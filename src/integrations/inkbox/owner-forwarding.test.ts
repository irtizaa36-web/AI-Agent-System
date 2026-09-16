import { test } from "node:test";
import assert from "node:assert/strict";
import { computeOutboundBcc, getOwnerForwardAddress, shouldForwardInbound } from "./owner-forwarding";

function withOwnerEnv(value: string | undefined, fn: () => void): void {
  const original = process.env["OWNER_FORWARD_EMAIL"];
  if (value === undefined) delete process.env["OWNER_FORWARD_EMAIL"];
  else process.env["OWNER_FORWARD_EMAIL"] = value;
  try {
    fn();
  } finally {
    if (original === undefined) delete process.env["OWNER_FORWARD_EMAIL"];
    else process.env["OWNER_FORWARD_EMAIL"] = original;
  }
}

test("getOwnerForwardAddress is undefined until explicitly configured", () => {
  withOwnerEnv(undefined, () => {
    assert.equal(getOwnerForwardAddress(), undefined);
  });
});

test("computeOutboundBcc does nothing when forwarding is disabled", () => {
  withOwnerEnv(undefined, () => {
    const bcc = computeOutboundBcc([{ address: "restaurant@example.com" }], [], "agent@example.test");
    assert.deepEqual(bcc, []);
  });
});

test("computeOutboundBcc appends the owner once enabled", () => {
  withOwnerEnv("owner@example.com", () => {
    const bcc = computeOutboundBcc([{ address: "restaurant@example.com" }], [], "agent@example.test");
    assert.deepEqual(bcc, [{ address: "owner@example.com" }]);
  });
});

test("computeOutboundBcc never duplicates the owner if already a direct recipient", () => {
  withOwnerEnv("owner@example.com", () => {
    const bcc = computeOutboundBcc([{ address: "owner@example.com" }], [], "agent@example.test");
    assert.deepEqual(bcc, []);
  });
});

test("computeOutboundBcc never duplicates the owner if already bcc'd", () => {
  withOwnerEnv("owner@example.com", () => {
    const bcc = computeOutboundBcc(
      [{ address: "restaurant@example.com" }],
      [{ address: "owner@example.com" }],
      "agent@example.test",
    );
    assert.deepEqual(bcc, [{ address: "owner@example.com" }]);
  });
});

test("computeOutboundBcc does not bcc the owner if the owner is the sending mailbox itself", () => {
  withOwnerEnv("agent@example.test", () => {
    const bcc = computeOutboundBcc([{ address: "restaurant@example.com" }], [], "agent@example.test");
    assert.deepEqual(bcc, []);
  });
});

test("shouldForwardInbound is false while forwarding is disabled", () => {
  withOwnerEnv(undefined, () => {
    assert.equal(shouldForwardInbound("restaurant@example.com", "agent@example.test").forward, false);
  });
});

test("shouldForwardInbound refuses to forward a message that came from the owner (loop prevention)", () => {
  withOwnerEnv("owner@example.com", () => {
    const result = shouldForwardInbound("owner@example.com", "agent@example.test");
    assert.equal(result.forward, false);
    assert.match(result.reason ?? "", /owner's own/);
  });
});

test("shouldForwardInbound refuses to re-forward our own outbound copy (already BCC'd at send time)", () => {
  withOwnerEnv("owner@example.com", () => {
    const result = shouldForwardInbound("agent@example.test", "agent@example.test");
    assert.equal(result.forward, false);
    assert.match(result.reason ?? "", /already BCC'd/);
  });
});

test("shouldForwardInbound allows forwarding any other sender once enabled", () => {
  withOwnerEnv("owner@example.com", () => {
    assert.equal(shouldForwardInbound("restaurant@example.com", "agent@example.test").forward, true);
  });
});

function withExcludeEnv(value: string | undefined, fn: () => void): void {
  const original = process.env["OWNER_FORWARD_EXCLUDE_RECIPIENTS"];
  if (value === undefined) delete process.env["OWNER_FORWARD_EXCLUDE_RECIPIENTS"];
  else process.env["OWNER_FORWARD_EXCLUDE_RECIPIENTS"] = value;
  try {
    fn();
  } finally {
    if (original === undefined) delete process.env["OWNER_FORWARD_EXCLUDE_RECIPIENTS"];
    else process.env["OWNER_FORWARD_EXCLUDE_RECIPIENTS"] = original;
  }
}

test("shouldForwardInbound refuses a message whose original recipient is on the excluded list, regardless of sender", () => {
  withOwnerEnv("owner@example.com", () => {
    withExcludeEnv("brshivani@gmail.com", () => {
      // Same shape as the real flood: Gmail's own forwarding preserves the
      // original To: header, so retail marketing addressed to Shivani looks
      // just as varied in sender as anything else — the recipient is the
      // only stable signal.
      const result = shouldForwardInbound("hello@emails.reebok.com", "agent@example.test", ["brshivani@gmail.com"]);
      assert.equal(result.forward, false);
      assert.match(result.reason ?? "", /brshivani@gmail\.com/);
      assert.match(result.reason ?? "", /excluded from owner-forwarding/);
    });
  });
});

test("shouldForwardInbound still forwards mail addressed to someone not on the excluded list", () => {
  withOwnerEnv("owner@example.com", () => {
    withExcludeEnv("brshivani@gmail.com", () => {
      const result = shouldForwardInbound("team@mercor.com", "agent@example.test", ["irtizaa36@gmail.com"]);
      assert.equal(result.forward, true);
    });
  });
});

test("shouldForwardInbound is unaffected by the exclude list when it's unset — existing behavior is a strict default", () => {
  withOwnerEnv("owner@example.com", () => {
    withExcludeEnv(undefined, () => {
      const result = shouldForwardInbound("hello@emails.reebok.com", "agent@example.test", ["brshivani@gmail.com"]);
      assert.equal(result.forward, true);
    });
  });
});

test("shouldForwardInbound defaults toAddresses to empty for callers that haven't been updated — never crashes, never wrongly excludes", () => {
  withOwnerEnv("owner@example.com", () => {
    withExcludeEnv("brshivani@gmail.com", () => {
      const result = shouldForwardInbound("hello@emails.reebok.com", "agent@example.test");
      assert.equal(result.forward, true);
    });
  });
});

test("the exclude match is case-insensitive, matching the rest of this module's address handling", () => {
  withOwnerEnv("owner@example.com", () => {
    withExcludeEnv("BrShivani@Gmail.com", () => {
      const result = shouldForwardInbound("hello@emails.reebok.com", "agent@example.test", ["brshivani@gmail.com"]);
      assert.equal(result.forward, false);
    });
  });
});
