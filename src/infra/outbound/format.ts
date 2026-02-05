import type { ChannelId } from "../../channels/plugins/types.js";
import type { OutboundDeliveryResult } from "./deliver.js";
import { getChannelPlugin } from "../../channels/plugins/index.js";
import { getChatChannelMeta, normalizeChatChannelId } from "../../channels/registry.js";

export type OutboundDeliveryJson = {
  channel: string;
  via: "direct" | "gateway";
  to: string;
  messageId: string;
  mediaUrl: string | null;
  chatId?: string;
  channelId?: string;
  roomId?: string;
  conversationId?: string;
  timestamp?: number;
  toJid?: string;
  meta?: Record<string, unknown>;
};

type OutboundDeliveryMeta = {
  messageId?: string;
  chatId?: string;
  channelId?: string;
  roomId?: string;
  conversationId?: string;
  timestamp?: number;
  toJid?: string;
  meta?: Record<string, unknown>;
};

const resolveChannelLabel = (channel: string) => {
  const pluginLabel = getChannelPlugin(channel as ChannelId)?.meta.label;
  if (pluginLabel) {
    return pluginLabel;
  }
  const normalized = normalizeChatChannelId(channel);
  if (normalized) {
    return getChatChannelMeta(normalized).label;
  }
  return channel;
};

export function formatOutboundDeliverySummary(
  channel: string,
  result?: OutboundDeliveryResult,
): string {
  if (!result) {
    return `✅ 已通过 ${resolveChannelLabel(channel)} 发送。消息 ID：未知`;
  }

  const label = resolveChannelLabel(result.channel);
  const base = `✅ 已通过 ${label} 发送。消息 ID：${result.messageId}`;

  if ("chatId" in result) {
    return `${base}（聊天 ${result.chatId}）`;
  }
  if ("channelId" in result) {
    return `${base}（频道 ${result.channelId}）`;
  }
  if ("roomId" in result) {
    return `${base}（房间 ${result.roomId}）`;
  }
  if ("conversationId" in result) {
    return `${base}（会话 ${result.conversationId}）`;
  }
  return base;
}

export function buildOutboundDeliveryJson(params: {
  channel: string;
  to: string;
  result?: OutboundDeliveryMeta | OutboundDeliveryResult;
  via?: "direct" | "gateway";
  mediaUrl?: string | null;
}): OutboundDeliveryJson {
  const { channel, to, result } = params;
  const messageId = result?.messageId ?? "unknown";
  const payload: OutboundDeliveryJson = {
    channel,
    via: params.via ?? "direct",
    to,
    messageId,
    mediaUrl: params.mediaUrl ?? null,
  };

  if (result && "chatId" in result && result.chatId !== undefined) {
    payload.chatId = result.chatId;
  }
  if (result && "channelId" in result && result.channelId !== undefined) {
    payload.channelId = result.channelId;
  }
  if (result && "roomId" in result && result.roomId !== undefined) {
    payload.roomId = result.roomId;
  }
  if (result && "conversationId" in result && result.conversationId !== undefined) {
    payload.conversationId = result.conversationId;
  }
  if (result && "timestamp" in result && result.timestamp !== undefined) {
    payload.timestamp = result.timestamp;
  }
  if (result && "toJid" in result && result.toJid !== undefined) {
    payload.toJid = result.toJid;
  }
  if (result && "meta" in result && result.meta !== undefined) {
    payload.meta = result.meta;
  }

  return payload;
}

export function formatGatewaySummary(params: {
  action?: string;
  channel?: string;
  messageId?: string | null;
}): string {
  const action = params.action ?? "已发送";
  const channelSuffix = params.channel ? `（${params.channel}）` : "";
  const messageId = params.messageId ?? "未知";
  return `✅ ${action} 通过网关${channelSuffix}。消息 ID：${messageId}`;
}
