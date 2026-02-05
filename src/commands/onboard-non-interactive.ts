import type { OpenClawConfig } from "../config/config.js";
import type { RuntimeEnv } from "../runtime.js";
import type { OnboardOptions } from "./onboard-types.js";
import { formatCliCommand } from "../cli/command-format.js";
import { readConfigFileSnapshot } from "../config/config.js";
import { defaultRuntime } from "../runtime.js";
import { runNonInteractiveOnboardingLocal } from "./onboard-non-interactive/local.js";
import { runNonInteractiveOnboardingRemote } from "./onboard-non-interactive/remote.js";

export async function runNonInteractiveOnboarding(
  opts: OnboardOptions,
  runtime: RuntimeEnv = defaultRuntime,
) {
  const snapshot = await readConfigFileSnapshot();
  if (snapshot.exists && !snapshot.valid) {
    runtime.error(
      `配置无效。运行 \`${formatCliCommand("openclaw doctor")}\` 修复它，然后重新运行引导。`,
    );
    runtime.exit(1);
    return;
  }

  const baseConfig: OpenClawConfig = snapshot.valid ? snapshot.config : {};
  const mode = opts.mode ?? "local";
  if (mode !== "local" && mode !== "remote") {
    runtime.error(`无效的 --mode "${String(mode)}"（使用 local|remote）。`);
    runtime.exit(1);
    return;
  }

  if (mode === "remote") {
    await runNonInteractiveOnboardingRemote({ opts, runtime, baseConfig });
    return;
  }

  await runNonInteractiveOnboardingLocal({ opts, runtime, baseConfig });
}
