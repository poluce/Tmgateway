import fs from "node:fs";
import path from "node:path";
import { DEFAULT_AGENTS_FILENAME } from "../agents/workspace.js";
import { shortenHomePath } from "../utils.js";

export const MEMORY_SYSTEM_PROMPT = [
  "工作空间中未找到记忆系统。",
  "将以下内容粘贴到您的代理中：",
  "",
  "通过应用以下提交安装记忆系统：",
  "https://github.com/openclaw/openclaw/commit/9ffea23f31ca1df5183b25668f8f814bee0fb34e",
  "https://github.com/openclaw/openclaw/commit/7d1fee70e76f2f634f1b41fca927ee663914183a",
].join("\n");

export async function shouldSuggestMemorySystem(workspaceDir: string): Promise<boolean> {
  const memoryPaths = [path.join(workspaceDir, "MEMORY.md"), path.join(workspaceDir, "memory.md")];

  for (const memoryPath of memoryPaths) {
    try {
      await fs.promises.access(memoryPath);
      return false;
    } catch {
      // keep scanning
    }
  }

  const agentsPath = path.join(workspaceDir, DEFAULT_AGENTS_FILENAME);
  try {
    const content = await fs.promises.readFile(agentsPath, "utf-8");
    if (/memory\.md/i.test(content)) {
      return false;
    }
  } catch {
    // no AGENTS.md or unreadable; treat as missing memory guidance
  }

  return true;
}

export type LegacyWorkspaceDetection = {
  activeWorkspace: string;
  legacyDirs: string[];
};

export function detectLegacyWorkspaceDirs(params: {
  workspaceDir: string;
}): LegacyWorkspaceDetection {
  const activeWorkspace = path.resolve(params.workspaceDir);
  const legacyDirs: string[] = [];
  return { activeWorkspace, legacyDirs };
}

export function formatLegacyWorkspaceWarning(detection: LegacyWorkspaceDetection): string {
  return [
    "检测到额外的工作空间目录（可能包含旧的代理文件）：",
    ...detection.legacyDirs.map((dir) => `- ${shortenHomePath(dir)}`),
    `活动工作空间：${shortenHomePath(detection.activeWorkspace)}`,
    "如果未使用，请归档或移至废纸篓。",
  ].join("\n");
}
