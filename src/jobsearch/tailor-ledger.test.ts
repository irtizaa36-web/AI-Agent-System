import { test } from "node:test";
import assert from "node:assert/strict";
import {
  approveLedger,
  buildLedger,
  classifyClaim,
  extractDraftClaims,
  extractResumeFacts,
  renderResumeDiff,
  stripDraftHeader,
} from "./tailor-ledger";

const RESUME = `# Shivani Sharma

## Experience

**Acme Corp** — Marketing Manager, Jan 2020 – Present
- Led demand generation, growing pipeline 30% year over year.
- Managed a team of 5 marketers and a $500K annual budget.

**Beta Inc** — Marketing Coordinator, Jun 2017 – Dec 2019
- Ran email campaigns to 200K subscribers.

## Skills

SEO, marketing automation, Salesforce, demand generation

## Education

B.A. Marketing, State University, 2017
`;

test("extractResumeFacts pulls dates, metrics, degrees, skills, and employers deterministically", () => {
  const facts = extractResumeFacts(RESUME);
  assert.ok(facts.dates.some((d) => /2020/.test(d)), "dates include 2020");
  assert.ok(facts.metrics.includes("30%"), "metrics include the 30% lift");
  assert.ok(facts.metrics.some((m) => m.includes("500")), "metrics include the budget");
  assert.ok(facts.degrees.some((d) => /B\.?A\.?/i.test(d)), "degrees include the B.A.");
  assert.ok(facts.skills.includes("SEO"), "skills include SEO");
  assert.ok(facts.employers.some((e) => /Acme Corp/.test(e)), "employers include Acme Corp");
});

test("extractResumeFacts never invents — an empty resume yields empty facts", () => {
  const facts = extractResumeFacts("nothing here");
  assert.deepEqual(
    [facts.employers, facts.titles, facts.dates, facts.metrics, facts.degrees, facts.skills].map((f) => f.length),
    [0, 0, 0, 0, 0, 0],
  );
});

test("a claim restating the resume is confirmed", () => {
  const { verdict } = classifyClaim("Led demand generation, growing pipeline 30% year over year.", RESUME);
  assert.equal(verdict, "confirmed");
});

test("a claim stating a metric the resume never states is unsupported, however well-worded", () => {
  const { verdict, evidence } = classifyClaim(
    "As Marketing Manager at Acme Corp, grew pipeline 300% in one quarter.",
    RESUME,
  );
  assert.equal(verdict, "unsupported");
  assert.ok(evidence.join(" ").includes("300%"), "the evidence names the invented metric");
});

test("a claim with no traceable phrases is unsupported", () => {
  const { verdict } = classifyClaim("Fluent in Mandarin and led the APAC expansion.", RESUME);
  assert.equal(verdict, "unsupported");
});

test("a partial match is supportable, not confirmed", () => {
  const { verdict } = classifyClaim("Marketing leader with demand generation expertise.", RESUME);
  assert.equal(verdict, "supportable");
});

test("extractDraftClaims skips the stamp header, headings, and the Gaps section", () => {
  const draft = [
    "# DRAFT — tailored resume for \"X\" at Y",
    "",
    "> **Draft for the candidate's review — do not submit.**",
    "",
    "## Experience",
    "- Led demand generation at Acme Corp.",
    "",
    "## Gaps",
    "- The posting wants Salesforce Marketing Cloud; the resume shows Salesforce core.",
  ].join("\n");
  const claims = extractDraftClaims(draft);
  assert.deepEqual(claims, ["Led demand generation at Acme Corp."]);
});

test("buildLedger is born pending-approval with per-claim verdicts", () => {
  const draft = [
    "# DRAFT — tailored",
    "",
    "## Experience",
    "- Led demand generation, growing pipeline 30% year over year.",
    "- Fluent in Mandarin and led the APAC expansion.",
  ].join("\n");
  const ledger = buildLedger({
    jobId: "job-1",
    jobTitle: "Marketing Manager",
    company: "Acme Corp",
    resume: RESUME,
    draftMarkdown: draft,
    draftPath: "profile/shivani/tailored/job-1.md",
    generatedAt: new Date("2026-09-28T16:00:00.000Z"),
  });
  assert.equal(ledger.status, "pending-approval");
  assert.equal(ledger.approvedAt, null);
  assert.equal(ledger.unsupportedCount, 1);
  assert.equal(ledger.claims.length, 2);
  assert.equal(ledger.baseResumeSha256.length, 64);
});

test("approveLedger flips pending-approval to ready, and nothing else", () => {
  const pending = buildLedger({
    jobId: "job-1",
    jobTitle: "T",
    company: "C",
    resume: RESUME,
    draftMarkdown: "- Led demand generation.",
    draftPath: "p",
  });
  const approved = approveLedger(pending, new Date("2026-09-28T17:00:00.000Z"));
  assert.equal(approved.status, "ready");
  assert.equal(approved.approvedAt, "2026-09-28T17:00:00.000Z");

  // Fail closed: an already-ready ledger is untouched, never re-stamped.
  const again = approveLedger(approved, new Date("2026-09-29T00:00:00.000Z"));
  assert.equal(again.approvedAt, "2026-09-28T17:00:00.000Z");
});

test("renderResumeDiff shows added and removed lines in unified form", () => {
  const base = ["# Resume", "", "## Experience", "- Led demand generation.", "- Ran email campaigns."].join("\n");
  const draft = ["# Resume", "", "## Experience", "- Led demand generation for B2B SaaS.", "- Ran email campaigns."].join("\n");
  const diff = renderResumeDiff(base, draft);
  assert.match(diff, /--- base resume/);
  assert.match(diff, /\+\+\+ tailored draft/);
  assert.match(diff, /^- - Led demand generation\.$/m);
  assert.match(diff, /^\+ - Led demand generation for B2B SaaS\.$/m);
  assert.doesNotMatch(diff, /^- - Ran email campaigns\.$/m, "unchanged lines are context, not removals");
});

test("renderResumeDiff ignores the stamp header on the draft side", () => {
  const diff = renderResumeDiff("# Resume\n\nBody line.", "# DRAFT — x\n\n> do not submit\n\n# Resume\n\nBody line.");
  assert.doesNotMatch(diff, /^\+ # DRAFT/m);
  assert.doesNotMatch(diff, /^\+ >/m);
});

test("stripDraftHeader removes the stamp but keeps the body", () => {
  const stripped = stripDraftHeader("# DRAFT — x\n\n> do not submit\n\n# Resume\n\nBody.");
  assert.ok(!stripped.includes("DRAFT"), "header gone");
  assert.ok(stripped.includes("Body."), "body kept");
});
