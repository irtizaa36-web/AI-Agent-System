import { join } from "node:path";
import { ReplyDrafter } from "./drafter";
import { JsonFileVoiceStateStore, type VoiceStateStore } from "./store";
import { OutboxVoiceReplyTransport, type VoiceReplyTransport } from "./transport";
import { CODE_BROKER_ENV, isEnabled, REPLY_DRAFTER_ENV, REPLY_SEND_ENV, type SecurityAlert } from "./types";
import { VerificationBroker } from "./verification";

export interface VoiceSwitches {
  readonly codeBroker: boolean;
  readonly replyDrafting: boolean;
  readonly replySending: boolean;
}

export interface VoiceDeps {
  readonly store: VoiceStateStore;
  readonly broker: VerificationBroker;
  readonly drafter: ReplyDrafter;
  readonly switches: VoiceSwitches;
  acknowledgeAlert(id: string): Promise<SecurityAlert>;
}

/** All three switches read from the environment and are off unless set to exactly "true". */
export function voiceSwitchesFromEnv(env: NodeJS.ProcessEnv = process.env): VoiceSwitches {
  return {
    codeBroker: isEnabled(env[CODE_BROKER_ENV]),
    replyDrafting: isEnabled(env[REPLY_DRAFTER_ENV]),
    replySending: isEnabled(env[REPLY_SEND_ENV]),
  };
}

export function createVoiceDeps(input: {
  readonly store: VoiceStateStore;
  readonly transport: VoiceReplyTransport;
  readonly switches: VoiceSwitches;
  readonly now?: () => Date;
}): VoiceDeps {
  const { store, transport, switches, now } = input;
  return {
    store,
    switches,
    broker: new VerificationBroker(store, { enabled: switches.codeBroker, now }),
    drafter: new ReplyDrafter(store, { draftingEnabled: switches.replyDrafting, sendingEnabled: switches.replySending, transport, now }),
    async acknowledgeAlert(id: string): Promise<SecurityAlert> {
      let acked: SecurityAlert | undefined;
      await store.update((doc) => {
        const alert = doc.alerts.find((a) => a.id === id);
        if (!alert) throw new Error(`No alert "${id}".`);
        acked = { ...alert, acknowledged: true };
        return { ...doc, alerts: doc.alerts.map((a) => (a.id === id ? acked! : a)) };
      });
      return acked!;
    },
  };
}

/** The real wiring: state and outbox under the gitignored .orchestrator/voice/. */
export function createDefaultVoiceDeps(cwd: string, env: NodeJS.ProcessEnv = process.env): VoiceDeps {
  const dir = join(cwd, ".orchestrator", "voice");
  return createVoiceDeps({
    store: new JsonFileVoiceStateStore(join(dir, "state.json")),
    transport: new OutboxVoiceReplyTransport(join(dir, "outbox")),
    switches: voiceSwitchesFromEnv(env),
  });
}
