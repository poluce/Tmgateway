import type { OpenClawConfig } from "../../../config/config.js";
import type { RuntimeEnv } from "../../../runtime.js";
import type { OnboardOptions } from "../../onboard-types.js";

export function applyNonInteractiveSkillsConfig(params: {
  nextConfig: OpenClawConfig;
  opts: OnboardOptions;
  runtime: RuntimeEnv;
}) {
  const { nextConfig, opts, runtime } = params;
  if (opts.skipSkills) {
    return nextConfig;
  }

  const nodeManager = opts.nodeManager ?? "npm";
  if (!["npm", "pnpm", "bun"].includes(nodeManager)) {
    runtime.error("无效的 --node-manager（使用 npm、pnpm 或 bun）");
    runtime.exit(1);
    return nextConfig;
  }
  return {
    ...nextConfig,
    skills: {
      ...nextConfig.skills,
      install: {
        ...nextConfig.skills?.install,
        nodeManager,
      },
    },
  };
}
