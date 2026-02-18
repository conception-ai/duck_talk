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
| @vibecoded_apps/claude_talks/src/routes/live/types.ts | Port interfaces (DataStoreMethods, AudioPort, LiveBackend, ConverseApi) + correction types (STTCorrection, PendingApproval) |
| @vibecoded_apps/claude_talks/src/routes/live/stores/data.svelte.ts | Data store — reactive state + session lifecycle + audio buffer + approval flow |
| @vibecoded_apps/claude_talks/src/routes/live/stores/ui.svelte.ts | UI store — persistent user prefs (voiceEnabled, apiKey, learningMode) |
| @vibecoded_apps/claude_talks/src/routes/live/stores/corrections.svelte.ts | Corrections store — localStorage-persisted STT corrections |
| @vibecoded_apps/claude_talks/src/routes/live/recorder.ts | Mic audio recorder — RecordedChunk type (reused for audio buffer) |
| @vibecoded_apps/claude_talks/src/routes/live/gemini.ts | Gemini Live connection + message handling + STT correction prompt injection |
| @vibecoded_apps/claude_talks/src/routes/live/converse.ts | SSE stream consumer for /api/converse |
| @vibecoded_apps/claude_talks/src/routes/live/audio.ts | Browser audio I/O |
| @vibecoded_apps/claude_talks/src/routes/live/models.ts | Shared types (SessionInfo) |
| @vibecoded_apps/claude_talks/src/routes/live/tools.ts | Gemini function declarations + handlers |
| @vibecoded_apps/claude_talks/src/lib/llm.ts | LLM abstraction — `createLLM({ apiKey })` → callable with `.stream()` and `.json<T>()` |

## Guiding Principles

- **Clean data flows**: Raw signals (STT chunks, VAD events) must be merged into clean domain objects at the store level. Consumers (UI, corrections, API calls) should never reconstruct or re-derive from raw data. Fix the source, not each consumer. Leverage Svelte's reactivity: one clean `$state` → many `$derived` readers.

## Gotchas

- **Gemini Live**: use `types.LiveConnectConfig` + `types.Modality.AUDIO` (not raw dicts). `model_turn.parts` can be `None`. File input needs chunking + `audio_stream_end=True`.
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

## Locations & commands

- Session files: `~/.claude/projects/-{cwd-with-dashes}/{session-id}.jsonl`
- Svelte app: `cd vibecoded_apps/claude_talks && npm run dev` (port 5000)
- Watcher CLI: `python -m claude_talks.watcher /path/to/session.jsonl --handler log`
- Backend: `uvicorn api.server:app --port 8000`
- Test (mock, no credits): `curl -s -N -X POST http://localhost:8000/api/converse/test -H 'Content-Type: application/json' -d '{"instruction":"test"}'`
- Test (real): `curl -s -N -X POST http://localhost:8000/api/converse -H 'Content-Type: application/json' -d '{"instruction":"say hello"}'`

## Testing

After making changes, verify with the E2E test:

1. Start both servers in background:
   - `source /Users/dhuynh95/.claude/venv/bin/activate && uvicorn api.server:app --port 8000`
   - `cd vibecoded_apps/claude_talks && npx vite --port 5173`
2. Use Chrome MCP to navigate to `http://localhost:5173/#/live`
3. Take a snapshot to confirm the page loads (buttons: Start, Record, Replay, plus saved recordings)
4. Check console for errors (`list_console_messages`)
5. Run the **converse** scenario: click the `converse_closure_question` button (a saved recording that triggers the full converse pipeline via replay — Gemini → tool call → SSE → sendClientContent). Verify messages appear and no console errors.

- Saved recordings: `vibecoded_apps/claude_talks/public/recordings/` — `.json` files that can be replayed in the UI to test the full E2E pipeline without a mic
## Instructions

Read, digest then ask me questions if needed.
