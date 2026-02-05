import fs from "node:fs/promises";
import path from "node:path";
import type { RuntimeEnv } from "../runtime.js";
import type { ChannelChoice } from "./onboard-types.js";
import {
  resolveAgentDir,
  resolveAgentWorkspaceDir,
  resolveDefaultAgentId,
} from "../agents/agent-scope.js";
import { ensureAuthProfileStore } from "../agents/auth-profiles.js";
import { resolveAuthStorePath } from "../agents/auth-profiles/paths.js";
import { writeConfigFile } from "../config/config.js";
import { logConfigUpdated } from "../config/logging.js";
import { DEFAULT_AGENT_ID, normalizeAgentId } from "../routing/session-key.js";
import { defaultRuntime } from "../runtime.js";
import { resolveUserPath, shortenHomePath } from "../utils.js";
import { createClackPrompter } from "../wizard/clack-prompter.js";
import { WizardCancelledError } from "../wizard/prompts.js";
import {
  applyAgentBindings,
  buildChannelBindings,
  describeBinding,
  parseBindingSpecs,
} from "./agents.bindings.js";
import { createQuietRuntime, requireValidConfig } from "./agents.command-shared.js";
import { applyAgentConfig, findAgentEntryIndex, listAgentEntries } from "./agents.config.js";
import { promptAuthChoiceGrouped } from "./auth-choice-prompt.js";
import { applyAuthChoice, warnIfModelConfigLooksOff } from "./auth-choice.js";
import { setupChannels } from "./onboard-channels.js";
import { ensureWorkspaceAndSessions } from "./onboard-helpers.js";

type AgentsAddOptions = {
  name?: string;
  workspace?: string;
  model?: string;
  agentDir?: string;
  bind?: string[];
  nonInteractive?: boolean;
  json?: boolean;
};

async function fileExists(pathname: string): Promise<boolean> {
  try {
    await fs.stat(pathname);
    return true;
  } catch {
    return false;
  }
}

export async function agentsAddCommand(
  opts: AgentsAddOptions,
  runtime: RuntimeEnv = defaultRuntime,
  params?: { hasFlags?: boolean },
) {
  const cfg = await requireValidConfig(runtime);
  if (!cfg) {
    return;
  }

  const workspaceFlag = opts.workspace?.trim();
  const nameInput = opts.name?.trim();
  const hasFlags = params?.hasFlags === true;
  const nonInteractive = Boolean(opts.nonInteractive || hasFlags);

  if (nonInteractive && !workspaceFlag) {
    runtime.error("非交互模式需要 --workspace 参数。不带参数重新运行以使用向导。");
    runtime.exit(1);
    return;
  }

  if (nonInteractive) {
    if (!nameInput) {
      runtime.error("非交互模式需要代理名称。");
      runtime.exit(1);
      return;
    }
    if (!workspaceFlag) {
      runtime.error("非交互模式需要 --workspace 参数。不带参数重新运行以使用向导。");
      runtime.exit(1);
      return;
    }
    const agentId = normalizeAgentId(nameInput);
    if (agentId === DEFAULT_AGENT_ID) {
      runtime.error(`"${DEFAULT_AGENT_ID}" 是保留名称。请选择其他名称。`);
      runtime.exit(1);
      return;
    }
    if (agentId !== nameInput) {
      runtime.log(`已将代理 ID 规范化为 "${agentId}"。`);
    }
    if (findAgentEntryIndex(listAgentEntries(cfg), agentId) >= 0) {
      runtime.error(`代理 "${agentId}" 已存在。`);
      runtime.exit(1);
      return;
    }

    const workspaceDir = resolveUserPath(workspaceFlag);
    const agentDir = opts.agentDir?.trim()
      ? resolveUserPath(opts.agentDir.trim())
      : resolveAgentDir(cfg, agentId);
    const model = opts.model?.trim();
    const nextConfig = applyAgentConfig(cfg, {
      agentId,
      name: nameInput,
      workspace: workspaceDir,
      agentDir,
      ...(model ? { model } : {}),
    });

    const bindingParse = parseBindingSpecs({
      agentId,
      specs: opts.bind,
      config: nextConfig,
    });
    if (bindingParse.errors.length > 0) {
      runtime.error(bindingParse.errors.join("\n"));
      runtime.exit(1);
      return;
    }
    const bindingResult =
      bindingParse.bindings.length > 0
        ? applyAgentBindings(nextConfig, bindingParse.bindings)
        : { config: nextConfig, added: [], skipped: [], conflicts: [] };

    await writeConfigFile(bindingResult.config);
    if (!opts.json) {
      logConfigUpdated(runtime);
    }
    const quietRuntime = opts.json ? createQuietRuntime(runtime) : runtime;
    await ensureWorkspaceAndSessions(workspaceDir, quietRuntime, {
      skipBootstrap: Boolean(bindingResult.config.agents?.defaults?.skipBootstrap),
      agentId,
    });

    const payload = {
      agentId,
      name: nameInput,
      workspace: workspaceDir,
      agentDir,
      model,
      bindings: {
        added: bindingResult.added.map(describeBinding),
        skipped: bindingResult.skipped.map(describeBinding),
        conflicts: bindingResult.conflicts.map(
          (conflict) => `${describeBinding(conflict.binding)} (agent=${conflict.existingAgentId})`,
        ),
      },
    };
    if (opts.json) {
      runtime.log(JSON.stringify(payload, null, 2));
    } else {
      runtime.log(`代理：${agentId}`);
      runtime.log(`工作空间：${shortenHomePath(workspaceDir)}`);
      runtime.log(`代理目录：${shortenHomePath(agentDir)}`);
      if (model) {
        runtime.log(`模型：${model}`);
      }
      if (bindingResult.conflicts.length > 0) {
        runtime.error(
          [
            "跳过已被其他代理占用的绑定：",
            ...bindingResult.conflicts.map(
              (conflict) =>
                `- ${describeBinding(conflict.binding)} (代理=${conflict.existingAgentId})`,
            ),
          ].join("\n"),
        );
      }
    }
    return;
  }

  const prompter = createClackPrompter();
  try {
    await prompter.intro("添加 OpenClaw 代理");
    const name =
      nameInput ??
      (await prompter.text({
        message: "代理名称",
        validate: (value) => {
          if (!value?.trim()) {
            return "必填";
          }
          const normalized = normalizeAgentId(value);
          if (normalized === DEFAULT_AGENT_ID) {
            return `"${DEFAULT_AGENT_ID}" 是保留名称。请选择其他名称。`;
          }
          return undefined;
        },
      }));

    const agentName = String(name).trim();
    const agentId = normalizeAgentId(agentName);
    if (agentName !== agentId) {
      await prompter.note(`已将 ID 规范化为 "${agentId}"。`, "代理 ID");
    }

    const existingAgent = listAgentEntries(cfg).find(
      (agent) => normalizeAgentId(agent.id) === agentId,
    );
    if (existingAgent) {
      const shouldUpdate = await prompter.confirm({
        message: `代理 "${agentId}" 已存在。是否更新？`,
        initialValue: false,
      });
      if (!shouldUpdate) {
        await prompter.outro("未做任何更改。");
        return;
      }
    }

    const workspaceDefault = resolveAgentWorkspaceDir(cfg, agentId);
    const workspaceInput = await prompter.text({
      message: "工作空间目录",
      initialValue: workspaceDefault,
      validate: (value) => (value?.trim() ? undefined : "必填"),
    });
    const workspaceDir = resolveUserPath(String(workspaceInput).trim() || workspaceDefault);
    const agentDir = resolveAgentDir(cfg, agentId);

    let nextConfig = applyAgentConfig(cfg, {
      agentId,
      name: agentName,
      workspace: workspaceDir,
      agentDir,
    });

    const defaultAgentId = resolveDefaultAgentId(cfg);
    if (defaultAgentId !== agentId) {
      const sourceAuthPath = resolveAuthStorePath(resolveAgentDir(cfg, defaultAgentId));
      const destAuthPath = resolveAuthStorePath(agentDir);
      const sameAuthPath =
        path.resolve(sourceAuthPath).toLowerCase() === path.resolve(destAuthPath).toLowerCase();
      if (
        !sameAuthPath &&
        (await fileExists(sourceAuthPath)) &&
        !(await fileExists(destAuthPath))
      ) {
        const shouldCopy = await prompter.confirm({
          message: `从 "${defaultAgentId}" 复制认证配置？`,
          initialValue: false,
        });
        if (shouldCopy) {
          await fs.mkdir(path.dirname(destAuthPath), { recursive: true });
          await fs.copyFile(sourceAuthPath, destAuthPath);
          await prompter.note(`已从 "${defaultAgentId}" 复制认证配置。`, "认证配置");
        }
      }
    }

    const wantsAuth = await prompter.confirm({
      message: "现在为此代理配置模型/认证？",
      initialValue: false,
    });
    if (wantsAuth) {
      const authStore = ensureAuthProfileStore(agentDir, {
        allowKeychainPrompt: false,
      });
      const authChoice = await promptAuthChoiceGrouped({
        prompter,
        store: authStore,
        includeSkip: true,
      });

      const authResult = await applyAuthChoice({
        authChoice,
        config: nextConfig,
        prompter,
        runtime,
        agentDir,
        setDefaultModel: false,
        agentId,
      });
      nextConfig = authResult.config;
      if (authResult.agentModelOverride) {
        nextConfig = applyAgentConfig(nextConfig, {
          agentId,
          model: authResult.agentModelOverride,
        });
      }
    }

    await warnIfModelConfigLooksOff(nextConfig, prompter, {
      agentId,
      agentDir,
    });

    let selection: ChannelChoice[] = [];
    const channelAccountIds: Partial<Record<ChannelChoice, string>> = {};
    nextConfig = await setupChannels(nextConfig, runtime, prompter, {
      allowSignalInstall: true,
      onSelection: (value) => {
        selection = value;
      },
      promptAccountIds: true,
      onAccountId: (channel, accountId) => {
        channelAccountIds[channel] = accountId;
      },
    });

    if (selection.length > 0) {
      const wantsBindings = await prompter.confirm({
        message: "现在将选定的频道路由到此代理？（绑定）",
        initialValue: false,
      });
      if (wantsBindings) {
        const desiredBindings = buildChannelBindings({
          agentId,
          selection,
          config: nextConfig,
          accountIds: channelAccountIds,
        });
        const result = applyAgentBindings(nextConfig, desiredBindings);
        nextConfig = result.config;
        if (result.conflicts.length > 0) {
          await prompter.note(
            [
              "跳过已被其他代理占用的绑定：",
              ...result.conflicts.map(
                (conflict) =>
                  `- ${describeBinding(conflict.binding)} (代理=${conflict.existingAgentId})`,
              ),
            ].join("\n"),
            "路由绑定",
          );
        }
      } else {
        await prompter.note(
          [
            "路由未更改。准备好后再添加绑定。",
            "文档：https://docs.openclaw.ai/concepts/multi-agent",
          ].join("\n"),
          "路由",
        );
      }
    }

    await writeConfigFile(nextConfig);
    logConfigUpdated(runtime);
    await ensureWorkspaceAndSessions(workspaceDir, runtime, {
      skipBootstrap: Boolean(nextConfig.agents?.defaults?.skipBootstrap),
      agentId,
    });

    const payload = {
      agentId,
      name: agentName,
      workspace: workspaceDir,
      agentDir,
    };
    if (opts.json) {
      runtime.log(JSON.stringify(payload, null, 2));
    }
    await prompter.outro(`代理 "${agentId}" 已就绪。`);
  } catch (err) {
    if (err instanceof WizardCancelledError) {
      runtime.exit(0);
      return;
    }
    throw err;
  }
}
