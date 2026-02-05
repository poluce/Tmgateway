import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import type { OpenClawConfig } from "../config/config.js";
import type { RuntimeEnv } from "../runtime.js";
import type { DoctorOptions, DoctorPrompter } from "./doctor-prompter.js";
import { resolveGatewayPort, resolveIsNixMode } from "../config/paths.js";
import { findExtraGatewayServices, renderGatewayServiceCleanupHints } from "../daemon/inspect.js";
import { renderSystemNodeWarning, resolveSystemNodeInfo } from "../daemon/runtime-paths.js";
import {
  auditGatewayServiceConfig,
  needsNodeRuntimeMigration,
  SERVICE_AUDIT_CODES,
} from "../daemon/service-audit.js";
import { resolveGatewayService } from "../daemon/service.js";
import { note } from "../terminal/note.js";
import { buildGatewayInstallPlan } from "./daemon-install-helpers.js";
import { DEFAULT_GATEWAY_DAEMON_RUNTIME, type GatewayDaemonRuntime } from "./daemon-runtime.js";

const execFileAsync = promisify(execFile);

function detectGatewayRuntime(programArguments: string[] | undefined): GatewayDaemonRuntime {
  const first = programArguments?.[0];
  if (first) {
    const base = path.basename(first).toLowerCase();
    if (base === "bun" || base === "bun.exe") {
      return "bun";
    }
    if (base === "node" || base === "node.exe") {
      return "node";
    }
  }
  return DEFAULT_GATEWAY_DAEMON_RUNTIME;
}

function findGatewayEntrypoint(programArguments?: string[]): string | null {
  if (!programArguments || programArguments.length === 0) {
    return null;
  }
  const gatewayIndex = programArguments.indexOf("gateway");
  if (gatewayIndex <= 0) {
    return null;
  }
  return programArguments[gatewayIndex - 1] ?? null;
}

function normalizeExecutablePath(value: string): string {
  return path.resolve(value);
}

function extractDetailPath(detail: string, prefix: string): string | null {
  if (!detail.startsWith(prefix)) {
    return null;
  }
  const value = detail.slice(prefix.length).trim();
  return value.length > 0 ? value : null;
}

async function cleanupLegacyLaunchdService(params: {
  label: string;
  plistPath: string;
}): Promise<string | null> {
  const domain = typeof process.getuid === "function" ? `gui/${process.getuid()}` : "gui/501";
  await execFileAsync("launchctl", ["bootout", domain, params.plistPath]).catch(() => undefined);
  await execFileAsync("launchctl", ["unload", params.plistPath]).catch(() => undefined);

  const trashDir = path.join(os.homedir(), ".Trash");
  try {
    await fs.mkdir(trashDir, { recursive: true });
  } catch {
    // ignore
  }

  try {
    await fs.access(params.plistPath);
  } catch {
    return null;
  }

  const dest = path.join(trashDir, `${params.label}-${Date.now()}.plist`);
  try {
    await fs.rename(params.plistPath, dest);
    return dest;
  } catch {
    return null;
  }
}

export async function maybeRepairGatewayServiceConfig(
  cfg: OpenClawConfig,
  mode: "local" | "remote",
  runtime: RuntimeEnv,
  prompter: DoctorPrompter,
) {
  if (resolveIsNixMode(process.env)) {
    note("检测到 Nix 模式；跳过服务更新。", "网关");
    return;
  }

  if (mode === "remote") {
    note("网关模式为远程；跳过本地服务审计。", "网关");
    return;
  }

  const service = resolveGatewayService();
  let command: Awaited<ReturnType<typeof service.readCommand>> | null = null;
  try {
    command = await service.readCommand(process.env);
  } catch {
    command = null;
  }
  if (!command) {
    return;
  }

  const audit = await auditGatewayServiceConfig({
    env: process.env,
    command,
  });
  const needsNodeRuntime = needsNodeRuntimeMigration(audit.issues);
  const systemNodeInfo = needsNodeRuntime
    ? await resolveSystemNodeInfo({ env: process.env })
    : null;
  const systemNodePath = systemNodeInfo?.supported ? systemNodeInfo.path : null;
  if (needsNodeRuntime && !systemNodePath) {
    const warning = renderSystemNodeWarning(systemNodeInfo);
    if (warning) {
      note(warning, "网关运行时");
    }
    note(
      "未找到系统 Node 22+。通过 Homebrew/apt/choco 安装后重新运行 doctor 以从 Bun/版本管理器迁移。",
      "网关运行时",
    );
  }

  const port = resolveGatewayPort(cfg, process.env);
  const runtimeChoice = detectGatewayRuntime(command.programArguments);
  const { programArguments, workingDirectory, environment } = await buildGatewayInstallPlan({
    env: process.env,
    port,
    token: cfg.gateway?.auth?.token ?? process.env.OPENCLAW_GATEWAY_TOKEN,
    runtime: needsNodeRuntime && systemNodePath ? "node" : runtimeChoice,
    nodePath: systemNodePath ?? undefined,
    warn: (message, title) => note(message, title),
    config: cfg,
  });
  const expectedEntrypoint = findGatewayEntrypoint(programArguments);
  const currentEntrypoint = findGatewayEntrypoint(command.programArguments);
  if (
    expectedEntrypoint &&
    currentEntrypoint &&
    normalizeExecutablePath(expectedEntrypoint) !== normalizeExecutablePath(currentEntrypoint)
  ) {
    audit.issues.push({
      code: SERVICE_AUDIT_CODES.gatewayEntrypointMismatch,
      message: "网关服务入口点与当前安装不匹配。",
      detail: `${currentEntrypoint} -> ${expectedEntrypoint}`,
      level: "recommended",
    });
  }

  if (audit.issues.length === 0) {
    return;
  }

  note(
    audit.issues
      .map((issue) =>
        issue.detail ? `- ${issue.message} (${issue.detail})` : `- ${issue.message}`,
      )
      .join("\n"),
    "网关服务配置",
  );

  const aggressiveIssues = audit.issues.filter((issue) => issue.level === "aggressive");
  const needsAggressive = aggressiveIssues.length > 0;

  if (needsAggressive && !prompter.shouldForce) {
    note("检测到自定义或意外的服务编辑。使用 --force 重新运行以覆盖。", "网关服务配置");
  }

  const repair = needsAggressive
    ? await prompter.confirmAggressive({
        message: "立即用当前默认值覆盖网关服务配置？",
        initialValue: Boolean(prompter.shouldForce),
      })
    : await prompter.confirmRepair({
        message: "立即将网关服务配置更新为推荐的默认值？",
        initialValue: true,
      });
  if (!repair) {
    return;
  }
  try {
    await service.install({
      env: process.env,
      stdout: process.stdout,
      programArguments,
      workingDirectory,
      environment,
    });
  } catch (err) {
    runtime.error(`网关服务更新失败: ${String(err)}`);
  }
}

export async function maybeScanExtraGatewayServices(
  options: DoctorOptions,
  runtime: RuntimeEnv,
  prompter: DoctorPrompter,
) {
  const extraServices = await findExtraGatewayServices(process.env, {
    deep: options.deep,
  });
  if (extraServices.length === 0) {
    return;
  }

  note(
    extraServices.map((svc) => `- ${svc.label} (${svc.scope}, ${svc.detail})`).join("\n"),
    "检测到其他类似网关的服务",
  );

  const legacyServices = extraServices.filter((svc) => svc.legacy === true);
  if (legacyServices.length > 0) {
    const shouldRemove = await prompter.confirmSkipInNonInteractive({
      message: "立即移除旧版网关服务 (clawdbot/moltbot)？",
      initialValue: true,
    });
    if (shouldRemove) {
      const removed: string[] = [];
      const failed: string[] = [];
      for (const svc of legacyServices) {
        if (svc.platform !== "darwin") {
          failed.push(`${svc.label} (${svc.platform})`);
          continue;
        }
        if (svc.scope !== "user") {
          failed.push(`${svc.label} (${svc.scope})`);
          continue;
        }
        const plistPath = extractDetailPath(svc.detail, "plist:");
        if (!plistPath) {
          failed.push(`${svc.label} (缺少 plist 路径)`);
          continue;
        }
        const dest = await cleanupLegacyLaunchdService({
          label: svc.label,
          plistPath,
        });
        removed.push(dest ? `${svc.label} -> ${dest}` : svc.label);
      }
      if (removed.length > 0) {
        note(removed.map((line) => `- ${line}`).join("\n"), "旧版网关已移除");
      }
      if (failed.length > 0) {
        note(failed.map((line) => `- ${line}`).join("\n"), "旧版网关清理已跳过");
      }
      if (removed.length > 0) {
        runtime.log("旧版网关服务已移除。接下来安装 OpenClaw 网关。");
      }
    }
  }

  const cleanupHints = renderGatewayServiceCleanupHints();
  if (cleanupHints.length > 0) {
    note(cleanupHints.map((hint) => `- ${hint}`).join("\n"), "清理提示");
  }

  note(
    [
      "建议：大多数设置每台机器运行单个网关。",
      "一个网关支持多个代理。",
      "如果您需要多个网关（例如，同一主机上的救援机器人），请隔离端口 + 配置/状态（参见文档：/gateway#multiple-gateways-same-host）。",
    ].join("\n"),
    "网关建议",
  );
}
