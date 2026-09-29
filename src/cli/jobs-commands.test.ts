import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

/**
 * The jobs dashboard server has no auth, so its bind address is a security
 * property: it must stay localhost-only no matter what --port is passed.
 * Tested as a static assertion on the module source rather than by starting
 * the server (serveDashboard blocks on SIGINT/SIGTERM).
 */
test("the jobs dashboard binds 127.0.0.1 explicitly, never 0.0.0.0 or an env-driven host", async () => {
  const source = await readFile(join(__dirname, "jobs-commands.js"), "utf8");
  const listenCalls = [...source.matchAll(/server\.listen\(([^)]*)\)/g)].map((m) => m[1] as string);
  assert.ok(listenCalls.length > 0, "expected at least one server.listen call");
  for (const args of listenCalls) {
    assert.match(args, /"127\.0\.0\.1"/, `bind address must be explicit localhost: server.listen(${args})`);
    assert.doesNotMatch(args, /0\.0\.0\.0/, "never bind all interfaces");
  }
});

test("tailor --approve renders the diff and claim check, and only --confirm marks ready", async () => {
  const { mkdtemp, mkdir, writeFile, readFile } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { runJobsTailorApprove } = await import("./jobs-commands.js");
  const { profileDirFor } = await import("../jobsearch/config.js");
  const { TAILORED_DIR } = await import("../jobsearch/tailor.js");
  const { buildLedger, ledgerPathFor, writeLedger } = await import("../jobsearch/tailor-ledger.js");
  const { JsonFileJobStore } = await import("../store/job-store.js");
  const { dataDirFor } = await import("../jobsearch/config.js");
  const { randomUUID } = await import("node:crypto");

  const root = await mkdtemp(join(tmpdir(), "tailor-approve-"));
  const stdout: string[] = [];
  const stderr: string[] = [];
  const deps = { stdout: (l: string) => stdout.push(l), stderr: (l: string) => stderr.push(l) };

  const resume = ["# Resume", "", "## Experience", "- Led demand generation at Acme Corp."].join("\n");
  const profileDir = join(root, profileDirFor("shivani"));
  await mkdir(profileDir, { recursive: true });
  await writeFile(join(profileDir, "resume.md"), resume, "utf8");

  const tailoredDir = join(root, profileDirFor("shivani"), TAILORED_DIR);
  await mkdir(tailoredDir, { recursive: true });
  const draft = ["# DRAFT — x", "", "> do not submit", "", "# Resume", "", "## Experience", "- Led demand generation at Acme Corp for B2B SaaS.", "- Fluent in Mandarin and led the APAC expansion single-handedly."].join("\n");
  await writeFile(join(tailoredDir, "job-1.md"), draft, "utf8");
  const ledger = buildLedger({ jobId: "job-1", jobTitle: "Marketing Manager", company: "Acme", resume, draftMarkdown: draft, draftPath: join(tailoredDir, "job-1.md") });
  await writeLedger(ledgerPathFor(tailoredDir, "job-1"), ledger);

  const store = new JsonFileJobStore(join(root, dataDirFor("shivani")));
  await store.saveApplication({
    id: randomUUID(), jobId: "job-1", status: "pending-approval", appliedAt: null,
    resumeVariantPath: join(tailoredDir, "job-1.md"), coverLetterPath: null,
    followUpDueAt: null, outcome: null, rejectionReason: null, notes: [],
  });

  // Review-only: renders, changes nothing.
  assert.equal(await runJobsTailorApprove("shivani", root, deps, "job-1", false), 0);
  const review = stdout.join("\n");
  assert.match(review, /Base resume vs tailored draft/);
  assert.match(review, /UNSUPPORTED/);
  assert.match(review, /APAC expansion/);
  assert.match(review, /--confirm/);
  const stillPending = JSON.parse(await readFile(ledgerPathFor(tailoredDir, "job-1"), "utf8")) as { status: string };
  assert.equal(stillPending.status, "pending-approval", "review-only changes nothing");

  // The explicit tap: marks ready.
  stdout.length = 0;
  assert.equal(await runJobsTailorApprove("shivani", root, deps, "job-1", true), 0);
  const approved = JSON.parse(await readFile(ledgerPathFor(tailoredDir, "job-1"), "utf8")) as { status: string; approvedAt: string | null };
  assert.equal(approved.status, "ready");
  assert.ok(approved.approvedAt, "approval is timestamped");
  const apps = await store.listApplications();
  assert.equal(apps[0]!.status, "materials_ready");

  // A second confirm is a no-op, never re-stamps.
  const firstApprovedAt = approved.approvedAt;
  assert.equal(await runJobsTailorApprove("shivani", root, deps, "job-1", true), 0);
  const again = JSON.parse(await readFile(ledgerPathFor(tailoredDir, "job-1"), "utf8")) as { approvedAt: string };
  assert.equal(again.approvedAt, firstApprovedAt);
});

test("tailor --approve fails loudly when there is no ledger", async () => {
  const { mkdtemp, mkdir, writeFile } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { runJobsTailorApprove } = await import("./jobs-commands.js");
  const root = await mkdtemp(join(tmpdir(), "tailor-approve-"));
  const stdout: string[] = [];
  const stderr: string[] = [];
  const deps = { stdout: (l: string) => stdout.push(l), stderr: (l: string) => stderr.push(l) };
  assert.equal(await runJobsTailorApprove("shivani", root, deps, "nope", true), 1);
  assert.match(stderr.join("\n"), /No evidence ledger/);
});

test("jobs applied records her application and schedules the nudge; jobs stage walks the funnel", async () => {
  const { mkdtemp, mkdir, writeFile } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { runJobsCommand } = await import("./jobs-commands.js");
  const { JsonFileJobStore } = await import("../store/job-store.js");
  const { dataDirFor } = await import("../jobsearch/config.js");

  const root = await mkdtemp(join(tmpdir(), "crm-cli-"));
  await mkdir(join(root, "config", "job-search", "shivani"), { recursive: true });
  const stdout: string[] = [];
  const stderr: string[] = [];
  const deps = { stdout: (l: string) => stdout.push(l), stderr: (l: string) => stderr.push(l), root };

  const store = new JsonFileJobStore(join(root, dataDirFor("shivani")));
  await store.saveJobs([{
    id: "job-1", contentHash: "h", identityKey: "k", title: "Field Marketing Manager", company: "Eon.io",
    rawLocation: "Remote", locationClass: "remote", remoteRegion: "us",
    salaryMin: null, salaryMax: null, salaryCurrency: null, postedAt: null,
    experienceYearsMin: null, experienceYearsMax: null,
    firstSeenAt: "2026-09-28T00:00:00.000Z", lastSeenAt: "2026-09-28T00:00:00.000Z",
    sources: [], applyUrl: "https://example.com/1", descriptionPath: "/tmp/1.html",
    summary: "s", state: "shortlisted", filterReason: null, score: 80,
    confidence: null, rationale: null, gaps: [], scoreDimensions: null,
  }]);

  assert.equal(await runJobsCommand(["applied", "--profile", "shivani", "--job", "job-1"], deps), 0);
  let apps = await store.listApplications();
  assert.equal(apps.length, 1);
  assert.equal(apps[0]!.status, "applied");
  assert.ok(apps[0]!.appliedAt, "applied date stamped");
  assert.ok(apps[0]!.followUpDueAt, "nudge scheduled");
  assert.match(stdout.join("\n"), /Follow-up nudge scheduled in 7 days/);
  const jobs = await store.listJobs();
  assert.equal(jobs[0]!.state, "applied", "job record follows the application");

  // The funnel walk.
  assert.equal(await runJobsCommand(["stage", "--profile", "shivani", "job-1", "screening"], deps), 0);
  apps = await store.listApplications();
  assert.equal(apps[0]!.status, "screening");

  // An illegal jump fails loudly and changes nothing.
  stdout.length = 0; stderr.length = 0;
  assert.equal(await runJobsCommand(["stage", "--profile", "shivani", "job-1", "offer"], deps), 1);
  assert.match(stderr.join("\n"), /Cannot move application/);
  apps = await store.listApplications();
  assert.equal(apps[0]!.status, "screening", "illegal move changed nothing");
});

test("jobs reject rejects the posting and explicitly does not mute the company", async () => {
  const { mkdtemp, mkdir, writeFile } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { runJobsCommand } = await import("./jobs-commands.js");
  const { JsonFileJobStore } = await import("../store/job-store.js");
  const { dataDirFor } = await import("../jobsearch/config.js");
  const { loadMutedCompanies } = await import("../jobsearch/crm.js");

  const root = await mkdtemp(join(tmpdir(), "crm-cli-"));
  await mkdir(join(root, "config", "job-search", "shivani"), { recursive: true });
  const stdout: string[] = [];
  const stderr: string[] = [];
  const deps = { stdout: (l: string) => stdout.push(l), stderr: (l: string) => stderr.push(l), root };

  const store = new JsonFileJobStore(join(root, dataDirFor("shivani")));
  await store.saveJobs([{
    id: "job-2", contentHash: "h", identityKey: "k", title: "Marketing Coordinator", company: "Noise Inc",
    rawLocation: "Remote", locationClass: "remote", remoteRegion: "us",
    salaryMin: null, salaryMax: null, salaryCurrency: null, postedAt: null,
    experienceYearsMin: null, experienceYearsMax: null,
    firstSeenAt: "2026-09-28T00:00:00.000Z", lastSeenAt: "2026-09-28T00:00:00.000Z",
    sources: [], applyUrl: "https://example.com/2", descriptionPath: "/tmp/2.html",
    summary: "s", state: "shortlisted", filterReason: null, score: 70,
    confidence: null, rationale: null, gaps: [], scoreDimensions: null,
  }]);

  assert.equal(await runJobsCommand(["reject", "--profile", "shivani", "--job", "job-2"], deps), 0);
  const jobs = await store.listJobs();
  assert.equal(jobs[0]!.state, "rejected");
  assert.match(stdout.join("\n"), /NOT muted/);
  assert.deepEqual(await loadMutedCompanies("shivani", root), [], "rejecting a posting never mutes the company");
});

test("jobs mute-company / unmute-company round-trips", async () => {
  const { mkdtemp, mkdir, writeFile } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { runJobsCommand } = await import("./jobs-commands.js");
  const { loadMutedCompanies } = await import("../jobsearch/crm.js");

  const root = await mkdtemp(join(tmpdir(), "crm-cli-"));
  await mkdir(join(root, "config", "job-search", "shivani"), { recursive: true });
  const stdout: string[] = [];
  const stderr: string[] = [];
  const deps = { stdout: (l: string) => stdout.push(l), stderr: (l: string) => stderr.push(l), root };

  assert.equal(await runJobsCommand(["mute-company", "--profile", "shivani", "Noise Inc"], deps), 0);
  assert.deepEqual(await loadMutedCompanies("shivani", root), ["Noise Inc"]);
  assert.equal(await runJobsCommand(["unmute-company", "--profile", "shivani", "Noise Inc"], deps), 0);
  assert.deepEqual(await loadMutedCompanies("shivani", root), []);
});

test("jobs linkedin-sync ingests applied/saved history idempotently and never rejects", async () => {
  const { mkdtemp, mkdir, writeFile } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { runJobsCommand } = await import("./jobs-commands.js");
  const { JsonFileJobStore } = await import("../store/job-store.js");
  const { dataDirFor } = await import("../jobsearch/config.js");
  const { linkedInPullPath, chicagoDateStamp } = await import("../jobsearch/sources/linkedin-pull.js");

  const root = await mkdtemp(join(tmpdir(), "crm-cli-"));
  await mkdir(join(root, "config", "job-search", "shivani"), { recursive: true });
  const stdout: string[] = [];
  const stderr: string[] = [];
  const deps = { stdout: (l: string) => stdout.push(l), stderr: (l: string) => stderr.push(l), root };

  const pullPath = linkedInPullPath("shivani", chicagoDateStamp(new Date()), root);
  await mkdir(join(pullPath, ".."), { recursive: true });
  await writeFile(pullPath, JSON.stringify({
    pulledAt: new Date().toISOString(),
    items: [],
    appliedHistory: [
      { title: "Field Marketing Manager", company: "Eon.io", location: "Dallas", dateApplied: null, status: "In Progress" },
      { title: "Performance Marketing Specialist", company: "Bloom Nutrition", location: "Austin", dateApplied: null, status: "No longer accepting applications" },
    ],
    savedJobs: [
      { title: "Field Marketing Manager", company: "Baseten", location: "NYC", url: "https://example.com/b" },
    ],
  }), "utf8");

  assert.equal(await runJobsCommand(["linkedin-sync", "--profile", "shivani"], deps), 0);
  const store = new JsonFileJobStore(join(root, dataDirFor("shivani")));
  let apps = await store.listApplications();
  assert.equal(apps.length, 3);
  assert.deepEqual(apps.map((a) => a.status).sort(), ["applied", "applied", "saved"]);
  assert.ok(apps.every((a) => a.source === "linkedin"));

  // Second run: idempotent.
  stdout.length = 0;
  assert.equal(await runJobsCommand(["linkedin-sync", "--profile", "shivani"], deps), 0);
  apps = await store.listApplications();
  assert.equal(apps.length, 3, "re-running creates nothing new");
  assert.match(stdout.join("\n"), /0 application record\(s\) created/);
});

test("jobs mail-scan refuses without --dry-run and proposes links with it", async () => {
  const { mkdtemp, mkdir, writeFile } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { runJobsCommand } = await import("./jobs-commands.js");
  const { JsonFileJobStore } = await import("../store/job-store.js");
  const { dataDirFor } = await import("../jobsearch/config.js");
  const { randomUUID } = await import("node:crypto");

  const root = await mkdtemp(join(tmpdir(), "crm-cli-"));
  await mkdir(join(root, "config", "job-search", "shivani"), { recursive: true });
  const stdout: string[] = [];
  const stderr: string[] = [];
  const deps = { stdout: (l: string) => stdout.push(l), stderr: (l: string) => stderr.push(l), root };

  // Read-only by design: no --dry-run, no scan.
  assert.equal(await runJobsCommand(["mail-scan", "--profile", "shivani", "--mbox", "/tmp/x.json"], deps), 1);
  assert.match(stderr.join("\n"), /read-only/);

  const mbox = join(root, "mail.json");
  await writeFile(mbox, JSON.stringify([
    { id: "m1", from: "jobs@acmecorp.com", subject: "Interview: Marketing Program Manager", date: null, snippet: "Acme Corp would like to meet you" },
    { id: "m2", from: "mom@family.com", subject: "Dinner Sunday", date: null, snippet: "hi" },
  ]), "utf8");

  const store = new JsonFileJobStore(join(root, dataDirFor("shivani")));
  await store.saveJobs([{
    id: "job-9", contentHash: "h", identityKey: "k", title: "Marketing Program Manager", company: "Acme Corp",
    rawLocation: "Remote", locationClass: "remote", remoteRegion: "us",
    salaryMin: null, salaryMax: null, salaryCurrency: null, postedAt: null,
    experienceYearsMin: null, experienceYearsMax: null,
    firstSeenAt: "2026-09-28T00:00:00.000Z", lastSeenAt: "2026-09-28T00:00:00.000Z",
    sources: [], applyUrl: "https://example.com/9", descriptionPath: "/tmp/9.html",
    summary: "s", state: "applied", filterReason: null, score: 80,
    confidence: null, rationale: null, gaps: [], scoreDimensions: null,
  }]);
  await store.saveApplication({
    id: randomUUID(), jobId: "job-9", status: "applied", appliedAt: "2026-09-20T00:00:00.000Z",
    resumeVariantPath: null, coverLetterPath: null, followUpDueAt: "2026-09-27T00:00:00.000Z",
    outcome: null, rejectionReason: null, notes: [],
  });

  stdout.length = 0; stderr.length = 0;
  assert.equal(await runJobsCommand(["mail-scan", "--profile", "shivani", "--dry-run", "--mbox", mbox], deps), 0);
  const report = stdout.join("\n");
  assert.match(report, /interview/);
  assert.match(report, /nothing was changed/);
  assert.ok(!report.includes("Dinner Sunday"), "non-recruiting mail is not proposed");
});
