import { test } from "node:test";
import assert from "node:assert/strict";
import { buildWritePlan, checkAgainstRosters, parseSleeperWriteAction, type SleeperWriteAction } from "./write-actions";
import { NOT_CONFIGURED, formatPreview, runSleeperWrite } from "./write-gate";
import { FakeSleeperWriteClient } from "./fake-write-client";
import { RealSleeperWriteClient, createSleeperWriteClientFromEnv } from "./graphql-client";
import { fixtureData, LEAGUE_ID, PLAYERS } from "../../sleeper/test-fixtures";

const ROSTERS = fixtureData().rosters?.[LEAGUE_ID] ?? [];

const LINEUP: SleeperWriteAction = { kind: "set_lineup", leagueId: LEAGUE_ID, rosterId: 1, starters: ["11", "12", "19", "14", "20", "16", "17", "18", "KC"] };

function parsed(value: unknown): SleeperWriteAction {
  const result = parseSleeperWriteAction(value);
  if (!result.ok) throw new Error(result.error);
  return result.action;
}

test("parseSleeperWriteAction accepts every write kind", () => {
  const valid = [
    LINEUP,
    { kind: "update_ir", leagueId: LEAGUE_ID, rosterId: 1, reserve: ["22"] },
    { kind: "update_taxi", leagueId: LEAGUE_ID, rosterId: 1, taxi: [] },
    { kind: "add_drop_player", leagueId: LEAGUE_ID, rosterId: 1, addPlayerIds: ["41"], dropPlayerIds: ["22"] },
    { kind: "submit_waiver_claim", leagueId: LEAGUE_ID, rosterId: 1, addPlayerId: "41", dropPlayerId: "22", bid: 12 },
    { kind: "cancel_waiver_claim", leagueId: LEAGUE_ID, transactionId: "555", leg: 3 },
    { kind: "propose_trade", leagueId: LEAGUE_ID, rosterId: 1, partnerRosterId: 2, sendPlayerIds: ["20"], receivePlayerIds: ["34"] },
    { kind: "respond_to_trade", leagueId: LEAGUE_ID, transactionId: "556", leg: 3, response: "reject" },
  ];
  for (const action of valid) assert.deepEqual(parsed(action), action);
});

test("parseSleeperWriteAction rejects malformed actions with a reason", () => {
  const invalid: unknown[] = [
    null,
    { kind: "place_pickem_entry", leagueId: LEAGUE_ID },
    { ...LINEUP, leagueId: "abc" },
    { ...LINEUP, rosterId: 0 },
    { ...LINEUP, starters: [] },
    { ...LINEUP, starters: ["Robert'); DROP"] },
    { kind: "add_drop_player", leagueId: LEAGUE_ID, rosterId: 1, addPlayerIds: [], dropPlayerIds: [] },
    { kind: "submit_waiver_claim", leagueId: LEAGUE_ID, rosterId: 1, addPlayerId: "41", bid: 2.5 },
    { kind: "submit_waiver_claim", leagueId: LEAGUE_ID, rosterId: 1, addPlayerId: "41", bid: -1 },
    { kind: "propose_trade", leagueId: LEAGUE_ID, rosterId: 1, partnerRosterId: 1, sendPlayerIds: ["20"], receivePlayerIds: [] },
    { kind: "respond_to_trade", leagueId: LEAGUE_ID, transactionId: "556", leg: 3, response: "maybe" },
  ];
  for (const value of invalid) assert.equal(parseSleeperWriteAction(value).ok, false, JSON.stringify(value));
});

test("a trade maps each player to the roster that receives (adds) and gives up (drops) them", () => {
  const plan = buildWritePlan({ kind: "propose_trade", leagueId: LEAGUE_ID, rosterId: 1, partnerRosterId: 2, sendPlayerIds: ["20"], receivePlayerIds: ["34"] });
  assert.equal(plan.operation, "propose_trade");
  assert.deepEqual(plan.variables["k_adds"], ["34", "20"]);
  assert.deepEqual(plan.variables["v_adds"], [1, 2]);
  assert.deepEqual(plan.variables["k_drops"], ["20", "34"]);
  assert.deepEqual(plan.variables["v_drops"], [1, 2]);
});

test("a waiver claim carries the FAAB bid as waiver_bid", () => {
  const plan = buildWritePlan({ kind: "submit_waiver_claim", leagueId: LEAGUE_ID, rosterId: 1, addPlayerId: "41", dropPlayerId: "22", bid: 12 });
  assert.equal(plan.operation, "submit_waiver_claim");
  assert.deepEqual(plan.variables["k_settings"], ["waiver_bid"]);
  assert.deepEqual(plan.variables["v_settings"], [12]);
  assert.match(plan.query, /^mutation submit_waiver_claim\(/);
});

test("the roster check catches players on the wrong roster, duplicates, and already-rostered adds", () => {
  assert.deepEqual(checkAgainstRosters(LINEUP, ROSTERS), []);
  assert.match(checkAgainstRosters({ ...LINEUP, starters: ["11", "34"] } as SleeperWriteAction, ROSTERS).join(), /player 34 is not on roster 1/);
  assert.match(checkAgainstRosters({ ...LINEUP, starters: ["11", "11"] } as SleeperWriteAction, ROSTERS).join(), /listed twice/);
  assert.match(
    checkAgainstRosters({ kind: "submit_waiver_claim", leagueId: LEAGUE_ID, rosterId: 1, addPlayerId: "43" }, ROSTERS).join(),
    /already on a roster/,
  );
  assert.match(
    checkAgainstRosters({ kind: "propose_trade", leagueId: LEAGUE_ID, rosterId: 1, partnerRosterId: 2, sendPlayerIds: ["34"], receivePlayerIds: ["14"] }, ROSTERS).join(),
    /34 is not on your roster 1.*14 is not on partner roster 2/,
  );
  assert.match(checkAgainstRosters({ ...LINEUP, rosterId: 9 } as SleeperWriteAction, ROSTERS).join(), /roster 9 does not exist/);
});

test("without confirm:true nothing is sent — only a dry-run preview", async () => {
  const client = new FakeSleeperWriteClient();
  for (const confirm of [undefined, false, "true", 1, "yes"]) {
    const outcome = await runSleeperWrite(LINEUP, { confirm, client, rosters: ROSTERS, players: PLAYERS });
    assert.equal(outcome.dryRun, true);
    assert.equal(outcome.written, false);
  }
  assert.equal(client.executed.length, 0);

  const text = formatPreview((await runSleeperWrite(LINEUP, { rosters: ROSTERS, players: PLAYERS })).preview);
  assert.match(text, /dry_run:true/);
  assert.match(text, /written:false/);
  assert.match(text, /Bench Back \[19\]/);
  assert.match(text, /rosterCheck:ok/);
  assert.match(text, /graphqlOperation:roster_update_starters/);
});

test("with confirm:true a clean action is sent exactly once, as previewed", async () => {
  const client = new FakeSleeperWriteClient();
  const outcome = await runSleeperWrite(LINEUP, { confirm: true, client, rosters: ROSTERS });
  assert.equal(outcome.written, true);
  assert.deepEqual(client.executed, [buildWritePlan(LINEUP)]);
});

test("confirm:true still refuses when unconfigured, unchecked, or failing the roster check", async () => {
  const client = new FakeSleeperWriteClient();
  await assert.rejects(runSleeperWrite(LINEUP, { confirm: true, rosters: ROSTERS }), new RegExp(NOT_CONFIGURED.slice(0, 30)));
  await assert.rejects(runSleeperWrite(LINEUP, { confirm: true, client }), /not checked against the league's live rosters/);
  await assert.rejects(
    runSleeperWrite({ ...LINEUP, starters: ["34"] } as SleeperWriteAction, { confirm: true, client, rosters: ROSTERS }),
    /Refusing to write: player 34/,
  );
  assert.equal(client.executed.length, 0);
});

test("the real GraphQL client sends the owner's token and the exact plan (fetch injected, no network)", async () => {
  const sent: { url: string; init: RequestInit }[] = [];
  const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
    sent.push({ url: String(url), init: init ?? {} });
    return new Response(JSON.stringify({ data: { roster_update_starters: { roster_id: 1 } } }), { status: 200 });
  }) as typeof fetch;
  const client = new RealSleeperWriteClient({ token: "test-token-not-real", fetchImpl });
  const plan = buildWritePlan(LINEUP);
  assert.deepEqual(await client.execute(plan), { roster_id: 1 });
  assert.equal(sent.length, 1);
  assert.equal(sent[0]?.url, "https://sleeper.com/graphql");
  const headers = sent[0]?.init.headers as Record<string, string>;
  assert.equal(headers["authorization"], "test-token-not-real");
  assert.equal(headers["x-sleeper-graphql-op"], "roster_update_starters");
  assert.deepEqual(JSON.parse(String(sent[0]?.init.body)), { operationName: plan.operation, variables: plan.variables, query: plan.query });
});

test("the real GraphQL client reports an expired token and GraphQL errors clearly", async () => {
  const respond = (status: number, body: unknown) => (async () => new Response(JSON.stringify(body), { status })) as unknown as typeof fetch;
  await assert.rejects(new RealSleeperWriteClient({ token: "t", fetchImpl: respond(401, {}) }).execute(buildWritePlan(LINEUP)), /expired/);
  await assert.rejects(
    new RealSleeperWriteClient({ token: "t", fetchImpl: respond(200, { errors: [{ message: "roster locked" }] }) }).execute(buildWritePlan(LINEUP)),
    /roster locked/,
  );
});

test("no write client exists unless SLEEPER_TOKEN is set", () => {
  const original = process.env["SLEEPER_TOKEN"];
  try {
    delete process.env["SLEEPER_TOKEN"];
    assert.equal(createSleeperWriteClientFromEnv(), undefined);
    process.env["SLEEPER_TOKEN"] = "   ";
    assert.equal(createSleeperWriteClientFromEnv(), undefined);
    process.env["SLEEPER_TOKEN"] = "test-token-not-real";
    assert.ok(createSleeperWriteClientFromEnv() instanceof RealSleeperWriteClient);
  } finally {
    if (original === undefined) delete process.env["SLEEPER_TOKEN"];
    else process.env["SLEEPER_TOKEN"] = original;
  }
});
