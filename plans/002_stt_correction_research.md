# STT Correction — Research Log

## Problem

Gemini Live consistently mis-transcribes one user's speech. Example:
- User says: **"What is the latest commit?"**
- `inputTranscription` shows: **"What is the latest complete?"** (or "committee", "COVID", etc.)

The current app has text-based corrections in `systemInstruction` (`<STT_CORRECTIONS>`) which help the reasoning layer (tool call args get corrected) but `inputTranscription` still shows the wrong text.

**Goal:** fix `inputTranscription` itself, not just downstream reasoning.

## Test Assets

- Recording: `vibecoded_apps/claude_talks/public/recordings/what_is_latest_commit.json` — 522 chunks, 16kHz PCM, ~4s. Used as both the correction audio and the live audio in all experiments.
- Test script: `vibecoded_apps/claude_talks/test-audio-correction.mjs` — ESM Node script. Connects to Gemini Live, feeds the recording, logs `inputTranscription`. Run with `GEMINI_API_KEY=... node test-audio-correction.mjs`.
- SDK: `@google/genai` in `node_modules/`, ESM, node dist at `dist/node/index.mjs`.

## Key Concepts: Two Channels

A Gemini Live session has two ways to send data — can be used simultaneously:

| Channel | VAD | `inputTranscription` | Ordering | Use for |
|---|---|---|---|---|
| `sendRealtimeInput` | Yes — auto-responds | Yes — STT fires | Best-effort | Live mic audio |
| `sendClientContent` | No | No | Deterministic | Context injection, text relay |

**Critical:** `inputTranscription` only fires for audio sent via `sendRealtimeInput`. Audio sent via `sendClientContent` (as `inlineData`) bypasses STT entirely.

**`turnComplete`** is the server's definitive signal that a turn is done. Reliable synchronization primitive for sequencing operations.

**Injected model turns** via `sendClientContent` are fully written into the context window and treated as the model's own prior speech (verified: model recalled "pineapple" it never actually said).

## Dead Ends

| Approach | What happened | Why it fails |
|---|---|---|
| `sendClientContent` audio `inlineData` + `turnComplete: true` | Session dead — "Invalid argument" | Can't use `turnComplete: true` with audio inlineData |
| `sendClientContent` audio `inlineData` (false) → real audio via `sendRealtimeInput` | `inputTranscription` unchanged | `sendClientContent` bypasses STT — model sees audio in context but STT pipeline never heard it |
| `sendClientContent` audio `inlineData` (false) → text question (true) | Session dead — "Precondition check failed" | Audio `inlineData` in `sendClientContent` silently corrupts session state; any subsequent `turnComplete: true` fails |
| `sendRealtimeInput` correction → (no wait) → text label → real audio | Phase 2 empty transcription | Model was mid-response during label injection; dirty session state |

**Conclusion on `sendClientContent` + audio:** the Live API does not properly support audio `inlineData` in `sendClientContent` turns. It accepts the call without immediate error but leaves the session broken.

## What Works

**The calibration loop pattern** (verified in experiments 8 and 9):

```
[session start, before mic opens]

for each correction:
  1. sendRealtimeInput: correction audio chunks + 2s silence
  2. await turnComplete                          ← deterministic wait
  3. sendClientContent: [
       user:  "What I said was: '{correction.meant}'"
       model: "Understood. When I hear this sound, you are saying '{correction.meant}' and I will transcribe it correctly."
     ], turnComplete: false

sendClientContent: [
  user:  "[LIVE START]"
  model: ""
], turnComplete: false

[mic starts here — user can now talk]
```

**System prompt required:**
```
You operate in two phases.
CALIBRATION phase: You will hear audio examples. After each, you will receive a correction
telling you what was actually said. Stay silent — do not respond.
LIVE phase: Starts when you receive [LIVE START]. Respond normally from that point.
```

**Results:**
```
calibration inputTranscription: " What is the latest complete?"   ← STT still wrong on correction audio itself
live        inputTranscription: " What is the latest commit?"     ← corrected
```

**Important:** The system prompt did not fully suppress calibration responses — model still spoke during calibration. However correction still applied. The calibration audio/response can be suppressed in the UI layer (don't play audio, don't show transcript) without needing server-side suppression.

## Architecture for App Integration

The calibration loop runs inside `connectGemini()` (or between `connectGemini` and `startMic` in `data.svelte.ts`), **before the mic starts**. The user physically cannot send audio during calibration. No race conditions, no suppression needed.

```
connectGemini()     ← session established, calibration loop runs here
                      status: 'calibrating' during this phase
startMic()          ← mic opens after all corrections processed
                      user can now talk
```

`turnComplete` gates each correction — we don't advance until the server confirms the turn is done. The calibration loop needs a mutable `waitingForTurnComplete` resolve function set before feeding each correction's audio, resolved by `handleMessage` when `turnComplete` arrives.

**Timing gotcha:** `[LIVE START]` injection via `sendClientContent` can emit a spurious `turnComplete`. Set the live-phase `turnComplete` listener AFTER feeding the live audio (by then the spurious one has already fired and been ignored).

## Open Questions / Promising Leads

1. **Calibration response suppression in system prompt** — the CALIBRATION/LIVE system prompt did not fully silence the model during calibration. The "stay silent" instruction was ignored. Suppressing in the UI layer works, but if model verbosity causes calibration to take long (waiting for a long response before `turnComplete`), this could add latency. Possible fix: use PTT mode (`automaticActivityDetection: { disabled: true }`) for the calibration phase to have tighter control over when the model responds.

2. **Transcription quality** — experiments 8/9 got perfect "commit". The full calibration loop test got "committee" (closer than "complete" but not perfect). This may be model variability (STT is probabilistic) rather than a structural issue. More runs needed to assess consistency.

3. **Multiple corrections** — all experiments used one correction. How does the loop behave with 3–5 corrections? Does each successive correction still work? Does calibration latency stack linearly?

4. **Richer ack messages** — untested whether a more detailed acknowledgment ("I will transcribe it correctly from now on") vs empty string improves correction quality.

5. **Text corrections in system prompt** — the existing `<STT_CORRECTIONS>` text block is still in `buildSystemPrompt()`. Now that we have a working audio correction approach, decide whether to keep both (belt-and-suspenders) or remove text corrections in favour of audio only.
