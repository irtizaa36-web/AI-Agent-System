import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { STAKING_RULES, playsOn, type Conviction, type EntryStatus, type LedgerEntry } from "./bankroll";
import type { PickemSlip, SlipPick } from "./slip";

/**
 * The manual entry log (ADR 0021): generated slips, and the entries the owner
 * says they placed by hand. It records what the owner reports. It never
 * reaches Sleeper, and an entry exists only because the owner logged it.
 */

export interface PickemEntry extends LedgerEntry {
  readonly id: string;
  readonly slipId: string;
  readonly conviction: Conviction;
  readonly picks: readonly SlipPick[];
  /** The payout multiplier the app showed when the owner placed it. */
  readonly multiplier: number;
  readonly loggedAt: string;
  readonly settledAt?: string;
}

export interface PickemStore {
  saveSlip(slip: PickemSlip): Promise<void>;
  getSlip(id: string): Promise<PickemSlip | undefined>;
  listEntries(): Promise<readonly PickemEntry[]>;
  saveEntry(entry: PickemEntry): Promise<void>;
}

interface StoreFile {
  slips: Record<string, PickemSlip>;
  entries: PickemEntry[];
}

export class InMemoryPickemStore implements PickemStore {
  private readonly data: StoreFile = { slips: {}, entries: [] };

  async saveSlip(slip: PickemSlip): Promise<void> {
    this.data.slips[slip.id] = slip;
  }
  async getSlip(id: string): Promise<PickemSlip | undefined> {
    return this.data.slips[id];
  }
  async listEntries(): Promise<readonly PickemEntry[]> {
    return [...this.data.entries];
  }
  async saveEntry(entry: PickemEntry): Promise<void> {
    const i = this.data.entries.findIndex((e) => e.id === entry.id);
    if (i >= 0) this.data.entries[i] = entry;
    else this.data.entries.push(entry);
  }
}

/** One JSON file under .orchestrator/ (gitignored): the bankroll is personal data and stays local. */
export class JsonFilePickemStore implements PickemStore {
  constructor(private readonly path: string) {}

  private async load(): Promise<StoreFile> {
    try {
      const parsed = JSON.parse(await readFile(this.path, "utf-8")) as Partial<StoreFile>;
      return { slips: parsed.slips ?? {}, entries: parsed.entries ?? [] };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return { slips: {}, entries: [] };
      throw error;
    }
  }

  private async persist(data: StoreFile): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true });
    const tmp = `${this.path}.tmp`;
    await writeFile(tmp, JSON.stringify(data, null, 2), "utf-8");
    await rename(tmp, this.path);
  }

  async saveSlip(slip: PickemSlip): Promise<void> {
    const data = await this.load();
    data.slips[slip.id] = slip;
    await this.persist(data);
  }
  async getSlip(id: string): Promise<PickemSlip | undefined> {
    return (await this.load()).slips[id];
  }
  async listEntries(): Promise<readonly PickemEntry[]> {
    return (await this.load()).entries;
  }
  async saveEntry(entry: PickemEntry): Promise<void> {
    const data = await this.load();
    const i = data.entries.findIndex((e) => e.id === entry.id);
    if (i >= 0) data.entries[i] = entry;
    else data.entries.push(entry);
    await this.persist(data);
  }
}

/**
 * Records that the owner placed a slip by hand. The log reflects reality, so
 * an entry over the daily limit is still recorded — with a warning, since
 * the rule was broken outside this tool.
 */
export async function logManualEntry(
  store: PickemStore,
  input: { readonly slipId: string; readonly multiplier: number; readonly placedOn?: string; readonly now?: Date },
): Promise<{ entry: PickemEntry; warnings: readonly string[] }> {
  const slip = await store.getSlip(input.slipId);
  if (!slip) throw new Error(`No slip "${input.slipId}". Generate it first with pickem slip.`);
  if (!(Number.isFinite(input.multiplier) && input.multiplier > 1)) throw new Error("--multiplier must be the payout multiplier the app showed (greater than 1).");
  const entries = await store.listEntries();
  if (entries.some((e) => e.slipId === slip.id)) throw new Error(`Slip ${slip.id} is already logged.`);
  const placedOn = input.placedOn ?? slip.day;
  const warnings = playsOn(entries, placedOn) >= STAKING_RULES.maxPlaysPerDay ? [`This is play ${playsOn(entries, placedOn) + 1} on ${placedOn}, over the ${STAKING_RULES.maxPlaysPerDay}-a-day rule.`] : [];
  const entry: PickemEntry = {
    id: `entry-${slip.id.replace(/^slip-/, "")}`,
    slipId: slip.id,
    conviction: slip.conviction,
    picks: slip.picks,
    stake: slip.stake,
    multiplier: input.multiplier,
    status: "open",
    placedOn,
    loggedAt: (input.now ?? new Date()).toISOString(),
  };
  await store.saveEntry(entry);
  return { entry, warnings };
}

/** Records how an entry settled. A win pays stake × multiplier unless the owner gives the actual payout. */
export async function settleEntry(
  store: PickemStore,
  input: { readonly entryId: string; readonly result: Exclude<EntryStatus, "open">; readonly payout?: number; readonly now?: Date },
): Promise<PickemEntry> {
  const entry = (await store.listEntries()).find((e) => e.id === input.entryId);
  if (!entry) throw new Error(`No logged entry "${input.entryId}".`);
  if (entry.status !== "open") throw new Error(`Entry ${entry.id} already settled as ${entry.status}.`);
  if (input.payout !== undefined && !(Number.isFinite(input.payout) && input.payout >= 0)) throw new Error("--payout must be 0 or more.");
  const payout =
    input.result === "won" ? (input.payout ?? Math.round(entry.stake * entry.multiplier * 100) / 100) : input.result === "void" ? entry.stake : 0;
  const settled: PickemEntry = { ...entry, status: input.result, payout, settledAt: (input.now ?? new Date()).toISOString() };
  await store.saveEntry(settled);
  return settled;
}
