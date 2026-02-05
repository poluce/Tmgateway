import type { OpenClawConfig } from "../config/config.js";
import type { DoctorPrompter } from "./doctor-prompter.js";
import {
  buildAuthHealthSummary,
  DEFAULT_OAUTH_WARN_MS,
  formatRemainingShort,
} from "../agents/auth-health.js";
import {
  CLAUDE_CLI_PROFILE_ID,
  CODEX_CLI_PROFILE_ID,
  ensureAuthProfileStore,
  repairOAuthProfileIdMismatch,
  resolveApiKeyForProfile,
  resolveProfileUnusableUntilForDisplay,
} from "../agents/auth-profiles.js";
import { updateAuthProfileStoreWithLock } from "../agents/auth-profiles/store.js";
import { formatCliCommand } from "../cli/command-format.js";
import { note } from "../terminal/note.js";

export async function maybeRepairAnthropicOAuthProfileId(
  cfg: OpenClawConfig,
  prompter: DoctorPrompter,
): Promise<OpenClawConfig> {
  const store = ensureAuthProfileStore();
  const repair = repairOAuthProfileIdMismatch({
    cfg,
    store,
    provider: "anthropic",
    legacyProfileId: "anthropic:default",
  });
  if (!repair.migrated || repair.changes.length === 0) {
    return cfg;
  }

  note(repair.changes.map((c) => `- ${c}`).join("\n"), "认证配置");
  const apply = await prompter.confirm({
    message: "现在更新配置中的 Anthropic OAuth 配置 ID？",
    initialValue: true,
  });
  if (!apply) {
    return cfg;
  }
  return repair.config;
}

function pruneAuthOrder(
  order: Record<string, string[]> | undefined,
  profileIds: Set<string>,
): { next: Record<string, string[]> | undefined; changed: boolean } {
  if (!order) {
    return { next: order, changed: false };
  }
  let changed = false;
  const next: Record<string, string[]> = {};
  for (const [provider, list] of Object.entries(order)) {
    const filtered = list.filter((id) => !profileIds.has(id));
    if (filtered.length !== list.length) {
      changed = true;
    }
    if (filtered.length > 0) {
      next[provider] = filtered;
    }
  }
  return { next: Object.keys(next).length > 0 ? next : undefined, changed };
}

function pruneAuthProfiles(
  cfg: OpenClawConfig,
  profileIds: Set<string>,
): { next: OpenClawConfig; changed: boolean } {
  const profiles = cfg.auth?.profiles;
  const order = cfg.auth?.order;
  const nextProfiles = profiles ? { ...profiles } : undefined;
  let changed = false;

  if (nextProfiles) {
    for (const id of profileIds) {
      if (id in nextProfiles) {
        delete nextProfiles[id];
        changed = true;
      }
    }
  }

  const prunedOrder = pruneAuthOrder(order, profileIds);
  if (prunedOrder.changed) {
    changed = true;
  }

  if (!changed) {
    return { next: cfg, changed: false };
  }

  const nextAuth =
    nextProfiles || prunedOrder.next
      ? {
          ...cfg.auth,
          profiles: nextProfiles && Object.keys(nextProfiles).length > 0 ? nextProfiles : undefined,
          order: prunedOrder.next,
        }
      : undefined;

  return {
    next: {
      ...cfg,
      auth: nextAuth,
    },
    changed: true,
  };
}

export async function maybeRemoveDeprecatedCliAuthProfiles(
  cfg: OpenClawConfig,
  prompter: DoctorPrompter,
): Promise<OpenClawConfig> {
  const store = ensureAuthProfileStore(undefined, { allowKeychainPrompt: false });
  const deprecated = new Set<string>();
  if (store.profiles[CLAUDE_CLI_PROFILE_ID] || cfg.auth?.profiles?.[CLAUDE_CLI_PROFILE_ID]) {
    deprecated.add(CLAUDE_CLI_PROFILE_ID);
  }
  if (store.profiles[CODEX_CLI_PROFILE_ID] || cfg.auth?.profiles?.[CODEX_CLI_PROFILE_ID]) {
    deprecated.add(CODEX_CLI_PROFILE_ID);
  }

  if (deprecated.size === 0) {
    return cfg;
  }

  const lines = ["检测到已弃用的外部 CLI 认证配置（不再支持）："];
  if (deprecated.has(CLAUDE_CLI_PROFILE_ID)) {
    lines.push(
      `- ${CLAUDE_CLI_PROFILE_ID} (Anthropic)：使用 setup-token → ${formatCliCommand("openclaw models auth setup-token")}`,
    );
  }
  if (deprecated.has(CODEX_CLI_PROFILE_ID)) {
    lines.push(
      `- ${CODEX_CLI_PROFILE_ID} (OpenAI Codex)：使用 OAuth → ${formatCliCommand(
        "openclaw models auth login --provider openai-codex",
      )}`,
    );
  }
  note(lines.join("\n"), "认证配置");

  const shouldRemove = await prompter.confirmRepair({
    message: "现在移除已弃用的 CLI 认证配置？",
    initialValue: true,
  });
  if (!shouldRemove) {
    return cfg;
  }

  await updateAuthProfileStoreWithLock({
    updater: (nextStore) => {
      let mutated = false;
      for (const id of deprecated) {
        if (nextStore.profiles[id]) {
          delete nextStore.profiles[id];
          mutated = true;
        }
        if (nextStore.usageStats?.[id]) {
          delete nextStore.usageStats[id];
          mutated = true;
        }
      }
      if (nextStore.order) {
        for (const [provider, list] of Object.entries(nextStore.order)) {
          const filtered = list.filter((id) => !deprecated.has(id));
          if (filtered.length !== list.length) {
            mutated = true;
            if (filtered.length > 0) {
              nextStore.order[provider] = filtered;
            } else {
              delete nextStore.order[provider];
            }
          }
        }
      }
      if (nextStore.lastGood) {
        for (const [provider, profileId] of Object.entries(nextStore.lastGood)) {
          if (deprecated.has(profileId)) {
            delete nextStore.lastGood[provider];
            mutated = true;
          }
        }
      }
      return mutated;
    },
  });

  const pruned = pruneAuthProfiles(cfg, deprecated);
  if (pruned.changed) {
    note(
      Array.from(deprecated.values())
        .map((id) => `- 已从配置中移除 ${id}`)
        .join("\n"),
      "Doctor 更改",
    );
  }
  return pruned.next;
}

type AuthIssue = {
  profileId: string;
  provider: string;
  status: string;
  remainingMs?: number;
};

function formatAuthIssueHint(issue: AuthIssue): string | null {
  if (issue.provider === "anthropic" && issue.profileId === CLAUDE_CLI_PROFILE_ID) {
    return `已弃用的配置。使用 ${formatCliCommand("openclaw models auth setup-token")} 或 ${formatCliCommand(
      "openclaw configure",
    )}。`;
  }
  if (issue.provider === "openai-codex" && issue.profileId === CODEX_CLI_PROFILE_ID) {
    return `已弃用的配置。使用 ${formatCliCommand(
      "openclaw models auth login --provider openai-codex",
    )} 或 ${formatCliCommand("openclaw configure")}。`;
  }
  return `通过 \`${formatCliCommand("openclaw configure")}\` 或 \`${formatCliCommand("openclaw onboard")}\` 重新认证。`;
}

function formatAuthIssueLine(issue: AuthIssue): string {
  const remaining =
    issue.remainingMs !== undefined ? ` (${formatRemainingShort(issue.remainingMs)})` : "";
  const hint = formatAuthIssueHint(issue);
  return `- ${issue.profileId}: ${issue.status}${remaining}${hint ? ` — ${hint}` : ""}`;
}

export async function noteAuthProfileHealth(params: {
  cfg: OpenClawConfig;
  prompter: DoctorPrompter;
  allowKeychainPrompt: boolean;
}): Promise<void> {
  const store = ensureAuthProfileStore(undefined, {
    allowKeychainPrompt: params.allowKeychainPrompt,
  });
  const unusable = (() => {
    const now = Date.now();
    const out: string[] = [];
    for (const profileId of Object.keys(store.usageStats ?? {})) {
      const until = resolveProfileUnusableUntilForDisplay(store, profileId);
      if (!until || now >= until) {
        continue;
      }
      const stats = store.usageStats?.[profileId];
      const remaining = formatRemainingShort(until - now);
      const kind =
        typeof stats?.disabledUntil === "number" && now < stats.disabledUntil
          ? `已禁用${stats.disabledReason ? `:${stats.disabledReason}` : ""}`
          : "冷却中";
      const hint = kind.startsWith("已禁用:billing")
        ? "充值额度（提供商计费）或切换提供商。"
        : "等待冷却结束或切换提供商。";
      out.push(`- ${profileId}: ${kind} (${remaining})${hint ? ` — ${hint}` : ""}`);
    }
    return out;
  })();

  if (unusable.length > 0) {
    note(unusable.join("\n"), "认证配置冷却");
  }

  let summary = buildAuthHealthSummary({
    store,
    cfg: params.cfg,
    warnAfterMs: DEFAULT_OAUTH_WARN_MS,
  });

  const findIssues = () =>
    summary.profiles.filter(
      (profile) =>
        (profile.type === "oauth" || profile.type === "token") &&
        (profile.status === "expired" ||
          profile.status === "expiring" ||
          profile.status === "missing"),
    );

  let issues = findIssues();
  if (issues.length === 0) {
    return;
  }

  const shouldRefresh = await params.prompter.confirmRepair({
    message: "现在刷新即将过期的 OAuth 令牌？（静态令牌需要重新认证）",
    initialValue: true,
  });

  if (shouldRefresh) {
    const refreshTargets = issues.filter(
      (issue) =>
        issue.type === "oauth" && ["expired", "expiring", "missing"].includes(issue.status),
    );
    const errors: string[] = [];
    for (const profile of refreshTargets) {
      try {
        await resolveApiKeyForProfile({
          cfg: params.cfg,
          store,
          profileId: profile.profileId,
        });
      } catch (err) {
        errors.push(`- ${profile.profileId}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    if (errors.length > 0) {
      note(errors.join("\n"), "OAuth 刷新错误");
    }
    summary = buildAuthHealthSummary({
      store: ensureAuthProfileStore(undefined, {
        allowKeychainPrompt: false,
      }),
      cfg: params.cfg,
      warnAfterMs: DEFAULT_OAUTH_WARN_MS,
    });
    issues = findIssues();
  }

  if (issues.length > 0) {
    note(
      issues
        .map((issue) =>
          formatAuthIssueLine({
            profileId: issue.profileId,
            provider: issue.provider,
            status: issue.status,
            remainingMs: issue.remainingMs,
          }),
        )
        .join("\n"),
      "模型认证",
    );
  }
}
