import type { ChannelAccountSnapshot, ChannelStatusIssue } from "../types.js";
import { formatCliCommand } from "../../../cli/command-format.js";
import { asString, isRecord } from "./shared.js";

type WhatsAppAccountStatus = {
  accountId?: unknown;
  enabled?: unknown;
  linked?: unknown;
  connected?: unknown;
  running?: unknown;
  reconnectAttempts?: unknown;
  lastError?: unknown;
};

function readWhatsAppAccountStatus(value: ChannelAccountSnapshot): WhatsAppAccountStatus | null {
  if (!isRecord(value)) {
    return null;
  }
  return {
    accountId: value.accountId,
    enabled: value.enabled,
    linked: value.linked,
    connected: value.connected,
    running: value.running,
    reconnectAttempts: value.reconnectAttempts,
    lastError: value.lastError,
  };
}

export function collectWhatsAppStatusIssues(
  accounts: ChannelAccountSnapshot[],
): ChannelStatusIssue[] {
  const issues: ChannelStatusIssue[] = [];
  for (const entry of accounts) {
    const account = readWhatsAppAccountStatus(entry);
    if (!account) {
      continue;
    }
    const accountId = asString(account.accountId) ?? "default";
    const enabled = account.enabled !== false;
    if (!enabled) {
      continue;
    }
    const linked = account.linked === true;
    const running = account.running === true;
    const connected = account.connected === true;
    const reconnectAttempts =
      typeof account.reconnectAttempts === "number" ? account.reconnectAttempts : null;
    const lastError = asString(account.lastError);

    if (!linked) {
      issues.push({
        channel: "whatsapp",
        accountId,
        kind: "auth",
        message: "未链接（没有 WhatsApp Web 会话）。",
        fix: `运行：${formatCliCommand("openclaw channels login")}（在网关主机上扫描二维码）。`,
      });
      continue;
    }

    if (running && !connected) {
      issues.push({
        channel: "whatsapp",
        accountId,
        kind: "runtime",
        message: `已链接但断开连接${reconnectAttempts != null ? `（reconnectAttempts=${reconnectAttempts}）` : ""}${lastError ? `：${lastError}` : "。"}`,
        fix: `运行：${formatCliCommand("openclaw doctor")}（或重启网关）。如果问题持续，请通过 channels login 重新链接并检查日志。`,
      });
    }
  }
  return issues;
}
