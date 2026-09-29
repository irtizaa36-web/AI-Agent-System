import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildTailorSystemPrompt,
  buildTailorUserPrompt,
  draftTailoredResume,
  estimateTailorCost,
  stampDraftHeader,
  TAILOR_MAX_TOKENS,
  TAILOR_MODEL,
  tailorCompletionRequest,
} from "./tailor";
import { FakeScoringClient } from "./scoring-client";
import { costOf } from "./cost";
import type { JobRecord } from "./records";
import { runJobsCommand } from "../cli/jobs-commands";

/**
 * A synthetic posting with a real posting's shape: marketing program
 * management, stated salary and experience, signal-dense summary. Nothing in
 * it names a real person — no-fabrication tests use a fictional resume.
 */
function makeJob(overrides: Partial<JobRecord> = {}): JobRecord {
  return {
    id: "job-abc-123",
    contentHash: "hash",
    identityKey: "acme|growth marketing manager|remote",
    title: "Growth Marketing Manager",
    company: "Acme Corp",
    rawLocation: "Remote",
    locationClass: "remote",
    remoteRegion: "us",
    salaryMin: 120000,
    salaryMax: 150000,
    salaryCurrency: "USD",
    postedAt: "2026-09-20",
    experienceYearsMin: 3,
    experienceYearsMax: 6,
    firstSeenAt: "2026-09-21T10:00:00Z",
    lastSeenAt: "2026-09-21T10:00:00Z",
    sources: [{ sourceId: "greenhouse", url: "https://boards.example/greenhouse/acme/jobs/1", fetchedAt: "2026-09-21T10:00:00Z" }],
    applyUrl: "https://boards.example/greenhouse/acme/jobs/1",
    descriptionPath: "memory://hash",
    summary: "Own GTM launch calendars for new product releases. Run lifecycle email and paid-social experiments. Needs 3-6 years in marketing ops, Salesforce and HubSpot fluency, and SQL for funnel analysis.",
    state: "scored",
    filterReason: null,
    score: 82,
    confidence: "high",
    rationale: "Strong overlap on GTM and lifecycle experience.",
    gaps: ["SQL for funnel analysis"],
    ...overrides,
  };
}

/** A fictional resume. Any test claim about fabrication uses this, never a real person's. */
const SYNTHETIC_RESUME = `# Jane Doe
jane.doe@example.com · (555) 010-2030

## Summary
Marketing program manager with 5 years in B2B SaaS, owning GTM launch calendars and lifecycle campaigns.

## Experience
### Senior Marketing Program Manager — WidgetCo (2021–2026)
- Owned GTM launch calendar across 14 product releases, coordinating product, sales, and CS.
- Ran lifecycle email program driving 22% trial-to-paid conversion.
- Managed $1.2M annual paid-social budget.

### Marketing Specialist — GadgetInc (2019–2021)
- Built HubSpot workflows for lead nurturing; Salesforce power user.

## Skills
HubSpot, Salesforce, GTM planning, lifecycle marketing

## Education
B.A. Communications, State University (2019)`;

const OUTRAGEOUS_CLAIM = "won the Nobel Prize for growth hacking";

test("the system prompt carries the hard no-fabrication rules", () => {
  const system = buildTailorSystemPrompt();
  assert.ok(system.includes("NEVER invent"), "must forbid invention outright");
  assert.ok(system.includes("traceable to something written in the base resume"), "every bullet must trace to the resume");
  assert.ok(system.includes("reorder"), "reframing and reordering must be explicitly allowed");
  assert.ok(system.includes("## Gaps"), "must require the Gaps section");
  assert.ok(system.includes("never auto-submitted"), "must state draft-only");
});

test("the user prompt contains the job data and the full resume verbatim", () => {
  const job = makeJob();
  const user = buildTailorUserPrompt(job, SYNTHETIC_RESUME);
  assert.ok(user.includes("Growth Marketing Manager"), "job title");
  assert.ok(user.includes("Acme Corp"), "company");
  assert.ok(user.includes(job.summary), "posting summary");
  assert.ok(user.includes(SYNTHETIC_RESUME), "the complete resume, verbatim");
  // Raw HTML never enters the prompt: only the trimmed summary is included.
  assert.ok(!user.includes("descriptionPath"), "no pointer to raw bodies");
});

test("the prompts contain no claims absent from the job record and the resume", () => {
  // The fabrication boundary: every fact the model sees comes from the job
  // or the resume, so an outrageous claim can appear in neither prompt.
  const job = makeJob();
  const system = buildTailorSystemPrompt();
  const user = buildTailorUserPrompt(job, SYNTHETIC_RESUME);
  assert.ok(!system.includes(OUTRAGEOUS_CLAIM));
  assert.ok(!user.includes(OUTRAGEOUS_CLAIM));
  // And the job's own stated facts (salary, gaps) ARE visible to the model.
  assert.ok(user.includes("120,000"));
  assert.ok(user.includes("3–6 years"));
});

test("the draft header stamps the file as a draft-for-review with the job id", () => {
  const job = makeJob();
  const stamped = stampDraftHeader(job, "body text", new Date("2026-09-28T20:00:00Z"));
  const lines = stamped.split("\n");
  assert.ok(lines[0]?.startsWith("# DRAFT"), "header line leads the file");
  assert.ok(lines[0]?.includes("Growth Marketing Manager"), "title named in the header");
  assert.ok(lines[0]?.includes("Acme Corp"), "company named in the header");
  assert.ok(stamped.includes("do not submit"), "explicit do-not-submit stamp");
  assert.ok(stamped.includes(job.id), "job record id for traceability");
  assert.ok(stamped.endsWith("body text\n"), "draft body follows the stamp");
});

test("draftTailoredResume uses the ScoringClient port, Haiku, and prices the call", async () => {
  const job = makeJob();
  const fake = new FakeScoringClient(["# Jane Doe\n\nTailored resume body\n\n## Gaps\n- SQL for funnel analysis"]);
  const draft = await draftTailoredResume(job, SYNTHETIC_RESUME, fake, new Date("2026-09-28T20:00:00Z"));

  assert.equal(fake.requests.length, 1);
  assert.equal(fake.requests[0]?.model, TAILOR_MODEL, "drafting rides the Haiku default");
  assert.equal(fake.requests[0]?.maxTokens, TAILOR_MAX_TOKENS);
  assert.ok(draft.markdown.startsWith("# DRAFT"), "returned draft is stamped");
  assert.ok(draft.markdown.includes("## Gaps"), "model's Gaps section preserved under the stamp");
  assert.ok(draft.markdown.includes(job.id), "stamp carries the job id");
  assert.equal(
    draft.costUsd,
    costOf(TAILOR_MODEL, { inputTokens: draft.inputTokens, outputTokens: draft.outputTokens }),
    "cost priced from the same table as the scoring ledger",
  );
  assert.ok(draft.costUsd > 0, "a real Haiku call has a nonzero price");
});

test("draftTailoredResume surfaces API errors exactly as the client reports them", async () => {
  const job = makeJob();
  const failing = new FakeScoringClient([]);
  failing.complete = async () => {
    throw new Error("Anthropic API 429: rate limited");
  };
  await assert.rejects(() => draftTailoredResume(job, SYNTHETIC_RESUME, failing), /Anthropic API 429/);
});

test("estimateTailorCost is labeled an estimate and stays in the cents range", () => {
  const request = tailorCompletionRequest(makeJob(), SYNTHETIC_RESUME);
  const estimate = estimateTailorCost(request);
  assert.ok(estimate > 0, "a real prompt has nonzero estimated input");
  assert.ok(estimate < 0.05, `expected a few cents, got $${estimate.toFixed(4)}`);
});

// --- CLI: `jobs tailor` ---

interface CollectedDeps {
  readonly out: string[];
  readonly err: string[];
}

async function makeFixtureRoot(): Promise<{ root: string; cleanup: () => Promise<void> }> {
  const root = await mkdtemp(join(tmpdir(), "tailor-cli-test-"));
  await mkdir(join(root, "config", "job-search", "shivani"), { recursive: true });
  await writeFile(join(root, "config", "job-search", "shivani", "preferences.json"), "{}\n", "utf8");
  await mkdir(join(root, "profile", "shivani"), { recursive: true });
  await writeFile(join(root, "profile", "shivani", "resume.md"), `${SYNTHETIC_RESUME}\n`, "utf8");
  await mkdir(join(root, ".orchestrator", "jobs", "shivani", "jobs"), { recursive: true });
  await writeFile(
    join(root, ".orchestrator", "jobs", "shivani", "jobs", "job-abc-123.json"),
    `${JSON.stringify(makeJob(), null, 2)}\n`,
    "utf8",
  );
  return { root, cleanup: () => rm(root, { recursive: true, force: true }) };
}

function depsOf(collected: CollectedDeps, root: string) {
  return {
    stdout: (line: string) => collected.out.push(line),
    stderr: (line: string) => collected.err.push(line),
    root,
  };
}

test("jobs tailor --dry-run prints the prompt and a cost estimate, calls no API, writes nothing", async () => {
  const { root, cleanup } = await makeFixtureRoot();
  try {
    const collected: CollectedDeps = { out: [], err: [] };
    const exit = await runJobsCommand(
      ["tailor", "--profile", "shivani", "--job", "job-abc-123", "--dry-run"],
      depsOf(collected, root),
    );
    assert.equal(exit, 0);
    const out = collected.out.join("\n");
    assert.ok(out.includes("--- system prompt ---"), "system prompt printed");
    assert.ok(out.includes("--- user prompt ---"), "user prompt printed");
    assert.ok(out.includes("NEVER invent"), "no-fabrication rules visible in the dry run");
    assert.ok(out.includes(SYNTHETIC_RESUME.split("\n")[0] as string), "resume visible in the dry run");
    assert.ok(out.includes("~$"), "cost estimate printed");
    assert.ok(out.includes("no API call made"), "estimate labeled as no-call");
  } finally {
    await cleanup();
  }
});

test("jobs tailor fails loudly when --job is missing, unknown, or the resume is absent", async () => {
  const { root, cleanup } = await makeFixtureRoot();
  try {
    const missing: CollectedDeps = { out: [], err: [] };
    assert.equal(
      await runJobsCommand(["tailor", "--profile", "shivani"], depsOf(missing, root)),
      1,
      "missing --job exits nonzero",
    );
    assert.ok(missing.err.join(" ").includes("--job"));

    const unknown: CollectedDeps = { out: [], err: [] };
    assert.equal(
      await runJobsCommand(["tailor", "--profile", "shivani", "--job", "nope"], depsOf(unknown, root)),
      1,
      "unknown job id exits nonzero",
    );
    assert.ok(unknown.err.join(" ").includes("nope"));

    await rm(join(root, "profile", "shivani", "resume.md"));
    const noResume: CollectedDeps = { out: [], err: [] };
    assert.equal(
      await runJobsCommand(["tailor", "--profile", "shivani", "--job", "job-abc-123", "--dry-run"], depsOf(noResume, root)),
      1,
      "missing resume exits nonzero with the loud MissingProfile message",
    );
    assert.ok(noResume.err.join(" ").includes("No resume found"));
  } finally {
    await cleanup();
  }
});

test("jobs tailor refuses without an API key rather than drafting against nothing", async () => {
  const { root, cleanup } = await makeFixtureRoot();
  try {
    const saved = process.env["ANTHROPIC_API_KEY"];
    delete process.env["ANTHROPIC_API_KEY"];
    try {
      const collected: CollectedDeps = { out: [], err: [] };
      const exit = await runJobsCommand(
        ["tailor", "--profile", "shivani", "--job", "job-abc-123"],
        depsOf(collected, root),
      );
      assert.equal(exit, 1);
      assert.ok(collected.err.join(" ").includes("ANTHROPIC_API_KEY"), "names the missing key");
    } finally {
      if (saved !== undefined) process.env["ANTHROPIC_API_KEY"] = saved;
    }
  } finally {
    await cleanup();
  }
});
