# Mute Gemini — Claude-Only Voice

Status: ready to implement
Created: 2026-02-20

## The problem

Two agents (Gemini Live + Claude Code) share one voice. The user can't
tell who's speaking. Gemini editorializes, answers instead of routing,
and leaks audio despite a complex 3-phase suppression state machine.

### Observed failures

| # | Failure | Evidence |
|---|---------|----------|
| 1 | **Unreliable routing** — Gemini answers instead of calling `converse` | Nudge logic exists (`gemini.ts:286-291`) because this fails regularly |
| 2 | **Poor STT** — "commit" → "complete" | Entire correction subsystem built (3 modes, LLM auto-correct, persistent corrections store) |
| 3 | **Editorializes Claude's text** — paraphrases, skips technical details | System prompt says "relay faithfully" but Gemini summarizes and loses precision |
| 4 | **Won't stay silent** — generates audio/text during converse | `conversePhase` state machine (3 states, complex timing) exists solely for this |
| 5 | **Garbles tool-call args** — `instruction` is Gemini's interpretation, not transcription | Another lossy layer in the telephone chain |
| 6 | **Fragile timing** — "Asking Claude" audio arrives before `toolCall` message | Phase transitions depend on event ordering; race conditions where audio leaks |

### Root cause

All six failures stem from one design flaw: **Gemini has agency AND a
mouth.** The system tries to control Gemini's speech via prompting, but
prompts are suggestions, not constraints. The `conversePhase` state
machine is complexity born from fighting Gemini's desire to talk.

## The insight

Don't remove Gemini. **Muzzle it programmatically.**

Gemini keeps its brain (STT, VAD, tool calling) but loses its mouth.
Audio bytes are dropped in code, not suppressed by prompt. The only time
Gemini's audio reaches the speaker is when it's reading Claude's text
aloud — and we control exactly when that happens.

## Architecture: before and after

### Before (current)

```
User speaks → Gemini Live (STT + routing + TTS) → Claude Code
                  ↑                                    │
                  └──── [CLAUDE]: text fed back ────────┘

Gemini speaks:
  - Its own acks ("Asking Claude...")
  - Its own commentary (editorializing)
  - Claude's text (via sendClientContent relay)
  - All gated by 3-phase conversePhase state machine
```

### After (proposed)

```
User speaks → Gemini Live (STT + routing) → Claude Code
                                                  │
              Gemini TTS ◄── [CLAUDE]: text ──────┘
              (audio gate: open ONLY during TTS phase)

Gemini speaks:
  - Claude's text ONLY
  - Gated by binary state machine (2 states)
  - Everything else: /dev/null
```

## The state machine

Two states. Two transitions.

```
                        ┌──────────────┐
         ┌─────────────►│    MUTED     │◄──────────────┐
         │              │  (default)   │               │
         │              └──────┬───────┘               │
         │                     │                       │
   Claude stream done     first Claude chunk           │
   OR error               arrives via SSE              │
         │                     │                       │
         │                     ▼                       │
         │              ┌──────────────┐               │
         └──────────────│     TTS      │───────────────┘
                        │ (Claude's    │  user interrupts
                        │  mouth)      │  (sc.interrupted)
                        └──────────────┘
```

### State behavior

| Signal | MUTED (default) | TTS |
|--------|-----------------|-----|
| `modelTurn.parts` (Gemini audio) | **DROP** — never reaches speaker | **PLAY** — Gemini reading Claude's text aloud |
| `outputTranscription` (Gemini's speech text) | **DROP** — never reaches UI | **DROP** — it's `[CLAUDE]:` echo noise; real text is in `appendTool` |
| `inputTranscription` (user's speech) | Pass through (always) | Pass through (always) |
| Tool calls | Process normally | N/A (tool calls arrive in MUTED) |
| `sc.interrupted` (user spoke during TTS) | N/A | → MUTED + `player.flush()` |

### What replaces "Asking Claude"

A programmatic chime sound (Web Audio API, no external file). Plays when
the `converse` tool call is received. Gives the user instant feedback
that the system heard them, without Gemini speaking.

### Comparison to current state machine

| | Current (`conversePhase`) | Proposed (`phase`) |
|---|---|---|
| States | 3: `idle`, `suppressing`, `relaying` | 2: `muted`, `tts` |
| Default | `idle` (audio/text pass through) | `muted` (audio/text dropped) |
| Timing dependency | "Asking Claude" must arrive before `toolCall` | None — chime on tool call, no ack |
| `outputTranscription` | Shown in `idle`, blocked in `suppressing`/`relaying` | **Never shown** — Claude's text is always in `appendTool` |
| Audio flush | On entering `suppressing` (cancel queued ack) | On `sc.interrupted` only (nothing to flush otherwise) |

## Key files

| File | Lines | What it does now | What changes |
|------|-------|-----------------|--------------|
| `.../live/gemini.ts` | 108 | `conversePhase: 'idle' \| 'suppressing' \| 'relaying'` | Replace with `phase: 'muted' \| 'tts'` |
| `.../live/gemini.ts` | 66-80 | `BASE_PROMPT` — relay instructions | Simplify to dispatcher prompt |
| `.../live/gemini.ts` | 135-229 | `converse` tool handler — suppression + relay | Remove suppression setup, add chime |
| `.../live/gemini.ts` | 247-253 | `sc.interrupted` handler | Add `phase = 'muted'` |
| `.../live/gemini.ts` | 265-267 | `outputTranscription` → `appendOutput` | Delete (never display Gemini's speech text) |
| `.../live/gemini.ts` | 273-278 | Audio gating: `conversePhase !== 'suppressing'` | Change to: `phase === 'tts'` |
| `.../live/gemini.ts` | 285-291 | Nudge: `conversePhase === 'idle'` | Change to: `phase === 'muted'` |
| `.../live/audio.ts` | (end) | — | Add `playChime()` utility |
| `.../live/+page.svelte` | 188 | Label: `'Gemini'` | Change to `'Claude'` |

### Files NOT changed

| File | Why unchanged |
|------|--------------|
| `data.svelte.ts` | `appendOutput` stays (dead code, not called). `pendingOutput` always empty. No breakage. |
| `types.ts` | No interface changes. `DataStoreMethods.appendOutput` stays in the interface (removing would be a separate cleanup). |
| `tools.ts` | Tool declarations unchanged. |
| `converse.ts` | SSE consumer unchanged. |
| `stores/ui.svelte.ts` | No changes. |
| `stores/corrections.svelte.ts` | No changes. |
| `correct.ts` | No changes. |

## Implementation

### 1. `gemini.ts` — state variable

Replace line 108:

```typescript
// OLD
let conversePhase: 'idle' | 'suppressing' | 'relaying' = 'idle';

// NEW
let phase: 'muted' | 'tts' = 'muted';
```

### 2. `gemini.ts` — system prompt

Replace `BASE_PROMPT` (lines 66-80):

```typescript
const BASE_PROMPT = `
You are a silent dispatcher between a user and Claude Code.

RULES:
1. When the user gives an instruction, call the converse tool with their words. Do NOT speak or acknowledge.
2. When you receive a message prefixed with [CLAUDE]:, read it aloud naturally and conversationally. Skip bullet markers, dashes, code formatting symbols, and random IDs.
3. Never add your own words, commentary, or opinions. Never answer questions yourself.
4. When user says "STOP", stop immediately.
`;
```

Key difference: "Do NOT speak or acknowledge" replaces "say Asking
Claude." Gemini skips generating ack audio → faster path to tool call.
Even if it generates something, MUTED drops the bytes.

### 3. `gemini.ts` — converse tool handler

In the `converse` tool block (starting ~line 135):

```typescript
// REMOVE these lines:
conversePhase = 'suppressing';
player.flush();

// ADD: play chime for user feedback
playChime();
```

In `executeConverse` callbacks:

```typescript
onChunk(text) {
  data.appendTool(text);
  if (sessionRef) {
    // First chunk: open the audio gate
    if (phase === 'muted') phase = 'tts';
    sessionRef.sendClientContent({
      turns: [{ role: 'user', parts: [{ text: `[CLAUDE]: ${text}` }] }],
      turnComplete: true,
    });
  }
},
onDone() {
  phase = 'muted';
  data.finishTool();
},
onError(msg) {
  phase = 'muted';
  data.finishTool();
  data.pushError(msg);
},
```

### 4. `gemini.ts` — audio gating in serverContent

Replace the audio playback condition (~line 274):

```typescript
// OLD
if (part.inlineData?.data && conversePhase !== 'suppressing') {
  player.play(part.inlineData.data);
}

// NEW
if (part.inlineData?.data && phase === 'tts') {
  player.play(part.inlineData.data);
}
```

### 5. `gemini.ts` — outputTranscription

Delete the block at ~line 265-267:

```typescript
// DELETE entirely — Gemini's speech text never reaches the UI
// Claude's text is already displayed via appendTool
if (sc.outputTranscription?.text && conversePhase === 'idle') {
  data.appendOutput(sc.outputTranscription.text);
}
```

### 6. `gemini.ts` — interrupted handler

Add phase reset (~line 247):

```typescript
if (sc.interrupted) {
  console.log(`[${tag}] interrupted`);
  phase = 'muted';          // ← ADD
  userSpokeInTurn = false;
  player.flush();
  data.commitTurn();
  return;
}
```

### 7. `gemini.ts` — nudge logic

Update condition (~line 285):

```typescript
// OLD
if (userSpokeInTurn && conversePhase === 'idle') {

// NEW
if (userSpokeInTurn && phase === 'muted') {
```

### 8. `gemini.ts` — approval cancel callbacks

The cancel callbacks passed to `holdForApproval` (~lines 208, 216, 225):

```typescript
// OLD
() => { conversePhase = 'idle'; }

// NEW
() => { phase = 'muted'; }
```

Technically a no-op (already muted by default), but explicit is better
for the reject path where we need to be sure the gate is closed.

### 9. `audio.ts` — chime utility

Add after `playPcmChunks` (after line 160):

```typescript
/** Short notification chime — no external file needed. */
export function playChime(frequency = 800, duration = 0.15): void {
  const ctx = new AudioContext();
  const osc = ctx.createOscillator();
  const gain = ctx.createGain();
  osc.connect(gain);
  gain.connect(ctx.destination);
  osc.frequency.value = frequency;
  gain.gain.value = 0.3;
  osc.start();
  gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + duration);
  osc.stop(ctx.currentTime + duration);
  setTimeout(() => void ctx.close(), (duration + 0.1) * 1000);
}
```

Import in `gemini.ts`:

```typescript
import { playChime } from './audio';
```

### 10. `+page.svelte` — label

Change assistant turn label (line 188):

```svelte
<!-- OLD -->
<span class="label">{turn.role === 'user' ? 'You' : 'Gemini'}</span>

<!-- NEW -->
<span class="label">{turn.role === 'user' ? 'You' : 'Claude'}</span>
```

## Interaction with existing features

### Review/correct modes (approval flow)

Unchanged. In review/correct mode:
1. Tool call arrives → MUTED (default, no change)
2. `holdForApproval` fires (sync in review, async in correct)
3. User sees approval UI, clicks Accept
4. `executeConverse` runs → Claude streams → first chunk → `phase = 'tts'`
5. Gemini reads Claude's text aloud
6. Done → `phase = 'muted'`

The approval cancel callback resets to `muted` (already the default).
No dead audio during the approval wait.

### PTT (push-to-talk)

Unchanged. PTT gates mic input (`sendRealtimeInput`), not audio output.
The binary `phase` gate is orthogonal.

### Replay mode

Unchanged. Replay feeds pre-recorded audio via `sendRealtimeInput`.
The same tool call → chime → Claude stream → TTS flow applies.

### `accept_instruction` tool

Unchanged. It calls `data.approve()` and sends a blocking tool response.
No audio generation, no phase interaction.

### `pendingOutput` / `doCommitAssistant()`

`appendOutput` is never called → `pendingOutput` always empty →
`doCommitAssistant()` still works (commits based on `pendingTool` state,
which is unaffected). Assistant turns in the UI contain only Claude's
tool results, which is correct.

## What this does NOT fix

- **STT accuracy** — `inputTranscription` still comes from Gemini's
  separate ASR frontend. Same errors. The correction subsystem
  (correct mode, LLM auto-correct) is still needed.
  See: `roadmap/todos/correction_llm_accuracy.md`

- **Routing reliability** — Gemini may still fail to call `converse`.
  The nudge logic stays. However: with a simpler prompt (no speech
  management), routing may improve (untested hypothesis).

- **Tool-call arg quality** — `instruction` is still Gemini's
  interpretation. The correction pipeline still needed for accuracy.

## Verification

### Build

```bash
cd vibecoded_apps/claude_talks && npm run check
```

### Manual test (with API key)

1. Navigate to `http://localhost:5173/#/live`
2. Enter Gemini API key
3. Click Start → speak an instruction ("What is a closure?")
4. Verify:
   - **No "Asking Claude"** voice — silence after speaking
   - **Chime plays** when tool call fires
   - **Claude's text appears** in the tool card (streamed)
   - **Claude's text spoken aloud** by Gemini TTS after first chunk
   - **Interrupting** (speak during TTS) stops playback immediately
   - **Label says "Claude"** not "Gemini"

### Replay test (no mic needed)

Use saved recording:

1. Click a recording button (e.g., `converse_closure_question`)
2. Wait ~10s for Gemini to process
3. Same verification as above

### Console log patterns

```
[live] tool call: converse { instruction: "..." }     ← tool fires
[converse] starting: ...                               ← Claude stream starts
[converse] chunk 1: ...                                ← first chunk → TTS opens
```

No `"Asking Claude"` in outputTranscription logs.

### E2E with chrome agent

```
Navigate to http://localhost:5173/#/live.
Take a snapshot. Verify buttons: Start, Record, Replay.
Click the button labeled "converse_closure_question".
Wait 20 seconds.
Take a snapshot.
Verify: message bubbles appeared, label says "Claude" not "Gemini".
Check console: no errors (ignore mic warnings).
Report pass/fail.
```

## Rollback

If this breaks something unexpected: revert `phase` to the old 3-state
`conversePhase`, restore `BASE_PROMPT`, remove `playChime` call,
restore the `outputTranscription` block. All changes are in `gemini.ts`
+ `audio.ts` + one label in `+page.svelte`. No data model or API changes.
