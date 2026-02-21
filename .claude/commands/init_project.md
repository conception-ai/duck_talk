# Role

You are a world class software engineer.
Your code must be clean, minimalist and easy to read.

## Files to read at all times

| File | Purpose |
|------|---------|
| @models.py | Session JSONL schema |
| @watcher.py | File monitor |
| @claude_client.py | Claude Code SDK wrapper (isolated subprocess) |
| @api/server.py | FastAPI backend — SSE streaming + sentence buffering + `GET /api/sessions/{id}/messages` (faithful content blocks) + `POST /api/sessions/{id}/back` (rewind) |
| @vibecoded_apps/CLAUDE.md | Svelte app conventions |
| @vibecoded_apps/claude_talks/src/routes/home/+page.svelte | Home page — session list, fetches `GET /api/sessions`, navigates to `/live/:id` |
| @vibecoded_apps/claude_talks/src/App.svelte | Router — `/` → HomePage, `/live` → LivePage, `/live/:id` → LivePage (with session), `/recordings` → RecordingsPage |
| @vibecoded_apps/claude_talks/src/routes/live/+page.svelte | Gemini Live — 3-item header (Home, title, Settings gear), messages area, mic orb (bottom center, tap to start/stop, CSS pulse when connected), unified Settings modal (API key, voice, mode, model, prompt). Loads history on mount, renders `messages[]` + `voiceLog[]` + pending overlays |
| @vibecoded_apps/claude_talks/src/routes/live/types.ts | Port interfaces (DataStoreMethods with `back()`, AudioPort, LiveBackend, ConverseApi with `abort()`, RealtimeInput) + CC message types (`ContentBlock`, `Message`, `VoiceEvent`) + `InteractionMode` (`'direct' \| 'review' \| 'correct'`) + correction types (STTCorrection, PendingApproval) |
| @vibecoded_apps/claude_talks/src/routes/live/stores/data.svelte.ts | Data store — two-array model: `messages[]` (CC conversation, mutable) + `voiceLog[]` (ephemeral, append-only). `loadHistory()`, `back()`, session lifecycle, audio buffer, approval flow |
| @vibecoded_apps/claude_talks/src/routes/live/stores/ui.svelte.ts | UI store — persistent user prefs (voiceEnabled, apiKey, mode: InteractionMode, model, systemPrompt). `setMode()` sets mode directly. `load()` merges localStorage with `DEFAULTS` so new fields get populated. Migrates old `learningMode: boolean` on load |
| @vibecoded_apps/claude_talks/src/routes/live/stores/corrections.svelte.ts | Corrections store — localStorage-persisted STT corrections |
| @vibecoded_apps/claude_talks/src/routes/live/gemini.ts | Gemini Live connection + message handling. 3-way mode branching (direct/review/correct) in tool call handler. No correction logic in Gemini layer — corrections are handled externally via `correctInstruction` dep |
| @vibecoded_apps/claude_talks/src/routes/live/correct.ts | Stateless LLM auto-correction — `correctInstruction(llm, instruction, corrections)`. Text-only today, planned: multimodal with audio (see `roadmap/todos/correction_llm_accuracy.md`) |
| @vibecoded_apps/claude_talks/src/routes/live/converse.ts | SSE stream consumer for /api/converse. Has `AbortController` + `abort()` method for cancelling in-flight streams (used by `back()`) |
| @vibecoded_apps/claude_talks/src/routes/live/audio.ts | Browser audio I/O |
| @vibecoded_apps/claude_talks/src/routes/live/tools.ts | Gemini function declarations (`accept_instruction`, `converse`) + handlers |
| @vibecoded_apps/claude_talks/src/lib/llm.ts | LLM abstraction — `createLLM({ apiKey })` → callable with `.stream()`, `.json<T>()`. Supports multimodal: `Message.content` accepts `string` or `Part[]` (text + `inlineData` for audio/images) |
| @vibecoded_apps/claude_talks/src/lib/stt.ts | Pure audio utilities — `combineChunks` (merge base64 PCM), `chunksToWav` (PCM → WAV). No LLM dependency |
| @vibecoded_apps/claude_talks/src/lib/recording-db.ts | IndexedDB CRUD for utterance recordings — `saveRecording`, `getAllRecordings`, `deleteRecording`, `clearAllRecordings` |
| @vibecoded_apps/claude_talks/src/lib/recorder.ts | Black-box utterance recorder — taps `getUserMedia` to capture mic audio, auto-segments on `utterance-committed` CustomEvents, persists to IndexedDB. Setup called from live `+page.svelte` on mount. Console access via `window.__recorder` |
| @vibecoded_apps/claude_talks/src/routes/recordings/+page.svelte | Recordings browser — reads from IndexedDB, lists utterances with play/download/delete buttons. Route: `/#/recordings` |

## Files to read if needed

| File | Purpose |
|------|---------|
| docs/gemini-live-docs.md | Gemini Live API reference — capabilities, VAD config, function calling, session management |
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
- **Function calling**: `tools.ts` declares `TOOLS` (uses `Type` enum from SDK) + `handleToolCall()` (pure fetch). The `converse` tool is `NON_BLOCKING` + `SILENT` response — Gemini speaks an acknowledgment while Claude streams in the background. Chunks are fed back via `sendClientContent` so Gemini reads them aloud. The handler lives in `gemini.ts` (not `tools.ts`) because it needs the session ref.
- **`accept_instruction` is a meta-tool** (`gemini.ts`): Unlike `converse`, it acts on existing state — it calls `data.approve()` to accept the pending converse instruction. Critical: it MUST skip `startTool()` (would overwrite the pending `converse` tool) and sends a plain blocking response. `approve()` is on both the public store surface (UI button) and `DataStoreMethods` port (voice tool) — same function, no divergence, race-safe (second call is a no-op via `if (!pendingApproval) return` guard).
- **Gemini disconnect handling** (`gemini.ts`): `closed` flag is hoisted to outer scope (next to `sessionRef`) so the `onclose` callback can reach it. On unexpected Gemini crash: `onclose` sets `closed = true` (guards all sends), resets `conversePhase = 'idle'`, clears `sessionRef`, and shows a toast via `pushError()`. On user-initiated `stop()`: `backend.close()` sets `closed = true` first, so `onclose` detects `wasExpected = closed` and skips the toast. Claude's converse stream continues rendering text even after Gemini dies — only TTS relay is lost. The preview model (`gemini-2.5-flash-native-audio-preview`) can drop with "Internal error occurred" at any time — this is Gemini infra instability, not a client bug (confirmed by replay: same audio succeeds on retry).
- **Converse phase gating** (`gemini.ts`): A `conversePhase` state machine (`idle` → `suppressing` → `relaying` → `idle`) gates both audio and text during converse. Key non-obvious timing: Gemini sends "Asking Claude" audio/text BEFORE the `toolCall` message arrives, so the ack naturally passes through while `conversePhase` is still `idle`. After the tool call, `suppressing` blocks Gemini's own audio + flushes the player. On first `sendClientContent` (Claude chunk), `relaying` re-enables audio (Gemini reads Claude aloud) but keeps blocking `outputTranscription` (the `[CLAUDE]:` echo is noise — Claude's text is already in `pendingTool.text` via `appendTool`). `holdForApproval` takes an optional `cancel` callback to reset the phase on reject.
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
  - **`review`** — single-stage approval: user sees instruction, Accept/Edit/Reject. If user edits, the diff is saved as a correction in `corrections.svelte.ts`. Acceptance can come from UI button OR Gemini's `accept_instruction` tool (voice).
  - **`correct`** — LLM auto-corrects instruction via `correct.ts`, then shows single-stage approval with the corrected text. `rawInstruction` on `PendingApproval` tracks the original for correction bookkeeping.
  - No correction logic in Gemini layer — corrections are purely external via the stateless LLM call in `correct.ts`.
  - `snapshotUtterance()` must still be called BEFORE `commitTurn()` in `gemini.ts` — it captures audio buffer. `commitTurn()` clears `audioBuffer`.
  - Audio/text suppression during converse is handled by `conversePhase` in `gemini.ts` (not in the store). See **Converse phase gating** above.
  - Approval UI is in the pending tool bubble (not user turn bubble). Shows `pendingApproval.instruction` (corrected) when approval is active, falls back to `pendingTool.args.instruction` when streaming.
- **LLM correction timing** (`correct` mode): the `correctInstruction` call fires synchronously when the tool call arrives, but it's async (~2s round-trip to Gemini Flash). During those 2s the user sees a pending tool with no approval buttons. Gemini sends `turnComplete` during this window. The `.then()` callback in `gemini.ts:210` is where `holdForApproval` finally gets called. On LLM error, falls back to uncorrected instruction.
- **`correctInstruction` DI closure** (`+page.svelte:28-32`): the closure creates `createLLM({ apiKey })` on each call. This is safe — `llm.ts` caches clients by API key internally (`getClient()`). The closure also reads `corrections.corrections` at call time (not creation time), so corrections added mid-session are picked up.
- **UI layout** (`+page.svelte`): Header has 3 items: Home | Gemini Live | Settings (gear). Mic orb at bottom center — grey when idle (tap to start), green with CSS pulse rings when connected (tap to stop). Always VAD, no PTT. Settings modal consolidates: API key, voice on/off, mode, model, system prompt, corrections link. Auto-opens on first visit if no API key.
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
