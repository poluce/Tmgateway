import type { MemoryProviderStatus } from "../memory/types.js";
import type { RuntimeEnv } from "../runtime.js";
import { withProgress } from "../cli/progress.js";
import { loadConfig } from "../config/config.js";
import { buildGatewayConnectionDetails, callGateway } from "../gateway/call.js";
import { normalizeControlUiBasePath } from "../gateway/control-ui-shared.js";
import { probeGateway } from "../gateway/probe.js";
import { collectChannelStatusIssues } from "../infra/channels-status-issues.js";
import { resolveOsSummary } from "../infra/os-summary.js";
import { getTailnetHostname } from "../infra/tailscale.js";
import { getMemorySearchManager } from "../memory/index.js";
import { runExec } from "../process/exec.js";
import { buildChannelsTable } from "./status-all/channels.js";
import { getAgentLocalStatuses } from "./status.agent-local.js";
import { pickGatewaySelfPresence, resolveGatewayProbeAuth } from "./status.gateway-probe.js";
import { getStatusSummary } from "./status.summary.js";
import { getUpdateCheckResult } from "./status.update.js";

type MemoryStatusSnapshot = MemoryProviderStatus & {
  agentId: string;
};

type MemoryPluginStatus = {
  enabled: boolean;
  slot: string | null;
  reason?: string;
};

function resolveMemoryPluginStatus(cfg: ReturnType<typeof loadConfig>): MemoryPluginStatus {
  const pluginsEnabled = cfg.plugins?.enabled !== false;
  if (!pluginsEnabled) {
    return { enabled: false, slot: null, reason: "插件已禁用" };
  }
  const raw = typeof cfg.plugins?.slots?.memory === "string" ? cfg.plugins.slots.memory.trim() : "";
  if (raw && raw.toLowerCase() === "none") {
    return { enabled: false, slot: null, reason: 'plugins.slots.memory="none"' };
  }
  return { enabled: true, slot: raw || "memory-core" };
}

export type StatusScanResult = {
  cfg: ReturnType<typeof loadConfig>;
  osSummary: ReturnType<typeof resolveOsSummary>;
  tailscaleMode: string;
  tailscaleDns: string | null;
  tailscaleHttpsUrl: string | null;
  update: Awaited<ReturnType<typeof getUpdateCheckResult>>;
  gatewayConnection: ReturnType<typeof buildGatewayConnectionDetails>;
  remoteUrlMissing: boolean;
  gatewayMode: "local" | "remote";
  gatewayProbe: Awaited<ReturnType<typeof probeGateway>> | null;
  gatewayReachable: boolean;
  gatewaySelf: ReturnType<typeof pickGatewaySelfPresence>;
  channelIssues: ReturnType<typeof collectChannelStatusIssues>;
  agentStatus: Awaited<ReturnType<typeof getAgentLocalStatuses>>;
  channels: Awaited<ReturnType<typeof buildChannelsTable>>;
  summary: Awaited<ReturnType<typeof getStatusSummary>>;
  memory: MemoryStatusSnapshot | null;
  memoryPlugin: MemoryPluginStatus;
};

export async function scanStatus(
  opts: {
    json?: boolean;
    timeoutMs?: number;
    all?: boolean;
  },
  _runtime: RuntimeEnv,
): Promise<StatusScanResult> {
  return await withProgress(
    {
      label: "正在扫描状态…",
      total: 10,
      enabled: opts.json !== true,
    },
    async (progress) => {
      progress.setLabel("正在加载配置…");
      const cfg = loadConfig();
      const osSummary = resolveOsSummary();
      progress.tick();

      progress.setLabel("正在检查 Tailscale…");
      const tailscaleMode = cfg.gateway?.tailscale?.mode ?? "off";
      const tailscaleDns =
        tailscaleMode === "off"
          ? null
          : await getTailnetHostname((cmd, args) =>
              runExec(cmd, args, { timeoutMs: 1200, maxBuffer: 200_000 }),
            ).catch(() => null);
      const tailscaleHttpsUrl =
        tailscaleMode !== "off" && tailscaleDns
          ? `https://${tailscaleDns}${normalizeControlUiBasePath(cfg.gateway?.controlUi?.basePath)}`
          : null;
      progress.tick();

      progress.setLabel("正在检查更新…");
      const updateTimeoutMs = opts.all ? 6500 : 2500;
      const update = await getUpdateCheckResult({
        timeoutMs: updateTimeoutMs,
        fetchGit: true,
        includeRegistry: true,
      });
      progress.tick();

      progress.setLabel("正在解析代理…");
      const agentStatus = await getAgentLocalStatuses();
      progress.tick();

      progress.setLabel("正在探测网关…");
      const gatewayConnection = buildGatewayConnectionDetails();
      const isRemoteMode = cfg.gateway?.mode === "remote";
      const remoteUrlRaw =
        typeof cfg.gateway?.remote?.url === "string" ? cfg.gateway.remote.url : "";
      const remoteUrlMissing = isRemoteMode && !remoteUrlRaw.trim();
      const gatewayMode = isRemoteMode ? "remote" : "local";
      const gatewayProbe = remoteUrlMissing
        ? null
        : await probeGateway({
            url: gatewayConnection.url,
            auth: resolveGatewayProbeAuth(cfg),
            timeoutMs: Math.min(opts.all ? 5000 : 2500, opts.timeoutMs ?? 10_000),
          }).catch(() => null);
      const gatewayReachable = gatewayProbe?.ok === true;
      const gatewaySelf = gatewayProbe?.presence
        ? pickGatewaySelfPresence(gatewayProbe.presence)
        : null;
      progress.tick();

      progress.setLabel("正在查询频道状态…");
      const channelsStatus = gatewayReachable
        ? await callGateway({
            method: "channels.status",
            params: {
              probe: false,
              timeoutMs: Math.min(8000, opts.timeoutMs ?? 10_000),
            },
            timeoutMs: Math.min(opts.all ? 5000 : 2500, opts.timeoutMs ?? 10_000),
          }).catch(() => null)
        : null;
      const channelIssues = channelsStatus ? collectChannelStatusIssues(channelsStatus) : [];
      progress.tick();

      progress.setLabel("正在汇总频道…");
      const channels = await buildChannelsTable(cfg, {
        // Show token previews in regular status; keep `status --all` redacted.
        // Set `CLAWDBOT_SHOW_SECRETS=0` to force redaction.
        showSecrets: process.env.CLAWDBOT_SHOW_SECRETS?.trim() !== "0",
      });
      progress.tick();

      progress.setLabel("正在检查内存…");
      const memoryPlugin = resolveMemoryPluginStatus(cfg);
      const memory = await (async (): Promise<MemoryStatusSnapshot | null> => {
        if (!memoryPlugin.enabled) {
          return null;
        }
        if (memoryPlugin.slot !== "memory-core") {
          return null;
        }
        const agentId = agentStatus.defaultId ?? "main";
        const { manager } = await getMemorySearchManager({ cfg, agentId });
        if (!manager) {
          return null;
        }
        try {
          await manager.probeVectorAvailability();
        } catch {}
        const status = manager.status();
        await manager.close?.().catch(() => {});
        return { agentId, ...status };
      })();
      progress.tick();

      progress.setLabel("正在读取会话…");
      const summary = await getStatusSummary();
      progress.tick();

      progress.setLabel("正在渲染…");
      progress.tick();

      return {
        cfg,
        osSummary,
        tailscaleMode,
        tailscaleDns,
        tailscaleHttpsUrl,
        update,
        gatewayConnection,
        remoteUrlMissing,
        gatewayMode,
        gatewayProbe,
        gatewayReachable,
        gatewaySelf,
        channelIssues,
        agentStatus,
        channels,
        summary,
        memory,
        memoryPlugin,
      };
    },
  );
}
