# LLM Auto-Correction Accuracy

Status: needs work before shipping
Created: 2026-02-19
Related: `plans/002_stt_correction_research.md`

## What exists today

A stateless LLM call that rewrites Gemini's tool-call instruction using
accumulated user corrections as few-shot examples.

```
User speaks → Gemini Live STT → converse({ instruction }) → LLM corrects → approval UI
```

### Key files

| File | What it does |
|------|-------------|
| `vibecoded_apps/claude_talks/src/routes/live/correct.ts` | `correctInstruction(llm, instruction, corrections)` — the LLM call |
| `vibecoded_apps/claude_talks/src/routes/live/gemini.ts:207-226` | Mode branching: `correct` path calls `correctInstruction` then `holdForApproval` |
| `vibecoded_apps/claude_talks/src/routes/live/+page.svelte:28-32` | DI wiring: builds closure over `createLLM` + `corrections.corrections` |
| `vibecoded_apps/claude_talks/src/lib/llm.ts` | `createLLM({ apiKey })` — Gemini text generation abstraction |
| `vibecoded_apps/claude_talks/src/routes/live/stores/corrections.svelte.ts` | Persisted corrections store (`addSTT`, `remove`) |
| `vibecoded_apps/claude_talks/src/routes/live/types.ts:42` | `Correction` type (has `heard`, `meant`, `audioChunks`) |

### Current prompt (correct.ts)

```
Fix speech-to-text errors in this instruction.

Known corrections:
- "what's the latest commit we did?" → "what branch are we in?"

Instruction: "What is the latest commit?"

Return only the corrected text.
```

### Data flow through the system

```
┌─────────────┐     ┌──────────────┐     ┌─────────────┐     ┌────────────┐
│ User speaks │ ──→ │ Gemini Live  │ ──→ │ correct.ts  │ ──→ │ Approval   │
│ (audio)     │     │ STT + tool   │     │ LLM rewrite │     │ UI         │
└─────────────┘     │ call         │     └─────────────┘     │ Accept/    │
                    │              │           ↑              │ Edit/      │
                    │ instruction: │     corrections[]        │ Reject     │
                    │ "What is the │     from localStorage    └────────────┘
                    │ latest       │                                │
                    │ commit?"     │                          ┌─────▼──────┐
                    └──────────────┘                          │ Claude     │
                                                             │ Code       │
                                                             └────────────┘
```

## Observed problems

### 1. Hallucinated corrections

With stored correction:
  `"what's the latest commit we did?" → "what branch are we in?"`

The LLM receives `"What is the latest commit?"` and rewrites it to
`"What branch are we in?"` — a completely wrong correction.

**Root cause:** the prompt says "fix STT errors" but gives no constraint
to only apply corrections when words actually match. The LLM sees a
superficially similar sentence ("latest commit" appears in both) and
generalizes the example into a semantic rewrite.

**Worse case:** with zero matching patterns, the LLM still rewrites.
It treats the examples as "this user tends to mean X when they say Y"
rather than "these specific words were misheard."

### 2. No way to know if correction is right

The LLM can't hear audio. It only sees text. Two identical-looking
instructions could mean different things depending on what the user
actually said. Without audio context, the LLM is guessing.

### 3. Corrections are sentence-level, not word-level

The stored corrections map full sentences to full sentences:
  `"what's the latest commit we did?" → "what branch are we in?"`

But STT errors are word-level: "commit" → "complete", "suite" → "sweet".
The prompt conflates these — it asks the LLM to fix an instruction using
sentence-level examples, so it pattern-matches on intent not on misheard words.

## What to try next

### A. Audio-aware correction (primary approach)

The `Correction` type already stores `audioChunks` (PCM 16kHz). We have
the raw audio of what the user said. Send it to the LLM alongside the
text so it can actually hear the user and make an informed decision.

**Why this is the right approach:** the core problem is the LLM is
guessing based on text alone. It can't distinguish "the STT was wrong"
from "the user said something different." With audio, the LLM can
listen to what the user actually said and compare it to the transcription.

**Two modes: zero-shot and few-shot.**

Both send the current utterance audio. The difference is whether past
correction examples (with their audio) are included as in-context examples.

**Zero-shot** — no prior corrections exist yet, or none are relevant.
The LLM gets only the current audio + transcription and decides if the
STT output sounds right:

```typescript
// Zero-shot: just audio + transcription
const messages: Message[] = [
  {
    role: 'user',
    content: [
      { inlineData: { data: audio, mimeType: 'audio/pcm;rate=16000' } },
      { text: `The speech-to-text system transcribed this audio as:
"${instruction}"

Listen to the audio carefully. If the transcription contains
errors, return the corrected text. If it is accurate, return
it unchanged.

Return only the final text, nothing else.` },
    ],
  },
];
```

**Few-shot** — past corrections exist. Each correction has its own audio
(`correction.audioChunks`) plus the heard/meant pair. These become
in-context examples before the current utterance:

```typescript
// Few-shot: past corrections as audio examples, then current utterance
const messages: Message[] = [];

// System context
messages.push({
  role: 'user',
  content: 'You fix speech-to-text errors. You will receive audio recordings ' +
    'with their transcriptions. First, examples of past corrections. ' +
    'Then, a new utterance to correct.',
});
messages.push({ role: 'assistant', content: 'Understood.' });

// In-context examples: each correction's audio + heard → meant
for (const c of corrections) {
  if (!c.audioChunks.length) continue;
  const exAudio = combineChunks(c.audioChunks);
  messages.push({
    role: 'user',
    content: [
      { inlineData: { data: exAudio, mimeType: 'audio/pcm;rate=16000' } },
      { text: `STT transcribed this as: "${c.heard}"\nWhat was actually said?` },
    ],
  });
  messages.push({ role: 'assistant', content: c.meant });
}

// Current utterance to correct
messages.push({
  role: 'user',
  content: [
    { inlineData: { data: audio, mimeType: 'audio/pcm;rate=16000' } },
    { text: `STT transcribed this as: "${instruction}"\nWhat was actually said?` },
  ],
});
```

**The logic in `correctInstruction`:**

```typescript
async function correctInstruction(
  llm: LLM, instruction: string, audioChunks: RecordedChunk[], corrections: Correction[],
): Promise<string> {
  const audio = combineChunks(audioChunks);
  const withAudio = corrections.filter(c => c.audioChunks.length > 0);

  let messages: Message[];
  if (withAudio.length) {
    messages = buildFewShot(audio, instruction, withAudio);  // examples + current
  } else {
    messages = buildZeroShot(audio, instruction);            // just current
  }

  const result = await llm(messages);
  return result.trim() || instruction;
}
```

**Why few-shot with audio matters:** the LLM hears the user's accent
and speech patterns in the examples, learns what "complete" sounds like
when this user says "commit", then applies that learned pattern to the
current utterance. Text-only few-shot can't do this — it's just
string matching. Audio few-shot is calibration via ICL.

**Key change:** the function signature gains `audioChunks` parameter.
The audio is the `pendingApproval.audioChunks` captured by
`snapshotUtterance()` in `gemini.ts:135` before `commitTurn()` clears
the buffer.

**What needs to change:**

| File | Change |
|------|--------|
| `correct.ts` | Add `audioChunks` param, build multimodal `Message[]` |
| `gemini.ts:210` | Pass `audioChunks` to `correctInstruction` |
| `+page.svelte:28-32` | Update DI closure to forward audio chunks |
| `types.ts` (DataStoreMethods) | No change — `snapshotUtterance` already returns chunks |

**Wiring in gemini.ts (line 210):**

Currently:
```typescript
deps.correctInstruction(instruction).then(...)
```

Becomes:
```typescript
deps.correctInstruction(instruction, audioChunks).then(...)
```

The `audioChunks` are already available in scope — captured at line 135.

### B. Test in isolation first (before integrating)

Build a standalone test script. No Gemini Live needed — just the LLM
and recorded audio files.

**Test matrix — 4 scenarios:**

```
                        │ No corrections     │ With corrections
                        │ (zero-shot)        │ (few-shot)
────────────────────────┼────────────────────┼─────────────────────
STT wrong               │ Can LLM hear the   │ Does audio example
("latest complete?"     │ right word from     │ improve accuracy
 but audio says commit) │ audio alone?        │ over zero-shot?
────────────────────────┼────────────────────┼─────────────────────
STT correct             │ Does LLM leave it  │ Does LLM leave it
("What is a closure?"   │ alone?             │ alone even with
 audio matches)         │                    │ unrelated examples?
```

```typescript
// test-correction.ts — run with: npx tsx test-correction.ts
import { createLLM } from './src/lib/llm';
import { correctInstruction } from './src/routes/live/correct';
import fs from 'fs';

const llm = createLLM({ apiKey: process.env.GEMINI_API_KEY! });

// Audio of user saying "What is the latest commit?"
const commitRecording = JSON.parse(fs.readFileSync(
  'public/recordings/what_is_latest_commit.json', 'utf-8'
));
// Audio of user saying "Tell me what a closure is"
const closureRecording = JSON.parse(fs.readFileSync(
  'public/recordings/converse_closure_question.json', 'utf-8'
));

// Past correction with audio (for few-shot)
const corrections = [{
  type: 'stt' as const,
  id: 'test',
  createdAt: '',
  heard: 'What is the latest complete?',
  meant: 'What is the latest commit?',
  audioChunks: commitRecording.chunks,  // same audio — user said "commit"
}];

const cases = [
  // Zero-shot: STT wrong, no examples
  { label: 'zero-shot / STT wrong',
    instruction: 'What is the latest complete?',
    audio: commitRecording.chunks,
    corrections: [],
    expected: 'What is the latest commit?' },

  // Zero-shot: STT correct, no examples
  { label: 'zero-shot / STT correct',
    instruction: 'Tell me what a closure is',
    audio: closureRecording.chunks,
    corrections: [],
    expected: 'Tell me what a closure is' },

  // Few-shot: STT wrong, with matching example
  { label: 'few-shot / STT wrong',
    instruction: 'What is the latest complete?',
    audio: commitRecording.chunks,
    corrections,
    expected: 'What is the latest commit?' },

  // Few-shot: STT correct, with unrelated example
  { label: 'few-shot / STT correct + unrelated example',
    instruction: 'Tell me what a closure is',
    audio: closureRecording.chunks,
    corrections,
    expected: 'Tell me what a closure is' },
];

for (const c of cases) {
  const results = [];
  for (let i = 0; i < 3; i++) {
    results.push(await correctInstruction(llm, c.instruction, c.audio, c.corrections));
  }
  const passes = results.filter(r => r === c.expected).length;
  console.log(`${passes}/3 ${c.label}`);
  console.log(`  input:    "${c.instruction}"`);
  console.log(`  expected: "${c.expected}"`);
  console.log(`  got:      ${results.map(r => `"${r}"`).join(', ')}`);
}
```

Run each case 3 times minimum to measure consistency.

### C. Constrained output (combine with A)

Force structured JSON to avoid ambiguity:

```typescript
const result = await llm.json<{ corrected: string; changed: boolean }>(
  messages,
  {
    type: 'object',
    properties: {
      corrected: { type: 'string' },
      changed: { type: 'boolean' },
    },
    required: ['corrected', 'changed'],
  },
);
```

The `changed` field eliminates the "return unchanged" ambiguity.



## Test assets

| Asset | Path | Notes |
|-------|------|-------|
| Recording | `vibecoded_apps/claude_talks/public/recordings/what_is_latest_commit.json` | 522 chunks, 16kHz PCM, ~4s |
| Recording | `vibecoded_apps/claude_talks/public/recordings/converse_closure_question.json` | Closure question |
| Test script | `vibecoded_apps/claude_talks/test-audio-correction.mjs` | Standalone Gemini Live test |
| Research log | `plans/002_stt_correction_research.md` | Full experiment history |
