# Sound Design

## Why sound matters here

This is a voice-first interface. The user may not be looking at the screen. Every piece of information that would normally be conveyed visually — loading spinners, error banners, state changes — must have an auditory equivalent or be lost.

Sound is the primary feedback channel. Visual UI is the fallback.

## Core principle: resolve ambiguity

A sound is justified if and only if it resolves an ambiguity that the user cannot resolve otherwise. Three tests:

1. **What ambiguity does it resolve?** If the user would be confused or uncertain without it, it earns its place.
2. **Is silence sufficient?** Silence is a signal too — "done," "nothing happening," "interrupted." Don't add sound where silence already communicates.
3. **Does it survive repetition?** The user will hear this sound hundreds of times. If it demands attention or carries emotional weight, it will become irritating. Neutral > pleasant > dramatic.

Every candidate sound that fails any of these tests is excluded. The vocabulary should be as small as possible and no smaller.

## Design constraints

### Whitelist, not blacklist

The previous architecture let Gemini speak by default and tried to suppress unwanted speech. This is a blacklist — block what you don't want and hope you caught everything. It leaked constantly.

The new architecture blocks all Gemini audio by default. Sound only passes through an explicit gate. This is a whitelist — only allow what you specifically intend. Leaks are structurally impossible.

This principle applies beyond the audio gate. Every sound in the system should be an intentional, programmatic decision. No sound should be a side effect of a language model's behavior.

### Functional, not decorative

Each sound maps to exactly one system state transition. No sound exists for aesthetics, branding, or "polish." If you can't name the state transition a sound represents, it doesn't belong.

### Neutral over expressive

Productivity tool, not a game. Sounds should be:
- **Short** — under 200ms for events, looping for states
- **Soft** — low amplitude, won't startle
- **Timbrally simple** — sine waves, not chords or melodies
- **Pitch-coded** — rising = positive/ready, falling = negative/stopped, flat = neutral/ongoing

Emotional neutrality is a feature. The tap that says "heard you" should feel the same whether the user just asked to delete a database or rename a variable.

### The gap problem

The critical UX challenge is dead air. The timeline of a single exchange:

```
User speaks ──── 0s
VAD silence ──── +0.2s
Gemini routes ── +0.5-1.5s
Claude TTFT ──── +2-10s
Claude streams ─ +N seconds
Done ─────────── silence
```

Between speech end and Claude's voice, there can be 3-12 seconds of silence. In a voice-first interface, ambiguous silence is the worst possible signal. Each gap needs exactly one sound to fill it — no more.

## The vocabulary

Two sounds. Everything else is implicit in the conversation flow.

### Taxonomy

**Event** — punctual, fire-and-forget. Marks a discrete state transition.
- Tap

**State** — continuous, looping. Indicates an ongoing condition.
- Pulse (thinking)

The only voice in the system is Gemini TTS reading Claude's text. It is not "our" sound — it's the content delivery mechanism. We control when it's allowed through (the gate), but we don't design it.

### What's excluded and why

| Candidate | Why excluded |
|-----------|-------------|
| Error sound | Pulse stopping IS the error signal. The absence of resolution is unambiguous. Visual UI handles the detail. |
| Ready chime | The user initiated the connection — they're watching. Visual state suffices. |
| Stopped chime | Silence after voice = done. Falling pitch adds no information. |
| Approval prompt | User chose review mode — they're already watching. Visual UI suffices. |
| Interrupt ack | Audio stopping IS the feedback. Sound on silence is redundant. |
| "Done" chime | Silence after voice = done. Adding a chime adds no information. |
| Per-chunk ticks | Voice is continuous. Ticks during speech are noise. |
| Gemini verbal ack | The entire point of muting. Replaced by tap. |

The exclusion list is as important as the inclusion list. Every sound you don't add is cognitive load you don't impose.

---

## Sound specifications

### 1. TAP

**State transition**: tool call received (user intent captured, routing to Claude)

**Resolves**: the 0.5-1.5s gap between speech end and system acknowledgment. Without it, the user doesn't know if the system heard them.

**Character**: Hann-windowed sine at ~690Hz. 3ms of signal in an 80ms frame. The envelope is `sin²(πt/dur)` — zero derivative at both endpoints, so the sound appears and dissolves with no perceptible attack or release. Gentle frequency sweep from 710→670Hz (barely perceptible — the ear hears a single soft pulse, not a descending tone). Peak amplitude 0.22.

**Implementation**: `src/routes/live/sounds/tap.ts` — pre-rendered AudioBuffer, no oscillators.

**Timing**: plays immediately on `converse` tool call, before any async work begins.

### 2. PULSE

**State transition**: Claude is processing (TTFT gap)

**Resolves**: the 2-10s gap between tap and Claude's voice. Without it, silence after a tap feels like the system crashed.

**Character**: 80Hz sine with Hann-shaped breathing — amplitude swells and recedes once per second following `sin²()`. Amplitude range: 0.02–0.05 (40% floor, 60% swell depth). Quiet enough to forget about, present enough that its absence would be noticed.

**Implementation**: `src/routes/live/sounds/pulse.ts` — pre-rendered 1s AudioBuffer, looped.

**Timing**: starts immediately after tap. Hard-stops (no fade) the instant the first Claude SSE chunk arrives. The voice beginning IS the resolution — any transition sound would delay it.

---

## The Hann window: why it works

The single most important discovery in this sound design: the envelope function matters more than frequency, synthesis method, or harmonic content.

`sin²(πt/dur)` — the Hann window — has a unique property: **zero derivative at both endpoints.** The amplitude starts at zero with zero slope and ends at zero with zero slope. There is no attack transient, no release click, no mathematical edge for the ear to catch.

This is why the tap doesn't sound "gadgetty" despite being a raw sine wave. And why the pulse breathes rather than oscillates despite being a raw sine wave. The Hann window makes the sound appear and dissolve instead of starting and stopping.

### What was tried and rejected

Every alternative envelope produced sounds that felt synthetic, mechanical, or attention-seeking:

| Envelope | Problem |
|----------|---------|
| Linear ramp attack + exponential decay | The junction between attack and decay is a discontinuity. The ear catches it as "electronic." |
| Gaussian bump | Smooth, but doesn't reach zero at endpoints — needs hard truncation, which adds a click. |
| ADSR (attack/decay/sustain/release) | Four parameters to tune, each a potential source of artificiality. Over-designed. |

### What was tried and rejected (synthesis)

Attempts to make sounds "warmer" or "more organic" by increasing complexity consistently made them worse:

| Method | Result |
|--------|--------|
| Additive sines (stacking harmonics) | Each harmonic added was a decision the ear could detect as designed. More harmonics = more synthetic. |
| Filtered noise (bandpass, pink) | Organic texture, but impossible to make discreet enough. Noise draws attention. |
| Karplus-Strong (physical modeling) | Models a plucked string. Sounds like a guitar — wrong physical object. |
| FM synthesis (carrier:modulator) | Rich timbres, but still bolted onto the wrong envelope. The envelope was always the real problem. |
| Detuned sine clusters | Beating/shimmer draws attention. The variation becomes the thing you listen to. |

The lesson: **a simple sine with the right envelope beats a complex timbre with the wrong one.** The ear forgives spectral simplicity but punishes envelope artificiality.

### Parameters: gentle over dramatic

The original spec called for a 700→400Hz sweep. The actual recording that sounded right sweeps 710→670Hz — a 40Hz range, barely perceptible. Every attempt with dramatic parameter changes (1800→900Hz pitch drops, fast exponential decays, wide frequency sweeps) sounded "gadgetty" because **drama demands attention, and attention is the opposite of what a utility sound should do.**

The sound should be felt, not noticed.

---

## Flow integration

### Normal exchange (direct mode)

```
User speaks ─────────────────── (real world)
VAD silence ─────────────────── (silence, ~200ms)
Tool call ───────────────────── TAP
Claude TTFT ─────────────────── PULSE ... PULSE ... PULSE
First chunk ─────────────────── voice begins (pulse hard-stops)
Streaming ───────────────────── voice continues
Done ────────────────────────── silence (= done)
```

### Error during processing

```
Tool call ───────────────────── TAP
Claude TTFT ─────────────────── PULSE ... PULSE
Error ───────────────────────── pulse stops (= something went wrong)
```

### User interrupts Claude

```
Claude streaming ────────────── voice playing
User speaks ─────────────────── voice stops instantly (= interrupt ack)
```

### Session lifecycle

```
User taps mic orb ───────────── (visual: connecting state)
Connection established ──────── (visual: ready state)
... conversation ...
User taps stop ──────────────── silence (= done)
```

### Review/correct mode

```
Tool call ───────────────────── TAP
Approval wait ───────────────── PULSE ... (system is MUTED, awaiting user)
User approves ───────────────── (pulse continues — now waiting for Claude)
First chunk ─────────────────── voice begins (pulse hard-stops)
```

Note: no distinct sound for "awaiting approval." The pulse already communicates "system is working." From the user's perspective, the wait is continuous — they don't need to distinguish "waiting for approval UI" from "waiting for Claude." The visual approval buttons handle that distinction.
