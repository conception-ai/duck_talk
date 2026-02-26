# Role

You are a world class software engineer.
Your code must be clean, minimalist and easy to read.

## Files to read at all times

Batch read them all in a single read. You must read context in a single turnÒ

| File | Purpose |
|------|---------|
| @src/shared/types.ts | Unified types for sessions + content blocks. Single source of truth — server and client both import from here. `ContentBlock` union, `SessionEntry`/`TreeEntry` unions, type guards |
| @src/shared/models.ts | Session file operations — `Conversation` class, `walkPath()`, `forkSession()`, `pathToSlug()`, `readTail()`/`sessionPreview()` for fast JSONL scanning |
| @src/server/claude-client.ts | TS Agent SDK wrapper. `ClaudeConfig`, `subprocessEnv()`. `Claude.converse()` async generator — streams `TextDelta \| ContentBlockChunk \| Result` |
| @src/server/routes.ts | Express backend — SSE streaming, all API endpoints, `express.static()` for production. cwd-scoped: `PROJECT_CWD` from launch dir |
| @src/server/cli.ts | CLI entry point. `.env` loader (zero-dep), prereq checks, Express listen, `publicDir` resolution for production mode |
| @package.json | Package config — `npm start` (production), `npm run dev` (dev), `npm run build` (tsc + vite) |
| @src/client/routes/home/+page.svelte | Home page — session list, fetches `GET /api/sessions`, navigates to `/live/:id` |
| @src/client/App.svelte | Router — `/` → HomePage, `/live` → LivePage, `/live/:id` → LivePage (with session), `/recordings` → RecordingsPage |
| @src/client/routes/live/+page.svelte | Gemini Live — 3-zone layout: chat-scroll (messages + faded streaming bubble), dock (float transcription/approval + input-bar with real waveform + mic/stop), modals (Settings, Corrections). Waveform via second `getUserMedia` + `AnalyserNode`, synced to `live.status` via `$effect`. Loads history on mount. Renders `messages[]` only (not `voiceLog[]`) |
| @src/client/routes/live/types.ts | Re-exports render types from `lib/chat-types.ts` (`ContentBlock`, `Message`, `VoiceEvent`, `PendingTool`, `PendingApproval`, `Status`, `InteractionMode`, `Correction`). Keeps port interfaces locally: `DataStoreMethods`, `AudioPort`, `LiveBackend`, `ConverseApi`, `StreamingTTS`, `RealtimeInput` |
| @src/client/routes/live/stores/data.svelte.ts | Data store — two-array model: `messages[]` (CC conversation, mutable) + `voiceLog[]` (ephemeral, append-only). `loadHistory()`, `editMessage()`, session lifecycle, approval flow. `doCommitAssistant()` routes tool results to `messages[]`. No player lifecycle — TTS session owns its own player |
| @src/client/routes/live/stores/ui.svelte.ts | UI store — persistent user prefs (apiKey, mode: InteractionMode, model, systemPrompt, readbackEnabled, permissionMode). `setMode()` sets mode directly. `load()` merges localStorage with `DEFAULTS` so new fields get populated. Migrates old `learningMode: boolean` on load |
| @src/client/routes/live/gemini.ts | Gemini Live connection + message handling (STT + VAD + orchestration only — no TTS). 2-tool model: `converse` (forward instruction) + `stop` (cancel). `converse` is BLOCKING — Gemini freezes, tool response sent immediately as `{ result: "done" }` to unfreeze. Claude's response text is injected back into outer Gemini via TTS session's `onFlush` hook (`sendClientContent` with `role: 'model'`, `turnComplete: false`) — same sentence-boundary cadence as TTS audio. Stop detection uses browser-native `startKeywordListener` (from `voice-approval.ts`) during active converse — lower latency than Gemini's ASR. `stop` tool is pure control flow (no `startTool`/`finishTool`). Opens persistent TTS session once at `connectGemini()` scope. `holdWithVoice` wires voice approval during BLOCKING hold. `approvalPending` gates `sendRealtimeInput` |
| @src/client/routes/live/tts-session.ts | Persistent TTS session — self-contained Gemini Live session that speaks Claude's text. Owns its own connection, sentence buffer, and audio player. One instance per voice session, reused across converse calls. `send(text)` / `finish()` / `interrupt()` / `close()` interface. `interrupt()` mutes + flushes between converse calls; `close()` is final teardown. Each sentence-buffer flush sent as `sendClientContent(turnComplete: true)`. Tracks `pendingSends` counter. Prefixes text with `[READ]:` to prevent Gemini answering instead of reading. Optional `onFlush` callback — fires alongside `sendText` on each sentence-buffer flush, used by `gemini.ts` to piggyback context injection into outer Gemini |
| @src/client/routes/live/converse.ts | SSE stream consumer for /api/converse. Has `AbortController` + `abort()` method for cancelling in-flight streams (used by `back()`) |
| @src/client/routes/live/audio.ts | Browser audio I/O — mic capture (PCM worklet at 16kHz), gapless player (24kHz), one-shot playback. `createPlayer().stop()` guards against double-close (`ctx.state !== 'closed'`) |
| @src/client/routes/live/tools.ts | Gemini function declarations (`converse` — forward instruction, `stop` — cancel current work) + handlers |
| @src/client/routes/live/buffer.ts | Sentence-boundary text buffer — `createSentenceBuffer(onFlush, { minChars, maxWaitMs })`. Accumulates streaming text, flushes at sentence boundaries (`. ` `! ` `? `) when >= minChars (default 40) accumulated. Timer fallback (default 1000ms) for text without punctuation |

## Files to read if needed

| File | Purpose |
|------|---------|
| docs/gemini-live-docs.md | Gemini Live API reference — capabilities, VAD config, function calling, session management |
| docs/claude_code_python_sdk.md | Claude Agent SDK reference — `ClaudeAgentOptions`, `ClaudeSDKClient`, `query()`. No leaf/branch control exists; `resume` is session ID only |
| src/client/lib/tts.ts | TTS utility — `speak(apiKey, text)` → base64 PCM at 24kHz via Gemini TTS. Imported by `+page.svelte` for readback (plays instruction via `playPcmChunks` before approval). Also dynamically imported by Chrome MCP test scripts |
| src/client/routes/live/stores/corrections.svelte.ts | Corrections store — localStorage-persisted STT corrections |
| src/client/routes/live/correct.ts | Stateless LLM auto-correction — `correctInstruction(llm, instruction, corrections)`. Text-only today, planned: multimodal with audio (see `roadmap/todos/correction_llm_accuracy.md`) |
| src/client/routes/live/voice-approval.ts | Browser `webkitSpeechRecognition` keyword listener. Generic `startKeywordListener(keywords, { tag, lang })` matches words against a callback map, auto-stops on first match. Exports keyword constants (`ACCEPT_WORDS`, `REJECT_WORDS`, `STOP_WORDS`). `startVoiceApproval` is a thin wrapper for approval holds. Used for both approval keywords and stop detection during converse |
| src/client/lib/llm.ts | LLM abstraction — `createLLM({ apiKey })` → callable with `.stream()`, `.json<T>()`. Supports multimodal: `Message.content` accepts `string` or `Part[]` (text + `inlineData` for audio/images) |
| src/client/lib/stt.ts | Pure audio utilities — `combineChunks` (merge base64 PCM), `chunksToWav` (PCM → WAV). No LLM dependency |
| src/client/lib/recording-db.ts | IndexedDB CRUD for utterance recordings — `saveRecording`, `getAllRecordings`, `deleteRecording`, `clearAllRecordings` |
| src/client/lib/recorder.ts | Black-box utterance recorder — taps `getUserMedia` to capture mic audio, auto-segments on `utterance-committed` CustomEvents, persists to IndexedDB. Setup called from live `+page.svelte` on mount. Console access via `window.__recorder` |
| src/client/routes/recordings/+page.svelte | Recordings browser — reads from IndexedDB, lists utterances with play/download/delete buttons. Route: `/#/recordings` |
| src/client/lib/chat-types.ts | Re-exports `ContentBlock` from `src/shared/types.ts` (single source of truth). UI-only types defined locally: `Message`, `PendingTool`, `PendingApproval`, `Status`, `VoiceEvent`, `Correction`, `InteractionMode`. `live/types.ts` re-exports from here |
| src/client/lib/message-helpers.ts | Pure functions on `Message`: `messageText()`, `messageToolUses()`, `messageToolResults()`, `messageThinking()`, `buildToolResultMap()`, `isToolResultOnly()`. Used by both `live/` and `new-ui/` |
| src/client/lib/dev/ScenarioSelector.svelte | Reusable dev dropdown for switching UI states. Generic over `T` (any scenario state shape). Positioned top-right |

## Guiding Principles

- **Clean data flows**: Raw signals (STT chunks, VAD events) must be merged into clean domain objects at the store level. Consumers (UI, corrections, API calls) should never reconstruct or re-derive from raw data. Fix the source, not each consumer. Leverage Svelte's reactivity: one clean `$state` → many `$derived` readers.

## UI/UX Iteration Process

**Production → Prototype (fast start):**
1. Create a new route under `src/routes/` (e.g. `new-ui/`)
2. Import shared types e.g. `lib/chat-types.ts` and helpers e.g. `lib/message-helpers.ts`
3. Create a `scenarios.ts` with mock data in `ScenarioState` shape, e.g.: `{ messages: Message[], status: Status, pendingTool, pendingApproval, pendingInput, toast }`
4. Build `+page.svelte` using `ScenarioSelector` from `lib/dev/ScenarioSelector.svelte` — bottom-right dropdown drives all UI state via `$derived`
5. Register the route in `App.svelte`
6. No backend, no stores, no audio needed — iterate at `http://localhost:5173/#/your-route`

**Prototype → Production (propagate):**
1. Diff `new-ui/+page.svelte` vs `live/+page.svelte` — focus on markup and CSS changes
2. Template bindings carry over directly because both use the same `lib/message-helpers` and `lib/chat-types`
3. If types changed during prototyping, reconcile them and verify re-exports still work
4. Run `npm run check` to catch breakage

**Key pattern — scenario-driven rendering (Svelte 5):**
```svelte
let scenario = $state(SCENARIOS[0]);              // ScenarioSelector binds here
let messages = $derived(scenario.state.messages);  // everything derives from scenario
let status = $derived(scenario.state.status);
let inputText = $state('');                        // local interactive state
```


## Gotchas

- **Two-array data model** (`data.svelte.ts`): State is split into two arrays with different lifecycles:
  - `messages: Message[]` — CC conversation only. Persistent (loaded from backend, appended during converse, truncated on "back"). 1:1 with `types.ts` content blocks. `commitTurn()` routes converse tool results here.
  - `voiceLog: VoiceEvent[]` — user speech + errors. Append-only, session-local, lost on page reload. `commitTurn()` routes `pendingInput` here. `pushError()` also goes here.
  - **Why**: "go back" pops from `messages[]` but leaves `voiceLog[]` untouched. Can't do this cleanly with one interleaved array.
- **Message quality levels**: `messages[]` has two fidelity levels depending on source:
  - **Loaded from backend** (`GET /api/sessions/{id}/messages`): full content blocks — `text`, `thinking`, `tool_use`, `tool_result`, `image`.
  - **Appended during live session** (from SSE stream): degraded — only `[{ type: 'text', text: flatText }]`. The SSE endpoint returns `{text: "..."}` chunks, not structured blocks.
  - Both render fine. When user navigates away and returns, history reload gives full fidelity.
- **`walk_path()` returns leaf-to-root order**: `Conversation.walk_path(leaf_uuid)` returns `[leaf, ..., root]`. Must `.reverse()` for display. The backend `GET /messages` endpoint handles this.
- **CLI ignores `SummaryEntry.leafUuid`** (proven experimentally): When resuming with `--resume <session_id>`, the CLI always picks the deepest leaf in the tree, NOT the `leafUuid` from a `SummaryEntry`. `Conversation.active_leaf` matches this behavior (just deepest leaf). The only way to rewind is `fork_session()`: create a new JSONL with only the path entries up to the target message, then resume THAT session. The frontend auto-adopts the new `session_id` from the done event (`converse.ts:103`).
- **Backend serialization**: `AssistantEntry.message.content` is `ContentBlock[]` (plain TS objects). `routes.ts` filters null/undefined keys when serializing (equivalent of pydantic's `exclude_none`). `UserEntry.message.content` (`string | JsonDict[]`) returned as-is.
- **`editMessage()` abort race condition** (`data.svelte.ts`): `api.abort()` is sync but the AbortError fires on the next microtask. The error callback in `gemini.ts` calls `finishTool()` which could commit partial results. Solution: `editMessage()` clears `pendingTool = null` BEFORE the await, so `finishTool()` short-circuits when the async error arrives.
- **Gemini Live**: use `types.LiveConnectConfig` + `types.Modality.AUDIO` (not raw dicts). `model_turn.parts` can be `None`. File input needs chunking + `audio_stream_end=True`.
- **Audio format split**: Gemini Live (`sendRealtimeInput`) accepts raw PCM (`audio/pcm;rate=16000`). `generateContent` does NOT — it needs a proper container format (WAV, MP3, etc.). Use `chunksToWav()` from `stt.ts` to wrap PCM before passing to `llm()`. Confirmed by experiment: raw PCM → hallucinated output; WAV → correct transcription.
- **Two injection channels** (`gemini.ts`): A Gemini Live session has two ways to send data — they can be used simultaneously on the same session.
  - `sendRealtimeInput` — **live audio stream**. Subject to VAD (auto-detects speech start/stop). Best-effort ordering. Use for: mic audio.
  - `sendClientContent` — **structured context injection**. No VAD. Deterministic ordering. Model responds only if `turnComplete: true`. Use for: prefilling context, feeding Claude text back. Audio `inlineData` parts work here (undocumented but confirmed). `turnComplete: true` crashes if sent before any audio has flowed — use `turnComplete: false` for context prefilling.
  - Ordering is guaranteed *within* each channel but *not across* them. Already mixed in practice: mic streams via `sendRealtimeInput` while Claude chunks are injected via `sendClientContent`.
- **`inputTranscription` / `outputTranscription`** — confusingly named. Both are **server-sent events** (Gemini pushes them to you). "input" = transcription of the **user's** mic audio (from `sendRealtimeInput`). "output" = transcription of **Gemini's own** spoken response.
  - `inputTranscription` is produced by a separate ASR pipeline that does not read the model's context window. `sendClientContent` (text or audio) does not change it.
  - `sendClientContent` with `turnComplete: true` as the first message → **disconnects** ("Request contains an invalid argument."). Use `turnComplete: false` for prefilling.
- **Abort model** (`gemini.ts`): Three abort paths, all funneling through `activeConverse?.abort()` (idempotent via `aborted` flag):
  - **Browser keyword listener** (`voice-approval.ts`): `startKeywordListener` with `STOP_WORDS` runs during active converse via `webkitSpeechRecognition`. Exact word match ("stop", "cancel") — no false positives on "bus stop". Lowest latency (~200ms). Listener lifecycle matches converse: starts with `executeConverse`, cleaned up in `abort()`.
  - **Gemini `stop` tool**: Gemini processes speech, calls `stop` tool (~1-2s latency). Pure control flow — handled before `startTool`, so no phantom pendingTool. Or calls `converse` with new instruction → `executeConverse` calls `activeConverse?.abort()` before starting new stream.
  - **`sc.interrupted`**: Gemini's own VAD interruption signal (model generation was canceled server-side), distinct from `inputTranscription` (ASR text). When `sc.interrupted` fires, `activeConverse?.abort()` runs.
  - **Double-fire is safe**: If keyword listener and stop tool both fire for the same "stop" utterance, `abort()` runs once (first caller wins via `aborted` flag). The stop tool then hits `activeConverse = null` → `?.abort()` is a no-op. No data store side effects.
- **BLOCKING converse + immediate tool response** (`gemini.ts`): The `converse` tool is BLOCKING — Gemini freezes entirely (no audio, no text) when it calls the tool. The tool response is sent immediately as `{ result: "done" }` to unfreeze — Claude's text is NOT sent via tool response (which confused Gemini). Instead, Claude's response is injected separately via `sendClientContent` with `role: 'model'`, `turnComplete: false` — piggybacking on the TTS sentence buffer's `onFlush` callback. This gives Gemini context about what Claude said without going through the tool call/response mechanism. After unfreeze, Outer Gemini is free to hear new speech and call tools (including `stop` or another `converse`). A persistent TTS session (`tts-session.ts`) handles audio output independently.
- **`approvalPending` gates `sendRealtimeInput`** (`gemini.ts`): During BLOCKING approval holds, mic audio is gated off from the frozen Gemini session. Without this, audio would buffer server-side and replay as a phantom utterance after unfreezing. One-line gate in the `LiveBackend` handle.
- **Voice approval during BLOCKING** (`voice-approval.ts` + `gemini.ts`): Since Gemini is frozen during approval (can't hear the user), `startVoiceApproval` (thin wrapper over `startKeywordListener` using `ACCEPT_WORDS`/`REJECT_WORDS`) takes over. `holdWithVoice()` in `gemini.ts` starts it alongside `holdForApproval`, stops it on resolve. A `resolved` boolean guards against double-fire (voice says "accept" at the same instant user clicks Accept button → only one fires). Voice calls `data.approve()` / `data.reject()` — same store methods the UI buttons use.
- **Gemini disconnect handling** (`gemini.ts`): `closed` flag is hoisted to outer scope (next to `sessionRef`) so the `onclose` callback can reach it. On unexpected Gemini crash: `onclose` sets `closed = true` (guards all sends), calls `tts.close()` (persistent TTS teardown), clears `sessionRef`, and shows a toast via `pushError()`. On user-initiated `stop()`: `backend.close()` sets `closed = true` first, so `onclose` detects `wasExpected = closed` and skips the toast. Claude's converse stream continues rendering text even after Gemini dies — only TTS is lost. The preview model (`gemini-2.5-flash-native-audio-preview`) can drop with "Internal error occurred" at any time — this is Gemini infra instability, not a client bug (confirmed by replay: same audio succeeds on retry).
- **TTS session architecture** (`tts-session.ts`): Persistent Gemini Live session, one per voice session (created at `connectGemini()` scope), reused across converse calls. Fully self-contained — owns its own `GoogleGenAI` connection, `createSentenceBuffer`, and `createPlayer`. Each sentence-buffer flush is sent directly via `sendClientContent(turnComplete: true)`. Non-obvious behaviors discovered experimentally:
  - **`turnComplete:false` does NOT trigger audio** — audio only starts after `turnComplete:true`. Accumulating all text with `turnComplete:false` then sending `true` at the end is batch TTS, not streaming.
  - **`turnComplete:true` without prior `sendRealtimeInput` audio works fine** — the gotcha about crashing without prior audio does NOT apply to TTS-only sessions (tested).
  - **Multiple `turnComplete:true` are NOT merged in practice** — each `sendClientContent(turnComplete:true)` produces its own `turnComplete` response from Gemini. The session tracks `pendingSends` counter: increment on send, decrement on `turnComplete`.
  - **Sentence-boundary splitting matters** — time-based splitting (1s buffer) cuts mid-sentence ("FastAPI" [gap] "with SSE streaming"). Sentence-boundary splitting (`. ` `! ` `? ` after >=40 chars, fallback 1000ms) sounds natural.
  - **Connect latency is ~35-57ms** — paid once per voice session, not per converse call.
  - **First-audio latency is ~1.5s** consistently from `sendClientContent(turnComplete:true)` to first `inlineData` audio chunk.
  - **Three lifecycle methods**: `finish()` flushes buffer, lets audio drain, resets state (session stays alive). `interrupt()` mutes audio, clears buffer, flushes player (session stays alive, AudioContext preserved). `close()` is final teardown — destroys AudioContext + closes WebSocket. Only called when outer Gemini session ends.
  - **`muted` flag for stale audio gating**: On `interrupt()`, `muted = true` — `onmessage` drops all incoming audio chunks. On next `send()`, `muted` clears and TTFT tracking resets. Without this, audio from an interrupted converse would play into the next one.
  - **`pendingSends` reset on interrupt**: Set to 0 on `interrupt()`. Old `turnComplete` events from Gemini arrive and `Math.max(0, pendingSends - 1)` stays at 0. Combined with `finishing = false`, prevents stale drain logic from closing the session.
  - **`player.flush()` vs `player.stop()`**: `interrupt()` uses `flush()` (stops sources, resets timing, preserves AudioContext). `close()` uses `stop()` (calls `ctx.close()` — irreversible). Getting this wrong = either leaked AudioContexts or broken audio after first interrupt.
  - **TTS hallucination prevention**: Text sent to the TTS session is prefixed with `[READ]:` and the system prompt explicitly forbids answering questions. Without this, Gemini answers conversational text ("Want me to dig into those?") instead of reading it aloud.
  - **Context accumulation**: Previous `[READ]:` turns stay in the TTS session's context window across converse calls. Accepted trade-off for reduced latency. If the context window fills up, Gemini will error and the session closes via `onerror`/`onclose`.
  - **`onFlush` callback for context injection**: `openTTSSession(apiKey, onFlush?)` accepts an optional callback that fires on every sentence-buffer flush alongside `sendText`. The callback receives clean text (without `[READ]:` prefix — that's added inside `sendText`). `gemini.ts` uses this to inject Claude's response into the outer Gemini session at the same sentence-boundary cadence as TTS audio. One buffer, two consumers. On `interrupt()` / `clear()`, the buffer is cleared without flushing — no stale context injection. On abort, `onChunk` is gated by `aborted` flag so `tts.send()` never fires, naturally preventing both TTS and context injection.
- **Svelte app**: Gemini API key is stored client-side in `localStorage` (`claude-talks:ui`), managed via unified Settings modal in `+page.svelte`. Flows through DI: `ui.apiKey` → `data.svelte.ts` (`getApiKey` dep) → `gemini.ts` (`ConnectDeps.apiKey`). Settings modal auto-opens on first visit if no key is set.
- **Nested session prevention** (`claude-client.ts`): `delete process.env['CLAUDECODE']` at import time — prevents "nested session" error when `reduck` runs inside a Claude Code terminal.
- **Session paths**: All sessions live under `~/.claude/projects/{slug}/`. The slug uses hyphens for ALL non-`[a-zA-Z0-9-]` chars — this is the CLI's own path sanitization (`path_to_slug()`). Example: `/Users/foo/my_project` → `-Users-foo-my-project`.
- **cwd-scoped**: `reduck` is launched from a directory → that IS the project. `PROJECT_CWD = process.cwd()` at server startup. No multi-project picker.
- **SDK client lifetime**: Each `query()` call spawns a fresh subprocess. Use `resume=session_id` (captured from `ResultMessage.session_id`) to maintain conversation across calls.
- **Interaction mode** (`ui.svelte.ts`): 2-way mode selector in Settings modal — `direct`, `review`. Persisted in localStorage (`claude-talks:ui` as `mode`).
  - **`direct`** — tool calls execute immediately, no approval UI.
  - **`review`** — single-stage approval: user sees instruction, Accept/Edit/Reject. If user edits, the diff is saved as a correction in `corrections.svelte.ts`. Acceptance can come from UI button OR voice (`webkitSpeechRecognition` via `voice-approval.ts`).
  - Main session audio is fully ignored (no player, no `outputTranscription` handler). TTS session handles all audio output independently.
  - Approval UI is in the dock float (docked above input bar, not inline in chat). Shows `pendingApproval.instruction` in a green-bordered card with Accept/Edit/Reject buttons. Edit mode replaces text with a textarea.
- **UI layout** (`+page.svelte`): 3-zone layout — (1) **chat-scroll**: committed messages + faded streaming bubble, (2) **dock**: float (transcription or approval card) + input-bar (waveform + stop when connected, "Reply..." + mic when idle), (3) overlays: toast, modals. No `voiceLog[]` rendering. Mic button inside input-bar (bottom right), not a centered orb. Real audio-reactive waveform (16 green bars via `AnalyserNode`). Settings modal consolidates: API key, readback, mode, permission mode, model, system prompt, corrections link. Auto-opens on first visit if no API key.
- **Second `getUserMedia` for waveform** (`+page.svelte`): The waveform uses a completely separate `getUserMedia` + `AnalyserNode` pipeline from the PCM mic in `audio.ts`. Two independent `MediaStream`s from the same physical device. The `$effect` starts/stops based on `live.status` using Svelte 5's cleanup return (`return stopWaveform`). The second `getUserMedia` auto-grants — browsers don't re-prompt after first permission grant in the same page load. `startWaveform()` has a `.catch()` to silently degrade if permission is denied.
- **TTS injection sample rate** (`test-inject.ts`): The fake mic `AudioContext` runs at 16kHz. TTS (`speak()`) outputs 24kHz. Injecting 24kHz audio directly into a 16kHz context silently fails — no error, but no audio reaches the PCM worklet. `inject()` now auto-resamples via `OfflineAudioContext` when `sampleRate !== 16000`. IndexedDB replays are already 16kHz and skip resampling. Also: `inject()` is now `async` (returns `Promise<void>`) due to the resampling step.
- **TTS injection timing**: `speak()` takes ~10s round-trip. The Gemini preview model disconnects after ~5s of silence. Pre-generate TTS audio BEFORE clicking Start, cache on `window.__pregenAudio`, then inject immediately after `connected` appears.
- **Vite HMR doesn't propagate deep .ts changes**: Editing `tts-session.ts` (imported by `gemini.ts` → `data.svelte.ts` → `+page.svelte`) does NOT trigger HMR reload. The old module stays cached. For isolated testing via Chrome MCP, use `import('/src/path.ts?v=' + Date.now())` to cache-bust. For production, hard refresh (Cmd+Shift+R) is required.
- **Utterance recorder** (`recorder.ts`): Black-box getUserMedia tap — runs a parallel AudioWorklet (`recorder-proc`) alongside the app's `pcm-processor`. Both consume the same MediaStream independently. Auto-segments via `utterance-committed` CustomEvent emitted from `commitTurn()` in `data.svelte.ts` (1 line). Persists to IndexedDB via `recording-db.ts`. `setup()` is called from live `+page.svelte` on mount (before `startMic()`). Console: `window.__recorder.recordings`, `.segment()`, `.download(i)`. Recordings page at `/#/recordings` reads from same IndexedDB.

### TS backend gotchas (post-migration)

- **ContentBlock type unification**: `chat-types.ts` re-exports `ContentBlock` from `src/shared/types.ts`. The `tool_result.content` field is `string | JsonDict[]` (wider than the old client-only `string`). `buildToolResultMap` in `message-helpers.ts` stringifies array content. Any new code touching `tool_result.content` must handle both variants.
- **tsconfig isolation**: `tsconfig.app.json` includes only `src/client/**/*`. Importing from `src/shared/models.ts` (which uses Node `fs` APIs) in client code will fail — no `@types/node` in the browser context. Only pure-type imports from `src/shared/types.ts` work from client code. TypeScript follows imports automatically, so `src/shared/types.ts` doesn't need explicit inclusion.
- **Two build outputs in `dist/`**: `tsc` outputs `dist/server/` + `dist/shared/`, Vite outputs `dist/public/`. They coexist. `npm run build` runs both sequentially. Don't `rm -rf dist` between them.
- **Production static serving**: `npm start` auto-detects `dist/public/` via `import.meta.url` and serves it with `express.static()`. Works from both `src/server/` (tsx dev) and `dist/server/` (compiled prod) because the relative path `../../dist/public` resolves correctly from both locations. Hash routing (`/#/live`) means no SPA catch-all needed.
- **`.env` loading**: `cli.ts` has a zero-dep `.env` loader (~10 lines). Only sets vars not already in `process.env` — real env vars take precedence. Loaded before anything else in the CLI.
- **SDK type casts**: TS Agent SDK v0.2.56 uses `BetaMessage`/`BetaRawMessageStreamEvent` types. `claude-client.ts` uses `as unknown as Record<string, unknown>` casts to extract streaming deltas. May change in future SDK versions.
- **SDK error discrimination**: `SDKResultSuccess` has `result: string`, `SDKResultError` has `errors: string[]` (NOT `result`). Use `msg.is_error` + `'errors' in msg` to discriminate. Different from Python SDK.
- **Old Python backend**: Archived in `archive/reduck/` for reference. Not used at runtime.

## Locations & commands

- Session files: `~/.claude/projects/-{cwd-with-dashes}/{session-id}.jsonl`
- Production (single server): `npm run build && npm start` (port 8000, serves API + frontend)
- Dev (two servers): `npm run dev:server` (Express :8000) + `npm run dev:client` (Vite :5173)
- Dev (both at once): `npm run dev`
- No browser: `npm start -- --no-browser --port 8001`
- Type-check: `npm run check` (server + client)
- Test (real): `curl -s -N -X POST http://localhost:8000/api/converse -H 'Content-Type: application/json' -d '{"instruction":"say hello","model":"sonnet","system_prompt":"Be concise.","permission_mode":"plan"}'`

## Testing

### Backend testing

**Bash tool stdout is unreliable for HTTP requests to the backend.** curl and python urllib produce correct responses but the Bash tool swallows stdout. Always write to a file and cat after:

```bash
# Quick test (write to file, then read)
python3 -c "
import urllib.request, json
req = urllib.request.Request(
    'http://localhost:8000/api/converse',
    data=json.dumps({'instruction': 'say hello', 'model': 'sonnet', 'system_prompt': 'Be concise.', 'permission_mode': 'plan'}).encode(),
    headers={'Content-Type': 'application/json'},
)
with urllib.request.urlopen(req, timeout=60) as r:
    with open('/tmp/api_test.txt', 'w') as f:
        f.write(r.read().decode())
" ; cat /tmp/api_test.txt
```

Or use **Claude in Chrome** `javascript_tool` with `fetch()` — browser stdout works fine.

**`npm run dev:server` uses `tsx` (no hot-reload).** Changes to any `src/server/` or `src/shared/` file require killing and restarting the server process.

### E2E testing (Claude in Chrome)

**Prerequisite**: Claude in Chrome MCP tools (`mcp__claude-in-chrome__*`) must be available. If they are not, tell the user to restart with `claude --chrome` to enable browser automation.

**Key tools**: `tabs_context_mcp` (get tab IDs), `tabs_create_mcp` (new tab), `navigate` (go to URL), `javascript_tool` (execute JS), `computer` (click/screenshot), `find` (locate elements), `read_page` (a11y tree), `read_console_messages` (console output). All take a `tabId` parameter — multiple tabs can be automated in parallel.

**`javascript_tool` does NOT support top-level `await`**. Wrap all async code in an IIFE:
```js
// WRONG — SyntaxError
const { setup } = await import('/src/lib/test-inject.ts');

// RIGHT — async IIFE
(async () => {
  const { setup } = await import('/src/lib/test-inject.ts');
  setup();
  return 'done';
})()
```

**Programmatic audio injection** — no mic needed:
> Uses `test-inject.ts` module to inject audio into a fake mic stream.
> Primary method is **TTS** via `speak()`. Auto-resamples 24kHz→16kHz internally.
>
> 1. `tabs_context_mcp` → get existing tabs, then `tabs_create_mcp` if needed to get a `tabId`
> 2. `navigate` with `tabId` + `url: "http://localhost:5173/#/live"`
> 3. `javascript_tool`: setup fake mic AND pre-generate TTS audio (BEFORE clicking Start — `speak()` takes ~10s, Gemini disconnects after ~5s idle)
>    ```js
>    (async () => {
>      const { setup } = await import('/src/lib/test-inject.ts');
>      setup();
>      const { speak } = await import('/src/lib/tts.ts');
>      const key = JSON.parse(localStorage.getItem('claude-talks:ui') || '{}').apiKey;
>      const { data, sampleRate } = await speak(key, 'What is the latest commit?');
>      window.__pregenAudio = { data, sampleRate };
>      return 'setup + TTS ready';
>    })()
>    ```
> 4. Click the mic orb (use `find` to locate it, then `computer` to click). Wait for `connected` via `read_console_messages` with `pattern: "connected"`.
> 5. `javascript_tool`: inject the pre-generated audio immediately
>    ```js
>    (async () => {
>      const { inject } = await import('/src/lib/test-inject.ts');
>      await inject(window.__pregenAudio.data, window.__pregenAudio.sampleRate);
>      return 'injected';
>    })()
>    ```
> 6. Verify via `read_console_messages`: `[test] injected N samples` → `tool call: converse` → `TTFT: Nms`
>
> **Critical**: `setup()` must run BEFORE clicking Start — the getUserMedia override must be in place when the app first calls it.
> **Critical**: Pre-generate TTS BEFORE connecting — `speak()` latency races against Gemini's ~5s idle disconnect.
> **VAD only**: injection relies on VAD to detect end-of-speech from silence.
>
> **Legacy: IndexedDB replay** (deprecated, still works): `injectFromDB(index)` replays previously recorded utterances from IndexedDB. Free and instant but limited to whatever was recorded in past sessions. Use `listReplays()` to see available recordings.

## Instructions

Read, digest then ask me questions if needed.
