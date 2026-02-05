import type { Command } from "commander";
import type { CostUsageSummary } from "../../infra/session-cost-usage.js";
import type { GatewayDiscoverOpts } from "./discover.js";
import { gatewayStatusCommand } from "../../commands/gateway-status.js";
import { formatHealthChannelLines, type HealthSummary } from "../../commands/health.js";
import { loadConfig } from "../../config/config.js";
import { discoverGatewayBeacons } from "../../infra/bonjour-discovery.js";
import { resolveWideAreaDiscoveryDomain } from "../../infra/widearea-dns.js";
import { defaultRuntime } from "../../runtime.js";
import { formatDocsLink } from "../../terminal/links.js";
import { colorize, isRich, theme } from "../../terminal/theme.js";
import { formatTokenCount, formatUsd } from "../../utils/usage-format.js";
import { runCommandWithRuntime } from "../cli-utils.js";
import {
  runDaemonInstall,
  runDaemonRestart,
  runDaemonStart,
  runDaemonStatus,
  runDaemonStop,
  runDaemonUninstall,
} from "../daemon-cli.js";
import { withProgress } from "../progress.js";
import { callGatewayCli, gatewayCallOpts } from "./call.js";
import {
  dedupeBeacons,
  parseDiscoverTimeoutMs,
  pickBeaconHost,
  pickGatewayPort,
  renderBeaconLines,
} from "./discover.js";
import { addGatewayRunCommand } from "./run.js";

function styleHealthChannelLine(line: string, rich: boolean): string {
  if (!rich) {
    return line;
  }
  const colon = line.indexOf(":");
  if (colon === -1) {
    return line;
  }

  const label = line.slice(0, colon + 1);
  const detail = line.slice(colon + 1).trimStart();
  const normalized = detail.toLowerCase();

  const applyPrefix = (prefix: string, color: (value: string) => string) =>
    `${label} ${color(detail.slice(0, prefix.length))}${detail.slice(prefix.length)}`;

  if (normalized.startsWith("failed")) {
    return applyPrefix("failed", theme.error);
  }
  if (normalized.startsWith("ok")) {
    return applyPrefix("ok", theme.success);
  }
  if (normalized.startsWith("linked")) {
    return applyPrefix("linked", theme.success);
  }
  if (normalized.startsWith("configured")) {
    return applyPrefix("configured", theme.success);
  }
  if (normalized.startsWith("not linked")) {
    return applyPrefix("not linked", theme.warn);
  }
  if (normalized.startsWith("not configured")) {
    return applyPrefix("not configured", theme.muted);
  }
  if (normalized.startsWith("unknown")) {
    return applyPrefix("unknown", theme.warn);
  }

  return line;
}

function runGatewayCommand(action: () => Promise<void>, label?: string) {
  return runCommandWithRuntime(defaultRuntime, action, (err) => {
    const message = String(err);
    defaultRuntime.error(label ? `${label}: ${message}` : message);
    defaultRuntime.exit(1);
  });
}

function parseDaysOption(raw: unknown, fallback = 30): number {
  if (typeof raw === "number" && Number.isFinite(raw)) {
    return Math.max(1, Math.floor(raw));
  }
  if (typeof raw === "string" && raw.trim() !== "") {
    const parsed = Number(raw);
    if (Number.isFinite(parsed)) {
      return Math.max(1, Math.floor(parsed));
    }
  }
  return fallback;
}

function renderCostUsageSummary(summary: CostUsageSummary, days: number, rich: boolean): string[] {
  const totalCost = formatUsd(summary.totals.totalCost) ?? "$0.00";
  const totalTokens = formatTokenCount(summary.totals.totalTokens) ?? "0";
  const lines = [
    colorize(rich, theme.heading, `用量成本（${days} 天）`),
    `${colorize(rich, theme.muted, "总计：")} ${totalCost} · ${totalTokens} tokens`,
  ];

  if (summary.totals.missingCostEntries > 0) {
    lines.push(`${colorize(rich, theme.muted, "缺失条目：")} ${summary.totals.missingCostEntries}`);
  }

  const latest = summary.daily.at(-1);
  if (latest) {
    const latestCost = formatUsd(latest.totalCost) ?? "$0.00";
    const latestTokens = formatTokenCount(latest.totalTokens) ?? "0";
    lines.push(
      `${colorize(rich, theme.muted, "最近一天：")} ${latest.date} · ${latestCost} · ${latestTokens} tokens`,
    );
  }

  return lines;
}

export function registerGatewayCli(program: Command) {
  const gateway = addGatewayRunCommand(
    program
      .command("gateway")
      .description("运行 WebSocket 网关")
      .addHelpText(
        "after",
        () =>
          `\n${theme.muted("文档：")} ${formatDocsLink("/cli/gateway", "docs.openclaw.ai/cli/gateway")}\n`,
      ),
  );

  addGatewayRunCommand(gateway.command("run").description("运行 WebSocket 网关（前台）"));

  gateway
    .command("status")
    .description("显示网关服务状态 + 探测网关")
    .option("--url <url>", "网关 WebSocket URL（默认为配置/远程/本地）")
    .option("--token <token>", "网关令牌（如需要）")
    .option("--password <password>", "网关密码（密码认证）")
    .option("--timeout <ms>", "超时时间（毫秒）", "10000")
    .option("--no-probe", "跳过 RPC 探测")
    .option("--deep", "扫描系统级服务", false)
    .option("--json", "输出 JSON", false)
    .action(async (opts) => {
      await runDaemonStatus({
        rpc: opts,
        probe: Boolean(opts.probe),
        deep: Boolean(opts.deep),
        json: Boolean(opts.json),
      });
    });

  gateway
    .command("install")
    .description("安装网关服务（launchd/systemd/schtasks）")
    .option("--port <port>", "网关端口")
    .option("--runtime <runtime>", "守护进程运行时（node|bun），默认：node")
    .option("--token <token>", "网关令牌（令牌认证）")
    .option("--force", "如已安装则重新安装/覆盖", false)
    .option("--json", "输出 JSON", false)
    .action(async (opts) => {
      await runDaemonInstall(opts);
    });

  gateway
    .command("uninstall")
    .description("卸载网关服务（launchd/systemd/schtasks）")
    .option("--json", "输出 JSON", false)
    .action(async (opts) => {
      await runDaemonUninstall(opts);
    });

  gateway
    .command("start")
    .description("启动网关服务（launchd/systemd/schtasks）")
    .option("--json", "输出 JSON", false)
    .action(async (opts) => {
      await runDaemonStart(opts);
    });

  gateway
    .command("stop")
    .description("停止网关服务（launchd/systemd/schtasks）")
    .option("--json", "输出 JSON", false)
    .action(async (opts) => {
      await runDaemonStop(opts);
    });

  gateway
    .command("restart")
    .description("重启网关服务（launchd/systemd/schtasks）")
    .option("--json", "输出 JSON", false)
    .action(async (opts) => {
      await runDaemonRestart(opts);
    });

  gatewayCallOpts(
    gateway
      .command("call")
      .description("调用网关方法")
      .argument("<method>", "方法名（health/status/system-presence/cron.*）")
      .option("--params <json>", "参数的 JSON 对象字符串", "{}")
      .action(async (method, opts) => {
        await runGatewayCommand(async () => {
          const params = JSON.parse(String(opts.params ?? "{}"));
          const result = await callGatewayCli(method, opts, params);
          if (opts.json) {
            defaultRuntime.log(JSON.stringify(result, null, 2));
            return;
          }
          const rich = isRich();
          defaultRuntime.log(
            `${colorize(rich, theme.heading, "网关调用")}: ${colorize(rich, theme.muted, String(method))}`,
          );
          defaultRuntime.log(JSON.stringify(result, null, 2));
        }, "网关调用失败");
      }),
  );

  gatewayCallOpts(
    gateway
      .command("usage-cost")
      .description("从会话日志获取用量成本摘要")
      .option("--days <days>", "包含的天数", "30")
      .action(async (opts) => {
        await runGatewayCommand(async () => {
          const days = parseDaysOption(opts.days);
          const result = await callGatewayCli("usage.cost", opts, { days });
          if (opts.json) {
            defaultRuntime.log(JSON.stringify(result, null, 2));
            return;
          }
          const rich = isRich();
          const summary = result as CostUsageSummary;
          for (const line of renderCostUsageSummary(summary, days, rich)) {
            defaultRuntime.log(line);
          }
        }, "网关用量成本获取失败");
      }),
  );

  gatewayCallOpts(
    gateway
      .command("health")
      .description("获取网关健康状态")
      .action(async (opts) => {
        await runGatewayCommand(async () => {
          const result = await callGatewayCli("health", opts);
          if (opts.json) {
            defaultRuntime.log(JSON.stringify(result, null, 2));
            return;
          }
          const rich = isRich();
          const obj: Record<string, unknown> = result && typeof result === "object" ? result : {};
          const durationMs = typeof obj.durationMs === "number" ? obj.durationMs : null;
          defaultRuntime.log(colorize(rich, theme.heading, "网关健康状态"));
          defaultRuntime.log(
            `${colorize(rich, theme.success, "正常")}${durationMs != null ? ` (${durationMs}ms)` : ""}`,
          );
          if (obj.channels && typeof obj.channels === "object") {
            for (const line of formatHealthChannelLines(obj as HealthSummary)) {
              defaultRuntime.log(styleHealthChannelLine(line, rich));
            }
          }
        });
      }),
  );

  gateway
    .command("probe")
    .description("显示网关可达性 + 发现 + 健康 + 状态摘要（本地 + 远程）")
    .option("--url <url>", "显式网关 WebSocket URL（仍探测本地）")
    .option("--ssh <target>", "远程网关隧道的 SSH 目标（user@host 或 user@host:port）")
    .option("--ssh-identity <path>", "SSH 身份文件路径")
    .option("--ssh-auto", "尝试从 Bonjour 发现推导 SSH 目标", false)
    .option("--token <token>", "网关令牌（应用于所有探测）")
    .option("--password <password>", "网关密码（应用于所有探测）")
    .option("--timeout <ms>", "总探测预算（毫秒）", "3000")
    .option("--json", "输出 JSON", false)
    .action(async (opts) => {
      await runGatewayCommand(async () => {
        await gatewayStatusCommand(opts, defaultRuntime);
      });
    });

  gateway
    .command("discover")
    .description("通过 Bonjour 发现网关（本地 + 广域，如已配置）")
    .option("--timeout <ms>", "每个命令的超时时间（毫秒）", "2000")
    .option("--json", "输出 JSON", false)
    .action(async (opts: GatewayDiscoverOpts) => {
      await runGatewayCommand(async () => {
        const cfg = loadConfig();
        const wideAreaDomain = resolveWideAreaDiscoveryDomain({
          configDomain: cfg.discovery?.wideArea?.domain,
        });
        const timeoutMs = parseDiscoverTimeoutMs(opts.timeout, 2000);
        const domains = ["local.", ...(wideAreaDomain ? [wideAreaDomain] : [])];
        const beacons = await withProgress(
          {
            label: "正在扫描网关…",
            indeterminate: true,
            enabled: opts.json !== true,
            delayMs: 0,
          },
          async () => await discoverGatewayBeacons({ timeoutMs, wideAreaDomain }),
        );

        const deduped = dedupeBeacons(beacons).toSorted((a, b) =>
          String(a.displayName || a.instanceName).localeCompare(
            String(b.displayName || b.instanceName),
          ),
        );

        if (opts.json) {
          const enriched = deduped.map((b) => {
            const host = pickBeaconHost(b);
            const port = pickGatewayPort(b);
            return { ...b, wsUrl: host ? `ws://${host}:${port}` : null };
          });
          defaultRuntime.log(
            JSON.stringify(
              {
                timeoutMs,
                domains,
                count: enriched.length,
                beacons: enriched,
              },
              null,
              2,
            ),
          );
          return;
        }

        const rich = isRich();
        defaultRuntime.log(colorize(rich, theme.heading, "网关发现"));
        defaultRuntime.log(
          colorize(rich, theme.muted, `发现 ${deduped.length} 个网关 · 域：${domains.join(", ")}`),
        );
        if (deduped.length === 0) {
          return;
        }

        for (const beacon of deduped) {
          for (const line of renderBeaconLines(beacon, rich)) {
            defaultRuntime.log(line);
          }
        }
      }, "网关发现失败");
    });
}
