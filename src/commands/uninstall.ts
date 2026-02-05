import { cancel, confirm, isCancel, multiselect } from "@clack/prompts";
import path from "node:path";
import type { RuntimeEnv } from "../runtime.js";
import {
  isNixMode,
  loadConfig,
  resolveConfigPath,
  resolveOAuthDir,
  resolveStateDir,
} from "../config/config.js";
import { resolveGatewayService } from "../daemon/service.js";
import { stylePromptHint, stylePromptMessage, stylePromptTitle } from "../terminal/prompt-style.js";
import { resolveHomeDir } from "../utils.js";
import { collectWorkspaceDirs, isPathWithin, removePath } from "./cleanup-utils.js";

type UninstallScope = "service" | "state" | "workspace" | "app";

export type UninstallOptions = {
  service?: boolean;
  state?: boolean;
  workspace?: boolean;
  app?: boolean;
  all?: boolean;
  yes?: boolean;
  nonInteractive?: boolean;
  dryRun?: boolean;
};

const multiselectStyled = <T>(params: Parameters<typeof multiselect<T>>[0]) =>
  multiselect({
    ...params,
    message: stylePromptMessage(params.message),
    options: params.options.map((opt) =>
      opt.hint === undefined ? opt : { ...opt, hint: stylePromptHint(opt.hint) },
    ),
  });

function buildScopeSelection(opts: UninstallOptions): {
  scopes: Set<UninstallScope>;
  hadExplicit: boolean;
} {
  const hadExplicit = Boolean(opts.all || opts.service || opts.state || opts.workspace || opts.app);
  const scopes = new Set<UninstallScope>();
  if (opts.all || opts.service) {
    scopes.add("service");
  }
  if (opts.all || opts.state) {
    scopes.add("state");
  }
  if (opts.all || opts.workspace) {
    scopes.add("workspace");
  }
  if (opts.all || opts.app) {
    scopes.add("app");
  }
  return { scopes, hadExplicit };
}

async function stopAndUninstallService(runtime: RuntimeEnv): Promise<boolean> {
  if (isNixMode) {
    runtime.error("检测到 Nix 模式；服务卸载已禁用。");
    return false;
  }
  const service = resolveGatewayService();
  let loaded = false;
  try {
    loaded = await service.isLoaded({ env: process.env });
  } catch (err) {
    runtime.error(`网关服务检查失败：${String(err)}`);
    return false;
  }
  if (!loaded) {
    runtime.log(`网关服务 ${service.notLoadedText}。`);
    return true;
  }
  try {
    await service.stop({ env: process.env, stdout: process.stdout });
  } catch (err) {
    runtime.error(`网关停止失败：${String(err)}`);
  }
  try {
    await service.uninstall({ env: process.env, stdout: process.stdout });
    return true;
  } catch (err) {
    runtime.error(`网关卸载失败：${String(err)}`);
    return false;
  }
}

async function removeMacApp(runtime: RuntimeEnv, dryRun?: boolean) {
  if (process.platform !== "darwin") {
    return;
  }
  await removePath("/Applications/OpenClaw.app", runtime, {
    dryRun,
    label: "/Applications/OpenClaw.app",
  });
}

export async function uninstallCommand(runtime: RuntimeEnv, opts: UninstallOptions) {
  const { scopes, hadExplicit } = buildScopeSelection(opts);
  const interactive = !opts.nonInteractive;
  if (!interactive && !opts.yes) {
    runtime.error("非交互模式需要 --yes。");
    runtime.exit(1);
    return;
  }

  if (!hadExplicit) {
    if (!interactive) {
      runtime.error("非交互模式需要明确的范围（使用 --all）。");
      runtime.exit(1);
      return;
    }
    const selection = await multiselectStyled<UninstallScope>({
      message: "卸载哪些组件？",
      options: [
        {
          value: "service",
          label: "网关服务",
          hint: "launchd / systemd / schtasks",
        },
        { value: "state", label: "状态 + 配置", hint: "~/.openclaw" },
        { value: "workspace", label: "工作空间", hint: "代理文件" },
        {
          value: "app",
          label: "macOS 应用",
          hint: "/Applications/OpenClaw.app",
        },
      ],
      initialValues: ["service", "state", "workspace"],
    });
    if (isCancel(selection)) {
      cancel(stylePromptTitle("卸载已取消。") ?? "卸载已取消。");
      runtime.exit(0);
      return;
    }
    for (const value of selection) {
      scopes.add(value);
    }
  }

  if (scopes.size === 0) {
    runtime.log("未选择任何内容。");
    return;
  }

  if (interactive && !opts.yes) {
    const ok = await confirm({
      message: stylePromptMessage("继续卸载？"),
    });
    if (isCancel(ok) || !ok) {
      cancel(stylePromptTitle("卸载已取消。") ?? "卸载已取消。");
      runtime.exit(0);
      return;
    }
  }

  const dryRun = Boolean(opts.dryRun);
  const cfg = loadConfig();
  const stateDir = resolveStateDir();
  const configPath = resolveConfigPath();
  const oauthDir = resolveOAuthDir();
  const configInsideState = isPathWithin(configPath, stateDir);
  const oauthInsideState = isPathWithin(oauthDir, stateDir);
  const workspaceDirs = collectWorkspaceDirs(cfg);

  if (scopes.has("service")) {
    if (dryRun) {
      runtime.log("[dry-run] remove gateway service");
    } else {
      await stopAndUninstallService(runtime);
    }
  }

  if (scopes.has("state")) {
    await removePath(stateDir, runtime, { dryRun, label: stateDir });
    if (!configInsideState) {
      await removePath(configPath, runtime, { dryRun, label: configPath });
    }
    if (!oauthInsideState) {
      await removePath(oauthDir, runtime, { dryRun, label: oauthDir });
    }
  }

  if (scopes.has("workspace")) {
    for (const workspace of workspaceDirs) {
      await removePath(workspace, runtime, { dryRun, label: workspace });
    }
  }

  if (scopes.has("app")) {
    await removeMacApp(runtime, dryRun);
  }

  runtime.log("CLI 仍已安装。如需移除，请通过 npm/pnpm 卸载。");

  if (scopes.has("state") && !scopes.has("workspace")) {
    const home = resolveHomeDir();
    if (home && workspaceDirs.some((dir) => dir.startsWith(path.resolve(home)))) {
      runtime.log("提示：工作空间已保留。使用 --workspace 重新运行以移除它们。");
    }
  }
}
