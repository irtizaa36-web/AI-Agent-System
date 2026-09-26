import type { TrackerDocument } from "./types";
import { escalate, type Escalation } from "./policy";

/**
 * Owner-activity reconciliation (ADR 0024). Toozy sometimes replies from his
 * own phone in agent-managed threads. Given recent thread messages, detect
 * owner-sent messages (sender = his FB id) and update lead state instead of
 * double-messaging: record the reply, mark the thread owner-handled, and
 * stand the agent down on that thread.
 */

export const OWNER_FB_ID = "100066954623124";

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
): { doc: TrackerDocument; report: ReconcileReport } {
  const ownerActiveThreads: string[] = [];
  const notes: string[] = [];
  const escalations: Escalation[] = [];

  const ownerMsgs = messages.filter((m) => m.senderId === OWNER_FB_ID);
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
