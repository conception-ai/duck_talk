<script lang="ts">
  import { marked } from 'marked';
  import { tick } from 'svelte';
  import { push } from 'svelte-spa-router';
  import { createDataStore } from './stores/data.svelte';
  import { createUIStore } from './stores/ui.svelte';
  import { createCorrectionsStore } from './stores/corrections.svelte';
  import { startMic, createPlayer, playPcmChunks } from './audio';
  import { createConverseApi } from './converse';
  import { correctInstruction } from './correct';
  import { DEFAULT_SYSTEM_PROMPT } from './defaults';
  import { createLLM } from '../../lib/llm';
  import { setup as setupRecorder } from '../../lib/recorder';
  import type { AudioSink, ContentBlock, InteractionMode, Message, STTCorrection } from './types';

  setupRecorder();

  let { params } = $props<{ params?: { id?: string } }>();

  const ui = createUIStore();
  const corrections = createCorrectionsStore();

  const live = createDataStore({
    audio: {
      startMic,
      createPlayer(): AudioSink {
        const raw = createPlayer();
        return {
          play(b64: string) { if (ui.voiceEnabled) raw.play(b64); },
          flush() { raw.flush(); },
          stop() { raw.stop(); },
        };
      },
    },
    api: createConverseApi('/api/converse', () => ({
      model: ui.model,
      systemPrompt: ui.systemPrompt,
      permissionMode: ui.permissionMode,
    })),
    getApiKey: () => ui.apiKey,
    getMode: () => ui.mode,
    correctInstruction: (instruction: string) => {
      const key = ui.apiKey;
      if (!key) return Promise.resolve(instruction);
      return correctInstruction(createLLM({ apiKey: key }), instruction, corrections.corrections);
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

  // --- Helper: extract text from a message for display ---
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

  function messageToolResults(msg: Message): Extract<ContentBlock, { type: 'tool_result' }>[] {
    if (typeof msg.content === 'string') return [];
    return msg.content.filter(
      (b): b is Extract<ContentBlock, { type: 'tool_result' }> => b.type === 'tool_result',
    );
  }

  function messageThinking(msg: Message): string[] {
    if (typeof msg.content === 'string') return [];
    return msg.content
      .filter((b): b is Extract<ContentBlock, { type: 'thinking' }> => b.type === 'thinking')
      .map((b) => b.thinking);
  }

  // --- Settings modal state ---
  let settingsOpen = $state(!ui.apiKey);
  let keyDraft = $state(ui.apiKey ?? '');
  let voiceDraft = $state(ui.voiceEnabled);
  let modeDraft = $state<InteractionMode>(ui.mode);
  let modelDraft = $state(ui.model);
  let permissionModeDraft = $state(ui.permissionMode);
  let promptDraft = $state(ui.systemPrompt);

  function openSettings() {
    keyDraft = ui.apiKey ?? '';
    voiceDraft = ui.voiceEnabled;
    modeDraft = ui.mode;
    modelDraft = ui.model;
    permissionModeDraft = ui.permissionMode;
    promptDraft = ui.systemPrompt;
    settingsOpen = true;
  }

  function saveSettings() {
    if (keyDraft.trim()) ui.setApiKey(keyDraft);
    if (voiceDraft !== ui.voiceEnabled) ui.toggleVoice();
    ui.setMode(modeDraft);
    ui.setModel(modelDraft);
    ui.setPermissionMode(permissionModeDraft);
    ui.setSystemPrompt(promptDraft);
    settingsOpen = false;
  }

  // --- Corrections modal ---
  let correctionsOpen = $state(false);
  let playingId = $state<string | null>(null);
  let stopPlaying: (() => void) | null = null;

  function playCorrection(c: STTCorrection) {
    stopPlaying?.();
    if (playingId === c.id) { playingId = null; return; }
    const handle = playPcmChunks(c.audioChunks.map(ch => ch.data), 16000, () => { playingId = null; });
    stopPlaying = handle.stop;
    playingId = c.id;
  }

  function downloadCorrection(c: STTCorrection) {
    const blob = new Blob(
      [JSON.stringify({ chunks: c.audioChunks, sampleRate: 16000 })],
      { type: 'application/json' },
    );
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `correction-${c.id.slice(0, 8)}.json`;
    a.click();
    URL.revokeObjectURL(url);
  }

  function playApprovalAudio() {
    const chunks = live.pendingApproval?.audioChunks;
    if (!chunks?.length) return;
    stopPlaying?.();
    if (playingId === 'approval') { playingId = null; return; }
    const handle = playPcmChunks(chunks.map(ch => ch.data), 16000, () => { playingId = null; });
    stopPlaying = handle.stop;
    playingId = 'approval';
  }

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
    const original = live.pendingApproval.rawInstruction ?? live.pendingApproval.instruction;
    if (editDraft !== original) {
      corrections.addSTT(original, editDraft, live.pendingApproval.audioChunks);
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


  let messagesEl: HTMLDivElement;

  $effect(() => {
    void live.messages.length;
    void live.pendingInput;
    void live.pendingTool?.text;
    tick().then(() => messagesEl?.scrollTo(0, messagesEl.scrollHeight));
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
    <span class="header-spacer"></span>
    <button class="header-link" onclick={openSettings}>Settings</button>
  </header>

  {#if historyLoading}
    <p class="loading">Loading conversation...</p>
  {/if}

  <!-- CC Messages (persistent conversation) -->
  <div class="messages" bind:this={messagesEl}>
    {#each live.messages as msg}
      <div class="msg {msg.role}">
        {#if messageText(msg)}
          {#if msg.role === 'assistant'}
            <div class="markdown">{@html marked.parse(messageText(msg))}</div>
          {:else}
            <p>{messageText(msg)}</p>
          {/if}
        {/if}
        {#each messageThinking(msg) as think}
          <details class="thinking">
            <summary>Thinking...</summary>
            <p>{think}</p>
          </details>
        {/each}
        {#each messageToolUses(msg) as tool}
          <div class="tool-result">
            <span class="tool-pill">{tool.name}</span>
            {#if tool.input.instruction}
              <p class="tool-args">{tool.input.instruction}</p>
            {:else if Object.keys(tool.input).length}
              <p class="tool-args">{JSON.stringify(tool.input)}</p>
            {/if}
          </div>
        {/each}
        {#each messageToolResults(msg) as result}
          <details class="tool-result">
            <summary>Tool result</summary>
            <p class="tool-text">{result.content}</p>
          </details>
        {/each}
      </div>
    {/each}

    <!-- Pending: live transcription -->
    {#if live.pendingInput}
      <div class="msg user pending">
        <p>{live.pendingInput}</p>
      </div>
    {/if}

    <!-- Pending: Claude thinking / streaming / approval -->
    {#if live.pendingTool}
      {#if live.pendingApproval}
        <div class="msg assistant approval">
          <p>{live.pendingApproval.instruction}</p>
          {#if editing}
            <textarea class="edit-instruction" bind:value={editDraft}></textarea>
            <div class="approval-actions">
              <button class="approve-btn" onclick={handleSubmitEdit}>Submit</button>
              <button onclick={handleCancelEdit}>Cancel</button>
            </div>
          {:else}
            <div class="approval-actions">
              {#if live.pendingApproval.audioChunks.length}
                <button class="correction-play" onclick={playApprovalAudio}>
                  {playingId === 'approval' ? '\u25A0' : '\u25B6'}
                </button>
              {/if}
              <button class="approve-btn" onclick={handleAccept}>Accept</button>
              <button onclick={handleStartEdit}>Edit</button>
              <button class="reject-btn" onclick={handleReject}>Reject</button>
            </div>
          {/if}
        </div>
      {:else if live.pendingTool.text}
        <div class="msg assistant pending">
          <div class="markdown">{@html marked.parse(live.pendingTool.text)}</div>
        </div>
      {:else}
        <div class="msg assistant pending">
          <p class="thinking-dots"><span></span><span></span><span></span></p>
        </div>
      {/if}
    {/if}
  </div>

  <!-- Toast -->
  {#if live.toast}
    <div class="toast">{live.toast}</div>
  {/if}

  <!-- Input bar -->
  <div class="input-bar">
    {#if live.status === 'connected'}
      <div class="waveform">
        {#each [1.0, 0.8, 1.15, 0.85, 1.05] as dur, i}
          <span class="wave-bar" style="animation-duration: {dur}s; animation-delay: {i * 0.12}s"></span>
        {/each}
      </div>
    {:else}
      <textarea class="input-field" placeholder="Reply..." disabled rows="1"></textarea>
    {/if}
    <button
      class="mic-btn"
      class:connected={live.status === 'connected'}
      class:connecting={live.status === 'connecting'}
      disabled={live.status === 'connecting'}
      onclick={() => live.status === 'idle' ? live.start() : live.stop()}
    >
      <svg viewBox="0 0 24 24" width="20" height="20" fill="currentColor">
        <path d="M12 14c1.66 0 3-1.34 3-3V5c0-1.66-1.34-3-3-3S9 3.34 9 5v6c0 1.66 1.34 3 3 3zm5.3-3c0 3-2.54 5.1-5.3 5.1S6.7 14 6.7 11H5c0 3.41 2.72 6.23 6 6.72V21h2v-3.28c3.28-.48 6-3.3 6-6.72h-1.7z"/>
      </svg>
    </button>
  </div>
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

      <label>
        API Key
        <input type="password" placeholder="API key" bind:value={keyDraft} />
      </label>

      <label>
        Voice Playback
        <select bind:value={voiceDraft}>
          <option value={true}>On</option>
          <option value={false}>Off</option>
        </select>
      </label>

      <label>
        Mode
        <select bind:value={modeDraft}>
          <option value="direct">Direct</option>
          <option value="review">Review</option>
          <option value="correct">Correct</option>
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
      <h2>STT Corrections</h2>
      {#each corrections.corrections as c (c.id)}
        <div class="correction-row">
          <div class="correction-text">
            <span class="correction-heard">{c.heard}</span>
            <span class="correction-arrow">-&gt;</span>
            <span class="correction-meant">{c.meant}</span>
          </div>
          {#if c.audioChunks.length}
            <button class="correction-play" onclick={() => playCorrection(c)}>
              {playingId === c.id ? '\u25A0' : '\u25B6'}
            </button>
            <button class="correction-play" onclick={() => downloadCorrection(c)}>{'\u2193'}</button>
          {/if}
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
  main {
    max-width: 600px;
    margin: 0 auto;
    padding: 1rem;
    height: 100dvh;
    box-sizing: border-box;
    font-family: system-ui, sans-serif;
    display: flex;
    flex-direction: column;
  }

  header {
    display: flex;
    align-items: center;
    gap: 1rem;
    margin-bottom: 0.5rem;
  }

  .header-link {
    font-size: 0.8rem;
    color: #9ca3af;
    border: none;
    padding: 0.25rem 0;
    background: none;
    cursor: pointer;
  }

  .header-link:hover {
    color: #374151;
  }

  .header-spacer {
    flex: 1;
  }

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

  .modal h2 {
    margin: 0;
    font-size: 1.1rem;
  }

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

  .settings-modal {
    width: min(550px, 90vw);
  }

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

  .messages {
    display: flex;
    flex-direction: column;
    gap: 0.75rem;
    flex: 1;
    min-height: 0;
    overflow-y: auto;
    padding: 0.5rem 0;
  }

  .msg {
    padding: 0.5rem 0;
    max-width: 85%;
  }

  .msg.user {
    align-self: flex-end;
    text-align: right;
  }

  .msg.assistant {
    align-self: flex-start;
  }

  .thinking {
    margin-top: 0.5rem;
    font-size: 0.8rem;
    color: #9ca3af;
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

  .tool-result {
    margin-top: 0.5rem;
    padding: 0.5rem;
    border-radius: 0.375rem;
    background: #f5f0ff;
    border: 1px solid #e4d9fc;
  }

  .tool-result {
    margin-top: 0.5rem;
    padding: 0.5rem;
    border-radius: 0.375rem;
    background: #f5f0ff;
    border: 1px solid #e4d9fc;
  }

  .tool-pill {
    display: inline-block;
    font-size: 0.75rem;
    font-family: monospace;
    padding: 0.2rem 0.6rem;
    border-radius: 1rem;
    background: #ede9fe;
    color: #7c3aed;
  }

  .tool-args {
    font-size: 0.8rem;
    font-style: italic;
    color: #6b7280;
    margin: 0.25rem 0 0;
  }

  .tool-text {
    font-size: 0.85rem;
    white-space: pre-wrap;
    max-height: 300px;
    overflow-y: auto;
    color: #374151;
  }

  .msg.pending {
    opacity: 0.6;
  }

  .msg.approval {
    opacity: 1;
    border: 2px solid #059669;
  }

  .msg p {
    margin: 0.25rem 0 0;
  }

  /* Markdown prose inside chat bubbles */
  .markdown :global(h1),
  .markdown :global(h2),
  .markdown :global(h3) {
    margin: 0.5rem 0 0.25rem;
    font-size: 0.95rem;
    font-weight: 700;
  }

  .markdown :global(p) {
    margin: 0.25rem 0;
  }

  .markdown :global(ul),
  .markdown :global(ol) {
    margin: 0.25rem 0;
    padding-left: 1.25rem;
  }

  .markdown :global(code) {
    font-size: 0.8rem;
    background: rgba(0, 0, 0, 0.06);
    padding: 0.1rem 0.3rem;
    border-radius: 0.2rem;
  }

  .markdown :global(pre) {
    margin: 0.5rem 0;
    padding: 0.5rem;
    background: rgba(0, 0, 0, 0.06);
    border-radius: 0.375rem;
    overflow-x: auto;
    font-size: 0.8rem;
  }

  .markdown :global(pre code) {
    background: none;
    padding: 0;
  }

  .markdown :global(blockquote) {
    margin: 0.25rem 0;
    padding-left: 0.75rem;
    border-left: 3px solid rgba(0, 0, 0, 0.15);
    color: #6b7280;
  }

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

  .approval-actions .correction-play {
    margin-right: auto;
  }

  .approve-btn {
    font-size: 0.8rem;
    padding: 0.3rem 1rem;
    color: #059669;
    border-color: #059669;
  }

  .reject-btn {
    font-size: 0.8rem;
    padding: 0.3rem 1rem;
    color: #dc2626;
    border-color: #dc2626;
  }

  .correction-row {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    padding: 0.4rem 0;
    border-bottom: 1px solid #f0f0f0;
  }

  .correction-text {
    flex: 1;
    font-size: 0.85rem;
  }

  .correction-heard {
    text-decoration: line-through;
    color: #9ca3af;
  }

  .correction-arrow {
    color: #9ca3af;
    margin: 0 0.25rem;
  }

  .correction-meant {
    color: #059669;
  }

  .correction-play {
    font-size: 0.7rem;
    padding: 0.2rem 0.5rem;
    color: #2563eb;
    border-color: #93c5fd;
  }

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

  /* Toast */
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
    box-shadow: 0 2px 8px rgba(0, 0, 0, 0.08);
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

  /* Thinking dots */
  .thinking-dots {
    display: flex;
    gap: 0.3rem;
    margin: 0.25rem 0 0;
  }

  .thinking-dots span {
    width: 6px;
    height: 6px;
    border-radius: 50%;
    background: #9ca3af;
    animation: dot-bounce 1.4s ease-in-out infinite;
  }

  .thinking-dots span:nth-child(2) { animation-delay: 0.2s; }
  .thinking-dots span:nth-child(3) { animation-delay: 0.4s; }

  @keyframes dot-bounce {
    0%, 80%, 100% { opacity: 0.3; transform: scale(0.8); }
    40% { opacity: 1; transform: scale(1); }
  }

  /* Input bar */
  .input-bar {
    flex-shrink: 0;
    margin: 0.5rem 0;
    display: flex;
    align-items: flex-end;
    gap: 0.5rem;
    padding: 0.5rem 0.5rem 0.5rem 0.75rem;
    background: white;
    border: 1px solid #e5e7eb;
    border-radius: 1.25rem;
    box-shadow: 0 1px 4px rgba(0, 0, 0, 0.06);
  }

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

  .mode-status:hover {
    opacity: 0.7;
  }

  .mode-status.mode-accept {
    color: #7c3aed;
  }

  .waveform {
    flex: 1;
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 3px;
    padding: 0.35rem 0;
  }

  .wave-bar {
    width: 3px;
    height: 20px;
    border-radius: 1.5px;
    background: #059669;
    animation: wave 1s ease-in-out infinite;
  }

  @keyframes wave {
    0%, 100% { transform: scaleY(0.15); }
    50% { transform: scaleY(1); }
  }

  .input-field {
    flex: 1;
    border: none;
    outline: none;
    background: transparent;
    font-family: inherit;
    font-size: 0.9rem;
    resize: none;
    padding: 0.35rem 0;
    line-height: 1.4;
    color: #374151;
  }

  .input-field::placeholder {
    color: #9ca3af;
  }

  .input-field:disabled {
    opacity: 0.6;
    cursor: default;
  }

  .mic-btn {
    position: relative;
    flex-shrink: 0;
    width: 36px;
    height: 36px;
    border-radius: 50%;
    border: none;
    background: #e5e7eb;
    color: #6b7280;
    cursor: pointer;
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 0;
  }

  .mic-btn:disabled {
    cursor: default;
  }

  .mic-btn.connecting {
    animation: gentle-pulse 1.5s ease-in-out infinite;
  }

  .mic-btn.connected {
    background: #059669;
    color: white;
  }

  .mic-btn.connected::before,
  .mic-btn.connected::after {
    content: '';
    position: absolute;
    inset: 0;
    border-radius: 50%;
    border: 2px solid #059669;
    animation: pulse-ring 2s ease-out infinite;
  }

  .mic-btn.connected::after {
    animation-delay: 1s;
  }

  @keyframes pulse-ring {
    0% { transform: scale(1); opacity: 0.5; }
    100% { transform: scale(1.8); opacity: 0; }
  }

  @keyframes gentle-pulse {
    0%, 100% { opacity: 0.5; }
    50% { opacity: 1; }
  }
</style>
