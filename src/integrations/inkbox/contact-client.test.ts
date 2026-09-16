import { test } from "node:test";
import assert from "node:assert/strict";
import { FakeContactClient, InkboxContactApiError, createContactClientFromEnv, type Contact } from "./contact-client";

function contact(overrides: Partial<Contact> = {}): Contact {
  return {
    id: "c1",
    preferredName: "Shivani Bangalore",
    emails: [{ value: "brshivani@gmail.com", isPrimary: true }],
    phones: [],
    customFields: [],
    notes: null,
    ...overrides,
  };
}

test("FakeContactClient.lookup finds a seeded contact by exact email, case-insensitively", async () => {
  const client = new FakeContactClient([contact()]);
  const found = await client.lookup({ email: "BrShivani@Gmail.com" });
  assert.equal(found.length, 1);
  assert.equal(found[0]?.id, "c1");
});

test("FakeContactClient.lookup returns an empty array on no match, never throws or guesses", async () => {
  const client = new FakeContactClient([contact()]);
  assert.deepEqual(await client.lookup({ email: "nobody@example.com" }), []);
});

test("FakeContactClient.lookup finds a seeded contact by phone", async () => {
  const client = new FakeContactClient([contact({ phones: [{ valueE164: "+12144023994", isPrimary: true }] })]);
  const found = await client.lookup({ phone: "+12144023994" });
  assert.equal(found.length, 1);
});

test("FakeContactClient.update replaces only the fields in the patch, leaving the rest untouched", async () => {
  const client = new FakeContactClient([contact()]);
  const updated = await client.update("c1", { phones: [{ valueE164: "+12144023994", isPrimary: true }] });
  assert.equal(updated.preferredName, "Shivani Bangalore", "untouched field survives");
  assert.deepEqual(updated.phones, [{ valueE164: "+12144023994", isPrimary: true }]);
  assert.equal(client.updates.length, 1);
  assert.equal(client.updates[0]?.contactId, "c1");
});

test("FakeContactClient.update on an unknown contact id throws rather than silently no-op", async () => {
  const client = new FakeContactClient([contact()]);
  await assert.rejects(() => client.update("does-not-exist", { notes: "x" }), InkboxContactApiError);
});

test("FakeContactClient.merge combines the losing contact's identifiers onto the survivor and removes the losing record", async () => {
  const survivor = contact({ id: "survivor", preferredName: "Shivani Bangalore", emails: [{ value: "brshivani@gmail.com", isPrimary: true }], phones: [] });
  const losing = contact({ id: "losing", preferredName: null, emails: [], phones: [{ valueE164: "+12144023994", isPrimary: true }] });
  const client = new FakeContactClient([survivor, losing]);

  const merged = await client.merge("survivor", ["losing"]);

  assert.equal(merged.preferredName, "Shivani Bangalore", "survivor's own name wins over the losing contact's null");
  assert.deepEqual(merged.phones, [{ valueE164: "+12144023994", isPrimary: true }], "phone absorbed from the losing contact");
  assert.deepEqual(await client.lookup({ phone: "+12144023994" }), [merged], "a lookup by the absorbed phone now finds the survivor");
});

test("FakeContactClient.merge throws on an unknown survivor or losing id rather than silently no-op", async () => {
  const client = new FakeContactClient([contact({ id: "survivor" })]);
  await assert.rejects(() => client.merge("does-not-exist", ["also-missing"]), InkboxContactApiError);
  await assert.rejects(() => client.merge("survivor", ["also-missing"]), InkboxContactApiError);
});

test("createContactClientFromEnv returns undefined without INKBOX_API_KEY — never a half-configured client", () => {
  const original = process.env["INKBOX_API_KEY"];
  try {
    delete process.env["INKBOX_API_KEY"];
    assert.equal(createContactClientFromEnv(), undefined);
  } finally {
    if (original === undefined) delete process.env["INKBOX_API_KEY"];
    else process.env["INKBOX_API_KEY"] = original;
  }
});

test("createContactClientFromEnv returns a real client once INKBOX_API_KEY is present", () => {
  const original = process.env["INKBOX_API_KEY"];
  try {
    process.env["INKBOX_API_KEY"] = "test-key";
    assert.notEqual(createContactClientFromEnv(), undefined);
  } finally {
    if (original === undefined) delete process.env["INKBOX_API_KEY"];
    else process.env["INKBOX_API_KEY"] = original;
  }
});
