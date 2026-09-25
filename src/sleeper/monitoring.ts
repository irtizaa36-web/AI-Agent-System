import {
  playerName,
  type PlayerMap,
  type PlayerProjection,
  type SleeperLeague,
  type SleeperReadClient,
  type SleeperRoster,
  type SleeperUser,
  type ScheduleGame,
} from "../integrations/sleeper/client";
import type { SleeperWriteAction } from "../integrations/sleeper/write-actions";

/**
 * Read-only monitoring for the owner's Sleeper leagues (ADR 0021): resolve
 * the owner's account from a username, preview a week's matchup with injury
 * and bye flags, and rank waiver-wire pickups. Needs no credentials and
 * never writes. Where a suggestion could become a write (a lineup swap), it
 * is returned as a SleeperWriteAction for the owner to preview and confirm
 * separately — never sent from here.
 */

/** Statuses that mean a player will not play or is very unlikely to. */
const WILL_NOT_PLAY = new Set(["Out", "IR", "PUP", "Sus", "NA", "DNR"]);
const AT_RISK = new Set(["Doubtful", "Questionable"]);
const NON_STARTING_SLOTS = new Set(["BN", "IR", "TAXI"]);
const PROJECTION_POSITIONS = ["QB", "RB", "WR", "TE", "K", "DEF"] as const;

/** Which player positions can fill a lineup slot. */
export function slotAccepts(slot: string, position: string | null): boolean {
  if (!position) return false;
  switch (slot) {
    case "FLEX":
      return ["RB", "WR", "TE"].includes(position);
    case "SUPER_FLEX":
      return ["QB", "RB", "WR", "TE"].includes(position);
    case "REC_FLEX":
      return ["WR", "TE"].includes(position);
    case "WRRB_FLEX":
      return ["WR", "RB"].includes(position);
    case "IDP_FLEX":
      return ["DL", "LB", "DB"].includes(position);
    default:
      return slot === position;
  }
}

export interface ResolvedAccount {
  readonly user: SleeperUser;
  readonly season: string;
  readonly week: number;
  readonly leagues: readonly SleeperLeague[];
}

/** Turns the username the owner gives at runtime into their user id and this season's leagues. */
export async function resolveAccount(client: SleeperReadClient, username: string, season?: string): Promise<ResolvedAccount> {
  const trimmed = username.trim();
  if (!trimmed) throw new Error("A Sleeper username is required.");
  const [user, state] = await Promise.all([client.getUser(trimmed), client.getNflState()]);
  const resolvedSeason = season ?? state.league_season ?? state.season;
  const leagues = await client.getUserLeagues(user.user_id, resolvedSeason);
  return { user, season: resolvedSeason, week: state.display_week || state.week, leagues };
}

/** Finds the owner's roster in a league, or throws a clear error. */
export function findOwnRoster(rosters: readonly SleeperRoster[], userId: string, leagueId: string): SleeperRoster {
  const roster = rosters.find((r) => r.owner_id === userId);
  if (!roster) throw new Error(`User ${userId} has no roster in league ${leagueId}.`);
  return roster;
}

/**
 * Teams on bye in `week`: every team that appears anywhere in the season's
 * schedule but not in that week's games. Returns undefined when the schedule
 * isn't available (it comes from an undocumented endpoint), so callers say
 * "bye status unknown" rather than claiming nobody is on bye.
 */
export function byeTeams(schedule: readonly ScheduleGame[], week: number): ReadonlySet<string> | undefined {
  if (schedule.length === 0) return undefined;
  const all = new Set(schedule.flatMap((g) => [g.home, g.away]));
  const playing = new Set(schedule.filter((g) => g.week === week).flatMap((g) => [g.home, g.away]));
  if (playing.size === 0) return undefined;
  return new Set([...all].filter((team) => !playing.has(team)));
}

/** Picks the league's projected-points key from its scoring settings. */
export function pointsKey(league: SleeperLeague): "pts_ppr" | "pts_half_ppr" | "pts_std" {
  const rec = league.scoring_settings?.["rec"] ?? 0;
  if (rec >= 1) return "pts_ppr";
  if (rec >= 0.5) return "pts_half_ppr";
  return "pts_std";
}

async function safely<T>(load: () => Promise<T>): Promise<T | undefined> {
  try {
    return await load();
  } catch {
    return undefined;
  }
}

async function loadProjections(client: SleeperReadClient, season: string, week: number): Promise<ReadonlyMap<string, PlayerProjection> | undefined> {
  const rows = await safely(() => client.getProjections(season, week, PROJECTION_POSITIONS));
  if (!rows || rows.length === 0) return undefined;
  return new Map(rows.map((row) => [row.player_id, row]));
}

export interface PlayerLine {
  readonly playerId: string;
  readonly name: string;
  readonly position: string | null;
  readonly team: string | null;
  readonly slot?: string;
  readonly injuryStatus: string | null;
  /** undefined when bye weeks couldn't be determined. */
  readonly onBye: boolean | undefined;
  readonly projectedPoints: number | undefined;
}

export interface Alert {
  readonly kind: "out" | "questionable" | "bye" | "empty_slot" | "ir_eligible";
  readonly playerId?: string;
  readonly message: string;
}

export interface LineupSwap {
  readonly slot: string;
  readonly benchOut: PlayerLine;
  readonly startIn: PlayerLine;
}

export interface MatchupPreview {
  readonly league: SleeperLeague;
  readonly week: number;
  readonly rosterId: number;
  readonly opponent: { readonly rosterId: number; readonly ownerName: string } | undefined;
  readonly myStarters: readonly PlayerLine[];
  readonly myProjectedTotal: number | undefined;
  readonly opponentStarters: readonly PlayerLine[];
  readonly opponentProjectedTotal: number | undefined;
  readonly alerts: readonly Alert[];
  readonly suggestedSwaps: readonly LineupSwap[];
  /** The full lineup after the suggested swaps, ready to preview — never sent from here. */
  readonly suggestedLineupAction: SleeperWriteAction | undefined;
  /** Sources that were unavailable, so the report can say what it couldn't check. */
  readonly unavailable: readonly string[];
}

function line(
  playerId: string,
  players: PlayerMap,
  byes: ReadonlySet<string> | undefined,
  projections: ReadonlyMap<string, PlayerProjection> | undefined,
  key: string,
  slot?: string,
): PlayerLine {
  const player = players[playerId];
  const team = player?.team ?? null;
  const projected = projections?.get(playerId)?.stats[key];
  return {
    playerId,
    name: playerName(player, playerId),
    position: player?.position ?? null,
    team,
    ...(slot ? { slot } : {}),
    injuryStatus: player?.injury_status ?? null,
    onBye: byes === undefined ? undefined : team !== null && byes.has(team),
    projectedPoints: projections ? (projected ?? 0) : undefined,
  };
}

function cannotPlay(p: PlayerLine): boolean {
  return p.onBye === true || (p.injuryStatus !== null && WILL_NOT_PLAY.has(p.injuryStatus));
}

function total(lines: readonly PlayerLine[]): number | undefined {
  if (lines.some((l) => l.projectedPoints === undefined)) return undefined;
  return Math.round(lines.reduce((sum, l) => sum + (l.projectedPoints ?? 0), 0) * 100) / 100;
}

/** The weekly matchup preview: both lineups, projections when available, and every injury/bye/empty-slot flag on the owner's side. */
export async function matchupPreview(
  client: SleeperReadClient,
  input: { readonly leagueId: string; readonly userId: string; readonly week?: number },
): Promise<MatchupPreview> {
  const [league, state, rosters, users, players] = await Promise.all([
    client.getLeague(input.leagueId),
    client.getNflState(),
    client.getRosters(input.leagueId),
    client.getLeagueUsers(input.leagueId),
    client.getPlayers(),
  ]);
  const week = input.week ?? (state.display_week || state.week);
  const season = league.season;
  const [matchups, schedule, projections] = await Promise.all([
    client.getMatchups(input.leagueId, week),
    safely(() => client.getSchedule(season)),
    loadProjections(client, season, week),
  ]);
  const byes = schedule ? byeTeams(schedule, week) : undefined;
  const key = pointsKey(league);
  const unavailable = [...(byes === undefined ? ["bye weeks (schedule endpoint unavailable)"] : []), ...(projections === undefined ? ["projections"] : [])];

  const mine = findOwnRoster(rosters, input.userId, input.leagueId);
  const slots = league.roster_positions.filter((s) => !NON_STARTING_SLOTS.has(s));
  const myMatchup = matchups.find((m) => m.roster_id === mine.roster_id);
  const opponentMatchup =
    myMatchup && myMatchup.matchup_id !== null ? matchups.find((m) => m.matchup_id === myMatchup.matchup_id && m.roster_id !== mine.roster_id) : undefined;
  const opponentRoster = opponentMatchup ? rosters.find((r) => r.roster_id === opponentMatchup.roster_id) : undefined;
  const opponentUser = opponentRoster ? users.find((u) => u.user_id === opponentRoster.owner_id) : undefined;

  const myStarterIds = mine.starters ?? [];
  const myStarters = myStarterIds.map((id, i) => line(id, players, byes, projections, key, slots[i]));
  const opponentStarters = (opponentRoster?.starters ?? [])
    .map((id, i) => line(id, players, byes, projections, key, slots[i]))
    .filter((p) => p.playerId !== "0");

  const alerts: Alert[] = [];
  myStarters.forEach((p, i) => {
    if (p.playerId === "0") {
      alerts.push({ kind: "empty_slot", message: `Your ${slots[i] ?? "starting"} slot is empty.` });
      return;
    }
    if (p.onBye) alerts.push({ kind: "bye", playerId: p.playerId, message: `${p.name} (${p.team}) is on bye in week ${week} and is in your lineup.` });
    if (p.injuryStatus && WILL_NOT_PLAY.has(p.injuryStatus)) {
      alerts.push({ kind: "out", playerId: p.playerId, message: `${p.name} is listed ${p.injuryStatus} and is in your lineup.` });
    } else if (p.injuryStatus && AT_RISK.has(p.injuryStatus)) {
      alerts.push({ kind: "questionable", playerId: p.playerId, message: `${p.name} is listed ${p.injuryStatus}; check news before lock.` });
    }
  });
  const reserve = new Set(mine.reserve ?? []);
  for (const id of mine.players ?? []) {
    const status = players[id]?.injury_status;
    if (!reserve.has(id) && (status === "IR" || status === "PUP")) {
      alerts.push({ kind: "ir_eligible", playerId: id, message: `${playerName(players[id], id)} is on ${status} but not in an IR slot.` });
    }
  }

  // Greedy swaps: for each starter who can't play, the healthy bench player
  // eligible for that slot with the best projection (or any eligible one
  // when projections are unavailable).
  const startersSet = new Set(myStarterIds);
  const bench = (mine.players ?? [])
    .filter((id) => !startersSet.has(id) && !reserve.has(id) && !(mine.taxi ?? []).includes(id))
    .map((id) => line(id, players, byes, projections, key));
  const used = new Set<string>();
  const suggestedSwaps: LineupSwap[] = [];
  const newStarters = [...myStarterIds];
  myStarters.forEach((starter, i) => {
    const slot = slots[i];
    if (!slot || !(starter.playerId === "0" || cannotPlay(starter))) return;
    const candidates = bench
      .filter((b) => !used.has(b.playerId) && !cannotPlay(b) && slotAccepts(slot, b.position))
      .sort((a, b) => (b.projectedPoints ?? 0) - (a.projectedPoints ?? 0));
    const pick = candidates[0];
    if (!pick) return;
    used.add(pick.playerId);
    newStarters[i] = pick.playerId;
    suggestedSwaps.push({ slot, benchOut: starter, startIn: pick });
  });

  return {
    league,
    week,
    rosterId: mine.roster_id,
    opponent: opponentRoster
      ? { rosterId: opponentRoster.roster_id, ownerName: opponentUser?.metadata?.team_name || opponentUser?.display_name || `roster ${opponentRoster.roster_id}` }
      : undefined,
    myStarters,
    myProjectedTotal: total(myStarters.filter((p) => p.playerId !== "0")),
    opponentStarters,
    opponentProjectedTotal: total(opponentStarters),
    alerts,
    suggestedSwaps,
    suggestedLineupAction:
      suggestedSwaps.length > 0 ? { kind: "set_lineup", leagueId: league.league_id, rosterId: mine.roster_id, starters: newStarters } : undefined,
    unavailable,
  };
}

function fmtPoints(points: number | undefined): string {
  return points === undefined ? "n/a" : points.toFixed(1);
}

export function formatMatchupPreview(preview: MatchupPreview): string {
  const row = (p: PlayerLine): string =>
    `  ${(p.slot ?? "").padEnd(10)} ${p.playerId === "0" ? "(empty)" : `${p.name} (${p.position ?? "?"}, ${p.team ?? "FA"})`}` +
    `${p.injuryStatus ? ` [${p.injuryStatus}]` : ""}${p.onBye ? " [BYE]" : ""}  proj ${fmtPoints(p.projectedPoints)}`;
  return [
    `League: ${preview.league.name} (${preview.league.league_id}) — week ${preview.week}`,
    `Opponent: ${preview.opponent ? `${preview.opponent.ownerName} (roster ${preview.opponent.rosterId})` : "none this week"}`,
    `Projected: you ${fmtPoints(preview.myProjectedTotal)} vs them ${fmtPoints(preview.opponentProjectedTotal)}`,
    "Your starters:",
    ...preview.myStarters.map(row),
    ...(preview.opponentStarters.length > 0 ? ["Their starters:", ...preview.opponentStarters.map(row)] : []),
    preview.alerts.length === 0 ? "Alerts: none" : ["Alerts:", ...preview.alerts.map((a) => `  - ${a.message}`)].join("\n"),
    ...(preview.suggestedSwaps.length > 0
      ? [
          "Suggested swaps (not made — preview with sleeper write):",
          ...preview.suggestedSwaps.map((s) => `  - ${s.slot}: bench ${s.benchOut.playerId === "0" ? "(empty)" : s.benchOut.name}, start ${s.startIn.name}`),
          `suggestedAction:${JSON.stringify(preview.suggestedLineupAction)}`,
        ]
      : []),
    ...(preview.unavailable.length > 0 ? [`Unavailable: ${preview.unavailable.join(", ")}`] : []),
  ].join("\n");
}

export interface WaiverCandidate {
  readonly player: PlayerLine;
  readonly trendingAdds: number;
  /** Heuristic FAAB suggestion in whole dollars; undefined in non-FAAB leagues. */
  readonly suggestedBid: number | undefined;
  readonly suggestedDrop: PlayerLine | undefined;
}

export interface WaiverReport {
  readonly league: SleeperLeague;
  readonly week: number;
  readonly rosterId: number;
  readonly faab: { readonly budget: number; readonly remaining: number } | undefined;
  /** Winning FAAB bids in this league last week, highest first — the local market. */
  readonly recentWinningBids: readonly { readonly name: string; readonly bid: number }[];
  readonly candidates: readonly WaiverCandidate[];
  readonly unavailable: readonly string[];
}

/**
 * Ranks unrostered players worth claiming: trending adds across Sleeper that
 * are free agents in this league, at a position the league starts, and not
 * ruled out. Sorted by this week's projection when available, else by how
 * many Sleeper managers are adding them. The suggested bid is a plain
 * heuristic (a share of remaining FAAB by rank), labelled as such.
 */
export async function waiverRecommendations(
  client: SleeperReadClient,
  input: { readonly leagueId: string; readonly userId: string; readonly week?: number; readonly limit?: number },
): Promise<WaiverReport> {
  const [league, state, rosters, players, trending] = await Promise.all([
    client.getLeague(input.leagueId),
    client.getNflState(),
    client.getRosters(input.leagueId),
    client.getPlayers(),
    client.getTrending("add", { lookbackHours: 48, limit: 100 }),
  ]);
  const week = input.week ?? (state.display_week || state.week);
  const [projections, schedule, lastWeekTransactions] = await Promise.all([
    loadProjections(client, league.season, week),
    safely(() => client.getSchedule(league.season)),
    week > 1 ? safely(() => client.getTransactions(input.leagueId, week - 1)) : Promise.resolve([]),
  ]);
  const byes = schedule ? byeTeams(schedule, week) : undefined;
  const key = pointsKey(league);
  const mine = findOwnRoster(rosters, input.userId, input.leagueId);
  const rostered = new Set(rosters.flatMap((r) => r.players ?? []));
  const startablePositions = new Set(league.roster_positions.filter((s) => !NON_STARTING_SLOTS.has(s)));
  const startable = (position: string | null): boolean => [...startablePositions].some((slot) => slotAccepts(slot, position));

  const isFaab = league.settings?.["waiver_type"] === 2;
  const budget = Number(league.settings?.["waiver_budget"] ?? 0);
  const used = Number(mine.settings?.["waiver_budget_used"] ?? 0);
  const faab = isFaab ? { budget, remaining: Math.max(0, budget - used) } : undefined;

  const starters = new Set(mine.starters ?? []);
  const reserve = new Set(mine.reserve ?? []);
  const droppable = (mine.players ?? [])
    .filter((id) => !starters.has(id) && !reserve.has(id) && !(mine.taxi ?? []).includes(id))
    .map((id) => line(id, players, byes, projections, key))
    .sort((a, b) => (a.projectedPoints ?? 0) - (b.projectedPoints ?? 0));
  const suggestedDrop = droppable[0];

  const limit = input.limit ?? 5;
  const ranked = trending
    .filter((t) => !rostered.has(t.player_id))
    .map((t) => ({ t, p: line(t.player_id, players, byes, projections, key) }))
    .filter(({ p }) => startable(p.position) && !(p.injuryStatus && WILL_NOT_PLAY.has(p.injuryStatus)))
    .sort((a, b) =>
      projections ? (b.p.projectedPoints ?? 0) - (a.p.projectedPoints ?? 0) || b.t.count - a.t.count : b.t.count - a.t.count,
    )
    .slice(0, limit);

  const bidShare = (rank: number): number => (rank === 0 ? 0.15 : rank < 3 ? 0.08 : 0.03);
  const candidates = ranked.map(({ t, p }, rank) => ({
    player: p,
    trendingAdds: t.count,
    suggestedBid: faab ? Math.min(faab.remaining, Math.max(faab.remaining > 0 ? 1 : 0, Math.round(faab.remaining * bidShare(rank)))) : undefined,
    suggestedDrop,
  }));

  const recentWinningBids = (lastWeekTransactions ?? [])
    .filter((tx) => tx.type === "waiver" && tx.status === "complete" && tx.settings?.["waiver_bid"] !== undefined)
    .flatMap((tx) => Object.keys(tx.adds ?? {}).map((id) => ({ name: playerName(players[id], id), bid: Number(tx.settings?.["waiver_bid"] ?? 0) })))
    .sort((a, b) => b.bid - a.bid);

  return {
    league,
    week,
    rosterId: mine.roster_id,
    faab,
    recentWinningBids,
    candidates,
    unavailable: [...(projections === undefined ? ["projections"] : []), ...(byes === undefined ? ["bye weeks"] : [])],
  };
}

export function formatWaiverReport(report: WaiverReport): string {
  return [
    `League: ${report.league.name} (${report.league.league_id}) — week ${report.week}, your roster ${report.rosterId}`,
    report.faab ? `FAAB: $${report.faab.remaining} of $${report.faab.budget} left` : "Waivers: not FAAB (priority order)",
    report.recentWinningBids.length > 0
      ? `Last week's winning bids: ${report.recentWinningBids
          .slice(0, 5)
          .map((b) => `${b.name} $${b.bid}`)
          .join(", ")}`
      : "Last week's winning bids: none recorded",
    report.candidates.length === 0 ? "No free-agent candidates among trending adds." : "Candidates (not claimed — preview with sleeper write):",
    ...report.candidates.map(
      (c, i) =>
        `  ${i + 1}. ${c.player.name} (${c.player.position ?? "?"}, ${c.player.team ?? "FA"}) [${c.player.playerId}]` +
        `${c.player.injuryStatus ? ` [${c.player.injuryStatus}]` : ""}${c.player.onBye ? " [BYE this week]" : ""}` +
        ` — proj ${fmtPoints(c.player.projectedPoints)}, ${c.trendingAdds} adds/48h` +
        `${c.suggestedBid !== undefined ? `, heuristic bid $${c.suggestedBid}` : ""}` +
        `${c.suggestedDrop ? `, drop candidate ${c.suggestedDrop.name} [${c.suggestedDrop.playerId}]` : ""}`,
    ),
    ...(report.unavailable.length > 0 ? [`Unavailable: ${report.unavailable.join(", ")}`] : []),
  ].join("\n");
}
