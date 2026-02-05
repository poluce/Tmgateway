import fs from "node:fs";
import path from "node:path";
import { note } from "../terminal/note.js";

export function noteSourceInstallIssues(root: string | null) {
  if (!root) {
    return;
  }

  const workspaceMarker = path.join(root, "pnpm-workspace.yaml");
  if (!fs.existsSync(workspaceMarker)) {
    return;
  }

  const warnings: string[] = [];
  const nodeModules = path.join(root, "node_modules");
  const pnpmStore = path.join(nodeModules, ".pnpm");
  const tsxBin = path.join(nodeModules, ".bin", "tsx");
  const srcEntry = path.join(root, "src", "entry.ts");

  if (fs.existsSync(nodeModules) && !fs.existsSync(pnpmStore)) {
    warnings.push(
      "- node_modules 不是由 pnpm 安装的（缺少 node_modules/.pnpm）。运行：pnpm install",
    );
  }

  if (fs.existsSync(path.join(root, "package-lock.json"))) {
    warnings.push(
      "- 在 pnpm 工作空间中存在 package-lock.json。如果您运行了 npm install，请删除它并使用 pnpm 重新安装。",
    );
  }

  if (fs.existsSync(srcEntry) && !fs.existsSync(tsxBin)) {
    warnings.push("- 源代码运行缺少 tsx 二进制文件。运行：pnpm install");
  }

  if (warnings.length > 0) {
    note(warnings.join("\n"), "安装");
  }
}
