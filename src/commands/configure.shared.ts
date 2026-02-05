import {
  confirm as clackConfirm,
  intro as clackIntro,
  outro as clackOutro,
  select as clackSelect,
  text as clackText,
} from "@clack/prompts";
import { stylePromptHint, stylePromptMessage, stylePromptTitle } from "../terminal/prompt-style.js";

export const CONFIGURE_WIZARD_SECTIONS = [
  "workspace",
  "model",
  "web",
  "gateway",
  "daemon",
  "channels",
  "skills",
  "health",
] as const;

export type WizardSection = (typeof CONFIGURE_WIZARD_SECTIONS)[number];

export type ChannelsWizardMode = "configure" | "remove";

export type ConfigureWizardParams = {
  command: "configure" | "update";
  sections?: WizardSection[];
};

export const CONFIGURE_SECTION_OPTIONS: Array<{
  value: WizardSection;
  label: string;
  hint: string;
}> = [
  { value: "workspace", label: "工作空间", hint: "设置工作空间和会话目录" },
  { value: "model", label: "模型", hint: "选择提供商和凭证" },
  { value: "web", label: "网络工具", hint: "配置 Brave 搜索和网页抓取" },
  { value: "gateway", label: "网关", hint: "端口、绑定、认证、Tailscale" },
  {
    value: "daemon",
    label: "守护进程",
    hint: "安装/管理后台服务",
  },
  {
    value: "channels",
    label: "频道",
    hint: "连接 WhatsApp/Telegram 等并设置默认值",
  },
  { value: "skills", label: "技能", hint: "安装/启用工作空间技能" },
  {
    value: "health",
    label: "健康检查",
    hint: "运行网关和频道检查",
  },
];

export const intro = (message: string) => clackIntro(stylePromptTitle(message) ?? message);
export const outro = (message: string) => clackOutro(stylePromptTitle(message) ?? message);
export const text = (params: Parameters<typeof clackText>[0]) =>
  clackText({
    ...params,
    message: stylePromptMessage(params.message),
  });
export const confirm = (params: Parameters<typeof clackConfirm>[0]) =>
  clackConfirm({
    ...params,
    message: stylePromptMessage(params.message),
  });
export const select = <T>(params: Parameters<typeof clackSelect<T>>[0]) =>
  clackSelect({
    ...params,
    message: stylePromptMessage(params.message),
    options: params.options.map((opt) =>
      opt.hint === undefined ? opt : { ...opt, hint: stylePromptHint(opt.hint) },
    ),
  });
