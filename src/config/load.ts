import { Registry } from "../registry/registry";
import type { Pack } from "../registry/pack";
import { createAnthropicProvider } from "../providers/anthropic";
import { createEchoProvider } from "../providers/fake";
import { readFileTool } from "../tools/read-file";
import { createInkboxSearchMailTool } from "../tools/inkbox-search-mail";
import { createInkboxReadThreadTool } from "../tools/inkbox-read-thread";
import { createInkboxSaveDraftTool } from "../tools/inkbox-save-draft";
import { createSendEmailTool } from "../tools/send-email";
import { createReadWebPageTool } from "../tools/read-web-page";
import type { InkboxClient } from "../integrations/inkbox/client";
import { FakeInkboxClient } from "../integrations/inkbox/fake-client";
import { createInkboxClientFromEnv } from "../integrations/inkbox/real-client";
import type { DraftStore } from "../integrations/inkbox/draft-store";
import type { BrowserClient } from "../integrations/browser/client";
import { FakeBrowserClient } from "../integrations/browser/fake-client";
import { createBrowserClientFromSession, createPublicBrowserClient } from "../integrations/browser/real-client";
import type { FormFillingClient } from "../integrations/browser/form-client";
import { RealFormFillingClient } from "../integrations/browser/real-form-client";
import { createBrowserListFormFieldsTool } from "../tools/browser-list-form-fields";
import { createBrowserFillFormPreviewTool } from "../tools/browser-fill-form-preview";
import { createBrowserSubmitFormTool } from "../tools/browser-submit-form";
import type { PolymarketClient } from "../integrations/polymarket/client";
import { createPolymarketClientFromEnv } from "../integrations/polymarket/real-client";
import { createPolymarketFindMarketsTool } from "../tools/polymarket-find-markets";
import { createPolymarketGetQuoteTool } from "../tools/polymarket-get-quote";
import { createPolymarketPreviewOrderTool } from "../tools/polymarket-preview-order";
import { createPolymarketPlaceOrderTool } from "../tools/polymarket-place-order";
import { createReadJobBoardPageTool } from "../tools/read-job-board-page";
import { createXSearchSweepTool } from "../tools/x-search-sweep";
import { withSummarization } from "../tools/with-summarization";
import { createGraphRecallTool } from "../tools/graph-recall";
import { createGraphRecordTool } from "../tools/graph-record";
import { InMemoryGraphStore, type GraphStore } from "../store/graph-store";
import { coreDemoPack } from "../packs/core-demo/pack";
import { personalAssistantPack } from "../packs/personal-assistant/pack";
import { dispatcherPack } from "../packs/dispatcher/pack";
import { careerAdvisorPack } from "../packs/career-advisor/pack";
import { aiResearchPack } from "../packs/ai-research/pack";
import { jobSearchPack } from "../packs/job-search/pack";
import { publicAgentCreationPack } from "../packs/public-agent-creation/pack";
import { predictionMarketsPack } from "../packs/prediction-markets/pack";
import type { SleeperReadClient } from "../integrations/sleeper/client";
import { createRealSleeperClient } from "../integrations/sleeper/real-client";
import type { SleeperWriteClient } from "../integrations/sleeper/write-gate";
import { createSleeperWriteClientFromEnv } from "../integrations/sleeper/graphql-client";
import { createSleeperFindLeaguesTool, createSleeperMatchupPreviewTool, createSleeperWaiverRecommendationsTool } from "../tools/sleeper-read-tools";
import { createSleeperExecuteWriteTool, createSleeperPreviewWriteTool } from "../tools/sleeper-write-tools";
import { createPickemBankrollStatusTool, createPickemBuildSlipTool, createPickemResearchLineTool } from "../tools/pickem-tools";
import { InMemoryPickemStore, type PickemStore } from "../sleeper/pickem/store";
import { sleeperPack } from "../packs/sleeper/pack";
import { createSettlementsDeps, type SettlementsDeps } from "../settlements/deps";
import { createSettlementsTools } from "../tools/settlements-tools";
import { settlementsPack } from "../packs/settlements/pack";

/**
 * Packs enabled by default. A future CLI flag or config file can change
 * which Packs load without touching the engine — this list is the only
 * place that currently decides.
 */
const ENABLED_PACKS: readonly Pack[] = [coreDemoPack, personalAssistantPack, dispatcherPack, careerAdvisorPack, aiResearchPack, jobSearchPack, publicAgentCreationPack, predictionMarketsPack, sleeperPack, settlementsPack];

/** Agents the Dispatcher should never route a goal to: itself, and utility agents with no real conversational job (ADR 0008). */
const NOT_DISPATCHABLE = new Set(["dispatcher", "inkbox-send", "demo"]);

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
 * Picks the real, Playwright-backed browser client (ADR 0007) when a human
 * has already run `browser login <siteName>` and saved a session, otherwise
 * falls back to the in-memory fake — never a half-configured real client.
 */
export function createDefaultBrowserClient(siteName: string): BrowserClient {
  return createBrowserClientFromSession(siteName) ?? new FakeBrowserClient(siteName);
}

/**
 * What the Sleeper Tools run against (ADR 0021). The read client needs no
 * credentials. The write client exists only when SLEEPER_TOKEN is set — there
 * is no fake fallback, so nothing can report a write that didn't happen. The
 * CLI passes a file-backed pick'em store; the default is in-memory.
 */
export interface SleeperDeps {
  readonly readClient: SleeperReadClient;
  readonly writeClient: SleeperWriteClient | undefined;
  readonly pickemStore: PickemStore;
}

/**
 * Optional dependencies passed as one named bag, so adding a domain doesn't
 * grow loadDefaultConfig's positional parameter list any further.
 */
export interface LoadOptions {
  /** Settlement tracker and research sources (ADR 0022). Default: an in-memory tracker seeded with the owner's pipeline. */
  readonly settlements?: SettlementsDeps;
  /** The browser client x-search-sweep runs against (ADR 0025). Default: the real, Playwright-backed client if `browser login x <url>` has been run for @WoozyBets, otherwise an in-memory fake. */
  readonly xBrowserClient?: BrowserClient;
}

export function defaultSleeperDeps(): SleeperDeps {
  return { readClient: createRealSleeperClient(), writeClient: createSleeperWriteClientFromEnv(), pickemStore: new InMemoryPickemStore() };
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
export function loadDefaultConfig(
  inkboxClient: InkboxClient = createDefaultInkboxClient(),
  browserClient: BrowserClient = createDefaultBrowserClient("sermo"),
  formFillingClient: FormFillingClient = new RealFormFillingClient(),
  jobBoardClient: BrowserClient = createPublicBrowserClient("job-boards"),
  graphStore: GraphStore = new InMemoryGraphStore(),
  polymarketClient: PolymarketClient = createPolymarketClientFromEnv(),
  sleeper: SleeperDeps = defaultSleeperDeps(),
  options: LoadOptions = {},
): Registry {
  const registry = new Registry();

  const anthropicProvider = createAnthropicProvider();
  registry.registerProvider(anthropicProvider);
  registry.registerProvider(createEchoProvider());

  // Read-only, informational Tools are wrapped with withSummarization so an
  // oversized file or page gets condensed by a cheap model before the
  // expensive agent's turn ever includes it (Spotify's "two cheap
  // assistants" pattern — see tools/with-summarization.ts). Tools whose
  // exact output another Tool or an approval gate depends on (send-email,
  // the browser form tools) are deliberately left unwrapped.
  const summarization = { provider: anthropicProvider };
  registry.registerTool(withSummarization(readFileTool, summarization));
  registry.registerTool(createInkboxSearchMailTool(inkboxClient));
  registry.registerTool(createInkboxReadThreadTool(inkboxClient));
  registry.registerTool(createInkboxSaveDraftTool(inkboxClient));
  registry.registerTool(createSendEmailTool(inkboxClient));
  registry.registerTool(withSummarization(createReadWebPageTool(browserClient), summarization));
  registry.registerTool(createBrowserListFormFieldsTool(formFillingClient));
  registry.registerTool(createBrowserFillFormPreviewTool(formFillingClient));
  registry.registerTool(createBrowserSubmitFormTool(formFillingClient));
  registry.registerTool(withSummarization(createReadJobBoardPageTool(jobBoardClient), summarization));
  registry.registerTool(withSummarization(createXSearchSweepTool(options.xBrowserClient ?? createDefaultBrowserClient("x")), summarization));
  registry.registerTool(createGraphRecallTool(graphStore));
  registry.registerTool(createGraphRecordTool(graphStore));
  registry.registerTool(createPolymarketFindMarketsTool(polymarketClient));
  registry.registerTool(createPolymarketGetQuoteTool(polymarketClient));
  registry.registerTool(createPolymarketPreviewOrderTool(polymarketClient));
  registry.registerTool(createPolymarketPlaceOrderTool(polymarketClient));
  registry.registerTool(createSleeperFindLeaguesTool(sleeper.readClient));
  registry.registerTool(createSleeperMatchupPreviewTool(sleeper.readClient));
  registry.registerTool(createSleeperWaiverRecommendationsTool(sleeper.readClient));
  registry.registerTool(createSleeperPreviewWriteTool(sleeper.readClient));
  registry.registerTool(createSleeperExecuteWriteTool(sleeper.readClient, sleeper.writeClient));
  registry.registerTool(createPickemResearchLineTool(sleeper.readClient));
  registry.registerTool(createPickemBankrollStatusTool(sleeper.pickemStore));
  registry.registerTool(createPickemBuildSlipTool(sleeper.pickemStore));
  for (const tool of createSettlementsTools(options.settlements ?? createSettlementsDeps())) registry.registerTool(tool);

  for (const pack of ENABLED_PACKS) {
    registry.registerPack(pack.name);
    pack.register(registry);
  }

  return registry;
}

/**
 * The agents the Dispatcher is allowed to route a goal to (ADR 0008):
 * every registered agent with a description, except itself and utility
 * agents with no real conversational job. An agent with no description is
 * silently excluded rather than shown with an empty one — it wasn't
 * written with dispatching in mind.
 */
export function dispatchableAgents(registry: Registry): readonly { readonly name: string; readonly description: string }[] {
  return registry
    .listAgents()
    .filter((agent) => agent.description && !NOT_DISPATCHABLE.has(agent.name))
    .map((agent) => ({ name: agent.name, description: agent.description as string }));
}
