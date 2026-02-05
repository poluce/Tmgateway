import type { OpenClawConfig } from "../config/config.js";
import type { RuntimeEnv } from "../runtime.js";
import { getChannelPlugin, listChannelPlugins } from "../channels/plugins/index.js";
import { formatCliCommand } from "../cli/command-format.js";
import { CONFIG_PATH } from "../config/config.js";
import { note } from "../terminal/note.js";
import { shortenHomePath } from "../utils.js";
import { confirm, select } from "./configure.shared.js";
import { guardCancel } from "./onboard-helpers.js";

export async function removeChannelConfigWizard(
  cfg: OpenClawConfig,
  runtime: RuntimeEnv,
): Promise<OpenClawConfig> {
  let next = { ...cfg };

  const listConfiguredChannels = () =>
    listChannelPlugins()
      .map((plugin) => plugin.meta)
      .filter((meta) => next.channels?.[meta.id] !== undefined);

  while (true) {
    const configured = listConfiguredChannels();
    if (configured.length === 0) {
      note(
        [
          "在 openclaw.json 中未找到频道配置。",
          `提示：\`${formatCliCommand("openclaw channels status")}\` 可查看已配置和启用的内容。`,
        ].join("\n"),
        "移除频道",
      );
      return next;
    }

    const channel = guardCancel(
      await select({
        message: "移除哪个频道配置？",
        options: [
          ...configured.map((meta) => ({
            value: meta.id,
            label: meta.label,
            hint: "从配置中删除令牌和设置（磁盘上的凭证保持不变）",
          })),
          { value: "done", label: "完成" },
        ],
      }),
      runtime,
    );

    if (channel === "done") {
      return next;
    }

    const label = getChannelPlugin(channel)?.meta.label ?? channel;
    const confirmed = guardCancel(
      await confirm({
        message: `从 ${shortenHomePath(CONFIG_PATH)} 删除 ${label} 配置？`,
        initialValue: false,
      }),
      runtime,
    );
    if (!confirmed) {
      continue;
    }

    const nextChannels: Record<string, unknown> = { ...next.channels };
    delete nextChannels[channel];
    next = {
      ...next,
      channels: Object.keys(nextChannels).length
        ? (nextChannels as OpenClawConfig["channels"])
        : undefined,
    };

    note(
      [`${label} 已从配置中移除。`, "注意：磁盘上的凭证/会话保持不变。"].join("\n"),
      "频道已移除",
    );
  }
}
