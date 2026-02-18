<script lang="ts">
  import { createDataStore } from './stores/data.svelte';
  import { createUIStore } from './stores/ui.svelte';
  import { createCorrectionsStore } from './stores/corrections.svelte';
  import { startMic, createPlayer } from './audio';
  import { createConverseApi } from './converse';
  import type { Recording } from './recorder';
  import type { AudioSink } from './types';

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
    api: createConverseApi(),
    getApiKey: () => ui.apiKey,
    getLearningMode: () => ui.learningMode,
    getCorrections: () => corrections.corrections,
  });

  let keyDraft = $state(ui.apiKey ?? '');
  let correctionsModalOpen = $state(false);
  let editedInstruction = $state('');
  $effect(() => {
    if (live.pendingApproval) {
      editedInstruction = String(live.pendingApproval.toolCall.args.instruction ?? '');
    }
  });

  function handleApprove() {
    const approval = live.pendingApproval;
    if (!approval) return;
    const original = String(approval.toolCall.args.instruction ?? '');
    if (editedInstruction !== original) {
      corrections.addSTT(original, editedInstruction, approval.audioChunks);
    }
    live.approve(editedInstruction);
    editedInstruction = '';
  }

  function handleReject() {
    live.reject();
    editedInstruction = '';
  }

  let fileInput: HTMLInputElement;
  let recordings = $state<string[]>([]);

  async function loadRecordings() {
    const res = await fetch('/recordings/index.json');
    if (res.ok) recordings = await res.json();
  }
  loadRecordings();

  async function handleReplay() {
    fileInput.click();
  }

  async function onFileSelected(e: Event) {
    const input = e.target as HTMLInputElement;
    const file = input.files?.[0];
    if (!file) return;
    const text = await file.text();
    const recording: Recording = JSON.parse(text);
    input.value = '';
    live.startReplay(recording);
  }

  async function replayFile(name: string) {
    const res = await fetch(`/recordings/${name}`);
    if (!res.ok) return;
    const recording: Recording = await res.json();
    live.startReplay(recording);
  }
</script>

<main>
  <header>
    <h1>Gemini Live</h1>
    <button class="header-sm" onclick={() => { keyDraft = ui.apiKey ?? ''; ui.openApiKeyModal(); }}>API Key</button>
    <button class="header-sm" class:muted={!ui.voiceEnabled} onclick={ui.toggleVoice}>
      {ui.voiceEnabled ? 'Voice On' : 'Voice Off'}
    </button>
    <button class="header-sm" class:active-mode={ui.learningMode} onclick={ui.toggleLearningMode}>
      {ui.learningMode ? 'Learning' : 'Direct'}
    </button>
    {#if corrections.corrections.length}
      <button class="header-sm" onclick={() => { correctionsModalOpen = true; }}>
        Corrections ({corrections.corrections.length})
      </button>
    {/if}
    {#if live.status === 'idle'}
      <button onclick={live.start}>Start</button>
      <button class="rec-btn" onclick={live.startRecording}>Record</button>
      <button onclick={handleReplay}>Replay</button>
      <input type="file" accept=".json" bind:this={fileInput} onchange={onFileSelected} hidden />
      {#each recordings as name}
        <button class="rec-file" onclick={() => replayFile(name)}>{name.replace('.json', '')}</button>
      {/each}
    {:else if live.status === 'connecting'}
      <button disabled>Connecting...</button>
    {:else if live.status === 'recording'}
      <button class="rec-btn recording" onclick={live.stopRecording}>Stop Rec</button>
    {:else}
      <button onclick={live.stop}>Stop</button>
    {/if}
  </header>

  <div class="messages">
    {#each live.turns as turn}
      <div class="msg {turn.role}">
        <span class="label">{turn.role === 'user' ? 'You' : 'Gemini'}</span>
        {#if turn.text}<p>{turn.text}</p>{/if}
        {#if turn.toolCall}
          <div class="tool-result">
            <span class="tool-pill">{turn.toolCall.name}</span>
            {#if turn.toolCall.args.instruction}
              <p class="tool-args">{turn.toolCall.args.instruction}</p>
            {:else if Object.keys(turn.toolCall.args).length}
              <p class="tool-args">{JSON.stringify(turn.toolCall.args)}</p>
            {/if}
            {#if turn.toolResult}<p class="tool-text">{turn.toolResult}</p>{/if}
          </div>
        {/if}
      </div>
    {/each}

    {#if live.pendingInput}
      <div class="msg user pending">
        <span class="label">You</span>
        <p>{live.pendingInput}</p>
      </div>
    {/if}

    {#if live.pendingTool}
      <div class="msg assistant pending">
        <span class="label">Gemini</span>
        {#if live.pendingOutput}<p>{live.pendingOutput}</p>{/if}
        <div class="tool-result streaming">
          <span class="tool-pill">{live.pendingTool.name}</span>
          {#if live.pendingApproval}
            {#if live.pendingApproval.transcription}
              <p class="transcription">You said: {live.pendingApproval.transcription}</p>
            {/if}
            <textarea
              class="edit-instruction"
              bind:value={editedInstruction}
            ></textarea>
            <div class="approval-actions">
              <button class="approve-btn" onclick={handleApprove}>Approve</button>
              <button class="reject-btn" onclick={handleReject}>Reject</button>
            </div>
          {:else}
            {#if live.pendingTool.args?.instruction}
              <p class="tool-args">{live.pendingTool.args.instruction}</p>
            {:else if live.pendingTool.args && Object.keys(live.pendingTool.args).length}
              <p class="tool-args">{JSON.stringify(live.pendingTool.args)}</p>
            {/if}
          {/if}
          {#if live.pendingTool.text}<p class="tool-text">{live.pendingTool.text}</p>{/if}
        </div>
      </div>
    {:else if live.pendingOutput}
      <div class="msg assistant pending">
        <span class="label">Gemini</span>
        <p>{live.pendingOutput}</p>
      </div>
    {/if}
  </div>
</main>

{#if ui.apiKeyModalOpen}
  <!-- svelte-ignore a11y_no_static_element_interactions -->
  <div class="backdrop" onkeydown={() => {}} onclick={ui.closeApiKeyModal}>
    <!-- svelte-ignore a11y_no_static_element_interactions -->
    <div class="modal" onkeydown={() => {}} onclick={(e) => e.stopPropagation()}>
      <h2>Gemini API Key</h2>
      <input
        type="password"
        placeholder="Enter your API key"
        bind:value={keyDraft}
        onkeydown={(e) => { if (e.key === 'Enter') ui.setApiKey(keyDraft); }}
      />
      <div class="modal-actions">
        <button onclick={ui.closeApiKeyModal}>Cancel</button>
        <button onclick={() => ui.setApiKey(keyDraft)}>Save</button>
      </div>
    </div>
  </div>
{/if}

{#if correctionsModalOpen}
  <!-- svelte-ignore a11y_no_static_element_interactions -->
  <div class="backdrop" onkeydown={() => {}} onclick={() => { correctionsModalOpen = false; }}>
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
          <button class="correction-delete" onclick={() => corrections.remove(c.id)}>x</button>
        </div>
      {/each}
      {#if !corrections.corrections.length}
        <p class="correction-empty">No corrections yet.</p>
      {/if}
      <div class="modal-actions">
        <button onclick={() => { correctionsModalOpen = false; }}>Close</button>
      </div>
    </div>
  </div>
{/if}

<style>
  main {
    max-width: 600px;
    margin: 2rem auto;
    font-family: system-ui, sans-serif;
  }

  header {
    display: flex;
    align-items: center;
    gap: 1rem;
    margin-bottom: 1rem;
  }

  h1 {
    margin: 0;
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

  .header-sm {
    font-size: 0.75rem;
  }

  .header-sm:first-of-type {
    margin-left: auto;
  }

  .header-sm.muted {
    opacity: 0.5;
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

  .rec-file {
    font-size: 0.75rem;
    color: #2563eb;
    border-color: #93c5fd;
  }

  .rec-btn.recording {
    color: #dc2626;
    border-color: #dc2626;
  }

  .messages {
    display: flex;
    flex-direction: column;
    gap: 0.75rem;
    max-height: 70vh;
    overflow-y: auto;
    padding: 0.5rem 0;
  }

  .msg {
    padding: 0.5rem 0.75rem;
    border-radius: 0.5rem;
  }

  .msg.user {
    background: #f0f0f0;
    align-self: flex-end;
    text-align: right;
  }

  .msg.assistant {
    background: #e8f4fd;
    align-self: flex-start;
  }

  .label {
    font-size: 0.7rem;
    font-weight: 600;
    text-transform: uppercase;
    opacity: 0.5;
  }

  .tool-result {
    margin-top: 0.5rem;
    padding: 0.5rem;
    border-radius: 0.375rem;
    background: #f5f0ff;
    border: 1px solid #e4d9fc;
  }

  .tool-result.streaming {
    border-style: dashed;
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

  .msg p {
    margin: 0.25rem 0 0;
  }

  .header-sm.active-mode {
    color: #059669;
    border-color: #059669;
  }

  .transcription {
    font-size: 0.75rem;
    color: #9ca3af;
    margin: 0.25rem 0 0;
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
