# cc-relay: Expose an HTTP server from a Claude Code Web sandbox

## Problem

Claude Code Web sandboxes have **no inbound connectivity**. You cannot open a
port or receive incoming requests. But they **can make outbound HTTPS** through
Anthropic's egress proxy. cc-relay exploits this asymmetry: the sandbox polls a
Cloudflare Worker for pending requests, forwards them to a local FastAPI server,
and posts responses back. From the outside it looks like a normal HTTP endpoint.

## Current deployment

| Component | URL / value |
|---|---|
| Worker | `https://cc-relay.daniel-90c.workers.dev` |
| Health check | `GET /ping` (no auth) |
| Public proxy | `GET/POST/… /proxy/{path}` (no auth) |
| Sandbox poll | `GET /proxy/_poll` (requires `x-token` header) |
| Sandbox respond | `POST /proxy/_respond` (requires `x-token` header) |
| Token | `cc-relay-0dc090e4fd95c0e422fb02c5784f06a5` (set as `SECRET_TOKEN` Wrangler secret) |
| Cloudflare account | `90c75663eac3646bd6c6b1f3502674c9` (daniel@conception.dev) |
| Workers subdomain | `daniel-90c.workers.dev` |

## Architecture

```
Phone / Browser
       │  GET /proxy/hello
       ▼
┌────────────────────────────┐
│  Cloudflare Worker         │
│  cc-relay.*.workers.dev    │
│                            │
│  1. Enqueues request in    │
│     Durable Object (DO)    │
│  2. Polls DO for sandbox   │
│     response (300ms loop)  │
│  3. Returns response       │
│     to caller              │
└─────────┬──────────────────┘
          │  Durable Object "Relay"
          │  (in-memory, strongly consistent)
          │  pendingRequests: []
          │  responses: {}
─ ─ ─ ─ ─│─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─
SANDBOX   │  outbound HTTPS only
          │  (via Anthropic egress proxy)
┌─────────▼──────────────────┐
│  bridge_loop()             │
│  polls GET /proxy/_poll    │
│  every ~1 second           │
│  POST /proxy/_respond      │
└─────────┬──────────────────┘
          │  localhost:8000
┌─────────▼──────────────────┐
│  FastAPI server             │
│  GET  /hello               │
│  POST /echo                │
│  (add your own endpoints)  │
└────────────────────────────┘
```

## Request lifecycle

```
Phone              Worker                DO (Relay)           Sandbox bridge       FastAPI
  │                   │                     │                      │                  │
  │ GET /proxy/hello  │                     │                      │                  │
  │──────────────────►│                     │                      │                  │
  │                   │  POST /_enqueue     │                      │                  │
  │                   │────────────────────►│ push to              │                  │
  │                   │                     │ pendingRequests      │                  │
  │                   │  GET /_await/{id}   │                      │                  │
  │                   │────────────────────►│ {found: false}       │                  │
  │                   │◄────────────────────│                      │                  │
  │                   │  (sleep 300ms)      │                      │                  │
  │                   │                     │         GET /_poll   │                  │
  │                   │                     │◄─────────────────────│                  │
  │                   │                     │ drain queue          │                  │
  │                   │                     │─────────────────────►│                  │
  │                   │                     │ {requests: [{…}]}    │                  │
  │                   │                     │                      │ GET /hello       │
  │                   │                     │                      │─────────────────►│
  │                   │                     │                      │ {"message":"…"}  │
  │                   │                     │                      │◄─────────────────│
  │                   │                     │   POST /_respond     │                  │
  │                   │                     │◄─────────────────────│                  │
  │                   │                     │ store in responses   │                  │
  │                   │  GET /_await/{id}   │                      │                  │
  │                   │────────────────────►│ {found: true, …}     │                  │
  │                   │◄────────────────────│                      │                  │
  │ {"message":"…"}   │                     │                      │                  │
  │◄──────────────────│                     │                      │                  │
  │ 200 OK            │                     │                      │                  │
```

## File map

```
cc-relay/
├── src/
│   └── index.js              ← Cloudflare Worker + Durable Object (deployed)
├── sandbox/
│   └── server.py             ← FastAPI + bridge (runs in Claude Code Web sandbox)
├── wrangler.jsonc             ← Wrangler config (DO bindings, KV namespace, migrations)
├── ARCHITECTURE.md            ← this file
├── package.json
└── .gitignore
```

## Reproduce from scratch

### 1. Deploy the Worker (one-time)

```bash
cd cc-relay
npm install -g wrangler
wrangler login                         # OAuth in browser
wrangler kv namespace create MAILBOX   # note the ID, update wrangler.jsonc
wrangler secret put SECRET_TOKEN       # paste your chosen token
wrangler deploy
```

### 2. Start the server in a Claude Code Web sandbox

In the sandbox's Claude Code session, paste server.py then run:

```bash
pip install fastapi uvicorn httpx
RELAY_TOKEN=<your-token> nohup python server.py > /tmp/server.log 2>&1 &
```

Verify locally inside the sandbox:
```bash
curl -s http://127.0.0.1:8000/hello
# → {"message":"Hello from Claude Code sandbox!"}
```

### 3. Test from the outside

```bash
curl https://cc-relay.daniel-90c.workers.dev/proxy/hello
# → {"message":"Hello from Claude Code sandbox!"}
```

## Key design decisions and lessons learned

### Why Durable Objects, not KV?

Our first implementation used KV as a message queue. It failed silently:
Cloudflare KV is **eventually consistent** with up to 60-second read-after-write
delays across edges. The sandbox would poll and always see an empty queue because
its reads hit a stale edge cache. KV is designed for read-heavy, write-rare data
— not real-time coordination.

Durable Objects (DO) hold state **in memory** on a single instance. All requests
to `idFromName("default")` go to the same instance. Reads and writes are
instant. Free plan requires `new_sqlite_classes` (not `new_classes`) in the
migration config.

### Why all DO handlers return immediately

DOs serialize all `fetch()` calls: one at a time, waiting for the previous
handler's returned promise to resolve before starting the next. If `_enqueue`
returned a long-lived promise (waiting for the sandbox to respond), it would
**deadlock** — `_poll` could never run to deliver the request.

Solution: `_enqueue` stores the request and returns instantly. The Worker (not
the DO) does the polling loop for the response via `/_await/{id}`. The DO stays
unblocked.

### Sandbox SSL / TLS inspection

All outbound traffic from the sandbox goes through Anthropic's egress proxy at
`21.0.0.147:15004`. This proxy performs **TLS inspection** using a custom CA
(`sandbox-egress-production TLS Inspection CA`).

`curl` works fine because it uses the system CA store which includes this CA.
But Python's `httpx` uses `certifi` by default, which does **not** include it.
Fix: create an `ssl.SSLContext` from the system store:

```python
import ssl
ctx = ssl.create_default_context()  # loads system CAs
httpx.AsyncClient(verify=ctx)       # uses system CAs, not certifi
```

### Sandbox network access levels

- **Full**: can reach any domain (including `workers.dev`). This is what we use.
- **Limited**: allowlisted domains only. `workers.dev` is NOT allowlisted.
  Workaround: host the relay behind an allowlisted domain, or use a Google Cloud
  Function (`*.googleapis.com` is allowlisted).
- **None**: only Anthropic API channel. Relay won't work.

### Keeping the server alive

`python server.py &` in the sandbox's Claude Code session dies when the
background task mechanism reclaims it. Use `nohup` + redirect:

```bash
nohup python server.py > /tmp/server.log 2>&1 &
```

The session must stay alive. If it terminates, the VM is reclaimed and the
server stops. There is no persistence across sessions.

## Timing

```
t=0.0s    Phone hits /proxy/hello
t=0.0s    Worker enqueues in DO, starts 25s poll loop (300ms interval)
t=0-1s    Sandbox bridge poll fires (every 1s)
t=~1s     Sandbox gets request, forwards to FastAPI
t=~1s     FastAPI responds
t=~1s     Sandbox POSTs response to DO
t=~1.3s   Worker's next /_await finds response, returns to phone
          Total round-trip: ~1-2s typical
```

## Current limitations

- **Single-tenant**: one shared token, one global queue. No per-user isolation.
- **No streaming**: full response is buffered before relay. SSE/WebSocket not supported.
- **Poll latency**: ~1s minimum added by the bridge polling interval.
- **Session ephemeral**: sandbox VM dies when the Claude Code Web session ends.
- **No request headers forwarded**: only method, path, and body are proxied.
- **25s timeout**: external requests that take >25s will get a 504.
- **KV namespace unused**: still in wrangler.jsonc from the first iteration. Can be removed.

## Next steps (if continuing)

- **Multi-tenant**: URL structure `/t/{token}/{path}` with per-token queues in the DO.
- **Streaming**: WebSocket upgrade through the relay for SSE/streaming responses.
- **Auto-start hook**: `SessionStart` hook in Claude Code Web environment config to
  auto-install deps and start server.py on every session.
- **Phone UI**: minimal HTML page to send requests and view responses from mobile.
