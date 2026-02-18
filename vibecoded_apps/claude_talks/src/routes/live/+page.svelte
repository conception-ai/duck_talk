<script lang="ts">
  import { createDataStore } from './stores/data.svelte';
  import { createUIStore } from './stores/ui.svelte';
  import { startMic, createPlayer } from './audio';
  import { createConverseApi } from './converse';
  import type { Recording } from './recorder';
  import type { AudioSink } from './types';

  const ui = createUIStore();

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
  });

  let keyDraft = $state(ui.apiKey ?? '');

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
        {#if turn.tool}
          <div class="tool-result">
            <span class="tool-pill">{turn.tool.name}</span>
            {#if turn.tool.text}<p class="tool-text">{turn.tool.text}</p>{/if}
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
</style>
