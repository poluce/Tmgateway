import type { AuthProfileStore } from "../agents/auth-profiles.js";
import type { AuthChoice } from "./onboard-types.js";

export type AuthChoiceOption = {
  value: AuthChoice;
  label: string;
  hint?: string;
};

export type AuthChoiceGroupId =
  | "openai"
  | "anthropic"
  | "google"
  | "copilot"
  | "openrouter"
  | "ai-gateway"
  | "moonshot"
  | "zai"
  | "xiaomi"
  | "opencode-zen"
  | "minimax"
  | "synthetic"
  | "venice"
  | "qwen";

export type AuthChoiceGroup = {
  value: AuthChoiceGroupId;
  label: string;
  hint?: string;
  options: AuthChoiceOption[];
};

const AUTH_CHOICE_GROUP_DEFS: {
  value: AuthChoiceGroupId;
  label: string;
  hint?: string;
  choices: AuthChoice[];
}[] = [
  {
    value: "openai",
    label: "OpenAI",
    hint: "Codex OAuth + API 密钥",
    choices: ["openai-codex", "openai-api-key"],
  },
  {
    value: "anthropic",
    label: "Anthropic",
    hint: "setup-token + API 密钥",
    choices: ["token", "apiKey"],
  },
  {
    value: "minimax",
    label: "MiniMax",
    hint: "M2.1（推荐）",
    choices: ["minimax-portal", "minimax-api", "minimax-api-lightning"],
  },
  {
    value: "moonshot",
    label: "Moonshot AI (Kimi K2.5)",
    hint: "Kimi K2.5 + Kimi 编程",
    choices: ["moonshot-api-key", "moonshot-api-key-cn", "kimi-code-api-key"],
  },
  {
    value: "google",
    label: "Google",
    hint: "Gemini API 密钥 + OAuth",
    choices: ["gemini-api-key", "google-antigravity", "google-gemini-cli"],
  },
  {
    value: "openrouter",
    label: "OpenRouter",
    hint: "API 密钥",
    choices: ["openrouter-api-key"],
  },
  {
    value: "qwen",
    label: "通义千问",
    hint: "OAuth 认证",
    choices: ["qwen-portal"],
  },
  {
    value: "zai",
    label: "Z.AI (GLM 4.7)",
    hint: "API 密钥",
    choices: ["zai-api-key"],
  },
  {
    value: "copilot",
    label: "Copilot",
    hint: "GitHub + 本地代理",
    choices: ["github-copilot", "copilot-proxy"],
  },
  {
    value: "ai-gateway",
    label: "Vercel AI Gateway",
    hint: "API 密钥",
    choices: ["ai-gateway-api-key"],
  },
  {
    value: "opencode-zen",
    label: "OpenCode Zen",
    hint: "API 密钥",
    choices: ["opencode-zen"],
  },
  {
    value: "xiaomi",
    label: "小米",
    hint: "API 密钥",
    choices: ["xiaomi-api-key"],
  },
  {
    value: "synthetic",
    label: "Synthetic",
    hint: "Anthropic 兼容（多模型）",
    choices: ["synthetic-api-key"],
  },
  {
    value: "venice",
    label: "Venice AI",
    hint: "隐私优先（无审查模型）",
    choices: ["venice-api-key"],
  },
];

export function buildAuthChoiceOptions(params: {
  store: AuthProfileStore;
  includeSkip: boolean;
}): AuthChoiceOption[] {
  void params.store;
  const options: AuthChoiceOption[] = [];

  options.push({
    value: "token",
    label: "Anthropic 令牌（粘贴 setup-token）",
    hint: "在其他地方运行 `claude setup-token`，然后在此粘贴令牌",
  });

  options.push({
    value: "openai-codex",
    label: "OpenAI Codex（ChatGPT OAuth）",
  });
  options.push({ value: "chutes", label: "Chutes（OAuth）" });
  options.push({ value: "openai-api-key", label: "OpenAI API 密钥" });
  options.push({ value: "openrouter-api-key", label: "OpenRouter API 密钥" });
  options.push({
    value: "ai-gateway-api-key",
    label: "Vercel AI Gateway API 密钥",
  });
  options.push({
    value: "moonshot-api-key",
    label: "Kimi API 密钥（.ai）",
  });
  options.push({
    value: "moonshot-api-key-cn",
    label: "Kimi API 密钥（.cn）",
  });
  options.push({ value: "kimi-code-api-key", label: "Kimi Code API 密钥（订阅）" });
  options.push({ value: "synthetic-api-key", label: "Synthetic API 密钥" });
  options.push({
    value: "venice-api-key",
    label: "Venice AI API 密钥",
    hint: "隐私优先推理（无审查模型）",
  });
  options.push({
    value: "github-copilot",
    label: "GitHub Copilot（GitHub 设备登录）",
    hint: "使用 GitHub 设备流程",
  });
  options.push({ value: "gemini-api-key", label: "Google Gemini API 密钥" });
  options.push({
    value: "google-antigravity",
    label: "Google Antigravity OAuth",
    hint: "使用内置的 Antigravity 认证插件",
  });
  options.push({
    value: "google-gemini-cli",
    label: "Google Gemini CLI OAuth",
    hint: "使用内置的 Gemini CLI 认证插件",
  });
  options.push({ value: "zai-api-key", label: "Z.AI（GLM 4.7）API 密钥" });
  options.push({
    value: "xiaomi-api-key",
    label: "小米 API 密钥",
  });
  options.push({
    value: "minimax-portal",
    label: "MiniMax OAuth",
    hint: "MiniMax 的 OAuth 插件",
  });
  options.push({ value: "qwen-portal", label: "通义千问 OAuth" });
  options.push({
    value: "copilot-proxy",
    label: "Copilot 代理（本地）",
    hint: "VS Code Copilot 模型的本地代理",
  });
  options.push({ value: "apiKey", label: "Anthropic API 密钥" });
  // Token flow is currently Anthropic-only; use CLI for advanced providers.
  options.push({
    value: "opencode-zen",
    label: "OpenCode Zen（多模型代理）",
    hint: "通过 opencode.ai/zen 使用 Claude、GPT、Gemini",
  });
  options.push({ value: "minimax-api", label: "MiniMax M2.1" });
  options.push({
    value: "minimax-api-lightning",
    label: "MiniMax M2.1 Lightning",
    hint: "更快，输出成本更高",
  });
  if (params.includeSkip) {
    options.push({ value: "skip", label: "暂时跳过" });
  }

  return options;
}

export function buildAuthChoiceGroups(params: { store: AuthProfileStore; includeSkip: boolean }): {
  groups: AuthChoiceGroup[];
  skipOption?: AuthChoiceOption;
} {
  const options = buildAuthChoiceOptions({
    ...params,
    includeSkip: false,
  });
  const optionByValue = new Map<AuthChoice, AuthChoiceOption>(
    options.map((opt) => [opt.value, opt]),
  );

  const groups = AUTH_CHOICE_GROUP_DEFS.map((group) => ({
    ...group,
    options: group.choices
      .map((choice) => optionByValue.get(choice))
      .filter((opt): opt is AuthChoiceOption => Boolean(opt)),
  }));

  const skipOption = params.includeSkip
    ? ({ value: "skip", label: "暂时跳过" } satisfies AuthChoiceOption)
    : undefined;

  return { groups, skipOption };
}
