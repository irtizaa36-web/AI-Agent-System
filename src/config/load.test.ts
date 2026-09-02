import { test } from "node:test";
import assert from "node:assert/strict";
import { loadDefaultConfig, dispatchableAgents } from "./load";

test("loadDefaultConfig wires up engine providers/tools plus the enabled packs' agents", () => {
  const registry = loadDefaultConfig();

  assert.equal(registry.getProvider("claude").name, "claude");
  assert.equal(registry.getProvider("fake").name, "fake");
  assert.equal(registry.getTool("read-file").name, "read-file");
  assert.equal(registry.getTool("inkbox-search-mail").name, "inkbox-search-mail");
  assert.equal(registry.getTool("inkbox-read-thread").name, "inkbox-read-thread");
  assert.equal(registry.getTool("inkbox-save-draft").name, "inkbox-save-draft");
  assert.equal(registry.getTool("send-email").requiresApproval, true);
  assert.equal(registry.getTool("read-web-page").name, "read-web-page");
  assert.equal(registry.getTool("browser-list-form-fields").name, "browser-list-form-fields");
  assert.equal(registry.getTool("browser-fill-form-preview").requiresApproval, false);
  assert.equal(registry.getTool("browser-submit-form").requiresApproval, true);
  assert.equal(registry.getTool("read-job-board-page").name, "read-job-board-page");

  const names = registry
    .listAgents()
    .map((agent) => agent.name)
    .sort();
  assert.deepEqual(names, ["career-advisor", "case-report-writer", "default", "demo", "dispatcher", "inkbox-send", "job-search-agent", "personal-admin"]);
  assert.deepEqual(registry.listPacks(), ["core-demo", "personal-assistant", "dispatcher", "career-advisor", "ai-research", "job-search"]);
});

test("dispatchableAgents excludes the dispatcher itself and utility/demo agents, keeping only agents with a description", () => {
  const registry = loadDefaultConfig();
  const names = dispatchableAgents(registry)
    .map((a) => a.name)
    .sort();
  assert.deepEqual(names, ["career-advisor", "case-report-writer", "default", "job-search-agent", "personal-admin"]);
});
