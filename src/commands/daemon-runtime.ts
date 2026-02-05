export type GatewayDaemonRuntime = "node" | "bun";

export const DEFAULT_GATEWAY_DAEMON_RUNTIME: GatewayDaemonRuntime = "node";

export const GATEWAY_DAEMON_RUNTIME_OPTIONS: Array<{
  value: GatewayDaemonRuntime;
  label: string;
  hint?: string;
}> = [
  {
    value: "node",
    label: "Node（推荐）",
    hint: "WhatsApp + Telegram 必需。Bun 在重连时可能损坏内存。",
  },
];

export function isGatewayDaemonRuntime(value: string | undefined): value is GatewayDaemonRuntime {
  return value === "node" || value === "bun";
}
