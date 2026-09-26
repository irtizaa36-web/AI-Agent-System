# OpenMuse cloud demo (GitHub Codespaces)

This branch (`demo/openmuse-cloud`) runs [CopilotKit/OpenMuse](https://github.com/CopilotKit/OpenMuse) in a GitHub Codespace and gives it a public URL. The OpenMuse source is in `openmuse/` (see `openmuse/UPSTREAM.md` for the pinned commit). The Codespace config is `.devcontainer/devcontainer.json`, and `demo/openmuse.sh` does the setup.

## What you get

| Port | Process | Visibility for the demo |
| --- | --- | --- |
| **8081** | OpenMuse web UI (Expo web / Metro) | **Public**: the URL you share |
| **8787** | OpenMuse API (Hono + CopilotKit runtime) | **Public**: the browser calls it directly from the web UI |
| 8790 | Optional browser worker (Playwright) | **Private.** Never forward it publicly. Only the API talks to it |

Model backend: **native Anthropic**. OpenMuse's model engine (`openmuse/apps/server/src/engine/tanstack-agent.ts`) calls Anthropic directly for `MODEL=anthropic/<model-id>`. The OpenAI-to-Anthropic shim at `127.0.0.1:8899` from the local setup is **not used**, and you don't need `OPENAI_API_KEY` or `OPENAI_BASE_URL`.

```ini
WORKSPACE_MODE=sample               # fictional mailbox/data; required for HOST=127.0.0.1
AGENT_BACKEND=model
MODEL=anthropic/claude-sonnet-4-5   # override with MODEL=anthropic/<id> before `demo/openmuse.sh env`
ANTHROPIC_API_KEY=<Codespaces secret>
CPK_INTELLIGENCE_API_KEY=<Codespaces secret>   # OpenMuse refuses to start without it, in every mode
PORT=8787
HOST=127.0.0.1                      # Codespaces forwards loopback ports; sample mode requires loopback
PUBLIC_API_URL=https://$CODESPACE_NAME-8787.$GITHUB_CODESPACES_PORT_FORWARDING_DOMAIN
ALLOWED_ORIGINS=https://$CODESPACE_NAME-8081.$GITHUB_CODESPACES_PORT_FORWARDING_DOMAIN,...
EXPO_PUBLIC_API_URL=<same as PUBLIC_API_URL>   # passed to the web UI at start; baked into the bundle
```

`demo/openmuse.sh env` writes all of this to `openmuse/.env` (git-ignored). You don't need to edit it by hand.

## 1. Create the Codespaces secrets (once)

On GitHub, go to **Settings → Codespaces → Secrets → New secret**, either in your user settings or in the repository settings. Create these two secrets and give each one access to `irtizaa36-web/AI-Agent-System`:

| Secret | Value |
| --- | --- |
| `ANTHROPIC_API_KEY` | An Anthropic API key. Use a key with a spend limit, because the demo URL is public. |
| `CPK_INTELLIGENCE_API_KEY` | The server-only CopilotKit Intelligence project key. Create it with `npx copilotkit@latest login` and then `npx copilotkit@latest project select`. |

`devcontainer.json` also lists both secrets, so the **Create codespace** screen prompts for any that are missing.

## 2. Open a Codespace on this branch

In the repository, open **Code → Codespaces → ⋯ → New with options**. Choose branch **`demo/openmuse-cloud`**, keep the default dev container ("OpenMuse cloud demo"), and select **Create codespace**.

Or use the GitHub CLI:

```sh
gh codespace create -R irtizaa36-web/AI-Agent-System -b demo/openmuse-cloud
```

The container has Node 24 (OpenMuse needs 22 or later), Python 3.12, and the GitHub CLI. `postCreateCommand` installs pnpm 11.19.0 and runs `pnpm install --frozen-lockfile` in `openmuse/`, which takes about 1–2 minutes.

If you added the secrets after the Codespace was created, **stop and restart the Codespace** so it picks them up. Then check:

```sh
test -n "$ANTHROPIC_API_KEY" && test -n "$CPK_INTELLIGENCE_API_KEY" && echo secrets OK
```

## 3. Configure the model backend

```sh
demo/openmuse.sh env
```

This writes `openmuse/.env` with the native Anthropic settings above and this Codespace's forwarded URLs. To use a different Claude model, run `MODEL=anthropic/<model-id> demo/openmuse.sh env`.

## 4. Start the server and the web UI

Terminal 1 starts the API:

```sh
demo/openmuse.sh api          # = cd openmuse && pnpm dev
```

When it's ready it prints `OpenMuse sample API ready at https://<codespace>-8787.app.github.dev`.

Terminal 2 starts the web UI:

```sh
demo/openmuse.sh web          # = cd openmuse && EXPO_PUBLIC_API_URL=<public 8787 URL> pnpm dev:web
```

Wait for `Web Bundled …`. The first load of the page compiles about 2,700 modules, so it takes 10–20 seconds.

## 5. Make the forwarded ports public

Both ports must be public. The web UI runs in the viewer's browser and calls the API URL cross-origin, and a private Codespaces port rejects those requests.

```sh
demo/openmuse.sh public       # = gh codespace ports visibility 8787:public 8081:public -c "$CODESPACE_NAME"
demo/openmuse.sh urls         # prints the URL to share
```

In the UI, you can do the same thing from the **Ports** panel: right-click port 8787, choose **Port Visibility → Public**, and then repeat for port 8081.

Share the **8081** URL: `https://<codespace>-8081.app.github.dev`. On the sign-in screen, select **Connect**. Sample mode doesn't need an access key.

Check the API with `curl https://<codespace>-8787.app.github.dev/api/health`. It should return `{"ok":true,"mode":"sample","agentConfigured":true,...}`.

Try these in the UI:
- In Chat, send "Complete the permission slip".
- Under **Goals → Track**, create an availability watch.
- Under **Menu → Delegate task → Finance**, choose **Try example transactions**.
- Ask any open-ended question. Claude answers it through the native Anthropic backend.

## 6. (Optional) Browser worker for "Summarize copilotkit.ai"-style prompts

Terminal 3:

```sh
cd openmuse
pnpm --dir apps/worker exec playwright install --with-deps chromium
pnpm dev:browser              # reads BROWSER_WORKER_URL / WORKER_TOKEN from openmuse/.env
```

The worker listens on `127.0.0.1:8790`. **Leave 8790 private.** The API reaches it over loopback, and **Take control** is proxied through the API.

## Security: read before sharing the URL

- **Sample mode has no login.** Anyone who has the public 8081/8787 URLs can chat with the agent, and every chat spends your `ANTHROPIC_API_KEY`. Share the URLs only with the people who are meant to use the demo. Use a key with a spend limit.
- After the demo, run `demo/openmuse.sh private` and **stop the Codespace**. Codespaces also stops it automatically after the idle timeout, and restarting it resets the ports to private.
- The mailbox, documents, and finance data are fictional. No Google account is connected. Live Google mode (`WORKSPACE_MODE=live`) needs OAuth and an access key and is out of scope for this demo.
- `openmuse/.env`, `openmuse/.openmuse/`, and browser profiles are git-ignored. Don't commit them.

## Troubleshooting

| Symptom | Fix |
| --- | --- |
| `error: ANTHROPIC_API_KEY is not set` | Add the Codespaces secret, then restart the Codespace. |
| API exits with `OpenMuse requires CPK_INTELLIGENCE_API_KEY` | Add the `CPK_INTELLIGENCE_API_KEY` secret, restart the Codespace, and rerun `demo/openmuse.sh env`. |
| `Sample workspace is local-only. HOST must be a loopback address.` | Keep `HOST=127.0.0.1`. Codespaces forwarding still works. |
| UI loads, but Connect fails or there's a CORS error in the console | Port 8787 isn't public, or `ALLOWED_ORIGINS` is stale. Run `demo/openmuse.sh public`, rerun `demo/openmuse.sh env`, and restart the API. |
| UI still calls `localhost:8787` | Start the UI with `demo/openmuse.sh web`, not with plain `pnpm dev:web`, so that `EXPO_PUBLIC_API_URL` gets set. |
| `agentConfigured:false` in `/api/health` | `MODEL` or `ANTHROPIC_API_KEY` is missing from `openmuse/.env`. Rerun `demo/openmuse.sh env`. |
