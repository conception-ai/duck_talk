<script lang="ts">
  import { marked } from 'marked';
  import { push } from 'svelte-spa-router';
  import ScenarioSelector from '../../lib/dev/ScenarioSelector.svelte';
  import {
    messageText,
    messageToolUses,
    messageThinking,
    buildToolResultMap,
    isToolResultOnly,
  } from '../../lib/message-helpers';
  import { SCENARIOS, type Scenario } from './scenarios';

  let scenario = $state<Scenario>(SCENARIOS[0]);
  let messages = $derived(scenario.state.messages);
  let pendingTool = $derived(scenario.state.pendingTool);
  let pendingApproval = $derived(scenario.state.pendingApproval);
  let status = $derived(scenario.state.status);
  let pendingInput = $derived(scenario.state.pendingInput);
  let toast = $derived(scenario.state.toast);
  let resultMap = $derived(buildToolResultMap(messages));

  // Local interactive state
  let inputText = $state('');
  let selectedModel = $state('opus');
  let muted = $state(false);
  let textareaEl: HTMLTextAreaElement;

  // Sync inputText from pendingInput (STT streaming or pending review)
  $effect(() => {
    if (status === 'connected' || (pendingInput && status === 'idle')) {
      inputText = pendingInput;
    }
  });

  function autoGrow() {
    if (!textareaEl) return;
    textareaEl.style.height = 'auto';
    textareaEl.style.height = Math.min(textareaEl.scrollHeight, 384) + 'px';
  }
</script>

<main>
  <header>
    <button class="header-link" onclick={() => push('/')}>Home</button>
    <span class="spacer"></span>
    <ScenarioSelector scenarios={SCENARIOS} bind:current={scenario} />
  </header>

  <!-- Single scroll container (messages + sticky input in same flow) -->
  <div class="scroll">
    <div class="column">
      <!-- Messages (flex-1 = emergent buffer zone) -->
      <div class="messages">
        {#each messages as msg}
          {#if !isToolResultOnly(msg)}
            <div class="bubble {msg.role}">
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
                  </details>
                {/each}
              {/if}
            </div>
          {/if}
        {/each}

        <!-- Streaming response -->
        {#if pendingTool && !pendingApproval}
          <div class="bubble assistant streaming">
            {#if pendingTool.text}
              <div class="prose">{@html marked.parse(pendingTool.text)}</div>
            {/if}
            {#if pendingTool.streaming}
              <div class="dots"><span></span><span></span><span></span></div>
            {/if}
          </div>
        {/if}
      </div>

      <!-- Sticky input area -->
      <div class="input-area">
        <!-- Approval float -->
        {#if pendingApproval}
          <div class="float approval">
            <div class="approval-text"><p>{pendingApproval.instruction}</p></div>
            <div class="approval-actions">
              <button class="btn-accept">Accept</button>
              <button class="btn-secondary">Edit</button>
              <button class="btn-reject">Reject</button>
            </div>
          </div>
        {/if}

        <!-- Two-row input box -->
        <div class="input-box">
          <!-- Row 1: Textarea (always visible) -->
          <textarea
            bind:this={textareaEl}
            bind:value={inputText}
            oninput={autoGrow}
            placeholder="What can I help you with?"
            rows="1"
            readonly={status === 'connected'}
            disabled={!!pendingTool?.streaming}
            class:stt-streaming={status === 'connected'}
          ></textarea>

          <!-- Row 2: Controls -->
          <div class="controls-row">
            {#if status === 'connected'}
              <button class="ctrl-btn" class:muted title={muted ? 'Unmute' : 'Mute'} onclick={() => muted = !muted}>
                {#if muted}
                  <svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor">
                    <path d="M16.5 12c0-1.77-1.02-3.29-2.5-4.03v2.21l2.45 2.45c.03-.2.05-.41.05-.63zm2.5 0c0 .94-.2 1.82-.54 2.64l1.51 1.51A8.796 8.796 0 0 0 21 12c0-4.28-2.99-7.86-7-8.77v2.06c2.89.86 5 3.54 5 6.71zM4.27 3L3 4.27 7.73 9H3v6h4l5 5v-6.73l4.25 4.25c-.67.52-1.42.93-2.25 1.18v2.06a8.99 8.99 0 0 0 3.69-1.81L19.73 21 21 19.73l-9-9L4.27 3zM12 4L9.91 6.09 12 8.18V4z"/>
                  </svg>
                {:else}
                  <svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor">
                    <path d="M3 9v6h4l5 5V4L7 9H3zm13.5 3c0-1.77-1.02-3.29-2.5-4.03v8.05c1.48-.73 2.5-2.25 2.5-4.02zM14 3.23v2.06c2.89.86 5 3.54 5 6.71s-2.11 5.85-5 6.71v2.06c4.01-.91 7-4.49 7-8.77s-2.99-7.86-7-8.77z"/>
                  </svg>
                {/if}
              </button>
            {:else}
              <button class="ctrl-btn" title="Add attachment">
                <svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor">
                  <path d="M19 13h-6v6h-2v-6H5v-2h6V5h2v6h6v2z"/>
                </svg>
              </button>
            {/if}
            <span class="controls-spacer"></span>
            {#if status !== 'connected'}
              <select class="model-select" bind:value={selectedModel}>
                <option value="opus">Opus</option>
                <option value="sonnet">Sonnet</option>
                <option value="haiku">Haiku</option>
              </select>
            {/if}
            <!-- Smart primary button -->
            {#if status === 'connecting'}
              <button class="primary-btn" disabled>
                <span class="spinner-icon"></span>
              </button>
            {:else if status === 'connected'}
              <button class="primary-btn stop-btn">
                <svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor">
                  <rect x="6" y="6" width="12" height="12" rx="2"/>
                </svg>
              </button>
            {:else if pendingTool?.streaming}
              <button class="primary-btn" disabled>
                <span class="pulse-icon"></span>
              </button>
            {:else if inputText.trim()}
              <button class="primary-btn send-btn">
                <svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor">
                  <path d="M2.01 21L23 12 2.01 3 2 10l15 2-15 2z"/>
                </svg>
              </button>
            {:else}
              <button class="primary-btn mic-btn">
                <svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor">
                  <path d="M12 14c1.66 0 3-1.34 3-3V5c0-1.66-1.34-3-3-3S9 3.34 9 5v6c0 1.66 1.34 3 3 3zm5.3-3c0 3-2.54 5.1-5.3 5.1S6.7 14 6.7 11H5c0 3.41 2.72 6.23 6 6.72V21h2v-3.28c3.28-.48 6-3.3 6-6.72h-1.7z"/>
                </svg>
              </button>
            {/if}
          </div>
        </div>
      </div>
    </div>
  </div>

  <!-- Toast -->
  {#if toast}
    <div class="toast">{toast}</div>
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
    font-size: 0.8rem;
    color: #888;
    border: none;
    background: none;
    cursor: pointer;
    padding: 0.25rem 0;
  }

  .header-link:hover { color: #333; }
  .spacer { flex: 1; }

  /* --- Single scroll container --- */
  .scroll {
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

  /* --- Messages (flex-1 = buffer zone) --- */
  .messages {
    flex: 1;
    padding: 0.5rem 1rem 1rem;
    display: flex;
    flex-direction: column;
    gap: 0.75rem;
  }

  /* --- Bubbles --- */
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

  .bubble.streaming { opacity: 0.7; }

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

  .tool-use summary::-webkit-details-marker { display: none; }

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

  /* --- Sticky input area --- */
  .input-area {
    position: sticky;
    bottom: 0;
    padding: 1rem 1rem 0.5rem;
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
    background: linear-gradient(to bottom, transparent, #fafafa 1rem);
  }

  /* --- Approval float --- */
  .float.approval {
    padding: 0.6rem 0.75rem;
    border-radius: 0.75rem;
    background: white;
    border: 1.5px solid #059669;
    font-size: 0.85rem;
    animation: slide-up 0.15s ease-out;
  }

  .approval-text {
    max-height: 6rem;
    overflow-y: auto;
  }

  .approval-text p { margin: 0; }

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
    cursor: pointer;
    border: 1px solid currentColor;
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

  /* --- Two-row input box --- */
  .input-box {
    display: flex;
    flex-direction: column;
    background: white;
    border: 1px solid #e0e0e0;
    border-radius: 1rem;
    box-shadow: 0 1px 3px rgba(0,0,0,0.04);
  }

  textarea {
    border: none;
    outline: none;
    resize: none;
    font-size: 0.9rem;
    font-family: inherit;
    line-height: 1.5;
    max-height: 384px;
    overflow-y: auto;
    background: transparent;
    padding: 0.65rem 0.85rem 0.15rem;
  }

  textarea::placeholder { color: #aaa; }
  textarea:disabled { opacity: 0.5; }

  /* --- STT streaming state --- */
  textarea.stt-streaming {
    font-style: italic;
    color: #059669;
    border-left: 3px solid #059669;
    opacity: 1;
  }

  /* --- Controls row --- */
  .controls-row {
    display: flex;
    align-items: center;
    padding: 0.2rem 0.5rem 0.45rem;
    gap: 0.35rem;
  }

  .controls-spacer { flex: 1; }

  .ctrl-btn {
    width: 28px;
    height: 28px;
    border-radius: 50%;
    border: none;
    background: none;
    color: #bbb;
    cursor: pointer;
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 0;
  }

  .ctrl-btn:hover { background: #f5f5f5; color: #888; }

  .model-select {
    font-size: 0.8rem;
    font-weight: 500;
    color: #888;
    border: none;
    background: none;
    cursor: pointer;
    padding: 0.15rem 0;
  }

  .model-select:hover { color: #555; }

  .ctrl-btn.muted { color: #dc2626; }

  /* --- Smart primary button --- */
  .primary-btn {
    flex-shrink: 0;
    width: 32px;
    height: 32px;
    border-radius: 50%;
    border: none;
    display: flex;
    align-items: center;
    justify-content: center;
    cursor: pointer;
    padding: 0;
    transition: background 0.15s, opacity 0.15s;
  }

  .primary-btn:disabled { opacity: 0.3; cursor: default; }

  .primary-btn.send-btn {
    background: #1a1a1a;
    color: white;
  }

  .primary-btn.send-btn:hover { opacity: 0.8; }

  .primary-btn.mic-btn {
    background: #f0f0f0;
    color: #888;
  }

  .primary-btn.mic-btn:hover { background: #e5e5e5; color: #555; }

  .primary-btn.stop-btn {
    background: #dc2626;
    color: white;
  }

  .primary-btn.stop-btn:hover { background: #b91c1c; }

  .spinner-icon {
    width: 14px;
    height: 14px;
    border: 2px solid #ccc;
    border-top-color: #666;
    border-radius: 50%;
    animation: spin 0.8s linear infinite;
  }

  @keyframes spin {
    to { transform: rotate(360deg); }
  }

  .pulse-icon {
    width: 8px;
    height: 8px;
    border-radius: 50%;
    background: #999;
    animation: pulse-fade 1.5s ease-in-out infinite;
  }

  @keyframes pulse-fade {
    0%, 100% { opacity: 0.3; }
    50% { opacity: 1; }
  }

  /* --- Toast --- */
  .toast {
    position: fixed;
    top: 1rem;
    left: 50%;
    transform: translateX(-50%);
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
    z-index: 200;
  }

  @keyframes toast-in {
    from { opacity: 0; transform: translateX(-50%) translateY(-0.5rem); }
    to { opacity: 1; transform: translateX(-50%) translateY(0); }
  }
</style>
