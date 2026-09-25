import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type {
  NflState,
  PlayerMap,
  PlayerProjection,
  ScheduleGame,
  SleeperDraft,
  SleeperLeague,
  SleeperLeagueUser,
  SleeperMatchup,
  SleeperPlayer,
  SleeperReadClient,
  SleeperRoster,
  SleeperTransaction,
  SleeperUser,
  TrendingPlayer,
  TrendingType,
} from "./client";

/**
 * The real Sleeper read client (ADR 0021), called directly with `fetch` — no
 * SDK dependency (ADR 0002). No credentials: the documented API is public
 * and read-only. Sleeper asks callers to stay under 1000 calls a minute and
 * to fetch /players/nfl at most once a day; both are enforced here.
 */
const DEFAULT_BASE_URL = "https://api.sleeper.app";
const DEFAULT_TIMEOUT_MS = 30_000;
/** Headroom under Sleeper's stated ~1000 calls/minute. */
const MAX_CALLS_PER_MINUTE = 900;
const ONE_DAY_MS = 24 * 60 * 60 * 1000;

export class SleeperAPIError extends Error {
  readonly statusCode: number;

  constructor(statusCode: number, detail: string) {
    super(`Sleeper API error (HTTP ${statusCode}): ${detail}`);
    this.name = "SleeperAPIError";
    this.statusCode = statusCode;
  }
}

/** Where the daily /players/nfl snapshot lives between runs. */
export interface PlayersCache {
  read(): Promise<{ readonly fetchedAt: number; readonly players: PlayerMap } | undefined>;
  write(fetchedAt: number, players: PlayerMap): Promise<void>;
}

/** Keeps the players snapshot in a local JSON file (under .orchestrator/, which is gitignored). */
export class JsonFilePlayersCache implements PlayersCache {
  constructor(private readonly path: string) {}

  async read(): Promise<{ fetchedAt: number; players: PlayerMap } | undefined> {
    try {
      const parsed = JSON.parse(await readFile(this.path, "utf-8")) as { fetchedAt?: unknown; players?: unknown };
      if (typeof parsed.fetchedAt !== "number" || typeof parsed.players !== "object" || parsed.players === null) return undefined;
      return { fetchedAt: parsed.fetchedAt, players: parsed.players as PlayerMap };
    } catch {
      return undefined;
    }
  }

  async write(fetchedAt: number, players: PlayerMap): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true });
    await writeFile(this.path, JSON.stringify({ fetchedAt, players }), "utf-8");
  }
}

export interface RealSleeperClientOptions {
  readonly baseUrl?: string;
  readonly timeoutMs?: number;
  readonly playersCache?: PlayersCache;
  readonly fetchImpl?: typeof fetch;
  readonly now?: () => number;
  readonly sleep?: (ms: number) => Promise<void>;
}

export function createRealSleeperClient(options: RealSleeperClientOptions = {}): SleeperReadClient {
  const baseUrl = options.baseUrl ?? DEFAULT_BASE_URL;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const fetchImpl = options.fetchImpl ?? fetch;
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const callTimes: number[] = [];
  let playersInMemory: { fetchedAt: number; players: PlayerMap } | undefined;

  async function throttle(): Promise<void> {
    const windowStart = now() - 60_000;
    while (callTimes.length > 0 && (callTimes[0] as number) < windowStart) callTimes.shift();
    if (callTimes.length >= MAX_CALLS_PER_MINUTE) {
      await sleep((callTimes[0] as number) - windowStart);
    }
    callTimes.push(now());
  }

  async function get<T>(path: string, query: Record<string, string | readonly string[]> = {}): Promise<T> {
    await throttle();
    const url = new URL(path, baseUrl);
    for (const [key, value] of Object.entries(query)) {
      if (typeof value === "string") url.searchParams.set(key, value);
      else for (const item of value) url.searchParams.append(key, item);
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let response: Response;
    try {
      response = await fetchImpl(url, { method: "GET", headers: { accept: "application/json" }, signal: controller.signal });
    } finally {
      clearTimeout(timer);
    }
    const text = await response.text();
    if (!response.ok) throw new SleeperAPIError(response.status, text || response.statusText);
    return (text ? JSON.parse(text) : null) as T;
  }

  return {
    async getUser(usernameOrId: string): Promise<SleeperUser> {
      const user = await get<SleeperUser | null>(`/v1/user/${encodeURIComponent(usernameOrId)}`);
      // Sleeper answers an unknown username with HTTP 200 and a null body.
      if (!user || !user.user_id) throw new Error(`No Sleeper user found for "${usernameOrId}". Check the username's spelling.`);
      return user;
    },

    async getUserLeagues(userId: string, season: string): Promise<readonly SleeperLeague[]> {
      return (await get<SleeperLeague[] | null>(`/v1/user/${encodeURIComponent(userId)}/leagues/nfl/${encodeURIComponent(season)}`)) ?? [];
    },

    async getLeague(leagueId: string): Promise<SleeperLeague> {
      const league = await get<SleeperLeague | null>(`/v1/league/${encodeURIComponent(leagueId)}`);
      if (!league) throw new Error(`No Sleeper league found with id "${leagueId}".`);
      return league;
    },

    async getLeagueUsers(leagueId: string): Promise<readonly SleeperLeagueUser[]> {
      return (await get<SleeperLeagueUser[] | null>(`/v1/league/${encodeURIComponent(leagueId)}/users`)) ?? [];
    },

    async getRosters(leagueId: string): Promise<readonly SleeperRoster[]> {
      return (await get<SleeperRoster[] | null>(`/v1/league/${encodeURIComponent(leagueId)}/rosters`)) ?? [];
    },

    async getMatchups(leagueId: string, week: number): Promise<readonly SleeperMatchup[]> {
      return (await get<SleeperMatchup[] | null>(`/v1/league/${encodeURIComponent(leagueId)}/matchups/${week}`)) ?? [];
    },

    async getTransactions(leagueId: string, week: number): Promise<readonly SleeperTransaction[]> {
      return (await get<SleeperTransaction[] | null>(`/v1/league/${encodeURIComponent(leagueId)}/transactions/${week}`)) ?? [];
    },

    async getDrafts(leagueId: string): Promise<readonly SleeperDraft[]> {
      return (await get<SleeperDraft[] | null>(`/v1/league/${encodeURIComponent(leagueId)}/drafts`)) ?? [];
    },

    async getPlayers(): Promise<PlayerMap> {
      const fresh = (snapshot: { fetchedAt: number } | undefined): boolean => snapshot !== undefined && now() - snapshot.fetchedAt < ONE_DAY_MS;
      if (fresh(playersInMemory)) return (playersInMemory as { players: PlayerMap }).players;
      const cached = await options.playersCache?.read();
      if (cached && fresh(cached)) {
        playersInMemory = { fetchedAt: cached.fetchedAt, players: cached.players };
        return cached.players;
      }
      const players = (await get<Record<string, SleeperPlayer> | null>("/v1/players/nfl")) ?? {};
      const fetchedAt = now();
      playersInMemory = { fetchedAt, players };
      await options.playersCache?.write(fetchedAt, players);
      return players;
    },

    async getTrending(type: TrendingType, trendingOptions: { lookbackHours?: number; limit?: number } = {}): Promise<readonly TrendingPlayer[]> {
      return (
        (await get<TrendingPlayer[] | null>(`/v1/players/nfl/trending/${type}`, {
          lookback_hours: String(trendingOptions.lookbackHours ?? 24),
          limit: String(trendingOptions.limit ?? 25),
        })) ?? []
      );
    },

    async getNflState(): Promise<NflState> {
      const state = await get<NflState | null>("/v1/state/nfl");
      if (!state) throw new Error("Sleeper returned no NFL state.");
      return state;
    },

    async getSchedule(season: string): Promise<readonly ScheduleGame[]> {
      return (await get<ScheduleGame[] | null>(`/schedule/nfl/regular/${encodeURIComponent(season)}`)) ?? [];
    },

    async getProjections(season: string, week: number, positions: readonly string[]): Promise<readonly PlayerProjection[]> {
      const rows =
        (await get<{ player_id: string; week: number; stats?: Record<string, number> | null }[] | null>(
          `/projections/nfl/${encodeURIComponent(season)}/${week}`,
          { season_type: "regular", "position[]": positions },
        )) ?? [];
      return rows.map((row) => ({ player_id: row.player_id, week: row.week, stats: row.stats ?? {} }));
    },
  };
}
