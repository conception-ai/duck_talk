<script lang="ts">
  import { onMount } from 'svelte';
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
  import reduckLogo from '../../assets/Reduck_Brand_Mark_RGB_Inverse.svg';
  import './styles/colorPalette.css';
  import './styles/fontSizes.css';
  import './styles/reduck-theme.css';

  let scenario = $state<Scenario>(SCENARIOS[0]);
  let messages = $derived(scenario.state.messages);
  let pendingTool = $derived(scenario.state.pendingTool);
  let pendingApproval = $derived(scenario.state.pendingApproval);
  let scenarioStatus = $derived(scenario.state.status);
  let pendingInput = $derived(scenario.state.pendingInput);
  let toast = $derived(scenario.state.toast);

  // Local status override (mic click sets to 'connected')
  let statusOverride = $state<'idle' | 'connecting' | 'connected' | null>(null);
  let status = $derived(statusOverride ?? scenarioStatus);
  let resultMap = $derived(buildToolResultMap(messages));

  // Local interactive state
  let inputText = $state('');
  let selectedModel = $state('opus');
  let muted = $state(false);
  let textareaEl: HTMLTextAreaElement;

  // Mic intro (until first use)
  let micHasBeenUsed = $state(false);

  // Placeholder rotation
  const PLACEHOLDERS = ['What can I help you with?', 'Try speaking your request...'];
  let placeholderIndex = $state(0);
  let placeholderFade = $state(true);
  let placeholderInterval: ReturnType<typeof setInterval> | undefined;

  // Sidebar state
  let sidebarOpen = $state(false);
  let mounted = $state(false);

  // Session title state
  let sessionTitle = $state('Current session');
  let titleDropdownOpen = $state(false);
  let renaming = $state(false);
  let renameInput = $state('');

  // Editable transcription state (approval mode)
  let editing = $state(false);
  let originalApprovalText = $state('');

  // Typing animation for recording mode
  let typingInterval: ReturnType<typeof setInterval> | undefined;

  // Settings popover
  let settingsOpen = $state(false);
  let inputMuted = $state(false);
  let outputMuted = $state(false);
  let transcriptionMode = $state<'direct' | 'review'>('review');
  let permissionMode = $state<'plan' | 'accept-edits'>('plan');
  const PERMISSION_MODES = ['plan', 'accept-edits'] as const;
  let permissionModeLabel = $derived(permissionMode === 'plan' ? 'Plan' : 'Accept Edits');

  function startRename() {
    renameInput = sessionTitle;
    renaming = true;
    titleDropdownOpen = false;
  }

  function confirmRename() {
    if (renameInput.trim()) sessionTitle = renameInput.trim();
    renaming = false;
  }

  function deleteSession() {
    titleDropdownOpen = false;
    // In a real app this would delete; here just reset
    sessionTitle = 'New session';
  }

  onMount(() => {
    sidebarOpen = localStorage.getItem('sidebar-open') === 'true';
    micHasBeenUsed = localStorage.getItem('mic-used') === 'true';
    requestAnimationFrame(() => { mounted = true; });

    function onGlobalKey(e: KeyboardEvent) {
      if (e.key === 'Escape' && inputMode === 'recording') {
        e.preventDefault();
        exitLive();
        return;
      }
      // Shift+Tab: cycle permission mode (in empty or conversation idle)
      if (e.key === 'Tab' && e.shiftKey && inputMode === 'idle') {
        e.preventDefault();
        const idx = PERMISSION_MODES.indexOf(permissionMode);
        permissionMode = PERMISSION_MODES[(idx + 1) % PERMISSION_MODES.length];
        return;
      }
      // Cmd+M: start Live mode
      if (e.metaKey && e.key === 'm' && inputMode === 'idle') {
        e.preventDefault();
        onMicClick();
        return;
      }
      // When mic-center is showing and no input is focused, handle typing
      const active = document.activeElement;
      const isInputFocused = active instanceof HTMLInputElement || active instanceof HTMLTextAreaElement || active instanceof HTMLSelectElement;
      if (showMicCenter && !isInputFocused) {
        if (e.metaKey || e.ctrlKey || e.altKey) return;
        if (e.key.length === 1) { e.preventDefault(); switchToTyping(e.key); }
      }
    }
    window.addEventListener('keydown', onGlobalKey);

    return () => {
      if (placeholderInterval) clearInterval(placeholderInterval);
      window.removeEventListener('keydown', onGlobalKey);
    };
  });

  $effect(() => {
    if (mounted) localStorage.setItem('sidebar-open', sidebarOpen.toString());
  });

  // Derive the input mode from scenario state
  // idle = default, recording = STT active, review = approval text ready to edit/send
  type InputMode = 'idle' | 'recording' | 'review' | 'streaming';
  let inputMode = $derived<InputMode>(
    pendingApproval ? 'review' :
    status === 'connected' ? 'recording' :
    pendingTool?.streaming ? 'streaming' :
    'idle'
  );

  // Placeholder rotation — only in empty scenario
  let isEmpty = $derived(messages.length === 0 && inputMode === 'idle');
  let micGlow = $derived(!micHasBeenUsed && isEmpty && placeholderIndex === 1);

  // Empty mode: mic-centered vs typing
  let typingMode = $state(false);
  let showMicCenter = $derived(isEmpty && !inputText.trim());

  function switchToTyping(initialChar = '') {
    typingMode = true;
    inputText = initialChar;
    requestAnimationFrame(() => {
      textareaEl?.focus();
    });
  }

  function onMicCenterKey(e: KeyboardEvent) {
    // Ignore modifier keys, Tab, Escape, etc.
    if (e.ctrlKey || e.altKey) return;
    if (e.metaKey) return; // Cmd shortcuts handled by global handler
    if (e.key === 'Tab' || e.key === 'Escape' || e.key === 'Shift') return;
    if (e.key === 'Enter') { switchToTyping(); return; }
    // Printable character — switch to typing with that char
    if (e.key.length === 1) {
      e.preventDefault();
      switchToTyping(e.key);
    }
  }

  $effect(() => {
    if (isEmpty) {
      placeholderInterval = setInterval(() => {
        placeholderFade = false;
        setTimeout(() => {
          placeholderIndex = (placeholderIndex + 1) % PLACEHOLDERS.length;
          placeholderFade = true;
        }, 300);
      }, 4000);
    } else {
      if (placeholderInterval) clearInterval(placeholderInterval);
      placeholderIndex = 0;
      placeholderFade = true;
    }
  });

  // Reset local overrides when scenario changes
  $effect(() => {
    scenario; // track scenario identity
    typingMode = false;
    statusOverride = null;
  });

  // Sync inputText from scenario state
  $effect(() => {
    if (typingInterval) { clearInterval(typingInterval); typingInterval = undefined; }

    if (pendingApproval) {
      inputText = pendingApproval.instruction;
      originalApprovalText = pendingApproval.instruction;
      editing = false;
    } else if (inputMode === 'recording' && pendingInput) {
      // Typing animation: reveal text character by character
      const fullText = pendingInput;
      let charIndex = 0;
      inputText = '';
      editing = false;
      typingInterval = setInterval(() => {
        charIndex++;
        inputText = fullText.slice(0, charIndex);
        if (charIndex >= fullText.length) {
          clearInterval(typingInterval);
          typingInterval = undefined;
        }
      }, 40);
    } else if (!statusOverride) {
      inputText = pendingInput || '';
      editing = false;
    }
    // Clear any leftover inline height from previous scenario
    if (textareaEl) textareaEl.style.height = '';

    return () => {
      if (typingInterval) { clearInterval(typingInterval); typingInterval = undefined; }
    };
  });

  const MIC_SVG = '<svg viewBox="0 0 24 24" width="10" height="10" fill="currentColor"><path d="M12 14a3 3 0 0 0 3-3V5a3 3 0 0 0-6 0v6a3 3 0 0 0 3 3zm5-3a5 5 0 0 1-10 0H5a7 7 0 0 0 6 6.92V21h2v-3.08A7 7 0 0 0 19 11h-2z"/></svg>';

  let inputTip = $derived(
    inputMode === 'review' ? `<span class="tt-voice">${MIC_SVG}Send</span> or <span class="tt-voice">${MIC_SVG}Clear</span>` :
    inputMode === 'recording' ? `<span class="tt-kbd">ESC</span> to exit Live` :
    inputMode === 'streaming' ? `<span class="tt-kbd">ESC</span> / <span class="tt-voice">${MIC_SVG}Stop</span> to interrupt` :
    inputText.trim() ? `Press <span class="tt-kbd">Enter</span> to send` :
    `Permission mode: <span class="tip-tag ${permissionMode === 'plan' ? 'tip-info' : 'tip-success'}">${permissionModeLabel}</span> <span class="tip-hint">(shift+tab to switch)</span>`
  );

  // Waveform bar heights (matching voice waveform envelope from reference image)
  // Short edges → tall center with natural variation
  const WAVE_HEIGHTS = [
    2,4,6,8,4,11,7,15,10,19,12,22,16,24,14,20,18,12,19,15,10,14,7,11,6,8,4,4,2,2
  ];

  let currentPlaceholder = $derived(
    inputMode === 'streaming' ? 'Wait for the agent to finish or say "Stop"' :
    PLACEHOLDERS[placeholderIndex]
  );

  function onMicClick() {
    if (!micHasBeenUsed) {
      micHasBeenUsed = true;
      localStorage.setItem('mic-used', 'true');
    }
    statusOverride = 'connected';
  }

  function exitLive() {
    statusOverride = 'idle';
    requestAnimationFrame(() => textareaEl?.focus());
  }

  function clearInput() {
    inputText = '';
    if (textareaEl) {
      textareaEl.style.height = '';
      textareaEl.focus();
    }
  }

  function autoGrow() {
    if (!textareaEl) return;
    // Always reset to natural height first
    textareaEl.style.height = '';
    if (!inputText.trim()) return;
    // Only set explicit height if content overflows natural size
    if (textareaEl.scrollHeight > textareaEl.clientHeight) {
      const maxH = window.innerHeight * 0.5;
      textareaEl.style.height = Math.min(textareaEl.scrollHeight, maxH) + 'px';
    }
  }

  function onTextareaFocus() {
    if (inputMode === 'review') {
      editing = true;
    }
  }

  function onTextareaBlur() {
    if (inputMode === 'review' && inputText === originalApprovalText) {
      editing = false;
    }
  }

  // Tooltip action — portals a tooltip to <body> on hover (matching Reduck Tooltip)
  function tip(label: string, opts?: { kbd?: string; voice?: string }) {
    if (!opts || (!opts.kbd && !opts.voice)) return label;
    const tags: string[] = [];
    if (opts.kbd) tags.push(`<span class="tt-kbd">${opts.kbd}</span>`);
    if (opts.voice) tags.push(`<span class="tt-voice">${MIC_SVG}${opts.voice}</span>`);
    const row = `<span class="tt-shortcuts">${tags.join('')}</span>`;
    if (opts.kbd && opts.voice) return `<span class="tt-label">${label}</span>${row}`;
    return `${label} ${row}`;
  }

  function tooltip(node: HTMLElement, html: string) {
    let el: HTMLDivElement | null = null;

    function show() {
      el = document.createElement('div');
      el.className = 'portal-tooltip';
      el.innerHTML = html + '<div class="portal-tooltip-arrow"></div>';
      document.body.appendChild(el);
      // Position after the browser has laid out the element
      requestAnimationFrame(() => {
        if (!el) return;
        const rect = node.getBoundingClientRect();
        const tipRect = el.getBoundingClientRect();
        el.style.left = `${rect.left + rect.width / 2 - tipRect.width / 2}px`;
        el.style.top = `${rect.top - tipRect.height - 8}px`;
        el.style.opacity = '1';
      });
    }

    function hide() {
      el?.remove();
      el = null;
    }

    node.addEventListener('mouseenter', show);
    node.addEventListener('mouseleave', hide);

    return {
      update(newHtml: string) { html = newHtml; },
      destroy() {
        hide();
        node.removeEventListener('mouseenter', show);
        node.removeEventListener('mouseleave', hide);
      }
    };
  }
</script>

<div class="app-layout reduck-theme">
  <!-- Sidebar (copied from storybook Header pattern) -->
  <header class="sidebar" class:mounted class:open={sidebarOpen}>
    <div class="top-actions">
      {#if sidebarOpen}
        <a class="redirect-homepage-link" aria-label="Homepage" href="#/" onclick={(e) => { e.preventDefault(); push('/'); }}>
          <img src={reduckLogo} alt="Reduck" width="31" height="31" />
        </a>
        <button class="sidebar-toggle-btn" type="button" onclick={() => sidebarOpen = !sidebarOpen} aria-label="Collapse sidebar" use:tooltip={'Collapse sidebar'}>
          <!-- sidebar icon -->
          <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <rect x="3" y="3" width="18" height="18" rx="2"/>
            <line x1="9" y1="3" x2="9" y2="21"/>
          </svg>
        </button>
      {:else}
        <button class="expand-sidebar-button" type="button" aria-label="Expand sidebar" use:tooltip={'Expand sidebar'} onclick={() => sidebarOpen = !sidebarOpen}>
          <img src={reduckLogo} alt="Reduck" width="31" height="31" />
        </button>
      {/if}
    </div>
    <nav aria-label="Main">
      <ul>
        <li>
          <a class="nav-link primary" href="#/" onclick={(e) => { e.preventDefault(); push('/'); }}>
            <!-- plus-square icon -->
            <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <rect x="3" y="3" width="18" height="18" rx="2"/>
              <line x1="12" y1="8" x2="12" y2="16"/>
              <line x1="8" y1="12" x2="16" y2="12"/>
            </svg>
            {#if sidebarOpen}<span class="ellipsis">New session</span>{/if}
          </a>
        </li>
      </ul>
    </nav>
    {#if sidebarOpen}
      <nav class="recent-sessions-nav" aria-label="Recent sessions">
        <span class="nav-label ellipsis">Recent sessions</span>
        <ul>
          <li>
            <a class="nav-link active" href="#/new-ui">
              <span class="ellipsis">Current session</span>
            </a>
          </li>
        </ul>
      </nav>
    {/if}
    <nav class="user-account-nav" aria-label="User account">
      <ul>
        <li>
          <button class="nav-link avatar-link" type="button">
            <span class="user-avatar" aria-label="User avatar">EM</span>
            {#if sidebarOpen}<span class="ellipsis">Elie Molzino</span>{/if}
          </button>
        </li>
      </ul>
    </nav>
  </header>

  <!-- Main content -->
  <main>
    <div class="content-header">
      <div class="session-title-wrapper">
        {#if renaming}
          <input
            class="rename-input"
            type="text"
            bind:value={renameInput}
            onkeydown={(e) => { if (e.key === 'Enter') confirmRename(); if (e.key === 'Escape') renaming = false; }}
            onblur={confirmRename}
          />
        {:else}
          <!-- svelte-ignore a11y_click_events_have_key_events -->
          <!-- svelte-ignore a11y_no_static_element_interactions -->
          <div class="session-title-btn" onclick={() => titleDropdownOpen = !titleDropdownOpen}>
            <span class="session-title-text">{sessionTitle}</span>
            <svg class="chevron-icon" class:open={titleDropdownOpen} viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <polyline points="6 9 12 15 18 9"/>
            </svg>
          </div>
          {#if titleDropdownOpen}
            <!-- svelte-ignore a11y_click_events_have_key_events -->
            <!-- svelte-ignore a11y_no_static_element_interactions -->
            <div class="title-dropdown-backdrop" onclick={() => titleDropdownOpen = false}></div>
            <div class="title-dropdown">
              <button class="dropdown-item" onclick={startRename}>
                <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                  <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/>
                  <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/>
                </svg>
                Rename
              </button>
              <button class="dropdown-item danger" onclick={deleteSession}>
                <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                  <polyline points="3 6 5 6 21 6"/>
                  <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/>
                </svg>
                Delete
              </button>
            </div>
          {/if}
        {/if}
      </div>
      <span class="spacer"></span>
      <ScenarioSelector scenarios={SCENARIOS} bind:current={scenario} />
    </div>

    <div class="scroll">
      <div class="column">
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

        <!-- Unified input area -->
        <div class="input-area">
          <div class="input-box" class:recording={inputMode === 'recording'} class:review={inputMode === 'review'} class:streaming={inputMode === 'streaming'} class:editing class:mic-center={showMicCenter}>
            {#if showMicCenter}
              <!-- svelte-ignore a11y_autofocus -->
              <input class="mic-center-trap" autofocus onkeydown={onMicCenterKey} />
              <!-- svelte-ignore a11y_click_events_have_key_events -->
              <!-- svelte-ignore a11y_no_static_element_interactions -->
              <div class="mic-center-zone" onclick={() => { document.querySelector<HTMLInputElement>('.mic-center-trap')?.focus(); }}>
                <button class="mic-center-btn" class:mic-intro={micGlow} aria-label="Start talking" use:tooltip={tip('Start talking', { kbd: '⌘M' })} onclick={(e) => { e.stopPropagation(); onMicClick(); }}>
                    <svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor">
                      <path d="M12 14c1.66 0 3-1.34 3-3V5c0-1.66-1.34-3-3-3S9 3.34 9 5v6c0 1.66 1.34 3 3 3zm5.3-3c0 3-2.54 5.1-5.3 5.1S6.7 14 6.7 11H5c0 3.41 2.72 6.23 6 6.72V21h2v-3.28c3.28-.48 6-3.3 6-6.72h-1.7z"/>
                    </svg>
                  </button>
              </div>
            {:else}
              <textarea
                bind:this={textareaEl}
                bind:value={inputText}
                oninput={autoGrow}
                onfocus={onTextareaFocus}
                onblur={onTextareaBlur}
                onkeydown={(e) => { if (e.metaKey && e.key === 'm') e.preventDefault(); }}
                placeholder={currentPlaceholder}
                class:placeholder-fade={placeholderFade}
                readonly={inputMode === 'recording' || inputMode === 'streaming'}
              ></textarea>
            {/if}

            <div class="controls-row">
              {#if inputMode === 'idle' || inputMode === 'streaming'}
                <!-- Add files button (idle/streaming only) -->
                <button class="ghost-btn" type="button" aria-label="Add files" use:tooltip={'Add files'}>
                  <svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor">
                    <path d="M19 13h-6v6h-2v-6H5v-2h6V5h2v6h6v2z"/>
                  </svg>
                </button>
              {/if}

              <!-- Settings button -->
              <div class="settings-wrapper">
                <button class="ghost-btn" type="button" aria-label="Settings" use:tooltip={'Settings'} onclick={() => settingsOpen = !settingsOpen}>
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
                      <select class="settings-select" bind:value={transcriptionMode}>
                        <option value="direct">Direct</option>
                        <option value="review">Review</option>
                      </select>
                    </div>
                    <div class="settings-divider"></div>
                    <div class="settings-section">
                      <span class="settings-section-title">Permission Mode</span>
                      <select class="settings-select" bind:value={permissionMode}>
                        <option value="plan">Plan</option>
                        <option value="accept-edits">Accept Edits</option>
                      </select>
                    </div>
                  </div>
                {/if}
              </div>

              {#if inputMode === 'recording'}
                <!-- Recording: waveform center, stop right -->
                <div class="waveform">
                  {#each WAVE_HEIGHTS as h, i}
                    <span style="--h: {h}px; animation-delay: {(i * 0.08) % 1.6}s"></span>
                  {/each}
                </div>
                <button class="primary-btn stop-btn" aria-label="Exit Live" use:tooltip={tip('Exit Live', { kbd: 'ESC', voice: 'Exit Live' })} onclick={exitLive}>
                  <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round">
                    <line x1="7" y1="7" x2="17" y2="17"/><line x1="17" y1="7" x2="7" y2="17"/>
                  </svg>
                </button>
              {:else if inputMode === 'review'}
                <!-- Review: waveform center (unless editing), clear + send right -->
                <div class="waveform">
                  {#each WAVE_HEIGHTS as h, i}
                    <span style="--h: {h}px; animation-delay: {(i * 0.08) % 1.6}s"></span>
                  {/each}
                </div>
                <button class="text-btn clear-btn" use:tooltip={tip('Clear', { voice: 'Clear' })} onclick={clearInput}>Clear</button>
                <button class="primary-btn send-btn" aria-label="Send" use:tooltip={tip('Send', { kbd: 'Enter', voice: 'Send' })}>
                  <svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor">
                    <path d="M2.01 21L23 12 2.01 3 2 10l15 2-15 2z"/>
                  </svg>
                </button>
              {:else if inputMode === 'streaming'}
                <!-- Streaming: stop button active -->
                <span class="controls-spacer"></span>
                <button class="primary-btn stop-btn" aria-label="Stop" use:tooltip={tip('Stop', { kbd: 'ESC', voice: 'Stop' })}>
                  <svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor">
                    <rect x="6" y="6" width="12" height="12" rx="2"/>
                  </svg>
                </button>
              {:else}
                <!-- Idle: spacer + model select + send (mic is centered above when empty) -->
                {#if showMicCenter}
                  <span class="type-instead">or start typing</span>
                {/if}
                <span class="controls-spacer"></span>
                {#if !showMicCenter}
                  <span class="model-select-wrap" use:tooltip={'Change model'}>
                    <select class="model-select" bind:value={selectedModel}>
                      <option value="opus">Opus</option>
                      <option value="sonnet">Sonnet</option>
                      <option value="haiku">Haiku</option>
                    </select>
                  </span>
                  {#if inputText.trim()}
                    <button class="primary-btn send-btn" aria-label="Send" use:tooltip={tip('Send', { kbd: 'Enter' })}>
                      <svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor">
                        <path d="M2.01 21L23 12 2.01 3 2 10l15 2-15 2z"/>
                      </svg>
                    </button>
                  {:else}
                    <button class="primary-btn mic-corner-btn" aria-label="Start talking" use:tooltip={tip('Start talking', { kbd: '⌘M' })} onclick={onMicClick}>
                      <svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor">
                        <path d="M12 14a3 3 0 0 0 3-3V5a3 3 0 0 0-6 0v6a3 3 0 0 0 3 3zm5-3a5 5 0 0 1-10 0H5a7 7 0 0 0 6 6.92V21h2v-3.08A7 7 0 0 0 19 11h-2z"/>
                      </svg>
                    </button>
                  {/if}
                {:else}
                  <span class="model-select-wrap" use:tooltip={'Change model'}>
                    <select class="model-select" bind:value={selectedModel}>
                      <option value="opus">Opus</option>
                      <option value="sonnet">Sonnet</option>
                      <option value="haiku">Haiku</option>
                    </select>
                  </span>
                  {#if inputText.trim()}
                    <button class="primary-btn send-btn" aria-label="Send" use:tooltip={tip('Send', { kbd: 'Enter' })}>
                      <svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor">
                        <path d="M2.01 21L23 12 2.01 3 2 10l15 2-15 2z"/>
                      </svg>
                    </button>
                  {/if}
                {/if}
              {/if}
            </div>
          </div>
          <p class="input-tip">{@html inputTip}</p>
        </div>
      </div>
    </div>

    {#if toast}
      <div class="toast">{toast}</div>
    {/if}
  </main>
</div>

<style>
  /* ============================================
     APP LAYOUT
     ============================================ */
  .app-layout {
    display: flex;
    width: 100%;
    height: 100dvh;
    overflow: hidden;
  }

  /* ============================================
     SIDEBAR (copied from storybook Header)
     ============================================ */
  .sidebar {
    background: var(--color-grey-900);
    display: flex;
    flex-direction: column;
    gap: 10px;
    max-width: 52px;
    padding-bottom: 8px;
    width: 100%;
    overflow: hidden;
    flex-shrink: 0;
  }

  .sidebar.mounted {
    transition: max-width 400ms;
  }

  .sidebar.open {
    max-width: 226px;
  }

  .top-actions {
    align-items: center;
    display: flex;
    height: 55px;
    justify-content: space-between;
    padding: 0 10px;
  }

  .redirect-homepage-link,
  .expand-sidebar-button {
    align-items: center;
    background: none;
    border: none;
    border-radius: 4px;
    cursor: pointer;
    display: flex;
    justify-content: center;
    margin: 0;
    padding: 0;
    text-decoration: none;
  }

  .sidebar-toggle-btn {
    align-items: center;
    background: none;
    border: none;
    border-radius: 4px;
    color: var(--color-grey-400);
    cursor: pointer;
    display: flex;
    justify-content: center;
    padding: 4px;
    transition: background 200ms, color 200ms;
  }

  .sidebar-toggle-btn:hover {
    background: var(--color-grey-800);
    color: var(--color-grey-200);
  }

  /* Nav links (matching storybook) */
  .nav-link {
    align-items: center;
    background: transparent;
    border-radius: 4px;
    color: var(--color-grey-300);
    display: flex;
    gap: 0.5em;
    min-height: 31px;
    padding: 0 8px;
    text-align: left;
    text-decoration: none;
    transition: color 200ms, background 200ms;
    width: 100%;
  }

  .nav-link.primary {
    color: var(--color-grey-50);
    font-weight: 500;
  }

  .nav-link:focus,
  .nav-link:hover {
    background: var(--color-grey-800);
  }

  .nav-link:active,
  .nav-link.active {
    background: var(--color-grey-700);
  }

  .sidebar:not(.open) .nav-link {
    min-height: 31px;
    min-width: 31px;
    width: fit-content;
  }

  .nav-link > :global(*) {
    flex-shrink: 0;
  }

  .sidebar nav {
    display: flex;
    flex-direction: column;
  }

  .sidebar ul {
    display: flex;
    flex-direction: column;
    gap: 10px;
    list-style: none;
    margin: 0;
    overflow: hidden auto;
    padding: 10px;
  }

  .user-account-nav {
    margin-top: auto;
  }

  /* User avatar (matching storybook UserAvatar) */
  .avatar-link {
    cursor: pointer;
    border: none;
    font-size: var(--font-size-body);
  }

  .user-avatar {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 31px;
    height: 31px;
    border-radius: 50%;
    background: var(--color-grey-50);
    color: var(--color-grey-900);
    font-size: 11px;
    font-weight: 500;
    flex-shrink: 0;
    line-height: 1;
  }

  .ellipsis {
    flex: 1;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .recent-sessions-nav {
    overflow: hidden;
  }

  .recent-sessions-nav ul {
    overflow: auto;
    padding: 10px;
    padding-top: 6px;
  }

  .nav-label {
    color: var(--color-grey-400);
    font-size: var(--font-size-caption);
    padding: 0 10px 4px;
  }

  /* ============================================
     MAIN CONTENT
     ============================================ */
  main {
    flex: 1;
    min-width: 0;
    display: flex;
    flex-direction: column;
    background: var(--background-color);
  }

  .content-header {
    flex-shrink: 0;
    display: flex;
    align-items: center;
    padding: 1rem 1rem;
    width: 100%;
    box-sizing: border-box;
  }

  .spacer { flex: 1; }

  /* Session title */
  .session-title-wrapper {
    position: relative;
  }

  .session-title-btn {
    display: flex;
    align-items: center;
    gap: 4px;
    cursor: pointer;
    padding: 4px 8px;
    border-radius: 8px;
    transition: background 200ms;
  }

  .session-title-btn:hover {
    background: var(--color-grey-700);
  }

  .session-title-text {
    font-size: var(--font-size-body);
    font-weight: 500;
    color: var(--text-color);
  }

  .chevron-icon {
    color: var(--color-grey-400);
    transition: transform 200ms;
  }

  .chevron-icon.open {
    transform: rotate(180deg);
  }

  .title-dropdown-backdrop {
    position: fixed;
    inset: 0;
    z-index: var(--z-dropdown);
  }

  .title-dropdown {
    position: absolute;
    top: calc(100% + 4px);
    left: 0;
    background: var(--color-grey-900);
    border: 1px solid var(--color-grey-600);
    border-radius: 8px;
    padding: 4px;
    min-width: 160px;
    z-index: var(--z-popover);
    box-shadow: 0 4px 12px rgba(0, 0, 0, 0.3);
  }

  .dropdown-item {
    display: flex;
    align-items: center;
    gap: 8px;
    width: 100%;
    padding: 8px 12px;
    border: none;
    border-radius: 6px;
    background: transparent;
    color: var(--text-color);
    font-size: var(--font-size-body);
    cursor: pointer;
    transition: background 200ms;
  }

  .dropdown-item:hover {
    background: var(--color-grey-700);
  }

  .dropdown-item.danger {
    color: var(--color-red-400);
  }

  .dropdown-item.danger:hover {
    background: var(--color-red-500-translucent-18);
  }

  .rename-input {
    background: transparent;
    border: 1px solid var(--color-orange-400);
    border-radius: 8px;
    color: var(--text-color);
    font-size: var(--font-size-body);
    font-weight: 500;
    padding: 4px 8px;
    outline: none;
    font-family: inherit;
  }

  /* ScenarioSelector dark overrides */
  main :global(.scenario-selector) {
    color: var(--color-grey-400);
    background: transparent;
    border: 1px solid var(--color-grey-600);
    border-radius: 8px;
    font-size: var(--font-size-small);
  }

  main :global(.scenario-selector:hover) {
    color: var(--color-grey-200);
    border-color: var(--color-grey-500);
  }

  main :global(.scenario-selector option) {
    background: var(--color-grey-800);
    color: var(--text-color);
  }

  /* ============================================
     SCROLL + COLUMN
     ============================================ */
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

  /* ============================================
     MESSAGES
     ============================================ */
  .messages {
    flex: 1;
    padding: 0.5rem 1rem 1rem;
    display: flex;
    flex-direction: column;
    gap: 0.75rem;
  }

  .bubble {
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

  /* Markdown prose */
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

  /* Thinking */
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

  /* Tool use */
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
    margin-top: 4px;
    margin-left: 4px;
    padding: 0.4rem 0.6rem;
    border-left: 2px solid var(--color-blue-500-translucent-18);
    border-radius: 0 8px 8px 0;
  }

  .tool-args {
    font-size: var(--font-size-small);
    font-style: italic;
    color: var(--color-grey-400);
    margin: 0;
    padding: 0.4rem 0.6rem;
    background: var(--color-grey-900);
    border-radius: 8px;
  }

  .tool-text {
    font-size: var(--font-size-small);
    white-space: pre-wrap;
    max-height: 200px;
    overflow-y: auto;
    color: var(--color-grey-300);
    margin-top: 4px;
  }

  /* Dots */
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

  /* ============================================
     UNIFIED INPUT AREA
     ============================================ */
  .input-area {
    position: sticky;
    bottom: 0;
    padding: 1rem 1rem 1rem;
    display: flex;
    flex-direction: column;
    background: linear-gradient(to bottom, transparent, var(--background-color) 1rem);
  }

  .input-tip {
    margin: 10px 0 0;
    text-align: center;
    font-size: var(--font-size-caption);
    color: var(--color-grey-400);
  }

  /* Tag (matching Reduck Tag neutral variant) */
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


  /* Portal tooltip (matching Reduck Tooltip component) — injected into <body> */
  :global(.portal-tooltip) {
    position: fixed;
    text-align: center;
    background: var(--color-grey-900);
    color: var(--color-grey-50);
    font-size: 0.75rem;
    padding: 4px 8px;
    border-radius: 4px;
    white-space: nowrap;
    pointer-events: none;
    z-index: 3000;
    font-family: 'Inter', sans-serif;
    opacity: 0;
    transition: opacity 150ms;
  }

  :global(.portal-tooltip-arrow) {
    position: absolute;
    bottom: -3px;
    left: 50%;
    transform: translateX(-50%) rotate(45deg);
    width: 6px;
    height: 6px;
    background: var(--color-grey-900);
  }

  /* Two-line tooltip: label on top, shortcuts below */
  :global(.tt-label) {
    display: block;
    margin-bottom: 4px;
  }

  :global(.tt-shortcuts) {
    display: inline-flex;
    align-items: center;
    gap: 4px;
  }

  :global(.tt-kbd),
  :global(.tt-voice) {
    display: inline-flex;
    align-items: center;
    gap: 3px;
    font-size: 0.65rem;
    padding: 1px 5px;
    border-radius: 4px;
    background: var(--color-grey-700);
    color: var(--color-grey-300);
  }

  :global(.tt-voice svg) {
    flex-shrink: 0;
  }

  .input-box {
    position: relative;
    display: flex;
    flex-direction: column;
    background: transparent;
    border: 1px solid var(--color-grey-600);
    border-radius: 16px;
    transition: border-color 200ms, background 200ms;
  }

  .input-box:hover { border-color: var(--color-grey-500); }
  .input-box:focus-within { border-color: var(--color-orange-400); }

  /* Mic-center mode (empty idle) */
  .input-box.mic-center {
    overflow: visible;
  }

  .mic-center-trap {
    position: absolute;
    opacity: 0;
    width: 0;
    height: 0;
    pointer-events: none;
  }

  .mic-center-zone {
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    flex: 1;
    cursor: text;
    margin-top: 16px;
    margin-bottom: 4px;
  }

  .mic-center-btn {
    width: 32px;
    height: 32px;
    border-radius: 12px;
    border: none;
    background: var(--color-orange-400);
    color: var(--color-grey-900);
    display: flex;
    align-items: center;
    justify-content: center;
    cursor: pointer;
    transition: background 200ms, box-shadow 300ms, transform 200ms;
  }

  .mic-center-btn:hover {
    background: var(--color-orange-500);
    transform: scale(1.05);
  }

  .mic-center-btn:active {
    background: var(--color-orange-600);
    transform: scale(0.97);
  }

  .mic-center-btn.mic-intro {
    box-shadow: 0 0 20px rgba(251, 146, 60, 0.5);
    animation: mic-center-glow 2s ease-in-out infinite;
  }

  @keyframes mic-center-glow {
    0%, 100% { box-shadow: 0 0 12px rgba(251, 146, 60, 0.3); }
    50% { box-shadow: 0 0 24px rgba(251, 146, 60, 0.6); }
  }

  .type-instead {
    position: absolute;
    left: 50%;
    transform: translateX(-50%);
    color: var(--color-grey-400);
    font-size: var(--font-size-small);
    font-family: inherit;
    padding: 0;
    white-space: nowrap;
    pointer-events: none;
  }

  /* Recording state: pulsing orange border, no glow */
  .input-box.recording {
    border-color: var(--color-orange-400);
    background: rgba(249, 115, 22, 0.15);
    animation: border-pulse 1.5s ease-in-out infinite;
  }

  @keyframes border-pulse {
    0%, 100% { border-color: var(--color-orange-400); }
    50% { border-color: var(--color-orange-200); }
  }

  /* Review state: orange bg like recording, no glow */
  .input-box.review {
    border-color: var(--color-orange-400);
    background: rgba(249, 115, 22, 0.15);
    animation: none;
  }

  /* Italic text for voice modes */
  .input-box.recording textarea,
  .input-box.review textarea {
    font-style: italic;
  }

  /* Recording: pulsing text color to signal live transcription */
  .input-box.recording textarea {
    color: var(--color-orange-200);
    animation: transcription-pulse 2s ease-in-out infinite;
  }

  @keyframes transcription-pulse {
    0%, 100% { color: var(--color-orange-200); }
    50% { color: var(--color-orange-300); }
  }

  .input-box.review.editing textarea {
    font-style: normal;
  }

  /* Streaming state: dimmed input, stop button active */
  .input-box.streaming {
    border-color: var(--color-grey-600);
  }

  .input-box.streaming:hover {
    border-color: var(--color-grey-600);
  }

  .input-box.streaming:focus-within {
    border-color: var(--color-grey-600);
  }

  .input-box.streaming textarea {
    opacity: 0.5;
  }

  /* Textarea — NEVER a border */
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
    padding: 1rem 1rem 1rem;
  }

  textarea:focus,
  textarea:focus-visible {
    border: 0;
    outline: 0;
    box-shadow: none;
  }

  textarea::placeholder {
    color: var(--color-grey-400);
    transition: opacity 300ms ease;
  }

  textarea:not(.placeholder-fade)::placeholder {
    opacity: 0;
  }
  textarea[readonly] { cursor: default; }

  /* Controls row */
  .controls-row {
    position: relative;
    display: flex;
    align-items: center;
    padding: 0.2rem 0.5rem 0.45rem;
    gap: 8px;
  }

  .input-box.mic-center .controls-row {
    padding-top: 0;
  }

  .controls-spacer { flex: 1; }

  .ctrl-btn {
    min-width: 32px; max-width: 32px;
    min-height: 32px; max-height: 32px;
    border-radius: 10px;
    border: none; background: transparent;
    color: var(--color-grey-400);
    cursor: pointer;
    display: flex; align-items: center; justify-content: center;
    padding: 0;
    font-weight: 500;
    transition: box-shadow 200ms, background 200ms, color 200ms;
  }

  .ctrl-btn:hover { background: var(--color-grey-800); color: var(--color-grey-200); }
  .ctrl-btn:active { background: var(--color-grey-900); }
  .ctrl-btn:disabled { opacity: 0.4; cursor: not-allowed; }
  .ctrl-btn.muted { color: var(--color-red-500); }

  .clear-btn { color: var(--color-grey-400); }
  .clear-btn:hover { color: var(--color-red-300); background: var(--color-red-500-translucent-18); }
  .clear-btn:active { background: var(--color-red-500-translucent-28); }

  /* Text button (e.g. "Clear" in review mode) */
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
    color: var(--color-grey-200);
    background: var(--color-grey-800);
  }

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
    transition: color 200ms;
  }

  .model-select option {
    background: var(--color-grey-800);
    color: var(--text-color);
  }

  .model-select:hover { color: var(--color-grey-200); }

  /* Voice waveform (recording + review) */
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
    height: var(--h, 4px);
    animation: wave-voice 1.6s ease-in-out infinite alternate;
  }

  @keyframes wave-voice {
    0% { transform: scaleY(0.3); }
    25% { transform: scaleY(1); }
    50% { transform: scaleY(0.5); }
    75% { transform: scaleY(0.9); }
    100% { transform: scaleY(0.4); }
  }

  /* Primary buttons (Reduck medium: 32px, border-radius 10px) */
  .primary-btn {
    flex-shrink: 0;
    min-width: 32px; max-width: 32px;
    min-height: 32px; max-height: 32px;
    border-radius: 10px;
    border: none;
    display: flex; align-items: center; justify-content: center;
    cursor: pointer; padding: 0;
    font-weight: 500;
    transition: box-shadow 200ms, background 200ms, border-color 200ms, color 200ms;
  }

  .primary-btn:disabled { opacity: 0.4; cursor: not-allowed; }

  /* Send: primary type */
  .primary-btn.send-btn {
    background: var(--color-orange-400);
    color: var(--color-grey-900);
  }
  .primary-btn.send-btn:hover { background: var(--color-orange-500); }
  .primary-btn.send-btn:active { background: var(--color-orange-600); }

  /* Mic corner: primary orange */
  .primary-btn.mic-corner-btn {
    background: var(--color-orange-400);
    color: var(--color-grey-900);
  }
  .primary-btn.mic-corner-btn:hover { background: var(--color-orange-500); }
  .primary-btn.mic-corner-btn:active { background: var(--color-orange-600); }

  /* Mic: ghost type */
  .primary-btn.mic-btn {
    background: transparent;
    color: var(--color-grey-400);
  }
  .primary-btn.mic-btn:hover { background: var(--color-grey-800); color: var(--color-grey-200); }
  .primary-btn.mic-btn:active { background: var(--color-grey-900); }

  /* Mic glow — synced with "Try speaking..." placeholder */
  .primary-btn.mic-btn {
    transition: box-shadow 300ms ease, background 200ms, color 300ms ease;
  }

  .primary-btn.mic-intro {
    box-shadow: 0 0 12px rgba(251, 146, 60, 0.4);
    color: var(--color-orange-400);
  }

  /* Stop: danger type */
  .primary-btn.stop-btn {
    background: var(--color-red-500-translucent-18);
    color: var(--color-red-300);
  }
  .primary-btn.stop-btn:hover { background: var(--color-red-500-translucent-28); }
  .primary-btn.stop-btn:active { background: var(--color-red-500-translucent-38); }

  .spinner-icon {
    width: 14px; height: 14px;
    border: 2px solid var(--color-grey-600);
    border-top-color: var(--color-grey-300);
    border-radius: 50%;
    animation: spin 0.8s linear infinite;
  }

  @keyframes spin { to { transform: rotate(360deg); } }

  .pulse-icon {
    width: 8px; height: 8px; border-radius: 50%;
    background: var(--color-grey-400);
    animation: pulse-fade 1.5s ease-in-out infinite;
  }

  @keyframes pulse-fade {
    0%, 100% { opacity: 0.3; }
    50% { opacity: 1; }
  }

  /* ============================================
     TOAST
     ============================================ */
  .toast {
    position: fixed;
    top: 1rem; left: 50%;
    transform: translateX(-50%);
    max-width: 360px;
    padding: 0.6rem 1rem;
    background: var(--color-grey-900);
    color: var(--color-red-300);
    border: 1px solid var(--color-grey-600);
    border-radius: 8px;
    font-size: var(--font-size-small);
    line-height: 1.4;
    box-shadow: 0 2px 8px rgba(0,0,0,0.3);
    animation: toast-in 200ms ease-out;
    z-index: var(--z-notification);
  }

  @keyframes toast-in {
    from { opacity: 0; transform: translateX(-50%) translateY(-0.5rem); }
    to { opacity: 1; transform: translateX(-50%) translateY(0); }
  }

  /* ============================================
     SETTINGS POPOVER
     ============================================ */
  .settings-wrapper {
    position: relative;
  }

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
    gap: 0;
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

  /* Toggle switch */
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

  .settings-select:hover {
    border-color: var(--color-grey-500);
  }

  .settings-select option {
    background: var(--color-grey-800);
    color: var(--text-color);
  }
</style>
