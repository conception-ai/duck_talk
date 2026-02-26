# Stream Tool Calls from Claude Code

Status: verified, ready to implement
Created: 2026-02-22
Priority: Medium
Why: It's ok if we are not looking at the screen.
Test artifact: `/tmp/stream_test.txt`

## The problem

When Claude Code uses a tool (Read, Glob, Bash, etc.), the user sees
nothing until the entire tool call is complete. The UI goes blank for
seconds — sometimes 10+ seconds for big reads — with no indication of
what Claude is doing.

Tool calls ARE streamed by the Anthropic API. The data exists in the
wire. We just drop it.

## Where the data gets lost

The pipeline has four layers. Tool streaming events die at layer 1.

```
Layer 1           Layer 2          Layer 3          Layer 4
claude_client.py → server.py SSE → converse.ts  →  gemini.ts / UI
    ▲
    │
    drops tool events here
```

### What the SDK gives us

The Claude Agent SDK yields `StreamEvent` objects whose `.event` dict
contains raw Anthropic API server-sent events. A tool call produces
this sequence:

```
content_block_start   ← tool name + id available immediately
  │
  ├─ input_json_delta ← partial JSON: {"patter
  ├─ input_json_delta ← partial JSON: n": "**/
  ├─ input_json_delta ← partial JSON: models
  ├─ input_json_delta ← partial JSON: .py"}
  │
content_block_stop    ← block complete
```

Then later, the SDK also yields a complete `AssistantMessage` with
the same tool block fully assembled. Two sources for the same data.

### What we extract today

```python
# claude_client.py — the only StreamEvent handling
if isinstance(msg, StreamEvent):
    delta = msg.event.get("delta", {})
    if text := delta.get("text"):       # ← only text deltas
        yield TextDelta(text=text)
                                        # tool events? ignored.

elif isinstance(msg, AssistantMessage): # ← tool blocks arrive here
    for block in msg.content:           #    as complete objects
        if isinstance(block, ToolUseBlock):
            yield ContentBlockChunk(...)  # only path for tools
```

Text streams in real-time. Tools arrive as a batch at the end.

## Empirically verified (2026-02-22)

Ran a test with `CLAUDECODE= python3 -c "..."` using the Agent SDK's
`query()` function. Asked Claude to find and read `models.py`.

**Results:**

| Event type | Count |
|---|---|
| `content_block_start` | 4 (2 thinking + 2 tool_use) |
| `content_block_delta` | 99 (thinking + input_json) |
| `content_block_stop` | 4 |
| `message_start` | 2 |
| `message_delta` / `message_stop` | 2 each |

Tool call streaming events exist, are plentiful, and contain all the
data needed to show tool names and arguments incrementally.

### Critical field names

The `StreamEvent.event` dict structure for tool calls:

```python
# content_block_start
event = {
    "type": "content_block_start",
    "index": 1,
    "content_block": {
        "type": "tool_use",
        "id": "toolu_01...",
        "name": "Glob",            # ← tool name, available immediately
        "input": {},
    },
}

# content_block_delta (for tool input)
event = {
    "type": "content_block_delta",
    "index": 1,
    "delta": {
        "type": "input_json_delta",
        "partial_json": "{\"patter",  # ← NOTE: field is "partial_json"
    },                                #    NOT "input_json"
}

# content_block_stop
event = {
    "type": "content_block_stop",
    "index": 1,
}
```

**Gotcha:** the delta type is `input_json_delta` but the field
containing the actual JSON fragment is `partial_json`. Easy to confuse.

## Root cause

Not a bug — an intentional simplification from early development. The
`claude_client.py` was written to stream text and emit tools as
complete blocks. This was fine when tools were fast. Now that Claude
uses many tools per turn (read 5 files, glob, grep), the gap is
noticeable.

## The two-source deduplication problem

This is the key design challenge. After streaming, the SDK ALSO emits
the tool block via `AssistantMessage`. If we extract from both, the
frontend sees each tool twice.

```
StreamEvent (content_block_start)  →  ToolStartChunk { id, name }
StreamEvent (content_block_stop)   →  ContentBlockChunk { id, name, input }
AssistantMessage (ToolUseBlock)    →  ContentBlockChunk { id, name, input }  ← DUPLICATE
```

### Solution: track emitted IDs

```
emitted_tool_ids = set()

content_block_start  →  add id to set, yield ToolStartChunk
content_block_stop   →  yield ContentBlockChunk
AssistantMessage     →  skip if id in emitted_tool_ids
```

**Graceful fallback:** if the SDK stops emitting streaming events
(version change, API change), the set stays empty and the
`AssistantMessage` path works exactly as it does today. Zero breakage.

## Where partial JSON is assembled

Two options for where to combine `partial_json` fragments into
complete tool input:

```
Option A: Backend accumulates             Option B: Frontend accumulates
┌──────────────┐                          ┌──────────────┐
│ claude_client│                          │ claude_client│
│   buf += pj  │ ← accumulate            │ yield pj     │ ← forward raw
│   json.loads │ ← parse at stop         │              │
│   yield full │ ← ContentBlockChunk     │              │
└──────────────┘                          └──────────────┘
                                          ┌──────────────┐
                                          │ frontend     │
                                          │   buf += pj  │ ← accumulate
                                          │   json.loads │ ← parse
                                          └──────────────┘
```

**Option A (recommended):** Backend handles the messy work. Frontend
only sees two clean events: "tool started" and "tool complete with
parsed input". Simpler SSE protocol, simpler frontend, one place for
error handling if JSON is malformed.

**Option B** would give the frontend live-updating args (e.g. watch a
file path appear character by character) but adds complexity across
the SSE boundary for marginal UX value. Not worth it for v1.

## Proposed data flow

### Current flow (tools invisible until done)

```
Claude API  ──stream──►  claude_client.py  ──SSE──►  converse.ts  ──►  UI
                              │                          │
                         [text only]              [text chunks]     [text appears]
                              │                          │
                         [AssistantMsg]            [tool block]     [tool appears
                          arrives last              arrives last     all at once]
```

### New flow (tools visible as they start)

```
Claude API  ──stream──►  claude_client.py  ──SSE──►  converse.ts  ──►  UI
                              │                          │
                         content_block_start      tool_start event   [pill appears:
                         → ToolStartChunk         → onToolStart       "Reading..."]
                              │                          │
                         [text deltas]             [text chunks]     [text streams]
                              │                          │
                         content_block_stop        block event       [pill updates
                         → ContentBlockChunk       → onBlock          to complete]
                              │                          │
                         AssistantMessage          (skipped —        [no duplicate]
                         → (deduped, skipped)       already seen)
```

## The four layers of change

### Layer 1: Python backend (`claude_client.py`)

**New chunk type:** `ToolStartChunk(id, name)` — emitted the instant
a tool name is known. Lightweight signal, no input data yet.

**State tracking:** `active_tools` dict (keyed by block index) holds
the id, name, and accumulated JSON buffer for each in-progress tool.
`emitted_tool_ids` set tracks what's been streamed for dedup.

**Three new event handlers** in the `StreamEvent` branch:
- `content_block_start` with `type == "tool_use"` → yield `ToolStartChunk`
- `content_block_delta` with `type == "input_json_delta"` → append `partial_json` to buffer
- `content_block_stop` → parse buffer, yield `ContentBlockChunk`

**Dedup:** `AssistantMessage` handler skips `ToolUseBlock` if `block.id in emitted_tool_ids`.

### Layer 2: SSE bridge (`server.py`)

One new branch: `ToolStartChunk` → `yield _sse({"tool_start": {"id": ..., "name": ...}})`.

### Layer 3: Frontend SSE consumer (`converse.ts`)

New callback in stream options: `onToolStart?(id, name)`.
Parse `data.tool_start` from the SSE event and invoke it.

### Layer 4: UI (`data.svelte.ts`, `gemini.ts`, `+page.svelte`)

Track active tool uses in reactive state. Show pulsing pills (or
similar affordance) while tools are in-flight. Clear when the tool
result or converse done arrives.

## What this does NOT change

- **Text streaming** — unchanged, same `TextDelta` path
- **Tool results** — `UserMessage` / `ToolResultBlock` path unchanged
- **Session management** — `ResultMessage` path unchanged
- **Gemini relay** — tool names only flow to the UI, not to Gemini
- **Approval flow** — no interaction with review/correct modes
- **Data model** — `messages[]` and `voiceLog[]` split unchanged

## Key files

| File | Role in the pipeline |
|------|---------------------|
| `claude_client.py` | SDK consumer — where streaming events are extracted or dropped |
| `api/server.py` | SSE bridge — forwards chunks as `data: {...}\n\n` events |
| `vibecoded_apps/.../converse.ts` | Frontend SSE consumer — parses events, calls callbacks |
| `vibecoded_apps/.../stores/data.svelte.ts` | Reactive state — tracks pending tools for the UI |
| `vibecoded_apps/.../gemini.ts` | Gemini handler — wires `onToolStart` in the `executeConverse` call |
| `vibecoded_apps/.../+page.svelte` | UI — renders active tool indicators |

## Verification

1. **Unit test (Python):** `CLAUDECODE= python3 -c "..."` — verify
   `ToolStartChunk` yields before `ContentBlockChunk`, no duplicate
   `ContentBlockChunk` from `AssistantMessage`
2. **SSE test:** `curl -N POST /api/converse` — verify `tool_start`
   event appears in the stream before the `block` event
3. **E2E:** live session or replay — verify tool pills appear in UI
   while Claude is working, disappear when done

## Open questions

1. **Streaming tool results** — tool results (what the tool returns
   back to Claude) also stream via `StreamEvent` as `ToolResultBlock`
   content deltas. Worth surfacing? Separate feature.

2. **Multiple concurrent tools** — Claude sometimes calls tools in
   parallel (`content_block_start` for tool A, then tool B, then
   deltas interleaved). The index-keyed `active_tools` dict handles
   this naturally, but the UI needs to show multiple pills.

3. **Thinking blocks** — also stream via `content_block_start` with
   `type == "thinking"`. Currently dropped. Same pattern could surface
   a "thinking..." indicator. Orthogonal but same mechanism.
