import { test } from "node:test";
import assert from "node:assert/strict";
import { getTunnelConfigFromEnv } from "./tunnel";

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
    for (const key of Object.keys(originals)) {
      if (originals[key] === undefined) delete process.env[key];
      else process.env[key] = originals[key];
    }
  }
}

test("getTunnelConfigFromEnv is undefined when INKBOX_API_KEY is missing", () => {
  withEnv({ INKBOX_API_KEY: undefined, INKBOX_TUNNEL_NAME: "toozy" }, () => {
    assert.equal(getTunnelConfigFromEnv("http://localhost:8787"), undefined);
  });
});

test("getTunnelConfigFromEnv is undefined when INKBOX_TUNNEL_NAME is missing", () => {
  withEnv({ INKBOX_API_KEY: "fake-key-for-test-only", INKBOX_TUNNEL_NAME: undefined }, () => {
    assert.equal(getTunnelConfigFromEnv("http://localhost:8787"), undefined);
  });
});

test("getTunnelConfigFromEnv returns the config once both are set", () => {
  withEnv({ INKBOX_API_KEY: "fake-key-for-test-only", INKBOX_TUNNEL_NAME: "toozy" }, () => {
    assert.deepEqual(getTunnelConfigFromEnv("http://localhost:8787"), {
      apiKey: "fake-key-for-test-only",
      tunnelName: "toozy",
      forwardTo: "http://localhost:8787",
    });
  });
});
