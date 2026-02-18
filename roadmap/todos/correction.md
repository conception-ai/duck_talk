# Speech Correction Feedback Loop

## The problem

Gemini does two sequential steps when processing user speech. Both can fail:

```
Audio → [STT] → Transcription → [Reasoning] → Tool args instruction → Claude
         ↑                          ↑
    Gemini mishears            Gemini misinterprets
    (accent, noise)            (wrong intent, wrong args)
```

Errors cascade: wrong transcription → wrong reasoning. You can't evaluate reasoning until transcription is correct.

## Correction pipeline (long-term vision)

### Phase 1: STT correction (current priority)

**Goal**: Let the user correct what Gemini heard before anything is sent to Claude.

When learning mode is on and Gemini calls `converse`:
- Hold the tool call
- Show the user their transcription (what Gemini heard)
- Accept / Edit / Reject
- If edited: save STT correction (`heard` → `meant`), send corrected text to Claude
- Corrections injected into Gemini's system prompt on next session via `<STT_CORRECTIONS>`

**Key design decision**: In learning mode, the corrected transcription IS what gets sent to Claude. Gemini's tool args reformulation is bypassed. Claude is smart enough to interpret natural speech directly.

### Phase 2: Reasoning correction (future)

**Goal**: Once STT is correct, evaluate whether Gemini's interpretation was right.

Open questions:
- If STT was wrong and we corrected it, Gemini's tool args are stale (derived from wrong input). Would Gemini have gotten it right with correct input? Can't know without re-running.
- Should we re-derive tool args from corrected transcription? (requires another Gemini call)
- Or let the user write the instruction directly? (simpler, but loses Gemini's reformulation value)
- Separate `ReasoningCorrection` type with `<REASONING_CORRECTIONS>` prompt block

### Phase 3: Automated learning

- Accumulate enough corrections → fine-tune or few-shot prompt patterns
- Audio chunks stored in corrections enable potential acoustic model feedback
- Detect recurring patterns (e.g., user always says "conversations" but Gemini hears "conversions")
