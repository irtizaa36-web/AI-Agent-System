/**
 * The Sleeper read port (ADR 0021): everything here is read-only and needs
 * no credentials. Most methods map to Sleeper's documented public API
 * (https://api.sleeper.app/v1). Two do not: `getSchedule` and
 * `getProjections` call undocumented endpoints the Sleeper app itself uses
 * (observed working on 2026-09-25). They can change without notice, so every
 * caller treats a failure from them as "unknown", never as an error that
 * stops the whole report.
 *
 * Field names follow Sleeper's wire format (snake_case) so a raw response can
 * be passed through without translation. Only fields the agent reads are
 * declared.
 */

export interface SleeperUser {
  readonly user_id: string;
  readonly username: string;
  readonly display_name: string;
}

export interface SleeperLeague {
  readonly league_id: string;
  readonly name: string;
  readonly season: string;
  readonly status: string;
  readonly total_rosters: number;
  /** Slot order for every roster, e.g. ["QB","RB","RB","WR","WR","TE","FLEX","K","DEF","BN","BN","IR"]. */
  readonly roster_positions: readonly string[];
  /** waiver_type 2 means FAAB; waiver_budget is the season FAAB budget. */
  readonly settings?: Readonly<Record<string, number | null | undefined>>;
  /** e.g. { rec: 1 } for full PPR, { rec: 0.5 } for half PPR. */
  readonly scoring_settings?: Readonly<Record<string, number>>;
}

/** A league member as returned by /league/<id>/users. */
export interface SleeperLeagueUser {
  readonly user_id: string;
  readonly display_name: string;
  readonly metadata?: { readonly team_name?: string } | null;
}

export interface SleeperRoster {
  readonly roster_id: number;
  readonly owner_id: string | null;
  readonly players: readonly string[] | null;
  /** Aligned with the league's starting slots (roster_positions minus BN/IR/TAXI); "0" marks an empty slot. */
  readonly starters: readonly string[] | null;
  readonly reserve: readonly string[] | null;
  readonly taxi: readonly string[] | null;
  readonly settings?: Readonly<Record<string, number | null | undefined>>;
}

export interface SleeperMatchup {
  readonly roster_id: number;
  /** Rosters sharing a matchup_id play each other this week; null during a bye/median-only week. */
  readonly matchup_id: number | null;
  readonly points: number;
  readonly starters: readonly string[];
  readonly players: readonly string[];
}

export interface SleeperTransaction {
  readonly transaction_id: string;
  /** "waiver", "free_agent" or "trade". */
  readonly type: string;
  /** "complete", "failed", "pending", ... */
  readonly status: string;
  readonly roster_ids: readonly number[];
  /** player_id -> roster_id receiving the player. */
  readonly adds: Readonly<Record<string, number>> | null;
  /** player_id -> roster_id giving the player up. */
  readonly drops: Readonly<Record<string, number>> | null;
  /** Holds waiver_bid (FAAB dollars) on waiver transactions. */
  readonly settings: Readonly<Record<string, number>> | null;
  readonly created: number;
  readonly leg: number;
}

export interface SleeperDraft {
  readonly draft_id: string;
  readonly status: string;
  readonly type: string;
  readonly season: string;
}

export interface SleeperPlayer {
  readonly player_id: string;
  readonly full_name?: string;
  readonly first_name?: string;
  readonly last_name?: string;
  /** Primary position; "DEF" for team defenses. */
  readonly position: string | null;
  readonly fantasy_positions?: readonly string[] | null;
  readonly team: string | null;
  /** "Questionable", "Doubtful", "Out", "IR", "PUP", "Sus", "NA", or null when healthy. */
  readonly injury_status: string | null;
  readonly active?: boolean;
}

export type PlayerMap = Readonly<Record<string, SleeperPlayer>>;

export interface TrendingPlayer {
  readonly player_id: string;
  readonly count: number;
}

export interface NflState {
  readonly week: number;
  readonly display_week: number;
  readonly season: string;
  readonly league_season: string;
  readonly season_type: string;
}

/** One game from the undocumented schedule endpoint. */
export interface ScheduleGame {
  readonly week: number;
  readonly home: string;
  readonly away: string;
  readonly date: string;
  readonly status: string | null;
}

/** One player's projected stat line for a week, from the undocumented projections endpoint. */
export interface PlayerProjection {
  readonly player_id: string;
  readonly week: number;
  /** Sleeper stat keys, e.g. rec_yd, rush_yd, pass_yd, rec, pts_ppr, pts_half_ppr, pts_std. */
  readonly stats: Readonly<Record<string, number>>;
}

export type TrendingType = "add" | "drop";

export interface SleeperReadClient {
  /** Accepts a username or a user_id. Throws if no such user exists. */
  getUser(usernameOrId: string): Promise<SleeperUser>;
  getUserLeagues(userId: string, season: string): Promise<readonly SleeperLeague[]>;
  getLeague(leagueId: string): Promise<SleeperLeague>;
  getLeagueUsers(leagueId: string): Promise<readonly SleeperLeagueUser[]>;
  getRosters(leagueId: string): Promise<readonly SleeperRoster[]>;
  getMatchups(leagueId: string, week: number): Promise<readonly SleeperMatchup[]>;
  /** Transactions for one leg (week), including completed waiver claims with their FAAB bids. */
  getTransactions(leagueId: string, week: number): Promise<readonly SleeperTransaction[]>;
  getDrafts(leagueId: string): Promise<readonly SleeperDraft[]>;
  /** Every NFL player, keyed by player_id. ~5MB: implementations must cache it for a day. */
  getPlayers(): Promise<PlayerMap>;
  getTrending(type: TrendingType, options?: { readonly lookbackHours?: number; readonly limit?: number }): Promise<readonly TrendingPlayer[]>;
  getNflState(): Promise<NflState>;
  /** Undocumented endpoint. */
  getSchedule(season: string): Promise<readonly ScheduleGame[]>;
  /** Undocumented endpoint. */
  getProjections(season: string, week: number, positions: readonly string[]): Promise<readonly PlayerProjection[]>;
}

/** "Patrick Mahomes", falling back to first+last, then the id. Team defenses have no full_name. */
export function playerName(player: SleeperPlayer | undefined, playerId: string): string {
  if (!player) return playerId;
  if (player.full_name) return player.full_name;
  const joined = [player.first_name, player.last_name].filter(Boolean).join(" ");
  return joined || playerId;
}
