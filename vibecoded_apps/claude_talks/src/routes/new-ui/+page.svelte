<script lang="ts">
  import { marked } from 'marked';
  import { push } from 'svelte-spa-router';
  import type { ContentBlock, Message } from '../live/types';

  // --- State ---
  type SimState = 'idle' | 'recording' | 'approval' | 'streaming';
  let simState = $state<SimState>('idle');
  let transcription = $state('');
  let streamingText = $state('');

  // --- Audio-reactive waveform ---
  const NUM_BARS = 16;
  let audioLevels = $state<number[]>(new Array(NUM_BARS).fill(0));
  let micCtx: AudioContext | null = null;
  let micStream: MediaStream | null = null;
  let rafId = 0;

  async function startRecording() {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    const ctx = new AudioContext({ sampleRate: 16000 });
    const source = ctx.createMediaStreamSource(stream);
    const analyser = ctx.createAnalyser();
    analyser.fftSize = 256;
    source.connect(analyser);
    micCtx = ctx;
    micStream = stream;

    const buf = new Float32Array(analyser.fftSize);
    const segSize = Math.floor(buf.length / NUM_BARS);
    function tick() {
      analyser.getFloatTimeDomainData(buf);
      audioLevels = Array.from({ length: NUM_BARS }, (_, i) => {
        let sum = 0;
        for (let j = 0; j < segSize; j++) {
          const v = buf[i * segSize + j];
          sum += v * v;
        }
        return Math.min(1, Math.sqrt(sum / segSize) * 3);
      });
      rafId = requestAnimationFrame(tick);
    }
    rafId = requestAnimationFrame(tick);
    simState = 'recording';
  }

  function stopRecording() {
    cancelAnimationFrame(rafId);
    micStream?.getTracks().forEach((t) => t.stop());
    void micCtx?.close();
    micCtx = null;
    micStream = null;
    audioLevels = new Array(NUM_BARS).fill(0);
  }

  // Simulated text intervals (transcription + streaming — not audio)
  let simInterval: ReturnType<typeof setInterval> | undefined;

  const MOCK_MESSAGES: Message[] = [
    { role: 'user', content: 'What is the latest commit?' },
    {
      role: 'assistant',
      content: [
        {
          type: 'text',
          text: 'The latest commit is `a0b8af3` with message "snapshot", made about 2 hours ago on the `main` branch.',
        },
        {
          type: 'tool_use',
          id: 't1',
          name: 'Bash',
          input: { command: 'git log --oneline -1' },
        },
      ],
    },
    { role: 'user', content: 'Can you explain the architecture of the live page?' },
    {
      role: 'assistant',
      content: [
        {
          type: 'thinking',
          thinking:
            'The user wants to understand the architecture. Let me look at the key files...',
        },
        {
          type: 'text',
          text: "The live page uses a **two-session Gemini architecture**:\n\n1. **Outer session** — handles STT and orchestration via VAD\n2. **Inner TTS session** — ephemeral, speaks Claude's responses\n\nThe `converse` tool is **BLOCKING** — Gemini freezes while Claude streams. This prevents audio overlap.",
        },
      ],
    },
    { role: 'user', content: 'Add a health check endpoint to the FastAPI server' },
    {
      role: 'assistant',
      content: [
        {
          type: 'text',
          text: "I'll add a `/health` endpoint to the FastAPI server. Let me first check the current server setup.",
        },
        {
          type: 'tool_use',
          id: 't2',
          name: 'Read',
          input: { file_path: 'api/server.py' },
        },
        {
          type: 'text',
          text: "I've added the health check endpoint:\n\n```python\n@app.get(\"/health\")\ndef health():\n    return {\"status\": \"ok\", \"timestamp\": datetime.utcnow().isoformat()}\n```\n\nIt returns the current server status and timestamp. You can test it with:\n```bash\ncurl http://localhost:8000/health\n```",
        },
        {
          type: 'tool_use',
          id: 't3',
          name: 'Edit',
          input: { file_path: 'api/server.py', old_string: 'app = FastAPI()', new_string: '...' },
        },
      ],
    },
    { role: 'user', content: 'Now run the tests to make sure nothing is broken' },
    {
      role: 'assistant',
      content: [
        {
          type: 'thinking',
          thinking: 'The user wants to run tests. Let me check if there are existing test files and run them.',
        },
        {
          type: 'tool_use',
          id: 't4',
          name: 'Bash',
          input: { command: 'python -m pytest tests/ -v' },
        },
        {
          type: 'text',
          text: "All tests pass:\n\n- `test_health_check` — **PASSED**\n- `test_list_sessions` — **PASSED**\n- `test_converse_stream` — **PASSED**\n- `test_get_messages` — **PASSED**\n\n4 passed, 0 failed. The health check endpoint is working correctly and no existing functionality was broken.",
        },
      ],
    },
    { role: 'user', content: 'What files were modified in this session?' },
    {
      role: 'assistant',
      content: [
        {
          type: 'text',
          text: "In this session I modified:\n\n1. **`api/server.py`** — added the `/health` GET endpoint with status and timestamp response\n2. **`tests/test_server.py`** — added `test_health_check` to verify the new endpoint\n\nBoth changes are minimal and focused. The health check is a simple synchronous endpoint that doesn't touch any of the session or Claude Code logic.",
        },
      ],
    },
  ];

  let messages = $state<Message[]>([...MOCK_MESSAGES]);

  // --- Simulation helpers (text only — audio is real) ---
  function clearSim() {
    clearInterval(simInterval);
    simInterval = undefined;
  }

  function setState(s: SimState) {
    clearSim();
    stopRecording();
    transcription = '';
    streamingText = '';
    messages = [...MOCK_MESSAGES];
    simState = s;

    if (s === 'recording') {
      const words = 'Fix the authentication bug in the login flow please'.split(' ');
      let wi = 0;
      simInterval = setInterval(() => {
        if (wi < words.length) {
          transcription += (wi > 0 ? ' ' : '') + words[wi];
          wi++;
        }
      }, 300);
      startRecording();
    }

    if (s === 'approval') {
      transcription = 'Fix the authentication bug in the login flow please';
      startRecording();
    }

    if (s === 'streaming') {
      messages = [...MOCK_MESSAGES, { role: 'user', content: 'Fix the authentication bug in the login flow' }];
      const fullText =
        "I'll fix the authentication bug. Let me start by reading the login handler to understand the current flow.\n\nLooking at the code, I can see the issue — the session token validation is checking expiry with `<` instead of `<=`, causing tokens to be rejected exactly at their expiry time.";
      let ci = 0;
      simInterval = setInterval(() => {
        if (ci < fullText.length) {
          const chunk = fullText.slice(ci, ci + 3);
          streamingText += chunk;
          ci += 3;
        } else {
          clearSim();
        }
      }, 30);
    }
  }

  // --- Helpers ---
  function messageText(msg: Message): string {
    if (typeof msg.content === 'string') return msg.content;
    return msg.content
      .filter((b): b is Extract<ContentBlock, { type: 'text' }> => b.type === 'text')
      .map((b) => b.text)
      .join('\n');
  }

  function messageToolUses(msg: Message): Extract<ContentBlock, { type: 'tool_use' }>[] {
    if (typeof msg.content === 'string') return [];
    return msg.content.filter(
      (b): b is Extract<ContentBlock, { type: 'tool_use' }> => b.type === 'tool_use',
    );
  }

  function messageHasThinking(msg: Message): boolean {
    if (typeof msg.content === 'string') return false;
    return msg.content.some((b) => b.type === 'thinking');
  }

  // Dev toolbar state
  let showToolbar = $state(true);
</script>

<main>
  <!-- Header -->
  <header>
    <button class="header-link" onclick={() => push('/')}>Home</button>
    <span class="spacer"></span>
    <button class="header-link" onclick={() => push('/live')}>Settings</button>
  </header>

  <!-- Chat zone -->
  <div class="chat-scroll">
    <div class="chat">
      {#each messages as msg}
        {#if msg.role === 'user'}
          <div class="bubble user">
            <p>{typeof msg.content === 'string' ? msg.content : messageText(msg)}</p>
          </div>
        {:else}
          <div class="bubble assistant">
            {#if messageHasThinking(msg)}
              <details class="thinking">
                <summary>Thinking...</summary>
              </details>
            {/if}
            {#if messageText(msg)}
              <div class="prose">{@html marked.parse(messageText(msg))}</div>
            {/if}
            {#each messageToolUses(msg) as tool}
              <div class="tool-pill">
                <span class="tool-name">{tool.name}</span>
              </div>
            {/each}
          </div>
        {/if}
      {/each}

      <!-- Streaming assistant response -->
      {#if simState === 'streaming' && streamingText}
        <div class="bubble assistant streaming">
          <div class="prose">{@html marked.parse(streamingText)}</div>
          <div class="dots"><span></span><span></span><span></span></div>
        </div>
      {/if}
    </div>
  </div>

  <!-- Bottom dock: transcription float + input bar -->
  <div class="dock">
    <!-- Transcription float (recording or approval) -->
    {#if simState === 'recording' && transcription}
      <div class="float transcription">
        <p>{transcription}</p>
      </div>
    {/if}

    {#if simState === 'approval'}
      <div class="float approval">
        <p>{transcription}</p>
        <div class="approval-actions">
          <button class="btn-accept" onclick={() => setState('streaming')}>Accept</button>
          <button class="btn-secondary" onclick={() => setState('approval')}>Edit</button>
          <button class="btn-reject" onclick={() => setState('idle')}>Reject</button>
        </div>
      </div>
    {/if}

    <!-- Input bar -->
    <div class="input-bar">
      {#if simState === 'recording' || simState === 'approval'}
        <div class="waveform">
          {#each audioLevels as level}
            <span class="bar" style="height: {4 + level * 24}px"></span>
          {/each}
        </div>
        <button class="mic-btn active" onclick={() => { stopRecording(); simState = 'idle'; }}>
          <svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor">
            <rect x="6" y="6" width="12" height="12" rx="2" />
          </svg>
        </button>
      {:else}
        <span class="placeholder">Reply...</span>
        <button
          class="mic-btn"
          class:pulsing={simState === 'streaming'}
          onclick={() => startRecording()}
        >
          <svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor">
            <path d="M12 14c1.66 0 3-1.34 3-3V5c0-1.66-1.34-3-3-3S9 3.34 9 5v6c0 1.66 1.34 3 3 3zm5.3-3c0 3-2.54 5.1-5.3 5.1S6.7 14 6.7 11H5c0 3.41 2.72 6.23 6 6.72V21h2v-3.28c3.28-.48 6-3.3 6-6.72h-1.7z" />
          </svg>
        </button>
      {/if}
    </div>
  </div>

  <!-- Dev toolbar -->
  {#if showToolbar}
    <div class="toolbar">
      <span class="toolbar-label">State:</span>
      {#each ['idle', 'recording', 'approval', 'streaming'] as s}
        <button
          class="toolbar-btn"
          class:active={simState === s}
          onclick={() => setState(s as SimState)}
        >{s}</button>
      {/each}
      <button class="toolbar-btn close" onclick={() => showToolbar = false}>x</button>
    </div>
  {/if}
</main>

<style>
  /* --- Layout --- */
  main {
    width: 100%;
    height: 100dvh;
    display: flex;
    flex-direction: column;
    font-family: system-ui, -apple-system, sans-serif;
    background: #fafafa;
    color: #1a1a1a;
  }

  header {
    display: flex;
    align-items: center;
    padding: 0.5rem 1rem;
    max-width: 640px;
    width: 100%;
    margin: 0 auto;
    box-sizing: border-box;
  }

  .header-link {
    font-size: 0.8rem;
    color: #888;
    border: none;
    background: none;
    cursor: pointer;
    padding: 0.25rem 0;
  }

  .header-link:hover { color: #333; }
  .spacer { flex: 1; }

  /* --- Chat --- */
  .chat-scroll {
    flex: 1;
    min-height: 0;
    overflow-y: auto;
  }

  .chat {
    max-width: 640px;
    width: 100%;
    margin: 0 auto;
    padding: 0.5rem 1rem 1rem;
    box-sizing: border-box;
    display: flex;
    flex-direction: column;
    gap: 0.75rem;
  }

  .bubble {
    max-width: 85%;
    line-height: 1.5;
    font-size: 0.9rem;
  }

  .bubble.user {
    align-self: flex-end;
    background: #f0f0f0;
    padding: 0.5rem 0.75rem;
    border-radius: 1rem 1rem 0.25rem 1rem;
  }

  .bubble.user p { margin: 0; }

  .bubble.assistant {
    align-self: flex-start;
    padding: 0.25rem 0;
  }

  .bubble.streaming {
    opacity: 0.7;
  }

  /* --- Markdown prose --- */
  .prose :global(p) { margin: 0.25rem 0; }
  .prose :global(strong) { font-weight: 600; }
  .prose :global(code) {
    font-size: 0.82rem;
    background: rgba(0,0,0,0.05);
    padding: 0.1rem 0.3rem;
    border-radius: 3px;
  }
  .prose :global(pre) {
    margin: 0.4rem 0;
    padding: 0.5rem;
    background: rgba(0,0,0,0.04);
    border-radius: 6px;
    overflow-x: auto;
    font-size: 0.8rem;
  }
  .prose :global(pre code) { background: none; padding: 0; }
  .prose :global(ol), .prose :global(ul) {
    margin: 0.25rem 0;
    padding-left: 1.25rem;
  }

  /* --- Tool pills --- */
  .tool-pill {
    display: inline-block;
    margin-top: 0.25rem;
  }

  .tool-name {
    font-size: 0.75rem;
    font-family: monospace;
    padding: 0.15rem 0.5rem;
    border-radius: 1rem;
    background: #ede9fe;
    color: #7c3aed;
  }

  /* --- Thinking --- */
  .thinking {
    font-size: 0.8rem;
    color: #999;
    margin-bottom: 0.25rem;
  }

  .thinking summary {
    cursor: pointer;
    font-style: italic;
  }

  /* --- Dots --- */
  .dots {
    display: flex;
    gap: 4px;
    margin-top: 0.5rem;
  }

  .dots span {
    width: 5px;
    height: 5px;
    border-radius: 50%;
    background: #999;
    animation: dot-pulse 1.4s ease-in-out infinite;
  }
  .dots span:nth-child(2) { animation-delay: 0.2s; }
  .dots span:nth-child(3) { animation-delay: 0.4s; }

  @keyframes dot-pulse {
    0%, 80%, 100% { opacity: 0.3; transform: scale(0.8); }
    40% { opacity: 1; transform: scale(1); }
  }

  /* --- Dock (bottom area) --- */
  .dock {
    flex-shrink: 0;
    max-width: 640px;
    width: 100%;
    margin: 0 auto;
    padding: 0 0.75rem 0.5rem;
    box-sizing: border-box;
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
  }

  /* --- Float (transcription + approval) --- */
  .float {
    padding: 0.6rem 0.75rem;
    border-radius: 0.75rem;
    font-size: 0.85rem;
    animation: slide-up 0.15s ease-out;
  }

  .float.transcription {
    background: rgba(255, 255, 255, 0.85);
    backdrop-filter: blur(12px);
    border: 1px solid #e0e0e0;
    color: #555;
    font-style: italic;
  }

  .float.transcription p { margin: 0; }

  .float.approval {
    background: white;
    border: 1.5px solid #059669;
    color: #1a1a1a;
  }

  .float.approval p { margin: 0 0 0.5rem; }

  .approval-actions {
    display: flex;
    gap: 0.5rem;
    justify-content: flex-end;
  }

  .approval-actions button {
    font-size: 0.8rem;
    padding: 0.3rem 0.75rem;
    border-radius: 0.25rem;
    cursor: pointer;
    border: 1px solid;
    background: none;
  }

  .btn-accept { color: #059669; border-color: #059669; }
  .btn-accept:hover { background: #059669; color: white; }
  .btn-secondary { color: #666; border-color: #ccc; }
  .btn-reject { color: #dc2626; border-color: #dc2626; }
  .btn-reject:hover { background: #dc2626; color: white; }

  @keyframes slide-up {
    from { opacity: 0; transform: translateY(8px); }
    to { opacity: 1; transform: translateY(0); }
  }

  /* --- Input bar --- */
  .input-bar {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    padding: 0.4rem 0.5rem 0.4rem 0.75rem;
    background: white;
    border: 1px solid #e0e0e0;
    border-radius: 1.5rem;
    box-shadow: 0 1px 3px rgba(0,0,0,0.04);
  }

  .placeholder {
    flex: 1;
    font-size: 0.85rem;
    color: #aaa;
  }

  /* --- Waveform --- */
  .waveform {
    flex: 1;
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 3px;
    padding: 0.2rem 0;
  }

  .bar {
    width: 3px;
    border-radius: 1.5px;
    background: #059669;
    transition: height 0.1s ease-out;
    min-height: 4px;
  }

  /* --- Mic button --- */
  .mic-btn {
    flex-shrink: 0;
    width: 34px;
    height: 34px;
    border-radius: 50%;
    border: none;
    background: #eee;
    color: #666;
    cursor: pointer;
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 0;
    transition: background 0.15s, color 0.15s;
  }

  .mic-btn:hover { background: #ddd; }

  .mic-btn.active {
    background: #dc2626;
    color: white;
  }

  .mic-btn.pulsing {
    animation: gentle-pulse 2s ease-in-out infinite;
  }

  @keyframes gentle-pulse {
    0%, 100% { opacity: 0.5; }
    50% { opacity: 1; }
  }

  /* --- Dev toolbar --- */
  .toolbar {
    position: fixed;
    top: 0.5rem;
    right: 0.5rem;
    display: flex;
    gap: 0.25rem;
    align-items: center;
    padding: 0.3rem 0.5rem;
    background: #1a1a1a;
    border-radius: 0.5rem;
    z-index: 999;
    box-shadow: 0 2px 8px rgba(0,0,0,0.2);
  }

  .toolbar-label {
    font-size: 0.7rem;
    color: #888;
    margin-right: 0.25rem;
  }

  .toolbar-btn {
    font-size: 0.7rem;
    padding: 0.2rem 0.5rem;
    border: 1px solid #444;
    border-radius: 0.25rem;
    background: none;
    color: #aaa;
    cursor: pointer;
  }

  .toolbar-btn:hover { border-color: #888; color: white; }
  .toolbar-btn.active { background: #333; color: white; border-color: #666; }
  .toolbar-btn.close { border-color: #666; color: #666; margin-left: 0.25rem; }
</style>
