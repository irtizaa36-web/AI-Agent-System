import { readFile } from "node:fs/promises";
import { parseArgs, type ParseArgsConfig } from "node:util";
import type { CliDeps } from "./index";
import type { VoiceDeps } from "../voice/deps";
import { DraftError } from "../voice/drafter";
import { redactCodes } from "../voice/redact";
import { CODE_BROKER_ENV, REPLY_DRAFTER_ENV, REPLY_SEND_ENV, type Listing, type ReplyDraft, type SecurityAlert } from "../voice/types";
import { VerificationError } from "../voice/verification";
import { parseVoiceEmail, toVoiceEmailInput } from "../voice/voice-email";

/**
 * `orchestrator voice ...` (ADR 0023): the Google Voice channel.
 *
 * - The verification-code broker uses a code only for a verification the
 *   agent started, for the service the message names, within 10 minutes.
 *   Every other code becomes an alert for Toozy.
 * - The reply drafter drafts templated replies to routine buyer texts,
 *   after the scam classifier. Each draft needs Toozy's exact-text approval,
 *   and sending has its own switch.
 *
 * Code values are printed once, on the `ingest` line that consumes them,
 * and are never written to a file.
 */

class UsageError extends Error {}

interface Command {
  readonly name: string;
  readonly usage: string;
  readonly summary: string;
  run(args: readonly string[], v: VoiceDeps, deps: CliDeps): Promise<void>;
}

function parse<T extends ParseArgsConfig["options"]>(args: readonly string[], options: T) {
  try {
    return parseArgs({ args: [...args], options, allowPositionals: true, strict: true });
  } catch (error) {
    throw new UsageError((error as Error).message);
  }
}

/** Single-quoted for a POSIX shell, so "$45" and apostrophes survive copy-paste. */
export function shellQuote(text: string): string {
  return `'${text.replace(/'/g, `'\\''`)}'`;
}

function formatAlert(a: SecurityAlert): string {
  return [
    `ALERT ${a.id} (${a.reason})${a.acknowledged ? " [acknowledged]" : ""}  ${a.at}`,
    `  from ${a.counterparty}, thread ${a.threadId}`,
    `  ${a.detail}`,
    ...(a.flags ? [`  flags: ${a.flags.join(", ")}`] : []),
    `  message: ${JSON.stringify(a.redactedText)}`,
  ].join("\n");
}

function formatDraft(d: ReplyDraft): string {
  const lines = [
    `DRAFT ${d.id} rev ${d.revision} [${d.status}] to ${d.counterparty} about listing ${d.listingId} (${d.intents.join(", ")})`,
    `  ${JSON.stringify(d.body)}`,
  ];
  if (d.status === "pending_approval")
    lines.push("  Toozy approves the exact text with:", `  orchestrator voice approve ${d.id} --revision ${d.revision} --body ${shellQuote(d.body)}`);
  if (d.status === "released") lines.push(`  Released to ${d.sendReference}. After the Gmail reply goes out: orchestrator voice mark-sent ${d.id} --gmail-message-id <id>`);
  return lines.join("\n");
}

function formatListing(l: Listing): string {
  return `${l.id}  [${l.status}]  ${l.title}  $${l.price}${l.priceFirm ? " firm" : ""}  ${l.localOnly ? "local pickup only" : "shipping ok"}` +
    `${l.pickupArea ? `  at ${l.pickupArea}` : ""}${l.pickupWindows.length ? `  (${l.pickupWindows.join("; ")})` : ""}`;
}

async function ingestOne(raw: unknown, v: VoiceDeps, deps: CliDeps): Promise<void> {
  const email = toVoiceEmailInput(raw);
  const message = parseVoiceEmail(email);
  if (!message) {
    deps.stdout(`${email.id}: not a Google Voice text or voicemail; ignored.`);
    return;
  }
  const code = await v.broker.ingest(message);
  switch (code.kind) {
    case "consumed":
      deps.stdout(`${email.id}: verification code for ${code.pending.service} (${code.pending.id}, "${code.pending.purpose}"): ${code.code.reveal()}`);
      deps.stdout("  Use it now in that flow. It is not stored anywhere, and the verification is closed.");
      return;
    case "alert":
      deps.stdout(`${email.id}: security alert for Toozy. The code was NOT used.\n${formatAlert(code.alert)}`);
      return;
    case "already-processed":
      deps.stdout(`${email.id}: already handled; nothing done.`);
      return;
    case "disabled":
    case "not-a-code":
      break;
  }
  const draft = await v.drafter.handle(message);
  switch (draft.kind) {
    case "drafted":
      deps.stdout(`${email.id}: reply drafted. Nothing is sent until Toozy approves this exact text.\n${formatDraft(draft.draft)}`);
      return;
    case "scam-alert":
      deps.stdout(`${email.id}: possible scam. No reply was drafted.\n${formatAlert(draft.alert)}`);
      return;
    case "needs-toozy":
      deps.stdout(`${email.id}: needs Toozy, no draft: ${draft.reasons.join("; ")}.`);
      return;
    case "verification-text":
      deps.stdout(`${email.id}: verification text with the code broker off (${CODE_BROKER_ENV}); nothing done.`);
      return;
    case "not-a-text":
      deps.stdout(`${email.id}: ${message.kind} from ${message.counterparty}: ${JSON.stringify(redactCodes(message.text))}`);
      return;
    case "already-processed":
      deps.stdout(`${email.id}: already handled; nothing done.`);
      return;
    case "disabled":
      deps.stdout(`${email.id}: text from ${message.counterparty}; reply drafting is off (${REPLY_DRAFTER_ENV}).`);
      return;
  }
}

const COMMANDS: readonly Command[] = [
  {
    name: "status",
    usage: "voice status",
    summary: "Which switches are on, open verifications, unacknowledged alerts, drafts waiting",
    async run(args, v, deps) {
      parse(args, {});
      const doc = await v.store.load();
      const on = (b: boolean) => (b ? "ON" : "off");
      deps.stdout(`code broker     ${on(v.switches.codeBroker)}  (${CODE_BROKER_ENV}="true")`);
      deps.stdout(`reply drafting  ${on(v.switches.replyDrafting)}  (${REPLY_DRAFTER_ENV}="true")`);
      deps.stdout(`reply sending   ${on(v.switches.replySending)}  (${REPLY_SEND_ENV}="true")`);
      const open = doc.pending.filter((p) => p.status === "open");
      deps.stdout(`open verifications: ${open.length} (fresh: ${open.filter((p) => v.broker.isFresh(p)).length})`);
      deps.stdout(`unacknowledged alerts: ${doc.alerts.filter((a) => !a.acknowledged).length}`);
      deps.stdout(`drafts waiting for approval: ${doc.drafts.filter((d) => d.status === "pending_approval").length}`);
    },
  },
  {
    name: "ingest",
    usage: "voice ingest --file <message.json>",
    summary: "Handle Voice emails read from Gmail (one JSON object or an array): {id, threadId, from, replyTo?, subject, body, receivedAt}",
    async run(args, v, deps) {
      const { values } = parse(args, { file: { type: "string" } });
      if (!values.file) throw new UsageError("--file is required");
      let parsed: unknown;
      try {
        parsed = JSON.parse(await readFile(values.file, "utf8"));
      } catch (error) {
        throw new UsageError(`could not read ${values.file} as JSON: ${(error as Error).message}`);
      }
      for (const raw of Array.isArray(parsed) ? parsed : [parsed]) await ingestOne(raw, v, deps);
    },
  },
  {
    name: "start-verification",
    usage: 'voice start-verification <service> --purpose "<which request of Toozy\'s>" [--alias name,name]',
    summary: "Right before asking a service to text a code: opens a 10-minute window for that service only",
    async run(args, v, deps) {
      const { values, positionals } = parse(args, { purpose: { type: "string" }, alias: { type: "string" } });
      if (!positionals[0]) throw new UsageError("service is required");
      if (!values.purpose) throw new UsageError("--purpose is required");
      const pending = await v.broker.start(positionals.join(" "), {
        purpose: values.purpose,
        aliases: values.alias ? values.alias.split(",") : [],
      });
      deps.stdout(`Opened ${pending.id} for ${pending.service} (names: ${pending.aliases.join(", ")}). Valid for 10 minutes, one code.`);
    },
  },
  {
    name: "pending",
    usage: "voice pending",
    summary: "Verifications the agent started, and whether each is still within 10 minutes",
    async run(args, v, deps) {
      parse(args, {});
      const pending = await v.broker.list();
      if (pending.length === 0) deps.stdout("No verifications.");
      for (const p of pending)
        deps.stdout(`${p.id}  ${p.service}  [${p.status}${p.status === "open" ? (v.broker.isFresh(p) ? ", fresh" : ", expired") : ""}]  started ${p.startedAt}  "${p.purpose}"`);
    },
  },
  {
    name: "cancel-verification",
    usage: "voice cancel-verification <id>",
    summary: "Close an open verification so no code can match it",
    async run(args, v, deps) {
      const { positionals } = parse(args, {});
      if (!positionals[0]) throw new UsageError("id is required");
      const p = await v.broker.cancel(positionals[0]);
      deps.stdout(`Cancelled ${p.id} (${p.service}).`);
    },
  },
  {
    name: "alerts",
    usage: "voice alerts [--all]",
    summary: "Security and scam alerts for Toozy (unacknowledged only, unless --all)",
    async run(args, v, deps) {
      const { values } = parse(args, { all: { type: "boolean", default: false } });
      const alerts = (await v.store.load()).alerts.filter((a) => values.all || !a.acknowledged);
      if (alerts.length === 0) deps.stdout("No alerts.");
      for (const a of alerts) deps.stdout(formatAlert(a));
    },
  },
  {
    name: "ack",
    usage: "voice ack <alert-id>",
    summary: "Mark an alert as seen by Toozy",
    async run(args, v, deps) {
      const { positionals } = parse(args, {});
      if (!positionals[0]) throw new UsageError("alert id is required");
      const a = await v.acknowledgeAlert(positionals[0]);
      deps.stdout(`Acknowledged ${a.id}.`);
    },
  },
  {
    name: "listing-add",
    usage: 'voice listing-add <id> --title "<title>" --price <dollars> [--firm] [--ships] [--pickup "Sat 10am-2pm;weekdays after 6pm"] [--area "<public meeting spot>"]',
    summary: "Record a listing replies can be drafted for (local pickup only unless --ships)",
    async run(args, v, deps) {
      const { values, positionals } = parse(args, {
        title: { type: "string" },
        price: { type: "string" },
        firm: { type: "boolean", default: false },
        ships: { type: "boolean", default: false },
        pickup: { type: "string" },
        area: { type: "string" },
      });
      if (!positionals[0] || !values.title || values.price === undefined) throw new UsageError("id, --title and --price are required");
      const price = Number(values.price.replace(/^\$/, ""));
      const listing = await v.drafter.addListing({
        id: positionals[0],
        title: values.title,
        price,
        priceFirm: values.firm === true,
        localOnly: values.ships !== true,
        pickupWindows: (values.pickup ?? "").split(";").map((w) => w.trim()).filter((w) => w.length > 0),
        ...(values.area ? { pickupArea: values.area } : {}),
        status: "available",
      });
      deps.stdout(`Added ${formatListing(listing)}`);
    },
  },
  {
    name: "listing-status",
    usage: "voice listing-status <id> available|pending|sold",
    summary: "Update a listing; unsent drafts written under the old status can no longer be sent",
    async run(args, v, deps) {
      const { positionals } = parse(args, {});
      const status = positionals[1];
      if (!positionals[0] || (status !== "available" && status !== "pending" && status !== "sold")) throw new UsageError("id and a status (available|pending|sold) are required");
      deps.stdout(`Updated ${formatListing(await v.drafter.setListingStatus(positionals[0], status))}`);
    },
  },
  {
    name: "listings",
    usage: "voice listings",
    summary: "Recorded listings",
    async run(args, v, deps) {
      parse(args, {});
      const listings = await v.drafter.listings();
      if (listings.length === 0) deps.stdout("No listings.");
      for (const l of listings) deps.stdout(formatListing(l));
    },
  },
  {
    name: "link",
    usage: "voice link <gmail-thread-id> <listing-id>",
    summary: "Say which listing a buyer's thread is about (needed once more than one listing is open)",
    async run(args, v, deps) {
      const { positionals } = parse(args, {});
      if (!positionals[0] || !positionals[1]) throw new UsageError("thread id and listing id are required");
      await v.drafter.linkThread(positionals[0], positionals[1]);
      deps.stdout(`Thread ${positionals[0]} is about ${positionals[1]}.`);
    },
  },
  {
    name: "drafts",
    usage: "voice drafts [--all]",
    summary: "Drafts waiting for approval or release (--all includes sent and rejected)",
    async run(args, v, deps) {
      const { values } = parse(args, { all: { type: "boolean", default: false } });
      const drafts = (await v.drafter.drafts()).filter((d) => values.all || ["pending_approval", "approved", "released"].includes(d.status));
      if (drafts.length === 0) deps.stdout("No drafts.");
      for (const d of drafts) deps.stdout(formatDraft(d));
    },
  },
  {
    name: "approve",
    usage: "voice approve <draft-id> --revision <n> --body '<the exact text>'",
    summary: "Toozy's approval of one draft's exact text; anything that differs is refused",
    async run(args, v, deps) {
      const { values, positionals } = parse(args, { revision: { type: "string" }, body: { type: "string" } });
      if (!positionals[0] || !values.revision || values.body === undefined) throw new UsageError("draft id, --revision and --body are required");
      const revision = Number(values.revision);
      if (!Number.isInteger(revision)) throw new UsageError("--revision must be a whole number");
      const d = await v.drafter.approve(positionals[0], revision, values.body);
      deps.stdout(`Approved ${d.id} rev ${d.revision}. Send with: orchestrator voice send ${d.id}`);
    },
  },
  {
    name: "edit",
    usage: "voice edit <draft-id> --body '<new text>'",
    summary: "Rewrite a draft; the new revision needs its own approval",
    async run(args, v, deps) {
      const { values, positionals } = parse(args, { body: { type: "string" } });
      if (!positionals[0] || values.body === undefined) throw new UsageError("draft id and --body are required");
      deps.stdout(formatDraft(await v.drafter.edit(positionals[0], values.body)));
    },
  },
  {
    name: "reject",
    usage: "voice reject <draft-id>",
    summary: "Discard a draft",
    async run(args, v, deps) {
      const { positionals } = parse(args, {});
      if (!positionals[0]) throw new UsageError("draft id is required");
      const d = await v.drafter.reject(positionals[0]);
      deps.stdout(`Rejected ${d.id}.`);
    },
  },
  {
    name: "send",
    usage: "voice send <draft-id>",
    summary: "Release one approved draft to the outbox for the Gmail reply (needs VOICE_REPLY_SEND_ENABLED)",
    async run(args, v, deps) {
      const { positionals } = parse(args, {});
      if (!positionals[0]) throw new UsageError("draft id is required");
      deps.stdout(formatDraft(await v.drafter.send(positionals[0])));
    },
  },
  {
    name: "mark-sent",
    usage: "voice mark-sent <draft-id> --gmail-message-id <id>",
    summary: "Record that the released reply went out as a Gmail reply",
    async run(args, v, deps) {
      const { values, positionals } = parse(args, { "gmail-message-id": { type: "string" } });
      if (!positionals[0] || !values["gmail-message-id"]) throw new UsageError("draft id and --gmail-message-id are required");
      const d = await v.drafter.markSent(positionals[0], values["gmail-message-id"]);
      deps.stdout(`Recorded ${d.id} as sent.`);
    },
  },
];

export function voiceUsage(): string {
  return ["Usage (orchestrator voice ...):", ...COMMANDS.map((c) => `  ${c.usage}\n      ${c.summary}`)].join("\n");
}

export async function runVoiceCommand(args: readonly string[], deps: CliDeps): Promise<number> {
  const voice = deps.voice;
  if (!voice) {
    deps.stderr("The Voice channel is not configured for this CLI invocation.");
    return 1;
  }
  const [name, ...rest] = args;
  const command = COMMANDS.find((c) => c.name === name);
  if (!command) {
    deps.stderr(voiceUsage());
    return 1;
  }
  try {
    await command.run(rest, voice, deps);
    return 0;
  } catch (error) {
    if (error instanceof UsageError) {
      deps.stderr(`${error.message}\nUsage: orchestrator ${command.usage}`);
      return 1;
    }
    if (error instanceof DraftError || error instanceof VerificationError) {
      deps.stderr(error.message);
      return 1;
    }
    deps.stderr(`voice ${command.name} failed: ${redactCodes((error as Error).message)}`);
    return 1;
  }
}
