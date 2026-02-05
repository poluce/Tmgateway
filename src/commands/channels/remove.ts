import { resolveChannelDefaultAccountId } from "../../channels/plugins/helpers.js";
import {
  getChannelPlugin,
  listChannelPlugins,
  normalizeChannelId,
} from "../../channels/plugins/index.js";
import { type OpenClawConfig, writeConfigFile } from "../../config/config.js";
import { DEFAULT_ACCOUNT_ID, normalizeAccountId } from "../../routing/session-key.js";
import { defaultRuntime, type RuntimeEnv } from "../../runtime.js";
import { createClackPrompter } from "../../wizard/clack-prompter.js";
import { type ChatChannel, channelLabel, requireValidConfig, shouldUseWizard } from "./shared.js";

export type ChannelsRemoveOptions = {
  channel?: string;
  account?: string;
  delete?: boolean;
};

function listAccountIds(cfg: OpenClawConfig, channel: ChatChannel): string[] {
  const plugin = getChannelPlugin(channel);
  if (!plugin) {
    return [];
  }
  return plugin.config.listAccountIds(cfg);
}

export async function channelsRemoveCommand(
  opts: ChannelsRemoveOptions,
  runtime: RuntimeEnv = defaultRuntime,
  params?: { hasFlags?: boolean },
) {
  const cfg = await requireValidConfig(runtime);
  if (!cfg) {
    return;
  }

  const useWizard = shouldUseWizard(params);
  const prompter = useWizard ? createClackPrompter() : null;
  let channel: ChatChannel | null = normalizeChannelId(opts.channel);
  let accountId = normalizeAccountId(opts.account);
  const deleteConfig = Boolean(opts.delete);

  if (useWizard && prompter) {
    await prompter.intro("移除频道账户");
    const selectedChannel = await prompter.select({
      message: "频道",
      options: listChannelPlugins().map((plugin) => ({
        value: plugin.id,
        label: plugin.meta.label,
      })),
    });
    channel = selectedChannel;

    accountId = await (async () => {
      const ids = listAccountIds(cfg, selectedChannel);
      const choice = await prompter.select({
        message: "账户",
        options: ids.map((id) => ({
          value: id,
          label: id === DEFAULT_ACCOUNT_ID ? "默认（主要）" : id,
        })),
        initialValue: ids[0] ?? DEFAULT_ACCOUNT_ID,
      });
      return normalizeAccountId(choice);
    })();

    const wantsDisable = await prompter.confirm({
      message: `禁用 ${channelLabel(selectedChannel)} 账户 "${accountId}"？（保留配置）`,
      initialValue: true,
    });
    if (!wantsDisable) {
      await prompter.outro("已取消。");
      return;
    }
  } else {
    if (!channel) {
      runtime.error("需要频道。使用 --channel <名称>。");
      runtime.exit(1);
      return;
    }
    if (!deleteConfig) {
      const confirm = createClackPrompter();
      const ok = await confirm.confirm({
        message: `禁用 ${channelLabel(channel)} 账户 "${accountId}"？（保留配置）`,
        initialValue: true,
      });
      if (!ok) {
        return;
      }
    }
  }

  const plugin = getChannelPlugin(channel);
  if (!plugin) {
    runtime.error(`未知频道：${channel}`);
    runtime.exit(1);
    return;
  }

  const resolvedAccountId =
    normalizeAccountId(accountId) ?? resolveChannelDefaultAccountId({ plugin, cfg });
  const accountKey = resolvedAccountId || DEFAULT_ACCOUNT_ID;

  let next = { ...cfg };
  if (deleteConfig) {
    if (!plugin.config.deleteAccount) {
      runtime.error(`频道 ${channel} 不支持删除。`);
      runtime.exit(1);
      return;
    }
    next = plugin.config.deleteAccount({
      cfg: next,
      accountId: resolvedAccountId,
    });
  } else {
    if (!plugin.config.setAccountEnabled) {
      runtime.error(`频道 ${channel} 不支持禁用。`);
      runtime.exit(1);
      return;
    }
    next = plugin.config.setAccountEnabled({
      cfg: next,
      accountId: resolvedAccountId,
      enabled: false,
    });
  }

  await writeConfigFile(next);
  if (useWizard && prompter) {
    await prompter.outro(
      deleteConfig
        ? `已删除 ${channelLabel(channel)} 账户 "${accountKey}"。`
        : `已禁用 ${channelLabel(channel)} 账户 "${accountKey}"。`,
    );
  } else {
    runtime.log(
      deleteConfig
        ? `已删除 ${channelLabel(channel)} 账户 "${accountKey}"。`
        : `已禁用 ${channelLabel(channel)} 账户 "${accountKey}"。`,
    );
  }
}
