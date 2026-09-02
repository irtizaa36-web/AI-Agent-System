import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readFileTool } from "./read-file";

test("readFileTool reads back the contents of a real file", async () => {
  const dir = await mkdtemp(join(tmpdir(), "orchestrator-test-"));
  const filePath = join(dir, "greeting.txt");
  await writeFile(filePath, "hello from disk", "utf-8");

  try {
    const content = await readFileTool.execute({ path: filePath });
    assert.equal(content, "hello from disk");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("readFileTool rejects malformed input", async () => {
  await assert.rejects(() => Promise.resolve(readFileTool.execute({})), /requires an input/);
});
