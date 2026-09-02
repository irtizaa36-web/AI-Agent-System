import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { browserSessionPath, hasBrowserSession } from "./session";

test("browserSessionPath places a site's session under .orchestrator/browser-sessions", () => {
  assert.equal(browserSessionPath("sermo"), join(".orchestrator", "browser-sessions", "sermo.json"));
});

test("hasBrowserSession is false for a site with no saved session", () => {
  assert.equal(hasBrowserSession("a-site-that-has-never-logged-in"), false);
});
