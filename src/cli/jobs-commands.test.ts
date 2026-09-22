import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseProfileFlag, runJobsCommand } from "./jobs-commands";
import type { JobsClients, JobsCommandDeps } from "./jobs-context";
import { FakeInkboxClient } from "../integrations/inkbox/fake-client";
import { FakeContactClient, type Contact } from "../integrations/inkbox/contact-client";
import { FakeScoringClient } from "../jobsearch/scoring-client";
import { FakeSmsClient } from "../jobsearch/sms-client";
import { FakeImessageClient } from "../jobsearch/imessage-client";
import type { EmailMessage } from "../integrations/inkbox/client";

/**
 * Every test runs against a fresh temp directory as the repo root, an explicit
 * env, and fake clients — so nothing here can read the real config, reach a
 * real mailbox or phone, or commit to the real repository.
 */

const NO_CLIENTS: JobsClients = {
  inkbox: () => undefined,
  scoring: () => undefined,
  sms: () => undefined,
  imessage: () => undefined,
  contacts: () => undefined,
  commitAndPush: () => ({ committed: false, pushed: false, error: "git is not available in tests" }),
};

interface Harness {
  readonly root: string;
  readonly out: string[];
  readonly err: string[];
  readonly run: (args: readonly string[], overrides?: Partial<Pick<JobsCommandDeps, "env" | "clients">>) => Promise<number>;
}

async function harness(profiles: Readonly<Record<string, { prefs?: object; watchlist?: readonly object[]; resume?: string }>> = {}): Promise<Harness> {
  const root = await mkdtemp(join(tmpdir(), "jobs-cli-"));
  for (const [name, setup] of Object.entries(profiles)) {
    const configDir = join(root, "config/job-search", name);
    await mkdir(configDir, { recursive: true });
    await writeFile(join(configDir, "preferences.json"), JSON.stringify(setup.prefs ?? {}), "utf8");
    await writeFile(join(configDir, "watchlist.json"), JSON.stringify(setup.watchlist ?? []), "utf8");
    if (setup.resume !== undefined) {
      await mkdir(join(root, "profile", name), { recursive: true });
      await writeFile(join(root, "profile", name, "resume.md"), setup.resume, "utf8");
    }
  }

  const out: string[] = [];
  const err: string[] = [];
  return {
    root,
    out,
    err,
    run: (args, overrides = {}) =>
      runJobsCommand(args, {
        stdout: (line) => out.push(line),
        stderr: (line) => err.push(line),
        root,
        env: overrides.env ?? {},
        clients: { ...NO_CLIENTS, ...overrides.clients },
      }),
  };
}

function email(overrides: Partial<EmailMessage> & Pick<EmailMessage, "id" | "body">): EmailMessage {
  return {
    threadId: `thread-${overrides.id}`,
    from: { address: "candidate@example.test" },
    to: [{ address: "agent@example.test" }],
    subject: "About my search",
    receivedAt: "2026-09-20T12:00:00.000Z",
    ...overrides,
  };
}

test("parseProfileFlag reads the value after --profile and refuses a flag in its place", () => {
  assert.equal(parseProfileFlag(["--profile", "shivani"]), "shivani");
  assert.equal(parseProfileFlag(["--profile", "--all"]), undefined);
  assert.equal(parseProfileFlag(["--profile"]), undefined);
  assert.equal(parseProfileFlag([]), undefined);
});

test("no subcommand or help prints usage and succeeds; an unknown subcommand prints usage and fails", async () => {
  const h = await harness();
  assert.equal(await h.run([]), 0);
  assert.equal(await h.run(["help"]), 0);
  assert.equal(await h.run(["nonsense"]), 1);
  assert.match(h.out.join("\n"), /jobs subcommands/);
});

test("profiles lists every configured profile, sorted", async () => {
  const h = await harness({ shivani: {}, irtiza: {} });
  assert.equal(await h.run(["profiles"]), 0);
  assert.deepEqual(h.out, ["irtiza", "shivani"]);
});

test("a per-profile command never picks a profile for you", async () => {
  const h = await harness({ shivani: {} });
  assert.equal(await h.run(["run"]), 1);
  assert.match(h.err.join("\n"), /Which profile\? Pass --profile <name> or --all\. Configured: shivani\./);
});

test("an unknown or invalid profile name is refused before anything is read or written", async () => {
  const h = await harness({ shivani: {} });
  assert.equal(await h.run(["digest", "--profile", "someone-else"]), 1);
  assert.equal(await h.run(["digest", "--profile", "../escape"]), 1);
  assert.match(h.err[0] ?? "", /No profile named "someone-else"/);
  assert.match(h.err[1] ?? "", /not a valid profile name/);
});

test("single-profile commands do not accept --all", async () => {
  const h = await harness({ shivani: {} });
  assert.equal(await h.run(["digest", "--all"]), 1);
  assert.match(h.err.join("\n"), /Pass --profile <name>\. /);
});

test("run with no watchlist and no Inkbox has nothing to fetch and says so", async () => {
  const h = await harness({ shivani: {} });
  assert.equal(await h.run(["run", "--profile", "shivani"]), 1);
  assert.match(h.err.join("\n"), /No sources configured for shivani/);
});

test("run without a resume still discovers, writes the digest, and names the real reason scoring was skipped", async () => {
  const h = await harness({ shivani: {} });
  const inkbox = new FakeInkboxClient();

  assert.equal(await h.run(["run", "--profile", "shivani"], { clients: { inkbox: () => inkbox } }), 0);

  assert.match(h.err.join("\n"), /No resume found/);
  assert.doesNotMatch(h.err.join("\n"), /ANTHROPIC_API_KEY/);
  const latest = await readFile(join(h.root, ".orchestrator/jobs/shivani/digests/latest.md"), "utf8");
  assert.match(latest, /# Job digest/);
  const payload = JSON.parse(await readFile(join(h.root, ".orchestrator/jobs/shivani/digests/latest.json"), "utf8")) as object;
  assert.ok(payload);

  // `jobs digest` now prints exactly what run wrote.
  h.out.length = 0;
  assert.equal(await h.run(["digest", "--profile", "shivani"]), 0);
  assert.equal(h.out[0], latest);
});

test("run with a resume but no API key warns that scoring is skipped", async () => {
  const h = await harness({ shivani: { resume: "# Resume" } });
  assert.equal(await h.run(["run", "--profile", "shivani"], { clients: { inkbox: () => new FakeInkboxClient() } }), 0);
  assert.match(h.err.join("\n"), /ANTHROPIC_API_KEY is not set — running discovery only/);
});

test("run --all runs every profile under its own header and keeps their digests apart", async () => {
  const h = await harness({ irtiza: {}, shivani: {} });
  assert.equal(await h.run(["run", "--all"], { clients: { inkbox: () => new FakeInkboxClient() } }), 0);
  assert.ok(h.out.includes("\n===== irtiza =====\n"));
  assert.ok(h.out.includes("\n===== shivani =====\n"));
  await readFile(join(h.root, ".orchestrator/jobs/irtiza/digests/latest.md"), "utf8");
  await readFile(join(h.root, ".orchestrator/jobs/shivani/digests/latest.md"), "utf8");
});

test("digest before any run explains how to make one", async () => {
  const h = await harness({ shivani: {} });
  assert.equal(await h.run(["digest", "--profile", "shivani"]), 1);
  assert.match(h.err.join("\n"), /No digest yet for shivani/);
});

test("delivery sends nothing unless each channel's *_ENABLED flag is exactly \"true\"", async () => {
  const h = await harness({ shivani: {} });
  const inkbox = new FakeInkboxClient();
  const sms = new FakeSmsClient();
  const imessage = new FakeImessageClient();
  const env = { DIGEST_SMS_TO: "+15550001111", DIGEST_IMESSAGE_TO: "+15550001111", DIGEST_EMAIL_TO: "candidate@example.test" };

  await h.run(["run", "--profile", "shivani"], { env, clients: { inkbox: () => inkbox, sms: () => sms, imessage: () => imessage } });

  assert.equal(sms.sent.length, 0);
  assert.equal(imessage.sent.length, 0);
  assert.equal((await inkbox.searchMail()).length, 0);
});

test("delivery sends the digest on every enabled channel", async () => {
  const h = await harness({ shivani: {} });
  const inkbox = new FakeInkboxClient();
  const sms = new FakeSmsClient();
  const imessage = new FakeImessageClient();
  const env = {
    DIGEST_SMS_ENABLED: "true",
    DIGEST_SMS_TO: "+15550001111",
    DIGEST_IMESSAGE_ENABLED: "true",
    DIGEST_IMESSAGE_TO: "+15550002222",
    DIGEST_EMAIL_ENABLED: "true",
    DIGEST_EMAIL_TO: "candidate@example.test",
  };

  assert.equal(await h.run(["run", "--profile", "shivani"], { env, clients: { inkbox: () => inkbox, sms: () => sms, imessage: () => imessage } }), 0);

  assert.equal(sms.sent[0]?.to, "+15550001111");
  assert.equal(imessage.sent[0]?.to, "+15550002222");
  const sentMail = await inkbox.searchMail();
  assert.equal(sentMail.length, 1);
  assert.equal(sentMail[0]?.to[0]?.address, "candidate@example.test");
  assert.match(h.out.join("\n"), /Digest texted to/);
  assert.match(h.out.join("\n"), /Digest iMessaged to/);
  assert.match(h.out.join("\n"), /Digest emailed to/);
});

test("an enabled channel with a missing destination or client is reported, and never fails the run", async () => {
  const h = await harness({ shivani: {} });
  const env = { DIGEST_SMS_ENABLED: "true", DIGEST_IMESSAGE_ENABLED: "true", DIGEST_IMESSAGE_TO: "+15550002222" };

  assert.equal(await h.run(["run", "--profile", "shivani"], { env, clients: { inkbox: () => new FakeInkboxClient() } }), 0);

  assert.match(h.err.join("\n"), /DIGEST_SMS_TO is not set/);
  assert.match(h.err.join("\n"), /INKBOX_API_KEY\/INKBOX_IDENTITY_ID are not both set/);
});

test("a blocked SMS recipient gets the opt-in hint", async () => {
  const h = await harness({ shivani: {} });
  const env = { DIGEST_SMS_ENABLED: "true", DIGEST_SMS_TO: "+15550001111" };
  await h.run(["run", "--profile", "shivani"], { env, clients: { inkbox: () => new FakeInkboxClient(), sms: () => new FakeSmsClient("blocked") } });
  assert.match(h.err.join("\n"), /Could not text the digest: .*opted in through Inkbox/);
});

test("check-feedback is a silent no-op unless FEEDBACK_LOOP_ENABLED is true", async () => {
  const h = await harness({ shivani: {} });
  assert.equal(await h.run(["check-feedback", "--profile", "shivani"]), 0);
  assert.deepEqual(h.out, []);
  assert.deepEqual(h.err, []);
});

test("check-feedback applies a requested preference change, commits it, replies, and never processes the same email twice", async () => {
  const h = await harness({ shivani: { prefs: { salaryFloor: 80000, _salaryFloor: "kept documentary comment" } } });
  const inkbox = new FakeInkboxClient("agent@example.test", [email({ id: "m1", body: "Please raise my salary floor to 95k." })]);
  const scoring = new FakeScoringClient([
    JSON.stringify({ hasQuestion: false, answerDraft: null, changes: [{ field: "salaryFloor", value: 95000, quote: "raise my salary floor to 95k" }], unclear: [] }),
  ]);
  const commits: { file: string; message: string }[] = [];
  const clients = {
    inkbox: () => inkbox,
    scoring: () => scoring,
    commitAndPush: (file: string, message: string) => {
      commits.push({ file, message });
      return { committed: true, pushed: true };
    },
  };
  const env = { FEEDBACK_LOOP_ENABLED: "true", DIGEST_EMAIL_TO: "candidate@example.test" };

  assert.equal(await h.run(["check-feedback", "--profile", "shivani"], { env, clients }), 0);

  const prefs = JSON.parse(await readFile(join(h.root, "config/job-search/shivani/preferences.json"), "utf8")) as Record<string, unknown>;
  assert.equal(prefs["salaryFloor"], 95000);
  assert.equal(prefs["_salaryFloor"], "kept documentary comment");
  assert.equal(commits.length, 1);
  assert.equal(commits[0]?.file, join("config/job-search/shivani", "preferences.json"));
  assert.match(commits[0]?.message ?? "", /^feedback\(shivani\): salaryFloor/);

  const replies = (await inkbox.searchMail()).filter((m) => m.from.address === "agent@example.test");
  assert.equal(replies.length, 1);
  assert.equal(replies[0]?.subject, "Re: About my search");
  assert.equal(replies[0]?.to[0]?.address, "candidate@example.test");

  // Second pass: already processed, so no second model call and no second reply.
  assert.equal(await h.run(["check-feedback", "--profile", "shivani"], { env, clients }), 0);
  assert.equal(scoring.requests.length, 1);
  assert.match(h.out.join("\n"), /No new direct feedback emails found/);
});

test("check-feedback ignores mail that is not the candidate writing directly to this mailbox", async () => {
  const h = await harness({ shivani: {} });
  const inkbox = new FakeInkboxClient("agent@example.test", [email({ id: "m1", body: "hi", from: { address: "stranger@example.test" } })]);
  const scoring = new FakeScoringClient([]);
  const env = { FEEDBACK_LOOP_ENABLED: "true", DIGEST_EMAIL_TO: "candidate@example.test" };

  assert.equal(await h.run(["check-feedback", "--profile", "shivani"], { env, clients: { inkbox: () => inkbox, scoring: () => scoring } }), 0);
  assert.equal(scoring.requests.length, 0);
});

test("check-feedback reports a git failure instead of hiding it", async () => {
  const h = await harness({ shivani: {} });
  const inkbox = new FakeInkboxClient("agent@example.test", [email({ id: "m1", body: "Only remote roles please." })]);
  const scoring = new FakeScoringClient([
    JSON.stringify({ hasQuestion: false, answerDraft: null, changes: [{ field: "remoteOnly", value: true, quote: "Only remote roles" }], unclear: [] }),
  ]);
  const env = { FEEDBACK_LOOP_ENABLED: "true", DIGEST_EMAIL_TO: "candidate@example.test" };

  await h.run(["check-feedback", "--profile", "shivani"], { env, clients: { inkbox: () => inkbox, scoring: () => scoring } });
  assert.match(h.err.join("\n"), /git failed \(git is not available in tests\)/);
});

test("check-feedback answers a text on the same channel it arrived on", async () => {
  const h = await harness({ shivani: {} });
  const imessage = new FakeImessageClient([
    { id: "t1", conversationId: "c1", direction: "inbound", remoteNumber: "+15550002222", content: "What did you find today?", service: "imessage", isRead: false },
  ]);
  const scoring = new FakeScoringClient([
    JSON.stringify({ hasQuestion: true, answerDraft: "Nothing new cleared the cutoff today.", changes: [], unclear: [] }),
  ]);
  const env = { FEEDBACK_LOOP_ENABLED: "true", DIGEST_EMAIL_TO: "candidate@example.test", DIGEST_IMESSAGE_TO: "+15550002222" };

  assert.equal(
    await h.run(["check-feedback", "--profile", "shivani"], {
      env,
      clients: { inkbox: () => new FakeInkboxClient(), imessage: () => imessage, scoring: () => scoring },
    }),
    0,
  );
  assert.equal(imessage.sent.length, 1);
  assert.equal(imessage.sent[0]?.to, "+15550002222");
  assert.match(imessage.sent[0]?.text ?? "", /Nothing new cleared the cutoff today/);
});

test("check-feedback with the loop on but no candidate address fails loudly", async () => {
  const h = await harness({ shivani: {} });
  assert.equal(await h.run(["check-feedback", "--profile", "shivani"], { env: { FEEDBACK_LOOP_ENABLED: "true" } }), 1);
  assert.match(h.err.join("\n"), /DIGEST_EMAIL_TO is not set/);
});

test("enrich-contact links her phone and tags the profile once, then leaves the contact alone", async () => {
  const h = await harness({ shivani: {} });
  const contact: Contact = {
    id: "contact-1",
    preferredName: "Candidate",
    emails: [{ value: "candidate@example.test" }],
    phones: [],
    customFields: [],
    notes: null,
  };
  const contacts = new FakeContactClient([contact]);
  const env = { DIGEST_EMAIL_TO: "candidate@example.test", DIGEST_IMESSAGE_TO: "+15550002222" };

  assert.equal(await h.run(["enrich-contact", "--profile", "shivani"], { env, clients: { contacts: () => contacts } }), 0);
  assert.equal(contacts.updates.length, 1);
  assert.deepEqual(contacts.updates[0]?.patch.phones, [{ valueE164: "+15550002222", label: "mobile", isPrimary: true }]);
  assert.deepEqual(contacts.updates[0]?.patch.customFields, [{ label: "moby-role", value: "job-search-candidate:shivani" }]);

  assert.equal(await h.run(["enrich-contact", "--profile", "shivani"], { env, clients: { contacts: () => contacts } }), 0);
  assert.equal(contacts.updates.length, 1);
  assert.match(h.out.join("\n"), /already up to date/);
});

test("reconcile with nothing previously filtered writes nothing", async () => {
  const h = await harness({ shivani: {} });
  assert.equal(await h.run(["reconcile", "--profile", "shivani"]), 0);
  assert.match(h.out.join("\n"), /None now pass/);
});

test("costs reads the shared ledger, grouping entries by run", async () => {
  const h = await harness();
  assert.equal(await h.run(["costs"]), 0);
  assert.deepEqual(h.out, ["No model spend recorded yet."]);

  await mkdir(join(h.root, "logs"), { recursive: true });
  const entry = (runId: string, costUsd: number, ts: string): string =>
    JSON.stringify({ runId, ts, stage: "score", model: "m", inputTokens: 1, outputTokens: 1, cacheRead: 0, costUsd });
  await writeFile(
    join(h.root, "logs/costs.jsonl"),
    [entry("run-aaaa-1", 0.01, "2026-09-20T10:00:00.000Z"), entry("run-aaaa-1", 0.02, "2026-09-20T10:01:00.000Z"), entry("run-bbbb-2", 0.5, "2026-09-21T10:00:00.000Z")].join("\n") + "\n",
    "utf8",
  );

  h.out.length = 0;
  assert.equal(await h.run(["costs"]), 0);
  assert.equal(h.out.at(-1), "2 run(s), $0.53 total.");
});
