import type { EmailAddress } from "./client";

const OWNER_FORWARD_ENV_VAR = "OWNER_FORWARD_EMAIL";
const OWNER_FORWARD_EXCLUDE_ENV_VAR = "OWNER_FORWARD_EXCLUDE_RECIPIENTS";

/** Unset by design until explicitly configured — never hard-code, never prompt for it. */
export function getOwnerForwardAddress(): string | undefined {
  const value = process.env[OWNER_FORWARD_ENV_VAR];
  return value && value.trim().length > 0 ? value.trim().toLowerCase() : undefined;
}

/**
 * Addresses whose forwarded mail stream the owner does not want a personal
 * copy of — comma-separated, e.g. "brshivani@gmail.com". Exists because
 * Gmail's own forwarding (Settings > Forwarding and POP/IMAP) is all-or-
 * nothing: there is no way to forward only Shivani's LinkedIn job alerts to
 * this mailbox without also forwarding everything else in her inbox — her
 * retail marketing subscriptions included. Confirmed in production Sep 16:
 * Reebok, Kendra Scott, T3 Micro and similar started flooding Irtiza's own
 * inbox once that forwarding was switched on, stacked on top of this
 * project's own owner-forward (every inbound message gets echoed to the
 * owner for oversight). Gmail preserves the original `To:` header through
 * its forwarding, so the original recipient is still visible on the message
 * once it lands here — that is the signal this list is matched against, not
 * the sender (the sender varies as much as anyone else's mail would).
 */
function getExcludedRecipients(): readonly string[] {
  const value = process.env[OWNER_FORWARD_EXCLUDE_ENV_VAR];
  if (!value) return [];
  return value
    .split(",")
    .map((address) => address.trim().toLowerCase())
    .filter((address) => address.length > 0);
}

function includesAddress(addresses: readonly EmailAddress[], address: string): boolean {
  return addresses.some((a) => a.address.toLowerCase() === address.toLowerCase());
}

/**
 * The BCC list an outbound email should actually carry: the owner's forward
 * address appended, unless forwarding is disabled (unset env var), the
 * owner is already a direct recipient (avoid a duplicate copy), or the
 * owner *is* the sending mailbox (avoid a pointless self-BCC). Pure and
 * total — no I/O — so the exact-approval preview and the actual send can
 * both call it and always agree.
 */
export function computeOutboundBcc(
  to: readonly EmailAddress[],
  existingBcc: readonly EmailAddress[],
  fromAddress: string,
): readonly EmailAddress[] {
  const owner = getOwnerForwardAddress();
  if (!owner) return existingBcc;
  if (owner === fromAddress.toLowerCase()) return existingBcc;
  if (includesAddress(to, owner) || includesAddress(existingBcc, owner)) return existingBcc;
  return [...existingBcc, { address: owner }];
}

/**
 * Whether a message sitting in the mailbox should be forwarded to the owner
 * as *inbound* mail: forwarding must be enabled, the message must not have
 * originated from the owner's own address (loop prevention), it must not be
 * our own outbound copy of something we sent (that copy was already BCC'd
 * at send time — forwarding it too would duplicate it), and its original
 * recipient (before it was forwarded into this mailbox) must not be on the
 * excluded-recipients list — see `getExcludedRecipients`'s doc comment for
 * why that check exists and why it looks at the recipient, not the sender.
 * `toAddresses` defaults to empty so existing callers that haven't been
 * updated to pass it keep working exactly as before (the exclusion check is
 * simply a no-op with nothing to match against).
 */
export function shouldForwardInbound(
  fromAddress: string,
  mailboxAddress: string,
  toAddresses: readonly string[] = [],
): { forward: boolean; reason?: string } {
  const owner = getOwnerForwardAddress();
  if (!owner) return { forward: false, reason: "OWNER_FORWARD_EMAIL is not configured" };
  if (owner === fromAddress.toLowerCase()) {
    return { forward: false, reason: "message originated from the owner's own forwarding address" };
  }
  if (fromAddress.toLowerCase() === mailboxAddress.toLowerCase()) {
    return { forward: false, reason: "message is our own outbound copy, already BCC'd at send time" };
  }
  const excluded = getExcludedRecipients();
  if (excluded.length > 0) {
    const matched = toAddresses.find((address) => excluded.includes(address.toLowerCase()));
    if (matched) {
      return {
        forward: false,
        reason: `message was originally addressed to ${matched}, which is excluded from owner-forwarding`,
      };
    }
  }
  return { forward: true };
}
