import type { RuntimeEnv } from "../runtime.js";
import {
  enableSystemdUserLinger,
  isSystemdUserServiceAvailable,
  readSystemdUserLingerStatus,
} from "../daemon/systemd.js";
import { note } from "../terminal/note.js";

export type LingerPrompter = {
  confirm?: (params: { message: string; initialValue?: boolean }) => Promise<boolean>;
  note: (message: string, title?: string) => Promise<void> | void;
};

export async function ensureSystemdUserLingerInteractive(params: {
  runtime: RuntimeEnv;
  prompter?: LingerPrompter;
  env?: NodeJS.ProcessEnv;
  title?: string;
  reason?: string;
  prompt?: boolean;
  requireConfirm?: boolean;
}): Promise<void> {
  if (process.platform !== "linux") {
    return;
  }
  if (params.prompt === false) {
    return;
  }
  const env = params.env ?? process.env;
  const prompter = params.prompter ?? { note };
  const title = params.title ?? "Systemd";
  if (!(await isSystemdUserServiceAvailable())) {
    await prompter.note("Systemd 用户服务不可用。跳过 lingering 检查。", title);
    return;
  }
  const status = await readSystemdUserLingerStatus(env);
  if (!status) {
    await prompter.note("无法读取 loginctl linger 状态。请确保 systemd + loginctl 可用。", title);
    return;
  }
  if (status.linger === "yes") {
    return;
  }

  const reason = params.reason ?? "Systemd 用户服务在您注销或空闲时会停止，这会终止网关。";
  const actionNote = params.requireConfirm
    ? "我们现在可以启用 lingering（可能需要 sudo；写入 /var/lib/systemd/linger）。"
    : "正在启用 lingering（可能需要 sudo；写入 /var/lib/systemd/linger）。";
  await prompter.note(`${reason}\n${actionNote}`, title);

  if (params.requireConfirm && prompter.confirm) {
    const ok = await prompter.confirm({
      message: `为 ${status.user} 启用 systemd lingering？`,
      initialValue: true,
    });
    if (!ok) {
      await prompter.note("没有 lingering，网关将在您注销时停止。", title);
      return;
    }
  }

  const resultNoSudo = await enableSystemdUserLinger({
    env,
    user: status.user,
  });
  if (resultNoSudo.ok) {
    await prompter.note(`已为 ${status.user} 启用 systemd lingering。`, title);
    return;
  }

  const result = await enableSystemdUserLinger({
    env,
    user: status.user,
    sudoMode: "prompt",
  });
  if (result.ok) {
    await prompter.note(`已为 ${status.user} 启用 systemd lingering。`, title);
    return;
  }

  params.runtime.error(`启用 lingering 失败：${result.stderr || result.stdout || "未知错误"}`);
  await prompter.note(`手动运行：sudo loginctl enable-linger ${status.user}`, title);
}

export async function ensureSystemdUserLingerNonInteractive(params: {
  runtime: RuntimeEnv;
  env?: NodeJS.ProcessEnv;
}): Promise<void> {
  if (process.platform !== "linux") {
    return;
  }
  const env = params.env ?? process.env;
  if (!(await isSystemdUserServiceAvailable())) {
    return;
  }
  const status = await readSystemdUserLingerStatus(env);
  if (!status || status.linger === "yes") {
    return;
  }

  const result = await enableSystemdUserLinger({
    env,
    user: status.user,
    sudoMode: "non-interactive",
  });
  if (result.ok) {
    params.runtime.log(`已为 ${status.user} 启用 systemd lingering。`);
    return;
  }

  params.runtime.log(
    `${status.user} 的 systemd lingering 已禁用。运行：sudo loginctl enable-linger ${status.user}`,
  );
}
