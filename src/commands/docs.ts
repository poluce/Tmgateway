import type { RuntimeEnv } from "../runtime.js";
import { hasBinary } from "../agents/skills.js";
import { formatCliCommand } from "../cli/command-format.js";
import { runCommandWithTimeout } from "../process/exec.js";
import { formatDocsLink } from "../terminal/links.js";
import { isRich, theme } from "../terminal/theme.js";

const SEARCH_TOOL = "https://docs.openclaw.ai/mcp.SearchOpenClaw";
const SEARCH_TIMEOUT_MS = 30_000;
const DEFAULT_SNIPPET_MAX = 220;

type DocResult = {
  title: string;
  link: string;
  snippet?: string;
};

type NodeRunner = {
  cmd: string;
  args: string[];
};

type ToolRunOptions = {
  input?: string;
  timeoutMs?: number;
};

function resolveNodeRunner(): NodeRunner {
  if (hasBinary("pnpm")) {
    return { cmd: "pnpm", args: ["dlx"] };
  }
  if (hasBinary("npx")) {
    return { cmd: "npx", args: ["-y"] };
  }
  throw new Error("缺少 pnpm 或 npx；请安装 Node 包运行器。");
}

async function runNodeTool(tool: string, toolArgs: string[], options: ToolRunOptions = {}) {
  const runner = resolveNodeRunner();
  const argv = [runner.cmd, ...runner.args, tool, ...toolArgs];
  return await runCommandWithTimeout(argv, {
    timeoutMs: options.timeoutMs ?? SEARCH_TIMEOUT_MS,
    input: options.input,
  });
}

async function runTool(tool: string, toolArgs: string[], options: ToolRunOptions = {}) {
  if (hasBinary(tool)) {
    return await runCommandWithTimeout([tool, ...toolArgs], {
      timeoutMs: options.timeoutMs ?? SEARCH_TIMEOUT_MS,
      input: options.input,
    });
  }
  return await runNodeTool(tool, toolArgs, options);
}

function extractLine(lines: string[], prefix: string): string | undefined {
  const line = lines.find((value) => value.startsWith(prefix));
  if (!line) {
    return undefined;
  }
  return line.slice(prefix.length).trim();
}

function normalizeSnippet(raw: string | undefined, fallback: string): string {
  const base = raw && raw.trim().length > 0 ? raw : fallback;
  const cleaned = base.replace(/\s+/g, " ").trim();
  if (!cleaned) {
    return "";
  }
  if (cleaned.length <= DEFAULT_SNIPPET_MAX) {
    return cleaned;
  }
  return `${cleaned.slice(0, DEFAULT_SNIPPET_MAX - 3)}...`;
}

function firstParagraph(text: string): string {
  const parts = text
    .split(/\n\s*\n/)
    .map((chunk) => chunk.trim())
    .filter(Boolean);
  return parts[0] ?? "";
}

function parseSearchOutput(raw: string): DocResult[] {
  const normalized = raw.replace(/\r/g, "");
  const blocks = normalized
    .split(/\n(?=Title: )/g)
    .map((chunk) => chunk.trim())
    .filter(Boolean);

  const results: DocResult[] = [];
  for (const block of blocks) {
    const lines = block.split("\n");
    const title = extractLine(lines, "Title:");
    const link = extractLine(lines, "Link:");
    if (!title || !link) {
      continue;
    }
    const content = extractLine(lines, "Content:");
    const contentIndex = lines.findIndex((line) => line.startsWith("Content:"));
    const body =
      contentIndex >= 0
        ? lines
            .slice(contentIndex + 1)
            .join("\n")
            .trim()
        : "";
    const snippet = normalizeSnippet(content, firstParagraph(body));
    results.push({ title, link, snippet: snippet || undefined });
  }
  return results;
}

function escapeMarkdown(text: string): string {
  return text.replace(/[()[\]]/g, "\\$&");
}

function buildMarkdown(query: string, results: DocResult[]): string {
  const lines: string[] = [`# 文档搜索：${escapeMarkdown(query)}`, ""];
  if (results.length === 0) {
    lines.push("_无结果。_");
    return lines.join("\n");
  }
  for (const item of results) {
    const title = escapeMarkdown(item.title);
    const snippet = item.snippet ? escapeMarkdown(item.snippet) : "";
    const suffix = snippet ? ` - ${snippet}` : "";
    lines.push(`- [${title}](${item.link})${suffix}`);
  }
  return lines.join("\n");
}

function formatLinkLabel(link: string): string {
  return link.replace(/^https?:\/\//i, "");
}

function renderRichResults(query: string, results: DocResult[], runtime: RuntimeEnv) {
  runtime.log(`${theme.heading("文档搜索：")} ${theme.info(query)}`);
  if (results.length === 0) {
    runtime.log(theme.muted("无结果。"));
    return;
  }
  for (const item of results) {
    const linkLabel = formatLinkLabel(item.link);
    const link = formatDocsLink(item.link, linkLabel);
    runtime.log(
      `${theme.muted("-")} ${theme.command(item.title)} ${theme.muted("(")}${link}${theme.muted(")")}`,
    );
    if (item.snippet) {
      runtime.log(`  ${theme.muted(item.snippet)}`);
    }
  }
}

async function renderMarkdown(markdown: string, runtime: RuntimeEnv) {
  runtime.log(markdown.trimEnd());
}

export async function docsSearchCommand(queryParts: string[], runtime: RuntimeEnv) {
  const query = queryParts.join(" ").trim();
  if (!query) {
    const docs = formatDocsLink("/", "docs.openclaw.ai");
    if (isRich()) {
      runtime.log(`${theme.muted("文档：")} ${docs}`);
      runtime.log(`${theme.muted("搜索：")} ${formatCliCommand('openclaw docs "您的查询"')}`);
    } else {
      runtime.log("文档：https://docs.openclaw.ai/");
      runtime.log(`搜索：${formatCliCommand('openclaw docs "您的查询"')}`);
    }
    return;
  }

  const payload = JSON.stringify({ query });
  const res = await runTool(
    "mcporter",
    ["call", SEARCH_TOOL, "--args", payload, "--output", "text"],
    { timeoutMs: SEARCH_TIMEOUT_MS },
  );

  if (res.code !== 0) {
    const err = res.stderr.trim() || res.stdout.trim() || `退出码 ${res.code}`;
    runtime.error(`文档搜索失败：${err}`);
    runtime.exit(1);
    return;
  }

  const results = parseSearchOutput(res.stdout);
  if (isRich()) {
    renderRichResults(query, results, runtime);
    return;
  }
  const markdown = buildMarkdown(query, results);
  await renderMarkdown(markdown, runtime);
}
