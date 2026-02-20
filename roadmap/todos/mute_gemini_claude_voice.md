# Mute Gemini — Claude-Only Voice

Status: ready to implement
Created: 2026-02-20

## The problem

Two agents (Gemini Live + Claude Code) share one voice channel. The user
can't tell who's speaking.

### Observed failures

| # | Failure | Why it happens |
|---|---------|----------------|
| 1 | **Unreliable routing** — Gemini answers instead of calling `converse` | Gemini is an agent with opinions. The prompt says "always call converse" but prompts are suggestions. A nudge mechanism had to be built. |
| 2 | **Poor STT** — "commit" → "complete" | `inputTranscription` comes from a separate ASR frontend that doesn't read the model's context. An entire correction subsystem was built (3 modes, LLM auto-correct, persistent corrections). |
| 3 | **Editorializes Claude's text** — paraphrases, drops technical details | Gemini is asked to "relay faithfully" but it's a language model — it summarizes, softens, skips formatting. Prompt compliance is best-effort. |
| 4 | **Won't stay silent** — generates audio/text during converse | A 3-state suppression state machine (`idle`/`suppressing`/`relaying`) exists solely to fight this. |
| 5 | **Garbles tool-call args** — `instruction` ≠ what user said | Gemini interprets, not transcribes. Another lossy link in the telephone chain. |
| 6 | **Fragile timing** — audio leaks through suppression | "Asking Claude" audio arrives BEFORE the `toolCall` message. Phase transitions depend on event ordering. Race conditions. |

### Root cause

All six failures share one origin: **Gemini has agency AND a mouth.**

The system tries to control speech via prompting, but prompts are
suggestions, not constraints. The 3-state machine is complexity born
from fighting Gemini's desire to talk. Every patch (suppression,
flushing, nudging, phase gating) treats symptoms, not the cause.

## Design space explored

We considered three architectures:

### A. Full split — remove Gemini's audio output entirely

Gemini = STT + routing only. Separate TTS service for Claude.

**Problem:** Gemini Live tightly couples four properties: continuous
listening (VAD), intent routing (tool calls), TTS, and interruptibility.
All four share one WebSocket. Splitting TTS out means rebuilding
interruption handling (detect user speech → kill separate TTS → signal
new input). High cost, modest gain.

### B. Two distinct voices

Keep Gemini's full audio loop. Give Claude a separate TTS with a
different voice. User hears two distinct voices.

**Problem:** Two TTS pipelines running in parallel. Gemini still speaks
its own acks and commentary — the prompt-compliance problems (failures
1, 3, 4) remain. Voice distinction helps attribution but doesn't fix
the underlying agency conflict.

### C. Muzzle programmatically (chosen)

Keep Gemini Live intact. **Drop audio bytes in code**, not via prompt.
Only let audio through when Gemini is reading Claude's text.

**Why this wins:**
- Keeps Gemini Live's tight coupling (VAD + routing + TTS + interrupts
  on one WebSocket) — no need to rebuild interruption handling
- Solves voice clarity with two lines of logic (audio gate + phase var)
- Belt-and-suspenders: prompt tells Gemini "don't speak" AND code drops
  the bytes. Prompt failure is harmless.
- Simplifies the state machine from 3 states to 2

## The core insight

**Invert the default.** The current system lets Gemini audio through
by default and tries to suppress it during converse. The new system
blocks Gemini audio by default and only opens the gate when Claude's
text is being read aloud.

```
Current default:  audio PASSES  → suppress during converse (hard)
New default:      audio BLOCKED → allow during TTS only (easy)
```

This is the difference between a whitelist and a blacklist. Whitelisting
(only allow what you explicitly want) is fundamentally more secure than
blacklisting (block what you don't want and hope you caught everything).

## The state machine

Two states. Two transitions.

```
                        ┌──────────────┐
         ┌─────────────►│    MUTED     │◄──────────────┐
         │              │  (default)   │               │
         │              └──────┬───────┘               │
         │                     │                       │
   Claude stream done     first Claude chunk           │
   OR error               arrives via SSE              │
         │                     │                       │
         │                     ▼                       │
         │              ┌──────────────┐               │
         └──────────────│     TTS      │───────────────┘
                        │ (Claude's    │  user interrupts
                        │  mouth)      │  (sc.interrupted)
                        └──────────────┘
```

### Signal routing by state

| Signal | MUTED (default) | TTS |
|--------|-----------------|-----|
| Gemini audio (`modelTurn.parts`) | **DROP** | **PLAY** (reading Claude's text) |
| Gemini speech text (`outputTranscription`) | **DROP** | **DROP** (echo noise — real text is in tool result) |
| User speech (`inputTranscription`) | Pass through | Pass through |
| Tool calls | Process normally | N/A (arrive in MUTED) |
| User interrupts (`sc.interrupted`) | N/A | → MUTED + flush player |

### Comparison to current state machine

| | Current (3-state) | Proposed (2-state) |
|---|---|---|
| Default | `idle` — audio/text pass through | `muted` — audio/text dropped |
| Core logic | Blacklist: suppress during converse | Whitelist: allow only during TTS |
| Timing dependency | "Asking Claude" must arrive before `toolCall` | None — chime on tool call |
| `outputTranscription` | Shown in `idle` (Gemini's own speech) | Never shown (Claude's text is always in tool result) |
| States | idle, suppressing, relaying | muted, tts |

### What replaces verbal acknowledgment

A programmatic chime sound when the `converse` tool call is received.
Instant, deterministic, no Gemini generation latency. The user hears
a click and knows the system is working.

### The prompt change (belt + suspenders)

The system prompt changes from "relay" instructions to "dispatcher":

```
Current: "You are a voice relay... ALWAYS call converse...
          respond with 'Asking Claude'... read [CLAUDE] aloud..."

New:     "You are a silent dispatcher... call converse...
          Do NOT speak or acknowledge...
          read [CLAUDE] aloud..."
```

Two independent effects:
1. **Behavioral**: Gemini skips generating ack audio → faster tool call
2. **Safety net**: even if Gemini speaks anyway, MUTED drops the bytes

Neither the prompt nor the code gate is sufficient alone. Together they're
robust: prompt failures are harmless (code catches them), code bugs are
visible (prompt keeps Gemini mostly quiet for debugging).

## Architecture diagrams

### Before

```
User speaks → Gemini Live (STT + routing + TTS) → Claude Code
                  ↑                                    │
                  └──── [CLAUDE]: text fed back ────────┘

Gemini speaks:
  - Its own acks ("Asking Claude...")
  - Its own commentary (editorializing)
  - Claude's text (via sendClientContent relay)
  - All gated by 3-phase state machine (leaky)
```

### After

```
User speaks → Gemini Live (STT + routing) → Claude Code
                                                  │
              Gemini TTS ◄── [CLAUDE]: text ──────┘
              (audio gate: open ONLY in TTS phase)

Gemini speaks:
  - Claude's text ONLY
  - Gated by 2-state machine (whitelist)
  - Everything else: /dev/null
```

### Data flow during a converse call

```
1. User speaks
   └→ inputTranscription → UI (always)

2. Gemini calls converse tool
   └→ chime plays (programmatic)
   └→ audio gate: stays MUTED

3. Claude Code streams response (SSE chunks)
   └→ each chunk: appendTool (UI shows text)
   └→ first chunk: phase → TTS (audio gate opens)
   └→ each chunk: sendClientContent → Gemini reads aloud
   └→ Gemini audio → speaker (gate is open)

4. Claude stream done
   └→ phase → MUTED (audio gate closes)

5. User can interrupt at any point during step 3
   └→ sc.interrupted → phase → MUTED + flush
```

## Interaction with existing features

**Review/correct modes**: Unchanged. During approval wait, system is
in MUTED (default). When user approves and Claude starts streaming,
TTS opens on first chunk. Cancel resets to MUTED (no-op since it's
already the default).

**PTT (push-to-talk)**: Orthogonal. PTT gates mic input
(`sendRealtimeInput`). The binary phase gate controls audio output.
Independent axes.

**Replay mode**: Same flow. Recorded audio triggers tool calls the
same way live audio does.

**`accept_instruction` tool**: Unchanged. Calls `data.approve()`,
sends blocking tool response. No audio generation, no phase interaction.

## What this does NOT fix

These remain separate problems with their own solutions:

- **STT accuracy** — `inputTranscription` still from Gemini's ASR.
  Same errors. Correction subsystem still needed.
  → `roadmap/todos/correction_llm_accuracy.md`

- **Routing reliability** — Gemini may still fail to call `converse`.
  Nudge logic stays. Hypothesis: simpler prompt (no speech management)
  may improve routing, but untested.

- **Tool-call arg quality** — `instruction` is still Gemini's
  interpretation, not verbatim transcription.

## Implementation sketch

The change is concentrated in the Gemini message handler (`gemini.ts`):

1. **State variable**: 3-state `conversePhase` → 2-state `phase` (`'muted' | 'tts'`)
2. **Audio gate**: flip condition from blacklist (`!== 'suppressing'`) to whitelist (`=== 'tts'`)
3. **outputTranscription**: delete the handler entirely (never display Gemini's speech text)
4. **Converse tool handler**: remove suppression setup, add chime call
5. **Interrupted handler**: add `phase = 'muted'`
6. **System prompt**: relay → dispatcher
7. **Chime utility**: small Web Audio API function in `audio.ts`
8. **UI label**: "Gemini" → "Claude"

Dead code (`appendOutput`, `pendingOutput` in the data store) becomes
inert — never called, no breakage. Can be cleaned up separately.

### Scope

| Layer | Changes |
|-------|---------|
| Gemini message handler | State machine, audio gate, prompt |
| Audio utilities | Add chime function |
| UI | One label change |
| Data store | None |
| Types/interfaces | None |
| Backend/API | None |
| Tool declarations | None |

## Verification

**Build**: `npm run check` in the Svelte app.

**Manual test**: Start live session → speak → verify:
- No "Asking Claude" voice (silence after speaking)
- Chime plays when tool call fires
- Claude's text appears in UI (streamed)
- Claude's text spoken aloud after first chunk arrives
- Interrupting stops playback immediately
- Label says "Claude" not "Gemini"

**Replay test**: Use saved recording — same verification, no mic needed.

**Rollback**: All changes in 3 files (`gemini.ts`, `audio.ts`,
`+page.svelte`). No data model, API, or interface changes. Revert
is straightforward.
