import type { JobRecord } from "./records";
import type { CompletionRequest, ScoringClient } from "./scoring-client";
import { costOf } from "./cost";

/**
 * Drafts a tailored resume variant for one scored job posting.
 *
 * This fills the `ApplicationRecord.resumeVariantPath` field (records.ts) that
 * the records layer declared but nothing generated — until this module, there
 * was a slot for a tailored resume and no way to produce one.
 *
 * The port is the same `ScoringClient` the scoring path uses (same client
 * setup, same ANTHROPIC_API_KEY, same error handling in scoring-client.ts) —
 * no new client class, because a one-call-per-invocation drafting step needs
 * nothing scoring's port doesn't already provide. The model is Haiku: the
 * standing policy routes cheap drafting work to the cheapest capable model.
 */

export const TAILOR_MODEL = "claude-haiku-4-5";

/** Output budget for one resume draft. A resume is long-form prose, not a scored JSON row. */
export const TAILOR_MAX_TOKENS = 4000;

/**
 * Rough chars-per-token for pre-call cost estimates. It is an estimate,
 * stated as one — never a number a ledger is built from.
 */
const ESTIMATED_CHARS_PER_TOKEN = 4;

/** Subdirectory under the profile dir where drafts are written. */
export const TAILORED_DIR = "tailored";

export interface TailorDraft {
  /** The model's text with the draft stamp header prepended. */
  readonly markdown: string;
  readonly model: string;
  readonly inputTokens: number;
  readonly outputTokens: number;
  /** Dollars for this call, from the same pricing table as the scoring ledger. */
  readonly costUsd: number;
}

/**
 * The stable rules half of the prompt. Hard no-fabrication rules live here,
 * in the cached system block, so they cannot drift between drafts and cannot
 * be diluted by a long user turn: the model is told, every time, what it may
 * not invent and what it must say plainly.
 */
export function buildTailorSystemPrompt(): string {
  return [
    "You are drafting a tailored resume variant from a candidate's REAL base resume and one job posting.",
    "",
    "Rules — these are absolute:",
    "- NEVER invent experience, employers, titles, dates, metrics, degrees, certifications, or skills. Every single bullet must be traceable to something written in the base resume.",
    "- What you MAY do: reorder sections and bullets, reword phrasing, and emphasize or expand the parts of the resume most relevant to this posting.",
    "- Keep the name, contact info, and every employer/title/date exactly as written in the base resume. Do not merge or split roles.",
    "- If the posting's level or title implies scope the resume does not show, say so in Gaps — do not inflate the resume to match.",
    "- End with a \"## Gaps\" section naming each requirement the posting states that the resume does not cover. If the resume genuinely covers everything stated, say so plainly instead.",
    "- This output is a DRAFT for the candidate's own review before any submission. It is never auto-submitted and never sent anywhere.",
    "",
    "Format: the full resume in Markdown, mirroring the base resume's structure (summary, experience, skills, education), followed by \"## Gaps\" as the final section. Return ONLY the resume markdown — no preamble, no commentary.",
  ].join("\n");
}

function describeExperience(job: JobRecord): string {
  if (job.experienceYearsMin === null && job.experienceYearsMax === null) return "not stated";
  if (job.experienceYearsMin !== null && job.experienceYearsMax !== null)
    return `${job.experienceYearsMin}–${job.experienceYearsMax} years`;
  if (job.experienceYearsMin !== null) return `${job.experienceYearsMin}+ years`;
  return `up to ${job.experienceYearsMax} years`;
}

function describeSalary(job: JobRecord): string {
  if (job.salaryMin === null && job.salaryMax === null) return "not stated";
  const currency = job.salaryCurrency ?? "USD";
  if (job.salaryMin !== null && job.salaryMax !== null)
    return `${job.salaryMin.toLocaleString()}–${job.salaryMax.toLocaleString()} ${currency}`;
  if (job.salaryMin !== null) return `${job.salaryMin.toLocaleString()}+ ${currency}`;
  return `up to ${job.salaryMax?.toLocaleString()} ${currency}`;
}

/**
 * The varying half of the prompt: the job as data, then the base resume
 * verbatim. The resume is included in full on purpose — the model may only
 * reframe what it can actually read, so the complete source text is the
 * fabrication boundary. Raw posting HTML never enters the prompt; the
 * trimmed `summary` the scorer saw is the input here too.
 */
export function buildTailorUserPrompt(job: JobRecord, resume: string): string {
  return [
    "## The job",
    `Title: ${job.title}`,
    `Company: ${job.company}`,
    `Location: ${job.rawLocation} (${job.locationClass})`,
    `Compensation: ${describeSalary(job)}`,
    `Experience sought: ${describeExperience(job)}`,
    "",
    "Posting summary:",
    job.summary,
    "",
    "## The base resume (verbatim — reframe it, never invent beyond it)",
    "",
    resume,
  ].join("\n");
}

/** One CompletionRequest for this draft. Kept separate so tests can inspect the prompt without a client. */
export function tailorCompletionRequest(job: JobRecord, resume: string): CompletionRequest {
  return {
    model: TAILOR_MODEL,
    system: buildTailorSystemPrompt(),
    user: buildTailorUserPrompt(job, resume),
    maxTokens: TAILOR_MAX_TOKENS,
  };
}

/**
 * The header stamped onto every draft. It says what the file is (a draft),
 * what it is for (her review), and what it must never be (submitted) — so a
 * file found out of context cannot be mistaken for a finished resume.
 */
export function stampDraftHeader(job: JobRecord, draftBody: string, now = new Date()): string {
  return [
    `# DRAFT — tailored resume for "${job.title}" at ${job.company}`,
    "",
    `> **Draft for the candidate's review — do not submit.** Generated ${now.toISOString()} from the base resume on file against job record \`${job.id}\`. Every bullet traces to the base resume; uncovered requirements are named in the "## Gaps" section.`,
    "",
    draftBody.trim(),
    "",
  ].join("\n");
}

/**
 * Pre-call cost estimate for `--dry-run`: approximate the input tokens from
 * character count, assume a typical resume-length output, and price it with
 * the same table the ledger uses. Labeled an estimate everywhere it appears.
 */
export function estimateTailorCost(request: CompletionRequest, assumedOutputTokens = 2000): number {
  const inputTokens = Math.ceil((request.system.length + request.user.length) / ESTIMATED_CHARS_PER_TOKEN);
  return costOf(request.model, { inputTokens, outputTokens: assumedOutputTokens });
}

/** Draft one tailored resume variant. Throws exactly how the client's API errors say it throws. */
export async function draftTailoredResume(
  job: JobRecord,
  resume: string,
  client: ScoringClient,
  now = new Date(),
): Promise<TailorDraft> {
  const request = tailorCompletionRequest(job, resume);
  const result = await client.complete(request);
  return {
    markdown: stampDraftHeader(job, result.text, now),
    model: request.model,
    inputTokens: result.usage.inputTokens,
    outputTokens: result.usage.outputTokens,
    costUsd: costOf(request.model, result.usage),
  };
}
