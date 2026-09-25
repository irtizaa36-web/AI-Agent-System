import type { SleeperPlayer } from "../integrations/sleeper/client";
import { FakeSleeperClient, type FakeSleeperData } from "../integrations/sleeper/fake-client";

/**
 * One small, made-up Sleeper league for tests (no real accounts or ids).
 * Week 3: the owner ("owner_one", user 100, roster 1) plays roster 2. One of
 * his starters is Out, one is on bye (BUF), and a bench player is on IR
 * without an IR slot.
 */
export const OWNER_ID = "100";
export const LEAGUE_ID = "1001";

function p(player_id: string, full_name: string, position: string, team: string | null, injury_status: string | null = null): SleeperPlayer {
  return { player_id, full_name, position, team, injury_status };
}

export const PLAYERS: Record<string, SleeperPlayer> = Object.fromEntries(
  [
    p("11", "Quinn Arm", "QB", "KC"),
    p("12", "Rex Runner", "RB", "SF"),
    p("13", "Hurt Back", "RB", "LAR", "Out"),
    p("14", "Wes Wideout", "WR", "DAL"),
    p("15", "Bye Guy", "WR", "BUF"),
    p("16", "Tate End", "TE", "PHI"),
    p("17", "Flex Star", "WR", "MIN"),
    p("18", "Kip Kicker", "K", "SEA"),
    { player_id: "KC", first_name: "Kansas City", last_name: "Chiefs", position: "DEF", team: "KC", injury_status: null },
    p("19", "Bench Back", "RB", "DET"),
    p("20", "Bench Wide", "WR", "NYG"),
    p("21", "Iffy Receiver", "WR", "GB", "Questionable"),
    p("22", "Long Injured", "TE", "CHI", "IR"),
    // Opponent (roster 2)
    p("31", "Other Qb", "QB", "CIN"),
    p("32", "Other Rb", "RB", "ATL"),
    p("33", "Other Rb2", "RB", "NO"),
    p("34", "Other Wr", "WR", "LV"),
    p("35", "Other Wr2", "WR", "TB"),
    p("36", "Other Te", "TE", "NE"),
    p("37", "Other Flex", "RB", "HOU"),
    p("38", "Other K", "K", "ARI"),
    { player_id: "DEN", first_name: "Denver", last_name: "Broncos", position: "DEF", team: "DEN", injury_status: null },
    // Free agents
    p("41", "Hot Pickup", "WR", "NYJ"),
    p("42", "Out Pickup", "RB", "JAX", "Out"),
    p("43", "Waiver Back", "RB", "CAR"),
    p("44", "Punter Guy", "P", "CLE"),
    p("45", "Same Name", "WR", "PIT"),
    p("46", "Same Name", "WR", "IND"),
  ].map((pl) => [pl.player_id, pl]),
);

const TEAMS = ["KC", "SF", "LAR", "DAL", "BUF", "PHI", "MIN", "SEA", "DET", "NYG", "GB", "CHI", "CIN", "ATL", "NO", "LV", "TB", "NE", "HOU", "ARI", "DEN", "NYJ", "JAX", "CAR", "CLE", "PIT", "IND", "MIA"];

function weekGames(week: number, byes: readonly string[]) {
  const playing = TEAMS.filter((t) => !byes.includes(t));
  const games = [];
  for (let i = 0; i + 1 < playing.length; i += 2) {
    games.push({ week, home: playing[i] as string, away: playing[i + 1] as string, date: `2026-09-${10 + week * 7}`, status: null });
  }
  return games;
}

export function fixtureData(overrides: Partial<FakeSleeperData> = {}): FakeSleeperData {
  return {
    users: [
      { user_id: OWNER_ID, username: "owner_one", display_name: "Owner One" },
      { user_id: "200", username: "rival_two", display_name: "Rival Two" },
    ],
    leagues: [
      {
        league_id: LEAGUE_ID,
        name: "Test League",
        season: "2026",
        status: "in_season",
        total_rosters: 2,
        roster_positions: ["QB", "RB", "RB", "WR", "WR", "TE", "FLEX", "K", "DEF", "BN", "BN", "BN", "BN", "IR"],
        settings: { waiver_type: 2, waiver_budget: 100 },
        scoring_settings: { rec: 1 },
      },
      { league_id: "1002", name: "Last Year", season: "2025", status: "complete", total_rosters: 10, roster_positions: [] },
    ],
    memberships: { [OWNER_ID]: [LEAGUE_ID, "1002"], "200": [LEAGUE_ID] },
    leagueUsers: {
      [LEAGUE_ID]: [
        { user_id: OWNER_ID, display_name: "Owner One" },
        { user_id: "200", display_name: "Rival Two", metadata: { team_name: "Rival FC" } },
      ],
    },
    rosters: {
      [LEAGUE_ID]: [
        {
          roster_id: 1,
          owner_id: OWNER_ID,
          players: ["11", "12", "13", "14", "15", "16", "17", "18", "KC", "19", "20", "21", "22"],
          starters: ["11", "12", "13", "14", "15", "16", "17", "18", "KC"],
          reserve: [],
          taxi: [],
          settings: { waiver_budget_used: 20 },
        },
        {
          roster_id: 2,
          owner_id: "200",
          players: ["31", "32", "33", "34", "35", "36", "37", "38", "DEN", "43"],
          starters: ["31", "32", "33", "34", "35", "36", "37", "38", "DEN"],
          reserve: [],
          taxi: [],
          settings: { waiver_budget_used: 0 },
        },
      ],
    },
    matchups: {
      [`${LEAGUE_ID}:3`]: [
        { roster_id: 1, matchup_id: 1, points: 0, starters: [], players: [] },
        { roster_id: 2, matchup_id: 1, points: 0, starters: [], players: [] },
      ],
    },
    transactions: {
      [`${LEAGUE_ID}:2`]: [
        { transaction_id: "900", type: "waiver", status: "complete", roster_ids: [2], adds: { "43": 2 }, drops: null, settings: { waiver_bid: 12 }, created: 1, leg: 2 },
        { transaction_id: "901", type: "waiver", status: "failed", roster_ids: [1], adds: { "43": 1 }, drops: null, settings: { waiver_bid: 5 }, created: 1, leg: 2 },
      ],
    },
    players: PLAYERS,
    trendingAdds: [
      { player_id: "43", count: 9000 }, // rostered by roster 2 — must be skipped
      { player_id: "42", count: 8000 }, // Out — must be skipped
      { player_id: "44", count: 7000 }, // punter — league doesn't start one
      { player_id: "41", count: 5000 },
      { player_id: "45", count: 100 },
    ],
    nflState: { week: 3, display_week: 3, season: "2026", league_season: "2026", season_type: "regular" },
    schedule: [...weekGames(1, []), ...weekGames(2, []), ...weekGames(3, ["BUF", "MIA"])],
    projections: {
      3: [
        { player_id: "11", week: 3, stats: { pts_ppr: 20, pass_yd: 260 } },
        { player_id: "12", week: 3, stats: { pts_ppr: 14, rush_yd: 70, rec_yd: 20 } },
        { player_id: "13", week: 3, stats: { pts_ppr: 0 } },
        { player_id: "14", week: 3, stats: { pts_ppr: 13, rec_yd: 78.2, rec: 6 } },
        { player_id: "15", week: 3, stats: { pts_ppr: 0 } },
        { player_id: "16", week: 3, stats: { pts_ppr: 9 } },
        { player_id: "17", week: 3, stats: { pts_ppr: 15 } },
        { player_id: "18", week: 3, stats: { pts_ppr: 8 } },
        { player_id: "KC", week: 3, stats: { pts_ppr: 7 } },
        { player_id: "19", week: 3, stats: { pts_ppr: 9.5 } },
        { player_id: "20", week: 3, stats: { pts_ppr: 7.5 } },
        { player_id: "21", week: 3, stats: { pts_ppr: 6 } },
        { player_id: "22", week: 3, stats: { pts_ppr: 0 } },
        { player_id: "31", week: 3, stats: { pts_ppr: 18 } },
        { player_id: "32", week: 3, stats: { pts_ppr: 12 } },
        { player_id: "33", week: 3, stats: { pts_ppr: 10 } },
        { player_id: "34", week: 3, stats: { pts_ppr: 11 } },
        { player_id: "35", week: 3, stats: { pts_ppr: 9 } },
        { player_id: "36", week: 3, stats: { pts_ppr: 7 } },
        { player_id: "37", week: 3, stats: { pts_ppr: 8 } },
        { player_id: "38", week: 3, stats: { pts_ppr: 8 } },
        { player_id: "DEN", week: 3, stats: { pts_ppr: 6 } },
        { player_id: "41", week: 3, stats: { pts_ppr: 11, rec_yd: 50 } },
        { player_id: "45", week: 3, stats: { pts_ppr: 12 } },
      ],
    },
    ...overrides,
  };
}

export function fixtureClient(overrides: Partial<FakeSleeperData> = {}): FakeSleeperClient {
  return new FakeSleeperClient(fixtureData(overrides));
}
