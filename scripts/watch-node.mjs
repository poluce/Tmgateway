#!/usr/bin/env node
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";

const args = process.argv.slice(2);
const env = { ...process.env, OPENCLAW_WAIT_DIST: "1" };
const cwd = process.cwd();
const compiler = "tsdown";
const distEntry = path.join(cwd, "dist", "entry.js");

const initialBuild = spawnSync("pnpm", ["exec", compiler], {
  cwd,
  env,
  stdio: "inherit",
});

if (initialBuild.status !== 0) {
  process.exit(initialBuild.status ?? 1);
}

const compilerProcess = spawn("pnpm", ["exec", compiler, "--watch"], {
  cwd,
  env,
  stdio: "inherit",
});

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const waitForEntry = async (timeoutMs = 30000) => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      fs.accessSync(distEntry, fs.constants.R_OK);
      return true;
    } catch {
      await sleep(200);
    }
  }
  return false;
};

let nodeProcess;
const startNodeProcess = async () => {
  const ready = await waitForEntry();
  if (!ready) {
    process.stderr.write(
      `[openclaw] dist/entry.js not found after build. Run "pnpm exec tsdown" once.\n`,
    );
    cleanup(1);
    return;
  }
  nodeProcess = spawn(process.execPath, ["--watch", "openclaw.mjs", ...args], {
    cwd,
    env,
    stdio: "inherit",
  });

  nodeProcess.on("exit", (code, signal) => {
    if (signal || exiting) {
      return;
    }
    cleanup(code ?? 1);
  });
};

let exiting = false;

function cleanup(code = 0) {
  if (exiting) {
    return;
  }
  exiting = true;
  nodeProcess?.kill("SIGTERM");
  compilerProcess.kill("SIGTERM");
  process.exit(code);
}

process.on("SIGINT", () => cleanup(130));
process.on("SIGTERM", () => cleanup(143));

compilerProcess.on("exit", (code) => {
  if (exiting) {
    return;
  }
  cleanup(code ?? 1);
});
startNodeProcess();
