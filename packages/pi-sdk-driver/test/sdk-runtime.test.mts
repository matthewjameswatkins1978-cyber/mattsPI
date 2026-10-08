import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { configurePiSdkRuntime, loadPiSdkRuntime } from "../dist/sdk-runtime.js";

await test("a managed runtime pointer escape is rejected without using the workspace SDK", async () => {
  const root = await mkdtemp(join(tmpdir(), "gary-pi-sdk-runtime-"));
  try {
    await writeFile(join(root, "current.json"), JSON.stringify({ directory: "../fallback" }));
    configurePiSdkRuntime({ directory: root, required: false });
    await assert.rejects(loadPiSdkRuntime(), /must name a version directory/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
