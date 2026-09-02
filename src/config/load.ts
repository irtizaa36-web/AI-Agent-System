import { Registry } from "../registry/registry";
import type { Pack } from "../registry/pack";
import { createAnthropicProvider } from "../providers/anthropic";
import { createEchoProvider } from "../providers/fake";
import { readFileTool } from "../tools/read-file";
import { coreDemoPack } from "../packs/core-demo/pack";
import { personalAssistantPack } from "../packs/personal-assistant/pack";

/**
 * Packs enabled by default. A future CLI flag or config file can change
 * which Packs load without touching the engine — this list is the only
 * place that currently decides.
 */
const ENABLED_PACKS: readonly Pack[] = [coreDemoPack, personalAssistantPack];

/**
 * Builds the default Registry: engine-level Providers and Tools (available
 * to every Pack) plus whichever Packs are enabled. This function never
 * hardcodes a domain-specific Agent itself — that's exactly what Packs are
 * for. Loading Provider/Tool definitions from a config file on disk is a
 * later phase, not needed yet.
 */
export function loadDefaultConfig(): Registry {
  const registry = new Registry();

  registry.registerProvider(createAnthropicProvider());
  registry.registerProvider(createEchoProvider());

  registry.registerTool(readFileTool);

  for (const pack of ENABLED_PACKS) {
    registry.registerPack(pack.name);
    pack.register(registry);
  }

  return registry;
}
