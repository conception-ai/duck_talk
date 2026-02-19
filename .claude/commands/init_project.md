# Role

You are a world class software engineer.
Your code must be clean, minimalist and easy to read.

## Files to read

| File | Purpose |
|------|---------|
| @models.py | Session JSONL schema |
| @watcher.py | File monitor |
| @claude_client.py | Claude Code SDK wrapper (isolated subprocess) |
| @api/server.py | FastAPI backend — SSE streaming + sentence buffering |
| @vibecoded_apps/CLAUDE.md | Svelte app conventions |
| @vibecoded_apps/claude_talks/src/routes/live/+page.svelte | Gemini Live — browser client (DI wiring + thin render) |
| @vibecoded_apps/claude_talks/src/routes/live/types.ts | Port interfaces (DataStoreMethods, AudioPort, LiveBackend, ConverseApi, RealtimeInput) + correction types (STTCorrection, PendingApproval) |
| @vibecoded_apps/claude_talks/src/routes/live/stores/data.svelte.ts | Data store — reactive state + session lifecycle + audio buffer + approval flow |
| @vibecoded_apps/claude_talks/src/routes/live/stores/ui.svelte.ts | UI store — persistent user prefs (voiceEnabled, apiKey, learningMode, pttMode) |
| @vibecoded_apps/claude_talks/src/routes/live/stores/corrections.svelte.ts | Corrections store — localStorage-persisted STT corrections |
| @vibecoded_apps/claude_talks/src/routes/live/recorder.ts | Mic audio recorder — RecordedChunk type (reused for audio buffer) |
| @vibecoded_apps/claude_talks/src/routes/live/gemini.ts | Gemini Live connection + message handling + STT correction prompt injection |
| @vibecoded_apps/claude_talks/src/routes/live/converse.ts | SSE stream consumer for /api/converse |
| @vibecoded_apps/claude_talks/src/routes/live/audio.ts | Browser audio I/O |
| @vibecoded_apps/claude_talks/src/routes/live/models.ts | Shared types (SessionInfo) |
| @vibecoded_apps/claude_talks/src/routes/live/tools.ts | Gemini function declarations + handlers |
| @vibecoded_apps/claude_talks/src/lib/llm.ts | LLM abstraction — `createLLM({ apiKey })` → callable with `.stream()` and `.json<T>()` |
| @docs/gemini-live-docs.md | Gemini Live API reference — capabilities, VAD config, function calling, session management |

## Guiding Principles

- **Clean data flows**: Raw signals (STT chunks, VAD events) must be merged into clean domain objects at the store level. Consumers (UI, corrections, API calls) should never reconstruct or re-derive from raw data. Fix the source, not each consumer. Leverage Svelte's reactivity: one clean `$state` → many `$derived` readers.

## Gotchas

- **Gemini Live**: use `types.LiveConnectConfig` + `types.Modality.AUDIO` (not raw dicts). `model_turn.parts` can be `None`. File input needs chunking + `audio_stream_end=True`.
- **Two injection channels** (`gemini.ts`): A Gemini Live session has two ways to send data — they can be used simultaneously on the same session.
  - `sendRealtimeInput` — **live audio stream**. Subject to VAD (auto-detects speech start/stop). Best-effort ordering. Use for: mic audio.
  - `sendClientContent` — **structured context injection**. No VAD. Deterministic ordering. Model responds only if `turnComplete: true`. Use for: prefilling context, feeding Claude text back. Audio `inlineData` parts work here (undocumented but confirmed). `turnComplete: true` crashes if sent before any audio has flowed — use `turnComplete: false` for context prefilling.
  - Ordering is guaranteed *within* each channel but *not across* them. Already mixed in practice: mic streams via `sendRealtimeInput` while Claude chunks are injected via `sendClientContent`.
- **`inputTranscription` / `outputTranscription`** — confusingly named. Both are **server-sent events** (Gemini sends them to you as outputs). "input" = transcription of the **user's** mic audio. "output" = transcription of **Gemini's own** spoken response. `inputTranscription` comes from a **decoupled ASR pipeline** completely independent of the model's context window — system instructions, `sendClientContent` (text or audio), corrections — none of it reaches the ASR. Stateless black box: audio bytes in → text out. Confirmed experimentally: injecting audio examples via `sendClientContent` does NOT change `inputTranscription`.
- **Function calling**: `tools.ts` declares `TOOLS` (uses `Type` enum from SDK) + `handleToolCall()` (pure fetch). The `converse` tool is `NON_BLOCKING` + `SILENT` response — Gemini speaks an acknowledgment while Claude streams in the background. Chunks are fed back via `sendClientContent` so Gemini reads them aloud. The handler lives in `gemini.ts` (not `tools.ts`) because it needs the session ref.
- **Converse phase gating** (`gemini.ts`): A `conversePhase` state machine (`idle` → `suppressing` → `relaying` → `idle`) gates both audio and text during converse. Key non-obvious timing: Gemini sends "Asking Claude" audio/text BEFORE the `toolCall` message arrives, so the ack naturally passes through while `conversePhase` is still `idle`. After the tool call, `suppressing` blocks Gemini's own audio + flushes the player. On first `sendClientContent` (Claude chunk), `relaying` re-enables audio (Gemini reads Claude aloud) but keeps blocking `outputTranscription` (the `[CLAUDE]:` echo is noise — Claude's text is already in `pendingTool.text` via `appendTool`). `holdForApproval` takes an optional `cancel` callback to reset the phase on reject.
- **Svelte app**: Gemini API key is stored client-side in `localStorage` (`claude-talks:ui`), managed via modal in `ui.svelte.ts`. Flows through DI: `ui.apiKey` → `data.svelte.ts` (`getApiKey` dep) → `gemini.ts` (`ConnectDeps.apiKey`). Modal auto-opens on first visit if no key is set.
- **Claude SDK isolation**: The SDK subprocess must be fully isolated from the parent Claude Code session. Three layers:
  1. `os.environ.pop("CLAUDECODE", None)` at import time — prevents "nested session" error
  2. `cli_path` → `~/.claude-sdk/cli/node_modules/.bin/claude` — separate binary
  3. `env={"CLAUDE_CONFIG_DIR": "~/.claude-sdk"}` — separate config/creds
  4. `cwd` → temp dir — separate working directory
- **SDK setup** (one-time): `npm install @anthropic-ai/claude-code --prefix ~/.claude-sdk/cli` then `CLAUDECODE= CLAUDE_CONFIG_DIR=~/.claude-sdk ~/.claude-sdk/cli/node_modules/.bin/claude login`
- **SDK client lifetime**: `ClaudeSDKClient` goes stale after the first `receive_response()` — the second `query()` hangs forever. Use the standalone `query()` function instead, with `resume=session_id` (captured from `ResultMessage.session_id`) to maintain conversation across calls. Each call spawns a fresh subprocess but resumes the same session.
- **SDK cwd constraint**: Setting `cwd` to a path inside `~/.claude/` causes the SDK subprocess to hang (observed, root cause unknown). This affects any project located under the Claude config directory, not just this one. Workaround: use a temp dir or a path outside `~/.claude/`.
- **Learning mode**: `learningMode` toggle in ui store. When on, `converse` tool calls are held for user approval (Accept/Edit/Reject) instead of executing immediately. Corrections are persisted in `corrections.svelte.ts` (localStorage `claude-talks:corrections`) and injected into Gemini's `systemInstruction` via `buildSystemPrompt()` on next session connect. Key details:
  - `snapshotUtterance()` must be called BEFORE `commitTurn()` in `gemini.ts` — it captures the full merged user text (prior committed user turns + current `pendingInput`) and audio buffer.
  - `commitTurn()` merges consecutive user turns (VAD fires multiple interrupts per utterance) and clears `pendingInput`/`audioBuffer`.
  - Audio/text suppression during converse is handled by `conversePhase` in `gemini.ts` (not in the store). See **Converse phase gating** above.
  - Approval UI is embedded in the last user turn bubble (not a separate element).
- **Push-to-talk (PTT)**: `pttMode` toggle in ui store. When on, Gemini's automatic VAD is disabled (`realtimeInputConfig.automaticActivityDetection.disabled: true`) and the user explicitly brackets speech with a hold-to-talk button. Key details:
  - **Session-level config** — VAD vs PTT is set at `ai.live.connect()` time. Can't toggle mid-session. UI disables the toggle when `status !== 'idle'`. Must stop + restart to switch modes.
  - **`sendRealtimeInput` widened** — `LiveBackend.sendRealtimeInput` takes a `RealtimeInput` object (`{ audio?, activityStart?, activityEnd? }`) matching the SDK shape. In `gemini.ts` it's a pure pass-through: `(input) => session.sendRealtimeInput(input)`. All audio call sites use `{ audio: { data, mimeType } }`.
  - **Mic gating** — mic runs continuously in both modes. One guard in the callback: `if (pttMode && !pttActive) return;`. This avoids re-initializing AudioContext/worklet on each press. `pttPress()` sets the flag + sends `activityStart`; `pttRelease()` clears it + sends `activityEnd`.
  - **`pttMode` is non-reactive in data store** — plain `let`, set once at `start()` from `deps.getPttMode()`. UI reads `ui.pttMode` directly (not from data store). `pttActive` IS reactive (`$state`) for UI button feedback.
  - **Replay always uses VAD** — `startReplay()` passes `pttMode: false`. PTT doesn't apply to pre-recorded audio.

## Locations & commands

- Session files: `~/.claude/projects/-{cwd-with-dashes}/{session-id}.jsonl`
- Svelte app: `cd vibecoded_apps/claude_talks && npm run dev` (port 5000)
- Watcher CLI: `python -m claude_talks.watcher /path/to/session.jsonl --handler log`
- Backend: `uvicorn api.server:app --port 8000`
- Test (mock, no credits): `curl -s -N -X POST http://localhost:8000/api/converse/test -H 'Content-Type: application/json' -d '{"instruction":"test"}'`
- Test (real): `curl -s -N -X POST http://localhost:8000/api/converse -H 'Content-Type: application/json' -d '{"instruction":"say hello"}'`

## Testing

After making changes, verify with the E2E test using the `e2e-chrome-tester` agent.

### How to use the E2E agent

The agent is a **vanilla test executor** — it does exactly what you tell it and reports results. It has no project context. Your prompt must be **self-contained**: explicit start state, explicit steps, explicit success criteria.

**Rules for launching:**
1. **Start both servers first** (Bash, background) before launching the agent.
2. **Tell it the URL** — always `http://localhost:5173/#/live`.
3. **Tell it what to look for** — element text, button labels, console log patterns. Be literal.
4. **Tell it what success looks like** — "page shows buttons: Start, Record, Replay", "console has no errors", "a message bubble appears with text".
5. **Don't assume context** — the agent doesn't know the app. Describe UI elements by visible text/role, not by component names.

### Servers

**Check first, don't restart blindly.** Curl both ports before starting anything. Only start what's missing. Never kill running servers — waste of tokens and time.

```bash
# Check if already running
curl -s -o /dev/null -w "%{http_code}" http://localhost:8000/docs  # backend
curl -s -o /dev/null -w "%{http_code}" http://localhost:5173       # frontend
```

Only start what returned non-200:
```bash
# Backend (must run from project root)
cd /Users/dhuynh95/claude_talks && source /Users/dhuynh95/.claude/venv/bin/activate && uvicorn api.server:app --port 8000
# Frontend
cd /Users/dhuynh95/claude_talks/vibecoded_apps/claude_talks && npx vite --port 5173
```

### Standard E2E scenarios

**Smoke test** (page loads):
> Navigate to `http://localhost:5173/#/live`. Take a snapshot. Verify buttons with text "Start", "Record", "Replay" are visible. Check console for errors (`list_console_messages`). Report pass/fail.

**Converse pipeline** (full E2E):
> Navigate to `http://localhost:5173/#/live`. Take a snapshot. Click the button labeled `converse_closure_question` (a saved recording). Wait 15 seconds for the replay to complete. Take a snapshot. Verify that message bubbles appeared in the conversation area. Check console for errors — ignore "mic" warnings. Report pass/fail.

- Saved recordings: `vibecoded_apps/claude_talks/public/recordings/` — `.json` files that can be replayed in the UI to test the full E2E pipeline without a mic
## Instructions

Read, digest then ask me questions if needed.
