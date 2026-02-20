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
import { createRecorder, type RecorderHandle, type Recording } from '../recorder';
import type { RecordedChunk } from '../recorder';
import type {
  AudioPort,
  AudioSink,
  AudioSource,
  ConverseApi,
  InteractionMode,
  LiveBackend,
  Message,
  PendingApproval,
  PendingTool,
  Status,
  VoiceEvent,
} from '../types';

interface DataStoreDeps {
  audio: AudioPort;
  api: ConverseApi;
  getApiKey: () => string | null;
  getMode: () => InteractionMode;
  correctInstruction: (instruction: string) => Promise<string>;
  getPttMode: () => boolean;
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

  // --- PTT state ---
  let pttMode = false;              // set at start(), gates mic callback
  let pttActive = $state(false);    // reactive — UI shows button state

  // --- Audio buffer (for STT corrections) ---
  let audioBuffer: RecordedChunk[] = [];
  let sessionStart = 0;

  // --- I/O handles (not reactive, not exposed) ---
  let backend: LiveBackend | null = null;
  let mic: AudioSource | null = null;
  let player: AudioSink | null = null;
  let recorder: RecorderHandle | null = null;

  // --- Mutation methods (passed to gemini.ts as DataStoreMethods) ---

  function appendInput(text: string) {
    pendingInput += text;
  }

  function appendOutput(text: string) {
    pendingOutput += text;
  }

  function startTool(name: string, args: Record<string, unknown>) {
    pendingTool = { name, args, text: '', streaming: true };
    awaitingToolDone = false;
  }

  function appendTool(text: string) {
    if (pendingTool) pendingTool.text += text;
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
      // Claude's response (degraded: text-only during live streaming)
      if (tool.text) {
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
    pttMode = deps.getPttMode();
    pttActive = false;
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
      pttMode,
    });
    if (!backend) return;

    try {
      mic = await audio.startMic((base64) => {
        if (pttMode && !pttActive) return;
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
    pttActive = false;
    pttMode = false;
    if (pendingTool?.streaming) pendingTool.streaming = false;
    commitTurn();
    mic?.stop();
    mic = null;
    player?.stop();
    player = null;
    backend?.close();
    backend = null;
    api.sessionId = null;
    status = 'idle';
  }

  // --- Lifecycle: Recording (mic only, no Gemini) ---

  async function startRecording() {
    recorder = createRecorder();
    status = 'recording';
    try {
      mic = await audio.startMic((base64) => {
        recorder?.feed(base64);
      });
    } catch (e: unknown) {
      pushError(`Mic failed: ${e instanceof Error ? e.message : String(e)}`);
      recorder = null;
      status = 'idle';
    }
  }

  function stopRecording() {
    mic?.stop();
    mic = null;
    recorder?.download();
    recorder = null;
    status = 'idle';
  }

  // --- Lifecycle: Replay (Gemini + recorded chunks) ---

  async function startReplay(recording: Recording) {
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
      tag: 'replay',
      apiKey,
      getMode: deps.getMode,
      correctInstruction: deps.correctInstruction,
      pttMode: false,
    });
    if (!backend) return;

    try {
      console.log(`[replay] feeding ${recording.chunks.length} chunks`);
      let prevTs = 0;
      for (const chunk of recording.chunks) {
        const delay = chunk.ts - prevTs;
        if (delay > 0) await new Promise((r) => setTimeout(r, delay));
        audioBuffer.push({ ts: chunk.ts, data: chunk.data });
        backend.sendRealtimeInput({
          audio: { data: chunk.data, mimeType: `audio/pcm;rate=${recording.sampleRate}` },
        });
        prevTs = chunk.ts;
      }
      // 2s silence so Gemini detects end-of-speech
      const silenceBytes = recording.sampleRate * 2 * 2;
      const silence = btoa(
        String.fromCharCode(...new Uint8Array(silenceBytes)),
      );
      backend.sendRealtimeInput({
        audio: { data: silence, mimeType: `audio/pcm;rate=${recording.sampleRate}` },
      });
      console.log('[replay] all chunks sent + 2s silence');
    } catch (e: unknown) {
      console.error('[replay] feed failed:', e);
      pushError(`Replay failed: ${e instanceof Error ? e.message : String(e)}`);
      status = 'idle';
    }
  }

  // --- PTT lifecycle ---

  function pttPress() {
    if (!pttMode || !backend) return;
    pttActive = true;
    backend.sendRealtimeInput({ activityStart: {} });
  }

  function pttRelease() {
    if (!pttMode || !backend) return;
    pttActive = false;
    backend.sendRealtimeInput({ activityEnd: {} });
  }

  // --- Public surface ---

  return {
    get status() { return status; },
    get messages() { return messages; },
    get voiceLog() { return voiceLog; },
    get pendingInput() { return pendingInput; },
    get pendingOutput() { return pendingOutput; },
    get pendingTool() { return pendingTool; },
    get pendingApproval() { return pendingApproval; },
    get pttActive() { return pttActive; },
    get claudeSessionId() { return api.sessionId; },
    setClaudeSession(id: string | null) { api.sessionId = id; },
    loadHistory,
    back,
    approve,
    reject,
    start,
    stop,
    startRecording,
    stopRecording,
    startReplay,
    pttPress,
    pttRelease,
  };
}
