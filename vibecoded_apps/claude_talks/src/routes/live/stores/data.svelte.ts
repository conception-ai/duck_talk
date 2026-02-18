/**
 * Core application data store.
 * Owns both reactive state (turns, status) and session lifecycle.
 * Takes swappable ports (audio, API) as constructor args.
 */

import { connectGemini } from '../gemini';
import { createRecorder, type RecorderHandle, type Recording } from '../recorder';
import type { RecordedChunk } from '../../recorder';
import type {
  AudioPort,
  AudioSink,
  AudioSource,
  Correction,
  ConverseApi,
  LiveBackend,
  PendingApproval,
  PendingTool,
  Status,
  Turn,
} from '../types';

interface DataStoreDeps {
  audio: AudioPort;
  api: ConverseApi;
  getApiKey: () => string | null;
  getLearningMode: () => boolean;
  getCorrections: () => Correction[];
}

export function createDataStore(deps: DataStoreDeps) {
  const { audio, api } = deps;

  // --- Reactive state ---
  let status = $state<Status>('idle');
  let turns = $state<Turn[]>([]);
  let pendingInput = $state('');
  let pendingOutput = $state('');
  let pendingTool = $state<PendingTool | null>(null);
  let awaitingToolDone = false; // not reactive — internal flag only
  let pendingApproval = $state<PendingApproval | null>(null);
  let pendingExecute: ((instruction: string) => void) | null = null;

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
    // Always flush user input
    const userText = pendingInput.trim();
    if (userText) {
      turns.push({ role: 'user', text: userText });
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

    // Merge into last assistant turn if consecutive speech (no tool on either)
    const last = turns.at(-1);
    if (last?.role === 'assistant' && !last.toolCall && !tool && text) {
      last.text = (last.text + '\n' + text).trim();
    } else {
      const turn: Turn = { role: 'assistant', text };
      if (tool) {
        turn.toolCall = { name: tool.name, args: tool.args };
        turn.toolResult = tool.text;
      }
      turns.push(turn);
    }

    pendingOutput = '';
    pendingTool = null;
  }

  function pushError(text: string) {
    turns.push({ role: 'assistant', text });
  }

  function setStatus(s: Status) {
    status = s;
  }

  function snapshotUtterance() {
    return { transcription: pendingInput, audioChunks: [...audioBuffer] };
  }

  function holdForApproval(
    approval: PendingApproval,
    execute: (instruction: string) => void,
  ) {
    pendingApproval = approval;
    pendingExecute = execute;
  }

  function approve(editedInstruction?: string) {
    if (!pendingApproval || !pendingExecute) return;
    const instruction =
      editedInstruction ?? String(pendingApproval.toolCall.args.instruction ?? '');
    pendingExecute(instruction);
    pendingApproval = null;
    pendingExecute = null;
  }

  function reject() {
    pendingApproval = null;
    pendingExecute = null;
    finishTool();
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
      getLearningMode: deps.getLearningMode,
      corrections: deps.getCorrections(),
    });
    if (!backend) return;

    try {
      console.log('[live] starting mic...');
      mic = await audio.startMic((base64) => {
        audioBuffer.push({ ts: Date.now() - sessionStart, data: base64 });
        backend?.sendRealtimeInput({
          data: base64,
          mimeType: 'audio/pcm;rate=16000',
        });
      });
      console.log('[live] mic started');
    } catch (e: unknown) {
      console.error('[live] mic failed:', e);
      pushError(`Mic failed: ${e instanceof Error ? e.message : String(e)}`);
      status = 'idle';
    }
  }

  function stop() {
    if (pendingTool?.streaming) pendingTool.streaming = false;
    commitTurn();
    mic?.stop();
    mic = null;
    player?.stop();
    player = null;
    backend?.close();
    backend = null;
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
      getLearningMode: deps.getLearningMode,
      corrections: deps.getCorrections(),
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
          data: chunk.data,
          mimeType: `audio/pcm;rate=${recording.sampleRate}`,
        });
        prevTs = chunk.ts;
      }
      // 2s silence so Gemini detects end-of-speech
      const silenceBytes = recording.sampleRate * 2 * 2;
      const silence = btoa(
        String.fromCharCode(...new Uint8Array(silenceBytes)),
      );
      backend.sendRealtimeInput({
        data: silence,
        mimeType: `audio/pcm;rate=${recording.sampleRate}`,
      });
      console.log('[replay] all chunks sent + 2s silence');
    } catch (e: unknown) {
      console.error('[replay] feed failed:', e);
      pushError(`Replay failed: ${e instanceof Error ? e.message : String(e)}`);
      status = 'idle';
    }
  }

  // --- Public surface ---

  return {
    get status() { return status; },
    get turns() { return turns; },
    get pendingInput() { return pendingInput; },
    get pendingOutput() { return pendingOutput; },
    get pendingTool() { return pendingTool; },
    get pendingApproval() { return pendingApproval; },
    approve,
    reject,
    start,
    stop,
    startRecording,
    stopRecording,
    startReplay,
  };
}
