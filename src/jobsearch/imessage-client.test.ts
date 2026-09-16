import { test } from "node:test";
import assert from "node:assert/strict";
import { FakeImessageClient, createImessageClientFromEnv, type ImessageMessage } from "./imessage-client";

test("FakeImessageClient records every send without touching the network", async () => {
  const client = new FakeImessageClient();
  await client.send("+12144023994", "bump the salary floor to 130k");

  assert.equal(client.sent.length, 1);
  assert.equal(client.sent[0]?.to, "+12144023994");
  assert.equal(client.sent[0]?.text, "bump the salary floor to 130k");
});

test("FakeImessageClient.listMessages returns whatever inbox it was seeded with", async () => {
  const seeded: ImessageMessage = {
    id: "m1",
    conversationId: "c1",
    direction: "inbound",
    remoteNumber: "+12144023994",
    content: "add Austin too",
    service: "imessage",
    isRead: false,
  };
  const client = new FakeImessageClient([seeded]);
  assert.deepEqual(await client.listMessages(), [seeded]);
});

test("createImessageClientFromEnv returns undefined when either required value is missing — never a half-configured client", () => {
  const original = { key: process.env["INKBOX_API_KEY"], id: process.env["INKBOX_IDENTITY_ID"] };
  try {
    delete process.env["INKBOX_API_KEY"];
    delete process.env["INKBOX_IDENTITY_ID"];
    assert.equal(createImessageClientFromEnv(), undefined);

    process.env["INKBOX_API_KEY"] = "test-key";
    assert.equal(createImessageClientFromEnv(), undefined, "identity id still missing");
  } finally {
    if (original.key === undefined) delete process.env["INKBOX_API_KEY"];
    else process.env["INKBOX_API_KEY"] = original.key;
    if (original.id === undefined) delete process.env["INKBOX_IDENTITY_ID"];
    else process.env["INKBOX_IDENTITY_ID"] = original.id;
  }
});

test("createImessageClientFromEnv returns a real client once both values are present", () => {
  const original = { key: process.env["INKBOX_API_KEY"], id: process.env["INKBOX_IDENTITY_ID"] };
  try {
    process.env["INKBOX_API_KEY"] = "test-key";
    process.env["INKBOX_IDENTITY_ID"] = "test-identity-id";
    assert.notEqual(createImessageClientFromEnv(), undefined);
  } finally {
    if (original.key === undefined) delete process.env["INKBOX_API_KEY"];
    else process.env["INKBOX_API_KEY"] = original.key;
    if (original.id === undefined) delete process.env["INKBOX_IDENTITY_ID"];
    else process.env["INKBOX_IDENTITY_ID"] = original.id;
  }
});
