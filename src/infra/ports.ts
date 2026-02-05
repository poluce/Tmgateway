import net from "node:net";
import type { RuntimeEnv } from "../runtime.js";
import type { PortListener, PortListenerKind, PortUsage, PortUsageStatus } from "./ports-types.js";
import { danger, info, shouldLogVerbose, warn } from "../globals.js";
import { logDebug } from "../logger.js";
import { defaultRuntime } from "../runtime.js";
import { formatPortDiagnostics } from "./ports-format.js";
import { inspectPortUsage } from "./ports-inspect.js";

class PortInUseError extends Error {
  port: number;
  details?: string;

  constructor(port: number, details?: string) {
    super(`端口 ${port} 已被占用。`);
    this.name = "PortInUseError";
    this.port = port;
    this.details = details;
  }
}

function isErrno(err: unknown): err is NodeJS.ErrnoException {
  return Boolean(err && typeof err === "object" && "code" in err);
}

export async function describePortOwner(port: number): Promise<string | undefined> {
  const diagnostics = await inspectPortUsage(port);
  if (diagnostics.listeners.length === 0) {
    return undefined;
  }
  return formatPortDiagnostics(diagnostics).join("\n");
}

export async function ensurePortAvailable(port: number): Promise<void> {
  // Detect EADDRINUSE early with a friendly message.
  try {
    await new Promise<void>((resolve, reject) => {
      const tester = net
        .createServer()
        .once("error", (err) => reject(err))
        .once("listening", () => {
          tester.close(() => resolve());
        })
        .listen(port);
    });
  } catch (err) {
    if (isErrno(err) && err.code === "EADDRINUSE") {
      const details = await describePortOwner(port);
      throw new PortInUseError(port, details);
    }
    throw err;
  }
}

export async function handlePortError(
  err: unknown,
  port: number,
  context: string,
  runtime: RuntimeEnv = defaultRuntime,
): Promise<never> {
  // Uniform messaging for EADDRINUSE with optional owner details.
  if (err instanceof PortInUseError || (isErrno(err) && err.code === "EADDRINUSE")) {
    const details = err instanceof PortInUseError ? err.details : await describePortOwner(port);
    runtime.error(danger(`${context} 失败：端口 ${port} 已被占用。`));
    if (details) {
      runtime.error(info("端口监听详情："));
      runtime.error(details);
      if (/openclaw|src\/index\.ts|dist\/index\.js/.test(details)) {
        runtime.error(warn("看起来另一个 OpenClaw 实例已在运行。请停止它或选择其他端口。"));
      }
    }
    runtime.error(info("解决方法：停止占用端口的进程或使用 --port <空闲端口>。"));
    runtime.exit(1);
  }
  runtime.error(danger(`${context} 失败：${String(err)}`));
  if (shouldLogVerbose()) {
    const stdout = (err as { stdout?: string })?.stdout;
    const stderr = (err as { stderr?: string })?.stderr;
    if (stdout?.trim()) {
      logDebug(`stdout: ${stdout.trim()}`);
    }
    if (stderr?.trim()) {
      logDebug(`stderr: ${stderr.trim()}`);
    }
  }
  return runtime.exit(1);
}

export { PortInUseError };
export type { PortListener, PortListenerKind, PortUsage, PortUsageStatus };
export { buildPortHints, classifyPortListener, formatPortDiagnostics } from "./ports-format.js";
export { inspectPortUsage } from "./ports-inspect.js";
