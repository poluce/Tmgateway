import type { OpenClawConfig } from "../config/config.js";
import type { RuntimeEnv } from "../runtime.js";
import { resolveGatewayPort } from "../config/config.js";
import { findTailscaleBinary } from "../infra/tailscale.js";
import { note } from "../terminal/note.js";
import { buildGatewayAuthConfig } from "./configure.gateway-auth.js";
import { confirm, select, text } from "./configure.shared.js";
import { guardCancel, normalizeGatewayTokenInput, randomToken } from "./onboard-helpers.js";

type GatewayAuthChoice = "token" | "password";

export async function promptGatewayConfig(
  cfg: OpenClawConfig,
  runtime: RuntimeEnv,
): Promise<{
  config: OpenClawConfig;
  port: number;
  token?: string;
}> {
  const portRaw = guardCancel(
    await text({
      message: "网关端口",
      initialValue: String(resolveGatewayPort(cfg)),
      validate: (value) => (Number.isFinite(Number(value)) ? undefined : "无效端口"),
    }),
    runtime,
  );
  const port = Number.parseInt(String(portRaw), 10);

  let bind = guardCancel(
    await select({
      message: "网关绑定模式",
      options: [
        {
          value: "loopback",
          label: "回环（仅本地）",
          hint: "绑定到 127.0.0.1 - 安全的本地访问",
        },
        {
          value: "tailnet",
          label: "Tailnet（Tailscale IP）",
          hint: "仅绑定到您的 Tailscale IP (100.x.x.x)",
        },
        {
          value: "auto",
          label: "自动（回环 → 局域网）",
          hint: "优先回环；不可用时回退到所有接口",
        },
        {
          value: "lan",
          label: "局域网（所有接口）",
          hint: "绑定到 0.0.0.0 - 可从网络上任何位置访问",
        },
        {
          value: "custom",
          label: "自定义 IP",
          hint: "指定特定 IP 地址，不可用时回退到 0.0.0.0",
        },
      ],
    }),
    runtime,
  );

  let customBindHost: string | undefined;
  if (bind === "custom") {
    const input = guardCancel(
      await text({
        message: "自定义 IP 地址",
        placeholder: "192.168.1.100",
        validate: (value) => {
          if (!value) {
            return "自定义绑定模式需要 IP 地址";
          }
          const trimmed = value.trim();
          const parts = trimmed.split(".");
          if (parts.length !== 4) {
            return "无效的 IPv4 地址（例如 192.168.1.100）";
          }
          if (
            parts.every((part) => {
              const n = parseInt(part, 10);
              return !Number.isNaN(n) && n >= 0 && n <= 255 && part === String(n);
            })
          ) {
            return undefined;
          }
          return "无效的 IPv4 地址（每个八位字节必须是 0-255）";
        },
      }),
      runtime,
    );
    customBindHost = typeof input === "string" ? input : undefined;
  }

  let authMode = guardCancel(
    await select({
      message: "网关认证",
      options: [
        { value: "token", label: "令牌", hint: "推荐默认方式" },
        { value: "password", label: "密码" },
      ],
      initialValue: "token",
    }),
    runtime,
  ) as GatewayAuthChoice;

  const tailscaleMode = guardCancel(
    await select({
      message: "Tailscale 暴露方式",
      options: [
        { value: "off", label: "关闭", hint: "不使用 Tailscale 暴露" },
        {
          value: "serve",
          label: "Serve",
          hint: "为您的 tailnet 提供私有 HTTPS（Tailscale 上的设备）",
        },
        {
          value: "funnel",
          label: "Funnel",
          hint: "通过 Tailscale Funnel 提供公共 HTTPS（互联网）",
        },
      ],
    }),
    runtime,
  );

  // Detect Tailscale binary before proceeding with serve/funnel setup.
  if (tailscaleMode !== "off") {
    const tailscaleBin = await findTailscaleBinary();
    if (!tailscaleBin) {
      note(
        [
          "在 PATH 或 /Applications 中未找到 Tailscale 二进制文件。",
          "请确保已从以下地址安装 Tailscale：",
          "  https://tailscale.com/download/mac",
          "",
          "您可以继续设置，但 serve/funnel 将在运行时失败。",
        ].join("\n"),
        "Tailscale 警告",
      );
    }
  }

  let tailscaleResetOnExit = false;
  if (tailscaleMode !== "off") {
    note(
      ["文档：", "https://docs.openclaw.ai/gateway/tailscale", "https://docs.openclaw.ai/web"].join(
        "\n",
      ),
      "Tailscale",
    );
    tailscaleResetOnExit = Boolean(
      guardCancel(
        await confirm({
          message: "退出时重置 Tailscale serve/funnel？",
          initialValue: false,
        }),
        runtime,
      ),
    );
  }

  if (tailscaleMode !== "off" && bind !== "loopback") {
    note("Tailscale 需要 bind=loopback。正在将绑定调整为回环。", "提示");
    bind = "loopback";
  }

  if (tailscaleMode === "funnel" && authMode !== "password") {
    note("Tailscale funnel 需要密码认证。", "提示");
    authMode = "password";
  }

  let gatewayToken: string | undefined;
  let gatewayPassword: string | undefined;
  let next = cfg;

  if (authMode === "token") {
    const tokenInput = guardCancel(
      await text({
        message: "网关令牌（留空自动生成）",
        initialValue: randomToken(),
      }),
      runtime,
    );
    gatewayToken = normalizeGatewayTokenInput(tokenInput) || randomToken();
  }

  if (authMode === "password") {
    const password = guardCancel(
      await text({
        message: "网关密码",
        validate: (value) => (value?.trim() ? undefined : "必填"),
      }),
      runtime,
    );
    gatewayPassword = String(password).trim();
  }

  const authConfig = buildGatewayAuthConfig({
    existing: next.gateway?.auth,
    mode: authMode,
    token: gatewayToken,
    password: gatewayPassword,
  });

  next = {
    ...next,
    gateway: {
      ...next.gateway,
      mode: "local",
      port,
      bind,
      auth: authConfig,
      ...(customBindHost && { customBindHost }),
      tailscale: {
        ...next.gateway?.tailscale,
        mode: tailscaleMode,
        resetOnExit: tailscaleResetOnExit,
      },
    },
  };

  return { config: next, port, token: gatewayToken };
}
