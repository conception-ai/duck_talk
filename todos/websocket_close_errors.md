# WebSocket CLOSING/CLOSED Errors on Session Stop

Status: edits applied, not tested, not committed
Created: 2026-02-20
Plan file: `.claude/plans/abundant-petting-puddle.md`

## The problem

~8700 "WebSocket is already in CLOSING or CLOSED state" errors flood
the console when the user stops a Gemini Live session while a Claude
converse stream is in-flight.

## Root cause: orphaned SSE stream + stale closure reference

Two independent things hold a reference to the Gemini WebSocket session:

```
data.svelte.ts                          gemini.ts (connectGemini closure)
┌──────────────────┐                    ┌──────────────────┐
│ backend: LiveBackend │ ──returned──► │ sessionRef: Session │
│ (set to null in stop) │              │ (never nulled)       │
└──────────────────┘                    └──────────────────┘
```

`stop()` clears `backend` but not `sessionRef`. And it doesn't abort
the SSE stream. So:

```
stop() runs
  ├── backend.close()        → WebSocket enters CLOSING
  ├── backend = null         → prevents sends through the data store handle
  │
  │   BUT:
  ├── sessionRef still alive → closure-captured ref to the closed session
  └── SSE stream still running → converse.ts reader loop keeps going
                                  │
                                  ├── onChunk fires
                                  ├── sendToGemini(text)
                                  ├── sessionRef.sendClientContent(...)
                                  └── ERROR: WebSocket is CLOSING/CLOSED
                                      (repeats for every remaining SSE chunk)
```

Compare with `back()` which correctly calls `api.abort()` before
clearing state. `stop()` is missing this.

## The two-reference problem (key insight)

The Gemini session is accessed through two paths:

1. **`backend` (data.svelte.ts)** — the `LiveBackend` handle returned by
   `connectGemini()`. Used by the data store for mic audio
   (`backend.sendRealtimeInput`). Nulled in `stop()`.

2. **`sessionRef` (gemini.ts closure)** — the raw `Session` captured
   inside `connectGemini()`. Used by `handleMessage` for tool responses
   and nudges, and by `sendToGemini` for relaying Claude chunks. Uses
   `sessionRef?.` optional chaining — but since sessionRef is never
   nulled, the guard doesn't help.

Path 1 is severed by `stop()`. Path 2 is not. The SSE callbacks use
path 2.

## Why thousands of errors

The `/api/converse` SSE stream delivers Claude's response as many small
text chunks. Each chunk triggers `onChunk` → `sendToGemini` →
`sessionRef.sendClientContent(...)`. A typical response has hundreds of
chunks, each producing an error. The errors stack fast because the
reader loop processes buffered chunks synchronously.

## The fix (two independent layers)

### Layer 1: Kill the source (primary)

Add `api.abort()` to `stop()`. This aborts the SSE fetch via
`AbortController`, causing the reader loop to throw `AbortError` and
stop. No more chunks, no more sends.

`back()` already does this correctly. `stop()` was missing it.

### Layer 2: Guard the target (defense-in-depth)

Null `sessionRef` in the `close()` method of the returned `LiveBackend`.
This makes all existing `sessionRef?.` optional chains effective — any
in-flight chunk that slips past the abort (already dispatched before
the signal propagates) silently no-ops.

Also add a `closed` boolean flag to the `LiveBackend` methods so calls
through the `backend` handle are guarded too (belt and suspenders for
the mic callback path, even though `stop()` also nulls `backend` and
stops the mic).

### Why both layers

`api.abort()` is the primary fix — it stops the source. But abort is
asynchronous: `controller.abort()` is synchronous, but the
`reader.read()` rejection fires on the next microtask. A chunk already
in the event loop can still reach `sendToGemini` before the error
propagates. Nulling `sessionRef` catches this edge.

Neither fix alone is sufficient. Together they're robust.

## Data flow: normal stop vs. mid-stream stop

### Normal stop (no converse in-flight)

```
stop()
  ├── commitTurn()       → flush pending state
  ├── api.abort()        → no-op (no active stream)
  ├── mic.stop()         → stop mic
  ├── backend.close()    → close WebSocket cleanly
  ├── backend = null
  └── status = 'idle'
```

### Mid-stream stop (converse SSE active) — BEFORE fix

```
stop()
  ├── commitTurn()
  ├── mic.stop()
  ├── backend.close()    → WebSocket CLOSING
  ├── backend = null
  └── status = 'idle'

  ... meanwhile SSE chunks keep arriving ...

  onChunk → sendToGemini → sessionRef.sendClientContent → ERROR ×N
```

### Mid-stream stop — AFTER fix

```
stop()
  ├── commitTurn()
  ├── api.abort()        → AbortController fires, SSE reader will throw
  ├── mic.stop()
  ├── backend.close()    → sets closed=true, sessionRef=null, WS closes
  ├── backend = null
  └── status = 'idle'

  ... microtask: reader.read() rejects with AbortError ...

  catch block → onError("Claude Code request failed.")
             → finishTool()    (no-op: pendingTool already null from commitTurn)
             → pushError(msg)  (cosmetic: adds error to voiceLog)

  Any in-flight chunk that already passed the abort:
  → sendToGemini → sessionRef?.sendClientContent → sessionRef is null → no-op
```

## Known cosmetic side-effect

When `api.abort()` fires, the converse.ts catch block calls
`onError('Claude Code request failed.')` which pushes to `voiceLog`.
The user might briefly see this error text. It's harmless — the session
is already stopped. Could be cleaned up later by checking for
`AbortError` in the catch block, but it's not blocking.

## What's already done

- Both edits applied (not committed):
  - `data.svelte.ts:stop()` — added `api.abort()` after `commitTurn()`
  - `gemini.ts:connectGemini()` return — added `closed` flag + `sessionRef = null` in `close()`

## What remains

- Manual test: start live → speak → trigger converse → stop mid-stream → check console
- Commit if clean

## Key files

| File | Role |
|------|------|
| `vibecoded_apps/claude_talks/src/routes/live/stores/data.svelte.ts` | `stop()`, `back()`, `start()` — session lifecycle |
| `vibecoded_apps/claude_talks/src/routes/live/gemini.ts` | `connectGemini()` — WebSocket session, `sessionRef`, `sendToGemini` |
| `vibecoded_apps/claude_talks/src/routes/live/converse.ts` | SSE stream consumer, `abort()` via AbortController |

## Verification

1. `cd vibecoded_apps/claude_talks && npm run dev` (port 5000)
2. Open `http://localhost:5000/#/live`, click mic orb
3. Speak a request that triggers converse (e.g. "list files OVER")
4. While Claude is streaming back, click the mic orb to stop
5. Console should have zero "WebSocket is already in CLOSING or CLOSED state" errors
