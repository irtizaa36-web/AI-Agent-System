import { test } from "node:test";
import assert from "node:assert/strict";
import { FakeInkboxClient } from "./fake-client";

test("saveDraft creates a draft with a revision, then bumps the revision on update", async () => {
  const client = new FakeInkboxClient("agent@example.test");

  const first = await client.saveDraft({ to: [{ address: "a@b.com" }], subject: "Hi", body: "First" });
  const second = await client.saveDraft({
    draftId: first.id,
    to: [{ address: "a@b.com" }],
    subject: "Hi",
    body: "Updated",
  });

  assert.notEqual(first.revision, second.revision);
  assert.equal((await client.getDraft(first.id))?.body, "Updated");
});

test("send rejects a stale revision and succeeds with the current one", async () => {
  const client = new FakeInkboxClient("agent@example.test");
  const draft = await client.saveDraft({ to: [{ address: "a@b.com" }], subject: "Hi", body: "Body" });
  const updated = await client.saveDraft({ draftId: draft.id, to: [{ address: "a@b.com" }], subject: "Hi", body: "Body2" });

  await assert.rejects(() => client.send({ draftId: draft.id, revision: draft.revision }), /has changed/);

  const result = await client.send({ draftId: draft.id, revision: updated.revision });
  assert.equal(result.to[0]?.address, "a@b.com");
  assert.ok(result.messageId);
  assert.ok(result.threadId);
});

test("send records the sent message so the thread can be read back", async () => {
  const client = new FakeInkboxClient("agent@example.test");
  const draft = await client.saveDraft({ to: [{ address: "a@b.com" }], subject: "Hi", body: "Body" });

  const result = await client.send({ draftId: draft.id, revision: draft.revision });
  const thread = await client.readThread(result.threadId);

  assert.equal(thread?.messages.length, 1);
  assert.equal(thread?.messages[0]?.from.address, "agent@example.test");
});

test("searchMail filters by subject/body/sender, case-insensitively", async () => {
  const client = new FakeInkboxClient("agent@example.test", [
    {
      id: "m1",
      threadId: "t1",
      from: { address: "restaurant@example.com" },
      to: [{ address: "agent@example.test" }],
      subject: "RE: Reservation for 13",
      body: "We can offer 7pm.",
      receivedAt: new Date().toISOString(),
    },
  ]);

  assert.equal((await client.searchMail("reservation")).length, 1);
  assert.equal((await client.searchMail("nonexistent")).length, 0);
});

test("forward reports skipped for an unknown message id", async () => {
  const client = new FakeInkboxClient("agent@example.test");
  const result = await client.forward("nope", { address: "owner@example.com" });
  assert.equal(result.status, "skipped");
});
