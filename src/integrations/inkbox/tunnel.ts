/**
 * Establishes the real Inkbox tunnel — the persistent, authenticated
 * data-plane connection that makes a public `*.inkboxwire.com` subdomain
 * actually route traffic to a local server. This is the one file in the
 * project that imports `@inkbox/sdk`: the Mail API itself needs no SDK
 * (see real-client.ts, built on plain `fetch` per ADR 0002), but there is
 * no documented raw-protocol alternative to this connection — the SDK's
 * own docs describe it as programmatic-only, no CLI/binary equivalent.
 */
export interface TunnelConfig {
  readonly apiKey: string;
  readonly tunnelName: string;
  readonly forwardTo: string;
}

/**
 * Reads tunnel config from the environment. Returns undefined (never
 * throws) when INKBOX_API_KEY or INKBOX_TUNNEL_NAME is missing, so a
 * caller can cleanly run the local receiver only, without a tunnel,
 * instead of half-configuring one.
 */
export function getTunnelConfigFromEnv(forwardTo: string): TunnelConfig | undefined {
  const apiKey = process.env["INKBOX_API_KEY"];
  const tunnelName = process.env["INKBOX_TUNNEL_NAME"];
  if (!apiKey || !tunnelName) return undefined;
  return { apiKey, tunnelName, forwardTo };
}

export interface ConnectedTunnel {
  readonly publicUrl: string;
  close(): Promise<void>;
}

/**
 * Brings the tunnel online, forwarding its public URL to a local address.
 * The tunnel must already exist for the calling org (provisioned when the
 * Inkbox identity/agent handle was created) — this only connects to it.
 * Never called during tests: it requires a real API key and makes a real
 * network connection, by design (there is nothing to fake here — a tunnel
 * either really connects or it doesn't).
 */
export async function connectTunnel(config: TunnelConfig): Promise<ConnectedTunnel> {
  const { Inkbox } = await import("@inkbox/sdk");
  const { connect } = await import("@inkbox/sdk/tunnels/connect");

  const inkbox = new Inkbox({ apiKey: config.apiKey });
  const listener = await connect(inkbox, { name: config.tunnelName, forwardTo: config.forwardTo });

  return {
    publicUrl: listener.publicUrl,
    close: () => listener.close(),
  };
}
