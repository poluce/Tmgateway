import type { ChannelAccountSnapshot } from "../../channels/plugins/types.js";
import { listChannelPlugins } from "../../channels/plugins/index.js";
import { buildChannelAccountSnapshot } from "../../channels/plugins/status.js";
import { formatCliCommand } from "../../cli/command-format.js";
import { withProgress } from "../../cli/progress.js";
import { type OpenClawConfig, readConfigFileSnapshot } from "../../config/config.js";
import { callGateway } from "../../gateway/call.js";
import { formatAge } from "../../infra/channel-summary.js";
import { collectChannelStatusIssues } from "../../infra/channels-status-issues.js";
import { defaultRuntime, type RuntimeEnv } from "../../runtime.js";
import { formatDocsLink } from "../../terminal/links.js";
import { theme } from "../../terminal/theme.js";
import { type ChatChannel, formatChannelAccountLabel, requireValidConfig } from "./shared.js";

export type ChannelsStatusOptions = {
  json?: boolean;
  probe?: boolean;
  timeout?: string;
};

export function formatGatewayChannelsStatusLines(payload: Record<string, unknown>): string[] {
  const lines: string[] = [];
  lines.push(theme.success("网关可达。"));
  const accountLines = (provider: ChatChannel, accounts: Array<Record<string, unknown>>) =>
    accounts.map((account) => {
      const bits: string[] = [];
      if (typeof account.enabled === "boolean") {
        bits.push(account.enabled ? "已启用" : "已禁用");
      }
      if (typeof account.configured === "boolean") {
        bits.push(account.configured ? "已配置" : "未配置");
      }
      if (typeof account.linked === "boolean") {
        bits.push(account.linked ? "已连接" : "未连接");
      }
      if (typeof account.running === "boolean") {
        bits.push(account.running ? "运行中" : "已停止");
      }
      if (typeof account.connected === "boolean") {
        bits.push(account.connected ? "已连接" : "已断开");
      }
      const inboundAt =
        typeof account.lastInboundAt === "number" && Number.isFinite(account.lastInboundAt)
          ? account.lastInboundAt
          : null;
      const outboundAt =
        typeof account.lastOutboundAt === "number" && Number.isFinite(account.lastOutboundAt)
          ? account.lastOutboundAt
          : null;
      if (inboundAt) {
        bits.push(`in:${formatAge(Date.now() - inboundAt)}`);
      }
      if (outboundAt) {
        bits.push(`out:${formatAge(Date.now() - outboundAt)}`);
      }
      if (typeof account.mode === "string" && account.mode.length > 0) {
        bits.push(`mode:${account.mode}`);
      }
      const botUsername = (() => {
        const bot = account.bot as { username?: string | null } | undefined;
        const probeBot = (account.probe as { bot?: { username?: string | null } } | undefined)?.bot;
        const raw = bot?.username ?? probeBot?.username ?? "";
        if (typeof raw !== "string") {
          return "";
        }
        const trimmed = raw.trim();
        if (!trimmed) {
          return "";
        }
        return trimmed.startsWith("@") ? trimmed : `@${trimmed}`;
      })();
      if (botUsername) {
        bits.push(`bot:${botUsername}`);
      }
      if (typeof account.dmPolicy === "string" && account.dmPolicy.length > 0) {
        bits.push(`dm:${account.dmPolicy}`);
      }
      if (Array.isArray(account.allowFrom) && account.allowFrom.length > 0) {
        bits.push(`allow:${account.allowFrom.slice(0, 2).join(",")}`);
      }
      if (typeof account.tokenSource === "string" && account.tokenSource) {
        bits.push(`token:${account.tokenSource}`);
      }
      if (typeof account.botTokenSource === "string" && account.botTokenSource) {
        bits.push(`bot:${account.botTokenSource}`);
      }
      if (typeof account.appTokenSource === "string" && account.appTokenSource) {
        bits.push(`app:${account.appTokenSource}`);
      }
      const application = account.application as
        | { intents?: { messageContent?: string } }
        | undefined;
      const messageContent = application?.intents?.messageContent;
      if (
        typeof messageContent === "string" &&
        messageContent.length > 0 &&
        messageContent !== "enabled"
      ) {
        bits.push(`intents:content=${messageContent}`);
      }
      if (account.allowUnmentionedGroups === true) {
        bits.push("groups:unmentioned");
      }
      if (typeof account.baseUrl === "string" && account.baseUrl) {
        bits.push(`url:${account.baseUrl}`);
      }
      const probe = account.probe as { ok?: boolean } | undefined;
      if (probe && typeof probe.ok === "boolean") {
        bits.push(probe.ok ? "正常" : "探测失败");
      }
      const audit = account.audit as { ok?: boolean } | undefined;
      if (audit && typeof audit.ok === "boolean") {
        bits.push(audit.ok ? "审计正常" : "审计失败");
      }
      if (typeof account.lastError === "string" && account.lastError) {
        bits.push(`错误:${account.lastError}`);
      }
      const accountId = typeof account.accountId === "string" ? account.accountId : "default";
      const name = typeof account.name === "string" ? account.name.trim() : "";
      const labelText = formatChannelAccountLabel({
        channel: provider,
        accountId,
        name: name || undefined,
      });
      return `- ${labelText}: ${bits.join(", ")}`;
    });

  const plugins = listChannelPlugins();
  const accountsByChannel = payload.channelAccounts as Record<string, unknown> | undefined;
  const accountPayloads: Partial<Record<string, Array<Record<string, unknown>>>> = {};
  for (const plugin of plugins) {
    const raw = accountsByChannel?.[plugin.id];
    if (Array.isArray(raw)) {
      accountPayloads[plugin.id] = raw as Array<Record<string, unknown>>;
    }
  }

  for (const plugin of plugins) {
    const accounts = accountPayloads[plugin.id];
    if (accounts && accounts.length > 0) {
      lines.push(...accountLines(plugin.id, accounts));
    }
  }

  lines.push("");
  const issues = collectChannelStatusIssues(payload);
  if (issues.length > 0) {
    lines.push(theme.warn("警告："));
    for (const issue of issues) {
      lines.push(
        `- ${issue.channel} ${issue.accountId}: ${issue.message}${issue.fix ? ` (${issue.fix})` : ""}`,
      );
    }
    lines.push(`- 运行：${formatCliCommand("openclaw doctor")}`);
    lines.push("");
  }
  lines.push(
    `提示：${formatDocsLink("/cli#status", "status --deep")} 可在状态输出中添加网关健康探测（需要可达的网关）。`,
  );
  return lines;
}

async function formatConfigChannelsStatusLines(
  cfg: OpenClawConfig,
  meta: { path?: string; mode?: "local" | "remote" },
): Promise<string[]> {
  const lines: string[] = [];
  lines.push(theme.warn("网关不可达；仅显示配置状态。"));
  if (meta.path) {
    lines.push(`配置：${meta.path}`);
  }
  if (meta.mode) {
    lines.push(`模式：${meta.mode}`);
  }
  if (meta.path || meta.mode) {
    lines.push("");
  }

  const accountLines = (provider: ChatChannel, accounts: Array<Record<string, unknown>>) =>
    accounts.map((account) => {
      const bits: string[] = [];
      if (typeof account.enabled === "boolean") {
        bits.push(account.enabled ? "enabled" : "disabled");
      }
      if (typeof account.configured === "boolean") {
        bits.push(account.configured ? "configured" : "not configured");
      }
      if (typeof account.linked === "boolean") {
        bits.push(account.linked ? "linked" : "not linked");
      }
      if (typeof account.mode === "string" && account.mode.length > 0) {
        bits.push(`mode:${account.mode}`);
      }
      if (typeof account.tokenSource === "string" && account.tokenSource) {
        bits.push(`token:${account.tokenSource}`);
      }
      if (typeof account.botTokenSource === "string" && account.botTokenSource) {
        bits.push(`bot:${account.botTokenSource}`);
      }
      if (typeof account.appTokenSource === "string" && account.appTokenSource) {
        bits.push(`app:${account.appTokenSource}`);
      }
      if (typeof account.baseUrl === "string" && account.baseUrl) {
        bits.push(`url:${account.baseUrl}`);
      }
      const accountId = typeof account.accountId === "string" ? account.accountId : "default";
      const name = typeof account.name === "string" ? account.name.trim() : "";
      const labelText = formatChannelAccountLabel({
        channel: provider,
        accountId,
        name: name || undefined,
      });
      return `- ${labelText}: ${bits.join(", ")}`;
    });

  const plugins = listChannelPlugins();
  for (const plugin of plugins) {
    const accountIds = plugin.config.listAccountIds(cfg);
    if (!accountIds.length) {
      continue;
    }
    const snapshots: ChannelAccountSnapshot[] = [];
    for (const accountId of accountIds) {
      const snapshot = await buildChannelAccountSnapshot({
        plugin,
        cfg,
        accountId,
      });
      snapshots.push(snapshot);
    }
    if (snapshots.length > 0) {
      lines.push(...accountLines(plugin.id, snapshots));
    }
  }

  lines.push("");
  lines.push(
    `提示：${formatDocsLink("/cli#status", "status --deep")} 可在状态输出中添加网关健康探测（需要可达的网关）。`,
  );
  return lines;
}

export async function channelsStatusCommand(
  opts: ChannelsStatusOptions,
  runtime: RuntimeEnv = defaultRuntime,
) {
  const timeoutMs = Number(opts.timeout ?? 10_000);
  const statusLabel = opts.probe ? "正在检查频道状态（探测）…" : "正在检查频道状态…";
  const shouldLogStatus = opts.json !== true && !process.stderr.isTTY;
  if (shouldLogStatus) {
    runtime.log(statusLabel);
  }
  try {
    const payload = await withProgress(
      {
        label: statusLabel,
        indeterminate: true,
        enabled: opts.json !== true,
      },
      async () =>
        await callGateway({
          method: "channels.status",
          params: { probe: Boolean(opts.probe), timeoutMs },
          timeoutMs,
        }),
    );
    if (opts.json) {
      runtime.log(JSON.stringify(payload, null, 2));
      return;
    }
    runtime.log(formatGatewayChannelsStatusLines(payload).join("\n"));
  } catch (err) {
    runtime.error(`网关不可达：${String(err)}`);
    const cfg = await requireValidConfig(runtime);
    if (!cfg) {
      return;
    }
    const snapshot = await readConfigFileSnapshot();
    const mode = cfg.gateway?.mode === "remote" ? "remote" : "local";
    runtime.log(
      (
        await formatConfigChannelsStatusLines(cfg, {
          path: snapshot.path,
          mode,
        })
      ).join("\n"),
    );
  }
}
