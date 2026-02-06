import { html, nothing } from "lit";
import type { IMessageStatus } from "../types.ts";
import type { ChannelsProps } from "./channels.types.ts";
import { formatAgo } from "../format.ts";
import { renderChannelConfigSection } from "./channels.config.ts";

export function renderIMessageCard(params: {
  props: ChannelsProps;
  imessage?: IMessageStatus | null;
  accountCountLabel: unknown;
}) {
  const { props, imessage, accountCountLabel } = params;

  return html`
    <div class="card">
      <div class="card-title">iMessage</div>
      <div class="card-sub">macOS 桥接状态和频道配置。</div>
      ${accountCountLabel}

      <div class="status-list" style="margin-top: 16px;">
        <div>
          <span class="label">已配置</span>
          <span>${imessage?.configured ? "是" : "否"}</span>
        </div>
        <div>
          <span class="label">运行中</span>
          <span>${imessage?.running ? "是" : "否"}</span>
        </div>
        <div>
          <span class="label">最后启动</span>
          <span>${imessage?.lastStartAt ? formatAgo(imessage.lastStartAt) : "无"}</span>
        </div>
        <div>
          <span class="label">最后探测</span>
          <span>${imessage?.lastProbeAt ? formatAgo(imessage.lastProbeAt) : "无"}</span>
        </div>
      </div>

      ${
        imessage?.lastError
          ? html`<div class="callout danger" style="margin-top: 12px;">
            ${imessage.lastError}
          </div>`
          : nothing
      }

      ${
        imessage?.probe
          ? html`<div class="callout" style="margin-top: 12px;">
            探测${imessage.probe.ok ? "成功" : "失败"} ·
            ${imessage.probe.error ?? ""}
          </div>`
          : nothing
      }

      ${renderChannelConfigSection({ channelId: "imessage", props })}

      <div class="row" style="margin-top: 12px;">
        <button class="btn" @click=${() => props.onRefresh(true)}>
          探测
        </button>
      </div>
    </div>
  `;
}
