import type { GatewayServiceRuntime } from "../daemon/service-runtime.js";
import { formatCliCommand } from "../cli/command-format.js";
import {
  resolveGatewayLaunchAgentLabel,
  resolveGatewaySystemdServiceName,
  resolveGatewayWindowsTaskName,
} from "../daemon/constants.js";
import { resolveGatewayLogPaths } from "../daemon/launchd.js";
import {
  isSystemdUnavailableDetail,
  renderSystemdUnavailableHints,
} from "../daemon/systemd-hints.js";
import { isWSLEnv } from "../infra/wsl.js";
import { getResolvedLoggerSettings } from "../logging.js";

type RuntimeHintOptions = {
  platform?: NodeJS.Platform;
  env?: Record<string, string | undefined>;
};

export function formatGatewayRuntimeSummary(
  runtime: GatewayServiceRuntime | undefined,
): string | null {
  if (!runtime) {
    return null;
  }
  const status = runtime.status ?? "unknown";
  const details: string[] = [];
  if (runtime.pid) {
    details.push(`pid ${runtime.pid}`);
  }
  if (runtime.state && runtime.state.toLowerCase() !== status) {
    details.push(`state ${runtime.state}`);
  }
  if (runtime.subState) {
    details.push(`sub ${runtime.subState}`);
  }
  if (runtime.lastExitStatus !== undefined) {
    details.push(`last exit ${runtime.lastExitStatus}`);
  }
  if (runtime.lastExitReason) {
    details.push(`reason ${runtime.lastExitReason}`);
  }
  if (runtime.lastRunResult) {
    details.push(`last run ${runtime.lastRunResult}`);
  }
  if (runtime.lastRunTime) {
    details.push(`last run time ${runtime.lastRunTime}`);
  }
  if (runtime.detail) {
    details.push(runtime.detail);
  }
  return details.length > 0 ? `${status} (${details.join(", ")})` : status;
}

export function buildGatewayRuntimeHints(
  runtime: GatewayServiceRuntime | undefined,
  options: RuntimeHintOptions = {},
): string[] {
  const hints: string[] = [];
  if (!runtime) {
    return hints;
  }
  const platform = options.platform ?? process.platform;
  const env = options.env ?? process.env;
  const fileLog = (() => {
    try {
      return getResolvedLoggerSettings().file;
    } catch {
      return null;
    }
  })();
  if (platform === "linux" && isSystemdUnavailableDetail(runtime.detail)) {
    hints.push(...renderSystemdUnavailableHints({ wsl: isWSLEnv() }));
    if (fileLog) {
      hints.push(`文件日志：${fileLog}`);
    }
    return hints;
  }
  if (runtime.cachedLabel && platform === "darwin") {
    const label = resolveGatewayLaunchAgentLabel(env.OPENCLAW_PROFILE);
    hints.push(
      `LaunchAgent 标签已缓存但 plist 缺失。清除方法：launchctl bootout gui/$UID/${label}`,
    );
    hints.push(`然后重新安装：${formatCliCommand("openclaw gateway install", env)}`);
  }
  if (runtime.missingUnit) {
    hints.push(`服务未安装。运行：${formatCliCommand("openclaw gateway install", env)}`);
    if (fileLog) {
      hints.push(`文件日志：${fileLog}`);
    }
    return hints;
  }
  if (runtime.status === "stopped") {
    hints.push("服务已加载但未运行（可能立即退出）。");
    if (fileLog) {
      hints.push(`文件日志：${fileLog}`);
    }
    if (platform === "darwin") {
      const logs = resolveGatewayLogPaths(env);
      hints.push(`Launchd 标准输出（如已安装）：${logs.stdoutPath}`);
      hints.push(`Launchd 标准错误（如已安装）：${logs.stderrPath}`);
    } else if (platform === "linux") {
      const unit = resolveGatewaySystemdServiceName(env.OPENCLAW_PROFILE);
      hints.push(`日志：journalctl --user -u ${unit}.service -n 200 --no-pager`);
    } else if (platform === "win32") {
      const task = resolveGatewayWindowsTaskName(env.OPENCLAW_PROFILE);
      hints.push(`日志：schtasks /Query /TN "${task}" /V /FO LIST`);
    }
  }
  return hints;
}
