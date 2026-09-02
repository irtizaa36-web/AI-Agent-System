import type { Pack } from "../../registry/pack";

/**
 * The engine's own placeholder pack: the "default" (Claude) and "demo"
 * (fake provider) agents used for local development and the CLI's built-in
 * demo. Not a real product — proof that the Pack seam works, kept as the
 * worked example until a real domain pack (e.g. im-brain) exists.
 */
export const coreDemoPack: Pack = {
  name: "core-demo",
  register(registry) {
    registry.registerAgent({
      name: "default",
      providerName: "claude",
      model: "claude-sonnet-5",
      systemPrompt: "You are a helpful, concise assistant.",
      toolNames: ["read-file"],
    });

    registry.registerAgent({
      name: "demo",
      providerName: "fake",
      model: "fake-echo-1",
      systemPrompt: "You are a deterministic demo agent that echoes what it's told.",
      toolNames: [],
    });

    // A utility agent, not a conversational one: it exists only so
    // Runs driven directly by the CLI's `inkbox` commands (prepare-send,
    // resume) have a real, registered AgentDefinition to look up
    // toolNames/providerName from. Nothing calls its systemPrompt.
    registry.registerAgent({
      name: "inkbox-send",
      providerName: "fake",
      model: "n/a",
      systemPrompt: "",
      toolNames: ["send-email"],
    });
  },
};
