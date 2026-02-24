<script lang="ts">
  import { marked } from 'marked';
  import { tick } from 'svelte';
  import { push, replace } from 'svelte-spa-router';
  import { createDataStore } from './stores/data.svelte';
  import { createUIStore } from './stores/ui.svelte';
  import { createCorrectionsStore } from './stores/corrections.svelte';
  import { startMic, playPcmChunks } from './audio';
  import { speak } from '../../lib/tts';
  import { createConverseApi } from './converse';
  import { DEFAULT_SYSTEM_PROMPT } from './defaults';
  import { setup as setupRecorder } from '../../lib/recorder';
  import type { ContentBlock, InteractionMode, Message } from './types';
  import {
    messageText,
    messageToolUses,
    messageThinking,
    buildToolResultMap,
    isToolResultOnly,
  } from '../../lib/message-helpers';

  setupRecorder();

  let { params } = $props<{ params?: { id?: string } }>();

  const ui = createUIStore();
  const corrections = createCorrectionsStore();

  const live = createDataStore({
    audio: { startMic },
    api: createConverseApi('/api/converse', () => ({
      model: ui.model,
      systemPrompt: ui.systemPrompt,
      permissionMode: ui.permissionMode,
    })),
    getApiKey: () => ui.apiKey,
    getMode: () => ui.mode,
    readbackInstruction: (text: string) => {
      let cancelled = false;
      let stop: (() => void) | undefined;
      if (!ui.readbackEnabled || !ui.apiKey) return () => {};
      speak(ui.apiKey, text).then(({ data, sampleRate }) => {
        if (cancelled) return;
        stop = playPcmChunks([data], sampleRate).stop;
      }).catch((e) => console.error('[readback]', e));
      return () => { cancelled = true; stop?.(); };
    },
  });

  // Load session history if route has an ID
  let historyLoading = $state(false);
  if (params?.id) {
    historyLoading = true;
    fetch(`/api/sessions/${params.id}/messages`)
      .then((res) => {
        if (!res.ok) throw new Error(`${res.status}`);
        return res.json();
      })
      .then((msgs: Message[]) => {
        live.loadHistory(msgs, params!.id!);
      })
      .catch((e) => {
        console.error('[live] failed to load history:', e);
      })
      .finally(() => {
        historyLoading = false;
      });
  }

  let resultMap = $derived(buildToolResultMap(live.messages));

  // --- Backend config name ---
  let configName = $state('');
  fetch('/api/config').then(r => r.json()).then(d => { configName = d.config; }).catch(() => {});

  // --- Settings modal state ---
  let settingsOpen = $state(!ui.apiKey);
  let keyDraft = $state(ui.apiKey ?? '');
  let readbackDraft = $state(ui.readbackEnabled);
  let modeDraft = $state<InteractionMode>(ui.mode);
  let modelDraft = $state(ui.model);
  let permissionModeDraft = $state(ui.permissionMode);
  let promptDraft = $state(ui.systemPrompt);

  function openSettings() {
    keyDraft = ui.apiKey ?? '';
    readbackDraft = ui.readbackEnabled;
    modeDraft = ui.mode;
    modelDraft = ui.model;
    permissionModeDraft = ui.permissionMode;
    promptDraft = ui.systemPrompt;
    settingsOpen = true;
  }

  function saveSettings() {
    if (keyDraft.trim()) ui.setApiKey(keyDraft);
    if (readbackDraft !== ui.readbackEnabled) ui.setReadbackEnabled(readbackDraft);
    ui.setMode(modeDraft);
    ui.setModel(modelDraft);
    ui.setPermissionMode(permissionModeDraft);
    ui.setSystemPrompt(promptDraft);
    settingsOpen = false;
  }

  // --- Corrections modal ---
  let correctionsOpen = $state(false);

  let hoveredMsg = $state<number | null>(null);
  let editing = $state(false);
  let editDraft = $state('');

  function handleAccept() {
    if (!live.pendingApproval) return;
    live.approve();
  }

  function handleStartEdit() {
    if (!live.pendingApproval) return;
    editDraft = live.pendingApproval.instruction;
    editing = true;
  }

  function handleSubmitEdit() {
    if (!live.pendingApproval) return;
    const original = live.pendingApproval.instruction;
    if (editDraft !== original) {
      corrections.add(original, editDraft);
    }
    live.approve(editDraft);
    editing = false;
  }

  function handleCancelEdit() {
    editing = false;
  }

  function handleReject() {
    live.reject();
    editing = false;
  }

  // --- Audio-reactive waveform ---
  const NUM_BARS = 16;
  let audioLevels = $state<number[]>(new Array(NUM_BARS).fill(0));
  let waveCtx: AudioContext | null = null;
  let waveStream: MediaStream | null = null;
  let waveRaf = 0;

  function startWaveform() {
    navigator.mediaDevices.getUserMedia({ audio: true }).then((stream) => {
      const ctx = new AudioContext({ sampleRate: 16000 });
      const source = ctx.createMediaStreamSource(stream);
      const analyser = ctx.createAnalyser();
      analyser.fftSize = 256;
      source.connect(analyser);
      waveCtx = ctx;
      waveStream = stream;
      const buf = new Float32Array(analyser.fftSize);
      const segSize = Math.floor(buf.length / NUM_BARS);
      function animate() {
        analyser.getFloatTimeDomainData(buf);
        audioLevels = Array.from({ length: NUM_BARS }, (_, i) => {
          let sum = 0;
          for (let j = 0; j < segSize; j++) { const v = buf[i * segSize + j]; sum += v * v; }
          return Math.min(1, Math.sqrt(sum / segSize) * 3);
        });
        waveRaf = requestAnimationFrame(animate);
      }
      waveRaf = requestAnimationFrame(animate);
    }).catch((e) => console.warn('[waveform] getUserMedia failed:', e));
  }

  function stopWaveform() {
    cancelAnimationFrame(waveRaf);
    waveStream?.getTracks().forEach(t => t.stop());
    if (waveCtx && waveCtx.state !== 'closed') void waveCtx.close();
    waveCtx = null; waveStream = null;
    audioLevels = new Array(NUM_BARS).fill(0);
  }

  let messagesEl: HTMLDivElement;

  // Auto-scroll chat on new content
  $effect(() => {
    void live.messages.length;
    void live.pendingTool?.text;
    tick().then(() => messagesEl?.scrollTo(0, messagesEl.scrollHeight));
  });

  // Sync URL with session ID
  $effect(() => {
    const id = live.claudeSessionId;
    if (id && id !== params?.id) replace(`/live/${id}`);
  });

  // Sync waveform with connection status
  $effect(() => {
    if (live.status === 'connected') {
      startWaveform();
      return stopWaveform;
    }
  });
</script>

<svelte:window onkeydown={(e) => {
  if (e.key === 'Tab' && e.shiftKey) {
    e.preventDefault();
    ui.cyclePermissionMode();
  }
}} />

<main>
  <header>
    <button class="header-link" onclick={() => push('/')}>Home</button>
    <span class="spacer"></span>
    <button class="header-link" onclick={openSettings}>Settings</button>
  </header>

  {#if historyLoading}
    <p class="loading">Loading conversation...</p>
  {/if}

  <!-- Zone 1: Chat (scrollable) -->
  <div class="chat-scroll" bind:this={messagesEl}>
    <div class="chat">
      {#each live.messages as msg, i}
        {#if !isToolResultOnly(msg)}
          <!-- svelte-ignore a11y_no_static_element_interactions -->
          <div class="bubble {msg.role}"
               onmouseenter={() => hoveredMsg = i}
               onmouseleave={() => hoveredMsg = null}>
            {#if hoveredMsg === i && msg.role === 'user' && msg.uuid && live.status === 'idle'}
              <button class="edit-btn" onclick={() => live.editMessage(i)}>Edit</button>
            {/if}
            {#if msg.role === 'user'}
              <p>{messageText(msg)}</p>
            {:else}
              {#each messageThinking(msg) as think}
                <details class="thinking">
                  <summary>Thinking...</summary>
                  <p>{think}</p>
                </details>
              {/each}
              {#if messageText(msg)}
                <div class="prose">{@html marked.parse(messageText(msg))}</div>
              {/if}
              {#each messageToolUses(msg) as tool}
                <details class="tool-use">
                  <summary><span class="tool-pill">{tool.name}</span></summary>
                  {#if tool.input.instruction}
                    <p class="tool-args">{tool.input.instruction}</p>
                  {:else if Object.keys(tool.input).length}
                    <p class="tool-args">{JSON.stringify(tool.input)}</p>
                  {/if}
                  {#if resultMap.get(tool.id)}
                    <p class="tool-text">{resultMap.get(tool.id)}</p>
                  {/if}
                </details>
              {/each}
            {/if}
          </div>
        {/if}
      {/each}

      <!-- Streaming Claude response (faded) -->
      {#if live.pendingTool && !live.pendingApproval}
        <div class="bubble assistant streaming">
          {#if live.pendingTool.text}
            <div class="prose">{@html marked.parse(live.pendingTool.text)}</div>
          {/if}
          {#if live.pendingTool.streaming}
            <div class="dots"><span></span><span></span><span></span></div>
          {/if}
        </div>
      {/if}
    </div>
  </div>

  <!-- Zone 2+3: Dock (float + input bar) -->
  <div class="dock">
    <!-- Transcription float -->
    {#if live.pendingInput && live.status === 'connected'}
      <div class="float transcription">
        <p>{live.pendingInput}</p>
      </div>
    {/if}

    <!-- Approval float -->
    {#if live.pendingApproval}
      <div class="float approval">
        <div class="approval-text"><p>{live.pendingApproval.instruction}</p></div>
        {#if editing}
          <textarea class="edit-instruction" bind:value={editDraft}></textarea>
          <div class="approval-actions">
            <button class="btn-accept" onclick={handleSubmitEdit}>Submit</button>
            <button class="btn-secondary" onclick={handleCancelEdit}>Cancel</button>
          </div>
        {:else}
          <div class="approval-actions">
            <button class="btn-accept" onclick={handleAccept}>Accept</button>
            <button class="btn-secondary" onclick={handleStartEdit}>Edit</button>
            <button class="btn-reject" onclick={handleReject}>Reject</button>
          </div>
        {/if}
      </div>
    {/if}

    <!-- Input bar -->
    <div class="input-bar">
      {#if live.status === 'connected'}
        <div class="waveform">
          {#each audioLevels as level}
            <span class="bar" style="height: {4 + level * 24}px"></span>
          {/each}
        </div>
        <button class="mic-btn active" onclick={() => live.stop()}>
          <svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor">
            <rect x="6" y="6" width="12" height="12" rx="2" />
          </svg>
        </button>
      {:else}
        <span class="placeholder">Reply...</span>
        <button
          class="mic-btn"
          class:pulsing={live.pendingTool?.streaming}
          disabled={live.status === 'connecting'}
          onclick={() => live.start()}
        >
          <svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor">
            <path d="M12 14c1.66 0 3-1.34 3-3V5c0-1.66-1.34-3-3-3S9 3.34 9 5v6c0 1.66 1.34 3 3 3zm5.3-3c0 3-2.54 5.1-5.3 5.1S6.7 14 6.7 11H5c0 3.41 2.72 6.23 6 6.72V21h2v-3.28c3.28-.48 6-3.3 6-6.72h-1.7z" />
          </svg>
        </button>
      {/if}
    </div>
  </div>

  <!-- Toast -->
  {#if live.toast}
    <div class="toast">{live.toast}</div>
  {/if}

  <!-- Permission mode -->
  <button class="mode-status" class:mode-accept={ui.permissionMode !== 'plan'} onclick={() => ui.cyclePermissionMode()}>
    {ui.permissionMode === 'plan' ? 'plan' : 'accept edits'} (shift+tab to cycle)
  </button>
</main>

<!-- Settings modal (consolidated) -->
{#if settingsOpen}
  <!-- svelte-ignore a11y_no_static_element_interactions -->
  <div class="backdrop" onkeydown={() => {}} onclick={() => { settingsOpen = false; }}>
    <!-- svelte-ignore a11y_no_static_element_interactions -->
    <div class="modal settings-modal" onkeydown={() => {}} onclick={(e) => e.stopPropagation()}>
      <h2>Settings</h2>

      {#if configName}
        <div class="config-badge">Config: {configName}</div>
      {/if}

      <label>
        API Key
        <input type="password" placeholder="API key" bind:value={keyDraft} />
      </label>

      <label>
        Instruction Readback
        <select bind:value={readbackDraft}>
          <option value={true}>On</option>
          <option value={false}>Off</option>
        </select>
      </label>

      <label>
        Mode
        <select bind:value={modeDraft}>
          <option value="direct">Direct</option>
          <option value="review">Review</option>
        </select>
      </label>

      <label>
        Permission Mode
        <select bind:value={permissionModeDraft}>
          <option value="plan">Plan</option>
          <option value="acceptEdits">Accept Edits</option>
        </select>
      </label>

      <label>
        Model
        <select bind:value={modelDraft}>
          <option value="haiku">Haiku</option>
          <option value="sonnet">Sonnet</option>
          <option value="opus">Opus</option>
        </select>
      </label>

      <label>
        System Prompt
        <textarea bind:value={promptDraft} rows="8"></textarea>
      </label>

      {#if corrections.corrections.length}
        <div class="corrections-link">
          <span>Corrections ({corrections.corrections.length})</span>
          <button class="link-btn" onclick={() => { correctionsOpen = true; }}>View</button>
        </div>
      {/if}

      <div class="modal-actions">
        <button onclick={() => { promptDraft = DEFAULT_SYSTEM_PROMPT; }}>Reset Prompt</button>
        <button onclick={() => { settingsOpen = false; }}>Cancel</button>
        <button onclick={saveSettings}>Save</button>
      </div>
    </div>
  </div>
{/if}

<!-- Corrections modal -->
{#if correctionsOpen}
  <!-- svelte-ignore a11y_no_static_element_interactions -->
  <div class="backdrop" onkeydown={() => {}} onclick={() => { correctionsOpen = false; }}>
    <!-- svelte-ignore a11y_no_static_element_interactions -->
    <div class="modal" onkeydown={() => {}} onclick={(e) => e.stopPropagation()}>
      <h2>Corrections</h2>
      {#each corrections.corrections as c (c.id)}
        <div class="correction-row">
          <div class="correction-text">
            <span class="correction-heard">{c.original}</span>
            <span class="correction-arrow">-&gt;</span>
            <span class="correction-meant">{c.corrected}</span>
          </div>
          <button class="correction-delete" onclick={() => corrections.remove(c.id)}>x</button>
        </div>
      {/each}
      {#if !corrections.corrections.length}
        <p class="correction-empty">No corrections yet.</p>
      {/if}
      <div class="modal-actions">
        <button onclick={() => { correctionsOpen = false; }}>Close</button>
      </div>
    </div>
  </div>
{/if}

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

  /* Global button reset (modals depend on this) */
  button {
    padding: 0.5rem 1.5rem;
    font-size: 0.9rem;
    cursor: pointer;
    border: 1px solid currentColor;
    border-radius: 0.25rem;
    background: none;
  }

  button:disabled {
    opacity: 0.5;
    cursor: default;
  }

  .loading {
    color: #9ca3af;
    text-align: center;
  }

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
    position: relative;
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

  /* --- Edit --- */
  .edit-btn {
    position: absolute;
    top: 0;
    right: 0;
    font-size: 0.65rem;
    padding: 0.15rem 0.5rem;
    color: #9ca3af;
    border: 1px solid #e5e7eb;
    border-radius: 0.25rem;
    background: white;
    cursor: pointer;
    opacity: 0;
    animation: fade-in 0.15s ease-out forwards;
  }

  .edit-btn:hover {
    color: #dc2626;
    border-color: #dc2626;
  }

  @keyframes fade-in {
    to { opacity: 1; }
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
  .prose :global(h1), .prose :global(h2), .prose :global(h3) {
    margin: 0.5rem 0 0.25rem;
    font-size: 0.95rem;
    font-weight: 700;
  }
  .prose :global(blockquote) {
    margin: 0.25rem 0;
    padding-left: 0.75rem;
    border-left: 3px solid rgba(0,0,0,0.15);
    color: #6b7280;
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

  .thinking p {
    white-space: pre-wrap;
    max-height: 200px;
    overflow-y: auto;
  }

  /* --- Tool use --- */
  .tool-use {
    margin-top: 0.25rem;
    padding: 0;
    border: none;
    background: none;
  }

  .tool-use summary {
    list-style: none;
    cursor: pointer;
    display: inline-block;
  }

  .tool-use summary::-webkit-details-marker {
    display: none;
  }

  .tool-pill {
    display: inline-block;
    font-size: 0.75rem;
    font-family: monospace;
    padding: 0.15rem 0.5rem;
    border-radius: 1rem;
    background: #ede9fe;
    color: #7c3aed;
  }

  .tool-args {
    font-size: 0.8rem;
    font-style: italic;
    color: #6b7280;
    margin: 0.25rem 0 0;
    padding: 0.4rem 0.6rem;
    background: #f9fafb;
    border-radius: 0.25rem;
    border: 1px solid #e5e7eb;
  }

  .tool-text {
    font-size: 0.8rem;
    white-space: pre-wrap;
    max-height: 200px;
    overflow-y: auto;
    color: #374151;
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
    display: flex;
    flex-direction: column-reverse;
    max-height: 8rem;
    overflow-y: auto;
    scrollbar-width: none;
  }

  .float.transcription::-webkit-scrollbar { display: none; }
  .float.transcription p { margin: 0; }

  .float.approval {
    background: white;
    border: 1.5px solid #059669;
    color: #1a1a1a;
  }

  .approval-text {
    max-height: 6rem;
    overflow-y: auto;
    scrollbar-width: none;
  }

  .approval-text::-webkit-scrollbar { display: none; }
  .approval-text p { margin: 0; }

  .edit-instruction {
    width: 100%;
    box-sizing: border-box;
    min-height: 3rem;
    margin-top: 0.5rem;
    padding: 0.5rem;
    font-size: 0.85rem;
    font-family: inherit;
    border: 1px solid #d1d5db;
    border-radius: 0.25rem;
    resize: vertical;
  }

  .approval-actions {
    display: flex;
    gap: 0.5rem;
    margin-top: 0.5rem;
    justify-content: flex-end;
  }

  .approval-actions button {
    font-size: 0.8rem;
    padding: 0.3rem 0.75rem;
    border-radius: 0.25rem;
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

  /* --- Mode status --- */
  .mode-status {
    flex-shrink: 0;
    align-self: center;
    font-size: 0.7rem;
    color: #059669;
    border: none;
    background: none;
    padding: 0.25rem 0;
    cursor: pointer;
  }

  .mode-status:hover { opacity: 0.7; }
  .mode-status.mode-accept { color: #7c3aed; }

  /* --- Toast --- */
  .toast {
    position: fixed;
    top: 1rem;
    right: 1rem;
    max-width: 360px;
    padding: 0.6rem 1rem;
    background: #fef2f2;
    color: #991b1b;
    border: 1px solid #fecaca;
    border-radius: 0.5rem;
    font-size: 0.8rem;
    line-height: 1.4;
    box-shadow: 0 2px 8px rgba(0,0,0,0.08);
    animation: toast-in 0.2s ease-out;
    overflow: hidden;
    text-overflow: ellipsis;
    display: -webkit-box;
    -webkit-line-clamp: 3;
    -webkit-box-orient: vertical;
    z-index: 200;
  }

  @keyframes toast-in {
    from { opacity: 0; transform: translateY(-0.5rem); }
    to { opacity: 1; transform: translateY(0); }
  }

  /* --- Modals --- */
  .backdrop {
    position: fixed;
    inset: 0;
    background: rgba(0, 0, 0, 0.4);
    display: flex;
    align-items: center;
    justify-content: center;
    z-index: 100;
  }

  .modal {
    background: white;
    padding: 1.5rem;
    border-radius: 0.5rem;
    width: min(400px, 90vw);
    display: flex;
    flex-direction: column;
    gap: 1rem;
  }

  .modal h2 { margin: 0; font-size: 1.1rem; }

  .modal input {
    padding: 0.5rem;
    font-size: 0.9rem;
    border: 1px solid #d1d5db;
    border-radius: 0.25rem;
    width: 100%;
    box-sizing: border-box;
  }

  .modal-actions {
    display: flex;
    justify-content: flex-end;
    gap: 0.5rem;
  }

  .settings-modal { width: min(550px, 90vw); }

  .settings-modal label {
    display: flex;
    flex-direction: column;
    gap: 0.25rem;
    font-size: 0.85rem;
    font-weight: 600;
  }

  .settings-modal select,
  .settings-modal textarea,
  .settings-modal input {
    padding: 0.5rem;
    font-size: 0.9rem;
    font-weight: 400;
    border: 1px solid #d1d5db;
    border-radius: 0.25rem;
    width: 100%;
    box-sizing: border-box;
    font-family: inherit;
  }

  .settings-modal textarea {
    resize: vertical;
    min-height: 120px;
  }

  .config-badge {
    font-size: 0.75rem;
    color: #6b7280;
    background: #f3f4f6;
    padding: 0.3rem 0.6rem;
    border-radius: 0.25rem;
    font-family: monospace;
  }

  .corrections-link {
    display: flex;
    align-items: center;
    justify-content: space-between;
    font-size: 0.85rem;
    color: #6b7280;
  }

  .link-btn {
    font-size: 0.75rem;
    padding: 0.2rem 0.8rem;
    color: #2563eb;
    border-color: #93c5fd;
  }

  /* --- Corrections --- */
  .correction-row {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    padding: 0.4rem 0;
    border-bottom: 1px solid #f0f0f0;
  }

  .correction-text { flex: 1; font-size: 0.85rem; }
  .correction-heard { text-decoration: line-through; color: #9ca3af; }
  .correction-arrow { color: #9ca3af; margin: 0 0.25rem; }
  .correction-meant { color: #059669; }

  .correction-delete {
    font-size: 0.7rem;
    padding: 0.2rem 0.5rem;
    color: #dc2626;
    border-color: #dc2626;
  }

  .correction-empty {
    color: #9ca3af;
    font-size: 0.85rem;
    text-align: center;
  }
</style>
