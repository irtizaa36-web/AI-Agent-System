import { Registry } from "../registry/registry";
import type { Pack } from "../registry/pack";
import { createAnthropicProvider } from "../providers/anthropic";
import { createEchoProvider } from "../providers/fake";
import { readFileTool } from "../tools/read-file";
import { createInkboxSearchMailTool } from "../tools/inkbox-search-mail";
import { createInkboxReadThreadTool } from "../tools/inkbox-read-thread";
import { createInkboxSaveDraftTool } from "../tools/inkbox-save-draft";
import { createSendEmailTool } from "../tools/send-email";
import type { InkboxClient } from "../integrations/inkbox/client";
import { FakeInkboxClient } from "../integrations/inkbox/fake-client";
import { createInkboxClientFromEnv } from "../integrations/inkbox/real-client";
import type { DraftStore } from "../integrations/inkbox/draft-store";
import { coreDemoPack } from "../packs/core-demo/pack";
import { personalAssistantPack } from "../packs/personal-assistant/pack";

/**
 * Packs enabled by default. A future CLI flag or config file can change
 * which Packs load without touching the engine — this list is the only
 * place that currently decides.
 */
const ENABLED_PACKS: readonly Pack[] = [coreDemoPack, personalAssistantPack];

/**
 * Picks the real Inkbox client when INKBOX_API_KEY and INKBOX_MAILBOX_ADDRESS
 * are both set (see integrations/inkbox/real-client.ts), otherwise falls back
 * to the in-memory fake — never a half-configured real client. Tests, and
 * any environment that hasn't explicitly configured real Inkbox credentials,
 * get the fake automatically this way.
 */
export function createDefaultInkboxClient(draftStore?: DraftStore): InkboxClient {
  const real = createInkboxClientFromEnv({ draftStore });
  if (real) return real;
  const mailboxAddress = process.env["INKBOX_MAILBOX_ADDRESS"] ?? "agent@example.test";
  return new FakeInkboxClient(mailboxAddress);
}

/**
 * Builds the default Registry: engine-level Providers and Tools (available
 * to every Pack) plus whichever Packs are enabled. This function never
 * hardcodes a domain-specific Agent itself — that's exactly what Packs are
 * for. Loading Provider/Tool definitions from a config file on disk is a
 * later phase, not needed yet.
 *
 * Accepts an InkboxClient so the caller (the CLI, or a test) can hold the
 * same client instance the registered Inkbox tools use — otherwise a CLI
 * command that reads mail directly and an Agent Run that reads mail via a
 * Tool would silently see two different, unsynchronized fake mailboxes.
 */
export function loadDefaultConfig(inkboxClient: InkboxClient = createDefaultInkboxClient()): Registry {
  const registry = new Registry();

  registry.registerProvider(createAnthropicProvider());
  registry.registerProvider(createEchoProvider());

  registry.registerTool(readFileTool);
  registry.registerTool(createInkboxSearchMailTool(inkboxClient));
  registry.registerTool(createInkboxReadThreadTool(inkboxClient));
  registry.registerTool(createInkboxSaveDraftTool(inkboxClient));
  registry.registerTool(createSendEmailTool(inkboxClient));

  for (const pack of ENABLED_PACKS) {
    registry.registerPack(pack.name);
    pack.register(registry);
  }

  return registry;
}
