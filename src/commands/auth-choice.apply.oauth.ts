import type { ApplyAuthChoiceParams, ApplyAuthChoiceResult } from "./auth-choice.apply.js";
import { loginChutes } from "./chutes-oauth.js";
import { isRemoteEnvironment } from "./oauth-env.js";
import { createVpsAwareOAuthHandlers } from "./oauth-flow.js";
import { applyAuthProfileConfig, writeOAuthCredentials } from "./onboard-auth.js";
import { openUrl } from "./onboard-helpers.js";

export async function applyAuthChoiceOAuth(
  params: ApplyAuthChoiceParams,
): Promise<ApplyAuthChoiceResult | null> {
  if (params.authChoice === "chutes") {
    let nextConfig = params.config;
    const isRemote = isRemoteEnvironment();
    const redirectUri =
      process.env.CHUTES_OAUTH_REDIRECT_URI?.trim() || "http://127.0.0.1:1456/oauth-callback";
    const scopes = process.env.CHUTES_OAUTH_SCOPES?.trim() || "openid profile chutes:invoke";
    const clientId =
      process.env.CHUTES_CLIENT_ID?.trim() ||
      String(
        await params.prompter.text({
          message: "输入 Chutes OAuth 客户端 ID",
          placeholder: "cid_xxx",
          validate: (value) => (value?.trim() ? undefined : "必填"),
        }),
      ).trim();
    const clientSecret = process.env.CHUTES_CLIENT_SECRET?.trim() || undefined;

    await params.prompter.note(
      isRemote
        ? [
            "您正在远程/VPS 环境中运行。",
            "将显示一个 URL 供您在本地浏览器中打开。",
            "登录后，将重定向 URL 粘贴回此处。",
            "",
            `重定向 URI：${redirectUri}`,
          ].join("\n")
        : [
            "浏览器将打开进行 Chutes 认证。",
            "如果回调未自动完成，请粘贴重定向 URL。",
            "",
            `重定向 URI：${redirectUri}`,
          ].join("\n"),
      "Chutes OAuth",
    );

    const spin = params.prompter.progress("正在启动 OAuth 流程…");
    try {
      const { onAuth, onPrompt } = createVpsAwareOAuthHandlers({
        isRemote,
        prompter: params.prompter,
        runtime: params.runtime,
        spin,
        openUrl,
        localBrowserMessage: "Complete sign-in in browser…",
      });

      const creds = await loginChutes({
        app: {
          clientId,
          clientSecret,
          redirectUri,
          scopes: scopes.split(/\s+/).filter(Boolean),
        },
        manual: isRemote,
        onAuth,
        onPrompt,
        onProgress: (msg) => spin.update(msg),
      });

      spin.stop("Chutes OAuth complete");
      const email =
        typeof creds.email === "string" && creds.email.trim() ? creds.email.trim() : "default";
      const profileId = `chutes:${email}`;

      await writeOAuthCredentials("chutes", creds, params.agentDir);
      nextConfig = applyAuthProfileConfig(nextConfig, {
        profileId,
        provider: "chutes",
        mode: "oauth",
      });
    } catch (err) {
      spin.stop("Chutes OAuth failed");
      params.runtime.error(String(err));
      await params.prompter.note(
        [
          "Trouble with OAuth?",
          "Verify CHUTES_CLIENT_ID (and CHUTES_CLIENT_SECRET if required).",
          `Verify the OAuth app redirect URI includes: ${redirectUri}`,
          "Chutes docs: https://chutes.ai/docs/sign-in-with-chutes/overview",
        ].join("\n"),
        "OAuth help",
      );
    }
    return { config: nextConfig };
  }

  return null;
}
