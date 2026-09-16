import type { Preferences } from "./records";
import type { ScoringClient } from "./scoring-client";
import type { CostLedger } from "./cost";

/**
 * Stage 11 (new): a candidate's own reply, turned into two things — an
 * answer to whatever she asked, and a preferences.json patch for whatever
 * she asked to change. Per Irtiza's explicit call (Sep 16, asked and
 * confirmed, not assumed): applied automatically, with no approval step.
 * That removes the human review gate every other config change in this
 * project has gone through so far — it does NOT remove the "never guess a
 * value" rule the rest of the pipeline already lives by. Those are
 * different things: the first is about who signs off, the second is about
 * whether a wrong answer is worse than an honest "I couldn't tell." A
 * misread reply that silently changes what she sees for days is exactly
 * the failure mode two full days of this project were spent finding and
 * fixing (the title-matching bug, the alert-mail body bug) — so this stays
 * conservative about what it's willing to infer, even while skipping the
 * approval step on what it IS confident about.
 */

/** The only Preferences fields a reply is allowed to change. Deliberately excludes pipeline-mechanical fields (scoringModel, digestLimit, postingTokenBudget, ...) that aren't things a candidate has an opinion about — narrowing the field list is itself a safety measure, independent of the prompt. */
export const ALLOWED_PATCH_FIELDS = [
  "titles",
  "titleExclusions",
  "salaryFloor",
  "remoteOnly",
  "metros",
  "locationPriority",
  "experienceYearsFloor",
  "experienceYearsCeiling",
  "maxPostingAgeDays",
  "usRemoteOnly",
  "industryExclusions",
  "companyExclusions",
  "scoreCutoff",
] as const;

export type AllowedPatchField = (typeof ALLOWED_PATCH_FIELDS)[number];

function isAllowedField(value: string): value is AllowedPatchField {
  return (ALLOWED_PATCH_FIELDS as readonly string[]).includes(value);
}

/** One field change the model proposed, with the part of her message it says justifies it — kept so a human reviewing the log later can check the model's reasoning against her actual words, not just trust the output. */
export interface PatchEntry {
  readonly field: AllowedPatchField;
  readonly value: unknown;
  readonly quote: string;
}

export interface FeedbackClassification {
  readonly hasQuestion: boolean;
  /** A draft reply addressing her question, grounded in the context the prompt was given — null when there was no question, or the model had nothing groundable to say. */
  readonly answerDraft: string | null;
  readonly changes: readonly PatchEntry[];
  /** Parts of her message that read like feedback but didn't map cleanly to an allowed field/value — surfaced, never dropped silently. */
  readonly unclear: readonly string[];
}

const EMPTY_CLASSIFICATION: FeedbackClassification = { hasQuestion: false, answerDraft: null, changes: [], unclear: [] };

/**
 * Whether an inbound message is genuinely the candidate writing to us,
 * rather than something merely addressed to her and swept up by her own
 * full-inbox forwarding (see owner-forwarding.ts's exclude-recipients doc
 * comment for the same distinction from a different angle). Two things
 * must both be true: she is the actual sender, and she wrote directly to
 * this mailbox — not a message from someone else that happens to have her
 * as a recipient, and not her own forwarded copy of unrelated mail arriving
 * with her as the original recipient rather than the direct sender to us.
 */
export function looksLikeDirectMessage(
  message: { readonly from: { readonly address: string }; readonly to: readonly { readonly address: string }[] },
  candidateAddress: string,
  mailboxAddress: string,
): boolean {
  const from = message.from.address.toLowerCase();
  const candidate = candidateAddress.toLowerCase();
  const mailbox = mailboxAddress.toLowerCase();
  if (from !== candidate) return false;
  return message.to.some((address) => address.address.toLowerCase() === mailbox);
}

/** Strips everything but digits, then keeps the last 10 — enough to match "+12144023994", "12144023994", and "(214) 402-3994" against each other without pretending to be a real phone-number parser. */
export function normalizePhone(value: string): string {
  const digits = value.replace(/\D/g, "");
  return digits.slice(-10);
}

/**
 * The iMessage counterpart to looksLikeDirectMessage above: true only for a
 * message this identity actually received (direction "inbound") from her own
 * configured number. There's no forwarded-mail equivalent to guard against
 * here — Inkbox's iMessage API only ever reports messages sent to or from
 * this identity directly — so the check is simpler than the email one.
 */
export function looksLikeDirectText(
  message: { readonly direction: string; readonly remoteNumber: string | null },
  candidatePhone: string,
): boolean {
  if (message.direction !== "inbound") return false;
  if (!message.remoteNumber) return false;
  return normalizePhone(message.remoteNumber) === normalizePhone(candidatePhone);
}

function fieldDescription(field: AllowedPatchField): string {
  const descriptions: Record<AllowedPatchField, string> = {
    titles: "array of strings — title patterns that must appear (any order) for a posting to be considered at all",
    titleExclusions: "array of strings — a title containing any of these is rejected outright (e.g. \"director\", \"intern\")",
    salaryFloor: "number or null — reject a posting whose stated max pay falls below this; null means no floor",
    remoteOnly: "boolean — true means only remote roles pass, unless metros re-admits a named place",
    metros: "array of strings — named places where onsite/hybrid roles are still allowed even with remoteOnly true",
    locationPriority: "array of strings — display-order preference only, never excludes anything",
    experienceYearsFloor: "number or null — reject a posting whose stated years-required range tops out below this",
    experienceYearsCeiling: "number or null — reject a posting whose stated years-required range starts above this",
    maxPostingAgeDays: "number or null — reject a posting older than this many days; null disables the check",
    usRemoteOnly: "boolean — true rejects a remote posting that names a non-US country with no US option",
    industryExclusions: "array of strings — a posting mentioning any of these is rejected",
    companyExclusions: "array of strings — a posting from any of these companies is rejected",
    scoreCutoff: "number 0-100 — minimum AI score to reach the digest's main list",
  };
  return descriptions[field];
}

/**
 * Builds the classification prompt. The current preferences (only the
 * allowed-to-change fields, not the whole file) and a short run context are
 * the ONLY facts the model is given to answer from — it is told explicitly
 * to say it doesn't know rather than invent an answer, the same discipline
 * `score.ts`'s scoring prompt already applies to job postings.
 */
export function buildFeedbackPrompt(
  messageText: string,
  currentPrefs: Preferences,
  runContext: string,
): { readonly system: string; readonly user: string } {
  const currentValues = Object.fromEntries(ALLOWED_PATCH_FIELDS.map((field) => [field, currentPrefs[field]]));

  const system = [
    "You read one message from a job candidate about her own search and turn it into two things:",
    "1. Whether she asked a question, and if so, a grounded draft reply.",
    "2. Any preference changes she asked for, mapped to specific fields.",
    "",
    "Rules, in order of importance:",
    "- Never invent a value she did not state or clearly, unambiguously imply. A vague or sarcastic remark is not a value.",
    "- Only ever change a field from this exact list, with this exact meaning:",
    ...ALLOWED_PATCH_FIELDS.map((field) => `  - ${field}: ${fieldDescription(field)}`),
    "- If a request doesn't map cleanly onto one of those fields and values, or the mapping is genuinely ambiguous, put the relevant part of her message in \"unclear\" and do NOT put anything in \"changes\" for it. An honest 'I couldn't map this' beats a wrong guess every time.",
    "- For an array field (titles, metros, etc.), the value you output is the FULL new array — you have the current array below, so add or remove from it as her message asks and output the complete result, not just a delta.",
    "- If she asks a question, answer it ONLY from the current preferences and run context given below. If you don't have what's needed to answer honestly, say so plainly in the draft rather than guessing.",
    "- Output ONLY a JSON object, no prose before or after, matching this shape exactly:",
    '{"hasQuestion": boolean, "answerDraft": string | null, "changes": [{"field": string, "value": <matching type>, "quote": string}], "unclear": [string]}',
  ].join("\n");

  const user = [
    `Her message:\n"""\n${messageText}\n"""`,
    "",
    `Her current preferences (only the fields you're allowed to change):\n${JSON.stringify(currentValues, null, 2)}`,
    "",
    `Recent run context:\n${runContext}`,
  ].join("\n");

  return { system, user };
}

/** True total-checking guard — every field/value/quote must be present and correctly typed, or the whole entry is dropped rather than partially trusted. */
function isValidPatchEntry(value: unknown): value is { field: string; value: unknown; quote: string } {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return typeof v["field"] === "string" && "value" in v && typeof v["quote"] === "string" && v["quote"].length > 0;
}

/**
 * Parses the model's JSON response. Malformed JSON, a missing top-level
 * key, or a change naming a field outside the allow-list is never
 * "best-effort" repaired — the safe failure here is the empty
 * classification (nothing changes, no reply drafted), not a guess at what
 * the model meant.
 */
export function parseFeedbackClassification(responseText: string): FeedbackClassification {
  let parsed: unknown;
  try {
    parsed = JSON.parse(responseText);
  } catch {
    return EMPTY_CLASSIFICATION;
  }
  if (typeof parsed !== "object" || parsed === null) return EMPTY_CLASSIFICATION;
  const obj = parsed as Record<string, unknown>;

  const hasQuestion = obj["hasQuestion"] === true;
  const answerDraft = typeof obj["answerDraft"] === "string" && obj["answerDraft"].length > 0 ? obj["answerDraft"] : null;

  const rawChanges = Array.isArray(obj["changes"]) ? obj["changes"] : [];
  const changes: PatchEntry[] = [];
  const unclear: string[] = Array.isArray(obj["unclear"]) ? obj["unclear"].filter((u): u is string => typeof u === "string") : [];

  for (const entry of rawChanges) {
    if (!isValidPatchEntry(entry) || !isAllowedField(entry.field)) {
      // A change naming a field we don't recognize or don't allow is treated
      // the same as an unclear request, never silently dropped without a
      // trace and never silently applied.
      unclear.push(isValidPatchEntry(entry) ? `unrecognized field "${entry.field}": ${entry.quote}` : "malformed change entry");
      continue;
    }
    changes.push({ field: entry.field, value: entry.value, quote: entry.quote });
  }

  return { hasQuestion, answerDraft, changes, unclear };
}

export async function classifyFeedback(
  messageText: string,
  currentPrefs: Preferences,
  runContext: string,
  client: ScoringClient,
  model: string,
  ledger?: CostLedger,
): Promise<FeedbackClassification> {
  const { system, user } = buildFeedbackPrompt(messageText, currentPrefs, runContext);
  const result = await client.complete({ model, system, user, maxTokens: 1500 });
  if (ledger) await ledger.record("feedback-classification", model, result.usage);
  return parseFeedbackClassification(result.text);
}

/**
 * Applies only whitelisted fields onto `prefs`, in the type each field
 * expects — a second, independent check on top of `isAllowedField` (the
 * parser already filters to the allow-list; this is the belt to that
 * suspenders, since this function is the one actually writing the file
 * candidate feedback controls). A type mismatch (e.g. a string where
 * `salaryFloor` needs a number-or-null) drops that one entry rather than
 * writing a value that would corrupt the file or crash the next run.
 */
export function applyFeedbackPatch(prefs: Preferences, changes: readonly PatchEntry[]): { readonly next: Preferences; readonly applied: readonly PatchEntry[]; readonly rejected: readonly PatchEntry[] } {
  let next = prefs;
  const applied: PatchEntry[] = [];
  const rejected: PatchEntry[] = [];

  for (const change of changes) {
    if (!isAllowedField(change.field)) {
      rejected.push(change);
      continue;
    }
    if (!matchesFieldType(change.field, change.value)) {
      rejected.push(change);
      continue;
    }
    next = { ...next, [change.field]: change.value };
    applied.push(change);
  }

  return { next, applied, rejected };
}

/**
 * The reply she actually receives. Built separately from the classification
 * itself so it can account for what `applyFeedbackPatch` actually did — the
 * model's proposed changes and what got applied can differ (a type
 * mismatch on an otherwise-allowed field), and she should hear about that
 * as plainly as an outright "unclear," not see it silently vanish.
 */
export function buildFeedbackReplyBody(
  classification: FeedbackClassification,
  applied: readonly PatchEntry[],
  rejected: readonly PatchEntry[],
): string {
  const lines: string[] = [];

  if (classification.hasQuestion) {
    lines.push(classification.answerDraft ?? "I'm not confident I can answer that from what's on file — flagging this for a closer look.");
  }

  if (applied.length > 0) {
    lines.push("", "Updated:");
    for (const change of applied) lines.push(`- ${change.field} → ${JSON.stringify(change.value)}`);
  }

  const unresolved = [...classification.unclear, ...rejected.map((c) => `"${c.quote}" (about ${c.field} — couldn't apply this one automatically)`)];
  if (unresolved.length > 0) {
    lines.push("", "Wasn't confident enough to act on, so nothing changed for these — say more and I'll apply it:");
    for (const item of unresolved) lines.push(`- ${item}`);
  }

  return lines.join("\n").trim();
}

function matchesFieldType(field: AllowedPatchField, value: unknown): boolean {
  switch (field) {
    case "titles":
    case "titleExclusions":
    case "metros":
    case "locationPriority":
    case "industryExclusions":
    case "companyExclusions":
      return Array.isArray(value) && value.every((v) => typeof v === "string");
    case "salaryFloor":
    case "experienceYearsFloor":
    case "experienceYearsCeiling":
    case "maxPostingAgeDays":
      return value === null || typeof value === "number";
    case "remoteOnly":
    case "usRemoteOnly":
      return typeof value === "boolean";
    case "scoreCutoff":
      return typeof value === "number" && value >= 0 && value <= 100;
  }
}
