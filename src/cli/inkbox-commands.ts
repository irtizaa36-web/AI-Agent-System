import { parseArgs } from "node:util";
import { randomUUID } from "node:crypto";
import { createTask } from "../core/task";
import { runToCompletion, approveAndExecute, resumeWithReply } from "../core/orchestrator";
import { FakeProvider } from "../providers/fake";
import type { EmailAddress } from "../integrations/inkbox/client";
import { getOwnerForwardAddress, shouldForwardInbound } from "../integrations/inkbox/owner-forwarding";
import { INKBOX_WEBHOOK_PATH } from "../integrations/inkbox/webhook";
import { startInkboxWebhookServer } from "../integrations/inkbox/webhook-server";
import { connectTunnel, getTunnelConfigFromEnv, type ConnectedTunnel } from "../integrations/inkbox/tunnel";
import type { CliDeps } from "./index";

const DEFAULT_WEBHOOK_PORT = 8787;

function parseAddresses(raw: string | undefined): readonly EmailAddress[] {
  if (!raw) return [];
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
    .map((address) => ({ address }));
}

function formatAddresses(addresses: readonly EmailAddress[]): string {
  return addresses.map((a) => a.address).join(", ") || "(none)";
}

async function draftCommand(args: readonly string[], deps: CliDeps): Promise<number> {
  const { values } = parseArgs({
    args: [...args],
    options: {
      to: { type: "string" },
      subject: { type: "string" },
      body: { type: "string" },
      thread: { type: "string" },
      "draft-id": { type: "string" },
    },
  });

  if (!values.to || !values.subject || !values.body) {
    deps.stderr('Usage: orchestrator inkbox draft --to "a@b.com,c@d.com" --subject "..." --body "..." [--thread <id>] [--draft-id <id>]');
    return 1;
  }

  const tool = deps.registry.getTool("inkbox-save-draft");
  const output = await tool.execute({
    to: parseAddresses(values.to),
    subject: values.subject,
    body: values.body,
    threadId: values.thread,
    draftId: values["draft-id"],
  });
  deps.stdout(output);
  return 0;
}

async function reviewDraftCommand(args: readonly string[], deps: CliDeps): Promise<number> {
  const { values } = parseArgs({ args: [...args], options: { "draft-id": { type: "string" } } });
  if (!values["draft-id"]) {
    deps.stderr("Usage: orchestrator inkbox review-draft --draft-id <id>");
    return 1;
  }

  const draft = await deps.inkboxClient.getDraft(values["draft-id"]);
  if (!draft) {
    deps.stderr(`No draft "${values["draft-id"]}" found.`);
    return 1;
  }

  deps.stdout(
    [
      `draftId:${draft.id}`,
      `revision:${draft.revision}`,
      `to:${formatAddresses(draft.to)}`,
      `bcc:${formatAddresses(draft.bcc ?? [])}`,
      `subject:${draft.subject}`,
      `body:${draft.body}`,
    ].join("\n"),
  );
  return 0;
}

async function prepareSendCommand(args: readonly string[], deps: CliDeps): Promise<number> {
  const { values } = parseArgs({ args: [...args], options: { "draft-id": { type: "string" } } });
  if (!values["draft-id"]) {
    deps.stderr("Usage: orchestrator inkbox prepare-send --draft-id <id>");
    return 1;
  }

  const draft = await deps.inkboxClient.getDraft(values["draft-id"]);
  if (!draft) {
    deps.stderr(`No draft "${values["draft-id"]}" found.`);
    return 1;
  }

  const agent = deps.registry.getAgent("inkbox-send");
  const tools = deps.registry.toolMapFor(agent.toolNames);
  // No real model call happens here: this scripts the one proposal a human
  // already made by choosing to stage this exact draft. `advance()` pauses
  // it in awaiting_approval via the same path a real Agent Run would use.
  const provider = new FakeProvider([
    {
      content: `Proposing to send draft "${draft.id}" (revision ${draft.revision}).`,
      toolCalls: [
        {
          id: randomUUID(),
          toolName: "send-email",
          input: { to: draft.to, subject: draft.subject, body: draft.body, bcc: draft.bcc ?? [], draftId: draft.id, revision: draft.revision },
        },
      ],
      stopReason: "tool_use",
    },
  ]);

  const run = await runToCompletion(createTask(`Send email: ${draft.subject}`), agent, { provider, tools });
  await deps.store.save(run);

  if (run.status !== "awaiting_approval" || !run.pendingAction) {
    deps.stderr(`Unexpected: run "${run.id}" did not pause for approval (status: ${run.status}).`);
    return 1;
  }

  const input = run.pendingAction.input as {
    to: readonly EmailAddress[];
    subject: string;
    body: string;
    bcc: readonly EmailAddress[];
    draftId: string;
    revision: string;
  };
  deps.stdout(
    [
      `runId:${run.id}`,
      "Review this exactly, then approve with the identical values:",
      `  to: ${formatAddresses(input.to)}`,
      `  bcc: ${formatAddresses(input.bcc)}`,
      `  subject: ${input.subject}`,
      `  body: ${input.body}`,
      `  draft-id: ${input.draftId}`,
      `  revision: ${input.revision}`,
      "",
      `orchestrator inkbox approve-send --run ${run.id} --to "${formatAddresses(input.to)}" --subject "${input.subject}" ` +
        `--body "${input.body}" --bcc "${formatAddresses(input.bcc)}" --draft-id ${input.draftId} --revision ${input.revision}`,
    ].join("\n"),
  );
  return 0;
}

async function approveSendCommand(args: readonly string[], deps: CliDeps): Promise<number> {
  const { values } = parseArgs({
    args: [...args],
    options: {
      run: { type: "string" },
      to: { type: "string" },
      subject: { type: "string" },
      body: { type: "string" },
      bcc: { type: "string" },
      "draft-id": { type: "string" },
      revision: { type: "string" },
    },
  });

  if (!values.run || !values.to || !values.subject || !values.body || !values["draft-id"] || !values.revision) {
    deps.stderr(
      "Usage: orchestrator inkbox approve-send --run <id> --to <addrs> --subject <s> --body <b> " +
        "--bcc <addrs|(none)> --draft-id <id> --revision <rev>",
    );
    return 1;
  }

  const run = await deps.store.load(values.run);
  if (!run) {
    deps.stderr(`No run "${values.run}" found.`);
    return 1;
  }

  const bccRaw = values.bcc === "(none)" ? "" : values.bcc;
  const approvalInput = {
    to: parseAddresses(values.to),
    subject: values.subject,
    body: values.body,
    bcc: parseAddresses(bccRaw),
    draftId: values["draft-id"],
    revision: values.revision,
  };

  try {
    const agent = deps.registry.getAgent(run.agentName);
    const tools = deps.registry.toolMapFor(agent.toolNames);
    const approved = await approveAndExecute(run, { tools }, approvalInput);
    await deps.store.save(approved);
    deps.stdout(`Approved and sent. Run "${approved.id}" is now "${approved.status}".`);
    deps.stdout(approved.session.messages.at(-1)?.content ?? "");
    return 0;
  } catch (error) {
    deps.stderr((error as Error).message);
    return 1;
  }
}

async function checkRepliesCommand(_args: readonly string[], deps: CliDeps): Promise<number> {
  const owner = getOwnerForwardAddress();
  const allMail = await deps.inkboxClient.searchMail();

  for (const message of allMail) {
    if (await deps.forwardingLog.hasForwarded(message.id)) continue;
    const decision = shouldForwardInbound(message.from.address, deps.inkboxClient.mailboxAddress);
    if (!decision.forward || !owner) {
      await deps.forwardingLog.record({
        messageId: message.id,
        forwardedTo: owner ?? "(disabled)",
        status: "skipped",
        reason: decision.reason,
        occurredAt: new Date().toISOString(),
      });
      continue;
    }
    try {
      const result = await deps.inkboxClient.forward(message.id, { address: owner });
      await deps.forwardingLog.record({
        messageId: message.id,
        forwardedTo: owner,
        status: result.status === "forwarded" ? "forwarded" : "skipped",
        reason: result.reason,
        occurredAt: new Date().toISOString(),
      });
    } catch (error) {
      // A forwarding failure is recorded on its own — it must never look
      // like the original message failed to arrive, and must never block
      // the reply-matching below.
      await deps.forwardingLog.record({
        messageId: message.id,
        forwardedTo: owner,
        status: "failed",
        reason: (error as Error).message,
        occurredAt: new Date().toISOString(),
      });
    }
  }

  const allRuns = await deps.store.list();
  const waitingRuns = allRuns.filter((run) => run.status === "waiting_for_response" && run.threadId);

  let resumedCount = 0;
  for (const run of waitingRuns) {
    const thread = await deps.inkboxClient.readThread(run.threadId as string);
    const reply = thread?.messages.find((m) => m.from.address !== deps.inkboxClient.mailboxAddress);
    if (!reply) continue;

    const agent = deps.registry.getAgent(run.agentName);
    const provider = deps.registry.getProvider(agent.providerName);
    const tools = deps.registry.toolMapFor(agent.toolNames);
    const resumed = await resumeWithReply(run, agent, { provider, tools }, reply.body);
    await deps.store.save(resumed);
    deps.stdout(`Resumed run "${run.id}" with a reply from ${reply.from.address}; now "${resumed.status}".`);
    resumedCount += 1;
  }

  if (resumedCount === 0) {
    deps.stdout("No new replies matched a waiting run.");
  }
  return 0;
}

async function reviewOfferCommand(args: readonly string[], deps: CliDeps): Promise<number> {
  const { values } = parseArgs({ args: [...args], options: { run: { type: "string" } } });
  if (!values.run) {
    deps.stderr("Usage: orchestrator inkbox review-offer --run <id>");
    return 1;
  }

  const run = await deps.store.load(values.run);
  if (!run) {
    deps.stderr(`No run "${values.run}" found.`);
    return 1;
  }

  const last = run.session.messages.at(-1);
  deps.stdout(`Run "${run.id}" status: ${run.status}`);
  deps.stdout(
    "Latest message (raw content — structured extraction of times/deposits/deadlines requires a real " +
      "model reasoning over this text; it is not pattern-matched here):",
  );
  deps.stdout(`[${last?.role ?? "none"}] ${last?.content ?? "(no messages yet)"}`);
  return 0;
}

/**
 * Starts the real-time Inkbox mail webhook receiver and keeps running until
 * interrupted (Ctrl+C). This is the live counterpart to `check-replies`
 * (still available as a polling fallback) — see webhook-server.ts for the
 * actual verification (signature, timestamp, replay, bearer token) and
 * webhook-handler.ts for the forward/resume logic once a request is
 * verified.
 */
async function serveWebhookCommand(_args: readonly string[], deps: CliDeps): Promise<number> {
  const signingKey = process.env["INKBOX_WEBHOOK_SIGNING_KEY"];
  if (!signingKey) {
    deps.stderr(
      "INKBOX_WEBHOOK_SIGNING_KEY is not set. Create or rotate a signing key in Inkbox and set this " +
        "environment variable to it before starting the receiver.",
    );
    return 1;
  }

  const authToken = process.env["INKBOX_WEBHOOK_AUTH_TOKEN"];
  const port = Number(process.env["INKBOX_WEBHOOK_PORT"] ?? DEFAULT_WEBHOOK_PORT);
  if (!Number.isInteger(port) || port <= 0) {
    deps.stderr(`INKBOX_WEBHOOK_PORT must be a positive integer (got "${process.env["INKBOX_WEBHOOK_PORT"]}").`);
    return 1;
  }

  let started;
  try {
    started = await startInkboxWebhookServer(
      {
        inkboxClient: deps.inkboxClient,
        forwardingLog: deps.forwardingLog,
        messageEventLog: deps.messageEventLog,
        registry: deps.registry,
        store: deps.store,
      },
      {
        path: INKBOX_WEBHOOK_PATH,
        port,
        signingKey,
        authToken,
        onEvent: (result) => deps.stdout(`[inkbox webhook] ${result.event}: ${result.actions.join("; ") || "(no action)"}`),
        onRejected: (info) => deps.stderr(`[inkbox webhook] rejected (${info.statusCode}): ${info.reason}`),
      },
    );
  } catch (error) {
    deps.stderr(`Failed to start the webhook receiver: ${(error as Error).message}`);
    return 1;
  }

  deps.stdout("Inkbox webhook receiver is READY.");
  deps.stdout(`Listening locally on http://localhost:${started.port}${INKBOX_WEBHOOK_PATH}`);
  deps.stdout(authToken ? "Bearer-token check: enabled (INKBOX_WEBHOOK_AUTH_TOKEN is set)." : "Bearer-token check: disabled (INKBOX_WEBHOOK_AUTH_TOKEN is not set).");

  // The tunnel is what actually makes a public *.inkboxwire.com URL reach
  // this local server — starting the server alone does not. Only attempted
  // when real credentials are configured; never during tests.
  let tunnel: ConnectedTunnel | undefined;
  const tunnelConfig = getTunnelConfigFromEnv(`http://localhost:${started.port}`);
  if (tunnelConfig) {
    try {
      tunnel = await connectTunnel(tunnelConfig);
      deps.stdout(`Tunnel connected. Public URL: ${tunnel.publicUrl}${INKBOX_WEBHOOK_PATH}`);
    } catch (error) {
      deps.stderr(`Failed to connect the Inkbox tunnel: ${(error as Error).message}`);
      deps.stdout("Continuing with the local receiver only — it is not yet reachable from the public internet.");
    }
  } else {
    deps.stdout(
      "Tunnel NOT connected (INKBOX_API_KEY and/or INKBOX_TUNNEL_NAME not set). " +
        "This receiver is only reachable at the localhost URL above until both are configured.",
    );
  }

  deps.stdout("Press Ctrl+C to stop.");

  await new Promise<void>((resolve) => {
    const shutdown = (): void => {
      void (async () => {
        if (tunnel) await tunnel.close();
        started.server.close(() => resolve());
      })();
    };
    process.once("SIGINT", shutdown);
    process.once("SIGTERM", shutdown);
  });

  deps.stdout("Inkbox webhook receiver stopped.");
  return 0;
}

/**
 * A dry-run readiness check: confirms the receiver started by `serve-webhook`
 * (in a separate, still-running invocation) is actually up and listening,
 * before you point the real Inkbox webhook subscription at it. Never signed,
 * never touches Inkbox — just a local HTTP GET.
 */
async function webhookHealthCommand(args: readonly string[], deps: CliDeps): Promise<number> {
  const { values } = parseArgs({ args: [...args], options: { port: { type: "string" } } });
  const port = Number(values.port ?? process.env["INKBOX_WEBHOOK_PORT"] ?? DEFAULT_WEBHOOK_PORT);
  const url = `http://localhost:${port}${INKBOX_WEBHOOK_PATH}/health`;

  try {
    const response = await fetch(url);
    if (!response.ok) {
      deps.stderr(`Health check failed: ${url} responded with HTTP ${response.status}.`);
      return 1;
    }
    const body = (await response.json()) as { status?: string; bearerTokenRequired?: boolean };
    deps.stdout(`OK: receiver is up at ${url}`);
    deps.stdout(`Bearer token required: ${body.bearerTokenRequired ? "yes" : "no"}`);
    return 0;
  } catch (error) {
    deps.stderr(
      `Health check failed: could not reach ${url} (${(error as Error).message}). ` +
        'Is "orchestrator inkbox serve-webhook" running in another terminal?',
    );
    return 1;
  }
}

/** Dispatches `orchestrator inkbox <subcommand>`. */
export async function runInkboxCommand(argv: readonly string[], deps: CliDeps): Promise<number> {
  const [subcommand, ...rest] = argv;

  switch (subcommand) {
    case "draft":
      return draftCommand(rest, deps);
    case "review-draft":
      return reviewDraftCommand(rest, deps);
    case "prepare-send":
      return prepareSendCommand(rest, deps);
    case "approve-send":
      return approveSendCommand(rest, deps);
    case "check-replies":
      return checkRepliesCommand(rest, deps);
    case "review-offer":
      return reviewOfferCommand(rest, deps);
    case "serve-webhook":
      return serveWebhookCommand(rest, deps);
    case "webhook-health":
      return webhookHealthCommand(rest, deps);
    default:
      deps.stderr(
        `Unknown "inkbox" subcommand "${subcommand ?? ""}". ` +
          "Available: draft, review-draft, prepare-send, approve-send, check-replies, review-offer, " +
          "serve-webhook, webhook-health.",
      );
      return 1;
  }
}
