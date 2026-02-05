import type { OpenClawConfig } from "../../../config/config.js";
import type { RuntimeEnv } from "../../../runtime.js";
import type { OnboardOptions } from "../../onboard-types.js";
import { resolveGatewayService } from "../../../daemon/service.js";
import { isSystemdUserServiceAvailable } from "../../../daemon/systemd.js";
import { buildGatewayInstallPlan, gatewayInstallErrorHint } from "../../daemon-install-helpers.js";
import { DEFAULT_GATEWAY_DAEMON_RUNTIME, isGatewayDaemonRuntime } from "../../daemon-runtime.js";
import { ensureSystemdUserLingerNonInteractive } from "../../systemd-linger.js";

export async function installGatewayDaemonNonInteractive(params: {
  nextConfig: OpenClawConfig;
  opts: OnboardOptions;
  runtime: RuntimeEnv;
  port: number;
  gatewayToken?: string;
}) {
  const { opts, runtime, port, gatewayToken } = params;
  if (!opts.installDaemon) {
    return;
  }

  const daemonRuntimeRaw = opts.daemonRuntime ?? DEFAULT_GATEWAY_DAEMON_RUNTIME;
  const systemdAvailable =
    process.platform === "linux" ? await isSystemdUserServiceAvailable() : true;
  if (process.platform === "linux" && !systemdAvailable) {
    runtime.log("Systemd 用户服务不可用；跳过服务安装。");
    return;
  }

  if (!isGatewayDaemonRuntime(daemonRuntimeRaw)) {
    runtime.error("无效的 --daemon-runtime（使用 node 或 bun）");
    runtime.exit(1);
    return;
  }

  const service = resolveGatewayService();
  const { programArguments, workingDirectory, environment } = await buildGatewayInstallPlan({
    env: process.env,
    port,
    token: gatewayToken,
    runtime: daemonRuntimeRaw,
    warn: (message) => runtime.log(message),
    config: params.nextConfig,
  });
  try {
    await service.install({
      env: process.env,
      stdout: process.stdout,
      programArguments,
      workingDirectory,
      environment,
    });
  } catch (err) {
    runtime.error(`网关服务安装失败：${String(err)}`);
    runtime.log(gatewayInstallErrorHint());
    return;
  }
  await ensureSystemdUserLingerNonInteractive({ runtime });
}
