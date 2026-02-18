# Learning Mode: Speech Correction Feedback Loop

## Files to read

Batch read all of these before starting:

- @vibecoded_apps/claude_talks/src/routes/live/types.ts — port interfaces, domain types (`ToolCall`, `PendingTool`, `Turn`, `DataStoreMethods`)
- @vibecoded_apps/claude_talks/src/routes/live/stores/data.svelte.ts — reactive state + session lifecycle
- @vibecoded_apps/claude_talks/src/routes/live/stores/ui.svelte.ts — persisted UI preferences (localStorage pattern to reuse)
- @vibecoded_apps/claude_talks/src/routes/live/gemini.ts — Gemini Live connection, tool call handling, `SYSTEM_PROMPT` const
- @vibecoded_apps/claude_talks/src/routes/live/+page.svelte — DI wiring + render (pending tool display at lines 110-123)
- @vibecoded_apps/claude_talks/src/routes/live/recorder.ts — `RecordedChunk` type (reuse for audio buffer)
- @vibecoded_apps/claude_talks/src/routes/live/converse.ts — SSE stream consumer
- @vibecoded_apps/CLAUDE.md — conventions (two stores, zero $effect, DI at the edge)

## Problem

Two distinct speech errors compound:

1. **Transcription**: Gemini mishears audio (accent). User says "What are the current conversations" → Gemini transcribes "What does the current conversations"
2. **Interpretation**: Gemini misinterprets transcription into tool args. "current conversations" → `{ instruction: "What does the current_conversations directory do?" }`

Currently, errors execute immediately with no user recourse. The user sees the wrong result only after Claude has already responded to the wrong question.

## Solution: Learning Mode

A `learningMode` toggle (persisted in ui store, off by default). When on, `converse` tool calls are **held for approval** instead of executing immediately. Other tools (`list_sessions`, etc.) execute normally.

### Flow

1. User speaks → mic chunks buffered + forwarded to Gemini (as today)
2. Gemini decides to call `converse` → tool call is **held**, not executed
3. Existing pending tool UI shows the tool args with inline `[✓] [✗]` buttons
4. User approves → executes as-is. User edits arg text then approves → saves correction + executes corrected version. User rejects → tool call dropped.
5. Corrections are injected into Gemini's `systemInstruction` on next session connect

Gemini still speaks its acknowledgment ("Asking Claude") — that's the audio stream, independent of execution. The actual Claude API call waits for approval.

```
│  YOU                                     │
│  What does the current conversations     │
│                                          │
│  GEMINI                                  │
│  Asking Claude.                          │
│  ┌─ converse ──────────────────────┐     │
│  │ What does the current_          │     │
│  │ conversations directory do?     │     │
│  │                        [✓] [✗]  │     │
│  └─────────────────────────────────┘     │
```

If user clicks arg text to edit before approving:

```
│  ┌─ converse ──────────────────────┐     │
│  │ ┌────────────────────────────┐  │     │
│  │ │ What are the current       │  │     │
│  │ │ conversations?         ░░░ │  │     │
│  │ └────────────────────────────┘  │     │
│  │                        [✓] [✗]  │     │
│  └─────────────────────────────────┘     │
```

No modal, no card. Just two buttons on the existing pending tool display.

## Data model

### `types.ts` — two correction types:

```ts
interface STTCorrection {
  type: 'stt';
  id: string;
  createdAt: string;
  audio: string;        // base64 PCM ground truth
  heard: string;        // Gemini's transcription (wrong)
  meant: string;        // correct transcription
}

interface ReasoningCorrection {
  type: 'reasoning';
  id: string;
  createdAt: string;
  input: string;        // what Gemini heard (may be correct)
  proposed: string;     // tool args Gemini proposed
  corrected: string;    // what it should have sent
}

type Correction = STTCorrection | ReasoningCorrection;
```

Different phenomena, different data shapes. User can create one or both from the same utterance:
- Edit transcription text → STT correction
- Edit tool call args → reasoning correction

### `types.ts` — add `PendingApproval` (transient, not persisted):

```ts
interface PendingApproval {
  toolCall: ToolCall;           // { name, args } from Gemini
  transcription: string;       // user's speech as transcribed
  audioChunks: RecordedChunk[]; // buffered audio for this utterance
}
```

Data only. The data store holds an internal `execute` callback alongside it (set by `gemini.ts`), and exposes `approve(instruction)` / `reject()` methods that trigger/cancel the Claude API call.

## Audio buffer

Lives inside `data.svelte.ts` as internal state (not exposed through `DataStoreMethods` port):

```
let audioBuffer: RecordedChunk[] = [];  // import RecordedChunk from recorder.ts
```

- **Mic callback** (line ~150): push to buffer AND forward to Gemini
- **`commitTurn()`**: reset buffer (turn boundary)
- **`startTool()`** in learning mode: snapshot buffer into `PendingApproval.audioChunks`

Audio segment captured = "end of last Gemini turn → tool call" = user's utterance. Uses existing `RecordedChunk` type from `recorder.ts`.

## Corrections store

**New file: `stores/corrections.svelte.ts`** — same localStorage pattern as `ui.svelte.ts`:

- Key: `'claude-talks:corrections'`
- `addSTT(audio, heard, meant)` / `addReasoning(input, proposed, corrected)` / `remove(id)` / `corrections` getter
- Separate from ui store: corrections are domain data (personal speech dictionary), not screen preferences

## System prompt injection

**`gemini.ts`** — `SYSTEM_PROMPT` const becomes `buildSystemPrompt(corrections: Correction[])`:

- `ConnectDeps` gains `corrections: Correction[]`
- Appends correction blocks to the prompt when corrections exist:

```
<STT_CORRECTIONS>
Your transcription often gets these wrong with this user:
- You transcribed: "does the current" → They said: "are the current"
</STT_CORRECTIONS>

<REASONING_CORRECTIONS>
When constructing tool call arguments:
- "current conversations" means the chat sessions, NOT a filesystem directory
</REASONING_CORRECTIONS>
```

Injected via `systemInstruction` in the config at connect time (Gemini docs confirm: set per-session).

## Files to modify

| File | Change |
|------|--------|
| `types.ts` | Add `STTCorrection`, `ReasoningCorrection`, `Correction` union, `PendingApproval`. Add `holdForApproval` to `DataStoreMethods`. |
| `stores/corrections.svelte.ts` | **New** — localStorage-backed corrections store |
| `stores/ui.svelte.ts` | Add `learningMode` boolean (persisted, default false) |
| `stores/data.svelte.ts` | Add audio buffer, `pendingApproval` state, approval/reject methods. Accept `corrections` + `learningMode` deps. |
| `gemini.ts` | `buildSystemPrompt(corrections)`, add `corrections` + `learningMode` to `ConnectDeps`. When `learningMode && fc.name === 'converse'`: call `data.holdForApproval(...)` with execute callback instead of calling `converseApi.stream()` directly. |
| `+page.svelte` | Wire corrections store + learningMode toggle. Render `[✓] [✗]` on pending tool when in learning mode. Editable arg text. |

All paths under `vibecoded_apps/claude_talks/src/routes/live/`.

## Verification

1. Start servers: `uvicorn api.server:app --port 8000` + `cd vibecoded_apps/claude_talks && npx vite --port 5173`
2. Navigate to `http://localhost:5173/#/live`
3. Toggle learning mode ON in header
4. Replay `converse_closure_question` recording
5. Verify: pending tool shows with `[✓] [✗]` buttons, Claude is NOT called yet
6. Edit the arg text, click ✓ → verify Claude is called with corrected instruction
7. Check `localStorage('claude-talks:corrections')` contains the correction
8. Stop session, start a new one → verify system prompt in console includes the correction
