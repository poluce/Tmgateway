import { Type } from "@sinclair/typebox";
import { loadConfig } from "../../config/config.js";
import { normalizeCronJobCreate, normalizeCronJobPatch } from "../../cron/normalize.js";
import { truncateUtf16Safe } from "../../utils.js";
import { resolveSessionAgentId } from "../agent-scope.js";
import { optionalStringEnum, stringEnum } from "../schema/typebox.js";
import { type AnyAgentTool, jsonResult, readStringParam } from "./common.js";
import { callGatewayTool, type GatewayCallOptions } from "./gateway.js";
import { resolveInternalSessionKey, resolveMainSessionAlias } from "./sessions-helpers.js";

// NOTE: We use Type.Object({}, { additionalProperties: true }) for job/patch
// instead of CronAddParamsSchema/CronJobPatchSchema because the gateway schemas
// contain nested unions. Tool schemas need to stay provider-friendly, so we
// accept "any object" here and validate at runtime.

const CRON_ACTIONS = ["status", "list", "add", "update", "remove", "run", "runs", "wake"] as const;

const CRON_WAKE_MODES = ["now", "next-heartbeat"] as const;

const REMINDER_CONTEXT_MESSAGES_MAX = 10;
const REMINDER_CONTEXT_PER_MESSAGE_MAX = 220;
const REMINDER_CONTEXT_TOTAL_MAX = 700;
const REMINDER_CONTEXT_MARKER = "\n\nRecent context:\n";

// Flattened schema: runtime validates per-action requirements.
const CronToolSchema = Type.Object({
  action: stringEnum(CRON_ACTIONS),
  gatewayUrl: Type.Optional(Type.String()),
  gatewayToken: Type.Optional(Type.String()),
  timeoutMs: Type.Optional(Type.Number()),
  includeDisabled: Type.Optional(Type.Boolean()),
  job: Type.Optional(Type.Object({}, { additionalProperties: true })),
  jobId: Type.Optional(Type.String()),
  id: Type.Optional(Type.String()),
  patch: Type.Optional(Type.Object({}, { additionalProperties: true })),
  text: Type.Optional(Type.String()),
  mode: optionalStringEnum(CRON_WAKE_MODES),
  contextMessages: Type.Optional(
    Type.Number({ minimum: 0, maximum: REMINDER_CONTEXT_MESSAGES_MAX }),
  ),
});

type CronToolOptions = {
  agentSessionKey?: string;
};

type ChatMessage = {
  role?: unknown;
  content?: unknown;
};

function stripExistingContext(text: string) {
  const index = text.indexOf(REMINDER_CONTEXT_MARKER);
  if (index === -1) {
    return text;
  }
  return text.slice(0, index).trim();
}

function truncateText(input: string, maxLen: number) {
  if (input.length <= maxLen) {
    return input;
  }
  const truncated = truncateUtf16Safe(input, Math.max(0, maxLen - 3)).trimEnd();
  return `${truncated}...`;
}

function normalizeContextText(raw: string) {
  return raw.replace(/\s+/g, " ").trim();
}

function extractMessageText(message: ChatMessage): { role: string; text: string } | null {
  const role = typeof message.role === "string" ? message.role : "";
  if (role !== "user" && role !== "assistant") {
    return null;
  }
  const content = message.content;
  if (typeof content === "string") {
    const normalized = normalizeContextText(content);
    return normalized ? { role, text: normalized } : null;
  }
  if (!Array.isArray(content)) {
    return null;
  }
  const chunks: string[] = [];
  for (const block of content) {
    if (!block || typeof block !== "object") {
      continue;
    }
    if ((block as { type?: unknown }).type !== "text") {
      continue;
    }
    const text = (block as { text?: unknown }).text;
    if (typeof text === "string" && text.trim()) {
      chunks.push(text);
    }
  }
  const joined = normalizeContextText(chunks.join(" "));
  return joined ? { role, text: joined } : null;
}

async function buildReminderContextLines(params: {
  agentSessionKey?: string;
  gatewayOpts: GatewayCallOptions;
  contextMessages: number;
}) {
  const maxMessages = Math.min(
    REMINDER_CONTEXT_MESSAGES_MAX,
    Math.max(0, Math.floor(params.contextMessages)),
  );
  if (maxMessages <= 0) {
    return [];
  }
  const sessionKey = params.agentSessionKey?.trim();
  if (!sessionKey) {
    return [];
  }
  const cfg = loadConfig();
  const { mainKey, alias } = resolveMainSessionAlias(cfg);
  const resolvedKey = resolveInternalSessionKey({ key: sessionKey, alias, mainKey });
  try {
    const res = await callGatewayTool<{ messages: Array<unknown> }>(
      "chat.history",
      params.gatewayOpts,
      {
        sessionKey: resolvedKey,
        limit: maxMessages,
      },
    );
    const messages = Array.isArray(res?.messages) ? res.messages : [];
    const parsed = messages
      .map((msg) => extractMessageText(msg as ChatMessage))
      .filter((msg): msg is { role: string; text: string } => Boolean(msg));
    const recent = parsed.slice(-maxMessages);
    if (recent.length === 0) {
      return [];
    }
    const lines: string[] = [];
    let total = 0;
    for (const entry of recent) {
      const label = entry.role === "user" ? "User" : "Assistant";
      const text = truncateText(entry.text, REMINDER_CONTEXT_PER_MESSAGE_MAX);
      const line = `- ${label}: ${text}`;
      total += line.length;
      if (total > REMINDER_CONTEXT_TOTAL_MAX) {
        break;
      }
      lines.push(line);
    }
    return lines;
  } catch {
    return [];
  }
}

export function createCronTool(opts?: CronToolOptions): AnyAgentTool {
  return {
    label: "定时任务",
    name: "cron",
    description: `管理网关定时任务（状态/列表/添加/更新/删除/运行/运行记录）和发送唤醒事件。

操作：
- status：检查定时调度器状态
- list：列出任务（使用 includeDisabled:true 包含已禁用的）
- add：创建任务（需要 job 对象，见下方架构）
- update：修改任务（需要 jobId + patch 对象）
- remove：删除任务（需要 jobId）
- run：立即触发任务（需要 jobId）
- runs：获取任务运行历史（需要 jobId）
- wake：发送唤醒事件（需要 text，可选 mode）

任务架构（用于 add 操作）：
{
  "name": "string (可选)",
  "schedule": { ... },      // 必需：何时运行
  "payload": { ... },       // 必需：执行什么
  "sessionTarget": "main" | "isolated",  // 必需
  "enabled": true | false   // 可选，默认 true
}

调度类型（schedule.kind）：
- "at"：在绝对时间一次性执行
  { "kind": "at", "atMs": <unix毫秒时间戳> }
- "every"：循环间隔
  { "kind": "every", "everyMs": <间隔毫秒>, "anchorMs": <可选起始毫秒> }
- "cron"：Cron 表达式
  { "kind": "cron", "expr": "<cron表达式>", "tz": "<可选时区>" }

载荷类型（payload.kind）：
- "systemEvent"：将文本作为系统事件注入会话
  { "kind": "systemEvent", "text": "<消息>" }
- "agentTurn"：使用消息运行代理（仅限隔离会话）
  { "kind": "agentTurn", "message": "<提示>", "model": "<可选>", "thinking": "<可选>", "timeoutSeconds": <可选>, "deliver": <可选布尔>, "channel": "<可选>", "to": "<可选>", "bestEffortDeliver": <可选布尔> }

关键约束：
- sessionTarget="main" 必须使用 payload.kind="systemEvent"
- sessionTarget="isolated" 必须使用 payload.kind="agentTurn"

唤醒模式（用于 wake 操作）：
- "next-heartbeat"（默认）：在下次心跳时唤醒
- "now"：立即唤醒

使用 jobId 作为规范标识符；id 为兼容性而接受。使用 contextMessages（0-10）将之前的消息作为上下文添加到任务文本中。`,
    parameters: CronToolSchema,
    execute: async (_toolCallId, args) => {
      const params = args as Record<string, unknown>;
      const action = readStringParam(params, "action", { required: true });
      const gatewayOpts: GatewayCallOptions = {
        gatewayUrl: readStringParam(params, "gatewayUrl", { trim: false }),
        gatewayToken: readStringParam(params, "gatewayToken", { trim: false }),
        timeoutMs: typeof params.timeoutMs === "number" ? params.timeoutMs : undefined,
      };

      switch (action) {
        case "status":
          return jsonResult(await callGatewayTool("cron.status", gatewayOpts, {}));
        case "list":
          return jsonResult(
            await callGatewayTool("cron.list", gatewayOpts, {
              includeDisabled: Boolean(params.includeDisabled),
            }),
          );
        case "add": {
          if (!params.job || typeof params.job !== "object") {
            throw new Error("需要提供 job");
          }
          const job = normalizeCronJobCreate(params.job) ?? params.job;
          if (job && typeof job === "object" && !("agentId" in job)) {
            const cfg = loadConfig();
            const agentId = opts?.agentSessionKey
              ? resolveSessionAgentId({ sessionKey: opts.agentSessionKey, config: cfg })
              : undefined;
            if (agentId) {
              (job as { agentId?: string }).agentId = agentId;
            }
          }
          const contextMessages =
            typeof params.contextMessages === "number" && Number.isFinite(params.contextMessages)
              ? params.contextMessages
              : 0;
          if (
            job &&
            typeof job === "object" &&
            "payload" in job &&
            (job as { payload?: { kind?: string; text?: string } }).payload?.kind === "systemEvent"
          ) {
            const payload = (job as { payload: { kind: string; text: string } }).payload;
            if (typeof payload.text === "string" && payload.text.trim()) {
              const contextLines = await buildReminderContextLines({
                agentSessionKey: opts?.agentSessionKey,
                gatewayOpts,
                contextMessages,
              });
              if (contextLines.length > 0) {
                const baseText = stripExistingContext(payload.text);
                payload.text = `${baseText}${REMINDER_CONTEXT_MARKER}${contextLines.join("\n")}`;
              }
            }
          }
          return jsonResult(await callGatewayTool("cron.add", gatewayOpts, job));
        }
        case "update": {
          const id = readStringParam(params, "jobId") ?? readStringParam(params, "id");
          if (!id) {
            throw new Error("需要提供 jobId（为向后兼容也接受 id）");
          }
          if (!params.patch || typeof params.patch !== "object") {
            throw new Error("需要提供 patch");
          }
          const patch = normalizeCronJobPatch(params.patch) ?? params.patch;
          return jsonResult(
            await callGatewayTool("cron.update", gatewayOpts, {
              id,
              patch,
            }),
          );
        }
        case "remove": {
          const id = readStringParam(params, "jobId") ?? readStringParam(params, "id");
          if (!id) {
            throw new Error("需要提供 jobId（为向后兼容也接受 id）");
          }
          return jsonResult(await callGatewayTool("cron.remove", gatewayOpts, { id }));
        }
        case "run": {
          const id = readStringParam(params, "jobId") ?? readStringParam(params, "id");
          if (!id) {
            throw new Error("需要提供 jobId（为向后兼容也接受 id）");
          }
          return jsonResult(await callGatewayTool("cron.run", gatewayOpts, { id }));
        }
        case "runs": {
          const id = readStringParam(params, "jobId") ?? readStringParam(params, "id");
          if (!id) {
            throw new Error("需要提供 jobId（为向后兼容也接受 id）");
          }
          return jsonResult(await callGatewayTool("cron.runs", gatewayOpts, { id }));
        }
        case "wake": {
          const text = readStringParam(params, "text", { required: true });
          const mode =
            params.mode === "now" || params.mode === "next-heartbeat"
              ? params.mode
              : "next-heartbeat";
          return jsonResult(
            await callGatewayTool("wake", gatewayOpts, { mode, text }, { expectFinal: false }),
          );
        }
        default:
          throw new Error(`未知操作：${action}`);
      }
    },
  };
}
