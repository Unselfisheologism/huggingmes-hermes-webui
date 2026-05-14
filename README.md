---
title: HuggingMes Hermes WebUI
emoji: 🪽
colorFrom: blue
colorTo: indigo
sdk: docker
app_port: 7861
pinned: true
license: mit
---
# 🪽 HuggingMes + Hermes WebUI

> A merged Hugging Face Space that runs [Hermes Agent](https://github.com/NousResearch/hermes-agent) with [Hermes WebUI](https://github.com/nesquena/hermes-webui) as the primary chat interface. Your own self-hosted AI agent, on free HF Space hardware.

**This project is not original work.** It's a deployment recipe that combines three excellent existing projects into a single Space:

- **[Hermes Agent](https://github.com/NousResearch/hermes-agent)** by **[Nous Research](https://nousresearch.com)** — the actual AI agent (memory, tools, scheduling, multi-provider LLM support). All the intelligence comes from here.
- **[Hermes WebUI](https://github.com/nesquena/hermes-webui)** by **[@nesquena](https://github.com/nesquena)** — the three-panel browser UI (sessions, chat, workspace files) with SSE streaming, slash commands, profiles, themes, voice input, file browser, and 100+ other features. Used as the primary chat surface.
- **[HuggingMes](https://github.com/somratpro/HuggingMes)** by **[@somratpro](https://github.com/somratpro)** — the HF Space wrapper: Docker image, gateway auth, HF Dataset persistence, Cloudflare proxy/keep-alive, Telegram bridge.

This repo just glues them together so both UIs share one port, one auth token, and one persistence layer on a single HF Space. Full credit goes to the upstream maintainers.

---

## Setting up your own Space

### 1. Duplicate the Space

[![Duplicate this Space](https://huggingface.co/datasets/huggingface/badges/resolve/main/duplicate-this-space-xl.svg)](https://huggingface.co/spaces/f4b404/hermes?duplicate=true) Click on this → Name it whatever you want, pick CPU basic free hardware, keep space public. HF copies all files automatically.

(For advanced users)If you'd rather start from this repo,  create a new Space with **SDK = Docker** at [huggingface.co/new-space](https://huggingface.co/new-space) and upload everything in this repo to its `main` branch.

### 2. Add secrets (Settings → Variables and secrets)

**Required** (the Space will not start without these):

| Secret | What it is | How to get it |
| --- | --- | --- |
| `GATEWAY_TOKEN` | Your password — gates the WebUI login and the `/v1/*` API. Pick anything strong. | Anything u want to keep as a password for your chat and dashboard |
| `HF_TOKEN` | Persists your sessions, profiles, skills, cron jobs, memory, and workspace files across Space restarts by syncing to a private HF Dataset every 10 min. **Without this, restarts wipe everything.** | [huggingface.co/settings/tokens](https://huggingface.co/settings/tokens) → Create New token → **Write** scope |
| `CLOUDFLARE_WORKERS_TOKEN` | Auto-provisions two Cloudflare Workers: one as an outbound proxy (needed for Telegram, sometimes for blocked LLM providers) and one as a cron keep-alive worker that pings `/health` every 10 min so the Space doesn't sleep on free tier | Go to https://dash.cloudflare.com/profile/api-tokens → Create new token → Edit Cloudflare Workers (Use this template)|

**Optional advanced features**:

| Secret | What it does |
| --- | --- |
| `CLOUDFLARE_ACCOUNT_ID` | Explicit Cloudflare account ID if you have multiple |
| `TELEGRAM_BOT_TOKEN` | Enables the Telegram bridge so you can chat with Hermes from Telegram |
| `TELEGRAM_ALLOWED_USERS` | Comma-separated numeric Telegram user IDs allowed to use the bot |
| `PRIMARY_UI` | Set to `dashboard` to make `/` show the HuggingMes status page instead of the chat UI. Default is `webui`. |
| `SYNC_INTERVAL` | Backup cadence in seconds (default 600, range 60–86400) |
| `HERMES_AGENT_VERSION` | Pin the upstream Hermes Agent base image to a specific tag for reproducibility (default `latest`) |

### 3. Restart and open

hugging face Settings → **Restart this Space** (or **Factory reboot** if you changed the Dockerfile). Wait ~5–8 minutes for the first build. Watch the **Logs** tab — when you see this, you're ready:

```
HuggingMes + Hermes WebUI router listening on 0.0.0.0:7861
```

Open the Space URL (`https://<you>-<name>.hf.space`) in a **new tab** (the embedded HF iframe sometimes blocks the login cookie). You'll see a login page → enter your `GATEWAY_TOKEN` → the chat UI loads.
Open the Space URL (`https://<you>-<name>.hf.space/hm`) for the hermes dashboard

> **Tip**: bookmark the direct `*.hf.space` URL rather than the HF page — much smoother on mobile and avoids iframe quirks.

## What you can do once it's running

| URL | What's there |
| --- | --- |
| `/` | **Hermes WebUI** — three-panel chat with sessions, file browser, slash commands, profiles, themes, voice input, mermaid diagrams, syntax highlighting, tool cards, and everything else hermes-webui ships |
| `/hm` | HuggingMes status dashboard — gateway/WebUI/backup/Telegram/keepalive tiles |
| `/hm/app/` | Hermes's built-in dashboard — manage providers, profiles, cron jobs |
| `/v1/*` | OpenAI-compatible API — point any OpenAI SDK at it with `GATEWAY_TOKEN` as the API key |
| `/health` | JSON health probe — no auth, used by HF Spaces and the Cloudflare keepalive worker |
| `/telegram` | Telegram bot webhook (only if `TELEGRAM_BOT_TOKEN` is set) |

### Using the API from code

```bash
curl https://<you>-<name>.hf.space/v1/chat/completions \
  -H "Authorization: Bearer $GATEWAY_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "hermes",
    "messages": [{"role": "user", "content": "hello"}]
  }'
```

```python
from openai import OpenAI
client = OpenAI(
    base_url="https://<you>-<name>.hf.space/v1",
    api_key="<your GATEWAY_TOKEN>",
)
resp = client.chat.completions.create(
    model="hermes",
    messages=[{"role": "user", "content": "hello"}],
)
```

### Adding MCP servers

Open `/hm/app/config` (the Hermes config editor) and add an `mcp` block. No SSH needed:

```yaml
mcp:
  servers:
    fetch:
      command: uvx
      args: ["mcp-server-fetch"]
    filesystem:
      command: npx
      args: ["-y", "@modelcontextprotocol/server-filesystem", "/opt/data/workspace"]
```

`uvx` and `npx` are both pre-installed in the image.

## Persistence and how it works

When `HF_TOKEN` is set:

- **On boot**, the Space downloads the latest snapshot from your private HF Dataset (default name `huggingmes-backup`) and restores it into `/opt/data/`.
- **Every `SYNC_INTERVAL` seconds** (default 600), it detects state changes and uploads a new snapshot.
- **On graceful shutdown** (SIGTERM), it does one final sync before exit.

What gets backed up: chat sessions, agent memory, workspace files, profiles, skills, cron jobs, Hermes config. The dataset is private to your HF account.

## Architecture

Single port (7861) Node.js router fronts four backends:

```
HF Space port 7861
        │
        ▼
   health-server.js  (router + auth + status page)
        │
        ├─► /                  → Hermes WebUI         (127.0.0.1:8787)
        ├─► /hm                → HuggingMes status    (in-process)
        ├─► /hm/app/*          → Hermes dashboard     (127.0.0.1:9119)  [SPA-rewritten]
        ├─► /v1/*              → Hermes gateway API   (127.0.0.1:8642)  [bearer auth]
        ├─► /telegram          → Telegram webhook     (127.0.0.1:8765)
        └─► /health, /status   → in-process JSON
```

`start.sh` boots Hermes Agent's gateway + dashboard + WebUI as subprocesses, then the router on top. `hermes-sync.py` runs the periodic HF Dataset upload loop. Cloudflare and Telegram setup runs once at boot if their respective secrets are set.

## Local testing

```bash
git clone https://github.com/F4bC0d3/huggingmes-hermes-webui.git
cd huggingmes-hermes-webui
cp .env.example .env
# edit .env with real GATEWAY_TOKEN, LLM_API_KEY, LLM_MODEL
docker build -t huggingmes-hermes-webui .
docker run --rm -p 7861:7861 --env-file .env huggingmes-hermes-webui
# open http://localhost:7861
```

## Troubleshooting

| Symptom | Cause / Fix |
| --- | --- |
| Build fails on `nousresearch/hermes-agent:latest` | Set `HERMES_AGENT_VERSION` to a specific tag and restart |
| Container Running but `/` returns 502 | Hermes WebUI didn't bind. Check Logs tab for `webui.log` output — usually missing/wrong `LLM_API_KEY` |
| `/v1/*` returns 401 | Need `Authorization: Bearer <GATEWAY_TOKEN>` header |
| `/api/status` 404s in logs | Cosmetic — old browser tab polling. Ignored. |
| Login loops on `/login` | Browser embedded in HF iframe blocks cookies. Open the Space in a new tab. |
| `Dashboard pages blank or 404 on refresh` | Should be fixed by the SPA rewriter in health-server.js. Hard-refresh and unregister service worker if cached: DevTools → Application → Service Workers → Unregister |
| Space sleeps after a few hours | Free tier limitation. Add `CLOUDFLARE_WORKERS_TOKEN` to provision a keep-alive cron worker |
| Telegram bot doesn't respond | HF Spaces blocks `api.telegram.org` egress. Add `CLOUDFLARE_WORKERS_TOKEN` to auto-provision an outbound proxy |
| Two Spaces overwriting each other's backup | Set different `BACKUP_DATASET_NAME` on each |

## Want a native Android app?

I have a companion Android wrapper at **[F4bC0d3/hermes-mobile](https://github.com/F4bC0d3/hermes-mobile)** — same auth flow, sessions drawer, ChatGPT/Claude-style top bar, all hermes-webui features inside. Just point it at your Space URL.

## Credits

- **[Nous Research](https://nousresearch.com)** for **[Hermes Agent](https://github.com/NousResearch/hermes-agent)** — the agent runtime, the persistent memory system, the multi-provider LLM routing, the cron and skills systems. None of this exists without their work.
- **[@nesquena](https://github.com/nesquena)** for **[Hermes WebUI](https://github.com/nesquena/hermes-webui)** — the chat interface you actually see and use. Three-panel layout, SSE streaming, slash commands, profile management, theme system, mobile responsive design — all theirs.
- **[@somratpro](https://github.com/somratpro)** for **[HuggingMes](https://github.com/somratpro/HuggingMes)** — the HF Space packaging, the HF Dataset backup engine (`hermes-sync.py`), the Cloudflare proxy and keepalive setup, the Telegram integration, and the gateway auth wrapper. This repo is largely a fork of HuggingMes with WebUI added as the primary surface.

This repo's only contribution is the integration layer: a Node.js router that fronts both UIs on a single HF Space port, unified auth where one `GATEWAY_TOKEN` gates everything, and minor tweaks to `start.sh` to launch hermes-webui alongside the existing HuggingMes processes. If you find this useful, star the upstream projects, not this one.

## License

MIT — same as both upstream projects.
