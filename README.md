# Reduck

Voice interface for Claude Code. Speak to Claude, hear it respond.

**Pipeline:** Mic → Gemini Live (STT + VAD) → Claude Code (Agent SDK) → Gemini TTS → Speaker

## Prerequisites

- [Claude Code CLI](https://docs.anthropic.com/en/docs/claude-code) on PATH (`npm install -g @anthropic-ai/claude-code`)
- `ANTHROPIC_API_KEY` — for Claude
- `GOOGLE_API_KEY` — for Gemini voice (STT/TTS)

## Quick start

```bash
git clone <repo> && cd claude_talks
npm install
npm run build

# Create .env with your keys
echo "ANTHROPIC_API_KEY=sk-ant-..." > .env
echo "GOOGLE_API_KEY=AIza..." >> .env

npm start
# Opens http://localhost:8000
```

## Development

```bash
npm run dev:server   # Express API on :8000
npm run dev:client   # Vite dev server on :5173 (proxies /api → :8000)
```

Or both at once: `npm run dev`

## Scripts

| Command | Description |
|---------|-------------|
| `npm start` | Run production server (serves built frontend) |
| `npm run build` | Compile server (tsc) + bundle frontend (vite) |
| `npm run check` | Type-check server + client |
| `npm run dev` | Start both dev servers |

## Project structure

```
src/
  shared/     Types + session file logic (used by both server and client)
  server/     Express API — Claude Agent SDK, SSE streaming, session listing
  client/     Svelte 5 SPA — voice UI, chat rendering, Gemini integration
dist/
  server/     Compiled server (tsc output)
  public/     Built frontend (vite output)
```

## CLI options

```
npm start -- --port 9000        # custom port (default: 8000)
npm start -- --host 0.0.0.0    # listen on all interfaces
npm start -- --no-browser      # don't open browser on start
```

## How it works

Reduck launches from a project directory — that directory becomes the scope for Claude Code sessions. The server reads session JSONL files from `~/.claude/projects/` and streams Claude responses as SSE events.

The voice pipeline uses Gemini Live for real-time speech-to-text with voice activity detection, routes transcriptions through Claude Code via the Agent SDK, then streams responses back through Gemini TTS for audio playback.
