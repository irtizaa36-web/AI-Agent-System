import { randomUUID } from "node:crypto";
import type { Channel, OutboxKind, OutboxMessage, TrackerDocument } from "./types";
import { DEFAULT_CONFIG } from "./config";
import { isWatchOnly } from "./owner_activity";

/**
 * Send queue (ADR 0024). Nothing goes straight to Messenger: every outbound
 * message is staged here first, then flushed in batches — Toozy's "5-minute
 * spurts" for the approval-card workflow. A flush marks messages
 * "awaiting-tap" and prints the EXACT text awaiting his tap; the operating
 * agent sends them (one approval card each) and records them "sent".
 *
 * The agent never waits idly on approvals: between spurts it keeps working
 * the other threads.
 */

export interface StageInput {
  readonly kind: OutboxKind;
  readonly channel: Channel;
  readonly threadId: string;
  readonly recipient: string;
  readonly body: string;
  readonly listingId?: string;
  readonly leadId?: string;
}

/**
 * Stage an outbound message. Nothing goes straight to Messenger: every
 * outbound message is staged here first, then flushed in batches —
 * Toozy's "5-minute spurts" for the approval-card workflow.
 *
 * Runaway guard: the same body is never staged twice for the same thread
 * while the first copy is still pending/awaiting-tap. Returns the existing
 * message with duplicated: true instead of drafting a duplicate nudge.
 */
export function stageMessage(doc: TrackerDocument, input: StageInput, now: string = new Date().toISOString()): { doc: TrackerDocument; message: OutboxMessage; duplicated: boolean } {
  const duplicate = doc.outbox.find(
    (m) => m.threadId === input.threadId && m.body === input.body && (m.status === "pending" || m.status === "awaiting-tap"),
  );
  if (duplicate) return { doc, message: duplicate, duplicated: true };
  const message: OutboxMessage = {
    id: randomUUID(),
    kind: input.kind,
    channel: input.channel,
    threadId: input.threadId,
    recipient: input.recipient,
    body: input.body,
    stagedAt: now,
    status: "pending",
    listingId: input.listingId,
    leadId: input.leadId,
  };
  return { doc: { ...doc, outbox: [...doc.outbox, message], updatedAt: now }, message, duplicated: false };
}

export function pendingMessages(doc: TrackerDocument): OutboxMessage[] {
  return doc.outbox.filter((m) => m.status === "pending");
}

export function awaitingTap(doc: TrackerDocument): OutboxMessage[] {
  return doc.outbox.filter((m) => m.status === "awaiting-tap");
}

/**
 * Flush one spurt: mark every pending message "awaiting-tap" and return them
 * for printing. Printing the exact bodies is the approval surface — the
 * owner taps one card per message in his app.
 *
 * Watch-only backstop: a pending message for a thread where the owner wrote
 * within the watch window is marked "suppressed" and never reaches a card.
 */
export function flushOutbox(
  doc: TrackerDocument,
  now: string = new Date().toISOString(),
  watchOnlyMinutes: number = DEFAULT_CONFIG.ownerActivity.watchOnlyMinutes,
): { doc: TrackerDocument; spurt: OutboxMessage[]; suppressed: OutboxMessage[] } {
  const pending = pendingMessages(doc);
  const suppressed = pending.filter((m) => isWatchOnly(doc, m.threadId, now, watchOnlyMinutes));
  const suppressedIds = new Set(suppressed.map((m) => m.id));
  const spurt = pending.filter((m) => !suppressedIds.has(m.id));
  const ids = new Set(spurt.map((m) => m.id));
  const outbox = doc.outbox.map((m) =>
    ids.has(m.id) ? { ...m, status: "awaiting-tap" as const } : suppressedIds.has(m.id) ? { ...m, status: "suppressed" as const } : m,
  );
  return {
    doc: { ...doc, outbox, updatedAt: now },
    spurt: spurt.map((m) => ({ ...m, status: "awaiting-tap" as const })),
    suppressed: suppressed.map((m) => ({ ...m, status: "suppressed" as const })),
  };
}

/** Record that the owner tapped send on these messages (cards approved). */
export function recordSent(doc: TrackerDocument, ids: readonly string[], now: string = new Date().toISOString()): TrackerDocument {
  const set = new Set(ids);
  return { ...doc, outbox: doc.outbox.map((m) => (set.has(m.id) ? { ...m, status: "sent" as const } : m)), updatedAt: now };
}
