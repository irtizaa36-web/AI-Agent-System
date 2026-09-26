import { execFile } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import type { TrackerDocument } from "../types";
import { analyzeComps, type CompSearchRunner } from "./comps";

/**
 * SELLING — photo-first intake (ADR 0024). This is the PRIMARY selling entry
 * point; manual listing creation (listings.ts) is the fallback.
 *
 * Flow: Toozy uploads item photos in chat → the operating agent (Muse or
 * Claude Code) does the vision analysis and writes a JSON sidecar →
 * `marketplace selling intake --photos <paths...> --sidecar <draft.json>`
 * validates the draft and prints a one-tap approval summary → on his tap
 * (`--approve`) the CLI publishes via `facebook-cli marketplace listing
 * create` (publish gate: photos + condition + category + location), then
 * registers the listing in state and enables inquiry monitoring.
 *
 * Defaults from his established pattern (questions are rare — only ask what
 * photos truly can't answer):
 *   price firm unless he says OBO · Highland Village public-meetup pickup
 *   (29.74096, -95.44716) · cash or Venmo · no street address anywhere ·
 *   aggressive + authentic listing tone.
 */

export const DEFAULT_MEETUP = {
  label: "Highland Village area — public meetup",
  latitude: 29.74096,
  longitude: -95.44716,
} as const;

export const DEFAULT_PAYMENT = "cash or Venmo";

/** facebook-cli publish-gate condition values. */
export const FB_CONDITIONS = ["new", "used_like_new", "used_good", "used_fair", "used", "refurbished"] as const;
export type FbCondition = (typeof FB_CONDITIONS)[number];

/**
 * Sidecar written by the operating agent after vision analysis of the
 * chat-uploaded photos. The agent — not the CLI — judges condition from the
 * photos; the CLI requires it to be stated explicitly (never inferred here).
 */
export interface IntakeSidecar {
  readonly item: string;
  readonly brand?: string;
  readonly model?: string;
  /** facebook-cli condition enum value, from the agent's visual judgment. */
  readonly condition: string;
  readonly flaws: readonly string[];
  readonly suggestedTitle: string;
  readonly suggestedDescription: string;
  readonly suggestedPrice: number;
  readonly compBasis: string;
  readonly category?: string;
  readonly obo?: boolean;
}

export interface IntakeOverrides {
  readonly title?: string;
  readonly price?: number;
  readonly condition?: string;
  readonly category?: string;
  readonly obo?: boolean;
}

export interface IntakeDraft {
  readonly title: string;
  readonly price: number;
  readonly firm: boolean;
  readonly description: string;
  readonly condition: FbCondition;
  readonly category: string;
  readonly categoryAssumed: boolean;
  readonly latitude: number;
  readonly longitude: number;
  readonly photos: readonly string[];
  readonly payment: string;
  readonly meetup: string;
}

/** Address-leak guard shared with templates (no street address, ever). */
const ADDRESS_MARKERS = [/\bapt\.?\b/i, /apartment/i, /\bsuite\b/i, /\bunit\s*#?\s*\d/i, /westcreek/i];

export class IntakeError extends Error {}

/** Small keyword → facebook-cli category map. Guesses are flagged as assumptions. */
const CATEGORY_KEYWORDS: ReadonlyArray<readonly [RegExp, string]> = [
  [/chair|couch|sofa|table|desk|dresser|bed|shelf|lamp/i, "furniture"],
  [/iphone|phone|laptop|mac|keyboard|mouse|tv|monitor|console|headphone|speaker|camera/i, "electronics"],
  [/bike|bicycle/i, "bikes"],
  [/car|tesla|truck|tire|rim/i, "vehicles"],
  [/guitar|piano|drum/i, "instruments"],
  [/game|lego|toy/i, "toys"],
  [/shirt|jacket|shoe|dress|clothes/i, "clothing"],
  [/vacuum|bissell|appliance|microwave|fridge/i, "home"],
];

export function guessCategory(item: string): string {
  for (const [re, cat] of CATEGORY_KEYWORDS) if (re.test(item)) return cat;
  return "miscellaneous";
}

export function loadSidecar(path: string): IntakeSidecar {
  if (!existsSync(path)) throw new IntakeError(`Sidecar not found: ${path}`);
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf-8"));
  } catch (error) {
    throw new IntakeError(`Sidecar ${path} is not valid JSON (${(error as Error).message}).`);
  }
  return parsed as IntakeSidecar;
}

/** Validate photos + sidecar; returns errors (blockers) and warnings (assumptions). */
export function validateIntake(photos: readonly string[], sidecar: IntakeSidecar, overrides: IntakeOverrides = {}): { errors: string[]; warnings: string[] } {
  const errors: string[] = [];
  const warnings: string[] = [];
  if (photos.length === 0) errors.push("At least one photo is required (publish gate: photos).");
  for (const p of photos) if (!existsSync(p)) errors.push(`Photo not found: ${p}`);

  const title = overrides.title ?? sidecar.suggestedTitle;
  const price = overrides.price ?? sidecar.suggestedPrice;
  const condition = overrides.condition ?? sidecar.condition;
  if (!title || !title.trim()) errors.push("Sidecar needs suggestedTitle (or pass --title).");
  if (!(price > 0)) errors.push("Sidecar needs a positive suggestedPrice (or pass --price).");
  if (!condition) {
    errors.push("Sidecar needs condition (new|used_like_new|used_good|used_fair|used|refurbished) — the operating agent must state it from the photos; the CLI never infers it.");
  } else if (!(FB_CONDITIONS as readonly string[]).includes(condition)) {
    errors.push(`Unknown condition "${condition}". Must be one of: ${FB_CONDITIONS.join("|")}.`);
  }
  if (!sidecar.suggestedDescription || !sidecar.suggestedDescription.trim()) errors.push("Sidecar needs suggestedDescription.");
  if (!sidecar.compBasis || !sidecar.compBasis.trim()) warnings.push("No compBasis — price has no stated comp basis; confirm the price with Toozy.");
  const category = overrides.category ?? sidecar.category;
  if (!category) warnings.push(`No category in sidecar — assuming "${guessCategory(sidecar.item || title || "")}" from keywords; confirm on the approval summary.`);
  return { errors, warnings };
}

/** Terms footer: aggressive + authentic, firm price, public meetup, no address. */
export function termsFooter(firm: boolean, payment: string, meetup: string): string {
  return [
    firm ? "Price is firm — no lowballs." : "Open to reasonable offers.",
    `Pickup: public meetup in the ${meetup}.`,
    `${payment}.`,
    "First to pick up gets it — no holds without a deposit.",
  ].join(" ");
}

export function buildIntakeDraft(photos: readonly string[], sidecar: IntakeSidecar, overrides: IntakeOverrides = {}): IntakeDraft {
  const { errors } = validateIntake(photos, sidecar, overrides);
  if (errors.length > 0) throw new IntakeError(`Intake blocked:\n- ${errors.join("\n- ")}`);

  const title = (overrides.title ?? sidecar.suggestedTitle).trim();
  const price = overrides.price ?? sidecar.suggestedPrice;
  const firm = !(overrides.obo ?? sidecar.obo ?? false);
  const condition = (overrides.condition ?? sidecar.condition) as FbCondition;
  const categoryAssumed = !(overrides.category ?? sidecar.category);
  const category = categoryAssumed ? guessCategory(sidecar.item || title) : (overrides.category ?? sidecar.category)!;
  const meetup = DEFAULT_MEETUP.label;

  const flawLine = sidecar.flaws.length > 0 ? ` Flaws: ${sidecar.flaws.join("; ")}.` : "";
  const description = `${sidecar.suggestedDescription.trim()}${flawLine}\n\n${termsFooter(firm, DEFAULT_PAYMENT, meetup)}`;

  for (const marker of ADDRESS_MARKERS) {
    if (marker.test(title) || marker.test(description)) {
      throw new IntakeError(`Intake draft tripped the address-leak guard (${marker}). Remove address details.`);
    }
  }

  return {
    title, price, firm, description, condition, category, categoryAssumed,
    latitude: DEFAULT_MEETUP.latitude, longitude: DEFAULT_MEETUP.longitude,
    photos: [...photos], payment: DEFAULT_PAYMENT, meetup,
  };
}

/** One-tap approval summary: item, price, pickup terms + publish-gate checklist. */
export function approvalSummary(draft: IntakeDraft): string {
  const gate = [
    `photos: ✓ ${draft.photos.length} attached`,
    `condition: ✓ ${draft.condition}`,
    `category: ${draft.categoryAssumed ? `⚠ assumed "${draft.category}" — confirm` : `✓ ${draft.category}`}`,
    `location: ✓ ${DEFAULT_MEETUP.label} (${draft.latitude}, ${draft.longitude})`,
  ];
  return [
    "LISTING — approve to publish:",
    `  Title: ${draft.title}`,
    `  Price: $${draft.price}${draft.firm ? " firm" : " OBO"}`,
    `  Condition: ${draft.condition}`,
    `  Category: ${draft.category}${draft.categoryAssumed ? " (assumed)" : ""}`,
    `  Pickup: ${draft.meetup}`,
    `  Payment: ${draft.payment}`,
    `  Description: ${draft.description}`,
    `  Publish gate: ${gate.join(" · ")}`,
    "This WILL PUBLISH immediately on approval — all publish-gate fields are present.",
  ].join("\n");
}

export interface PublishResult {
  readonly fbListingId?: string;
  readonly message: string;
  readonly live: boolean;
}

/** Runs `facebook-cli marketplace listing create`. Injected so tests never publish. */
export type FacebookCliRunner = (args: readonly string[]) => Promise<string>;

export function realFacebookCliRunner(args: readonly string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile("facebook-cli", [...args], { timeout: 120_000, maxBuffer: 8 * 1024 * 1024 }, (error, stdout, stderr) => {
      if (error) reject(new Error(`facebook-cli failed: ${stderr || error.message}`));
      else resolve(stdout);
    });
  });
}

function parseCreateResponse(stdout: string): { listingId?: string; message: string; productUrl?: string } {
  try {
    const parsed = JSON.parse(stdout);
    const data = parsed?.data ?? parsed;
    return {
      listingId: data?.listing_id ? String(data.listing_id) : undefined,
      message: String(data?.message ?? parsed?.message ?? stdout).slice(0, 300),
      productUrl: data?.product_url ? String(data.product_url) : undefined,
    };
  } catch {
    return { message: stdout.slice(0, 300) };
  }
}

/**
 * Publish an approved draft. MUST only be called after Toozy's one-tap
 * approval of the summary (CLI enforces via --approve).
 */
export async function publishApproved(draft: IntakeDraft, runner: FacebookCliRunner = realFacebookCliRunner): Promise<PublishResult> {
  const args: string[] = [
    "marketplace", "listing", "create",
    "--title", draft.title,
    "--price", String(draft.price),
    "--description", draft.description,
    "--condition", draft.condition,
    "--category", draft.category,
    "--latitude", String(draft.latitude),
    "--longitude", String(draft.longitude),
    "--delivery-type", "public_meetup",
  ];
  for (const photo of draft.photos) args.push("--photo", photo);
  const stdout = await runner(args);
  const parsed = parseCreateResponse(stdout);
  const live = /publish/i.test(parsed.message) && !/draft/i.test(parsed.message);
  return { fbListingId: parsed.listingId, message: parsed.message, live };
}

/** Verify the Messenger companion is ready for buyer inquiries after publish. */
export function messengerCheckRunner(): Promise<string> {
  return new Promise((resolve) => {
    execFile("hatch_messenger_cli", ["check"], { timeout: 60_000 }, (_e, stdout) => resolve(stdout));
  });
}

/**
 * Comp-based auto-pricing. Pulls live comparable listings for the item and
 * proposes the list price from the comp distribution; falls back to the
 * sidecar price when the search finds nothing (never a guess). The CLI shows
 * the basis on the approval summary — one tap, no pricing questions.
 */
export async function resolveIntakePrice(
  sidecar: IntakeSidecar,
  runner?: CompSearchRunner,
): Promise<{ price: number; compBasis: string; fromComps: boolean }> {
  const analysis = await analyzeComps(sidecar.brand ? `${sidecar.brand} ${sidecar.item}` : sidecar.item, runner);
  if (analysis.suggestedPrice !== undefined) {
    return { price: analysis.suggestedPrice, compBasis: analysis.basis, fromComps: true };
  }
  return { price: sidecar.suggestedPrice, compBasis: `${sidecar.compBasis || "sidecar price"} (${analysis.basis})`, fromComps: false };
}
