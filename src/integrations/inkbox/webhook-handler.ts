import { resumeWithReply } from "../../core/orchestrator";
import type { Registry } from "../../registry/registry";
import type { RunStore } from "../../store/run-store";
import type { EmailMessage, InkboxClient } from "./client";
import type { ForwardingLog } from "./forwarding-log";
import type { MessageEventLog, MessageLifecycleEvent } from "./message-event-log";
import { getOwnerForwardAddress, shouldForwardInbound } from "./owner-forwarding";
import type { InkboxWebhookEvent } from "./webhook";

export interface WebhookHandlerDeps {
  readonly inkboxClient: InkboxClient;
  readonly forwardingLog: ForwardingLog;
  readonly messageEventLog: MessageEventLog;
  readonly registry: Registry;
  readonly store: RunStore;
}

/** A short, human-readable audit trail of what this one event caused — logged by the CLI, never containing secrets. */
export interface WebhookHandlingResult {
  readonly event: string;
  readonly actions: readonly string[];
}

function str(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function strArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : [];
}

/**
 * Confirmed against a real delivered payload: the message fields are
 * nested under `data.message`, not flat on `data` itself, e.g.
 * `data.message.{id, thread_id, from_address, to_addresses, subject, body,
 * created_at}`. Falls back to a flat `data` shape too, in case a future
 * event type (or a documentation-only source) doesn't nest the same way —
 * degrades to undefined rather than throwing either way.
 *
 * `body` is frequently `null` here (Inkbox may report `body_state:
 * "unavailable"` and omit it from the webhook payload itself) — this
 * returns whatever the payload had, which can be `""`. Callers that need
 * the real content (e.g. resuming a waiting Run) must re-fetch it via
 * `InkboxClient.getMessage`, the same way `forward()` already does.
 */
function parseWebhookMessage(data: Record<string, unknown>): EmailMessage | undefined {
  const nested = typeof data["message"] === "object" && data["message"] !== null ? (data["message"] as Record<string, unknown>) : data;

  const id = str(nested["id"]) ?? str(nested["message_id"]);
  const fromAddress = str(nested["from_address"]);
  if (!id || !fromAddress) return undefined;

  return {
    id,
    threadId: str(nested["thread_id"]) ?? id,
    from: { address: fromAddress },
    to: strArray(nested["to_addresses"]).map((address) => ({ address })),
    subject: str(nested["subject"]) ?? "",
    body: str(nested["body"]) ?? str(nested["body_text"]) ?? str(nested["snippet"]) ?? "",
    receivedAt: str(nested["created_at"]) ?? new Date().toISOString(),
  };
}

/** Forwards a newly-received inbound message to the owner exactly once, then tries to resume a matching waiting Run. */
async function handleMessageReceived(message: EmailMessage, deps: WebhookHandlerDeps, actions: string[]): Promise<void> {
  const owner = getOwnerForwardAddress();
  const alreadyForwarded = await deps.forwardingLog.hasForwarded(message.id);

  if (alreadyForwarded) {
    actions.push("forwarding skipped: already forwarded");
  } else {
    const decision = shouldForwardInbound(message.from.address, deps.inkboxClient.mailboxAddress);
    if (decision.forward && owner) {
      try {
        const result = await deps.inkboxClient.forward(message.id, { address: owner });
        await deps.forwardingLog.record({
          messageId: message.id,
          forwardedTo: owner,
          status: result.status === "forwarded" ? "forwarded" : "skipped",
          reason: result.reason,
          occurredAt: new Date().toISOString(),
        });
        actions.push(`forwarded to owner (${result.status})`);
      } catch (error) {
        // A forwarding failure is recorded on its own — it must never look
        // like the original inbound message itself failed to arrive.
        await deps.forwardingLog.record({
          messageId: message.id,
          forwardedTo: owner,
          status: "failed",
          reason: (error as Error).message,
          occurredAt: new Date().toISOString(),
        });
        actions.push(`forwarding failed: ${(error as Error).message}`);
      }
    } else {
      await deps.forwardingLog.record({
        messageId: message.id,
        forwardedTo: owner ?? "(disabled)",
        status: "skipped",
        reason: decision.reason,
        occurredAt: new Date().toISOString(),
      });
      actions.push(`forwarding skipped: ${decision.reason ?? "n/a"}`);
    }
  }

  const allRuns = await deps.store.list();
  const waitingRun = allRuns.find((run) => run.status === "waiting_for_response" && run.threadId === message.threadId);
  if (!waitingRun) {
    actions.push("no waiting run matched this thread");
    return;
  }

  // The webhook payload's body is frequently empty/unavailable inline —
  // re-fetch the real message to get actual content to resume with,
  // falling back to whatever the payload had if the re-fetch comes up empty.
  const fullMessage = await deps.inkboxClient.getMessage(message.id);
  const replyBody = fullMessage?.body || message.body;

  const agent = deps.registry.getAgent(waitingRun.agentName);
  const provider = deps.registry.getProvider(agent.providerName);
  const tools = deps.registry.toolMapFor(agent.toolNames);
  const resumed = await resumeWithReply(waitingRun, agent, { provider, tools }, replyBody);
  await deps.store.save(resumed);
  actions.push(`resumed run "${resumed.id}" (now "${resumed.status}")`);
}

async function recordLifecycleEvent(
  event: MessageLifecycleEvent,
  data: Record<string, unknown>,
  deps: WebhookHandlerDeps,
  actions: string[],
): Promise<void> {
  // Same envelope convention confirmed for message.received — assumed
  // consistent across the other message.* event types, with a flat-`data`
  // fallback for tolerance.
  const nested = typeof data["message"] === "object" && data["message"] !== null ? (data["message"] as Record<string, unknown>) : data;
  const messageId = str(nested["id"]) ?? str(nested["message_id"]);
  if (!messageId) {
    actions.push(`"${event}" event had no message id; not recorded`);
    return;
  }
  const detail = str(nested["reason"]) ?? str(nested["error"]) ?? str(nested["status"]);
  await deps.messageEventLog.record({ messageId, event, detail, occurredAt: new Date().toISOString() });
  actions.push(`recorded "${event}" for message "${messageId}"`);
}

/**
 * Processes one already-verified, already-parsed Inkbox webhook event.
 * Deliberately takes no raw HTTP concepts (headers, request/response) — see
 * webhook-server.ts for that — so this stays testable with fakes exactly
 * like the rest of Core/adapters in this project.
 */
export async function handleInkboxWebhookEvent(webhookEvent: InkboxWebhookEvent, deps: WebhookHandlerDeps): Promise<WebhookHandlingResult> {
  const actions: string[] = [];

  switch (webhookEvent.event) {
    case "message.received": {
      const message = parseWebhookMessage(webhookEvent.data);
      if (!message) {
        actions.push("payload did not contain a recognizable message; ignored");
        break;
      }
      await handleMessageReceived(message, deps, actions);
      break;
    }
    case "message.sent":
      await recordLifecycleEvent("sent", webhookEvent.data, deps, actions);
      break;
    case "message.delivered":
      await recordLifecycleEvent("delivered", webhookEvent.data, deps, actions);
      break;
    case "message.bounced":
      await recordLifecycleEvent("bounced", webhookEvent.data, deps, actions);
      break;
    case "message.failed":
      await recordLifecycleEvent("failed", webhookEvent.data, deps, actions);
      break;
    case "message.forwarded":
      await recordLifecycleEvent("forwarded_confirmation", webhookEvent.data, deps, actions);
      break;
  }

  return { event: webhookEvent.event, actions };
}
