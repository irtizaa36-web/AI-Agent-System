import type { TrackerDocument } from "./types";
import { escalate, type Escalation } from "./policy";

/**
 * Owner-activity reconciliation (ADR 0024). Toozy sometimes replies from his
 * own phone in agent-managed threads. Given recent thread messages, detect
 * owner-sent messages (sender = his FB id) and update lead state instead of
 * double-messaging: record the reply, mark the thread owner-handled, and
 * stand the agent down on that thread.
 */

/** The owner's Facebook id, from the local environment only; never committed. Empty when unset. */
export const OWNER_FB_ID = process.env.OWNER_FB_ID ?? "";

/** True only for a message from the owner. With no owner id configured, nothing matches, so reconciliation no-ops. */
export function isOwnerSender(senderId: string | undefined, ownerId: string = OWNER_FB_ID): boolean {
  return ownerId !== "" && senderId === ownerId;
}

export interface ThreadMessage {
  readonly threadId: string;
  readonly senderId: string;
  readonly senderName: string;
  readonly body: string;
  readonly sentAt: string;
}

export interface ReconcileReport {
  readonly ownerActiveThreads: string[];
  readonly notes: string[];
  readonly escalations: Escalation[];
}

/**
 * Returns the updated doc plus a report. For every managed lead whose thread
 * shows an owner-sent message: set ownerRepliedAt, refresh lastContactAt,
 * flip needsAgentFollowUp off, and append a note with an excerpt. Each such
 * thread also raises an owner-override escalation (heads-up, not a blocker).
 */
export function reconcileOwnerActivity(
  doc: TrackerDocument,
  messages: readonly ThreadMessage[],
  ownerId: string = OWNER_FB_ID,
): { doc: TrackerDocument; report: ReconcileReport } {
  const ownerActiveThreads: string[] = [];
  const notes: string[] = [];
  const escalations: Escalation[] = [];

  const ownerMsgs = messages.filter((m) => isOwnerSender(m.senderId, ownerId));
  if (ownerMsgs.length === 0) {
    return { doc, report: { ownerActiveThreads, notes, escalations } };
  }

  const leads = doc.leads.map((lead) => {
    const mine = ownerMsgs.filter((m) => m.threadId === lead.threadId);
    if (mine.length === 0) return lead;
    const latest = mine[mine.length - 1];
    const excerpt = latest.body.length > 120 ? `${latest.body.slice(0, 120)}…` : latest.body;
    ownerActiveThreads.push(lead.threadId);
    notes.push(`${lead.name} (${lead.threadId}): owner replied at ${latest.sentAt} — "${excerpt}". Agent standing down on this thread.`);
    escalations.push(
      escalate("owner-override", `Toozy replied directly to ${lead.name} in thread ${lead.threadId}; agent stood down.`, {
        leadId: lead.id,
        threadId: lead.threadId,
        sentAt: latest.sentAt,
      }),
    );
    return {
      ...lead,
      ownerRepliedAt: latest.sentAt,
      lastContactAt: latest.sentAt,
      needsAgentFollowUp: false,
      notes: [...lead.notes, `Owner replied directly at ${latest.sentAt}.`],
    };
  });

  return {
    doc: { ...doc, leads, updatedAt: new Date().toISOString() },
    report: { ownerActiveThreads, notes, escalations },
  };
}

/**
 * WATCH-ONLY MODE (Karen upgrade 3). If the owner (account holder) sent a
 * message in a thread within the watch window (default 60 minutes), the
 * agent goes watch-only for that thread: it keeps updating internal state
 * but NEVER stages or sends a message there. Enforced twice: callers check
 * isWatchOnly() before staging, and flushOutbox() suppresses anything still
 * pending for a watch-only thread.
 */

/** The agent's own sender id, when its sends come from a separate identity. Empty when unset. */
export const AGENT_FB_ID = process.env.AGENT_FB_ID ?? "";

export type SenderRole = "owner" | "agent" | "counterparty";

/**
 * Who sent a thread message. The agent sends through the owner's account,
 * so the owner id alone can't separate them: a message from the owner's id
 * whose body matches an outbox message the agent staged for that thread is
 * the agent's own send; anything else from the owner's id is the owner.
 */
export function classifySender(
  doc: TrackerDocument,
  message: Pick<ThreadMessage, "threadId" | "senderId" | "body">,
  ids: { readonly ownerId?: string; readonly agentId?: string } = {},
): SenderRole {
  const ownerId = ids.ownerId ?? OWNER_FB_ID;
  const agentId = ids.agentId ?? AGENT_FB_ID;
  if (agentId !== "" && message.senderId === agentId) return "agent";
  if (!isOwnerSender(message.senderId, ownerId)) return "counterparty";
  // Empty snippets can't be matched to an agent send, so they count as the owner (the safe side).
  const body = message.body.trim().replace(/…$/, "");
  const agentSent = body !== "" && doc.outbox.some(
    (m) => m.threadId === message.threadId && (m.status === "sent" || m.status === "awaiting-tap") && m.body.trim().startsWith(body),
  );
  return agentSent ? "agent" : "owner";
}

/** Record the latest owner-sent time per thread. State only; nothing is sent. */
export function recordOwnerActivity(
  doc: TrackerDocument,
  messages: readonly Pick<ThreadMessage, "threadId" | "senderId" | "body" | "sentAt">[],
  ids: { readonly ownerId?: string; readonly agentId?: string } = {},
): TrackerDocument {
  let ownerActivity = doc.ownerActivity;
  for (const m of messages) {
    if (classifySender(doc, m, ids) !== "owner") continue;
    const prev = ownerActivity[m.threadId];
    if (!prev || prev < m.sentAt) ownerActivity = { ...ownerActivity, [m.threadId]: m.sentAt };
  }
  return ownerActivity === doc.ownerActivity ? doc : { ...doc, ownerActivity };
}

/** True while the owner's last message in this thread is inside the watch window. */
export function isWatchOnly(doc: TrackerDocument, threadId: string, nowIso: string, windowMinutes: number): boolean {
  const last = doc.ownerActivity?.[threadId];
  if (!last) return false;
  const age = new Date(nowIso).getTime() - new Date(last).getTime();
  return Number.isFinite(age) && age >= 0 && age < windowMinutes * 60_000;
}

/** Threads currently in watch-only mode. */
export function watchOnlyThreads(doc: TrackerDocument, nowIso: string, windowMinutes: number): string[] {
  return Object.keys(doc.ownerActivity ?? {}).filter((t) => isWatchOnly(doc, t, nowIso, windowMinutes));
}
