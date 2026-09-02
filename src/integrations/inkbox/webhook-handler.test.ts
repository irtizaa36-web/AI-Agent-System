import { test } from "node:test";
import assert from "node:assert/strict";
import { createTask } from "../../core/task";
import { startRun } from "../../core/orchestrator";
import type { Run } from "../../core/run";
import type { AgentDefinition } from "../../core/agent";
import { Registry } from "../../registry/registry";
import { InMemoryRunStore } from "../../store/run-store";
import { FakeProvider } from "../../providers/fake";
import { FakeInkboxClient } from "./fake-client";
import { InMemoryForwardingLog } from "./forwarding-log";
import { InMemoryMessageEventLog } from "./message-event-log";
import { handleInkboxWebhookEvent, type WebhookHandlerDeps } from "./webhook-handler";
import type { InkboxClient, ForwardResult, EmailAddress } from "./client";

const MAILBOX = "toozy@example.test";

function withOwnerEnv(value: string | undefined, fn: () => Promise<void>): Promise<void> {
  const original = process.env["OWNER_FORWARD_EMAIL"];
  if (value === undefined) delete process.env["OWNER_FORWARD_EMAIL"];
  else process.env["OWNER_FORWARD_EMAIL"] = value;
  return fn().finally(() => {
    if (original === undefined) delete process.env["OWNER_FORWARD_EMAIL"];
    else process.env["OWNER_FORWARD_EMAIL"] = original;
  });
}

const testAgent: AgentDefinition = {
  name: "test-agent",
  providerName: "fake",
  model: "n/a",
  systemPrompt: "You are a test agent.",
  toolNames: [],
};

function buildDeps(overrides: Partial<WebhookHandlerDeps> = {}): WebhookHandlerDeps {
  const registry = new Registry();
  registry.registerProvider(new FakeProvider([{ content: "Got it, thanks!", toolCalls: [], stopReason: "end_turn" }]));
  registry.registerAgent(testAgent);

  return {
    inkboxClient: new FakeInkboxClient(MAILBOX),
    forwardingLog: new InMemoryForwardingLog(),
    messageEventLog: new InMemoryMessageEventLog(),
    registry,
    store: new InMemoryRunStore(),
    ...overrides,
  };
}

function receivedMessageData(overrides: Record<string, unknown> = {}) {
  return {
    id: "msg-1",
    thread_id: "thread-1",
    from_address: "restaurant@example.com",
    to_addresses: [MAILBOX],
    subject: "Re: booking",
    body_text: "Yes, we have a table for 4 at 7pm.",
    created_at: new Date().toISOString(),
    ...overrides,
  };
}

test("message.received forwards a new inbound message to the owner exactly once", async () => {
  await withOwnerEnv("owner@example.com", async () => {
    const client = new FakeInkboxClient(MAILBOX);
    client.receiveInbound({
      id: "msg-1",
      threadId: "thread-1",
      from: { address: "restaurant@example.com" },
      to: [{ address: MAILBOX }],
      subject: "Re: booking",
      body: "Yes, we have a table for 4 at 7pm.",
      receivedAt: new Date().toISOString(),
    });
    const deps = buildDeps({ inkboxClient: client });

    const result = await handleInkboxWebhookEvent({ event: "message.received", data: receivedMessageData() }, deps);

    assert.match(result.actions.join(" | "), /forwarded to owner \(forwarded\)/);
    assert.equal(await deps.forwardingLog.hasForwarded("msg-1"), true);
  });
});

test("message.received skips forwarding a second time for the same message id (no duplicate forward)", async () => {
  await withOwnerEnv("owner@example.com", async () => {
    const forwardingLog = new InMemoryForwardingLog();
    await forwardingLog.record({ messageId: "msg-1", forwardedTo: "owner@example.com", status: "forwarded", occurredAt: new Date().toISOString() });
    const deps = buildDeps({ forwardingLog });

    const result = await handleInkboxWebhookEvent({ event: "message.received", data: receivedMessageData() }, deps);

    assert.match(result.actions.join(" | "), /already forwarded/);
  });
});

test("message.received skips forwarding when OWNER_FORWARD_EMAIL is not configured", async () => {
  await withOwnerEnv(undefined, async () => {
    const deps = buildDeps();
    const result = await handleInkboxWebhookEvent({ event: "message.received", data: receivedMessageData() }, deps);
    assert.match(result.actions.join(" | "), /forwarding skipped/);
    assert.equal(await deps.forwardingLog.hasForwarded("msg-1"), false);
  });
});

test("message.received records a forwarding failure distinctly, without affecting the original message", async () => {
  await withOwnerEnv("owner@example.com", async () => {
    const failingClient: InkboxClient = {
      mailboxAddress: MAILBOX,
      async searchMail() {
        return [];
      },
      async readThread() {
        return undefined;
      },
      async getMessage() {
        return undefined;
      },
      async saveDraft() {
        throw new Error("not used in this test");
      },
      async getDraft() {
        return undefined;
      },
      async send() {
        throw new Error("not used in this test");
      },
      async forward(_messageId: string, _to: EmailAddress): Promise<ForwardResult> {
        throw new Error("simulated Inkbox outage");
      },
    };
    const deps = buildDeps({ inkboxClient: failingClient });

    const result = await handleInkboxWebhookEvent({ event: "message.received", data: receivedMessageData() }, deps);

    assert.match(result.actions.join(" | "), /forwarding failed: simulated Inkbox outage/);
    const records = await deps.forwardingLog.list();
    assert.equal(records[0]?.status, "failed");
    // The event handler itself never throws — a forwarding failure must never look like the original message failed.
    assert.equal(result.event, "message.received");
  });
});

test("message.received resumes the matching waiting_for_response run by thread id", async () => {
  await withOwnerEnv(undefined, async () => {
    const deps = buildDeps();
    const run: Run = {
      ...startRun(createTask("book a table"), testAgent, "run-1"),
      status: "waiting_for_response",
      threadId: "thread-1",
    };
    await deps.store.save(run);

    const result = await handleInkboxWebhookEvent({ event: "message.received", data: receivedMessageData() }, deps);

    assert.match(result.actions.join(" | "), /resumed run "run-1" \(now "succeeded"\)/);
    const updated = await deps.store.load("run-1");
    assert.equal(updated?.status, "succeeded");
    assert.match(updated?.session.messages.map((m) => m.content).join("\n") ?? "", /Yes, we have a table for 4 at 7pm\./);
  });
});

test("message.received does nothing extra when no run is waiting on that thread", async () => {
  await withOwnerEnv(undefined, async () => {
    const deps = buildDeps();
    const result = await handleInkboxWebhookEvent({ event: "message.received", data: receivedMessageData() }, deps);
    assert.match(result.actions.join(" | "), /no waiting run matched this thread/);
  });
});

test("message.received ignores a payload with no recognizable message rather than throwing", async () => {
  const deps = buildDeps();
  const result = await handleInkboxWebhookEvent({ event: "message.received", data: { subject: "no id or sender here" } }, deps);
  assert.match(result.actions.join(" | "), /did not contain a recognizable message/);
});

for (const [event, expectedLifecycle] of [
  ["message.sent", "sent"],
  ["message.delivered", "delivered"],
  ["message.bounced", "bounced"],
  ["message.failed", "failed"],
  ["message.forwarded", "forwarded_confirmation"],
] as const) {
  test(`${event} records a "${expectedLifecycle}" lifecycle entry`, async () => {
    const deps = buildDeps();
    const result = await handleInkboxWebhookEvent({ event, data: { id: "msg-9", reason: "some detail" } }, deps);

    const records = await deps.messageEventLog.list();
    assert.equal(records.length, 1);
    assert.equal(records[0]?.messageId, "msg-9");
    assert.equal(records[0]?.event, expectedLifecycle);
    assert.equal(records[0]?.detail, "some detail");
    assert.equal(result.event, event);
  });
}

test("a lifecycle event with no message id is not recorded, but does not throw", async () => {
  const deps = buildDeps();
  const result = await handleInkboxWebhookEvent({ event: "message.bounced", data: {} }, deps);
  assert.deepEqual(await deps.messageEventLog.list(), []);
  assert.match(result.actions.join(" | "), /had no message id/);
});
