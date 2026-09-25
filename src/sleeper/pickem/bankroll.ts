/**
 * The owner's Sleeper Picks bankroll and staking rules (ADR 0021). Pure: no
 * I/O. The rules are the owner's own, fixed in code rather than left to a
 * model's judgment:
 *
 * - Starting bankroll $15.
 * - Standard plays stake $3–$4.
 * - High-conviction plays stake up to 50% of the current bankroll — never
 *   more, and never the whole bankroll.
 * - At most 2 plays a day (the owner may choose 1).
 * - On a weak day (no play clears the conviction bar), skip.
 *
 * Sleeper Picks has no API. Nothing in this module or anywhere in this
 * project places an entry: the owner places every entry by hand in the app.
 */

export const STAKING_RULES = {
  startingBankroll: 15,
  standardMinStake: 3,
  standardMaxStake: 4,
  highConvictionMaxFraction: 0.5,
  /** Sleeper's smallest entry, used as the floor for a high-conviction stake. */
  minEntry: 1,
  maxPlaysPerDay: 2,
} as const;

export type Conviction = "standard" | "high";
export type EntryStatus = "open" | "won" | "lost" | "void";

/** What the bankroll needs to know about a logged entry. */
export interface LedgerEntry {
  readonly stake: number;
  readonly status: EntryStatus;
  /** Total returned by Sleeper when settled (stake included). 0 for a loss, the stake for a void. */
  readonly payout?: number;
  /** YYYY-MM-DD, the day the owner placed it. */
  readonly placedOn: string;
}

export interface BankrollState {
  readonly starting: number;
  /** Money not tied up in open entries: starting − all stakes + all settled payouts. */
  readonly available: number;
  /** Stakes on entries that haven't settled yet. */
  readonly openExposure: number;
  /** Settled profit or loss so far. */
  readonly realizedPnl: number;
  readonly settledCount: number;
  readonly openCount: number;
}

const cents = (n: number): number => Math.round(n * 100) / 100;

export function computeBankroll(entries: readonly LedgerEntry[], starting: number = STAKING_RULES.startingBankroll): BankrollState {
  let available = starting;
  let openExposure = 0;
  let realizedPnl = 0;
  let settledCount = 0;
  for (const e of entries) {
    available -= e.stake;
    if (e.status === "open") {
      openExposure += e.stake;
      continue;
    }
    const payout = e.status === "void" ? e.stake : e.status === "lost" ? 0 : (e.payout ?? 0);
    available += payout;
    realizedPnl += payout - e.stake;
    settledCount++;
  }
  return {
    starting,
    available: cents(available),
    openExposure: cents(openExposure),
    realizedPnl: cents(realizedPnl),
    settledCount,
    openCount: entries.length - settledCount,
  };
}

export function playsOn(entries: readonly LedgerEntry[], day: string): number {
  return entries.filter((e) => e.placedOn === day).length;
}

export type StakeDecision = { readonly ok: true; readonly stake: number; readonly note: string } | { readonly ok: false; readonly reason: string };

/**
 * Decides the stake for one play under the owner's rules. With no
 * `requestedStake` it recommends one; with one, it checks it. The
 * high-conviction limit is 50% of what's available now, so it can never be
 * the whole bankroll.
 */
export function decideStake(input: {
  readonly conviction: Conviction;
  readonly available: number;
  readonly playsToday: number;
  readonly requestedStake?: number;
  /** The owner's chosen daily limit: 1 or 2. Defaults to 2. */
  readonly maxPlaysToday?: number;
}): StakeDecision {
  const maxPlays = Math.min(STAKING_RULES.maxPlaysPerDay, Math.max(1, input.maxPlaysToday ?? STAKING_RULES.maxPlaysPerDay));
  if (input.playsToday >= maxPlays) {
    return { ok: false, reason: `Already ${input.playsToday} play(s) today; the limit is ${maxPlays}. Skip until tomorrow.` };
  }
  const available = cents(input.available);
  const requested = input.requestedStake;
  if (requested !== undefined && !(Number.isFinite(requested) && requested > 0)) {
    return { ok: false, reason: "The stake must be a positive dollar amount." };
  }

  if (input.conviction === "standard") {
    if (available < STAKING_RULES.standardMinStake) {
      return { ok: false, reason: `Only $${available.toFixed(2)} available — below the $${STAKING_RULES.standardMinStake} standard stake. Stop and reassess.` };
    }
    // $3 while the bankroll is small, $4 once 20% of it covers $4.
    const recommended = Math.min(STAKING_RULES.standardMaxStake, Math.max(STAKING_RULES.standardMinStake, Math.floor(available * 0.2)));
    const stake = requested ?? recommended;
    if (stake < STAKING_RULES.standardMinStake || stake > STAKING_RULES.standardMaxStake) {
      return { ok: false, reason: `Standard plays stake $${STAKING_RULES.standardMinStake}–$${STAKING_RULES.standardMaxStake}; $${stake.toFixed(2)} is outside that.` };
    }
    if (stake > available) return { ok: false, reason: `$${stake.toFixed(2)} is more than the $${available.toFixed(2)} available.` };
    if (stake === available) return { ok: false, reason: `$${stake.toFixed(2)} would be the whole bankroll. Never stake 100%.` };
    return { ok: true, stake: cents(stake), note: `Standard play: $${stake.toFixed(2)} of $${available.toFixed(2)} available.` };
  }

  const cap = Math.floor(available * STAKING_RULES.highConvictionMaxFraction * 100) / 100;
  if (cap < STAKING_RULES.minEntry) {
    return { ok: false, reason: `50% of the $${available.toFixed(2)} available is below Sleeper's $${STAKING_RULES.minEntry} minimum entry.` };
  }
  const stake = requested ?? cap;
  if (stake > cap) {
    return { ok: false, reason: `High-conviction plays are capped at 50% of the bankroll: $${cap.toFixed(2)} of $${available.toFixed(2)}. $${stake.toFixed(2)} is over.` };
  }
  if (stake < STAKING_RULES.minEntry) return { ok: false, reason: `Sleeper's minimum entry is $${STAKING_RULES.minEntry}.` };
  return { ok: true, stake: cents(stake), note: `High-conviction play: $${stake.toFixed(2)} (cap $${cap.toFixed(2)} = 50% of $${available.toFixed(2)}).` };
}
