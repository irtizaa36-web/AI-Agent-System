import { test } from "node:test";
import assert from "node:assert/strict";
import { createInkboxClientFromEnv, createRealInkboxClient, parseRawMessage, parseRawThread } from "./real-client";
import { InMemoryDraftStore } from "./draft-store";

type FetchHandler = (url: string, init: RequestInit | undefined) => Response | Promise<Response>;

async function withFetch<T>(handler: FetchHandler, fn: () => Promise<T>): Promise<T> {
  const original = globalThis.fetch;
  const calls: { url: string; init: RequestInit | undefined }[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    calls.push({ url, init });
    return handler(url, init);
  }) as typeof fetch;
  (fn as unknown as { calls?: typeof calls }).calls = calls;
  try {
    return await fn();
  } finally {
    globalThis.fetch = original;
  }
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function noBodyResponse(status: number): Response {
  return new Response(null, { status });
}

// ---- pure parsing ----

test("parseRawMessage prefers body_text, falls back to stripped body_html, then snippet", () => {
  const base = { id: "m1", thread_id: "t1", from_address: "a@b.com", to_addresses: ["c@d.com"], subject: "Hi", created_at: "2026-01-01T00:00:00.000Z" };

  assert.equal(parseRawMessage({ ...base, body_text: "plain text", body_html: "<p>html</p>", snippet: "snip" }).body, "plain text");
  assert.equal(parseRawMessage({ ...base, body_html: "<p>hello <b>world</b></p>", snippet: "snip" }).body, "hello world");
  assert.equal(parseRawMessage({ ...base, snippet: "just a snippet" }).body, "just a snippet");
  assert.equal(parseRawMessage({ ...base }).body, "");
});

test("parseRawMessage falls back to the message's own id as threadId when thread_id is null", () => {
  const message = parseRawMessage({
    id: "m1",
    thread_id: null,
    from_address: "a@b.com",
    to_addresses: ["c@d.com"],
    subject: "Hi",
    created_at: "2026-01-01T00:00:00.000Z",
  });
  assert.equal(message.threadId, "m1");
});

test("parseRawThread carries the resolved subject and the already-parsed messages through unchanged", () => {
  const thread = parseRawThread({ id: "t1", subject: null }, [
    { id: "m1", threadId: "t1", from: { address: "a@b.com" }, to: [], subject: "", body: "", receivedAt: "2026-01-01T00:00:00.000Z" },
  ]);
  assert.equal(thread.id, "t1");
  assert.equal(thread.subject, "");
  assert.equal(thread.messages.length, 1);
});

// ---- network-backed methods, fetch stubbed ----

function rawMessage(overrides: Record<string, unknown> = {}) {
  return {
    id: "m1",
    thread_id: "t1",
    from_address: "customer@example.com",
    to_addresses: ["toozy@inkboxmail.com"],
    subject: "Hello",
    body_text: "Hi there",
    created_at: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

test("searchMail with no query lists messages", async () => {
  await withFetch(
    (url) => {
      assert.match(url, /\/mailboxes\/toozy%40inkboxmail\.com\/messages\?limit=50/);
      return jsonResponse(200, { items: [rawMessage()], next_cursor: null, has_more: false });
    },
    async () => {
      const client = createRealInkboxClient({ apiKey: "key", mailboxAddress: "toozy@inkboxmail.com" });
      const messages = await client.searchMail();
      assert.equal(messages.length, 1);
      assert.equal(messages[0]?.id, "m1");
    },
  );
});

test("searchMail with a query hits the search endpoint", async () => {
  await withFetch(
    (url) => {
      assert.match(url, /\/mailboxes\/toozy%40inkboxmail\.com\/search\?q=brunch&limit=50/);
      return jsonResponse(200, { items: [], next_cursor: null, has_more: false });
    },
    async () => {
      const client = createRealInkboxClient({ apiKey: "key", mailboxAddress: "toozy@inkboxmail.com" });
      await client.searchMail("brunch");
    },
  );
});

test("getMessage returns the parsed message on success", async () => {
  await withFetch(
    () => jsonResponse(200, rawMessage()),
    async () => {
      const client = createRealInkboxClient({ apiKey: "key", mailboxAddress: "toozy@inkboxmail.com" });
      const message = await client.getMessage("m1");
      assert.equal(message?.subject, "Hello");
    },
  );
});

test("getMessage returns undefined for a 404", async () => {
  await withFetch(
    () => jsonResponse(404, { detail: "not found" }),
    async () => {
      const client = createRealInkboxClient({ apiKey: "key", mailboxAddress: "toozy@inkboxmail.com" });
      assert.equal(await client.getMessage("missing"), undefined);
    },
  );
});

test("getMessage throws InkboxAPIError for a non-404 failure", async () => {
  await withFetch(
    () => jsonResponse(500, { detail: "internal error" }),
    async () => {
      const client = createRealInkboxClient({ apiKey: "key", mailboxAddress: "toozy@inkboxmail.com" });
      await assert.rejects(() => client.getMessage("m1"), /HTTP 500/);
    },
  );
});

test("readThread enriches snippet-level messages with full detail, and returns undefined for a 404", async () => {
  await withFetch(
    (url) => {
      if (url.includes("/threads/")) {
        return jsonResponse(200, {
          id: "t1",
          subject: "Booking",
          messages: [{ id: "m1", thread_id: "t1", from_address: "customer@example.com", to_addresses: ["toozy@inkboxmail.com"], subject: "Booking", snippet: "preview only", created_at: "2026-01-01T00:00:00.000Z" }],
        });
      }
      return jsonResponse(200, rawMessage({ id: "m1", body_text: "the full reply body" }));
    },
    async () => {
      const client = createRealInkboxClient({ apiKey: "key", mailboxAddress: "toozy@inkboxmail.com" });
      const thread = await client.readThread("t1");
      assert.equal(thread?.messages[0]?.body, "the full reply body");
    },
  );

  await withFetch(
    () => jsonResponse(404, { detail: "not found" }),
    async () => {
      const client = createRealInkboxClient({ apiKey: "key", mailboxAddress: "toozy@inkboxmail.com" });
      assert.equal(await client.readThread("missing"), undefined);
    },
  );
});

test("saveDraft/getDraft delegate to the configured DraftStore, never touching the network", async () => {
  const draftStore = new InMemoryDraftStore();
  await withFetch(
    () => {
      throw new Error("fetch should not be called for draft operations");
    },
    async () => {
      const client = createRealInkboxClient({ apiKey: "key", mailboxAddress: "toozy@inkboxmail.com", draftStore });
      const draft = await client.saveDraft({ to: [{ address: "a@b.com" }], subject: "s", body: "b" });
      assert.equal(draft.revision, "rev-1");
      const fetched = await client.getDraft(draft.id);
      assert.deepEqual(fetched, draft);
    },
  );
});

test("send rejects a stale revision without ever calling the network", async () => {
  const draftStore = new InMemoryDraftStore();
  await withFetch(
    () => {
      throw new Error("fetch should not be called for a stale revision");
    },
    async () => {
      const client = createRealInkboxClient({ apiKey: "key", mailboxAddress: "toozy@inkboxmail.com", draftStore });
      const draft = await client.saveDraft({ to: [{ address: "a@b.com" }], subject: "s", body: "b" });
      await assert.rejects(() => client.send({ draftId: draft.id, revision: "rev-0" }), /has changed since this send was prepared/);
    },
  );
});

test("send rejects an unknown draft id", async () => {
  const client = createRealInkboxClient({ apiKey: "key", mailboxAddress: "toozy@inkboxmail.com", draftStore: new InMemoryDraftStore() });
  await assert.rejects(() => client.send({ draftId: "nope", revision: "rev-1" }), /No draft "nope"/);
});

test("send posts the draft to Inkbox and returns the delivered SendResult", async () => {
  const draftStore = new InMemoryDraftStore();
  let capturedBody: unknown;
  await withFetch(
    (url, init) => {
      assert.match(url, /\/mailboxes\/toozy%40inkboxmail\.com\/messages$/);
      assert.equal(init?.method, "POST");
      capturedBody = JSON.parse(init?.body as string);
      return jsonResponse(200, rawMessage({ id: "sent-1", thread_id: "t-sent" }));
    },
    async () => {
      const client = createRealInkboxClient({ apiKey: "key", mailboxAddress: "toozy@inkboxmail.com", draftStore });
      const draft = await client.saveDraft({ to: [{ address: "customer@example.com" }], bcc: [{ address: "owner@example.com" }], subject: "s", body: "b" });
      const result = await client.send({ draftId: draft.id, revision: draft.revision });
      assert.equal(result.messageId, "sent-1");
      assert.equal(result.threadId, "t-sent");
      assert.deepEqual(result.to, [{ address: "customer@example.com" }]);
      assert.deepEqual(result.bcc, [{ address: "owner@example.com" }]);
    },
  );
  assert.deepEqual((capturedBody as { recipients: { to: string[]; bcc: string[] } }).recipients, {
    to: ["customer@example.com"],
    bcc: ["owner@example.com"],
  });
});

test("forward returns skipped when the original message can't be found, without posting anything", async () => {
  await withFetch(
    () => jsonResponse(404, { detail: "not found" }),
    async () => {
      const client = createRealInkboxClient({ apiKey: "key", mailboxAddress: "toozy@inkboxmail.com" });
      const result = await client.forward("missing", { address: "owner@example.com" });
      assert.equal(result.status, "skipped");
      assert.match(result.reason ?? "", /not found/);
    },
  );
});

test("forward fetches the original message then posts a prefixed copy to the forward target", async () => {
  let postBody: { subject?: string; body_text?: string; recipients?: { to: string[] } } | undefined;
  await withFetch(
    (url, init) => {
      if (init?.method === "POST") {
        postBody = JSON.parse(init.body as string);
        return jsonResponse(200, rawMessage({ id: "fwd-1" }));
      }
      return jsonResponse(200, rawMessage({ subject: "Original subject", body_text: "original body text" }));
    },
    async () => {
      const client = createRealInkboxClient({ apiKey: "key", mailboxAddress: "toozy@inkboxmail.com" });
      const result = await client.forward("m1", { address: "owner@example.com" });
      assert.equal(result.status, "forwarded");
    },
  );
  assert.equal(postBody?.recipients?.to?.[0], "owner@example.com");
  assert.match(postBody?.subject ?? "", /^Fwd: Original subject$/);
  assert.match(postBody?.body_text ?? "", /original body text/);
});

test("noBodyResponse helper is exercised for completeness of the 204 path", async () => {
  // send() never receives a 204 in practice, but the shared request() helper does handle it —
  // exercised here directly against getMessage's error path plumbing being unaffected by it.
  await withFetch(
    () => noBodyResponse(204),
    async () => {
      const client = createRealInkboxClient({ apiKey: "key", mailboxAddress: "toozy@inkboxmail.com" });
      const message = await client.getMessage("m1");
      assert.equal(message, undefined);
    },
  );
});

// ---- env-based factory ----

function withEnv(vars: Record<string, string | undefined>, fn: () => void): void {
  const originals: Record<string, string | undefined> = {};
  for (const key of Object.keys(vars)) {
    originals[key] = process.env[key];
    if (vars[key] === undefined) delete process.env[key];
    else process.env[key] = vars[key];
  }
  try {
    fn();
  } finally {
    for (const key of Object.keys(vars)) {
      if (originals[key] === undefined) delete process.env[key];
      else process.env[key] = originals[key];
    }
  }
}

test("createInkboxClientFromEnv returns undefined when INKBOX_API_KEY is missing", () => {
  withEnv({ INKBOX_API_KEY: undefined, INKBOX_MAILBOX_ADDRESS: "toozy@inkboxmail.com" }, () => {
    assert.equal(createInkboxClientFromEnv(), undefined);
  });
});

test("createInkboxClientFromEnv returns undefined when INKBOX_MAILBOX_ADDRESS is missing", () => {
  withEnv({ INKBOX_API_KEY: "key", INKBOX_MAILBOX_ADDRESS: undefined }, () => {
    assert.equal(createInkboxClientFromEnv(), undefined);
  });
});

test("createInkboxClientFromEnv builds a real client once both are set", () => {
  withEnv({ INKBOX_API_KEY: "key", INKBOX_MAILBOX_ADDRESS: "toozy@inkboxmail.com" }, () => {
    const client = createInkboxClientFromEnv();
    assert.equal(client?.mailboxAddress, "toozy@inkboxmail.com");
  });
});
