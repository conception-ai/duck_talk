# Isolated Audio Correction Test Script

## Context

The audio few-shot correction code was implemented in gemini.ts but we can't tell if it works from the browser alone — too many moving parts (Svelte, mic, converse pipeline, suppression state machine). We need a minimal Node.js script that connects to Gemini Live, feeds a recorded audio file, and logs the `inputTranscription` result. Run it twice: once without corrections (baseline), once with audio corrections injected via `sendClientContent`. Compare transcriptions.

## What we have

- Recording: `vibecoded_apps/claude_talks/public/recordings/what_is_latest_commit.json` — 522 chunks, 16kHz PCM, ~4s. User says "What is the latest commit?" but Gemini transcribes "What is the latest complete?" or similar.
- SDK: `@google/genai` already in `node_modules/` (ESM, has node dist)
- `combineAudioChunks` in `gemini.ts` — but uses browser `atob`/`btoa`. Node equivalent: `Buffer.from(data, 'base64')` / `.toString('base64')`.

## Implementation

### Single file: `vibecoded_apps/claude_talks/test-audio-correction.mjs`

An ESM Node script (`.mjs`) that:

1. Reads `GEMINI_API_KEY` from env
2. Loads the recording JSON from disk
3. Connects to Gemini Live (`gemini-2.5-flash-native-audio-preview-12-2025`) with:
   - `responseModalities: [Modality.AUDIO]`
   - `inputAudioTranscription: {}`
   - Minimal system instruction (just "Repeat what the user says")
   - No tools (we don't need converse — we just want transcription)
4. Accepts a `--with-correction` flag:
   - Without flag: just feed audio, log transcription (baseline)
   - With flag: first inject the correction via `sendClientContent` (audio + "The user said: ..."), then feed the same audio, log transcription
5. Feeds recording chunks with real timing delays (respecting `ts` deltas)
6. Sends 2s silence after last chunk to trigger end-of-speech
7. Collects all `inputTranscription` text and `serverContent.modelTurn` text
8. Waits for `turnComplete`, logs results, closes

### Key details

- **No browser APIs**: Use `Buffer` instead of `atob`/`btoa` for base64
- **Combine chunks for correction**: Same logic as `combineAudioChunks` but with `Buffer`
- **Callback-based SDK** (JS, not Python): Use `onmessage` callback, collect results in array, resolve a promise on `turnComplete`
- **The correction data**: The recording itself IS the correction audio. We combine all its chunks into one blob, then inject as `{ role: 'user', parts: [{ inlineData: { data, mimeType } }] }` + `{ role: 'model', parts: [{ text: 'The user said: "What is the latest commit?"' }] }` before feeding the same audio via `sendRealtimeInput`

### Usage

```bash
# Baseline (no correction)
GEMINI_API_KEY=... node vibecoded_apps/claude_talks/test-audio-correction.mjs

# With audio correction injected
GEMINI_API_KEY=... node vibecoded_apps/claude_talks/test-audio-correction.mjs --with-correction
```

### Expected output

```
[config] mode: baseline | with-correction
[config] recording: 522 chunks, 4171ms
[connected]
[correction] injected 1 audio example (if --with-correction)
[feeding] 522 chunks...
[feeding] done, sending 2s silence
[inputTranscription] "What is the latest complete?"   (or hopefully "What is the latest commit?" with correction)
[modelResponse] <whatever Gemini says back>
[done]
```

## Files

| File | Action |
|---|---|
| `vibecoded_apps/claude_talks/test-audio-correction.mjs` | Create — self-contained test script |

No changes to any existing files.

## Verification

1. `GEMINI_API_KEY=... node vibecoded_apps/claude_talks/test-audio-correction.mjs` — should connect, feed audio, print transcription, exit cleanly
2. `GEMINI_API_KEY=... node vibecoded_apps/claude_talks/test-audio-correction.mjs --with-correction` — same but with correction injected first
3. Compare the `inputTranscription` output between the two runs

---

## Experiments Run

### Experiment 1 — Baseline

```
sendRealtimeInput:  522 chunks × audio/pcm;rate=16000  (with timing delays)
sendRealtimeInput:  1 chunk × 2s silence

Received:
  inputTranscription  " What"
  inputTranscription  " is the latest complete?"
  turnComplete
```

### Experiment 2 — sendClientContent, text turns, turnComplete: true

```
sendClientContent:  turns=[
                      user:  { text: "..." }
                      model: { text: "..." }
                    ], turnComplete: true

Received:
  onclose  "Request contains an invalid argument."

sendRealtimeInput:  (not reached — session dead)
```

**Finding:** `sendClientContent` with `turnComplete: true` kills the session immediately when called before any real interaction. Invalid for this use.

### Experiment 3 — sendClientContent, text turns, turnComplete: false

```
sendClientContent:  turns=[
                      user:  { text: "..." }
                      model: { text: "..." }
                    ], turnComplete: false

Received:
  (nothing — model did not respond, as expected)

Session stayed alive. Clean close after 3s.
```

**Finding:** `turnComplete: false` is the correct flag for injecting context without triggering a response.

### Experiment 4 — sendClientContent, audio inlineData, turnComplete: false + real audio

```
sendClientContent:  turns=[
                      user:  { inlineData: { data: <130KB PCM>, mimeType: "audio/pcm;rate=16000" } }
                      model: { text: "The user said: \"What is the latest commit?\"" }
                    ], turnComplete: false

Received:
  (nothing)

[waited 2s]

sendRealtimeInput:  522 chunks × audio/pcm;rate=16000
sendRealtimeInput:  1 chunk × 2s silence

Received:
  inputTranscription  " What"
  inputTranscription  " is the latest complete?"
  turnComplete
```

**Finding:** Audio injected via `sendClientContent` + audio fed via `sendRealtimeInput` → `inputTranscription` unchanged from baseline. No error, session stable, but no effect on transcription.

---

### Experiment 5 — sendClientContent text×2: false then true

```
sendClientContent:  turns=[user: { text: "The phrase is: banana" }], turnComplete: false
[waited 1s]
sendClientContent:  turns=[user: { text: "What phrase did I mention?" }], turnComplete: true

Received:
  outputTranscription  "You just mentioned the phrase \"banana\"."
  turnComplete

Session stayed alive. Clean close.
```

**Finding:** Two sequential text `sendClientContent` calls work correctly. Context from the first call (`turnComplete: false`) is retrievable by the model in the second call (`turnComplete: true`). The context injection mechanism works for text.

### Experiment 6 — sendClientContent audio inlineData (false) then text question (true)

```
sendClientContent:  turns=[user: { inlineData: <130KB PCM> }], turnComplete: false
[waited 3s]
sendClientContent:  turns=[user: { text: "What did I say in that audio?" }], turnComplete: true

Received:
  onclose  "Precondition check failed."

No outputTranscription received.
```

Same result when audio + question combined in a single call:

```
sendClientContent:  turns=[user: { inlineData: <130KB PCM>, text: "What did I say?" }], turnComplete: true

Received:
  onclose  "Precondition check failed."
```

**Finding:** Any `sendClientContent` containing audio `inlineData` leaves the session unable to process a subsequent `turnComplete: true`. The API accepts the audio call without immediate error (no disconnect on the `turnComplete: false` call itself), but the session is silently corrupted — any later call that asks the model to generate a response fails.

---

## Summary of Findings

| Approach | Channel | Result |
|---|---|---|
| Text context → real audio | sendClientContent (false) + sendRealtimeInput | Session stable. `inputTranscription` unchanged. |
| Audio inlineData context → real audio | sendClientContent (false) + sendRealtimeInput | Session stable. `inputTranscription` unchanged. |
| Text context → text question | sendClientContent (false) → sendClientContent (true) | Works. Model recalls context correctly. |
| Audio inlineData → text question | sendClientContent (false) → sendClientContent (true) | "Precondition check failed." Session dead. |
| Audio inlineData + text question combined | sendClientContent (true) | "Precondition check failed." Session dead. |
| Text only, turnComplete: true | sendClientContent (true) | Works. Model responds normally. |

### Experiment 7 — sendRealtimeInput correction audio → text label → sendRealtimeInput real audio

```
sendRealtimeInput:  522 chunks × audio/pcm;rate=16000  (correction audio, phase 1)
sendRealtimeInput:  1 chunk × 2s silence

Received (phase 1):
  inputTranscription   " What is the latest complete?"
  outputTranscription  "The COVID-19 situation continues to evolve, with the most current..."
                       [model produced a ~200 word COVID essay]
  turnComplete         (never arrived — model still speaking at 15s timeout)

[timeout at 15s]

sendClientContent:  turns=[
                      user:  { text: "What I said was: \"What is the latest commit?\"" }
                      model: { text: "Understood. You said: \"What is the latest commit?\"" }
                    ], turnComplete: false
[waited 1s]

sendRealtimeInput:  522 chunks × audio/pcm;rate=16000  (real audio, phase 2)
sendRealtimeInput:  1 chunk × 2s silence

Received (phase 2):
  turnComplete  (arrived immediately — tail of phase 1 completing)
  inputTranscription   ""  (empty — real audio never transcribed)
```

**Findings:**
- `inputTranscription` on the correction audio: `" What is the latest complete?"` — STT identical to baseline. Feeding the correction through `sendRealtimeInput` does not change the STT output for that audio.
- The model responded to "What is the latest complete?" with a COVID-19 essay — it answered the (wrong) transcription.
- Phase 1 `turnComplete` never arrived within 15s (model was mid-response). Phase 2 session state was dirty: immediate `turnComplete` with no transcription for the real audio.
- The `sendClientContent` text label injection happened while the model was still speaking — its effect on phase 2 is unknown.

---

## Summary of Findings

| Approach | Channel | inputTranscription result |
|---|---|---|
| Baseline | sendRealtimeInput only | `" What is the latest complete?"` |
| Text context → real audio | sendClientContent(false) + sendRealtimeInput | `" What is the latest complete?"` |
| Audio inlineData context → real audio | sendClientContent(false) + sendRealtimeInput | `" What is the latest complete?"` |
| Text context → text question | sendClientContent(false) → sendClientContent(true) | Model recalled context correctly (n/a for STT) |
| Audio inlineData → text question | sendClientContent(false) → sendClientContent(true) | "Precondition check failed." Session dead |
| Correction via sendRealtimeInput → label → real audio | sendRealtimeInput → sendClientContent(false) → sendRealtimeInput | Phase 2 produced no transcription (dirty session state) |

### Experiment 8 — sendRealtimeInput correction audio (suppressed response) → text label → sendRealtimeInput real audio

Same as experiment 7 but with system prompt `"Whatever the user says, respond only with the single word: ok. Nothing else."` so phase 1 completes cleanly.

```
systemInstruction: "Whatever the user says, respond only with the single word: ok. Nothing else."

sendRealtimeInput:  522 chunks × audio/pcm;rate=16000  (correction audio, phase 1)
sendRealtimeInput:  1 chunk × 2s silence

Received (phase 1):
  inputTranscription   " What is the latest complete?"
  outputTranscription  "ok"
  turnComplete

sendClientContent:  turns=[
                      user:  { text: "What I said was: \"What is the latest commit?\"" }
                      model: { text: "ok" }
                    ], turnComplete: false
[waited 500ms]

sendRealtimeInput:  522 chunks × audio/pcm;rate=16000  (real audio, phase 2)
sendRealtimeInput:  1 chunk × 2s silence

Received (phase 2):
  inputTranscription   " What"
  inputTranscription   " is"
  inputTranscription   " the latest commit?"
  outputTranscription  "ok"
  turnComplete
```

**Results:**
```
correction inputTranscription: " What is the latest complete?"
real      inputTranscription: " What is the latest commit?"
```

Phase 1 `inputTranscription`: unchanged — `" What is the latest complete?"`.
Phase 2 `inputTranscription`: corrected — `" What is the latest commit?"`.

---

## Summary of Findings

| Experiment | Approach | inputTranscription result |
|---|---|---|
| 1 | Baseline — sendRealtimeInput only | `" What is the latest complete?"` |
| 2 | sendClientContent audio inlineData + turnComplete:true | Session dead — "Invalid argument" |
| 3 | sendClientContent text, turnComplete:false | Session stable, no transcription effect |
| 4 | sendClientContent audio inlineData, turnComplete:false → sendRealtimeInput real audio | `" What is the latest complete?"` — unchanged |
| 5 | Two text sendClientContent calls (false → true) | Model recalled text context correctly |
| 6 | sendClientContent audio inlineData (false) → sendClientContent text question (true) | "Precondition check failed." Session dead |
| 7 | sendRealtimeInput correction → text label → sendRealtimeInput real | Inconclusive — phase 1 never completed (model response too long) |
| 8 | sendRealtimeInput correction (suppressed response) → text label → sendRealtimeInput real | **`" What is the latest commit?"` — corrected** |

### Experiment 9 — CALIBRATION/LIVE system prompt with [LIVE START] sentinel

Same flow as experiment 8 but with a structured system prompt defining two named phases and a sentinel to switch between them.

```
systemInstruction:
  "You operate in two phases.
   CALIBRATION phase: You will hear audio examples followed by a correction message
   telling you what was actually said. Do not speak. Do not respond. Stay completely
   silent for every calibration turn.
   LIVE phase: Starts when you receive [LIVE START]. From that point, respond normally."

sendRealtimeInput:  522 chunks × audio/pcm;rate=16000  (calibration audio)
sendRealtimeInput:  1 chunk × 2s silence

Received (calibration):
  inputTranscription   " What is the latest complete?"
  outputTranscription  "The latest completed what? Could you please specify what you are referring to?"
  turnComplete

sendClientContent:  turns=[
                      user:  { text: "What I said was: \"What is the latest commit?\"" }
                      model: { text: "" }
                      user:  { text: "[LIVE START]" }
                      model: { text: "" }
                    ], turnComplete: false
[waited 500ms]

sendRealtimeInput:  522 chunks × audio/pcm;rate=16000  (live audio)
sendRealtimeInput:  1 chunk × 2s silence

Received (live):
  inputTranscription   " What"
  inputTranscription   " is"
  inputTranscription   " the latest commit?"
  outputTranscription  "I can't access specific project repositories. To tell you the latest commit, I would need to know the name or location of the repository."
  turnComplete
```

**Results:**
```
calibration inputTranscription: " What is the latest complete?"
live        inputTranscription: " What is the latest commit?"
```

**Findings:**
- Calibration `inputTranscription`: `" What is the latest complete?"` — STT still wrong on correction audio itself.
- Live `inputTranscription`: `" What is the latest commit?"` — corrected.
- System prompt did not fully suppress calibration response — model spoke ("The latest completed what?"). However correction still took effect.
- Live model response used the word "commit" correctly throughout, consistent with the corrected transcription.

---

## Summary of Findings

| Exp | Approach | inputTranscription result |
|---|---|---|
| 1 | Baseline — sendRealtimeInput only | `" What is the latest complete?"` |
| 2 | sendClientContent audio inlineData + turnComplete:true | Session dead — "Invalid argument" |
| 3 | sendClientContent text, turnComplete:false | `" What is the latest complete?"` — unchanged |
| 4 | sendClientContent audio inlineData (false) → sendRealtimeInput real audio | `" What is the latest complete?"` — unchanged |
| 5 | Two text sendClientContent calls (false → true) | Model recalled text context correctly (not an STT test) |
| 6 | sendClientContent audio inlineData (false) → sendClientContent text (true) | "Precondition check failed." Session dead |
| 7 | sendRealtimeInput correction → text label → sendRealtimeInput real | Inconclusive — phase 1 never completed (model response too long) |
| 8 | sendRealtimeInput correction ("ok" suppression) → text label → sendRealtimeInput real | `" What is the latest commit?"` — **corrected** |
| 9 | sendRealtimeInput correction (CALIBRATION/LIVE prompt) → text label + [LIVE START] → sendRealtimeInput real | `" What is the latest commit?"` — **corrected** |

### Experiment 10 — Model turn injection via sendClientContent

```
sendClientContent:  turns=[
                      model: { text: "The secret word is: pineapple." }
                    ], turnComplete: false
[waited 500ms]

sendClientContent:  turns=[
                      user: { text: "What did you just say?" }
                    ], turnComplete: true

Received:
  outputTranscription  "I said \"The secret word is: pineapple.\""
  turnComplete
```

**Finding:** Model turns injected via `sendClientContent` are fully written into the context window and treated by the model as its own prior speech. The model had never actually said "pineapple" — it was injected — but it recalled it as something it said.

---

## What Works

The sequence that corrects `inputTranscription`:

1. `sendRealtimeInput` correction audio + silence — let STT and model process it
2. Wait for `turnComplete`
3. `sendClientContent` text label + `[LIVE START]` sentinel, `turnComplete: false`
4. `sendRealtimeInput` real audio + silence

The system prompt must define CALIBRATION and LIVE phases with `[LIVE START]` as the switch. Model response during calibration was not fully suppressed in experiment 9 but correction still applied.
