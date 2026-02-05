import type { PortListener, PortListenerKind, PortUsage } from "./ports-types.js";
import { formatCliCommand } from "../cli/command-format.js";

export function classifyPortListener(listener: PortListener, port: number): PortListenerKind {
  const raw = `${listener.commandLine ?? ""} ${listener.command ?? ""}`.trim().toLowerCase();
  if (raw.includes("openclaw")) {
    return "gateway";
  }
  if (raw.includes("ssh")) {
    const portToken = String(port);
    const tunnelPattern = new RegExp(
      `-(l|r)\\s*${portToken}\\b|-(l|r)${portToken}\\b|:${portToken}\\b`,
    );
    if (!raw || tunnelPattern.test(raw)) {
      return "ssh";
    }
    return "ssh";
  }
  return "unknown";
}

export function buildPortHints(listeners: PortListener[], port: number): string[] {
  if (listeners.length === 0) {
    return [];
  }
  const kinds = new Set(listeners.map((listener) => classifyPortListener(listener, port)));
  const hints: string[] = [];
  if (kinds.has("gateway")) {
    hints.push(
      `网关已在本地运行。停止它（${formatCliCommand("openclaw gateway stop")}）或使用其他端口。`,
    );
  }
  if (kinds.has("ssh")) {
    hints.push("SSH 隧道已绑定到此端口。关闭隧道或在 -L 中使用其他本地端口。");
  }
  if (kinds.has("unknown")) {
    hints.push("另一个进程正在监听此端口。");
  }
  if (listeners.length > 1) {
    hints.push(
      "检测到多个监听器；除非有意运行隔离的配置文件，否则请确保每个端口只有一个网关/隧道。",
    );
  }
  return hints;
}

export function formatPortListener(listener: PortListener): string {
  const pid = listener.pid ? `pid ${listener.pid}` : "pid ?";
  const user = listener.user ? ` ${listener.user}` : "";
  const command = listener.commandLine || listener.command || "unknown";
  const address = listener.address ? ` (${listener.address})` : "";
  return `${pid}${user}: ${command}${address}`;
}

export function formatPortDiagnostics(diagnostics: PortUsage): string[] {
  if (diagnostics.status !== "busy") {
    return [`端口 ${diagnostics.port} 空闲。`];
  }
  const lines = [`端口 ${diagnostics.port} 已被占用。`];
  for (const listener of diagnostics.listeners) {
    lines.push(`- ${formatPortListener(listener)}`);
  }
  for (const hint of diagnostics.hints) {
    lines.push(`- ${hint}`);
  }
  return lines;
}
