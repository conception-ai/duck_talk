# Role

You are a world class software engineer.
Your code must be clean, minimalist and easy to read.

## Files to read at all times

Batch read them all in a single read. You must read context in a single turn.

| File | Purpose |
|------|---------|
| @app/Reduck/Models/ContentBlock.swift | `ContentBlock` enum + `JSONValue`. Custom Codable discriminated union |
| @app/Reduck/Models/Message.swift | `Message` struct. Dual content: `string \| [ContentBlock]` |
| @app/Reduck/Models/LiveTypes.swift | `Status`, `PendingTool`, `PendingApproval`, `InteractionMode`, `VoiceEvent` |
| @app/Reduck/Models/SessionInfo.swift | `SessionInfo` — API response from `GET /api/sessions` |
| @app/Reduck/Stores/LiveStore.swift | `@MainActor @Observable`. messages[], streamingText, sessionId. Owns `ConverseClient` |
| @app/Reduck/Stores/SettingsStore.swift | `@Observable` + UserDefaults. apiKey, mode, model, serverURL, baseURL |
| @app/Reduck/Services/ConverseClient.swift | SSE stream parser. `Sendable`, `@MainActor` callbacks with `await` |
| @app/Reduck/Views/LiveView.swift | Main view. Chat scroll + streaming bubble + text input + send/stop + toast |
| @app/Reduck/Views/SessionListView.swift | Home page. Session list, pull-to-refresh, nav to LiveView |
| @app/Reduck/Views/ChatBubbleView.swift | User/assistant bubbles. MarkdownUI, thinking disclosure, tool uses |
| @app/Reduck/ReduckApp.swift | `@main`. NavigationStack, injects SettingsStore via `.environment()` |
| @app/Reduck/Utilities/MessageHelpers.swift | Extensions: `textContent`, `toolUses`, `thinkingBlocks`, `buildToolResultMap` |
| @app/project.yml | xcodegen spec. iOS 17+, Swift 6, SPM: MarkdownUI |

## Files to read when needed

| File | Purpose |
|------|---------|
| app/Reduck/Views/ToolUseView.swift | Expandable tool_use/tool_result display |
| app/Reduck/Views/SettingsSheet.swift | Settings form (server URL, API key, mode, model, prompt) |
| app/Reduck/Info.plist | ATS localhost exception, mic/speech usage descriptions |
| src/server/routes.ts | Express backend — all API endpoints the iOS app calls. SSE streaming protocol |
| src/server/claude-client.ts | TS Agent SDK wrapper. `Claude.converse()` async generator — what `/api/converse` invokes |
| src/shared/types.ts | Backend types — `ContentBlock` union, `SessionEntry`. iOS models must match these |
| src/shared/models.ts | Session file ops — `Conversation`, `forkSession()`. Needed for edit/back feature |

## Previous frontend files to read for inspiration

| File | Purpose |
|------|---------|
| @src/client/routes/live/+page.svelte | 3-zone layout: chat-scroll, dock (transcription/approval + input-bar + waveform), modals |
| @src/client/routes/live/stores/data.svelte.ts | Two-array model: `messages[]` + `voiceLog[]`. Approval flow, session lifecycle |
| @src/client/routes/live/stores/ui.svelte.ts | Persistent prefs. `mode`, `apiKey`, `model`, `systemPrompt` |
| @src/client/routes/live/gemini.ts | Gemini Live orchestration. BLOCKING converse, 3 abort paths, `approvalPending` gate |
| @src/client/routes/live/tts-session.ts | Persistent TTS. `muted` flag, `pendingSends`, `onFlush` dual consumer |
| @src/client/routes/live/converse.ts | SSE consumer. `AbortController`, session ID capture from done event |
| @src/client/routes/live/audio.ts | Mic 16kHz PCM worklet, gapless player 24kHz |
| @src/client/routes/live/buffer.ts | Sentence-boundary buffer. minChars=40, maxWaitMs=1000 |
| @src/client/routes/live/voice-approval.ts | `webkitSpeechRecognition` keyword listener. ACCEPT/REJECT/STOP words |
| @src/client/routes/live/tools.ts | Gemini tool declarations: `converse` + `stop` |
| @src/client/routes/live/types.ts | Port interfaces: `DataStoreMethods`, `LiveBackend`, `ConverseApi`, `StreamingTTS` |

## Svelte source files (read when porting a specific component)

| File | iOS target |
|------|------------|
| src/client/routes/live/gemini.ts | → `Services/GeminiLiveService.swift` |
| src/client/routes/live/tts-session.ts | → `Services/TTSSession.swift` |
| src/client/routes/live/audio.ts | → `Services/AudioManager.swift` |
| src/client/routes/live/buffer.ts | → `Services/SentenceBuffer.swift` |
| src/client/routes/live/voice-approval.ts | → `Services/KeywordListener.swift` |
| src/client/routes/live/tools.ts | → tool declarations in GeminiLiveService |
| docs/gemini-live-api-swift-reference.md | Gemini Live API reference |

## Architecture

iOS thin client → Express backend (same Mac, `http://localhost:8000`).

| Svelte | iOS |
|--------|-----|
| `$state` / `$derived` | `@Observable` + SwiftUI bindings |
| `localStorage` | `UserDefaults` |
| `fetch` SSE | `URLSession.AsyncBytes` |
| `WebSocket` (Gemini Live) | `URLSessionWebSocketTask` or Swift SDK (TBD) |
| `AudioContext` + `AudioWorklet` (16kHz PCM) | `AVAudioEngine` + `installTap` |
| `webkitSpeechRecognition` | `SFSpeechRecognizer` |
| `Web Audio Player` (24kHz gapless) | `AVAudioPlayerNode` |

## Guiding Principles

- **Clean data flows**: Raw signals (STT, VAD) merge into domain objects at the store level. Views consume `@Observable` properties — never reconstruct from raw data.
- **Port behavior, not code**: The Svelte app is the spec. Match its behavior but write idiomatic Swift. Don't transliterate JS patterns.

## UI/UX Iteration Process

**Prototype (fast start):**
1. Create new view file in `Views/`
2. Import types from `Models/` and helpers from `Utilities/`
3. Add `#Preview` at bottom with mock data — no backend, no stores needed
4. Iterate in Xcode Canvas or simulator
5. Wire to `LiveStore` when visual is right

**Key pattern — preview-driven rendering:**
```swift
#Preview {
    let settings = SettingsStore()
    NavigationStack {
        LiveView(sessionId: nil)
    }
    .environment(settings)
}
```

**Propagation:**
1. Views consume `LiveStore` properties via `@Observable` — no manual subscription
2. Same `MessageHelpers` extensions work in all views
3. Build with `xcodebuild` to catch type errors across files
4. Regenerate project: `cd app && xcodegen generate`

## Gotchas

- **xcodegen regenerate required**: Adding/removing `.swift` files requires `cd app && xcodegen generate`. The `.xcodeproj` does NOT auto-discover new files. This is the #1 "why can't it find my type" error.
- **Swift 6 strict concurrency**: `@MainActor @Observable` on stores. Callbacks crossing actor boundaries need `@MainActor @Sendable @escaping` + `await` at call sites. Non-`@MainActor` code calling `@MainActor` closures must `await`. This is the #1 source of build errors.
- **ContentBlock custom Codable**: Swift can't auto-synthesize Codable for enums with associated values. Backend sends `{"type": "tool_use", ...}` — the inner `BlockType` enum maps snake_case discriminators. If you add a new block type, update both `BlockType` and `init(from:)`.
- **Message.content dual type**: Backend returns `content: "string"` for user, `content: [ContentBlock]` for assistant. Custom Codable tries string first, falls back to array. Both render fine — `textContent` extension handles both.
- **SSE parsing quirk**: `URLSession.AsyncBytes.lines` yields one line at a time. SSE events are `data: {...}\n\n`. Buffer lines, process on empty line (the `\n\n` boundary).
- **Two-array data model**: Same as Svelte — `messages[]` (persistent, mutable) vs `voiceLog[]` (ephemeral, append-only). "Go back" pops messages but keeps voiceLog.
- **Simulator device ID**: `6FDAF5DD-500F-48D0-B01B-57CC5827B1E2` (iPhone 17 Pro Max). Use UUID with `xcrun simctl` — name-based lookup can fail.
- **Backend must be running**: The iOS app is a thin client. Start Express: `cd /Users/dhuynh95/claude_talks && npm run dev:server`.

## Testing

### Build + deploy
```bash
# Build
xcodebuild -project app/Reduck.xcodeproj \
  -scheme Reduck \
  -destination 'platform=iOS Simulator,name=iPhone 17 Pro Max' \
  build 2>&1 | grep -E "error:|BUILD"

# Install + launch
xcrun simctl install 6FDAF5DD-500F-48D0-B01B-57CC5827B1E2 \
  ~/Library/Developer/Xcode/DerivedData/Reduck-ebvmabuzhltsadarjqqavzpewrxv/Build/Products/Debug-iphonesimulator/Reduck.app
xcrun simctl launch 6FDAF5DD-500F-48D0-B01B-57CC5827B1E2 dev.conception.reduck
```

### Backend
```bash
cd /Users/dhuynh95/claude_talks && npm run dev:server
# Verify: curl -s http://localhost:8000/api/sessions | head -40
```

### Quick API smoke test
```bash
curl -s http://localhost:8000/api/config
curl -s http://localhost:8000/api/sessions | python3 -m json.tool | head -20
```

## Useful commands

```bash
cd app && xcodegen generate                              # regenerate .xcodeproj after adding files
xcrun simctl list devices available | grep iPhone        # list simulators
xcrun simctl boot 6FDAF5DD-500F-48D0-B01B-57CC5827B1E2  # boot simulator
xcrun simctl shutdown booted                             # shutdown all
open -a Simulator                                        # open Simulator.app
```

## Instructions

