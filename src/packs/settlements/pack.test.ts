import { test } from "node:test";
import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { Registry } from "../../registry/registry";
import { settlementsPack } from "./pack";
import { loadDefaultConfig } from "../../config/load";
import { createTask } from "../../core/task";
import { runToCompletion } from "../../core/orchestrator";
import { FakeProvider } from "../../providers/fake";
import { createSettlementsDeps } from "../../settlements/deps";
import { InMemoryTrackerStorage } from "../../settlements/storage";
import { CLASSACTION_ORG_PAGE, TOP_CLASS_ACTIONS_FEED } from "../../settlements/research/fixtures";
import { classActionOrgSource, topClassActionsSource } from "../../settlements/research/sources";

function deps() {
  const pages: Record<string, string> = { [topClassActionsSource.url]: TOP_CLASS_ACTIONS_FEED, [classActionOrgSource.url]: CLASSACTION_ORG_PAGE };
  return createSettlementsDeps({
    storage: new InMemoryTrackerStorage(),
    today: () => "2026-09-25",
    fetch: async (url) => ({ ok: true, status: 200, text: async () => pages[url] ?? "" }),
  });
}

test("settlementsPack registers one agent whose prompt carries the hard rules", () => {
  const registry = new Registry();
  settlementsPack.register(registry);
  const agent = registry.getAgent("settlements-agent");
  assert.deepEqual(agent.toolNames, ["settlements-deadlines", "settlements-review", "settlements-evaluate", "settlements-research-sweep"]);
  assert.match(agent.systemPrompt, /You never file, attest to, or submit any claim/);
  assert.match(agent.systemPrompt, /Never fabricate an eligibility verdict, a deadline, a payout, or a confirmation number/);
  assert.match(agent.systemPrompt, /Statuses change only on evidence/);
  assert.match(agent.systemPrompt, /do-not-research list/);
});

test("no registered tool can file, attest, submit or change a claim, and none needs approval because none acts", async () => {
  const d = deps();
  const registry = loadDefaultConfig(undefined, undefined, undefined, undefined, undefined, undefined, undefined, { settlements: d });
  for (const tool of registry.listTools()) {
    assert.doesNotMatch(tool.name, /settlement.*(file|submit|attest|status|verdict|confirm)|(file|submit|attest).*(claim|settlement)/i, tool.name);
  }
  const tools = registry.toolMapFor(registry.getAgent("settlements-agent").toolNames);
  assert.equal(tools.size, 4);

  // Run every tool; statuses, verdicts and confirmations must be untouched.
  const before = (await d.openTracker()).list();
  for (const tool of tools.values()) {
    assert.notEqual(tool.requiresApproval, true, tool.name);
    const out = await tool.execute(tool.name === "settlements-evaluate" ? { text: "anyone who received a data breach notice" } : {});
    assert.ok(out.length > 0, tool.name);
  }
  const after = (await d.openTracker()).list();
  assert.deepEqual(
    after.map((s) => [s.id, s.status, s.eligibility, s.confirmation, s.deadline]),
    before.map((s) => [s.id, s.status, s.eligibility, s.confirmation, s.deadline]),
  );
  assert.equal((await d.openTracker()).inbox().length, 2, "the sweep's only write is the research inbox");
});

test("the settlements agent reports without claiming it filed anything", async () => {
  const d = deps();
  const registry = loadDefaultConfig(undefined, undefined, undefined, undefined, undefined, undefined, undefined, { settlements: d });
  const agent = registry.getAgent("settlements-agent");
  const provider = new FakeProvider([
    { content: "", toolCalls: [{ id: "c1", toolName: "settlements-deadlines", input: {} }], stopReason: "tool_use" },
    { content: "", toolCalls: [{ id: "c2", toolName: "settlements-review", input: { id: "usa-clinics-tcpa" } }], stopReason: "tool_use" },
    { content: "## Status\nNothing has been filed, attested or submitted for you.", toolCalls: [], stopReason: "end_turn" },
  ]);
  const run = await runToCompletion(createTask("What settlements are due?"), agent, { provider, tools: registry.toolMapFor(agent.toolNames) });
  assert.equal(run.status, "succeeded");
  const toolOutputs = run.session.messages.filter((m) => m.role === "tool").map((m) => m.content).join("\n");
  assert.match(toolOutputs, /USA Clinics Group TCPA .* 10 days left/);
  assert.match(toolOutputs, /14-day mark/);
});

test("the settlements code has no path that submits anything", async () => {
  const root = join(__dirname, "..", "..", "..", "src");
  const files: string[] = [];
  async function walk(dir: string): Promise<void> {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) await walk(path);
      else if (entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts") && entry.name !== "fixtures.ts") files.push(path);
    }
  }
  await walk(join(root, "settlements"));
  files.push(join(root, "tools", "settlements-tools.ts"), join(root, "cli", "settlements-commands.ts"), join(root, "packs", "settlements", "pack.ts"));
  assert.ok(files.length >= 12);
  for (const file of files) {
    const source = await readFile(file, "utf-8");
    assert.doesNotMatch(source, /method:\s*["'](POST|PUT|PATCH|DELETE)["']/i, file);
    assert.doesNotMatch(source, /export (async )?function (file|submit|attest)\w*/i, file);
    assert.doesNotMatch(source, /browser|playwright|form-client/i, file);
  }
});
