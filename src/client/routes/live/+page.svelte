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
  import './styles/colorPalette.css';
  import './styles/fontSizes.css';
  import './styles/reduck-theme.css';

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
    getApiKey: () => apiKey,
    getMode: () => ui.mode,
    readbackInstruction: (text: string) => {
      let cancelled = false;
      let stop: (() => void) | undefined;
      if (!ui.readbackEnabled || !apiKey) return () => {};
      speak(apiKey, text).then(({ data, sampleRate }) => {
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

  // --- Server config (Gemini API key) ---
  let apiKey = $state<string | null>(null);
  fetch('/api/config').then(r => r.json()).then(d => { apiKey = d.gemini_api_key ?? null; }).catch(() => {});

  // --- InputMode ---
  type InputMode = 'idle' | 'recording' | 'review' | 'streaming';
  let inputMode = $derived<InputMode>(
    live.pendingApproval ? 'review' :
    live.status === 'connected' ? 'recording' :
    live.pendingTool?.streaming ? 'streaming' :
    'idle'
  );

  // --- Settings popover ---
  let settingsOpen = $state(false);
  let inputMuted = $state(false);
  let outputMuted = $state(false);

  // Close popover when leaving idle
  $effect(() => { if (inputMode !== 'idle') settingsOpen = false; });

  // --- Review banner ---
  let reviewBannerDismissed = $state(false);

  // --- Input text (syncs from store in live modes, user-controlled in idle) ---
  let inputText = $state('');
  let textareaEl: HTMLTextAreaElement;
  let originalApprovalText = $state('');

  // Sync from live transcription during recording
  $effect(() => {
    if (live.status === 'connected' && !live.pendingApproval) {
      inputText = live.pendingInput;
    }
  });

  // Sync from approval text
  $effect(() => {
    const approval = live.pendingApproval;
    if (approval) {
      inputText = approval.instruction;
      originalApprovalText = approval.instruction;
      editing = false;
    }
  });

  // Clear when disconnecting from live
  $effect(() => {
    if (live.status === 'connected') {
      return () => {
        inputText = '';
        editing = false;
        if (textareaEl) textareaEl.style.height = '';
      };
    }
  });

  // Permission mode label for input tip
  let permissionModeLabel = $derived(ui.permissionMode === 'plan' ? 'Plan' : 'Accept Edits');

  let inputTip = $derived(
    inputMode === 'review'
      ? `Press <span class="tt-kbd">Enter</span> to send`
      : inputMode === 'recording'
      ? `<span class="tt-kbd">ESC</span> to exit Live`
      : inputMode === 'streaming'
      ? `<span class="tt-kbd">ESC</span> to stop`
      : inputText.trim()
      ? `Press <span class="tt-kbd">Enter</span> to send`
      : `Permission mode: <span class="tip-tag ${ui.permissionMode === 'plan' ? 'tip-info' : 'tip-success'}">${permissionModeLabel}</span> <span class="tip-hint">(shift+tab)</span>`
  );

  // --- Auto-grow textarea ---
  function autoGrow() {
    if (!textareaEl) return;
    textareaEl.style.height = '';
    if (!inputText.trim()) return;
    if (textareaEl.scrollHeight > textareaEl.clientHeight) {
      const maxH = window.innerHeight * 0.5;
      textareaEl.style.height = Math.min(textareaEl.scrollHeight, maxH) + 'px';
    }
  }

  // --- Edit message hover ---
  let hoveredMsg = $state<number | null>(null);
  let editing = $state(false);

  // --- Approval handlers ---
  function handleSendReview() {
    if (!live.pendingApproval) return;
    const original = live.pendingApproval.instruction;
    if (inputText !== original) {
      corrections.add(original, inputText);
    }
    live.approve(inputText);
    editing = false;
    reviewBannerDismissed = false;
  }

  function handleClearReview() {
    inputText = '';
    if (textareaEl) textareaEl.focus();
  }

  function handleReject() {
    live.reject();
    editing = false;
    reviewBannerDismissed = false;
  }

  // --- Send typed text (non-live) ---
  function handleSendText() {
    const text = inputText.trim();
    if (!text) return;
    inputText = '';
    if (textareaEl) textareaEl.style.height = '';
    live.sendText(text);
  }

  function onTextareaKeydown(e: KeyboardEvent) {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      if (inputMode === 'review') {
        handleSendReview();
      } else if (inputMode === 'idle' && inputText.trim()) {
        handleSendText();
      }
    }
  }

  function onTextareaFocus() {
    if (inputMode === 'review') editing = true;
  }

  function onTextareaBlur() {
    if (inputMode === 'review' && inputText === originalApprovalText) {
      editing = false;
    }
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
  if (e.key === 'Escape' && (inputMode === 'recording' || inputMode === 'streaming')) {
    e.preventDefault();
    live.stop();
  }
}} />

<main class="reduck-theme">
  <header>
    <button class="header-link" onclick={() => push('/')}>Home</button>
    <span class="spacer"></span>
  </header>

  {#if historyLoading}
    <p class="loading">Loading conversation...</p>
  {/if}

  <div class="chat-scroll" bind:this={messagesEl}>
    <div class="column">
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
                    <div class="tool-details">
                      {#if tool.input.command}
                        <p class="tool-args">{tool.input.command}</p>
                      {:else if tool.input.instruction}
                        <p class="tool-args">{tool.input.instruction}</p>
                      {:else if Object.keys(tool.input).length}
                        <p class="tool-args">{JSON.stringify(tool.input)}</p>
                      {/if}
                      {#if resultMap.get(tool.id)}
                        <p class="tool-text">{resultMap.get(tool.id)}</p>
                      {/if}
                    </div>
                  </details>
                {/each}
              {/if}
            </div>
          {/if}
        {/each}

        <!-- Streaming Claude response -->
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

      <!-- Unified input area -->
      <div class="input-area">
        {#if inputMode === 'review' && !reviewBannerDismissed}
          <div class="review-banner">
            <span>Review your message, edit if needed, then send.</span>
            <button class="review-banner-close" aria-label="Dismiss" onclick={() => reviewBannerDismissed = true}>
              <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round">
                <line x1="7" y1="7" x2="17" y2="17"/><line x1="17" y1="7" x2="7" y2="17"/>
              </svg>
            </button>
          </div>
        {/if}

        <div class="input-box" class:recording={inputMode === 'recording'} class:review={inputMode === 'review'} class:streaming={inputMode === 'streaming'} class:editing>
          <textarea
            bind:this={textareaEl}
            bind:value={inputText}
            oninput={autoGrow}
            onkeydown={onTextareaKeydown}
            onfocus={onTextareaFocus}
            onblur={onTextareaBlur}
            placeholder={inputMode === 'streaming' ? 'Waiting for response...' : 'Message...'}
            readonly={inputMode === 'recording' || inputMode === 'streaming'}
          ></textarea>

          <div class="controls-row">
            <!-- Settings gear -->
            <div class="settings-wrapper">
              <button class="ghost-btn" type="button" aria-label="Settings" onclick={() => settingsOpen = !settingsOpen}>
                <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                  <circle cx="12" cy="12" r="3"/>
                  <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/>
                </svg>
              </button>
              {#if settingsOpen}
                <!-- svelte-ignore a11y_click_events_have_key_events -->
                <!-- svelte-ignore a11y_no_static_element_interactions -->
                <div class="settings-backdrop" onclick={() => settingsOpen = false}></div>
                <div class="settings-popover">
                  <div class="settings-section">
                    <span class="settings-section-title">Audio</span>
                    <label class="settings-toggle">
                      <span class="settings-label">
                        <svg viewBox="0 0 24 24" width="14" height="14" fill="var(--color-grey-400)"><path d="M12 14c1.66 0 3-1.34 3-3V5c0-1.66-1.34-3-3-3S9 3.34 9 5v6c0 1.66 1.34 3 3 3zm5.3-3c0 3-2.54 5.1-5.3 5.1S6.7 14 6.7 11H5c0 3.41 2.72 6.23 6 6.72V21h2v-3.28c3.28-.48 6-3.3 6-6.72h-1.7z"/></svg>
                        Input
                      </span>
                      <button class="toggle-switch" class:active={!inputMuted} type="button" onclick={() => inputMuted = !inputMuted} aria-label="Toggle input audio">
                        <span class="toggle-knob"></span>
                      </button>
                    </label>
                    <label class="settings-toggle">
                      <span class="settings-label">
                        <svg viewBox="0 0 24 24" width="14" height="14" fill="var(--color-grey-400)"><path d="M3 9v6h4l5 5V4L7 9H3zm13.5 3c0-1.77-1.02-3.29-2.5-4.03v8.05c1.48-.73 2.5-2.25 2.5-4.02zM14 3.23v2.06c2.89.86 5 3.54 5 6.71s-2.11 5.85-5 6.71v2.06c4.01-.91 7-4.49 7-8.77s-2.99-7.86-7-8.77z"/></svg>
                        Output
                      </span>
                      <button class="toggle-switch" class:active={!outputMuted} type="button" onclick={() => outputMuted = !outputMuted} aria-label="Toggle output audio">
                        <span class="toggle-knob"></span>
                      </button>
                    </label>
                  </div>
                  <div class="settings-divider"></div>
                  <div class="settings-section">
                    <span class="settings-section-title">Transcription Mode</span>
                    <select class="settings-select" value={ui.mode} onchange={(e) => ui.setMode(e.currentTarget.value as InteractionMode)}>
                      <option value="direct">Direct</option>
                      <option value="review">Review</option>
                    </select>
                  </div>
                  <div class="settings-divider"></div>
                  <div class="settings-section">
                    <span class="settings-section-title">Permission Mode</span>
                    <select class="settings-select" value={ui.permissionMode} onchange={(e) => ui.setPermissionMode(e.currentTarget.value)}>
                      <option value="plan">Plan</option>
                      <option value="acceptEdits">Accept Edits</option>
                    </select>
                  </div>
                </div>
              {/if}
            </div>

            {#if inputMode === 'recording'}
              <!-- Recording: waveform + stop -->
              <div class="waveform">
                {#each audioLevels as level}
                  <span style="height: {4 + level * 24}px"></span>
                {/each}
              </div>
              <button class="primary-btn stop-btn" aria-label="Exit Live" onclick={() => live.stop()}>
                <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round">
                  <line x1="7" y1="7" x2="17" y2="17"/><line x1="17" y1="7" x2="7" y2="17"/>
                </svg>
              </button>
            {:else if inputMode === 'review'}
              <!-- Review: waveform + clear + send -->
              <div class="waveform">
                {#each audioLevels as level}
                  <span style="height: {4 + level * 24}px"></span>
                {/each}
              </div>
              <button class="text-btn" onclick={handleClearReview}>Clear</button>
              <button class="primary-btn send-btn" aria-label="Send" onclick={handleSendReview}>
                <svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor">
                  <path d="M2.01 21L23 12 2.01 3 2 10l15 2-15 2z"/>
                </svg>
              </button>
            {:else if inputMode === 'streaming'}
              <!-- Streaming: spacer + stop -->
              <span class="controls-spacer"></span>
              <button class="primary-btn stop-btn" aria-label="Stop" onclick={() => live.stop()}>
                <svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor">
                  <rect x="6" y="6" width="12" height="12" rx="2"/>
                </svg>
              </button>
            {:else}
              <!-- Idle: spacer + model + send/mic -->
              <span class="controls-spacer"></span>
              <span class="model-select-wrap">
                <select class="model-select" value={ui.model} onchange={(e) => ui.setModel(e.currentTarget.value)}>
                  <option value="opus">Opus</option>
                  <option value="sonnet">Sonnet</option>
                  <option value="haiku">Haiku</option>
                </select>
              </span>
              {#if inputText.trim()}
                <button class="primary-btn send-btn" aria-label="Send" onclick={handleSendText}>
                  <svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor">
                    <path d="M2.01 21L23 12 2.01 3 2 10l15 2-15 2z"/>
                  </svg>
                </button>
              {:else}
                <button class="primary-btn mic-corner-btn" aria-label="Start talking" disabled={live.status === 'connecting'} onclick={() => live.start()}>
                  <svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor">
                    <path d="M12 14c1.66 0 3-1.34 3-3V5c0-1.66-1.34-3-3-3S9 3.34 9 5v6c0 1.66 1.34 3 3 3zm5.3-3c0 3-2.54 5.1-5.3 5.1S6.7 14 6.7 11H5c0 3.41 2.72 6.23 6 6.72V21h2v-3.28c3.28-.48 6-3.3 6-6.72h-1.7z"/>
                  </svg>
                </button>
              {/if}
            {/if}
          </div>
        </div>

        <p class="input-tip">{@html inputTip}</p>
      </div>
    </div>
  </div>

  <!-- Toast -->
  {#if live.toast}
    <div class="toast">{live.toast}</div>
  {/if}
</main>

<style>
  /* === LAYOUT === */
  main {
    width: 100%;
    height: 100dvh;
    display: flex;
    flex-direction: column;
    font-family: 'Inter', sans-serif;
  }

  header {
    flex-shrink: 0;
    display: flex;
    align-items: center;
    padding: 0.5rem 1rem;
    max-width: 640px;
    width: 100%;
    margin: 0 auto;
    box-sizing: border-box;
  }

  .header-link {
    font-size: var(--font-size-small);
    color: var(--color-grey-400);
    border: none;
    background: none;
    cursor: pointer;
    padding: 0.25rem 0;
    font-family: inherit;
    transition: color 200ms;
  }

  .header-link:hover { color: var(--color-grey-200); }
  .spacer { flex: 1; }

  .loading {
    color: var(--color-grey-400);
    text-align: center;
  }

  /* === SCROLL + COLUMN === */
  .chat-scroll {
    flex: 1;
    min-height: 0;
    overflow-y: auto;
  }

  .column {
    max-width: 640px;
    width: 100%;
    margin: 0 auto;
    min-height: 100%;
    display: flex;
    flex-direction: column;
    box-sizing: border-box;
  }

  /* === MESSAGES === */
  .chat {
    flex: 1;
    padding: 0.5rem 1rem 1rem;
    display: flex;
    flex-direction: column;
    gap: 0.75rem;
  }

  .bubble {
    position: relative;
    max-width: 85%;
    line-height: 1.5;
    font-size: var(--font-size-body);
  }

  .bubble.user {
    align-self: flex-end;
    background: var(--color-grey-900);
    padding: 0.5rem 0.75rem;
    border-radius: 1rem 1rem 0.25rem 1rem;
  }

  .bubble.user p { margin: 0; }

  .bubble.assistant {
    align-self: flex-start;
    padding: 0.25rem 0;
  }

  .bubble.streaming { opacity: 0.7; }

  /* === EDIT BUTTON === */
  .edit-btn {
    position: absolute;
    top: 0;
    right: 0;
    font-size: 0.65rem;
    padding: 0.15rem 0.5rem;
    color: var(--color-grey-400);
    border: 1px solid var(--color-grey-600);
    border-radius: 0.25rem;
    background: var(--color-grey-800);
    cursor: pointer;
    font-family: inherit;
    opacity: 0;
    animation: fade-in 0.15s ease-out forwards;
  }

  .edit-btn:hover {
    color: var(--color-red-300);
    border-color: var(--color-red-500);
  }

  @keyframes fade-in {
    to { opacity: 1; }
  }

  /* === PROSE === */
  .prose :global(p) { margin: 0.25rem 0; }
  .prose :global(strong) { font-weight: 600; }
  .prose :global(code) {
    font-size: var(--font-size-small);
    background: var(--color-grey-700);
    padding: 0.1rem 0.3rem;
    border-radius: 3px;
  }
  .prose :global(pre) {
    margin: 0.4rem 0;
    padding: 0.5rem;
    background: var(--color-grey-900);
    border-radius: 8px;
    overflow-x: auto;
    font-size: var(--font-size-small);
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
    border-left: 3px solid var(--color-grey-600);
    color: var(--color-grey-400);
  }

  /* === THINKING === */
  .thinking {
    font-size: var(--font-size-small);
    color: var(--color-grey-400);
    margin-bottom: 0.25rem;
    background: var(--color-grey-700);
    border-radius: 8px;
    padding: 0.35rem 0.6rem;
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

  /* === TOOL USE === */
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

  .tool-use summary::-webkit-details-marker { display: none; }

  .tool-pill {
    display: inline-flex;
    align-items: center;
    gap: 2px;
    font-size: var(--font-size-caption);
    font-family: monospace;
    padding: 0.15rem 0.5rem;
    border-radius: 1rem;
    background: var(--color-blue-500-translucent-18);
    color: var(--color-blue-300);
    transition: background 200ms;
  }

  .tool-details {
    margin-top: 8px;
    padding-left: 8px;
    border-left: 2px solid var(--color-blue-500-translucent-18);
  }

  .tool-args {
    display: inline;
    font-size: var(--font-size-small);
    font-style: italic;
    color: var(--color-grey-400);
    margin: 0;
    padding: 2px 6px;
    background: var(--color-grey-900);
    border-radius: 4px;
  }

  .tool-text {
    font-size: var(--font-size-small);
    white-space: pre-wrap;
    max-height: 200px;
    overflow-y: auto;
    color: var(--color-grey-300);
    margin-top: 4px;
  }

  /* === DOTS === */
  .dots { display: flex; gap: 4px; margin-top: 0.5rem; }

  .dots span {
    width: 5px; height: 5px; border-radius: 50%;
    background: var(--color-grey-400);
    animation: dot-pulse 1.4s ease-in-out infinite;
  }
  .dots span:nth-child(2) { animation-delay: 0.2s; }
  .dots span:nth-child(3) { animation-delay: 0.4s; }

  @keyframes dot-pulse {
    0%, 80%, 100% { opacity: 0.3; transform: scale(0.8); }
    40% { opacity: 1; transform: scale(1); }
  }

  /* === INPUT AREA === */
  .input-area {
    position: sticky;
    bottom: 0;
    padding: 1rem;
    display: flex;
    flex-direction: column;
    background: linear-gradient(to bottom, transparent, var(--background-color) 1rem);
  }

  /* === REVIEW BANNER === */
  .review-banner {
    display: flex;
    align-items: center;
    justify-content: space-between;
    background: var(--color-grey-900);
    color: var(--color-grey-300);
    font-size: var(--font-size-small);
    padding: 6px 12px;
    border-radius: 8px;
    margin-bottom: 8px;
  }

  .review-banner-close {
    background: none;
    border: none;
    color: var(--color-grey-400);
    cursor: pointer;
    padding: 2px;
    display: flex;
    align-items: center;
    transition: color 200ms;
  }

  .review-banner-close:hover { color: var(--color-grey-200); }

  /* === INPUT BOX === */
  .input-box {
    position: relative;
    display: flex;
    flex-direction: column;
    background: transparent;
    border: 1px solid var(--color-grey-600);
    border-radius: 16px;
    min-height: 97px;
    transition: border-color 200ms, background 200ms;
  }

  .input-box:hover { border-color: var(--color-grey-500); }
  .input-box:focus-within { border-color: var(--color-orange-400); }

  .input-box.recording {
    border-color: var(--color-orange-400);
    background: rgba(249, 115, 22, 0.15);
    animation: border-pulse 1.5s ease-in-out infinite;
  }

  .input-box.review {
    border-color: var(--color-orange-400);
    background: rgba(249, 115, 22, 0.15);
    animation: none;
  }

  .input-box.recording textarea,
  .input-box.review textarea {
    font-style: italic;
  }

  .input-box.recording textarea {
    color: var(--color-orange-200);
    animation: transcription-pulse 2s ease-in-out infinite;
  }

  .input-box.review.editing textarea {
    font-style: normal;
  }

  .input-box.streaming {
    border-color: var(--color-grey-600);
  }

  .input-box.streaming:hover,
  .input-box.streaming:focus-within {
    border-color: var(--color-grey-600);
  }

  .input-box.streaming textarea {
    opacity: 0.5;
  }

  @keyframes border-pulse {
    0%, 100% { border-color: var(--color-orange-400); }
    50% { border-color: var(--color-orange-200); }
  }

  @keyframes transcription-pulse {
    0%, 100% { color: var(--color-orange-200); }
    50% { color: var(--color-orange-300); }
  }

  /* === TEXTAREA === */
  textarea {
    border: 0;
    outline: 0;
    box-shadow: none;
    -webkit-appearance: none;
    resize: none;
    field-sizing: content;
    font-size: var(--font-size-body);
    font-family: inherit;
    line-height: 1.5;
    max-height: 50dvh;
    overflow-y: auto;
    background: transparent;
    color: var(--text-color);
    padding: 1rem;
  }

  textarea:focus,
  textarea:focus-visible {
    border: 0;
    outline: 0;
    box-shadow: none;
  }

  textarea::placeholder {
    color: var(--color-grey-400);
  }

  textarea[readonly] { cursor: default; }

  /* === CONTROLS ROW === */
  .controls-row {
    position: relative;
    display: flex;
    align-items: center;
    padding: 0.2rem 0.5rem 0.45rem;
    gap: 8px;
  }

  .controls-spacer { flex: 1; }

  /* === GHOST BUTTON === */
  .ghost-btn {
    display: flex;
    align-items: center;
    justify-content: center;
    min-width: 32px; min-height: 32px;
    background: transparent;
    border: none;
    color: var(--color-grey-300);
    cursor: pointer;
    padding: 4px;
    border-radius: 8px;
    transition: color 200ms, background 200ms;
  }

  .ghost-btn:hover {
    color: var(--color-grey-100);
    background: var(--color-grey-900);
  }

  /* === TEXT BUTTON === */
  .text-btn {
    background: transparent;
    border: none;
    color: var(--color-grey-50);
    font-size: var(--font-size-small);
    font-weight: 500;
    font-family: inherit;
    cursor: pointer;
    padding: 0 8px;
    min-height: 32px;
    border-radius: 10px;
    display: flex;
    align-items: center;
    transition: color 200ms, background 200ms;
  }

  .text-btn:hover {
    color: var(--color-red-300);
    background: var(--color-red-500-translucent-18);
  }

  /* === PRIMARY BUTTON === */
  .primary-btn {
    flex-shrink: 0;
    min-width: 32px; max-width: 32px;
    min-height: 32px; max-height: 32px;
    border-radius: 10px;
    border: none;
    display: flex; align-items: center; justify-content: center;
    cursor: pointer; padding: 0;
    font-weight: 500;
    transition: box-shadow 200ms, background 200ms, color 200ms;
  }

  .primary-btn:disabled { opacity: 0.4; cursor: not-allowed; }

  .primary-btn.send-btn {
    background: var(--color-orange-400);
    color: var(--color-grey-900);
  }
  .primary-btn.send-btn:hover { background: var(--color-orange-500); }
  .primary-btn.send-btn:active { background: var(--color-orange-600); }

  .primary-btn.mic-corner-btn {
    background: var(--color-orange-400);
    color: var(--color-grey-900);
  }
  .primary-btn.mic-corner-btn:hover { background: var(--color-orange-500); }
  .primary-btn.mic-corner-btn:active { background: var(--color-orange-600); }

  .primary-btn.stop-btn {
    background: var(--color-red-500-translucent-18);
    color: var(--color-red-300);
  }
  .primary-btn.stop-btn:hover { background: var(--color-red-500-translucent-28); }
  .primary-btn.stop-btn:active { background: var(--color-red-500-translucent-38); }

  /* === MODEL SELECT === */
  .model-select-wrap {
    display: inline-flex;
  }

  .model-select {
    font-size: var(--font-size-small);
    font-weight: 500;
    color: var(--color-grey-400);
    border: none;
    border-radius: 8px;
    background: transparent;
    cursor: pointer;
    padding: 0.15rem 0.4rem;
    margin-right: 4px;
    font-family: inherit;
    transition: color 200ms;
  }

  .model-select option {
    background: var(--color-grey-800);
    color: var(--text-color);
  }

  .model-select:hover { color: var(--color-grey-200); }

  /* === WAVEFORM === */
  .waveform {
    flex: 1;
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 3px;
    height: 24px;
    overflow: hidden;
  }

  .waveform span {
    display: block;
    width: 2px;
    flex-shrink: 0;
    border-radius: 1px;
    background: var(--color-orange-100);
    transition: height 0.1s ease-out;
    min-height: 4px;
  }

  /* === INPUT TIP === */
  .input-tip {
    margin: 10px 0 0;
    text-align: center;
    font-size: var(--font-size-caption);
    color: var(--color-grey-400);
  }

  .input-tip :global(.tt-kbd) {
    display: inline-flex;
    align-items: center;
    gap: 3px;
    font-size: 0.65rem;
    padding: 1px 5px;
    border-radius: 4px;
    background: var(--color-grey-700);
    color: var(--color-grey-300);
  }

  .input-tip :global(.tip-tag) {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    border-radius: 20px;
    padding: 0 6px;
    font-weight: 500;
    line-height: 1.5em;
    white-space: nowrap;
    background: var(--color-grey-600);
    color: var(--color-grey-200);
  }

  .input-tip :global(.tip-info) {
    background: var(--color-blue-500-translucent-18);
    color: var(--color-blue-300);
  }

  .input-tip :global(.tip-success) {
    background: var(--color-green-500-translucent-18);
    color: var(--color-green-300);
  }

  .input-tip :global(.tip-hint) {
    color: var(--color-grey-400);
  }

  /* === SETTINGS POPOVER === */
  .settings-wrapper {
    position: relative;
  }

  .settings-backdrop {
    position: fixed;
    inset: 0;
    z-index: var(--z-dropdown);
  }

  .settings-popover {
    position: absolute;
    bottom: calc(100% + 8px);
    left: 0;
    background: var(--color-grey-900);
    border: 1px solid var(--color-grey-600);
    border-radius: 12px;
    padding: 12px;
    min-width: 220px;
    z-index: var(--z-popover);
    box-shadow: 0 4px 16px rgba(0, 0, 0, 0.4);
    display: flex;
    flex-direction: column;
  }

  .settings-section {
    display: flex;
    flex-direction: column;
    gap: 8px;
    padding: 4px 0;
  }

  .settings-section-title {
    font-size: var(--font-size-caption);
    font-weight: 600;
    color: var(--color-grey-400);
    text-transform: uppercase;
    letter-spacing: 0.04em;
  }

  .settings-divider {
    height: 1px;
    background: var(--color-grey-700);
    margin: 8px 0;
  }

  .settings-toggle {
    display: flex;
    align-items: center;
    justify-content: space-between;
    cursor: pointer;
  }

  .settings-label {
    display: flex;
    align-items: center;
    gap: 6px;
    font-size: var(--font-size-body);
    color: var(--text-color);
  }

  .settings-select {
    font-size: var(--font-size-body);
    font-family: inherit;
    color: var(--text-color);
    background: var(--color-grey-800);
    border: 1px solid var(--color-grey-600);
    border-radius: 8px;
    padding: 6px 8px;
    cursor: pointer;
    transition: border-color 200ms;
  }

  .settings-select:hover { border-color: var(--color-grey-500); }

  .settings-select option {
    background: var(--color-grey-800);
    color: var(--text-color);
  }

  /* === TOGGLE SWITCH === */
  .toggle-switch {
    position: relative;
    width: 36px;
    height: 20px;
    border-radius: 10px;
    border: none;
    background: var(--color-grey-600);
    cursor: pointer;
    padding: 0;
    transition: background 200ms;
  }

  .toggle-switch.active {
    background: var(--color-orange-400);
  }

  .toggle-knob {
    position: absolute;
    top: 2px;
    left: 2px;
    width: 16px;
    height: 16px;
    border-radius: 50%;
    background: var(--color-grey-50);
    transition: transform 200ms;
  }

  .toggle-switch.active .toggle-knob {
    transform: translateX(16px);
  }

  /* === TOAST === */
  .toast {
    position: fixed;
    top: 1rem;
    left: 50%;
    transform: translateX(-50%);
    max-width: 360px;
    padding: 0.6rem 1rem;
    background: var(--color-grey-900);
    color: var(--color-red-300);
    border: 1px solid var(--color-grey-600);
    border-radius: 8px;
    font-size: var(--font-size-small);
    line-height: 1.4;
    box-shadow: 0 2px 8px rgba(0, 0, 0, 0.3);
    animation: toast-in 200ms ease-out;
    z-index: var(--z-notification);
  }

  @keyframes toast-in {
    from { opacity: 0; transform: translateX(-50%) translateY(-0.5rem); }
    to { opacity: 1; transform: translateX(-50%) translateY(0); }
  }
</style>
