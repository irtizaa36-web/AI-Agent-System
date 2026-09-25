import { test } from "node:test";
import assert from "node:assert/strict";
import { createSleeperFindLeaguesTool, createSleeperMatchupPreviewTool, createSleeperWaiverRecommendationsTool } from "./sleeper-read-tools";
import { createSleeperExecuteWriteTool, createSleeperPreviewWriteTool } from "./sleeper-write-tools";
import { createPickemBankrollStatusTool, createPickemBuildSlipTool, createPickemResearchLineTool, pickemToday } from "./pickem-tools";
import { FakeSleeperWriteClient } from "../integrations/sleeper/fake-write-client";
import { InMemoryPickemStore } from "../sleeper/pickem/store";
import { fixtureClient, LEAGUE_ID } from "../sleeper/test-fixtures";

const LINEUP = { kind: "set_lineup", leagueId: LEAGUE_ID, rosterId: 1, starters: ["11", "12", "19", "14", "20", "16", "17", "18", "KC"] };

test("read tools resolve the username at runtime and never need credentials", async () => {
  const client = fixtureClient();
  const leagues = await createSleeperFindLeaguesTool(client).execute({ username: "owner_one" });
  assert.match(leagues, /userId:100/);
  assert.match(leagues, /leagueId:1001 \| Test League/);

  const preview = await createSleeperMatchupPreviewTool(client).execute({ username: "owner_one", leagueId: LEAGUE_ID });
  assert.match(preview, /Hurt Back is listed Out/);
  const waivers = await createSleeperWaiverRecommendationsTool(client).execute({ username: "owner_one", leagueId: LEAGUE_ID, limit: 1 });
  assert.match(waivers, /1\. Same Name/);
  assert.doesNotMatch(waivers, /2\. /);

  await assert.rejects(Promise.resolve().then(() => createSleeperMatchupPreviewTool(client).execute({ username: "owner_one", leagueId: LEAGUE_ID, week: 19 })), /week/);
  await assert.rejects(Promise.resolve().then(() => createSleeperFindLeaguesTool(client).execute({})), /requires "username"/);
});

test("sleeper-execute-write always requires approval; preview and read tools never do", () => {
  const client = fixtureClient();
  assert.equal(createSleeperExecuteWriteTool(client, new FakeSleeperWriteClient()).requiresApproval, true);
  for (const tool of [
    createSleeperPreviewWriteTool(client),
    createSleeperFindLeaguesTool(client),
    createSleeperMatchupPreviewTool(client),
    createSleeperWaiverRecommendationsTool(client),
  ]) {
    assert.notEqual(tool.requiresApproval, true, tool.name);
  }
});

test("sleeper-preview-write is a dry run with the live roster check", async () => {
  const output = await createSleeperPreviewWriteTool(fixtureClient()).execute({ action: LINEUP });
  assert.match(output, /dry_run:true/);
  assert.match(output, /rosterCheck:ok/);
  const bad = await createSleeperPreviewWriteTool(fixtureClient()).execute({ action: { ...LINEUP, starters: ["34"] } });
  assert.match(bad, /rosterCheck:FAILED\n  - player 34 is not on roster 1/);
});

test("sleeper-execute-write without confirm:true only previews, even after approval", async () => {
  const writer = new FakeSleeperWriteClient();
  const tool = createSleeperExecuteWriteTool(fixtureClient(), writer);
  for (const input of [{ action: LINEUP }, { action: LINEUP, confirm: "true" }, { action: LINEUP, confirm: false }]) {
    assert.match(await tool.execute(input), /not sent — "confirm": true is required/);
  }
  assert.equal(writer.executed.length, 0);
});

test("sleeper-execute-write with confirm:true sends the previewed action once", async () => {
  const writer = new FakeSleeperWriteClient();
  const output = await createSleeperExecuteWriteTool(fixtureClient(), writer).execute({ action: LINEUP, confirm: true });
  assert.match(output, /written:true/);
  assert.equal(writer.executed.length, 1);
  assert.equal(writer.executed[0]?.operation, "roster_update_starters");
});

test("sleeper-execute-write refuses without SLEEPER_TOKEN or on a failed roster check", async () => {
  await assert.rejects(async () => createSleeperExecuteWriteTool(fixtureClient(), undefined).execute({ action: LINEUP, confirm: true }), /set SLEEPER_TOKEN/);
  const writer = new FakeSleeperWriteClient();
  await assert.rejects(async () => createSleeperExecuteWriteTool(fixtureClient(), writer).execute({ action: { ...LINEUP, starters: ["34"] }, confirm: true }), /Refusing to write/);
  assert.equal(writer.executed.length, 0);
});

test("pick'em tools research, report the bankroll, and write a slip — none requires approval because none places anything", async () => {
  const store = new InMemoryPickemStore();
  const research = createPickemResearchLineTool(fixtureClient());
  const bankroll = createPickemBankrollStatusTool(store);
  const slip = createPickemBuildSlipTool(store);
  for (const tool of [research, bankroll, slip]) assert.notEqual(tool.requiresApproval, true);

  assert.match(await research.execute({ player: "Wes Wideout", stat: "rec_yd", line: 64.5 }), /grade:high/);
  assert.match(await bankroll.execute({}), /available:\$15\.00/);

  const text = await slip.execute({
    conviction: "standard",
    picks: [
      { player: "Wes Wideout", stat: "rec_yd", line: 64.5, direction: "more", grade: "high" },
      { player: "Quinn Arm", stat: "pass_yd", line: 215.5, direction: "more", grade: "standard" },
    ],
  });
  assert.match(text, /MANUAL ENTRY ONLY/);
  assert.match(text, /stake:\$3\.00/);
  assert.equal((await store.listEntries()).length, 0, "building a slip never logs an entry");

  const refused = await slip.execute({ conviction: "high", stake: 15, picks: [{ player: "A", stat: "rec", line: 5, direction: "more" }, { player: "B", stat: "rec", line: 5, direction: "more" }] });
  assert.match(refused, /slip:none\nreason:High-conviction plays are capped at 50%/);
});

test("pickemToday uses the owner's timezone, not UTC", () => {
  const original = process.env["PICKEM_TIMEZONE"];
  try {
    delete process.env["PICKEM_TIMEZONE"];
    // 02:00 UTC on the 28th is still the evening of the 27th in New York.
    assert.equal(pickemToday(new Date("2026-09-28T02:00:00Z")), "2026-09-27");
    process.env["PICKEM_TIMEZONE"] = "UTC";
    assert.equal(pickemToday(new Date("2026-09-28T02:00:00Z")), "2026-09-28");
  } finally {
    if (original === undefined) delete process.env["PICKEM_TIMEZONE"];
    else process.env["PICKEM_TIMEZONE"] = original;
  }
});
