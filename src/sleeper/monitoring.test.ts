import { test } from "node:test";
import assert from "node:assert/strict";
import { byeTeams, formatMatchupPreview, formatWaiverReport, matchupPreview, pointsKey, resolveAccount, slotAccepts, waiverRecommendations } from "./monitoring";
import { fixtureClient, fixtureData, LEAGUE_ID, OWNER_ID } from "./test-fixtures";

test("resolveAccount turns a runtime username into the user id and this season's leagues", async () => {
  const account = await resolveAccount(fixtureClient(), "Owner_One");
  assert.equal(account.user.user_id, OWNER_ID);
  assert.equal(account.season, "2026");
  assert.equal(account.week, 3);
  assert.deepEqual(
    account.leagues.map((l) => l.league_id),
    [LEAGUE_ID],
    "last season's league is excluded",
  );
  await assert.rejects(resolveAccount(fixtureClient(), "nobody"), /No Sleeper user found/);
  await assert.rejects(resolveAccount(fixtureClient(), "  "), /username is required/);
});

test("slot eligibility, bye detection and scoring key", () => {
  assert.equal(slotAccepts("FLEX", "TE"), true);
  assert.equal(slotAccepts("FLEX", "QB"), false);
  assert.equal(slotAccepts("SUPER_FLEX", "QB"), true);
  assert.equal(slotAccepts("WR", "RB"), false);
  const schedule = fixtureData().schedule ?? [];
  assert.deepEqual([...(byeTeams(schedule, 3) ?? [])].sort(), ["BUF", "MIA"]);
  assert.equal(byeTeams([], 3), undefined, "no schedule means unknown, not 'nobody on bye'");
  assert.equal(pointsKey({ league_id: "1", name: "", season: "", status: "", total_rosters: 0, roster_positions: [], scoring_settings: { rec: 0.5 } }), "pts_half_ppr");
});

test("matchup preview flags Out, bye and IR-eligible players and suggests eligible bench swaps", async () => {
  const preview = await matchupPreview(fixtureClient(), { leagueId: LEAGUE_ID, userId: OWNER_ID });
  assert.equal(preview.week, 3);
  assert.deepEqual(preview.opponent, { rosterId: 2, ownerName: "Rival FC" });

  const kinds = preview.alerts.map((a) => `${a.kind}:${a.playerId ?? ""}`);
  assert.ok(kinds.includes("out:13"), "Hurt Back is Out and starting");
  assert.ok(kinds.includes("bye:15"), "Bye Guy (BUF) is on bye in week 3");
  assert.ok(kinds.includes("ir_eligible:22"), "Long Injured is on IR but not in an IR slot");
  assert.ok(!kinds.some((k) => k.endsWith(":21")), "a questionable bench player isn't flagged as a lineup problem");

  // RB slot: Out starter -> best healthy RB on the bench. WR slot: bye -> best WR (7.5 over 6).
  assert.deepEqual(
    preview.suggestedSwaps.map((s) => `${s.slot}:${s.benchOut.playerId}->${s.startIn.playerId}`),
    ["RB:13->19", "WR:15->20"],
  );
  assert.deepEqual(preview.suggestedLineupAction, {
    kind: "set_lineup",
    leagueId: LEAGUE_ID,
    rosterId: 1,
    starters: ["11", "12", "19", "14", "20", "16", "17", "18", "KC"],
  });
  assert.equal(preview.myProjectedTotal, 86);
  assert.equal(preview.opponentProjectedTotal, 89);

  const text = formatMatchupPreview(preview);
  assert.match(text, /Bye Guy \(WR, BUF\) \[BYE\]/);
  assert.match(text, /Suggested swaps \(not made/);
});

test("matchup preview degrades honestly when the undocumented endpoints are down", async () => {
  const preview = await matchupPreview(fixtureClient({ undocumentedEndpointsDown: true }), { leagueId: LEAGUE_ID, userId: OWNER_ID });
  assert.deepEqual(preview.unavailable, ["bye weeks (schedule endpoint unavailable)", "projections"]);
  assert.equal(preview.myStarters[4]?.onBye, undefined, "bye status is unknown, not false");
  assert.ok(preview.alerts.some((a) => a.kind === "out"), "injury flags still work from the documented players list");
  assert.match(formatMatchupPreview(preview), /Unavailable: bye weeks/);
});

test("waiver recommendations skip rostered, ruled-out and unstartable players and rank by projection", async () => {
  const report = await waiverRecommendations(fixtureClient(), { leagueId: LEAGUE_ID, userId: OWNER_ID });
  assert.deepEqual(
    report.candidates.map((c) => c.player.playerId),
    ["45", "41"],
  );
  assert.deepEqual(report.faab, { budget: 100, remaining: 80 });
  assert.deepEqual(
    report.candidates.map((c) => c.suggestedBid),
    [12, 6],
  );
  assert.equal(report.candidates[0]?.suggestedDrop?.playerId, "22", "lowest-projected bench player");
  assert.deepEqual(report.recentWinningBids, [{ name: "Waiver Back", bid: 12 }], "failed claims are not winning bids");
  const text = formatWaiverReport(report);
  assert.match(text, /FAAB: \$80 of \$100 left/);
  assert.match(text, /heuristic bid \$12/);
});

test("waiver recommendations in a non-FAAB league suggest no bid", async () => {
  const data = fixtureData();
  const league = { ...(data.leagues?.[0] as NonNullable<typeof data.leagues>[number]), settings: { waiver_type: 0 } };
  const report = await waiverRecommendations(fixtureClient({ leagues: [league] }), { leagueId: LEAGUE_ID, userId: OWNER_ID });
  assert.equal(report.faab, undefined);
  assert.ok(report.candidates.every((c) => c.suggestedBid === undefined));
});
