# LLM Auto-Correction Timing Issue

Status: open
Created: 2026-02-19
Related: `roadmap/todos/correction_llm_accuracy.md`, `plans/002_stt_correction_research.md`

## The problem

In `correct` mode, the LLM correction call adds ~2 seconds of dead UI
after Gemini's tool call arrives. During those 2 seconds the user sees
a pending tool card with no buttons — no Accept, no Edit, no Reject.
It looks broken.

## Where it happens

The async gap lives in `gemini.ts:207-226`. The `.then()` callback is
where `holdForApproval` finally fires:

```
gemini.ts:207   if (mode === 'correct') {
gemini.ts:210     deps.correctInstruction(instruction).then(     ← HTTP call starts
                    ...                                            ~2s of nothing
gemini.ts:212       data.holdForApproval(...)                    ← approval buttons appear
                  )
```

The closure that actually calls the LLM is wired at the DI edge:

```
+page.svelte:28-32   correctInstruction: (instruction) => {
                       const key = ui.apiKey;
                       return correctInstruction(createLLM({ apiKey: key }), instruction, corrections.corrections);
                     }
```

Which calls:

```
correct.ts:4-11      correctInstruction(llm, instruction, corrections)
                       → llm(prompt)                                    ← Gemini Flash API round-trip
```

## Measured timeline (E2E, 2026-02-19)

Replay of `what_is_latest_commit.json` (522 chunks, ~4s audio).

```
T+0.0s     Replay starts, audio chunks fed to Gemini Live
T+10.1s    Gemini emits toolCall: converse({ instruction: "What is the latest commit?" })
           ├── startTool() called → UI shows pending tool card (dashed border, no buttons)
           ├── correctInstruction() dispatched (async, same tick)
           │
           │   ┌─────────────────────────────────────────────────┐
           │   │ DEAD UI WINDOW (~2s)                            │
           │   │                                                 │
           │   │ User sees: tool card with instruction text      │
           │   │ User can do: nothing (no buttons yet)           │
           │   │                                                 │
           │   │ Meanwhile Gemini sends:                         │
           │   │   - outputTranscription: "Asking Claude"        │
           │   │   - modelTurn: audio PCM data                   │
           │   │   - generationComplete                          │
           │   │   - turnComplete + usageMetadata                │
           │   │                                                 │
           │   │ conversePhase stays 'suppressing' the whole     │
           │   │ time — audio and text are blocked. No leaks.    │
           │   └─────────────────────────────────────────────────┘
           │
T+12.2s    LLM responds → holdForApproval() → UI shows Accept/Edit/Reject
```

### Breakdown

| Interval | Duration | Source |
|----------|----------|--------|
| Audio feed → tool call | ~10.1s | Gemini Live processing |
| Tool call → LLM dispatch | 0ms | Synchronous (same tick) |
| LLM round-trip | ~2.1s | `gemini-3-flash-preview:generateContent` |
| Total speech-to-approval | ~12.2s | Sum of above |

The 2.1s is the Gemini Flash API server processing time (measured via
`server-timing` header). Network latency is negligible.

## Why it matters

- The 2s gap comes after an already long ~10s Gemini processing wait.
  Total 12s from speech to actionable UI.
- During the gap, the tool card is visible but has no affordances.
  The user might think the app hung.
- In `review` mode (no LLM call), `holdForApproval` fires synchronously
  on the same tick as the tool call — buttons appear instantly. The
  contrast makes `correct` mode feel noticeably worse.

## Current code flow (correct mode)

```
gemini.ts handleMessage()
  │
  ├── message.toolCall.functionCalls detected
  │     mode = deps.getMode()                          // 'correct'
  │     audioChunks = data.snapshotUtterance().audioChunks
  │     data.commitTurn()
  │
  ├── for each fc:
  │     data.startTool(fc.name, fc.args)               // UI: pending tool card appears
  │     instruction = fc.args.instruction
  │     conversePhase = 'suppressing'
  │     sessionRef.sendToolResponse(SILENT)
  │
  │     executeConverse = (approved) => { ... }        // closure, not called yet
  │
  │     // ASYNC GAP STARTS HERE
  │     deps.correctInstruction(instruction)
  │       .then((corrected) => {
  │           data.holdForApproval(                    // UI: buttons appear
  │             { rawInstruction, instruction: corrected, audioChunks },
  │             executeConverse,
  │             () => { conversePhase = 'idle' },
  │           );
  │       })
  │     // ASYNC GAP ENDS when promise resolves (~2s)
  │
  └── (Gemini messages keep arriving during the gap,
       handled by the same handleMessage function)
```

## Options

### Option 1: Show raw instruction immediately, swap when corrected

Show approval buttons right away with the raw instruction. When the LLM
resolves, update the displayed instruction in-place.

```
T+10.1s  Tool call → holdForApproval({ instruction: raw }) → buttons appear
T+12.2s  LLM resolves → update pendingApproval.instruction to corrected
```

**Pros:** Zero dead UI. User can start reading/acting immediately.
**Cons:** Text changes under the user mid-read. Could be confusing.
Need a visual indicator that correction is pending (spinner on the text?).

**Implementation sketch:**
- `gemini.ts`: in `correct` mode, call `holdForApproval` synchronously
  with the raw instruction, then fire the LLM call
- `data.svelte.ts`: add `updateApprovalInstruction(corrected, raw)` method
  that updates `pendingApproval.instruction` and sets `rawInstruction`
- `correct.ts`: unchanged
- `+page.svelte`: show a small spinner/indicator next to instruction text
  while `rawInstruction` is not yet set (meaning LLM hasn't resolved)

### Option 2: "Correcting..." spinner

Keep current behavior (buttons appear only after LLM resolves) but show
a spinner or status text during the wait.

```
T+10.1s  Tool call → UI shows "Correcting..." in the tool card
T+12.2s  LLM resolves → holdForApproval → replace spinner with buttons
```

**Pros:** Simple. No text-swapping confusion.
**Cons:** Still 2s of no actionable UI. User just waits.

**Implementation sketch:**
- `data.svelte.ts`: add a `correcting = $state(false)` flag, set it
  in the tool call handler before the LLM call, clear on resolve
- `+page.svelte`: when `correcting && pendingTool && !pendingApproval`,
  show "Correcting..." text
- `gemini.ts`: set `data.setCorrecting(true)` before the `.then()`,
  set `data.setCorrecting(false)` inside `.then()` before `holdForApproval`

### Option 3: Accept the delay

The 2s is after a 10s Gemini processing wait anyway. The user is already
waiting. An extra 2s may not matter in practice.

**Pros:** Zero code change.
**Cons:** The dead UI still looks broken. Review mode has instant buttons
which makes the contrast jarring.

### Option 4: Pre-warm / cache LLM client

Currently `createLLM({ apiKey })` is called inside the closure on every
correction request (`+page.svelte:29-31`). The `llm.ts` factory caches
the `GoogleGenAI` client by API key (`llm.ts:50-59`), so the client is
already reused. The 2s is server-side processing, not client setup.

This option doesn't help — the bottleneck is the API call, not client
creation.

## Recommendation

Option 1 (show raw, swap when ready) gives the best UX. The user gets
instant buttons and can start reading. A small inline spinner (or
dimmed text that sharpens when corrected) signals that the LLM is still
working. If the user clicks Accept before the LLM resolves, use the raw
instruction — better to send something immediately than block.

## Key files reference

| File | Lines | What |
|------|-------|------|
| `vibecoded_apps/claude_talks/src/routes/live/gemini.ts` | 207-226 | Mode branching + async `.then()` |
| `vibecoded_apps/claude_talks/src/routes/live/correct.ts` | 4-11 | `correctInstruction` — the LLM call |
| `vibecoded_apps/claude_talks/src/routes/live/stores/data.svelte.ts` | 157-176 | `holdForApproval`, `approve` |
| `vibecoded_apps/claude_talks/src/routes/live/+page.svelte` | 28-32 | DI closure wiring the LLM call |
| `vibecoded_apps/claude_talks/src/routes/live/+page.svelte` | 207-243 | Approval UI rendering |
| `vibecoded_apps/claude_talks/src/routes/live/types.ts` | 48-52 | `PendingApproval` interface |
| `vibecoded_apps/claude_talks/src/lib/llm.ts` | 105-139 | `createLLM` factory |

## Test assets

| Asset | Path |
|-------|------|
| Recording | `vibecoded_apps/claude_talks/public/recordings/what_is_latest_commit.json` |
| E2E test approach | Launch replay in `correct` mode, observe console timestamps between `"correct mode: running LLM correction"` and `"[LLM auto correct]"` |
