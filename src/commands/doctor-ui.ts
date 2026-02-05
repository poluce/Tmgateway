import fs from "node:fs/promises";
import path from "node:path";
import type { RuntimeEnv } from "../runtime.js";
import type { DoctorPrompter } from "./doctor-prompter.js";
import { resolveOpenClawPackageRoot } from "../infra/openclaw-root.js";
import { runCommandWithTimeout } from "../process/exec.js";
import { note } from "../terminal/note.js";

export async function maybeRepairUiProtocolFreshness(
  _runtime: RuntimeEnv,
  prompter: DoctorPrompter,
) {
  const root = await resolveOpenClawPackageRoot({
    moduleUrl: import.meta.url,
    argv1: process.argv[1],
    cwd: process.cwd(),
  });

  if (!root) {
    return;
  }

  const schemaPath = path.join(root, "src/gateway/protocol/schema.ts");
  const uiIndexPath = path.join(root, "dist/control-ui/index.html");

  try {
    const [schemaStats, uiStats] = await Promise.all([
      fs.stat(schemaPath).catch(() => null),
      fs.stat(uiIndexPath).catch(() => null),
    ]);

    if (schemaStats && !uiStats) {
      note(["- 控制界面资源缺失。", "- 运行：pnpm ui:build"].join("\n"), "界面");

      // In slim/docker environments we may not have the UI source tree. Trying
      // to build would fail (and spam logs), so skip the interactive repair.
      const uiSourcesPath = path.join(root, "ui/package.json");
      const uiSourcesExist = await fs.stat(uiSourcesPath).catch(() => null);
      if (!uiSourcesExist) {
        note("跳过界面构建：ui/ 源代码不存在。", "界面");
        return;
      }

      const shouldRepair = await prompter.confirmRepair({
        message: "现在构建控制界面资源？",
        initialValue: true,
      });

      if (shouldRepair) {
        note("正在构建控制界面资源...（可能需要一些时间）", "界面");
        const uiScriptPath = path.join(root, "scripts/ui.js");
        const buildResult = await runCommandWithTimeout([process.execPath, uiScriptPath, "build"], {
          cwd: root,
          timeoutMs: 120_000,
          env: { ...process.env, FORCE_COLOR: "1" },
        });
        if (buildResult.code === 0) {
          note("界面构建完成。", "界面");
        } else {
          const details = [
            `界面构建失败（退出码 ${buildResult.code ?? "未知"}）。`,
            buildResult.stderr.trim() ? buildResult.stderr.trim() : null,
          ]
            .filter(Boolean)
            .join("\n");
          note(details, "界面");
        }
      }
      return;
    }

    if (!schemaStats || !uiStats) {
      return;
    }

    if (schemaStats.mtime > uiStats.mtime) {
      const uiMtimeIso = uiStats.mtime.toISOString();
      // Find changes since the UI build
      const gitLog = await runCommandWithTimeout(
        [
          "git",
          "-C",
          root,
          "log",
          `--since=${uiMtimeIso}`,
          "--format=%h %s",
          "src/gateway/protocol/schema.ts",
        ],
        { timeoutMs: 5000 },
      ).catch(() => null);

      if (gitLog && gitLog.code === 0 && gitLog.stdout.trim()) {
        note(
          `界面资源比协议架构旧。\n自上次构建以来的功能更改：\n${gitLog.stdout
            .trim()
            .split("\n")
            .map((l) => `- ${l}`)
            .join("\n")}`,
          "界面新鲜度",
        );

        const shouldRepair = await prompter.confirmAggressive({
          message: "现在重建界面？（检测到需要更新的协议不匹配）",
          initialValue: true,
        });

        if (shouldRepair) {
          const uiSourcesPath = path.join(root, "ui/package.json");
          const uiSourcesExist = await fs.stat(uiSourcesPath).catch(() => null);
          if (!uiSourcesExist) {
            note("跳过界面重建：ui/ 源代码不存在。", "界面");
            return;
          }

          note("正在重建过期的界面资源...（可能需要一些时间）", "界面");
          // Use scripts/ui.js to build, assuming node is available as we are running in it.
          // We use the same node executable to run the script.
          const uiScriptPath = path.join(root, "scripts/ui.js");
          const buildResult = await runCommandWithTimeout(
            [process.execPath, uiScriptPath, "build"],
            {
              cwd: root,
              timeoutMs: 120_000,
              env: { ...process.env, FORCE_COLOR: "1" },
            },
          );
          if (buildResult.code === 0) {
            note("界面重建完成。", "界面");
          } else {
            const details = [
              `界面重建失败（退出码 ${buildResult.code ?? "未知"}）。`,
              buildResult.stderr.trim() ? buildResult.stderr.trim() : null,
            ]
              .filter(Boolean)
              .join("\n");
            note(details, "界面");
          }
        }
      }
    }
  } catch {
    // If files don't exist, we can't check.
    // If git fails, we silently skip.
    // runtime.debug(`UI freshness check failed: ${String(err)}`);
  }
}
