import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import type { OpenClawConfig } from "../config/config.js";
import { note } from "../terminal/note.js";
import { shortenHomePath } from "../utils.js";

const execFileAsync = promisify(execFile);

function resolveHomeDir(): string {
  return process.env.HOME ?? os.homedir();
}

export async function noteMacLaunchAgentOverrides() {
  if (process.platform !== "darwin") {
    return;
  }
  const home = resolveHomeDir();
  const markerCandidates = [path.join(home, ".openclaw", "disable-launchagent")];
  const markerPath = markerCandidates.find((candidate) => fs.existsSync(candidate));
  if (!markerPath) {
    return;
  }

  const displayMarkerPath = shortenHomePath(markerPath);
  const lines = [
    `- LaunchAgent 写入已通过 ${displayMarkerPath} 禁用。`,
    "- 要恢复默认行为：",
    `  rm ${displayMarkerPath}`,
  ].filter((line): line is string => Boolean(line));
  note(lines.join("\n"), "网关 (macOS)");
}

async function launchctlGetenv(name: string): Promise<string | undefined> {
  try {
    const result = await execFileAsync("/bin/launchctl", ["getenv", name], { encoding: "utf8" });
    const value = String(result.stdout ?? "").trim();
    return value.length > 0 ? value : undefined;
  } catch {
    return undefined;
  }
}

function hasConfigGatewayCreds(cfg: OpenClawConfig): boolean {
  const localToken =
    typeof cfg.gateway?.auth?.token === "string" ? cfg.gateway?.auth?.token.trim() : "";
  const localPassword =
    typeof cfg.gateway?.auth?.password === "string" ? cfg.gateway?.auth?.password.trim() : "";
  const remoteToken =
    typeof cfg.gateway?.remote?.token === "string" ? cfg.gateway?.remote?.token.trim() : "";
  const remotePassword =
    typeof cfg.gateway?.remote?.password === "string" ? cfg.gateway?.remote?.password.trim() : "";
  return Boolean(localToken || localPassword || remoteToken || remotePassword);
}

export async function noteMacLaunchctlGatewayEnvOverrides(
  cfg: OpenClawConfig,
  deps?: {
    platform?: NodeJS.Platform;
    getenv?: (name: string) => Promise<string | undefined>;
    noteFn?: typeof note;
  },
) {
  const platform = deps?.platform ?? process.platform;
  if (platform !== "darwin") {
    return;
  }
  if (!hasConfigGatewayCreds(cfg)) {
    return;
  }

  const getenv = deps?.getenv ?? launchctlGetenv;
  const deprecatedLaunchctlEntries = [
    ["MOLTBOT_GATEWAY_TOKEN", await getenv("MOLTBOT_GATEWAY_TOKEN")],
    ["MOLTBOT_GATEWAY_PASSWORD", await getenv("MOLTBOT_GATEWAY_PASSWORD")],
    ["CLAWDBOT_GATEWAY_TOKEN", await getenv("CLAWDBOT_GATEWAY_TOKEN")],
    ["CLAWDBOT_GATEWAY_PASSWORD", await getenv("CLAWDBOT_GATEWAY_PASSWORD")],
  ].filter((entry): entry is [string, string] => Boolean(entry[1]?.trim()));
  if (deprecatedLaunchctlEntries.length > 0) {
    const lines = [
      "- 检测到已弃用的 launchctl 环境变量（已忽略）。",
      ...deprecatedLaunchctlEntries.map(
        ([key]) => `- \`${key}\` 已设置；请改用 \`OPENCLAW_${key.slice(key.indexOf("_") + 1)}\`。`,
      ),
    ];
    (deps?.noteFn ?? note)(lines.join("\n"), "网关 (macOS)");
  }

  const tokenEntries = [
    ["OPENCLAW_GATEWAY_TOKEN", await getenv("OPENCLAW_GATEWAY_TOKEN")],
  ] as const;
  const passwordEntries = [
    ["OPENCLAW_GATEWAY_PASSWORD", await getenv("OPENCLAW_GATEWAY_PASSWORD")],
  ] as const;
  const tokenEntry = tokenEntries.find(([, value]) => value?.trim());
  const passwordEntry = passwordEntries.find(([, value]) => value?.trim());
  const envToken = tokenEntry?.[1]?.trim() ?? "";
  const envPassword = passwordEntry?.[1]?.trim() ?? "";
  const envTokenKey = tokenEntry?.[0];
  const envPasswordKey = passwordEntry?.[0];
  if (!envToken && !envPassword) {
    return;
  }

  const lines = [
    "- 检测到 launchctl 环境覆盖（可能导致令人困惑的未授权错误）。",
    envToken && envTokenKey ? `- \`${envTokenKey}\` 已设置；它会覆盖配置中的令牌。` : undefined,
    envPassword
      ? `- \`${envPasswordKey ?? "OPENCLAW_GATEWAY_PASSWORD"}\` 已设置；它会覆盖配置中的密码。`
      : undefined,
    "- 清除覆盖并重启应用/网关：",
    envTokenKey ? `  launchctl unsetenv ${envTokenKey}` : undefined,
    envPasswordKey ? `  launchctl unsetenv ${envPasswordKey}` : undefined,
  ].filter((line): line is string => Boolean(line));

  (deps?.noteFn ?? note)(lines.join("\n"), "网关 (macOS)");
}

export function noteDeprecatedLegacyEnvVars(
  env: NodeJS.ProcessEnv = process.env,
  deps?: { noteFn?: typeof note },
) {
  const entries = Object.entries(env)
    .filter(
      ([key, value]) =>
        (key.startsWith("MOLTBOT_") || key.startsWith("CLAWDBOT_")) && value?.trim(),
    )
    .map(([key]) => key);
  if (entries.length === 0) {
    return;
  }

  const lines = [
    "- 检测到已弃用的旧版环境变量（已忽略）。",
    "- 请改用 OPENCLAW_* 等效变量：",
    ...entries.map((key) => {
      const suffix = key.slice(key.indexOf("_") + 1);
      return `  ${key} -> OPENCLAW_${suffix}`;
    }),
  ];
  (deps?.noteFn ?? note)(lines.join("\n"), "环境");
}
