import { test } from "node:test";
import assert from "node:assert/strict";
import { parseBrief } from "./brief";

test("parses a well-formed brief: title, target branch, body", () => {
  const result = parseBrief([
    "# Fix the flaky X sweep test",
    "",
    "Target branch: `claude/x-sweep-flake-fix`",
    "",
    "The sweep's third test intermittently times out. Diagnose and fix.",
    "",
  ].join("\n"));

  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.brief.title, "Fix the flaky X sweep test");
  assert.equal(result.brief.targetBranch, "claude/x-sweep-flake-fix");
  assert.equal(result.brief.body, "The sweep's third test intermittently times out. Diagnose and fix.");
});

test("target branch line without backticks is accepted", () => {
  const result = parseBrief("# Title\n\nTarget branch: claude/no-backticks\n\nBody text.\n");
  assert.equal(result.ok, true);
  if (result.ok) assert.equal(result.brief.targetBranch, "claude/no-backticks");
});

test("leading blank lines before the title are tolerated", () => {
  const result = parseBrief("\n\n  \n# Title\n\nTarget branch: `claude/foo`\n\nBody\n");
  assert.equal(result.ok, true);
  if (result.ok) assert.equal(result.brief.title, "Title");
});

test("an empty body is allowed", () => {
  const result = parseBrief("# Title\n\nTarget branch: `claude/foo`\n");
  assert.equal(result.ok, true);
  if (result.ok) assert.equal(result.brief.body, "");
});

test("rejects an empty file", () => {
  const result = parseBrief("   \n\n  ");
  assert.equal(result.ok, false);
  if (!result.ok) assert.match(result.error, /empty brief file/);
});

test("rejects a file with no leading '# Title' line", () => {
  const result = parseBrief("Target branch: `claude/foo`\n\nBody\n");
  assert.equal(result.ok, false);
  if (!result.ok) assert.match(result.error, /missing title/);
});

test("rejects a brief with content between the title and the target-branch line", () => {
  const result = parseBrief("# Title\n\nSome unexpected line\n\nTarget branch: `claude/foo`\n");
  assert.equal(result.ok, false);
  if (!result.ok) assert.match(result.error, /expected a 'Target branch:' line/);
});

test("rejects a brief with nothing at all after the title", () => {
  const result = parseBrief("# Title\n\n\n");
  assert.equal(result.ok, false);
  if (!result.ok) assert.match(result.error, /missing 'Target branch:' line/);
});

test("rejects a brief with a body but no target-branch line, rather than misreading the body as the branch", () => {
  const result = parseBrief("# Title\n\nJust a body, no target branch.\n");
  assert.equal(result.ok, false);
  if (!result.ok) assert.match(result.error, /expected a 'Target branch:' line/);
});

test("rejects a target branch that doesn't start with claude/", () => {
  const result = parseBrief("# Title\n\nTarget branch: `main`\n\nBody\n");
  assert.equal(result.ok, false);
  if (!result.ok) assert.match(result.error, /invalid target branch/);
});

test("rejects a target branch with characters outside the allowed set", () => {
  const result = parseBrief("# Title\n\nTarget branch: `claude/has spaces`\n\nBody\n");
  assert.equal(result.ok, false);
  if (!result.ok) assert.match(result.error, /invalid target branch/);
});
