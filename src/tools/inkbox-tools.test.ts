import { test } from "node:test";
import assert from "node:assert/strict";
import { FakeInkboxClient } from "../integrations/inkbox/fake-client";
import { createInkboxSearchMailTool } from "./inkbox-search-mail";
import { createInkboxReadThreadTool } from "./inkbox-read-thread";
import { createInkboxSaveDraftTool } from "./inkbox-save-draft";
import { createSendEmailTool } from "./send-email";

function withOwnerEnv(value: string | undefined, fn: () => Promise<void>): Promise<void> {
  const original = process.env["OWNER_FORWARD_EMAIL"];
  if (value === undefined) delete process.env["OWNER_FORWARD_EMAIL"];
  else process.env["OWNER_FORWARD_EMAIL"] = value;
  return fn().finally(() => {
    if (original === undefined) delete process.env["OWNER_FORWARD_EMAIL"];
    else process.env["OWNER_FORWARD_EMAIL"] = original;
  });
}

test("send-email is marked requiresApproval; inkbox-save-draft is not", () => {
  const client = new FakeInkboxClient();
  assert.equal(createSendEmailTool(client).requiresApproval, true);
  assert.equal(createInkboxSaveDraftTool(client).requiresApproval, false);
});

test("inkbox-save-draft saves a draft with no owner BCC while forwarding is disabled", async () => {
  await withOwnerEnv(undefined, async () => {
    const client = new FakeInkboxClient("agent@example.test");
    const tool = createInkboxSaveDraftTool(client);

    const output = await tool.execute({
      to: [{ address: "restaurant@example.com" }],
      subject: "Reservation for 13",
      body: "Hello, we'd like a table for 13 on a Friday evening.",
    });

    assert.match(output, /bcc:\(none\)/);
  });
});

test("inkbox-save-draft rejects a `to` entry with no address, rather than crashing inside computeOutboundBcc", async () => {
  const client = new FakeInkboxClient("agent@example.test");
  const tool = createInkboxSaveDraftTool(client);

  await assert.rejects(
    () => Promise.resolve(tool.execute({ to: [{ name: "Dr. Motazedi" }], subject: "Hi", body: "..." })),
    /requires \{ "to": \[\{"address": string\}/,
  );
});

test("send-email rejects a `to` entry with no address, rather than crashing", async () => {
  const client = new FakeInkboxClient("agent@example.test");
  const tool = createSendEmailTool(client);

  await assert.rejects(
    () =>
      Promise.resolve(
        tool.execute({ to: [{ name: "Dr. Motazedi" }], subject: "Hi", body: "...", bcc: [], draftId: "d1", revision: "r1" }),
      ),
    /send-email requires/,
  );
});

test("inkbox-save-draft includes the owner BCC once forwarding is configured", async () => {
  await withOwnerEnv("owner@example.com", async () => {
    const client = new FakeInkboxClient("agent@example.test");
    const tool = createInkboxSaveDraftTool(client);

    const output = await tool.execute({
      to: [{ address: "restaurant@example.com" }],
      subject: "Reservation for 13",
      body: "Hello.",
    });

    assert.match(output, /bcc:owner@example\.com/);
  });
});

test("send-email rejects when the approved fields no longer match the live draft", async () => {
  const client = new FakeInkboxClient("agent@example.test");
  const draft = await client.saveDraft({ to: [{ address: "r@example.com" }], subject: "Hi", body: "Body" });
  await client.saveDraft({ draftId: draft.id, to: [{ address: "r@example.com" }], subject: "Hi", body: "Changed!" });

  const tool = createSendEmailTool(client);

  await assert.rejects(
    () =>
      Promise.resolve(
        tool.execute({
          to: [{ address: "r@example.com" }],
          subject: "Hi",
          body: "Body", // stale — the live draft now says "Changed!"
          bcc: [],
          draftId: draft.id,
          revision: draft.revision,
        }),
      ),
    /no longer matches what was approved/,
  );
});

test("send-email succeeds when every field matches the live draft exactly", async () => {
  const client = new FakeInkboxClient("agent@example.test");
  const draft = await client.saveDraft({ to: [{ address: "r@example.com" }], subject: "Hi", body: "Body" });
  const tool = createSendEmailTool(client);

  const output = await tool.execute({
    to: draft.to,
    subject: draft.subject,
    body: draft.body,
    bcc: draft.bcc ?? [],
    draftId: draft.id,
    revision: draft.revision,
  });

  assert.match(output, /sent:true/);
  assert.match(output, /^threadId:\S+$/m);
});

test("inkbox-search-mail and inkbox-read-thread read back a sent message", async () => {
  const client = new FakeInkboxClient("agent@example.test");
  const draft = await client.saveDraft({ to: [{ address: "r@example.com" }], subject: "Reservation", body: "Body" });
  const sendTool = createSendEmailTool(client);
  const sendOutput = await sendTool.execute({
    to: draft.to,
    subject: draft.subject,
    body: draft.body,
    bcc: draft.bcc ?? [],
    draftId: draft.id,
    revision: draft.revision,
  });
  const threadId = sendOutput.match(/^threadId:(\S+)$/m)?.[1];

  const searchOutput = await createInkboxSearchMailTool(client).execute({ query: "Reservation" });
  assert.match(searchOutput, /subject:Reservation/);

  const threadOutput = await createInkboxReadThreadTool(client).execute({ threadId });
  assert.match(threadOutput, /Body/);
});
