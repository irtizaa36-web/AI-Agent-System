import { test } from "node:test";
import assert from "node:assert/strict";
import { runCli, type CliDeps } from "./index";
import { Registry } from "../registry/registry";
import { InMemoryRunStore } from "../store/run-store";
import { InMemoryWorkflowStore } from "../store/workflow-store";
import { FakeInkboxClient } from "../integrations/inkbox/fake-client";
import { InMemoryForwardingLog } from "../integrations/inkbox/forwarding-log";
import { InMemoryMessageEventLog } from "../integrations/inkbox/message-event-log";
import { InMemoryCoworkerTaskStore } from "../coworker/store";
import { InMemoryAgentStatusStore } from "../dashboard/agent-status-store";
import { InMemoryRecommendationStore } from "../dashboard/recommendation-store";
import { createSettlementsDeps } from "../settlements/deps";
import { InMemoryTrackerStorage } from "../settlements/storage";
import { CLASSACTION_ORG_PAGE, TOP_CLASS_ACTIONS_FEED } from "../settlements/research/fixtures";
import { classActionOrgSource, topClassActionsSource } from "../settlements/research/sources";
import { settlementsUsage } from "./settlements-commands";

function harness(today = "2026-09-25") {
  let now = today;
  const storage = new InMemoryTrackerStorage();
  const pages: Record<string, string> = { [topClassActionsSource.url]: TOP_CLASS_ACTIONS_FEED, [classActionOrgSource.url]: CLASSACTION_ORG_PAGE };
  const settlements = createSettlementsDeps({
    storage,
    today: () => now,
    fetch: async (url) => ({ ok: url in pages, status: url in pages ? 200 : 404, text: async () => pages[url] ?? "" }),
  });
  const stdout: string[] = [];
  const stderr: string[] = [];
  const deps: CliDeps = {
    registry: new Registry(),
    store: new InMemoryRunStore(),
    workflowStore: new InMemoryWorkflowStore(),
    cwd: process.cwd(),
    inkboxClient: new FakeInkboxClient(),
    forwardingLog: new InMemoryForwardingLog(),
    messageEventLog: new InMemoryMessageEventLog(),
    coworkerStore: new InMemoryCoworkerTaskStore(),
    agentStatusStore: new InMemoryAgentStatusStore(),
    recommendationStore: new InMemoryRecommendationStore(),
    settlements,
    stdout: (line) => stdout.push(line),
    stderr: (line) => stderr.push(line),
  };
  const run = async (...args: string[]) => {
    stdout.length = 0;
    stderr.length = 0;
    const code = await runCli(["settlements", ...args], deps);
    return { code, out: stdout.join("\n"), err: stderr.join("\n") };
  };
  return { run, settlements, setToday: (d: string) => (now = d) };
}

test("settlements deadlines lists the seeded pipeline soonest first", async () => {
  const h = harness();
  const r = await h.run("deadlines");
  assert.equal(r.code, 0);
  const order = ["usa-clinics-tcpa", "vsl3-probiotic", "finwise", "bestway-pool", "modmed", "dr-squatch", "amazon-returns", "inotiv", "realpage", "nonbank-atm"];
  const positions = order.map((id) => r.out.indexOf(`(${id})`));
  assert.ok(positions.every((p) => p > 0), r.out);
  assert.deepEqual([...positions].sort((a, b) => a - b), positions);
  assert.match(r.out, /UPCOMING\s+2026-10-05\s+10 days left\s+USA Clinics/);
  assert.match(r.out, /Non-bank ATM .* deadline conflict/);
  assert.doesNotMatch(r.out, /cvs-digital-privacy|apple-siri/, "filed and dropped aren't open");
  assert.match((await h.run("deadlines", "--all")).out, /cvs-digital-privacy/);
});

test("settlements alerts nudges once per threshold and --dry-run doesn't consume it", async () => {
  const h = harness();
  const dry = await h.run("alerts", "--dry-run");
  assert.match(dry.out, /USA Clinics Group TCPA \(unwanted texts\): 10 days left \(deadline 2026-10-05, 14-day mark\)/);
  assert.match(dry.out, /you: Search texts and email for USA Clinics Group messages/);
  assert.match(dry.out, /Nothing has been filed, attested or submitted for you/);
  assert.match((await h.run("alerts")).out, /1 deadline nudge/);
  assert.match((await h.run("alerts")).out, /No new deadline nudges/);
  h.setToday("2026-10-02");
  assert.match((await h.run("alerts")).out, /3 days left .*3-day mark/);
});

test("settlements review shows verdicts, evidence required, sourced payouts, and the missing CVS confirmation", async () => {
  const h = harness();
  const r = await h.run("review");
  assert.equal(r.code, 0);
  assert.match(r.out, /OPEN \(10\)/);
  assert.match(r.out, /FILED BY YOU \(1\)/);
  assert.match(r.out, /confirmation: NOT RECORDED — run: settlements confirmation cvs-digital-privacy <number>/);
  assert.match(r.out, /DROPPED \(13\)/);
  assert.match(r.out, /payout: \$50 - \$150 \[ClassAction.org settlements list/);
  assert.match(r.out, /\? you need to confirm: More than one USA Clinics Group marketing text/);
  const one = await h.run("review", "amazon-returns");
  assert.match(one.out, /✓ Had an Amazon return with a missing, late or wrong refund/);
  assert.match(one.out, /\? you need to confirm: Order numbers of affected returns/);
  assert.match(one.out, /history:\n\s+2026-09-25 researching: Imported/);
  assert.equal((await h.run("review", "nope")).code, 1);
});

test("the owner records a filing, its confirmation, and a payment — each with evidence", async () => {
  const h = harness();
  assert.match((await h.run("status", "vsl3-probiotic", "filed")).err, /--evidence is required: statuses change only on evidence/);
  assert.match((await h.run("status", "vsl3-probiotic", "ready_to_file", "--evidence", "I think so")).err, /unverified. Record an "eligible" verdict/);
  assert.equal((await h.run("verdict", "vsl3-probiotic", "eligible", "--evidence", "Found 2018 Amazon orders for 4 bottles")).code, 0);
  assert.equal((await h.run("status", "vsl3-probiotic", "ready_to_file", "--evidence", "Receipts gathered")).code, 0);
  const filed = await h.run("status", "vsl3-probiotic", "filed", "--evidence", "Submitted on vsl3lawsuit.com myself", "--filed-on", "2026-09-25");
  assert.match(filed.out, /is now filed\.\nNo confirmation number recorded/);
  assert.match((await h.run("confirmation", "vsl3-probiotic", "VSL-778899")).out, /Recorded confirmation VSL-778899/);
  assert.equal((await h.run("status", "vsl3-probiotic", "paid", "--evidence", "Check received", "--amount", "80", "--paid-on", "2026-09-25")).code, 0);
  assert.match((await h.run("review", "vsl3-probiotic")).out, /paid \$80\.00 on 2026-09-25/);

  assert.match((await h.run("confirmation", "cvs-digital-privacy", "5c4b-TEST")).out, /Recorded confirmation 5c4b-TEST for CVS digital privacy/);
});

test("dropping is permanent and research never brings it back", async () => {
  const h = harness();
  const drop = await h.run("status", "usa-clinics-tcpa", "dropped", "--evidence", "Searched all texts; none from USA Clinics");
  assert.match(drop.out, /do-not-research list/);
  assert.match((await h.run("status", "usa-clinics-tcpa", "researching", "--evidence", "x")).err, /dropped is final/);
  assert.match((await h.run("do-not-research")).out, /USA Clinics Group TCPA \(unwanted texts\).*Searched all texts/);
  const sweep = await h.run("research");
  assert.match(sweep.out, /on the do-not-research list \(4\):.*USA Clinics Group - Unwanted Texts \[USA Clinics Group TCPA \(unwanted texts\)\]/);
});

test("research → inbox → add/dismiss, with a sourced deadline required", async () => {
  const h = harness();
  const sweep = await h.run("research", "--limit", "1");
  assert.equal(sweep.code, 0);
  assert.match(sweep.out, /source Top Class Actions: 5 listings/);
  assert.match(sweep.out, /NEW \(2\)/);
  assert.match(sweep.out, /…and 1 more in the inbox/);
  assert.match(sweep.out, /Nothing was added to your tracker/);
  assert.match((await h.run("inbox")).out, /c-dap-health-data-breach\s+unverified\s+2026-10-21\s+DAP Health - Data Breach/);

  assert.match((await h.run("add", "c-dap-health-data-breach")).out, /Now tracking dap-health-data-breach/);
  assert.match((await h.run("dismiss", "c-navy-federal-credit-union-unauthorized-loans", "--reason", "Not a Navy Federal member")).out, /do-not-research list/);
  assert.match((await h.run("inbox")).out, /inbox is empty/);

  // A candidate with no deadline can only be added with one the owner sourced.
  const tracker = await h.settlements.openTracker();
  await tracker.recordCandidates([{ id: "c-x", name: "Example Widget", sources: [], domains: [], deadlineConflicts: [], criteria: [], firstSeen: "2026-09-25" }], []);
  assert.match((await h.run("add", "c-x")).err, /no sourced deadline/);
  assert.match((await h.run("add", "c-x", "--deadline", "2026-11-01")).err, /--deadline needs --source/);
  assert.equal((await h.run("add", "c-x", "--deadline", "2026-11-01", "--source", "https://widgetsettlement.com/faq")).code, 0);
  assert.match((await h.run("review", "example-widget")).out, /deadline source: widgetsettlement.com https:\/\/widgetsettlement.com\/faq/);
});

test("manual add infers criteria; action items track the owner's own steps", async () => {
  const h = harness();
  const added = await h.run("add", "--name", "Acme Rentals antitrust", "--deadline", "2026-12-15", "--source", "https://acmerentsettlement.com", "--payout", "Varies", "--class", "Tenants who rented an Acme apartment 2019-2024");
  assert.match(added.out, /Now tracking acme-rentals-antitrust/);
  assert.match(added.out, /✓ Rents a home/);
  assert.match((await h.run("add", "--name", "Forbes tracking settlement", "--deadline", "2026-12-15", "--source", "x")).err, /do-not-research list/);
  assert.match((await h.run("action", "acme-rentals-antitrust", "add", "--kind", "notice_search", "Look for the Acme notice")).out, /Added a1/);
  assert.match((await h.run("action", "acme-rentals-antitrust", "done", "a1", "--note", "found it")).out, /Done: Look for the Acme notice/);
  assert.equal((await h.run("action", "acme-rentals-antitrust", "add", "--kind", "file_claim", "x")).code, 1, "unknown kinds are refused");
});

test("settlements evaluate gives an explicit verdict with the evidence needed", async () => {
  const h = harness();
  assert.match((await h.run("evaluate", "--text", "California residents who visited the site")).out, /not_eligible/);
  const tcpa = await h.run("evaluate", "--title", "Acme TCPA", "--text", "received prerecorded calls from Acme");
  assert.match(tcpa.out, /unverified[\s\S]*came from this defendant/);
});

test("there is no command that files, attests or submits a claim", async () => {
  const h = harness();
  for (const sub of ["file", "submit", "attest", "claim", "file-claim"]) {
    const r = await h.run(sub);
    assert.equal(r.code, 1, sub);
    assert.match(r.err, /Usage \(orchestrator settlements/);
  }
  assert.doesNotMatch(settlementsUsage(), /settlements (file|submit|attest)\b/);
  assert.match(settlementsUsage(), /Every claim is filed by you, personally/);
});

test("bad flags report the command's own usage line", async () => {
  const h = harness();
  const r = await h.run("research", "--limit", "zero");
  assert.equal(r.code, 1);
  assert.match(r.err, /--limit must be a positive whole number\nUsage: orchestrator settlements research \[--limit N\]/);
  assert.match((await h.run("deadlines", "--nope")).err, /Unknown option '--nope'[\s\S]*Usage: orchestrator settlements deadlines/);
});
