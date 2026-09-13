import { test } from "node:test";
import assert from "node:assert/strict";
import { FakeSmsClient, SmsRecipientBlockedError, createSmsClientFromEnv } from "./sms-client";

test("FakeSmsClient records every send without touching the network", async () => {
  const client = new FakeSmsClient();
  await client.send("+15551234567", "3 new roles today.");

  assert.equal(client.sent.length, 1);
  assert.equal(client.sent[0]?.to, "+15551234567");
  assert.equal(client.sent[0]?.text, "3 new roles today.");
});

test("FakeSmsClient can simulate the recipient-blocked case for testing the caller's error handling", async () => {
  const client = new FakeSmsClient("blocked");
  await assert.rejects(() => client.send("+15551234567", "text"), SmsRecipientBlockedError);
  assert.equal(client.sent.length, 0, "a blocked send never gets recorded as sent");
});

test("createSmsClientFromEnv returns undefined when either required value is missing — never a half-configured client", () => {
  const original = { key: process.env["INKBOX_API_KEY"], id: process.env["INKBOX_SMS_PHONE_NUMBER_ID"] };
  try {
    delete process.env["INKBOX_API_KEY"];
    delete process.env["INKBOX_SMS_PHONE_NUMBER_ID"];
    assert.equal(createSmsClientFromEnv(), undefined);

    process.env["INKBOX_API_KEY"] = "test-key";
    assert.equal(createSmsClientFromEnv(), undefined, "phone number id still missing");
  } finally {
    if (original.key === undefined) delete process.env["INKBOX_API_KEY"];
    else process.env["INKBOX_API_KEY"] = original.key;
    if (original.id === undefined) delete process.env["INKBOX_SMS_PHONE_NUMBER_ID"];
    else process.env["INKBOX_SMS_PHONE_NUMBER_ID"] = original.id;
  }
});

test("createSmsClientFromEnv returns a real client once both values are present", () => {
  const original = { key: process.env["INKBOX_API_KEY"], id: process.env["INKBOX_SMS_PHONE_NUMBER_ID"] };
  try {
    process.env["INKBOX_API_KEY"] = "test-key";
    process.env["INKBOX_SMS_PHONE_NUMBER_ID"] = "test-number-id";
    assert.notEqual(createSmsClientFromEnv(), undefined);
  } finally {
    if (original.key === undefined) delete process.env["INKBOX_API_KEY"];
    else process.env["INKBOX_API_KEY"] = original.key;
    if (original.id === undefined) delete process.env["INKBOX_SMS_PHONE_NUMBER_ID"];
    else process.env["INKBOX_SMS_PHONE_NUMBER_ID"] = original.id;
  }
});
