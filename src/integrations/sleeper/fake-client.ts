import type {
  NflState,
  PlayerMap,
  PlayerProjection,
  ScheduleGame,
  SleeperDraft,
  SleeperLeague,
  SleeperLeagueUser,
  SleeperMatchup,
  SleeperReadClient,
  SleeperRoster,
  SleeperTransaction,
  SleeperUser,
  TrendingPlayer,
  TrendingType,
} from "./client";

export interface FakeSleeperData {
  readonly users?: readonly SleeperUser[];
  readonly leagues?: readonly SleeperLeague[];
  /** Which leagues each user_id belongs to. */
  readonly memberships?: Readonly<Record<string, readonly string[]>>;
  readonly leagueUsers?: Readonly<Record<string, readonly SleeperLeagueUser[]>>;
  readonly rosters?: Readonly<Record<string, readonly SleeperRoster[]>>;
  /** Keyed by `${leagueId}:${week}`. */
  readonly matchups?: Readonly<Record<string, readonly SleeperMatchup[]>>;
  /** Keyed by `${leagueId}:${week}`. */
  readonly transactions?: Readonly<Record<string, readonly SleeperTransaction[]>>;
  readonly players?: PlayerMap;
  readonly trendingAdds?: readonly TrendingPlayer[];
  readonly trendingDrops?: readonly TrendingPlayer[];
  readonly nflState?: NflState;
  readonly schedule?: readonly ScheduleGame[];
  /** Keyed by week. */
  readonly projections?: Readonly<Record<number, readonly PlayerProjection[]>>;
  /** When true, the two undocumented endpoints throw, as they might if Sleeper changes them. */
  readonly undocumentedEndpointsDown?: boolean;
}

/** An in-memory SleeperReadClient for tests: records every call, never touches the network. */
export class FakeSleeperClient implements SleeperReadClient {
  public readonly calls: string[] = [];

  constructor(private readonly data: FakeSleeperData = {}) {}

  async getUser(usernameOrId: string): Promise<SleeperUser> {
    this.calls.push(`getUser:${usernameOrId}`);
    const needle = usernameOrId.toLowerCase();
    const user = (this.data.users ?? []).find((u) => u.username.toLowerCase() === needle || u.user_id === usernameOrId);
    if (!user) throw new Error(`No Sleeper user found for "${usernameOrId}". Check the username's spelling.`);
    return user;
  }

  async getUserLeagues(userId: string, season: string): Promise<readonly SleeperLeague[]> {
    this.calls.push(`getUserLeagues:${userId}:${season}`);
    const ids = this.data.memberships?.[userId] ?? [];
    return (this.data.leagues ?? []).filter((l) => ids.includes(l.league_id) && l.season === season);
  }

  async getLeague(leagueId: string): Promise<SleeperLeague> {
    this.calls.push(`getLeague:${leagueId}`);
    const league = (this.data.leagues ?? []).find((l) => l.league_id === leagueId);
    if (!league) throw new Error(`No Sleeper league found with id "${leagueId}".`);
    return league;
  }

  async getLeagueUsers(leagueId: string): Promise<readonly SleeperLeagueUser[]> {
    this.calls.push(`getLeagueUsers:${leagueId}`);
    return this.data.leagueUsers?.[leagueId] ?? [];
  }

  async getRosters(leagueId: string): Promise<readonly SleeperRoster[]> {
    this.calls.push(`getRosters:${leagueId}`);
    return this.data.rosters?.[leagueId] ?? [];
  }

  async getMatchups(leagueId: string, week: number): Promise<readonly SleeperMatchup[]> {
    this.calls.push(`getMatchups:${leagueId}:${week}`);
    return this.data.matchups?.[`${leagueId}:${week}`] ?? [];
  }

  async getTransactions(leagueId: string, week: number): Promise<readonly SleeperTransaction[]> {
    this.calls.push(`getTransactions:${leagueId}:${week}`);
    return this.data.transactions?.[`${leagueId}:${week}`] ?? [];
  }

  async getDrafts(leagueId: string): Promise<readonly SleeperDraft[]> {
    this.calls.push(`getDrafts:${leagueId}`);
    return [];
  }

  async getPlayers(): Promise<PlayerMap> {
    this.calls.push("getPlayers");
    return this.data.players ?? {};
  }

  async getTrending(type: TrendingType, options: { lookbackHours?: number; limit?: number } = {}): Promise<readonly TrendingPlayer[]> {
    this.calls.push(`getTrending:${type}`);
    const list = (type === "add" ? this.data.trendingAdds : this.data.trendingDrops) ?? [];
    return list.slice(0, options.limit ?? 25);
  }

  async getNflState(): Promise<NflState> {
    this.calls.push("getNflState");
    return this.data.nflState ?? { week: 1, display_week: 1, season: "2026", league_season: "2026", season_type: "regular" };
  }

  async getSchedule(season: string): Promise<readonly ScheduleGame[]> {
    this.calls.push(`getSchedule:${season}`);
    if (this.data.undocumentedEndpointsDown) throw new Error("Sleeper API error (HTTP 404): not found");
    return this.data.schedule ?? [];
  }

  async getProjections(season: string, week: number, positions: readonly string[]): Promise<readonly PlayerProjection[]> {
    this.calls.push(`getProjections:${season}:${week}:${positions.join(",")}`);
    if (this.data.undocumentedEndpointsDown) throw new Error("Sleeper API error (HTTP 404): not found");
    return this.data.projections?.[week] ?? [];
  }
}
