# Claude.ai Tool Call UI — Design Analysis

> Reverse-engineered from a live Claude Code Web session on claude.ai (Feb 2025, Opus 4.6 Extended).
> Source conversation: a "Hello world FastAPI container setup" task involving file creation, bash scripts, error recovery, and long command output.

---

## Why This Document Exists

Claude.ai has a remarkably clean UI for rendering agentic tool calls — file writes, bash executions, thinking blocks, errors, and long outputs. Rather than showing raw JSON tool calls or walls of text, they compress everything into a scannable vertical timeline with progressive disclosure. This document captures every design decision we observed so any team can draw from it.

---

## Part 1: The Three Core Principles

### Principle 1 — Timeline, Not Chat Bubbles

The assistant response is **not** a chat bubble. It is a vertical timeline. Every piece of the response — narration text, tool calls, tool results, thinking — is a **node** in a single linear sequence connected by thin vertical lines.

**Why this works:** An agentic response is a *workflow*, not a *message*. A timeline communicates sequence, progress, and causality. Chat bubbles communicate turn-taking. The metaphor matches the content.

**Visual implementation:**
- A `1px` vertical line connects nodes via `w-[1px] h-full` divs centered in a `w-[20px]` column
- Each node has an `8px` top spacer containing the connector line, then the content row, then a bottom connector
- The entire timeline lives in a `flex flex-col font-ui leading-normal` container
- Nodes alternate between text narration and tool calls:
  ```
  [text] → [tool call] → [text] → [tool call] → [text] → [done]
  ```

### Principle 2 — Icon Vocabulary for Instant Scanning

Every node has a `20x20` SVG icon in a fixed `w-[20px]` column, left of the content. You can scan the icon column alone to understand the entire response without reading a word.

**Four icons, four meanings:**

| Icon | Visual | SVG viewBox | Used For |
|------|--------|-------------|----------|
| **Clock** | Circular clock face | `0 0 20 20` | Text narration ("Let me create...", "Working.") |
| **File** | Document with folded corner | `0 0 256 256` | File creation tool calls |
| **Terminal** | Console/prompt icon (3 SVG paths) | `0 0 20 20` | Script/bash execution tool calls |
| **Checkmark circle** | Circle with checkmark | `0 0 20 20` | Completion node ("Done") |
| **Sparkle** | Orange starburst (only icon with color) | `0 0 100 800` | Thinking/strategy header |

**Key design choice:** The sparkle is the *only* icon with a non-grey color (orange/coral). This makes the thinking block instantly findable as the "anchor" of the response.

### Principle 3 — Progressive Disclosure via Four Depth Layers

Information is hidden behind clicks at increasing levels of detail:

```
Layer 0: Collapsed summary header (one line, e.g. "Executed both requested commands successfully >")
  └─ Layer 1: Expanded timeline (all nodes visible with icons + text)
       └─ Layer 2: Expanded tool call (inline script output or side panel for files)
            └─ Layer 3: Scrollable output content (for long results like `pip list`)
```

The user chooses their depth. Casual review stays at Layer 0-1. Debugging drops to Layer 2-3. The layout never changes — only content is revealed or hidden.

---

## Part 2: Node Types in Detail

### Text Narration Nodes

**Purpose:** Claude's commentary between tool calls — explaining intent, transitions, status.

```
[clock icon] "Simple request, let me create a basic FastAPI hello world."
[clock icon] "Let me also install FastAPI and run it to verify it works."
[clock icon] "Working."
```

**Styling:**
- Icon class: `text-text-500` (muted grey)
- Text: plain paragraph, same `text-text-500` color
- No interaction — purely informational
- Connected to adjacent nodes by the vertical line

**Important:** These nodes are **hideable**. When the thinking header is collapsed, all text narration nodes disappear, leaving only tool call nodes visible. This is the "compact mode" toggle.

### Tool Call Nodes (File Creation)

**Purpose:** Represents a file write/create operation.

```
[file icon] "Create a FastAPI hello world app"        ← clickable button
              [main.py]                                ← file chip below
```

**Structure:**
- Row 1: `button` with `group/row flex flex-row items-center rounded-lg px-2.5 w-full` — the entire row is clickable
- Row 2: File chip — `button` styled as a pill with `cursor-pointer transition-colors text-text-500 hover:text-text-200 mx-2.5 mt-1`
- The chip shows the filename and the chip itself is also a separate clickable button

**Click behavior:** Opens a **side panel** on the right.
- The chat area compresses to ~50% width on the left
- Right panel shows:
  - Header: filename + extension label (e.g. "Main PY")
  - Controls: "Copy" button (with dropdown chevron), refresh icon, close (X)
  - Content: Full syntax-highlighted code with line numbers
- Sidebar collapses on close (X) — scroll position preserved

### Tool Call Nodes (Script/Bash Execution)

**Purpose:** Represents a shell command execution.

```
[terminal icon] "Install FastAPI and uvicorn"          ← clickable button
                  [Script]                             ← status chip below
```

**Structure:**
- Row 1: `button` — same layout as file tool calls
- Row 2: "Script" chip — changes color based on success/failure

**Click behavior:** **Inline expansion** directly below the button in the timeline.

Expanded view has two sections in a single code block container:
```
┌─────────────────────────────────────────────┐
│ bash                                         │
│ pip install fastapi uvicorn --break-system-  │
│ packages -q                                  │
├─────────────────────────────────────────────┤
│ Output                                       │
│ exit code 0                                  │
└─────────────────────────────────────────────┘
```

- "bash" label at top of command section
- Syntax highlighting on the command (keywords like `install`, `curl` get colored)
- "Output" label at top of result section
- Both sections in monospace font

**Why files get a side panel but scripts get inline:** Files are *artifacts* you might want to reference while continuing to read. Scripts are *actions* whose results matter in the flow — they belong in the timeline.

### Thinking/Strategy Header

**Purpose:** The anchor node for the entire response. Summarizes what Claude did.

```
[sparkle icon] "Marshaled resources to construct containerized FastAPI application"  [v]
```

**Behavior — The Master Toggle:**
- **Collapsed (> chevron):** Hides the entire timeline. Only the summary text below (final answer) remains visible.
- **Expanded (v chevron):** Shows the full timeline with all nodes.
- The sparkle icon is **orange** in collapsed state, changes to a simpler icon when expanded.

**The summary text is AI-generated.** It's not "Thinking..." or a static label. Claude generates a descriptive summary of all actions (e.g. "Marshaled resources to construct containerized FastAPI application", "Executed both requested commands successfully"). This text can differ across page loads.

### Completion Node

```
[checkmark-circle icon] "Done"
```

A terminal node indicating the agentic workflow finished. Uses a distinct checkmark-in-circle SVG. Same muted `text-text-500` styling as narration.

---

## Part 3: Error Handling

### Chip Color Signaling

The **only** visual difference between a successful and failed script is the "Script" chip color:

| State | CSS Class | Color | RGB |
|-------|-----------|-------|-----|
| **Success** | `text-text-500 hover:text-text-200` | Grey | `rgb(156, 154, 146)` |
| **Error** | `text-danger-000 hover:text-danger-100` | Red/coral | `rgb(254, 129, 129)` |

Everything else stays identical — same icon, same layout, same button behavior. No alert boxes, no error banners, no layout shifts. You scan the chip colors to find failures.

### Error Recovery Pattern

When a script fails, Claude's response shows the natural retry flow in the timeline:

```
[terminal] "Start server and test endpoints"
             [Script]  ← RED chip (failed)
[clock]    "Let me try again with a slightly different approach."
[terminal] "Test the FastAPI app using TestClient"
             [Script]  ← RED chip (failed again)
[clock]    "Let me install httpx and try again."
[terminal] "Install httpx and test"
             [Script]  ← grey chip (success)
[clock]    "Working."
[check]    "Done"
```

The timeline naturally tells the story of debugging — each retry is just another node. No special "error state" UI is needed because the timeline *is* the error narrative.

---

## Part 4: Long Output Handling

### The 200px Scroll Container

When a script produces long output (e.g. `pip list` with 150+ packages), the output section is constrained:

```css
max-h-[200px] overflow-y-auto [&_pre]:!text-xs [&_code]:!text-xs
```

| Property | Value | Effect |
|----------|-------|--------|
| `max-h-[200px]` | 200px cap | Output never grows taller than ~10 lines |
| `overflow-y-auto` | Internal scrollbar | Users scroll within the output area |
| `[&_pre]:!text-xs` | Force extra-small text | Fits more content per line |
| `[&_code]:!text-xs` | Force extra-small text | Consistent with pre blocks |

**Observed example:** `pip list` output was 3487px of content rendered in a 200px container — a 17:1 compression ratio. The scrollbar is the only indicator that more content exists.

**Design implication:** The output is *available* but *not promoted*. The timeline stays compact. Users who need the raw output scroll into it; everyone else skips past.

---

## Part 5: Streaming & In-Progress States

### Phase Sequence During Generation

1. **Thinking phase:**
   - Orange sparkle icon appears immediately
   - Summary text streams in next to it (e.g. "Thinking about concerns with this request")
   - Tool calls begin appearing below with grey "Script" chips *before execution starts* — they're queued

2. **Tool execution phase:**
   - Tool calls appear in the timeline as dispatched
   - No spinner on individual tool calls — they just appear in sequence
   - The **stop button** (circle icon) replaces the send arrow in bottom-right

3. **Text streaming phase:**
   - Final summary text streams below the timeline
   - An **audio waveform icon** (||||) appears next to the model selector during active streaming

### No Spinners, No Progress Bars

There are no loading spinners on individual tool calls. The streaming appearance of nodes *is* the progress indicator. The timeline grows downward as work happens — the scroll position is the progress bar.

---

## Part 6: End-of-Response Elements

### File Download Card

When the response creates a file artifact, a download card appears at the bottom:

```
┌──────────────────────────────────────────┐
│  [file icon]  Main           [Download]  │
│               PY                         │
└──────────────────────────────────────────┘
```

- Distinct bordered container, visually separate from the timeline
- File icon + name + extension label on the left
- "Download" button on the right
- Below: a collapsible "Presented file >" section (another layer of progressive disclosure)

### Response Action Bar

Below each completed response:

```
[copy] [thumbs-up] [thumbs-down] [retry]     "1:48 PM"
```

- Four icon buttons in a row
- Timestamp appears on hover (revealed via the `group` CSS pattern)
- The bar is `invisible` by default, shown on hover over the response container

---

## Part 7: DOM Architecture Reference

### Overall Response Structure

```html
<div class="grid grid-rows-[auto_auto] min-w-0">
  <!-- Row 1: Thinking/strategy header (collapsible) -->
  <div class="row-start-1 col-start-1 min-w-0">
    <button class="group/status flex items-center gap-2 py-1 text-sm">
      <!-- sparkle SVG + summary text -->
    </button>
    <status role="status"><!-- screen reader text --></status>
  </div>

  <!-- Row 2: The timeline -->
  <div class="row-start-2 col-start-1 relative grid isolate min-w-0">
    <!-- Z-layer 2: connector line background -->
    <div class="row-start-1 col-start-1 relative z-[2] min-w-0" />

    <!-- Z-layer 3: actual content -->
    <div class="row-start-1 col-start-1 relative min-w-0 z-[3] pl-2">
      <div class="flex flex-col font-ui leading-normal">
        <!-- Node 0: text narration -->
        <!-- Node 1: tool call -->
        <!-- Node 2: text narration -->
        <!-- Node 3: tool call -->
        <!-- ... -->
      </div>
    </div>
  </div>
</div>
```

### Individual Node Structure

```html
<div> <!-- wrapper -->
  <div> <!-- inner -->
    <div class="flex flex-col shrink-0">

      <!-- Top connector spacer -->
      <div class="flex flex-row h-[8px]">
        <div class="w-[20px] flex justify-center">
          <div class="w-[1px] h-full duration-150" /> <!-- vertical line -->
        </div>
      </div>

      <!-- Content row -->
      <div class="transition-colors rounded-lg duration-150">
        <div class="flex flex-row">
          <!-- Icon column (fixed width) -->
          <div class="flex w-[20px] justify-center">
            <svg width="20" height="20" viewBox="..."><!-- icon --></svg>
          </div>
          <!-- Content column -->
          <div class="pl-2 py-1.5 min-w-0">
            <!-- For text nodes: plain paragraph -->
            <!-- For tool calls: button + chip -->
          </div>
        </div>
      </div>

      <!-- Bottom connector spacer (same pattern as top) -->
    </div>
  </div>
</div>
```

### Tool Call Button

```html
<button class="group/row flex flex-row items-center rounded-lg px-2.5 w-full justify-between text-text-300 hover:text-text-200">
  <span>Create a FastAPI hello world app</span>
</button>
```

### Script Chip (Success vs Error)

```html
<!-- Success -->
<button class="flex items-center transition-colors cursor-pointer text-text-500 hover:text-text-200">
  Script
</button>

<!-- Error -->
<button class="flex items-center transition-colors cursor-pointer text-danger-000 hover:text-danger-100">
  Script
</button>
```

### Script Output Container

```html
<div class="p-2 flex flex-col gap-2 max-h-[200px] overflow-y-auto [&_pre]:!text-xs [&_code]:!text-xs">
  <!-- Command section -->
  <div>
    <span>bash</span>
    <code>pip install fastapi uvicorn --break-system-packages -q</code>
  </div>
  <!-- Output section -->
  <div>
    <span>Output</span>
    <code>exit code 0</code>
  </div>
</div>
```

---

## Part 8: Design Principles Summary

These are the transferable principles — applicable regardless of framework or stack.

1. **Timeline over chat bubbles.** Agentic workflows are sequences of actions, not conversational turns. Render them as progress logs.

2. **Icon vocabulary for scanning.** Four icons, four meanings. A user can scan the icon column in <1 second to understand what happened. No reading required.

3. **Progressive disclosure in layers.** Four depth levels: collapsed summary → expanded timeline → expanded tool call → scrollable output. Each click reveals more. The default state shows the minimum.

4. **Match expansion pattern to content type.** Files open in side panels (reference material, persist across scroll). Scripts expand inline (action results, part of the narrative flow).

5. **Color-only error signaling.** A red chip vs a grey chip. No layout shifts, no error banners, no modal dialogs. The timeline structure stays stable; only color changes.

6. **Cap output, don't truncate it.** Long outputs get a `200px` scrollable container, not a "show more" button or truncation with ellipsis. The content is all there — just not promoted.

7. **AI-generated summary headers.** The collapsible header isn't "Thinking..." — it's a generated description of what was accomplished. This gives the collapsed state actual informational value.

8. **Chips as metadata.** File names (`main.py`) and status labels (`Script`) appear as small pill-shaped chips below tool call buttons. They provide context without competing with the main text.

9. **Muted text hierarchy.** Three levels: user messages at full contrast, tool call names slightly dimmer, narration text at `text-text-500` (most muted). Your eye naturally finds what matters.

10. **Everything interactive is a button.** Tool call rows, file chips, script chips, the thinking header — all are `<button>` elements with hover states. The entire timeline is clickable. Nothing looks dead.

11. **No spinners.** The timeline growing downward *is* the loading state. Nodes appear as work happens. The scroll position is the progress bar.

12. **Stable layout under all states.** Errors don't add boxes. Long output doesn't push content. Expansion happens in-place or in a side panel. The main timeline geometry never changes.
