import { execFile } from "node:child_process";
import type { Channel, TrackerDocument } from "./types";
import { screenInbound } from "./scam";
import { renderTemplate } from "./templates";
import { itemsOf, logParseFailure, parseJsonLenient } from "./parse";

/**
 * Unified inbound monitor (ADR 0024). Normalizes lead events from three
 * channels into one LeadEvent stream:
 *
 *  (1) Messenger marketplace threads — `hatch_messenger_cli threads/messages`.
 *  (2) Google Voice SMS via Gmail — Voice texts forward as emails from
 *      voice-noreply@google.com labeled "Voice" (number (832) 915-0174).
 *      Read-only triage. Outbound SMS only as drafts through the voice
 *      drafter policy: scam classifier first, fixed templates, owner taps
 *      to send. NEVER auto-send, NEVER relay verification codes to
 *      strangers, never voice-call (no mic path).
 *  (3) AgentMail inbox irtiza-6902@agentmail.to — listing-related mail.
 *
 * Headless loops call pollAll(), match events to leads, dedupe via
 * seenEvents, and write state. Pollers are read-only by construction:
 * nothing here sends anything anywhere.
 */

export interface LeadEvent {
  /** Dedupe key: "<channel>:<native id>". */
  readonly id: string;
  readonly channel: Channel;
  readonly threadId: string;
  readonly senderName: string;
  readonly senderId?: string;
  /** Truncated to 280 chars at the poll boundary — full bodies never enter state. */
  readonly body: string;
  readonly sentAt: string;
}

/** Compact-schema rule: truncate every tool output before it enters context/state. */
export function truncate(text: string, max = 280): string {
  const t = text ?? "";
  return t.length > max ? `${t.slice(0, max)}…` : t;
}

/** Runs a CLI and returns stdout. Injected so tests use fakes, not CLIs. */
export type ExecFn = (cmd: string, args: readonly string[]) => Promise<string>;

function realExec(cmd: string, args: readonly string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(cmd, [...args], { timeout: 60_000, maxBuffer: 8 * 1024 * 1024 }, (error, stdout, stderr) => {
      if (error) reject(new Error(`${cmd} failed: ${stderr || error.message}`));
      else resolve(stdout);
    });
  });
}

export interface ChannelPoller {
  readonly name: Channel;
  /** Recent inbound events. Never throws on a single-channel failure — returns []. */
  poll(sinceIso: string): Promise<LeadEvent[]>;
}

/**
 * Gmail search pattern for Voice SMS (documented in SKILL.md):
 *   from:voice-noreply@google.com label:Voice newer_than:7d
 */
export const VOICE_GMAIL_QUERY = "from:voice-noreply@google.com label:Voice newer_than:7d";

function safeParseEvents(stdout: string, channel: Channel, toEvent: (item: any) => LeadEvent | undefined, source: string = channel): LeadEvent[] {
  const parsed = parseJsonLenient(stdout, source);
  if (!parsed.ok) return [];
  const items = itemsOf(parsed.value, source, stdout);
  const events: LeadEvent[] = [];
  for (const item of items) {
    try {
      const e = toEvent(item);
      if (e) events.push(e);
    } catch (error) {
      // One malformed item is logged and skipped; the rest of the payload still counts.
      logParseFailure(`${source}.item`, error, item);
    }
  }
  return events;
}

/** ISO time from a CLI date field; a garbage date is an error for the item, not a silent "now". */
function isoFrom(raw: unknown): string {
  const d = new Date(raw as string | number);
  if (Number.isNaN(d.getTime())) throw new Error(`unparseable date ${JSON.stringify(raw)}`);
  return d.toISOString();
}

export function createChannelPollers(exec: ExecFn = realExec): ChannelPoller[] {
  const messenger: ChannelPoller = {
    name: "messenger",
    async poll(_sinceIso: string): Promise<LeadEvent[]> {
      let threadsOut: string;
      try {
        threadsOut = await exec("hatch_messenger_cli", ["threads", "--folder", "mplace", "--limit", "30"]);
      } catch {
        return [];
      }
      return safeParseEvents(threadsOut, "messenger", (t) => {
        const threadId = t.conversation_id ?? t.thread_id ?? t.id;
        const snippet = t.snippet ?? "";
        if (!threadId || !snippet) return undefined;
        const senderId = String(t.snippet_sender_id ?? "");
        return {
          id: `messenger:${threadId}:${t.updated_at ?? ""}`,
          channel: "messenger",
          threadId: String(threadId),
          senderName: t.name ?? "unknown",
          senderId,
          body: truncate(String(snippet)),
          sentAt: t.updated_at === undefined ? new Date().toISOString() : isoFrom(Number(t.updated_at) || t.updated_at),
        };
      });
    },
  };

  const voiceSms: ChannelPoller = {
    name: "voice-sms",
    async poll(_sinceIso: string): Promise<LeadEvent[]> {
      let out: string;
      try {
        out = await exec("hatch_gws_cli", ["gmail", "+triage", "--query", VOICE_GMAIL_QUERY, "--max", "50", "--format", "json"]);
      } catch {
        return [];
      }
      return safeParseEvents(out, "voice-sms", (m) => {
        const id = m.id ?? m.message_id;
        if (!id) return undefined;
        return {
          id: `voice-sms:${id}`,
          channel: "voice-sms",
          threadId: String(m.threadId ?? m.thread_id ?? id),
          senderName: String(m.from ?? m.sender ?? "Voice SMS"),
          body: truncate(String(m.snippet ?? m.subject ?? "")),
          sentAt: m.date ? isoFrom(m.date) : new Date().toISOString(),
        };
      });
    },
  };

  const agentmail: ChannelPoller = {
    name: "agentmail",
    async poll(_sinceIso: string): Promise<LeadEvent[]> {
      let out: string;
      try {
        out = await exec("agentmail-cli", ["list-messages", "--limit", "25"]);
      } catch {
        return [];
      }
      return safeParseEvents(out, "agentmail", (m) => {
        const id = m.id ?? m.message_id;
        if (!id) return undefined;
        return {
          id: `agentmail:${id}`,
          channel: "agentmail",
          threadId: String(m.thread_id ?? m.threadId ?? id),
          senderName: String(m.from ?? "unknown"),
          body: truncate(String(m.subject ? `${m.subject} — ${m.snippet ?? ""}` : (m.snippet ?? ""))),
          sentAt: m.date ? isoFrom(m.date) : new Date().toISOString(),
        };
      });
    },
  };

  return [messenger, voiceSms, agentmail];
}

export async function pollAll(pollers: readonly ChannelPoller[], sinceIso: string): Promise<LeadEvent[]> {
  const results = await Promise.all(pollers.map((p) => p.poll(sinceIso)));
  return results.flat();
}

/** Drop events already recorded in seenEvents. */
export function dedupe(doc: TrackerDocument, events: readonly LeadEvent[]): LeadEvent[] {
  const seen = new Set(doc.seenEvents);
  return events.filter((e) => !seen.has(e.id));
}

/** Match an event to a known lead by thread id, else undefined (new lead). */
export function matchLead(doc: TrackerDocument, event: LeadEvent) {
  return doc.leads.find((l) => l.threadId === event.threadId);
}

export interface SmsDraft {
  readonly to: string;
  readonly body: string;
  readonly flagged: boolean;
  readonly reasons: readonly string[];
}

/**
 * Voice-SMS outbound: drafts ONLY, never sends. Scam classifier runs first;
 * flagged messages are returned unrendered (flagged: true) for escalation.
 * Fixed template only — no free-form texting to strangers. Verification-code
 * relay requests are always flagged (classic 6-digit-code scam).
 */
export function draftSmsReply(doc: TrackerDocument, event: LeadEvent, ctx: { item: string; price: number; meetup: string }): SmsDraft {
  const screen = screenInbound(event.body);
  if (screen.flagged) {
    return { to: event.senderName, body: "", flagged: true, reasons: screen.reasons };
  }
  const body = renderTemplate(doc, "sms-availability", {
    name: event.senderName,
    item: ctx.item,
    price: ctx.price,
    meetup: ctx.meetup,
  });
  return { to: event.senderName, body, flagged: false, reasons: [] };
}

/**
 * Watermark-based incremental reads (ADR 0024). Every poll records the
 * newest event id per thread; the next poll skips anything at or below the
 * watermark. Pollers fetch thread-list deltas / latest snippets only —
 * full histories are never re-read.
 */
export function updateWatermarks(doc: TrackerDocument, events: readonly LeadEvent[]): TrackerDocument {
  const watermarks = { ...doc.watermarks };
  for (const e of events) watermarks[e.threadId] = e.id;
  return { ...doc, watermarks };
}

/** Drop events from threads whose watermark already covers them. */
export function filterByWatermark(doc: TrackerDocument, events: readonly LeadEvent[]): LeadEvent[] {
  return events.filter((e) => doc.watermarks[e.threadId] !== e.id);
}
