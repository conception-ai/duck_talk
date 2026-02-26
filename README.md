# DuckTalk - Realtime Voice Wrapper for Claude Code

DuckTalk is a bidirectional voice wrapper for Claude Code that allows you to talk with minimal(ish) latency.

The key technology behind DuckTalk is a generic voice wrapper that can take any black box Agent (aka a multi turn LLM that receives inputs from users, ) and wrap it to add capabilities:
- Speech to Text (STT): users can **talk** to their agent
- Text to Speech (TTS): agents can **talk** back to their user



## Demo

// 



## Quick start

You will need:

- [Claude Code CLI](https://docs.anthropic.com/en/docs/claude-code) on PATH
- `ANTHROPIC_API_KEY` — for Claude Code
- `GOOGLE_API_KEY` — for Gemini voice (STT/TTS) 

```bash
git clone https://github.com/dhuynh95/claude_talks.git && cd claude_talks
npm install

# Set up your keys
cp .env.example .env
# Edit .env with your API keys

npm run dev
# Opens http://localhost:8000
```

## Why DuckTalk

I always wanted to have a Realtime Coding Assistant that I could talk to on a walk to see what is going and brainstorm with plans, which have become my main bottleneck.

So what's the issue with other approaches?


## How it works

Gemini handles real-time voice I/O (speech-to-text, voice activity detection, interruption). Claude Code handles the actual coding work. The chat UI shows messages, tool calls, and markdown — voice is the primary input but everything is visible.

**Two-agent split.** Gemini = ears and mouth, Claude = brain. Gemini Live acts as a transparent relay — it listens via WebSocket, transcribes speech, and calls a `converse` tool that forwards instructions to Claude Code. Claude's streamed response is spoken aloud via a persistent TTS session (a second Gemini connection) and displayed in the chat simultaneously.

**Session management.** State lives in Claude Code's native JSONL files — no separate database. You can browse past sessions, resume them, and rewind (fork) to any message.

**Review mode.** Optional approval step — hear the instruction read back before it goes to Claude. Accept, edit, or reject by voice or UI buttons.

## Architecture

**Key design decisions:**

- **Persistent TTS session** — one Gemini Live connection stays open for TTS across multiple converse calls. ~1.5s first-audio latency. Sentence-boundary buffering for natural speech cadence.
- **BLOCKING converse tool** — Gemini freezes when it calls `converse`, gets unblocked immediately. Claude's response text is injected back into Gemini's context via `sendClientContent` at the same cadence as TTS audio.
- **Fork-based rewind** — to "go back" in conversation, a new JSONL is created with only the path up to that message. Claude Code's native session format, no custom persistence.
- **Port-based DI** — stores take injectable interfaces (`AudioPort`, `ConverseApi`, `LiveBackend`) so components stay testable without Gemini/Claude dependencies.

## License

[MIT](LICENSE)
