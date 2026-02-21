/**
 * Core application data store.
 * Owns both reactive state (messages, voiceLog, status) and session lifecycle.
 * Takes swappable ports (audio, API) as constructor args.
 *
 * Two separate arrays with different lifecycles:
 * - messages: Message[]   — CC conversation (persistent, mutable, 1:1 with JSONL)
 * - voiceLog: VoiceEvent[] — user/Gemini speech (ephemeral, append-only)
 */

import { connectGemini } from '../gemini';
import type {
  AudioPort,
  AudioSink,
  AudioSource,
  ContentBlock,
  ConverseApi,
  InteractionMode,
  LiveBackend,
  Message,
  PendingApproval,
  PendingTool,
  RecordedChunk,
  Status,
  VoiceEvent,
} from '../types';

interface DataStoreDeps {
  audio: AudioPort;
  api: ConverseApi;
  getApiKey: () => string | null;
  getMode: () => InteractionMode;
  correctInstruction: (instruction: string) => Promise<string>;
}

export function createDataStore(deps: DataStoreDeps) {
  const { audio, api } = deps;

  // --- Reactive state ---
  let status = $state<Status>('idle');
  let messages = $state<Message[]>([]);
  let voiceLog = $state<VoiceEvent[]>([]);
  let pendingInput = $state('');
  let pendingOutput = $state('');
  let pendingTool = $state<PendingTool | null>(null);
  let awaitingToolDone = false; // not reactive — internal flag only
  let pendingApproval = $state<PendingApproval | null>(null);
  let pendingExecute: ((instruction: string) => void) | null = null;
  let pendingCancel: (() => void) | null = null;

  // --- Toast (auto-clearing error display) ---
  let toast = $state('');
  let toastTimer: ReturnType<typeof setTimeout> | undefined;

  // --- Audio buffer (for STT corrections) ---
  let audioBuffer: RecordedChunk[] = [];
  let sessionStart = 0;

  // --- I/O handles (not reactive, not exposed) ---
  let backend: LiveBackend | null = null;
  let mic: AudioSource | null = null;
  let player: AudioSink | null = null;

  // --- Mutation methods (passed to gemini.ts as DataStoreMethods) ---

  function appendInput(text: string) {
    pendingInput += text;
  }

  function appendOutput(text: string) {
    pendingOutput += text;
  }

  function startTool(name: string, args: Record<string, unknown>) {
    pendingTool = { name, args, text: '', blocks: [], streaming: true };
    awaitingToolDone = false;
  }

  function appendTool(text: string) {
    if (!pendingTool) return;
    pendingTool.text += text;
    const last = pendingTool.blocks.at(-1);
    if (last?.type === 'text') {
      last.text += text;
    } else {
      pendingTool.blocks.push({ type: 'text', text });
    }
  }

  function appendBlock(block: ContentBlock) {
    if (pendingTool) pendingTool.blocks.push(block);
  }

  function finishTool() {
    if (!pendingTool) return;
    pendingTool.streaming = false;
    if (awaitingToolDone) {
      doCommitAssistant();
      awaitingToolDone = false;
    }
  }

  function commitTurn() {
    // Flush user speech → voiceLog (append-only, never rewound)
    const userText = pendingInput.trim();
    if (userText) {
      // Merge into last voice event if consecutive user speech (VAD fires multiple interrupts)
      const last = voiceLog.at(-1);
      if (last?.role === 'user') {
        last.text = (last.text + ' ' + userText).trim();
      } else {
        voiceLog.push({ role: 'user', text: userText, ts: Date.now() });
      }
      window.dispatchEvent(new CustomEvent('utterance-committed', { detail: { transcript: userText } }));
    }
    pendingInput = '';
    audioBuffer = [];

    // If tool is still streaming, defer assistant commit
    if (pendingTool?.streaming) {
      awaitingToolDone = true;
      return;
    }

    doCommitAssistant();
  }

  function doCommitAssistant() {
    const text = pendingOutput.trim();
    const tool = pendingTool;

    if (!text && !tool) {
      pendingOutput = '';
      return;
    }

    // Gemini speech (without tool) → voiceLog
    if (text && !tool) {
      const last = voiceLog.at(-1);
      if (last?.role === 'gemini') {
        last.text = (last.text + '\n' + text).trim();
      } else {
        voiceLog.push({ role: 'gemini', text, ts: Date.now() });
      }
    }

    // Converse tool result → messages[] (CC conversation)
    if (tool) {
      // Gemini speech alongside tool → voiceLog
      if (text) {
        voiceLog.push({ role: 'gemini', text, ts: Date.now() });
      }
      // User instruction that was sent to Claude
      if (tool.name === 'converse' && tool.args.instruction) {
        messages.push({
          role: 'user',
          content: String(tool.args.instruction),
        });
      }
      // Claude's response
      if (tool.blocks.length > 0) {
        messages.push({ role: 'assistant', content: tool.blocks });
      } else if (tool.text) {
        messages.push({
          role: 'assistant',
          content: [{ type: 'text', text: tool.text }],
        });
      }
    }

    pendingOutput = '';
    pendingTool = null;
  }

  function pushError(text: string) {
    voiceLog.push({ role: 'gemini', text, ts: Date.now() });
    clearTimeout(toastTimer);
    toast = text;
    toastTimer = setTimeout(() => { toast = ''; }, 4000);
  }

  function setStatus(s: Status) {
    status = s;
  }

  function snapshotUtterance() {
    let prior = '';
    for (let i = voiceLog.length - 1; i >= 0; i--) {
      if (voiceLog[i].role === 'user') { prior = voiceLog[i].text; break; }
    }
    const full = prior
      ? (prior + ' ' + pendingInput).trim()
      : pendingInput.trim();
    return { transcription: full, audioChunks: [...audioBuffer] };
  }

  function holdForApproval(
    approval: PendingApproval,
    execute: (instruction: string) => void,
    cancel?: () => void,
  ) {
    pendingApproval = approval;
    pendingExecute = execute;
    pendingCancel = cancel ?? null;
  }

  function approve(editedText?: string) {
    if (!pendingApproval || !pendingExecute) return;
    const instruction = editedText ?? pendingApproval.instruction;
    if (pendingTool) pendingTool.args = { instruction };
    pendingExecute(instruction);
    pendingApproval = null;
    pendingExecute = null;
    pendingCancel = null;
  }

  function reject() {
    pendingApproval = null;
    pendingExecute = null;
    pendingCancel?.();
    pendingCancel = null;
    finishTool();
  }

  function loadHistory(msgs: Message[], sessionId: string) {
    messages = msgs;
    api.sessionId = sessionId;
  }

  async function back() {
    const sid = api.sessionId;
    if (!sid) return;

    // Abort in-flight converse stream
    api.abort();

    // Clear all pending state FIRST — prevents finishTool() from
    // committing partial results when the async abort error fires
    pendingTool = null;
    pendingOutput = '';
    pendingApproval = null;
    pendingCancel?.();
    pendingCancel = null;
    pendingExecute = null;

    // Persist rewind to backend
    const res = await fetch(`/api/sessions/${sid}/back`, { method: 'POST' });
    if (!res.ok) return;

    // Pop last round from messages[]
    while (messages.length && messages.at(-1)?.role === 'assistant') messages.pop();
    while (messages.length && messages.at(-1)?.role === 'user') messages.pop();
  }

  const dataMethods = {
    appendInput,
    appendOutput,
    startTool,
    appendTool,
    appendBlock,
    finishTool,
    commitTurn,
    pushError,
    setStatus,
    snapshotUtterance,
    holdForApproval,
    approve,
    back,
  };

  // --- Lifecycle: Live mode ---

  async function start() {
    const apiKey = deps.getApiKey();
    if (!apiKey) {
      pushError('API key not set. Click "API Key" to configure.');
      return;
    }
    sessionStart = Date.now();
    audioBuffer = [];
    player = audio.createPlayer();
    backend = await connectGemini({
      data: dataMethods,
      player,
      converseApi: api,
      tag: 'live',
      apiKey,
      getMode: deps.getMode,
      correctInstruction: deps.correctInstruction,
    });
    if (!backend) return;

    try {
      mic = await audio.startMic((base64) => {
        audioBuffer.push({ ts: Date.now() - sessionStart, data: base64 });
        backend?.sendRealtimeInput({
          audio: { data: base64, mimeType: 'audio/pcm;rate=16000' },
        });
      });
    } catch (e: unknown) {
      console.error('[live] mic failed:', e);
      pushError(`Mic failed: ${e instanceof Error ? e.message : String(e)}`);
      status = 'idle';
    }
  }

  function stop() {
    if (pendingTool?.streaming) pendingTool.streaming = false;
    commitTurn();
    api.abort();
    mic?.stop();
    mic = null;
    player?.stop();
    player = null;
    backend?.close();
    backend = null;
    status = 'idle';
  }

  // --- Public surface ---

  return {
    get toast() { return toast; },
    get status() { return status; },
    get messages() { return messages; },
    get voiceLog() { return voiceLog; },
    get pendingInput() { return pendingInput; },
    get pendingOutput() { return pendingOutput; },
    get pendingTool() { return pendingTool; },
    get pendingApproval() { return pendingApproval; },
    get claudeSessionId() { return api.sessionId; },
    setClaudeSession(id: string | null) { api.sessionId = id; },
    loadHistory,
    back,
    approve,
    reject,
    start,
    stop,
  };
}
