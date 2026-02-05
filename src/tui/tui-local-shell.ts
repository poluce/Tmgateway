import type { Component, SelectItem } from "@mariozechner/pi-tui";
import { spawn } from "node:child_process";
import { createSearchableSelectList } from "./components/selectors.js";

type LocalShellDeps = {
  chatLog: {
    addSystem: (line: string) => void;
  };
  tui: {
    requestRender: () => void;
  };
  openOverlay: (component: Component) => void;
  closeOverlay: () => void;
  createSelector?: (
    items: SelectItem[],
    maxVisible: number,
  ) => Component & {
    onSelect?: (item: SelectItem) => void;
    onCancel?: () => void;
  };
  spawnCommand?: typeof spawn;
  getCwd?: () => string;
  env?: NodeJS.ProcessEnv;
  maxOutputChars?: number;
};

export function createLocalShellRunner(deps: LocalShellDeps) {
  let localExecAsked = false;
  let localExecAllowed = false;
  const createSelector = deps.createSelector ?? createSearchableSelectList;
  const spawnCommand = deps.spawnCommand ?? spawn;
  const getCwd = deps.getCwd ?? (() => process.cwd());
  const env = deps.env ?? process.env;
  const maxChars = deps.maxOutputChars ?? 40_000;

  const ensureLocalExecAllowed = async (): Promise<boolean> => {
    if (localExecAllowed) {
      return true;
    }
    if (localExecAsked) {
      return false;
    }
    localExecAsked = true;

    return await new Promise<boolean>((resolve) => {
      deps.chatLog.addSystem("是否允许本会话执行本地 shell 命令？");
      deps.chatLog.addSystem(
        "这将在您的机器上（而非网关）运行命令，可能会删除文件或泄露敏感信息。",
      );
      deps.chatLog.addSystem("使用方向键选择 是/否，按 Enter 确认，Esc 取消。");
      const selector = createSelector(
        [
          { value: "no", label: "否" },
          { value: "yes", label: "是" },
        ],
        2,
      );
      selector.onSelect = (item) => {
        deps.closeOverlay();
        if (item.value === "yes") {
          localExecAllowed = true;
          deps.chatLog.addSystem("本地 shell：已为本会话启用");
          resolve(true);
        } else {
          deps.chatLog.addSystem("本地 shell：未启用");
          resolve(false);
        }
        deps.tui.requestRender();
      };
      selector.onCancel = () => {
        deps.closeOverlay();
        deps.chatLog.addSystem("本地 shell：已取消");
        deps.tui.requestRender();
        resolve(false);
      };
      deps.openOverlay(selector);
      deps.tui.requestRender();
    });
  };

  const runLocalShellLine = async (line: string) => {
    const cmd = line.slice(1);
    // NOTE: A lone '!' is handled by the submit handler as a normal message.
    // Keep this guard anyway in case this is called directly.
    if (cmd === "") {
      return;
    }

    if (localExecAsked && !localExecAllowed) {
      deps.chatLog.addSystem("本地 shell：本会话未启用");
      deps.tui.requestRender();
      return;
    }

    const allowed = await ensureLocalExecAllowed();
    if (!allowed) {
      return;
    }

    deps.chatLog.addSystem(`[local] $ ${cmd}`);
    deps.tui.requestRender();

    await new Promise<void>((resolve) => {
      const child = spawnCommand(cmd, {
        shell: true,
        cwd: getCwd(),
        env,
      });

      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (buf) => {
        stdout += buf.toString("utf8");
      });
      child.stderr.on("data", (buf) => {
        stderr += buf.toString("utf8");
      });

      child.on("close", (code, signal) => {
        const combined = (stdout + (stderr ? (stdout ? "\n" : "") + stderr : ""))
          .slice(0, maxChars)
          .trimEnd();

        if (combined) {
          for (const line of combined.split("\n")) {
            deps.chatLog.addSystem(`[local] ${line}`);
          }
        }
        deps.chatLog.addSystem(
          `[local] exit ${code ?? "?"}${signal ? ` (signal ${String(signal)})` : ""}`,
        );
        deps.tui.requestRender();
        resolve();
      });

      child.on("error", (err) => {
        deps.chatLog.addSystem(`[本地] 错误：${String(err)}`);
        deps.tui.requestRender();
        resolve();
      });
    });
  };

  return { runLocalShellLine };
}
