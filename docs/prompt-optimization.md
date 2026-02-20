# Iterative Prompt Optimization

A systematic method for improving LLM system prompts through controlled experimentation instead of vibes.

## The problem with prompt editing

The default approach is: edit the prompt, try it, see if it "feels better." This fails because:
- You can't tell what changed if you changed the prompt AND the input
- You can't tell if improvement on one input broke another
- You remember the bad output but not the good parts you lost
- You optimize for the last failure you saw, not the overall distribution

## The method

The core idea is borrowed from experimental science: hold inputs constant, vary the prompt, measure outputs. This turns prompt engineering from art into iteration.

### Step 1: Collect evidence from production

Don't invent test cases. Find a real conversation that exhibits the problem. Load it, dump every message, read the actual outputs. The real conversation contains failure modes you wouldn't think to script.

In our case: we loaded a JSONL session file, extracted all user/assistant text along the active conversation path, and read through every message untruncated. This revealed that assistant responses were 1,900-3,500 characters — full specification dumps spoken aloud through TTS.

### Step 2: Diagnose the root cause, not the symptom

Don't start with "make it shorter." Ask WHY it's long.

Separate the layers:
- Is the prompt addressing the right dimension? (formatting vs. information volume vs. structure)
- Is there a missing constraint? (no length cap, no stop signal)
- Is there a wrong mental model? (the LLM thinks it's writing a document, not having a conversation)

We found the existing prompt addressed **formatting** (no markdown, use contractions) but not **information dosing** (how much to say). That's a category error — like fixing a flooding problem by changing the color of the pipes.

### Step 3: Form a specific hypothesis

Not "make the prompt better." A testable claim:

- "Adding a hard sentence count (2-3 sentences) will reduce response length by >50%"
- "Adding 'skip filler phrases' with anti-examples will eliminate narration overhead"
- "Adding 'end with a hook' will make short answers feel complete instead of abrupt"

Each hypothesis targets one dimension. You can stack them, but you should know which one is doing the work.

### Step 4: Replay the same conversation

This is the key move that makes it scientific:

1. Take the exact same user turns from your evidence conversation (Step 1)
2. Send them to the LLM with the new prompt
3. **Use session continuity** — same session ID across turns so context builds naturally
4. Record every response with its character count

Same inputs. Different prompt. Fresh session. Controlled comparison.

### Step 5: Analyze per-turn, not in aggregate

Different turn types stress different prompt behaviors:
- A simple factual question tests baseline conciseness
- A "list things" request tests enumeration strategy
- A "tell me more" follow-up tests progressive disclosure depth

A prompt that nails turn 1 might still fail on turn 3. Look at each turn individually. For each one ask:
- Is the length appropriate?
- Is the information complete? (Brevity that drops the answer is a regression)
- Is the tone right?
- Does it invite follow-up or dead-end?

### Step 6: Hypothesize again from the analysis

Round 1 results generate Round 2 hypotheses. This is the iteration loop:

```
evidence → diagnosis → hypothesis → experiment → analysis → new hypothesis → ...
```

Usually 2-3 rounds is enough. You hit diminishing returns quickly — at that point you're overfitting to your test conversation. When two consecutive rounds produce similar quality, ship it.

### Step 7: Ship and document

Write the winning prompt to the actual file. Document what you tested and what you learned so the next person (or you in 3 months) doesn't re-derive everything from scratch.

## What makes this work

**Holding inputs constant** is the entire trick. Without it, you're changing two variables at once (prompt AND input) and can't attribute outcomes. With it, you can see exactly what each prompt change does.

**Skipping the baseline when you have production evidence.** If you already loaded a real conversation and saw the problem, you don't need to re-run it — you have the data. Jump straight to your first hypothesis. We skipped Round 0 because the session dump WAS the baseline.

**Per-turn analysis over aggregate metrics.** Average response length is misleading. A prompt that produces one perfect answer and one terrible answer has the same average as a prompt that produces two mediocre answers. Look at each turn.

**Anti-examples in constraints.** "Be concise" does nothing. "Skip filler phrases — don't say 'let me check that for you' or 'let me read the file'" works. The LLM needs concrete examples of what NOT to do, not abstract directives.

**Hooks as a design pattern.** When you constrain length, responses can feel abrupt. Adding "end with a hook" ("want the implementation details?") turns a dead-end into a conversation. This is the mechanism that makes progressive disclosure work — short answers that invite depth.

## Applied: voice output optimization

We applied this method to optimize a system prompt for a voice agent where Claude's text output is read aloud through TTS.

**Evidence:** Loaded a real 3-turn conversation. Responses were 1,900-3,500 chars — full specs and implementation plans read aloud as monologues.

**Diagnosis:** The prompt constrained formatting (no markdown) but not volume. The model produced natural-sounding walls of text.

**Round 1 hypothesis:** Add three rules — hard sentence cap ("2-3 by default"), progressive disclosure ("let the user pick what to expand"), and voice medium awareness ("every extra sentence costs 5-10 seconds").

**Round 1 results:**

| Turn | Baseline | Round 1 | Reduction |
|------|----------|---------|-----------|
| Simple question | ~200 chars | 129 | 35% |
| List items | ~1,968 | 366 | 81% |
| Elaborate | ~3,548 | 435 | 88% |

Good length reduction. But: filler phrases still present ("let me read the file for you"), missing follow-up hooks, one turn under-delivered on information.

**Round 2 hypothesis:** Add "skip filler phrases" with anti-examples, add "end with a hook" rule.

**Round 2 results:**

| Turn | Round 1 | Round 2 | Change |
|------|---------|---------|--------|
| Simple question | 129 | 64 | -50% (filler eliminated) |
| List items | 366 | 229 | -37% (tighter, all items included) |
| Elaborate | 435 | 477 | +10% (but better content — includes hook) |

Round 2 was better on every dimension except raw length on turn 3, which gained a follow-up hook ("want to tackle it?") that made the interaction feel complete. Shipped it.

**Key finding:** The leverage was overwhelmingly in information dosing (60-90% reduction), not formatting (10-15% reduction from removing markdown syntax). This would have been invisible without controlled comparison.
