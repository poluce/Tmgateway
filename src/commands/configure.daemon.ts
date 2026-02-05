import type { RuntimeEnv } from "../runtime.js";
import { withProgress } from "../cli/progress.js";
import { loadConfig } from "../config/config.js";
import { resolveGatewayService } from "../daemon/service.js";
import { note } from "../terminal/note.js";
import { confirm, select } from "./configure.shared.js";
import { buildGatewayInstallPlan, gatewayInstallErrorHint } from "./daemon-install-helpers.js";
import {
  DEFAULT_GATEWAY_DAEMON_RUNTIME,
  GATEWAY_DAEMON_RUNTIME_OPTIONS,
  type GatewayDaemonRuntime,
} from "./daemon-runtime.js";
import { guardCancel } from "./onboard-helpers.js";
import { ensureSystemdUserLingerInteractive } from "./systemd-linger.js";

export async function maybeInstallDaemon(params: {
  runtime: RuntimeEnv;
  port: number;
  gatewayToken?: string;
  daemonRuntime?: GatewayDaemonRuntime;
}) {
  const service = resolveGatewayService();
  const loaded = await service.isLoaded({ env: process.env });
  let shouldCheckLinger = false;
  let shouldInstall = true;
  let daemonRuntime = params.daemonRuntime ?? DEFAULT_GATEWAY_DAEMON_RUNTIME;
  if (loaded) {
    const action = guardCancel(
      await select({
        message: "网关服务已安装",
        options: [
          { value: "restart", label: "重启" },
          { value: "reinstall", label: "重新安装" },
          { value: "skip", label: "跳过" },
        ],
      }),
      params.runtime,
    );
    if (action === "restart") {
      await withProgress(
        { label: "网关服务", indeterminate: true, delayMs: 0 },
        async (progress) => {
          progress.setLabel("正在重启网关服务…");
          await service.restart({
            env: process.env,
            stdout: process.stdout,
          });
          progress.setLabel("网关服务已重启。");
        },
      );
      shouldCheckLinger = true;
      shouldInstall = false;
    }
    if (action === "skip") {
      return;
    }
    if (action === "reinstall") {
      await withProgress(
        { label: "网关服务", indeterminate: true, delayMs: 0 },
        async (progress) => {
          progress.setLabel("正在卸载网关服务…");
          await service.uninstall({ env: process.env, stdout: process.stdout });
          progress.setLabel("网关服务已卸载。");
        },
      );
    }
  }

  if (shouldInstall) {
    let installError: string | null = null;
    if (!params.daemonRuntime) {
      if (GATEWAY_DAEMON_RUNTIME_OPTIONS.length === 1) {
        daemonRuntime = GATEWAY_DAEMON_RUNTIME_OPTIONS[0]?.value ?? DEFAULT_GATEWAY_DAEMON_RUNTIME;
      } else {
        daemonRuntime = guardCancel(
          await select({
            message: "网关服务运行时",
            options: GATEWAY_DAEMON_RUNTIME_OPTIONS,
            initialValue: DEFAULT_GATEWAY_DAEMON_RUNTIME,
          }),
          params.runtime,
        ) as GatewayDaemonRuntime;
      }
    }
    await withProgress({ label: "网关服务", indeterminate: true, delayMs: 0 }, async (progress) => {
      progress.setLabel("正在准备网关服务…");

      const cfg = loadConfig();
      const { programArguments, workingDirectory, environment } = await buildGatewayInstallPlan({
        env: process.env,
        port: params.port,
        token: params.gatewayToken,
        runtime: daemonRuntime,
        warn: (message, title) => note(message, title),
        config: cfg,
      });

      progress.setLabel("正在安装网关服务…");
      try {
        await service.install({
          env: process.env,
          stdout: process.stdout,
          programArguments,
          workingDirectory,
          environment,
        });
        progress.setLabel("网关服务已安装。");
      } catch (err) {
        installError = err instanceof Error ? err.message : String(err);
        progress.setLabel("网关服务安装失败。");
      }
    });
    if (installError) {
      note("网关服务安装失败：" + installError, "网关");
      note(gatewayInstallErrorHint(), "网关");
      return;
    }
    shouldCheckLinger = true;
  }

  if (shouldCheckLinger) {
    await ensureSystemdUserLingerInteractive({
      runtime: params.runtime,
      prompter: {
        confirm: async (p) => guardCancel(await confirm(p), params.runtime),
        note,
      },
      reason:
        "Linux 安装使用 systemd 用户服务。没有 lingering，systemd 会在注销/空闲时停止用户会话并终止网关。",
      requireConfirm: true,
    });
  }
}
