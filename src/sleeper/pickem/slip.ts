import { createHash } from "node:crypto";
import { computeBankroll, decideStake, playsOn, type Conviction, type LedgerEntry } from "./bankroll";
import type { LineGrade } from "./research";

/**
 * The pick slip generator (ADR 0021). It writes out exactly what the owner
 * should enter by hand in the Sleeper app. It cannot enter it: Sleeper Picks
 * has no API, documented or not, and this project never automates the app.
 * A slip is only a proposal; it affects the bankroll once the owner logs it
 * as placed (`orchestrator sleeper pickem log`).
 */

/**
 * Sleeper Picks entries need at least 2 picks. The upper bound is this
 * project's own conservative limit, not a Sleeper rule; confirm what the app
 * allows.
 */
export const SLIP_PICK_LIMITS = { min: 2, max: 6 } as const;

export interface SlipPick {
  readonly player: string;
  readonly playerId?: string;
  readonly position?: string;
  readonly team?: string;
  /** Sleeper stat key or a plain name, e.g. "rec_yd" or "receiving yards". */
  readonly stat: string;
  readonly line: number;
  readonly direction: "more" | "less";
  readonly projection?: number;
  readonly edgePct?: number;
  /** The research grade, when the pick came from pickem-research-line. */
  readonly grade?: LineGrade;
}

export interface PickemSlip {
  readonly id: string;
  readonly createdAt: string;
  /** YYYY-MM-DD the slip is meant for. */
  readonly day: string;
  readonly conviction: Conviction;
  readonly stake: number;
  readonly picks: readonly SlipPick[];
  readonly availableBefore: number;
}

export type SlipResult = { readonly ok: true; readonly slip: PickemSlip; readonly text: string } | { readonly ok: false; readonly reason: string };

/** Validates untrusted picks (a Model's tool input or a JSON file). */
export function parseSlipPicks(value: unknown): { ok: true; picks: SlipPick[] } | { ok: false; error: string } {
  if (!Array.isArray(value)) return { ok: false, error: '"picks" must be an array' };
  const picks: SlipPick[] = [];
  for (const [i, raw] of value.entries()) {
    if (typeof raw !== "object" || raw === null) return { ok: false, error: `pick ${i + 1} must be an object` };
    const p = raw as Record<string, unknown>;
    if (typeof p["player"] !== "string" || !p["player"].trim()) return { ok: false, error: `pick ${i + 1}: "player" is required` };
    if (typeof p["stat"] !== "string" || !p["stat"].trim()) return { ok: false, error: `pick ${i + 1}: "stat" is required` };
    if (typeof p["line"] !== "number" || !(p["line"] > 0)) return { ok: false, error: `pick ${i + 1}: "line" must be a positive number` };
    if (p["direction"] !== "more" && p["direction"] !== "less") return { ok: false, error: `pick ${i + 1}: "direction" must be "more" or "less"` };
    const grade = p["grade"];
    if (grade !== undefined && grade !== "high" && grade !== "standard" && grade !== "weak") {
      return { ok: false, error: `pick ${i + 1}: "grade" must be high, standard or weak` };
    }
    const optionalString = (key: string): Record<string, string> => (typeof p[key] === "string" ? { [key]: p[key] as string } : {});
    const optionalNumber = (key: string): Record<string, number> => (typeof p[key] === "number" ? { [key]: p[key] as number } : {});
    picks.push({
      player: p["player"].trim(),
      stat: p["stat"].trim(),
      line: p["line"],
      direction: p["direction"],
      ...optionalString("playerId"),
      ...optionalString("position"),
      ...optionalString("team"),
      ...optionalNumber("projection"),
      ...optionalNumber("edgePct"),
      ...(grade !== undefined ? { grade: grade as LineGrade } : {}),
    });
  }
  return { ok: true, picks };
}

export function buildSlip(input: {
  readonly picks: readonly SlipPick[];
  readonly conviction: Conviction;
  readonly requestedStake?: number;
  readonly ledger: readonly LedgerEntry[];
  readonly day: string;
  readonly now?: Date;
  readonly maxPlaysToday?: number;
}): SlipResult {
  const { picks } = input;
  if (picks.length < SLIP_PICK_LIMITS.min || picks.length > SLIP_PICK_LIMITS.max) {
    return { ok: false, reason: `A slip needs ${SLIP_PICK_LIMITS.min}–${SLIP_PICK_LIMITS.max} picks; got ${picks.length}.` };
  }
  const keys = picks.map((p) => (p.playerId ?? p.player).toLowerCase());
  if (new Set(keys).size !== keys.length) return { ok: false, reason: "Each player may appear only once on a slip." };
  const weak = picks.filter((p) => p.grade === "weak");
  if (weak.length > 0) return { ok: false, reason: `Weak picks don't get played: ${weak.map((p) => p.player).join(", ")}. On a weak day, skip.` };
  if (input.conviction === "high" && picks.some((p) => p.grade !== undefined && p.grade !== "high")) {
    return { ok: false, reason: "A high-conviction slip needs every graded pick to be graded high. Use a standard stake instead." };
  }

  const bankroll = computeBankroll(input.ledger);
  const decision = decideStake({
    conviction: input.conviction,
    available: bankroll.available,
    playsToday: playsOn(input.ledger, input.day),
    ...(input.requestedStake !== undefined ? { requestedStake: input.requestedStake } : {}),
    ...(input.maxPlaysToday !== undefined ? { maxPlaysToday: input.maxPlaysToday } : {}),
  });
  if (!decision.ok) return { ok: false, reason: decision.reason };

  const createdAt = (input.now ?? new Date()).toISOString();
  const body = { day: input.day, conviction: input.conviction, stake: decision.stake, picks };
  const id = `slip-${createHash("sha256").update(JSON.stringify(body)).digest("hex").slice(0, 10)}`;
  const slip: PickemSlip = { id, createdAt, ...body, availableBefore: bankroll.available };
  return { ok: true, slip, text: formatSlip(slip, decision.note) };
}

export function formatSlip(slip: PickemSlip, stakeNote?: string): string {
  const pickLine = (p: SlipPick, i: number): string =>
    `  ${i + 1}. ${p.player}${p.position || p.team ? ` (${[p.position, p.team].filter(Boolean).join(", ")})` : ""}` +
    ` — ${p.direction.toUpperCase()} than ${p.line} ${p.stat}` +
    `${p.projection !== undefined ? ` — proj ${p.projection}` : ""}${p.edgePct !== undefined ? `, edge ${p.edgePct > 0 ? "+" : ""}${p.edgePct}%` : ""}`;
  return [
    "SLEEPER PICKS SLIP — MANUAL ENTRY ONLY",
    "This agent cannot place entries and has not placed this one. Enter it yourself in the Sleeper app.",
    `slipId:${slip.id}`,
    `day:${slip.day}`,
    `conviction:${slip.conviction}`,
    `stake:$${slip.stake.toFixed(2)}`,
    `availableBefore:$${slip.availableBefore.toFixed(2)}`,
    `availableAfter:$${(slip.availableBefore - slip.stake).toFixed(2)}`,
    ...(stakeNote ? [`stakeRule:${stakeNote}`] : []),
    `picks (${slip.picks.length}):`,
    ...slip.picks.map(pickLine),
    "Before you submit in the app: check every line still matches, the stake is exactly the one above, and note the payout multiplier the app shows.",
    `After you place it: orchestrator sleeper pickem log ${slip.id} --multiplier <the multiplier the app showed>`,
    "If you don't place it, do nothing: an unlogged slip never touches the bankroll.",
  ].join("\n");
}
