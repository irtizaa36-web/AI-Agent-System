/**
 * Karen upgrade config (ADR 0024 addendum). Code defaults live here; the
 * owner may override any of them in `.orchestrator/marketplace/config.json`
 * (gitignored, local only). Per-listing values (floorPrice, holdTimeoutHours)
 * live on the listing and win over these defaults.
 *
 * Nothing here enables a feature by itself: every switch that changes
 * prices on its own (stale auto-drop) defaults to OFF.
 */

import { existsSync, readFileSync } from "node:fs";

export interface NegotiationConfig {
  /** Offers less than this fraction below asking get a polite hold (no counter). */
  readonly holdBelowFraction: number;
  /** Offers at or beyond this fraction below asking are declined without a counter. */
  readonly declineAtFraction: number;
  /** Counter rounds without agreement before the agent stops and escalates to the owner. */
  readonly maxCounterRounds: number;
}

export interface QueueConfig {
  /** Default hours an unconfirmed pickup-slot hold lives before the queue auto-advances. */
  readonly holdTimeoutHours: number;
}

export interface OwnerActivityConfig {
  /** Minutes after an owner-sent message during which the agent is watch-only on that thread. */
  readonly watchOnlyMinutes: number;
}

export interface RentalConfig {
  /** Refundable deposit required before any booking is confirmed (listing terms win when set). */
  readonly deposit: number;
  readonly depositMethods: readonly string[];
  /** Public pickup area; the agent never delivers, meets elsewhere, or ships. */
  readonly pickupArea: string;
}

export interface IntakeConfig {
  /** Identification confidence (0..1) below which intake asks clarifying questions instead of drafting. */
  readonly minConfidence: number;
  /** Most clarifying questions asked in one go. */
  readonly maxQuestions: number;
}

export interface StaleDropConfig {
  /** OFF by default. The mechanism exists; the owner turns it on. */
  readonly enabled: boolean;
  /** Days with no inquiries (and no earlier drop) before a listing is stale. */
  readonly daysStale: number;
  /** Percent to cut from the current price per drop. */
  readonly dropPercent: number;
  /** Lowest price as a fraction of the original price, used when a listing has no floorPrice. */
  readonly floorFraction: number;
}

export interface KarenConfig {
  readonly negotiation: NegotiationConfig;
  readonly queue: QueueConfig;
  readonly ownerActivity: OwnerActivityConfig;
  readonly rental: RentalConfig;
  readonly intake: IntakeConfig;
  readonly staleDrop: StaleDropConfig;
}

export const DEFAULT_CONFIG: KarenConfig = {
  negotiation: { holdBelowFraction: 0.1, declineAtFraction: 0.25, maxCounterRounds: 2 },
  queue: { holdTimeoutHours: 12 },
  ownerActivity: { watchOnlyMinutes: 60 },
  rental: { deposit: 30, depositMethods: ["Venmo", "Zelle", "cash at pickup"], pickupArea: "Highland Village area" },
  intake: { minConfidence: 0.7, maxQuestions: 2 },
  staleDrop: { enabled: false, daysStale: 7, dropPercent: 10, floorFraction: 0.7 },
};

export type ConfigOverrides = { readonly [K in keyof KarenConfig]?: Partial<KarenConfig[K]> };

export class ConfigError extends Error {}

/** Merge overrides onto the defaults, section by section, and sanity-check the result. */
export function resolveConfig(overrides: ConfigOverrides = {}): KarenConfig {
  const config: KarenConfig = {
    negotiation: { ...DEFAULT_CONFIG.negotiation, ...overrides.negotiation },
    queue: { ...DEFAULT_CONFIG.queue, ...overrides.queue },
    ownerActivity: { ...DEFAULT_CONFIG.ownerActivity, ...overrides.ownerActivity },
    rental: { ...DEFAULT_CONFIG.rental, ...overrides.rental },
    intake: { ...DEFAULT_CONFIG.intake, ...overrides.intake },
    staleDrop: { ...DEFAULT_CONFIG.staleDrop, ...overrides.staleDrop },
  };
  const n = config.negotiation;
  if (!(n.holdBelowFraction > 0 && n.holdBelowFraction < n.declineAtFraction && n.declineAtFraction < 1)) {
    throw new ConfigError("negotiation: need 0 < holdBelowFraction < declineAtFraction < 1.");
  }
  if (!(Number.isInteger(n.maxCounterRounds) && n.maxCounterRounds >= 1)) throw new ConfigError("negotiation.maxCounterRounds must be a positive integer.");
  if (!(config.queue.holdTimeoutHours > 0)) throw new ConfigError("queue.holdTimeoutHours must be positive.");
  if (!(config.ownerActivity.watchOnlyMinutes > 0)) throw new ConfigError("ownerActivity.watchOnlyMinutes must be positive.");
  if (!(config.rental.deposit > 0)) throw new ConfigError("rental.deposit must be positive.");
  const s = config.staleDrop;
  if (typeof s.enabled !== "boolean") throw new ConfigError("staleDrop.enabled must be true or false.");
  if (!(s.daysStale > 0 && s.dropPercent > 0 && s.dropPercent < 100 && s.floorFraction > 0 && s.floorFraction <= 1)) {
    throw new ConfigError("staleDrop: need daysStale > 0, 0 < dropPercent < 100, 0 < floorFraction <= 1.");
  }
  return config;
}

/** Load overrides from a local JSON file. Missing file → defaults; unreadable file → ConfigError (never a silent reset). */
export function loadConfig(path: string): KarenConfig {
  if (!existsSync(path)) return DEFAULT_CONFIG;
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf-8"));
  } catch (error) {
    throw new ConfigError(`Marketplace config ${path} is not valid JSON (${(error as Error).message}).`);
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw new ConfigError(`Marketplace config ${path} must be a JSON object.`);
  return resolveConfig(parsed as ConfigOverrides);
}
