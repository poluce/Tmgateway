import type { RuntimeEnv } from "../../runtime.js";
import { buildModelAliasIndex, resolveModelRefFromString } from "../../agents/model-selection.js";
import { loadConfig } from "../../config/config.js";
import { logConfigUpdated } from "../../config/logging.js";
import {
  DEFAULT_PROVIDER,
  ensureFlagCompatibility,
  modelKey,
  resolveModelTarget,
  updateConfig,
} from "./shared.js";

export async function modelsFallbacksListCommand(
  opts: { json?: boolean; plain?: boolean },
  runtime: RuntimeEnv,
) {
  ensureFlagCompatibility(opts);
  const cfg = loadConfig();
  const fallbacks = cfg.agents?.defaults?.model?.fallbacks ?? [];

  if (opts.json) {
    runtime.log(JSON.stringify({ fallbacks }, null, 2));
    return;
  }
  if (opts.plain) {
    for (const entry of fallbacks) {
      runtime.log(entry);
    }
    return;
  }

  runtime.log(`备选模型（${fallbacks.length}）：`);
  if (fallbacks.length === 0) {
    runtime.log("- 无");
    return;
  }
  for (const entry of fallbacks) {
    runtime.log(`- ${entry}`);
  }
}

export async function modelsFallbacksAddCommand(modelRaw: string, runtime: RuntimeEnv) {
  const updated = await updateConfig((cfg) => {
    const resolved = resolveModelTarget({ raw: modelRaw, cfg });
    const targetKey = modelKey(resolved.provider, resolved.model);
    const nextModels = { ...cfg.agents?.defaults?.models };
    if (!nextModels[targetKey]) {
      nextModels[targetKey] = {};
    }
    const aliasIndex = buildModelAliasIndex({
      cfg,
      defaultProvider: DEFAULT_PROVIDER,
    });
    const existing = cfg.agents?.defaults?.model?.fallbacks ?? [];
    const existingKeys = existing
      .map((entry) =>
        resolveModelRefFromString({
          raw: String(entry ?? ""),
          defaultProvider: DEFAULT_PROVIDER,
          aliasIndex,
        }),
      )
      .filter((entry): entry is NonNullable<typeof entry> => Boolean(entry))
      .map((entry) => modelKey(entry.ref.provider, entry.ref.model));

    if (existingKeys.includes(targetKey)) {
      return cfg;
    }

    const existingModel = cfg.agents?.defaults?.model as
      | { primary?: string; fallbacks?: string[] }
      | undefined;

    return {
      ...cfg,
      agents: {
        ...cfg.agents,
        defaults: {
          ...cfg.agents?.defaults,
          model: {
            ...(existingModel?.primary ? { primary: existingModel.primary } : undefined),
            fallbacks: [...existing, targetKey],
          },
          models: nextModels,
        },
      },
    };
  });

  logConfigUpdated(runtime);
  runtime.log(`备选模型：${(updated.agents?.defaults?.model?.fallbacks ?? []).join(", ")}`);
}

export async function modelsFallbacksRemoveCommand(modelRaw: string, runtime: RuntimeEnv) {
  const updated = await updateConfig((cfg) => {
    const resolved = resolveModelTarget({ raw: modelRaw, cfg });
    const targetKey = modelKey(resolved.provider, resolved.model);
    const aliasIndex = buildModelAliasIndex({
      cfg,
      defaultProvider: DEFAULT_PROVIDER,
    });
    const existing = cfg.agents?.defaults?.model?.fallbacks ?? [];
    const filtered = existing.filter((entry) => {
      const resolvedEntry = resolveModelRefFromString({
        raw: String(entry ?? ""),
        defaultProvider: DEFAULT_PROVIDER,
        aliasIndex,
      });
      if (!resolvedEntry) {
        return true;
      }
      return modelKey(resolvedEntry.ref.provider, resolvedEntry.ref.model) !== targetKey;
    });

    if (filtered.length === existing.length) {
      throw new Error(`未找到备选模型：${targetKey}`);
    }

    const existingModel = cfg.agents?.defaults?.model as
      | { primary?: string; fallbacks?: string[] }
      | undefined;

    return {
      ...cfg,
      agents: {
        ...cfg.agents,
        defaults: {
          ...cfg.agents?.defaults,
          model: {
            ...(existingModel?.primary ? { primary: existingModel.primary } : undefined),
            fallbacks: filtered,
          },
        },
      },
    };
  });

  logConfigUpdated(runtime);
  runtime.log(`备选模型：${(updated.agents?.defaults?.model?.fallbacks ?? []).join(", ")}`);
}

export async function modelsFallbacksClearCommand(runtime: RuntimeEnv) {
  await updateConfig((cfg) => {
    const existingModel = cfg.agents?.defaults?.model as
      | { primary?: string; fallbacks?: string[] }
      | undefined;
    return {
      ...cfg,
      agents: {
        ...cfg.agents,
        defaults: {
          ...cfg.agents?.defaults,
          model: {
            ...(existingModel?.primary ? { primary: existingModel.primary } : undefined),
            fallbacks: [],
          },
        },
      },
    };
  });

  logConfigUpdated(runtime);
  runtime.log("备选模型列表已清空。");
}
