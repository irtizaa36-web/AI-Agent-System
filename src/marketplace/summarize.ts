import type { ThreadSummary, TrackerDocument } from "./types";
import type { LeadEvent } from "./channels";
import { logParseFailure } from "./parse";

/**
 * Rolling thread summaries (ADR 0024).
 *
 * State keeps a living summary per thread; raw messages are summarized once
 * and then dropped from context. The summarizer runs on the CHEAP tier
 * (triage/deltas/summaries/scam-screen), never the strong tier — see the
 * tiered model routing table in SKILL.md.
 */

/** Cheap-tier summarizer: (previousSummary, newMessages) => updatedSummary. */
export type Summarizer = (previous: string, newMessages: readonly string[]) => Promise<string>;

/**
 * Default extractive summarizer — used when no LLM tier is available.
 * Keeps the first line of the previous summary and appends the newest
 * truncated messages; deterministic, zero tokens.
 */
export async function extractiveSummarizer(previous: string, newMessages: readonly string[]): Promise<string> {
  const kept = previous.split("\n").filter(Boolean).slice(0, 4);
  const appended = newMessages.slice(-4).map((m) => m.slice(0, 140));
  return [...kept, ...appended].join("\n").slice(0, 1000);
}

/**
 * Fold new events into each thread's rolling summary. Only events carrying
 * a non-empty body participate; summaries store the narrative, never the
 * raw bodies.
 */
export async function rollSummaries(
  doc: TrackerDocument,
  events: readonly LeadEvent[],
  summarize: Summarizer = extractiveSummarizer,
  nowIso: string = new Date().toISOString(),
): Promise<TrackerDocument> {
  const byThread = new Map<string, string[]>();
  for (const e of events) {
    if (!e.body) continue;
    const arr = byThread.get(e.threadId) ?? [];
    arr.push(`${e.senderName}: ${e.body.slice(0, 280)}`);
    byThread.set(e.threadId, arr);
  }
  if (byThread.size === 0) return doc;
  const summaries = { ...doc.summaries };
  for (const [threadId, messages] of byThread) {
    const prev = summaries[threadId];
    // The summarizer may be a model: a throw or a non-string answer keeps the previous summary for this thread only.
    let summary: unknown;
    try {
      summary = await summarize(prev?.summary ?? "", messages);
    } catch (error) {
      logParseFailure("summarize.thread", error, messages.join("\n"));
      continue;
    }
    if (typeof summary !== "string" || summary.trim() === "") {
      logParseFailure("summarize.thread", "summarizer returned no text", summary);
      continue;
    }
    summaries[threadId] = {
      threadId,
      summary: summary.slice(0, 2000),
      updatedAt: nowIso,
      messageCount: (prev?.messageCount ?? 0) + messages.length,
    };
  }
  return { ...doc, summaries, updatedAt: nowIso };
}
