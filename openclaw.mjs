#!/usr/bin/env node

import { access } from "node:fs/promises";
import module from "node:module";
import process from "node:process";

// https://nodejs.org/api/module.html#module-compile-cache
if (module.enableCompileCache && !process.env.NODE_DISABLE_COMPILE_CACHE) {
  try {
    module.enableCompileCache();
  } catch {
    // Ignore errors
  }
}

const waitForEntryIfNeeded = async () => {
  if (process.env.OPENCLAW_WAIT_DIST !== "1") {
    return;
  }
  const entryUrl = new URL("./dist/entry.js", import.meta.url);
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    try {
      await access(entryUrl);
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
  }
  throw new Error("Timed out waiting for dist/entry.js to appear.");
};

await waitForEntryIfNeeded();
await import("./dist/entry.js");
