import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
import { createVoiceDeps, type VoiceSwitches } from "../voice/deps";
import { JsonFileVoiceStateStore } from "../voice/store";
import { FakeVoiceReplyTransport } from "../voice/transport";
import { shellQuote } from "./voice-commands";

const REPLY = "15550100001.15550100002.aBcD1234@txt.voice.google.com";

async function harness(switches: VoiceSwitches) {
  const dir = await mkdtemp(join(tmpdir(), "voice-cli-"));
  const statePath = join(dir, "state.json");
  const transport = new FakeVoiceReplyTransport();
  const voice = createVoiceDeps({ store: new JsonFileVoiceStateStore(statePath), transport, switches, now: () => new Date("2026-09-26T15:00:00Z") });
  const stdout: string[] = [];
  const stderr: string[] = [];
  const deps: CliDeps = {
    registry: new Registry(),
    store: new InMemoryRunStore(),
    workflowStore: new InMemoryWorkflowStore(),
    cwd: dir,
    inkboxClient: new FakeInkboxClient(),
    forwardingLog: new InMemoryForwardingLog(),
    messageEventLog: new InMemoryMessageEventLog(),
    coworkerStore: new InMemoryCoworkerTaskStore(),
    agentStatusStore: new InMemoryAgentStatusStore(),
    recommendationStore: new InMemoryRecommendationStore(),
    voice,
    stdout: (line) => stdout.push(line),
    stderr: (line) => stderr.push(line),
  };
  const run = async (...args: string[]) => {
    stdout.length = 0;
    stderr.length = 0;
    const code = await runCli(["voice", ...args], deps);
    return { code, out: stdout.join("\n"), err: stderr.join("\n") };
  };
  let n = 0;
  const message = async (body: string, subject = "New text message from (555) 010-0001") => {
    n += 1;
    const file = join(dir, `m${n}.json`);
    await writeFile(file, JSON.stringify({ id: `m${n}`, threadId: `t${n}`, from: `"(555) 010-0001" <${REPLY}>`, subject, body, receivedAt: "2026-09-26T15:00:00Z" }));
    return file;
  };
  return { run, message, dir, statePath, transport, cleanup: () => rm(dir, { recursive: true, force: true }) };
}

const ON: VoiceSwitches = { codeBroker: true, replyDrafting: true, replySending: true };

test("voice status: everything reports off by default", async () => {
  const h = await harness({ codeBroker: false, replyDrafting: false, replySending: false });
  try {
    const r = await h.run("status");
    assert.equal(r.code, 0);
    assert.match(r.out, /code broker\s+off/);
    assert.match(r.out, /reply drafting\s+off/);
    assert.match(r.out, /reply sending\s+off/);
    const ingest = await h.run("ingest", "--file", await h.message("Is it still available?"));
    assert.match(ingest.out, /reply drafting is off/);
  } finally {
    await h.cleanup();
  }
});

test("voice ingest: a matched code is printed once and never lands in the state file", async () => {
  const h = await harness(ON);
  try {
    assert.equal((await h.run("start-verification", "google", "--purpose", "survey panel signup")).code, 0);
    const r = await h.run("ingest", "--file", await h.message("G-482913 is your Google verification code."));
    assert.equal(r.code, 0);
    assert.match(r.out, /verification code for google .*: 482913/);
    assert.equal((await readFile(h.statePath, "utf8")).includes("482913"), false);

    const unsolicited = await h.run("ingest", "--file", await h.message("Your Microsoft code is 90871234"));
    assert.match(unsolicited.out, /security alert for Toozy\. The code was NOT used/);
    assert.equal(unsolicited.out.includes("90871234"), false);
    const alerts = await h.run("alerts");
    assert.match(alerts.out, /no-pending-verification/);
    assert.equal(alerts.out.includes("90871234"), false);
  } finally {
    await h.cleanup();
  }
});

test("voice: X is refused for the Voice number", async () => {
  const h = await harness(ON);
  try {
    const r = await h.run("start-verification", "x", "--purpose", "signup");
    assert.equal(r.code, 1);
    assert.match(r.err, /real mobile/);
  } finally {
    await h.cleanup();
  }
});

test("voice: draft → exact-text approve (the printed command) → send", async () => {
  const h = await harness(ON);
  try {
    await h.run("listing-add", "couch", "--title", "grey couch", "--price", "$250", "--pickup", "Saturday 10am-2pm", "--area", "the library lot");
    const drafted = await h.run("ingest", "--file", await h.message("Is it still available? How much?"));
    assert.match(drafted.out, /reply drafted/);
    const body = "Hi! Yes, the grey couch is still available. It's $250.";
    assert.ok(drafted.out.includes(`--body ${shellQuote(body)}`), drafted.out);
    const id = drafted.out.match(/DRAFT (draft-[0-9a-f]+)/)![1];

    const early = await h.run("send", id);
    assert.equal(early.code, 1);
    assert.equal(h.transport.sent.length, 0);

    const wrong = await h.run("approve", id, "--revision", "1", "--body", "Hi! Yes it's available.");
    assert.equal(wrong.code, 1);
    assert.equal((await h.run("approve", id, "--revision", "1", "--body", body)).code, 0);
    const sent = await h.run("send", id);
    assert.equal(sent.code, 0, sent.err);
    assert.equal(h.transport.sent.length, 1);
    assert.equal(h.transport.sent[0].body, body);
  } finally {
    await h.cleanup();
  }
});

test("voice: a scam text is an alert with no draft", async () => {
  const h = await harness(ON);
  try {
    await h.run("listing-add", "couch", "--title", "grey couch", "--price", "250");
    const r = await h.run("ingest", "--file", await h.message("Can you ship it? I'm out of town, will pay by cashier's check"));
    assert.match(r.out, /possible scam\. No reply was drafted/);
    assert.match(r.out, /overpayment-scheme/);
    assert.match(r.out, /shipping-only-local/);
    assert.match((await h.run("drafts")).out, /No drafts/);
  } finally {
    await h.cleanup();
  }
});

test("shellQuote survives dollar signs and apostrophes", () => {
  assert.equal(shellQuote("It's $250"), `'It'\\''s $250'`);
});
