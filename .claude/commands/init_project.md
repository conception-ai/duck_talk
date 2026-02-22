# Role

You are a world class software engineer.
Your code must be clean, minimalist and easy to read.

## Files to read at all times

| File | Purpose |
|------|---------|
| @models.py | Session JSONL schema, `fork_session()` (rewind by creating truncated JSONL), `Conversation` loader |
| @claude_client.py | Claude Code SDK wrapper (isolated subprocess) |
| @api/server.py | FastAPI backend — SSE streaming, `GET /api/sessions/{id}/messages` (faithful content blocks), `POST /api/converse` (forks session on `leaf_uuid` for rewind) |
| @vibecoded_apps/CLAUDE.md | Svelte app conventions |
| @vibecoded_apps/claude_talks/src/routes/home/+page.svelte | Home page — session list, fetches `GET /api/sessions`, navigates to `/live/:id` |
| @vibecoded_apps/claude_talks/src/App.svelte | Router — `/` → HomePage, `/live` → LivePage, `/live/:id` → LivePage (with session), `/recordings` → RecordingsPage |
| @vibecoded_apps/claude_talks/src/routes/live/+page.svelte | Gemini Live — header (Home, Settings), messages area, mic orb (bottom center, tap to start/stop, CSS pulse when connected), unified Settings modal (API key, readback, mode, model, permission mode, prompt). Loads history on mount, renders `messages[]` + `voiceLog[]` + pending overlays |
| @vibecoded_apps/claude_talks/src/routes/live/types.ts | Port interfaces (DataStoreMethods with `back()`, AudioPort, LiveBackend, ConverseApi with `abort()`, StreamingTTS, RealtimeInput) + CC message types (`ContentBlock`, `Message`, `VoiceEvent`) + `InteractionMode` (`'direct' \| 'review' \| 'correct'`) + correction types (STTCorrection, PendingApproval) |
| @vibecoded_apps/claude_talks/src/routes/live/stores/data.svelte.ts | Data store — two-array model: `messages[]` (CC conversation, mutable) + `voiceLog[]` (ephemeral, append-only). `loadHistory()`, `back()`, session lifecycle, audio buffer, approval flow. No player lifecycle — TTS session owns its own player |
| @vibecoded_apps/claude_talks/src/routes/live/stores/ui.svelte.ts | UI store — persistent user prefs (apiKey, mode: InteractionMode, model, systemPrompt, readbackEnabled, permissionMode). `setMode()` sets mode directly. `load()` merges localStorage with `DEFAULTS` so new fields get populated. Migrates old `learningMode: boolean` on load |
| vibecoded_apps/claude_talks/src/routes/live/stores/corrections.svelte.ts | Corrections store — localStorage-persisted STT corrections |
| @vibecoded_apps/claude_talks/src/routes/live/gemini.ts | Gemini Live connection + message handling (STT + VAD + orchestration only — no TTS). `converse` tool is BLOCKING — Gemini freezes, tool response sent immediately as `{ result: "done" }` (no Claude text → no context contamination). Opens ephemeral TTS session via `openTTSSession()`, feeds Claude chunks to it. `activeTTS` ref enables interrupt (close TTS + abort Claude SSE). `holdWithVoice` wires voice approval during BLOCKING hold. `approvalPending` gates `sendRealtimeInput` |
| @vibecoded_apps/claude_talks/src/routes/live/tts-session.ts | Ephemeral TTS module — self-contained Gemini Live session that speaks Claude's text. Owns its own connection, sentence buffer, queue-based sender, and audio player. One instance per converse call. `send(text)` / `finish()` / `close()` interface. Queue drains one batch at a time on `turnComplete` to avoid mid-sentence cuts |
| vibecoded_apps/claude_talks/src/routes/live/correct.ts | Stateless LLM auto-correction — `correctInstruction(llm, instruction, corrections)`. Text-only today, planned: multimodal with audio (see `roadmap/todos/correction_llm_accuracy.md`) |
| @vibecoded_apps/claude_talks/src/routes/live/converse.ts | SSE stream consumer for /api/converse. Has `AbortController` + `abort()` method for cancelling in-flight streams (used by `back()`) |
| @vibecoded_apps/claude_talks/src/routes/live/audio.ts | Browser audio I/O |
| @vibecoded_apps/claude_talks/src/routes/live/tools.ts | Gemini function declarations (`converse` — BLOCKING, no behavior override) + handlers |
| @vibecoded_apps/claude_talks/src/routes/live/buffer.ts | Sentence-boundary text buffer — `createSentenceBuffer(onFlush, { minChars, maxWaitMs })`. Accumulates streaming text, flushes at sentence boundaries (`. ` `! ` `? `) when >= minChars accumulated. Timer fallback for text without punctuation |
| vibecoded_apps/claude_talks/src/routes/live/voice-approval.ts | Browser `webkitSpeechRecognition` wrapper — listens for accept/reject keywords during BLOCKING approval holds. `startVoiceApproval(onAccept, onReject)` → returns `stop()` handle |
| vibecoded_apps/claude_talks/src/lib/llm.ts | LLM abstraction — `createLLM({ apiKey })` → callable with `.stream()`, `.json<T>()`. Supports multimodal: `Message.content` accepts `string` or `Part[]` (text + `inlineData` for audio/images) |
| vibecoded_apps/claude_talks/src/lib/stt.ts | Pure audio utilities — `combineChunks` (merge base64 PCM), `chunksToWav` (PCM → WAV). No LLM dependency |
| vibecoded_apps/claude_talks/src/lib/recording-db.ts | IndexedDB CRUD for utterance recordings — `saveRecording`, `getAllRecordings`, `deleteRecording`, `clearAllRecordings` |
| vibecoded_apps/claude_talks/src/lib/recorder.ts | Black-box utterance recorder — taps `getUserMedia` to capture mic audio, auto-segments on `utterance-committed` CustomEvents, persists to IndexedDB. Setup called from live `+page.svelte` on mount. Console access via `window.__recorder` |
| vibecoded_apps/claude_talks/src/routes/recordings/+page.svelte | Recordings browser — reads from IndexedDB, lists utterances with play/download/delete buttons. Route: `/#/recordings` |

## Files to read if needed

| File | Purpose |
|------|---------|
| docs/gemini-live-docs.md | Gemini Live API reference — capabilities, VAD config, function calling, session management |
| docs/claude_code_python_sdk.md | Claude Agent SDK reference — `ClaudeAgentOptions`, `ClaudeSDKClient`, `query()`. No leaf/branch control exists; `resume` is session ID only |
| @vibecoded_apps/claude_talks/src/lib/tts.ts | Test-only TTS utility — `speak(apiKey, text)` → base64 PCM at 24kHz via Gemini TTS. Dynamically imported by Claude in Chrome test scripts (`import('/src/lib/tts.ts')`), never imported by production code |

## Guiding Principles

- **Clean data flows**: Raw signals (STT chunks, VAD events) must be merged into clean domain objects at the store level. Consumers (UI, corrections, API calls) should never reconstruct or re-derive from raw data. Fix the source, not each consumer. Leverage Svelte's reactivity: one clean `$state` → many `$derived` readers.

## Gotchas

- **Two-array data model** (`data.svelte.ts`): State is split into two arrays with different lifecycles:
  - `messages: Message[]` — CC conversation only. Persistent (loaded from backend, appended during converse, truncated on "back"). 1:1 with `models.py` content blocks. `commitTurn()` routes converse tool results here.
  - `voiceLog: VoiceEvent[]` — user speech + Gemini speech + errors. Append-only, session-local, lost on page reload. `commitTurn()` routes `pendingInput`/`pendingOutput` here. `pushError()` also goes here.
  - **Why**: "go back" pops from `messages[]` but leaves `voiceLog[]` untouched. Can't do this cleanly with one interleaved array.
- **Message quality levels**: `messages[]` has two fidelity levels depending on source:
  - **Loaded from backend** (`GET /api/sessions/{id}/messages`): full content blocks — `text`, `thinking`, `tool_use`, `tool_result`, `image`.
  - **Appended during live session** (from SSE stream): degraded — only `[{ type: 'text', text: flatText }]`. The SSE endpoint returns `{text: "..."}` chunks, not structured blocks.
  - Both render fine. When user navigates away and returns, history reload gives full fidelity.
- **`walk_path()` returns leaf-to-root order**: `Conversation.walk_path(leaf_uuid)` returns `[leaf, ..., root]`. Must `.reverse()` for display. The backend `GET /messages` endpoint handles this.
- **CLI ignores `SummaryEntry.leafUuid`** (proven experimentally): When resuming with `--resume <session_id>`, the CLI always picks the deepest leaf in the tree, NOT the `leafUuid` from a `SummaryEntry`. `Conversation.active_leaf` matches this behavior (just deepest leaf). The only way to rewind is `fork_session()`: create a new JSONL with only the path entries up to the target message, then resume THAT session. The frontend auto-adopts the new `session_id` from the done event (`converse.ts:103`).
- **Backend serialization — no wrapper model**: `AssistantEntry.message.content` is `list[ContentBlock]` (pydantic models). Just call `.model_dump(exclude_none=True)` on each block — naturally produces the right JSON. `UserEntry.message.content` (`str | list[JsonDict]`) returned as-is.
- **`back()` abort race condition** (`data.svelte.ts`): `api.abort()` is sync but the AbortError fires on the next microtask. The error callback in `gemini.ts` calls `finishTool()` which could commit partial results. Solution: `back()` clears `pendingTool = null` BEFORE the await, so `finishTool()` short-circuits when the async error arrives.
- **Gemini Live**: use `types.LiveConnectConfig` + `types.Modality.AUDIO` (not raw dicts). `model_turn.parts` can be `None`. File input needs chunking + `audio_stream_end=True`.
- **Audio format split**: Gemini Live (`sendRealtimeInput`) accepts raw PCM (`audio/pcm;rate=16000`). `generateContent` does NOT — it needs a proper container format (WAV, MP3, etc.). Use `chunksToWav()` from `stt.ts` to wrap PCM before passing to `llm()`. Confirmed by experiment: raw PCM → hallucinated output; WAV → correct transcription.
- **Two injection channels** (`gemini.ts`): A Gemini Live session has two ways to send data — they can be used simultaneously on the same session.
  - `sendRealtimeInput` — **live audio stream**. Subject to VAD (auto-detects speech start/stop). Best-effort ordering. Use for: mic audio.
  - `sendClientContent` — **structured context injection**. No VAD. Deterministic ordering. Model responds only if `turnComplete: true`. Use for: prefilling context, feeding Claude text back. Audio `inlineData` parts work here (undocumented but confirmed). `turnComplete: true` crashes if sent before any audio has flowed — use `turnComplete: false` for context prefilling.
  - Ordering is guaranteed *within* each channel but *not across* them. Already mixed in practice: mic streams via `sendRealtimeInput` while Claude chunks are injected via `sendClientContent`.
- **`inputTranscription` / `outputTranscription`** — confusingly named. Both are **server-sent events** (Gemini pushes them to you). "input" = transcription of the **user's** mic audio (from `sendRealtimeInput`). "output" = transcription of **Gemini's own** spoken response.
  - `inputTranscription` is produced by a separate ASR pipeline that does not read the model's context window. `sendClientContent` (text or audio) does not change it.
  - `sendClientContent` with `turnComplete: true` as the first message → **disconnects** ("Request contains an invalid argument."). Use `turnComplete: false` for prefilling.
- **BLOCKING converse + immediate tool response** (`gemini.ts`): The `converse` tool is BLOCKING — Gemini freezes entirely (no audio, no text) when it calls the tool. The tool response is sent immediately as `{ result: "done" }` — no Claude text is sent back to the main session, eliminating context contamination. A separate ephemeral TTS session (`tts-session.ts`) handles audio output independently.
- **`approvalPending` gates `sendRealtimeInput`** (`gemini.ts`): During BLOCKING approval holds, mic audio is gated off from the frozen Gemini session. Without this, audio would buffer server-side and replay as a phantom utterance after unfreezing. One-line gate in the `LiveBackend` handle.
- **Voice approval during BLOCKING** (`voice-approval.ts` + `gemini.ts`): Since Gemini is frozen during approval (can't hear the user), `webkitSpeechRecognition` takes over as a lightweight keyword listener. `holdWithVoice()` in `gemini.ts` starts it alongside `holdForApproval`, stops it on resolve. A `resolved` boolean guards against double-fire (voice says "accept" at the same instant user clicks Accept button → only one fires). Voice calls `data.approve()` / `data.reject()` — same store methods the UI buttons use.
- **Gemini disconnect handling** (`gemini.ts`): `closed` flag is hoisted to outer scope (next to `sessionRef`) so the `onclose` callback can reach it. On unexpected Gemini crash: `onclose` sets `closed = true` (guards all sends), closes `activeTTS`, clears `sessionRef`, and shows a toast via `pushError()`. On user-initiated `stop()`: `backend.close()` sets `closed = true` first, so `onclose` detects `wasExpected = closed` and skips the toast. Claude's converse stream continues rendering text even after Gemini dies — only TTS is lost. The preview model (`gemini-2.5-flash-native-audio-preview`) can drop with "Internal error occurred" at any time — this is Gemini infra instability, not a client bug (confirmed by replay: same audio succeeds on retry).
- **TTS session architecture** (`tts-session.ts`): Ephemeral Gemini Live session opened per converse call. Fully self-contained — owns its own `GoogleGenAI` connection, `createSentenceBuffer`, queue-based sender, and `createPlayer`. Non-obvious behaviors discovered experimentally:
  - **`turnComplete:false` does NOT trigger audio** — audio only starts after `turnComplete:true`. Accumulating all text with `turnComplete:false` then sending `true` at the end is batch TTS, not streaming.
  - **`turnComplete:true` without prior `sendRealtimeInput` audio works fine** — the gotcha about crashing without prior audio does NOT apply to TTS-only sessions (tested).
  - **Multiple `turnComplete:true` during an active turn get merged** — Gemini treats queued sends as one big turn. Sending a new batch while a previous one is speaking creates a ~4-6s gap.
  - **Queue-based sending is critical** — send first sentence-buffer flush immediately with `turnComplete:true`, queue subsequent flushes, drain one at a time on `turnComplete` from TTS. This produces ~1.7s natural pauses at sentence boundaries instead of mid-sentence cuts.
  - **Sentence-boundary splitting matters** — time-based splitting (1s buffer) cuts mid-sentence ("FastAPI" [gap] "with SSE streaming"). Sentence-boundary splitting (`. ` `! ` `? ` after >=80 chars) sounds natural.
  - **Connect latency is ~35-57ms** — opening per converse call is fine, no need to pool.
  - **First-audio latency is ~1.5s** consistently from `sendClientContent(turnComplete:true)` to first `inlineData` audio chunk.
  - **`finish()` vs `close()`**: `finish()` flushes remaining buffer and lets audio drain naturally (closes on last `turnComplete`). `close()` is immediate teardown for interrupts — clears queue, flushes player, closes session.
- **Svelte app**: Gemini API key is stored client-side in `localStorage` (`claude-talks:ui`), managed via unified Settings modal in `+page.svelte`. Flows through DI: `ui.apiKey` → `data.svelte.ts` (`getApiKey` dep) → `gemini.ts` (`ConnectDeps.apiKey`). Settings modal auto-opens on first visit if no key is set.
- **Claude SDK isolation**: The SDK subprocess must be fully isolated from the parent Claude Code session. Three layers:
  1. `os.environ.pop("CLAUDECODE", None)` at import time — prevents "nested session" error
  2. `cli_path` → `~/.claude-sdk/cli/node_modules/.bin/claude` — separate binary
  3. `env={"CLAUDE_CONFIG_DIR": "~/.claude-sdk"}` — separate config/creds
  4. `cwd` → temp dir — separate working directory
- **SDK setup** (one-time): `npm install @anthropic-ai/claude-code --prefix ~/.claude-sdk/cli` then `CLAUDECODE= CLAUDE_CONFIG_DIR=~/.claude-sdk ~/.claude-sdk/cli/node_modules/.bin/claude login`
- **SDK client lifetime**: `ClaudeSDKClient` goes stale after the first `receive_response()` — the second `query()` hangs forever. Use the standalone `query()` function instead, with `resume=session_id` (captured from `ResultMessage.session_id`) to maintain conversation across calls. Each call spawns a fresh subprocess but resumes the same session.
- **SDK cwd constraint**: Setting `cwd` to a path inside `~/.claude/` causes the SDK subprocess to hang (observed, root cause unknown). This affects any project located under the Claude config directory, not just this one. Workaround: use a temp dir or a path outside `~/.claude/`.
- **Interaction mode** (`ui.svelte.ts`): 3-way mode selector in Settings modal — `direct`, `review`, `correct`. Persisted in localStorage (`claude-talks:ui` as `mode`).
  - **`direct`** — tool calls execute immediately, no approval UI.
  - **`review`** — single-stage approval: user sees instruction, Accept/Edit/Reject. If user edits, the diff is saved as a correction in `corrections.svelte.ts`. Acceptance can come from UI button OR voice (`webkitSpeechRecognition` via `voice-approval.ts`).
  - **`correct`** — LLM auto-corrects instruction via `correct.ts`, then shows single-stage approval with the corrected text. `rawInstruction` on `PendingApproval` tracks the original for correction bookkeeping.
  - No correction logic in Gemini layer — corrections are purely external via the stateless LLM call in `correct.ts`.
  - `snapshotUtterance()` must still be called BEFORE `commitTurn()` in `gemini.ts` — it captures audio buffer. `commitTurn()` clears `audioBuffer`.
  - Main session audio is fully ignored (no player, no `outputTranscription` handler). TTS session handles all audio output independently.
  - Approval UI is in the pending tool bubble (not user turn bubble). Shows `pendingApproval.instruction` (corrected) when approval is active, falls back to `pendingTool.args.instruction` when streaming.
- **LLM correction timing** (`correct` mode): the `correctInstruction` call fires synchronously when the tool call arrives, but it's async (~2s round-trip to Gemini Flash). During those 2s the user sees a pending tool with no approval buttons. Gemini sends `turnComplete` during this window. The `.then()` callback in `gemini.ts:210` is where `holdForApproval` finally gets called. On LLM error, falls back to uncorrected instruction.
- **`correctInstruction` DI closure** (`+page.svelte:28-32`): the closure creates `createLLM({ apiKey })` on each call. This is safe — `llm.ts` caches clients by API key internally (`getClient()`). The closure also reads `corrections.corrections` at call time (not creation time), so corrections added mid-session are picked up.
- **UI layout** (`+page.svelte`): Header: Home | Settings. Mic orb at bottom center — grey when idle (tap to start), green with CSS pulse rings when connected (tap to stop). Always VAD, no PTT. Settings modal consolidates: API key, readback, mode, permission mode, model, system prompt, corrections link. Auto-opens on first visit if no API key.
- **Utterance recorder** (`recorder.ts`): Black-box getUserMedia tap — runs a parallel AudioWorklet (`recorder-proc`) alongside the app's `pcm-processor`. Both consume the same MediaStream independently. Auto-segments via `utterance-committed` CustomEvent emitted from `commitTurn()` in `data.svelte.ts` (1 line). Persists to IndexedDB via `recording-db.ts`. `setup()` is called from live `+page.svelte` on mount (before `startMic()`). Console: `window.__recorder.recordings`, `.segment()`, `.download(i)`. Recordings page at `/#/recordings` reads from same IndexedDB.

## Locations & commands

- Session files: `~/.claude/projects/-{cwd-with-dashes}/{session-id}.jsonl`
- Svelte app: `cd vibecoded_apps/claude_talks && npm run dev` (port 5000)
- Watcher CLI: `python -m claude_talks.watcher /path/to/session.jsonl --handler log`
- Backend: `uvicorn api.server:app --port 8000 --reload`
- Test (mock, no credits): `curl -s -N -X POST http://localhost:8000/api/converse/test -H 'Content-Type: application/json' -d '{"instruction":"test"}'`
- Test (real): `curl -s -N -X POST http://localhost:8000/api/converse -H 'Content-Type: application/json' -d '{"instruction":"say hello"}'`

## Testing

### Backend testing

**Bash tool stdout is unreliable for HTTP requests to the backend.** curl and python urllib produce correct responses but the Bash tool swallows stdout. Always write to a file and cat after:

```bash
# Quick test (write to file, then read)
python3 -c "
import urllib.request, json
req = urllib.request.Request(
    'http://localhost:8000/api/converse',
    data=json.dumps({'instruction': 'say hello'}).encode(),
    headers={'Content-Type': 'application/json'},
)
with urllib.request.urlopen(req, timeout=60) as r:
    with open('/tmp/api_test.txt', 'w') as f:
        f.write(r.read().decode())
" ; cat /tmp/api_test.txt
```

Or use **Claude in Chrome** `javascript_tool` with `fetch()` — browser stdout works fine.

**`uvicorn --reload` doesn't reload transitive imports.** If you change `claude_client.py` (or any module imported by `server.py`), you must kill and restart the server process. `--reload` only re-imports the entry module.

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
> Two injection sources: **replay from IndexedDB** (free, instant, real audio) or **TTS** (costs API credits, synthetic).
>
> 1. `tabs_context_mcp` → get existing tabs, then `tabs_create_mcp` if needed to get a `tabId`
> 2. `navigate` with `tabId` + `url: "http://localhost:5000/#/live"`
> 3. `javascript_tool`: setup fake mic + list available replays (BEFORE clicking Start)
>    ```js
>    (async () => {
>      const { setup, listReplays } = await import('/src/lib/test-inject.ts');
>      setup();
>      return JSON.stringify(await listReplays());
>    })()
>    ```
> 4. Click the mic orb (use `find` to locate it, then `computer` to click). Wait for `[live] connected` via `read_console_messages` with `pattern: "connected"`.
> 5. `javascript_tool`: inject — **Option A: replay from IndexedDB** (preferred)
>    ```js
>    (async () => {
>      const { injectFromDB } = await import('/src/lib/test-inject.ts');
>      return await injectFromDB(0); // returns transcript
>    })()
>    ```
>    **Option B: TTS** (when no recordings exist or need specific text)
>    ```js
>    (async () => {
>      const { inject } = await import('/src/lib/test-inject.ts');
>      const { speak } = await import('/src/lib/tts.ts');
>      const key = JSON.parse(localStorage.getItem('claude-talks:ui') || '{}').apiKey;
>      const { data, sampleRate } = await speak(key, 'What are my todos in the todos folder? OVER.');
>      inject(data, sampleRate);
>      return 'injected';
>    })()
>    ```
> 6. Verify via `read_console_messages`: `[test] injected N samples` → `tool call: converse` → `TTFT: Nms`
>
> **Critical**: `setup()` must run BEFORE clicking Start — the getUserMedia override must be in place when the app first calls it.
> **VAD only**: injection relies on VAD to detect end-of-speech from silence.
> **Replays**: recordings are saved to IndexedDB automatically during live sessions (via `recorder.ts`). Use `listReplays()` to see what's available.
## Instructions

Read, digest then ask me questions if needed.
