# Architecture

Reduck is a voice interface for coding agents.

```
User ←→ Voice Relay ←→ Agent ←→ Codebase
             ↕              ↕
           TTS         Session Store
             ↕
         Audio I/O
```

Five roles, one key boundary: the **SSE protocol** between client and server. Everything client-side of it is constant across deployments. Everything server-side varies.

```
              SSE boundary
                  │
  Client          │    Server
  ───────         │    ──────
  Voice Relay     │    Agent backend
  TTS             │    Session store
  Audio I/O       │    Auth (managed only)
  UI              │
```

## Roles

### Agent — `AgentBackend`

Receives an instruction, streams back text deltas + content blocks, emits a result.

```
Instruction → AsyncGenerator<TextDelta | ContentBlock | Result>
```

Current: Claude Code via `@anthropic-ai/claude-agent-sdk` `query()`. Stateless — each call spawns a subprocess, session continuity via `resume` option.

The client never touches the agent SDK. It consumes SSE events through `ConverseApi`. Any agent that streams `{text}`, `{block}`, `{done}` works.

### Session Store — `SessionStore`

Persists conversation history. Operations: list sessions, load a conversation path, fork at a node.

Current: Claude Code's JSONL files on disk. Tree structure via `uuid`/`parentUuid` links. Read-only from Reduck's perspective — the agent owns writes.

**No interface yet.** The `Conversation` class and entry types (`UserEntry`, `AssistantEntry`, etc.) are hardwired to Claude Code's format. The tree-walking logic is generic; the parsing is not.

### Voice Relay — needs `VoiceRelayFactory`

Bidirectional audio gateway: VAD + STT + tool dispatch. It's a *relay*, not a participant — it decides WHEN to call the agent, not WHAT to say.

Current: Gemini Live API via WebSocket. Declares `converse` and `stop` as BLOCKING tools. When the user speaks, Gemini decides whether to dispatch to the agent or stop.

**Partially injectable.** `LiveBackend` interface exists for the output side. Creation, configuration, and the Gemini SDK import are hardcoded in `gemini.ts`. The orchestration logic (tool call → converse flow, approval gating, abort semantics) is interleaved with Gemini-specific message shapes.

### TTS — `StreamingTTS`

Streaming text-to-speech. Receives chunks as they arrive, sentence-buffers, speaks progressively.

```
send(text) → buffer and speak
finish()   → flush, drain remaining audio
interrupt() → stop immediately
close()    → tear down
```

Current: A second Gemini Live session with a "read aloud exactly" prompt. **Already injectable** — the `StreamingTTS` interface is clean.

### Audio I/O — `AudioPort`

Mic capture (PCM 16kHz mono) and speaker playback (PCM 24kHz gapless). Current: Browser AudioWorklet + AudioContext. **Already injectable** — interface exists.

## Injection Status

| Role | Interface | Exists? | Current impl | Swappable? |
|------|-----------|---------|-------------|------------|
| Agent | `AgentBackend` | NO | `claude-client.ts` (SDK subprocess) | Easy — extract interface |
| Session Store | `SessionStore` | NO | `models.ts` (JSONL files) | Medium — decouple parsing |
| Voice Relay | `VoiceRelayFactory` | NO | `gemini.ts` (Gemini Live) | Hard — orchestration coupled |
| TTS | `StreamingTTS` | YES | `tts-session.ts` (Gemini Live) | Ready |
| Audio I/O | `AudioPort` | YES | `audio.ts` (browser APIs) | Ready |

## Data Flow

### Happy path

```
1. Mic → PCM chunks → Voice Relay (Gemini WS)
2. Gemini VAD detects end-of-speech
3. Gemini calls converse tool with transcribed instruction
4. Client POST /api/converse → Server (SSE stream opens)
5. Server → Agent subprocess → streams text + blocks
6. Server relays as SSE → Client
7. Client feeds text to TTS (sentence-buffered)
8. TTS → audio → Speaker
9. Done event: session_id, cost, duration
```

### Interrupt

```
1. User says "stop" during active converse
2. Keyword listener detects it
3. Client aborts SSE fetch + interrupts TTS
4. Agent subprocess terminates
```

### Review mode

```
1–3. Same as happy path
4. Client holds for approval instead of executing
5. Instruction read back via TTS
6. User says "yes" (voice) or clicks approve (UI)
7. Approve → execute; Reject → unfreeze relay, no agent call
```

## SSE Protocol

The stable contract between server and any client. All events: `data: <json>\n\n`.

| Event | Shape | Meaning |
|-------|-------|---------|
| Text delta | `{text: string}` | Streaming assistant text |
| Content block | `{block: {type, ...}}` | Complete tool_use or tool_result |
| Done | `{done: true, session_id, cost_usd, duration_ms}` | Stream complete |
| Error | `{done: true, error: string}` | Stream failed |

## Deployment Modes

### Local (current)

Server runs on user's machine. Agent is a local subprocess. No auth.

```
Browser ──SSE──→ localhost:8000 ──subprocess──→ Claude Code CLI
                      │
                 ~/.claude/projects/*.jsonl
```

Requires: Claude Code CLI, API keys in .env, Node.js.

### Managed

Server is hosted. Agent runs remotely. Multi-tenant with auth.

```
Browser ──SSE──→ api.example.com ──API──→ Remote Agent
                      │                       │
                 Auth + routing          Remote storage
```

**What changes:**

| Component | Local → Managed |
|-----------|----------------|
| `claude-client.ts` | subprocess → remote API call |
| `models.ts` | `readFileSync` → API call |
| `routes.ts` | no auth → auth middleware, per-user routing |

**What stays identical:** all client code (`gemini.ts`, `tts-session.ts`, `audio.ts`, `converse.ts`), SSE protocol, port interfaces.

### Interfaces to extract

```typescript
// 1. Agent backend — replaces direct SDK import
interface AgentBackend {
  converse(message: string, opts: ConverseOpts): AsyncGenerator<Chunk>;
}

// 2. Session store — replaces filesystem access
interface SessionStore {
  list(): Promise<SessionInfo[]>;
  loadPath(sessionId: string, leafUuid?: string): Promise<PathEntry[]>;
  loadMessages(sessionId: string): Promise<MessageResponse[]>;
  fork(sessionId: string, leafUuid: string): Promise<string>;
}
```

`routes.ts` already takes config via `createApp(cfg)`. Widen it to accept `AgentBackend` + `SessionStore`. The choice of implementation is a deployment decision in `cli.ts`.

### Target server structure

```
src/server/
  cli.ts              # Entry point (both modes)
  routes.ts           # HTTP routes (mode-agnostic)
  types.ts            # AgentBackend, SessionStore interfaces
  backends/
    local.ts          # Agent via claude-agent-sdk
    managed.ts        # Agent via remote API
  stores/
    jsonl.ts          # Sessions from local JSONL
    remote.ts         # Sessions from remote API
```

## File Map (current)

```
src/
  server/
    cli.ts                 # Entry point, .env, prereqs
    routes.ts              # HTTP endpoints (SSE streaming)
    claude-client.ts       # Agent SDK wrapper
  client/
    routes/live/
      gemini.ts            # Voice relay orchestration
      tts-session.ts       # TTS via Gemini Live
      converse.ts          # SSE consumer (ConverseApi)
      audio.ts             # Browser mic + speaker
      types.ts             # Port interfaces
      tools.ts             # Tool declarations for relay
      voice-approval.ts    # Keyword detection
      buffer.ts            # Sentence buffer for TTS
    lib/
      chat-types.ts        # Shared render types
  shared/
    types.ts               # Session entry types, content blocks
    models.ts              # Conversation tree, fork, preview
```
