import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { JsonFilePlayersCache, SleeperAPIError, createRealSleeperClient, type PlayersCache } from "./real-client";
import type { PlayerMap } from "./client";

/** A fetch stand-in that answers from a table keyed by path+query and records every URL. No network. */
function fakeFetch(routes: Record<string, { status?: number; body: unknown }>): { fetchImpl: typeof fetch; urls: string[] } {
  const urls: string[] = [];
  const fetchImpl = (async (input: string | URL | Request) => {
    const url = new URL(String(input));
    urls.push(`${url.pathname}${url.search}`);
    const route = routes[url.pathname];
    if (!route) return new Response("not found", { status: 404 });
    return new Response(JSON.stringify(route.body), { status: route.status ?? 200 });
  }) as typeof fetch;
  return { fetchImpl, urls };
}

class MemoryCache implements PlayersCache {
  writes = 0;
  constructor(public snapshot?: { fetchedAt: number; players: PlayerMap }) {}
  async read() {
    return this.snapshot;
  }
  async write(fetchedAt: number, players: PlayerMap) {
    this.writes++;
    this.snapshot = { fetchedAt, players };
  }
}

test("getUser resolves a username, and an unknown username (HTTP 200 + null) is a clear error", async () => {
  const { fetchImpl, urls } = fakeFetch({
    "/v1/user/owner_one": { body: { user_id: "100", username: "owner_one", display_name: "Owner One" } },
    "/v1/user/nobody": { body: null },
  });
  const client = createRealSleeperClient({ fetchImpl });
  assert.equal((await client.getUser("owner_one")).user_id, "100");
  await assert.rejects(client.getUser("nobody"), /No Sleeper user found for "nobody"/);
  assert.deepEqual(urls, ["/v1/user/owner_one", "/v1/user/nobody"]);
});

test("league endpoints hit the documented v1 paths", async () => {
  const { fetchImpl, urls } = fakeFetch({
    "/v1/user/100/leagues/nfl/2026": { body: [] },
    "/v1/league/1001/rosters": { body: [] },
    "/v1/league/1001/matchups/3": { body: [] },
    "/v1/league/1001/transactions/2": { body: [] },
    "/v1/league/1001/drafts": { body: [] },
    "/v1/players/nfl/trending/add": { body: [{ player_id: "41", count: 5 }] },
    "/v1/state/nfl": { body: { week: 3, display_week: 3, season: "2026", league_season: "2026", season_type: "regular" } },
  });
  const client = createRealSleeperClient({ fetchImpl });
  await client.getUserLeagues("100", "2026");
  await client.getRosters("1001");
  await client.getMatchups("1001", 3);
  await client.getTransactions("1001", 2);
  await client.getDrafts("1001");
  assert.deepEqual(await client.getTrending("add", { lookbackHours: 48, limit: 10 }), [{ player_id: "41", count: 5 }]);
  assert.equal((await client.getNflState()).week, 3);
  assert.deepEqual(urls, [
    "/v1/user/100/leagues/nfl/2026",
    "/v1/league/1001/rosters",
    "/v1/league/1001/matchups/3",
    "/v1/league/1001/transactions/2",
    "/v1/league/1001/drafts",
    "/v1/players/nfl/trending/add?lookback_hours=48&limit=10",
    "/v1/state/nfl",
  ]);
});

test("projections go to the undocumented endpoint with repeated position[] params", async () => {
  const { fetchImpl, urls } = fakeFetch({ "/projections/nfl/2026/3": { body: [{ player_id: "14", week: 3, stats: { rec_yd: 78.2 } }, { player_id: "15", week: 3, stats: null }] } });
  const rows = await createRealSleeperClient({ fetchImpl }).getProjections("2026", 3, ["WR", "TE"]);
  assert.deepEqual(rows, [
    { player_id: "14", week: 3, stats: { rec_yd: 78.2 } },
    { player_id: "15", week: 3, stats: {} },
  ]);
  assert.equal(urls[0], "/projections/nfl/2026/3?season_type=regular&position%5B%5D=WR&position%5B%5D=TE");
});

test("HTTP errors surface as SleeperAPIError", async () => {
  const { fetchImpl } = fakeFetch({ "/v1/league/1/rosters": { status: 500, body: "boom" } });
  await assert.rejects(createRealSleeperClient({ fetchImpl }).getRosters("1"), (e: unknown) => e instanceof SleeperAPIError && e.statusCode === 500);
});

test("the ~5MB players list is fetched at most once a day: memory, then disk cache, then network", async () => {
  let clock = 1_000_000;
  const players = { "14": { player_id: "14", full_name: "Wes Wideout", position: "WR", team: "DAL", injury_status: null } };
  const { fetchImpl, urls } = fakeFetch({ "/v1/players/nfl": { body: players } });

  // Fresh disk cache: no network at all.
  const warm = new MemoryCache({ fetchedAt: clock - 60_000, players });
  const cachedClient = createRealSleeperClient({ fetchImpl, playersCache: warm, now: () => clock });
  assert.deepEqual(await cachedClient.getPlayers(), players);
  assert.equal(urls.length, 0);

  // Stale disk cache: fetch once, write back, then serve from memory.
  const stale = new MemoryCache({ fetchedAt: clock - 25 * 60 * 60 * 1000, players: {} });
  const client = createRealSleeperClient({ fetchImpl, playersCache: stale, now: () => clock });
  await client.getPlayers();
  await client.getPlayers();
  assert.deepEqual(urls, ["/v1/players/nfl"]);
  assert.equal(stale.writes, 1);

  // A day later it refreshes.
  clock += 24 * 60 * 60 * 1000 + 1;
  await client.getPlayers();
  assert.equal(urls.length, 2);
});

test("JsonFilePlayersCache round-trips and treats a missing file as empty", async () => {
  const dir = await mkdtemp(join(tmpdir(), "sleeper-cache-"));
  try {
    const cache = new JsonFilePlayersCache(join(dir, "nested", "players.json"));
    assert.equal(await cache.read(), undefined);
    await cache.write(42, { "1": { player_id: "1", position: "QB", team: "KC", injury_status: null } });
    assert.equal((await cache.read())?.fetchedAt, 42);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("calls are throttled below Sleeper's ~1000/minute limit", async () => {
  let clock = 0;
  const sleeps: number[] = [];
  const { fetchImpl } = fakeFetch({ "/v1/league/1/rosters": { body: [] } });
  const client = createRealSleeperClient({
    fetchImpl,
    now: () => clock,
    sleep: async (ms) => {
      sleeps.push(ms);
      clock += ms;
    },
  });
  for (let i = 0; i < 901; i++) await client.getRosters("1");
  assert.equal(sleeps.length, 1, "the 901st call within a minute waits");
});
