# Plan: Converse lifecycle — stateful client + interrupt support

## Problem

The Claude Code converse flow has no clean state management:
- **Backend** uses stateless `query()` (spawns a fresh subprocess per call, no interrupt)
- **Backend** emits `session_id` only in the final `done` SSE event (too late for frontend to use for interrupt)
- **Frontend** has no explicit `running` state; concurrent `stream()` calls corrupt state via stale async callbacks

## Solution

1. **Backend**: Replace stateless `query()` with `ClaudeSDKClient` (persistent subprocess, supports `interrupt()`)
2. **Backend**: Emit `session_id` as first SSE event
3. **Backend**: Add `POST /api/converse/interrupt` endpoint
4. **Frontend**: Make `converse.ts` self-managing — auto-abort previous stream, explicit `running` state

## Files to read before implementing

| File | Why |
|------|-----|
| `claude_client.py` | Current SDK wrapper — to be rewritten |
| `api/server.py` | FastAPI backend — converse endpoint to adapt |
| `vibecoded_apps/claude_talks/src/routes/live/converse.ts` | Frontend SSE consumer — to add safe abort + running state |
| `vibecoded_apps/claude_talks/src/routes/live/types.ts` | `ConverseApi` interface — to add `running` |

## Verified behavior (from testing)

`ClaudeSDKClient` interrupt flow — confirmed working:

```python
async with ClaudeSDKClient(options=options) as client:
    await client.query("long task")
    # collect a few messages...
    await client.interrupt()
    # MUST drain receive_response() — yields:
    #   UserMessage("[Request interrupted by user]")
    #   ResultMessage(subtype='error_during_execution', is_error=False)
    await client.query("new task")  # works, same session_id
```

Key facts:
- `interrupt()` is clean — `is_error=False`, same session continues
- Must drain `receive_response()` after interrupt before next `query()`
- Same `session_id` persists across interrupt + new query (no subprocess restart)
- `ClaudeSDKClient` is `async with` — keeps subprocess alive for the client lifetime

---

## Changes

### 1. `claude_client.py` — Rewrite: stateless `query()` → stateful `ClaudeSDKClient`

**Current**: Each `converse()` call spawns a fresh subprocess via standalone `query()`. No interrupt capability. Session continuity via `resume` option (re-reads JSONL on each call).

**New**: Hold a `ClaudeSDKClient` instance per active session. Support `interrupt()` + `converse()` on the same persistent subprocess.

```python
# BEFORE — stateless, one subprocess per call:
class Claude:
    async def converse(self, message, model, system_prompt, session_id=None, ...):
        options = ClaudeAgentOptions(model=model, cwd=self._cwd, ...)
        if session_id:
            options = replace(options, resume=session_id)
        async for msg in query(prompt=message, options=options):
            # yield chunks...

# AFTER — stateful, persistent subprocess:
class Claude:
    _client: ClaudeSDKClient | None = None
    _session_id: str | None = None

    async def converse(self, message, model, system_prompt, session_id=None, ...):
        # If session changed or no client, create new one
        if self._client is None or session_id != self._session_id:
            await self._close()
            options = ClaudeAgentOptions(model=model, cwd=self._cwd, ...)
            if session_id:
                options = replace(options, resume=session_id)
            self._client = ClaudeSDKClient(options=options)
            await self._client.__aenter__()

        await self._client.query(message)
        async for msg in self._client.receive_response():
            # yield chunks (same parsing as before)
            # capture session_id from ResultMessage

    async def interrupt(self):
        if self._client:
            await self._client.interrupt()
            # Drain cleanup messages
            async for msg in self._client.receive_response():
                if isinstance(msg, ResultMessage):
                    break

    async def close(self):
        if self._client:
            await self._client.__aexit__(None, None, None)
            self._client = None
```

**Design decisions to make during implementation:**
- Client lifetime: one `ClaudeSDKClient` per `Claude` instance, or per session?
  Recommendation: one per `Claude` instance, reconnect when `session_id` changes.
- `system_prompt` and `model` changes between calls: these are set in `ClaudeAgentOptions` at client creation. If they change, need a new client.
  Recommendation: compare against stored options, recreate client if they differ.
- Thread safety: FastAPI is async, only one converse runs at a time (single user prototype).
  Recommendation: no locking needed for now.

**Imports to add:**
```python
from claude_agent_sdk import ClaudeSDKClient, ResultMessage
```

**Imports to remove** (if no longer needed):
```python
# query is replaced by ClaudeSDKClient
# Keep: ClaudeAgentOptions, AssistantMessage, StreamEvent, ToolUseBlock, ToolResultBlock, UserMessage
```

### 2. `api/server.py` — Emit session_id early + interrupt endpoint

#### a) Emit session_id as first SSE event

The backend knows the session_id before streaming starts (either passed in or from `fork_session()`). Emit it immediately.

```python
# BEFORE (inside stream() generator):
    async def stream():
        n_chunks = 0
        async for chunk in claude.converse(...):
            ...

# AFTER:
    async def stream():
        if session_id:
            yield _sse({"session_id": session_id})
        n_chunks = 0
        async for chunk in claude.converse(...):
            ...
```

#### b) Add interrupt endpoint

```python
@app.post("/api/converse/interrupt")
async def interrupt_converse():
    await claude.interrupt()
    return {"status": "ok"}
```

### 3. `vibecoded_apps/claude_talks/src/routes/live/converse.ts` — Self-managing converse client

Three changes:

#### a) Add `running` state

```typescript
// BEFORE:
  let controller: AbortController | null = null;

// AFTER:
  let controller: AbortController | null = null;
  let running = false;
```

Expose in return object:
```typescript
    get running() { return running; },
    abort() { controller?.abort(); controller = null; running = false; },
```

#### b) Safe concurrent abort — the `mine` pattern

Each `stream()` call captures its own `AbortController`. When a newer stream aborts an older one, the old stream detects it was intentional and exits without firing `onError` (which would corrupt the newer stream's state in gemini.ts).

```typescript
// BEFORE:
    async stream(instruction, { onChunk, onBlock, onDone, onError }) {
      ...
      controller = new AbortController();
      try {
        const res = await fetch(endpoint, { ..., signal: controller.signal });
        ...
      } catch (e) {
        console.error(...);
        onError('Claude Code request failed.');
      } finally {
        controller = null;
      }
    },

// AFTER:
    async stream(instruction, { onChunk, onBlock, onDone, onError }) {
      controller?.abort();                    // Kill previous stream if running
      const mine = new AbortController();
      controller = mine;
      running = true;
      ...
      try {
        const res = await fetch(endpoint, { ..., signal: mine.signal });
        ...
      } catch (e) {
        if (mine.signal.aborted) return;      // Interrupted by newer stream — exit silently
        console.error(...);
        onError('Claude Code request failed.');
      } finally {
        if (controller === mine) {            // Only cleanup if still the active stream
          controller = null;
          running = false;
        }
      }
    },
```

**Why this matters:** Without `mine`, when stream A is aborted by stream B:
1. A's catch fires `onError` → gemini.ts sets `conversePhase = 'idle'` → B's phase is corrupted
2. A's finally sets `controller = null` → B's controller is wiped

#### c) Handle early session_id SSE event

```typescript
// BEFORE (inside SSE parsing loop):
            if (data.done) {
              if (data.session_id) sessionId = data.session_id;
              ...

// AFTER:
            if (data.session_id && !data.done) {
              sessionId = data.session_id;
              continue;   // Early announcement — no callback
            }
            if (data.done) {
              if (data.session_id) sessionId = data.session_id;
              ...
```

### 4. `vibecoded_apps/claude_talks/src/routes/live/types.ts` — Add `running`

```typescript
// BEFORE:
export interface ConverseApi {
  sessionId: string | null;
  sessionStart: number;
  leafUuid: string | null;
  stream(...): Promise<void>;
  abort(): void;
}

// AFTER — add one line:
export interface ConverseApi {
  sessionId: string | null;
  sessionStart: number;
  leafUuid: string | null;
  readonly running: boolean;    // <-- add
  stream(...): Promise<void>;
  abort(): void;
}
```

---

## Files NOT modified

- **`gemini.ts`**: No changes. It already sets `conversePhase = 'suppressing'` before `stream()`. The auto-abort inside `stream()` means gemini doesn't need to call `abort()` explicitly. Silent exit on interrupted streams means stale callbacks never fire.
- **`data.svelte.ts`**: No changes. `rewindTo()` calls `api.abort()` which still works. `pendingTool` remains the UI-level "running" signal.
- **`+page.svelte`**: No changes.

---

## Verification

### 1. Backend interrupt (Python)

```bash
# Terminal 1: start server
cd /Users/dhuynh95/claude_talks && uvicorn api.server:app --port 8000

# Terminal 2: start a long converse
curl -s -N -X POST http://localhost:8000/api/converse \
  -H 'Content-Type: application/json' \
  -d '{"instruction":"Count from 1 to 100 slowly, one per line","model":"sonnet","system_prompt":"You are helpful."}' &

# Wait 2 seconds, then interrupt
sleep 2
curl -s -X POST http://localhost:8000/api/converse/interrupt

# Verify: first stream stops, interrupt returns {"status": "ok"}
```

### 2. Early session_id emission

```bash
# Send a converse with an existing session_id
curl -s -N -X POST http://localhost:8000/api/converse \
  -H 'Content-Type: application/json' \
  -d '{"instruction":"say hi","session_id":"SOME_EXISTING_ID","model":"sonnet","system_prompt":"You are helpful."}'

# Verify: FIRST SSE event is data: {"session_id": "SOME_EXISTING_ID"}
# BEFORE any text chunks
```

### 3. Frontend safe concurrent abort

In browser at `http://localhost:5000/#/live`:
1. Start a Gemini session (click mic)
2. Trigger a converse via voice
3. While streaming, trigger another converse
4. Verify: first stream stops silently (no error toast), second stream renders normally
5. Check browser console: no `conversePhase` corruption, no stale `onError` logs

### 4. ClaudeSDKClient lifecycle

```bash
CLAUDECODE= python3 -c "
import asyncio
from claude_agent_sdk import ClaudeSDKClient, ClaudeAgentOptions, ResultMessage

async def test():
    opts = ClaudeAgentOptions(permission_mode='plan', cwd='/tmp')
    async with ClaudeSDKClient(options=opts) as client:
        # Query 1
        await client.query('Say ALPHA')
        sid = None
        async for msg in client.receive_response():
            if isinstance(msg, ResultMessage):
                sid = msg.session_id
                break
        print(f'Q1 session: {sid}')

        # Interrupt + Query 2
        await client.query('Count to 100')
        await asyncio.sleep(0.5)
        await client.interrupt()
        async for msg in client.receive_response():
            if isinstance(msg, ResultMessage): break
        print('Interrupted')

        # Query 3 — same session
        await client.query('Say GAMMA')
        async for msg in client.receive_response():
            if isinstance(msg, ResultMessage):
                assert msg.session_id == sid, f'Session changed: {msg.session_id} != {sid}'
                print(f'Q3 session matches: {msg.session_id}')
                break

asyncio.run(test())
"
```

Expected: same session_id across all 3 queries, interrupt is clean.
