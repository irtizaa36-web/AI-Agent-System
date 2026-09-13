import type { Confidence, JobRecord, Preferences } from "./records";
import { salaryUnknown } from "./filter";
import type { CostLedger } from "./cost";
import type { ScoringClient } from "./scoring-client";

/**
 * Stage 8: the only place in the scheduled pipeline where a model is used at
 * all, and the only place one is genuinely needed — judging whether a real
 * posting fits a real person.
 *
 * Three decisions keep this cheap. Postings are scored in batches, so the
 * rubric and profile are sent once per batch rather than once per posting.
 * The system prefix is identical across every batch in a run, so prompt
 * caching bills it at roughly a tenth after the first. And the model writes
 * the two-line rationale in the same call that produces the score, so the
 * digest needs no second, larger model at all.
 */

export interface CandidateProfile {
  /** The resume, already parsed to text once and cached on disk. */
  readonly resume: string;
  /** Anything she has said about what she wants that isn't a mechanical filter. */
  readonly notes: string;
}

export interface ScoredPosting {
  readonly id: string;
  readonly score: number;
  readonly confidence: Confidence;
  readonly rationale: string;
  readonly gaps: readonly string[];
}

const RUBRIC = `You are scoring job postings for one candidate. For each posting, decide how well it fits.

Score 0-100:
  85-100  Strong fit. Title, level, and most requirements line up with real resume content.
  65-84   Good fit worth her time. Some gaps, none disqualifying.
  40-64   Partial fit. Wrong level, adjacent function, or several unmet requirements.
  0-39    Not a fit.

Confidence is about how much the POSTING told you, not how good the match is:
  high    The posting stated responsibilities, requirements, and level clearly.
  medium  Enough to judge, with gaps in what was stated.
  low     Vague, boilerplate-heavy, or too short to judge properly.

Rules you must follow:
- Judge only against what the resume actually says. Never assume experience that is not written there.
- "gaps" lists requirements the posting asks for that the resume does not support. Name them plainly. An empty list means the resume genuinely covers the stated requirements.
- If a posting does not state salary, that is unknown, not a negative. Do not speculate about pay.
- The rationale is at most two short sentences, written to her, saying why this is or is not worth her time. No preamble, no restating the job title.

Return ONLY a JSON array, no prose and no code fences, shaped exactly:
[{"id":"<the id given>","score":<0-100>,"confidence":"low|medium|high","rationale":"<=2 sentences","gaps":["..."]}]
Return one object for every posting you were given, in the same order.`;

/**
 * The cached prefix. Everything that is identical for every batch in a run
 * lives here; everything that varies lives in the user turn. Keeping that
 * split clean is what makes the cache actually hit — a single varying
 * character in here would invalidate it on every call.
 */
export function buildSystemPrompt(profile: CandidateProfile, prefs: Preferences): string {
  const targets = prefs.titles.length > 0 ? prefs.titles.join(", ") : "(not yet configured — judge on the resume alone)";
  const floor = prefs.salaryFloor === null ? "(not set)" : `${prefs.salaryFloor.toLocaleString()} ${prefs.salaryCurrency}`;

  return `${RUBRIC}

## Target roles
${targets}

## Location requirement
${prefs.remoteOnly ? "Remote roles only." : "Remote or onsite."}${prefs.metros.length > 0 ? ` Onsite acceptable in: ${prefs.metros.join(", ")}.` : ""}

## Compensation floor
${floor}

## Her notes
${profile.notes || "(none provided)"}

## Her resume
${profile.resume}`;
}

/** The varying half: just the postings, trimmed. */
export function buildBatchPrompt(batch: readonly JobRecord[]): string {
  const postings = batch.map((record) => ({
    id: record.id,
    title: record.title,
    company: record.company,
    location: record.rawLocation || "(not stated)",
    remote: record.locationClass,
    salary: salaryUnknown(record)
      ? "not stated"
      : `${record.salaryMin?.toLocaleString() ?? "?"}-${record.salaryMax?.toLocaleString() ?? "?"} ${record.salaryCurrency ?? ""}`.trim(),
    description: record.summary,
  }));

  return `Score these ${batch.length} postings.\n\n${JSON.stringify(postings, null, 1)}`;
}

/**
 * Parses the model's reply. Deliberately strict about the shape and
 * deliberately forgiving about the wrapper: a model that wraps valid JSON in
 * a code fence has not actually failed, but one that invents a score of 120
 * or drops the id has, and that must not pass silently into the digest.
 */
export function parseScoringResponse(text: string): readonly ScoredPosting[] {
  const cleaned = text.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "").trim();
  const start = cleaned.indexOf("[");
  const end = cleaned.lastIndexOf("]");
  if (start === -1 || end === -1 || end < start) {
    throw new Error(`scoring response was not a JSON array: ${cleaned.slice(0, 200)}`);
  }

  const parsed: unknown = JSON.parse(cleaned.slice(start, end + 1));
  if (!Array.isArray(parsed)) throw new Error("scoring response did not parse to an array");

  return parsed.map((entry, index) => {
    const item = entry as Record<string, unknown>;
    const id = typeof item["id"] === "string" ? item["id"] : null;
    if (!id) throw new Error(`scoring entry ${index} has no id`);

    const rawScore = Number(item["score"]);
    if (!Number.isFinite(rawScore)) throw new Error(`scoring entry ${id} has a non-numeric score`);

    const confidence = item["confidence"];
    const gaps = Array.isArray(item["gaps"]) ? item["gaps"].filter((gap): gap is string => typeof gap === "string") : [];

    return {
      id,
      score: Math.max(0, Math.min(100, Math.round(rawScore))),
      confidence: confidence === "high" || confidence === "medium" || confidence === "low" ? confidence : "low",
      rationale: typeof item["rationale"] === "string" ? item["rationale"].trim() : "",
      gaps,
    };
  });
}

export function chunk<T>(items: readonly T[], size: number): readonly (readonly T[])[] {
  const batches: T[][] = [];
  for (let index = 0; index < items.length; index += size) {
    batches.push(items.slice(index, index + size));
  }
  return batches;
}

export interface ScoreRunResult {
  readonly scored: readonly JobRecord[];
  /** Batches the model failed on. Their postings stay unscored and are retried next run rather than silently dropped. */
  readonly failures: readonly string[];
}

/**
 * Scores every filtered posting, batch by batch, applying the result back
 * onto the records. A batch that fails does not fail the run: those postings
 * keep their `seen` state and come back around next run, which is the
 * difference between losing a morning's discoveries and losing nothing.
 */
export async function scoreRecords(
  records: readonly JobRecord[],
  profile: CandidateProfile,
  prefs: Preferences,
  client: ScoringClient,
  ledger: CostLedger,
): Promise<ScoreRunResult> {
  if (records.length === 0) return { scored: [], failures: [] };

  const system = buildSystemPrompt(profile, prefs);
  const scored: JobRecord[] = [];
  const failures: string[] = [];

  for (const batch of chunk(records, prefs.scoringBatchSize)) {
    try {
      const result = await client.complete({
        model: prefs.scoringModel,
        system,
        user: buildBatchPrompt(batch),
        // ~180 tokens of JSON per posting, with headroom.
        maxTokens: Math.max(1024, batch.length * 220),
      });
      await ledger.record("score", prefs.scoringModel, result.usage);

      const byId = new Map(parseScoringResponse(result.text).map((entry) => [entry.id, entry]));
      for (const record of batch) {
        const judgement = byId.get(record.id);
        if (!judgement) {
          failures.push(`${record.company} — ${record.title}: model returned no score`);
          continue;
        }
        scored.push({
          ...record,
          state: judgement.score >= prefs.scoreCutoff ? "shortlisted" : "scored",
          score: judgement.score,
          confidence: judgement.confidence,
          rationale: judgement.rationale,
          gaps: judgement.gaps,
        });
      }
    } catch (error) {
      failures.push(`batch of ${batch.length}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  return { scored, failures };
}
