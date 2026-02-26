/**
 * Gemini Live API connection and message handling.
 * Plain .ts — no runes, no reactive state.
 * Receives DataStoreMethods via dependency injection.
 *
 * ## Message flow
 *
 * Gemini Live is a bidirectional WebSocket. We send mic audio via
 * `sendRealtimeInput` and receive two kinds of messages:
 *
 * 1. **serverContent** — STT transcriptions, turn boundaries
 * 2. **toolCall** — Gemini wants to invoke a declared function
 *
 * ## The converse tool (BLOCKING)
 *
 * The `converse` tool is declared as BLOCKING so Gemini is frozen by the
 * API while Claude streams. The tool response is sent immediately as
 * `{ result: "done" }` to unfreeze Gemini. A persistent TTS session
 * (one per voice session) handles audio output — no relay through the
 * main session.
 */

import {
  GoogleGenAI,
  Modality,
  type LiveSendToolResponseParameters,
  type Session,
  type LiveServerMessage,
} from '@google/genai';
import { TOOLS, handleToolCall } from './tools';
import { openTTSSession } from './tts-session';
import { STOP_WORDS, startKeywordListener, startVoiceApproval } from './voice-approval';
import type { ConverseApi, DataStoreMethods, InteractionMode, LiveBackend } from './types';

// --- Log styles ---
const BLUE_BADGE = 'background:#2563eb;color:white;font-weight:bold;padding:1px 6px;border-radius:3px';
const DIM = 'color:#9ca3af';

const BASE_PROMPT = `
You are a voice relay between a user and Claude Code (a powerful coding agent).

<RULES>
1. When the user gives an instruction, call the converse tool. You will receive streaming outputs from Claude Code as if you did it so you have full context to better understand what the user wants.
2. When the user wants to cancel current work (e.g. "stop", "cancel", "nevermind"), call the stop tool.
3. DO NOT talk to the user. You are a relay only. Your audio is muted anyway.
</RULES>

You are a transparent bridge. The user is talking TO Claude Code THROUGH you.
`;

const MODEL = 'gemini-2.5-flash-native-audio-preview-12-2025';

interface ConnectDeps {
  data: DataStoreMethods;
  converseApi: ConverseApi;
  tag: string;
  apiKey: string;
  getMode: () => InteractionMode;
  getOutputMuted: () => boolean;
  readbackInstruction: (text: string) => () => void;
}

/**
 * Connect to Gemini Live and return a LiveBackend handle.
 * Returns null on failure (error is pushed to data store).
 */
export async function connectGemini(deps: ConnectDeps): Promise<LiveBackend | null> {
  const { data, converseApi, apiKey } = deps;

  const ai = new GoogleGenAI({ apiKey });
  data.setStatus('connecting');

  // Mutable ref — handleMessage closes over this, assigned after connect().
  let sessionRef: Session | null = null;
  let closed = false; // hoisted so onclose callback can reach it
  let approvalPending = false; // true during BLOCKING approval hold — gates sendRealtimeInput
  let activeConverse: { abort: () => void } | null = null; // Claude SSE abort handle
  const tts = openTTSSession(apiKey, deps.getOutputMuted, (text) => {
    if (!closed && sessionRef) {
      sessionRef.sendClientContent({ turns: [{ role: 'model', parts: [{ text }] }], turnComplete: false });
      console.log(`%c GEMINI %c ${ts()} ← ${text.length} chars`, BLUE_BADGE, DIM);
    }
  });
  let modelAudioSeen = false; // first model audio per turn — VAD-to-response proxy
  const t0 = Date.now();
  const ts = () => {
    const elapsed = (Date.now() - t0) / 1000;
    const mins = Math.floor(elapsed / 60);
    const secs = elapsed % 60;
    return `${String(mins).padStart(2, '0')}:${secs.toFixed(2).padStart(5, '0')}`;
  };

  async function handleMessage(message: LiveServerMessage) {
    // --- Tool calls ---
    if (message.toolCall?.functionCalls) {
      const mode = deps.getMode();
      data.commitTurn();
      for (const fc of message.toolCall.functionCalls) {
        console.log(`%c GEMINI %c ${ts()} tool: ${fc.name}`, BLUE_BADGE, DIM, fc.args);

        // Stop is pure control flow — no pendingTool needed
        if (fc.name === 'stop') {
          console.log(`%c GEMINI %c ${ts()} ⏹ STOP (tool) — aborting active converse`, BLUE_BADGE, DIM);
          activeConverse?.abort();
          sessionRef?.sendToolResponse({
            functionResponses: [{ id: fc.id, name: 'stop', response: { result: 'stopped' } }],
          });
          continue;
        }

        data.startTool(fc.name!, fc.args ?? {});

        if (fc.name === 'converse') {
          const instruction = String(
            (fc.args as Record<string, unknown>)?.instruction ?? '',
          );

          // Shared rejection handler — unfreezes Gemini without executing
          const rejectAndUnfreeze = () => {
            sessionRef?.sendToolResponse({
              functionResponses: [{
                id: fc.id, name: 'converse',
                response: { status: 'rejected' },
              }],
            });
          };

          // Streams Claude's response via SSE. Inner Gemini TTS handles audio.
          // Both lifecycles are bundled into activeConverse so any user speech
          // can tear down both at once via abort().
          const executeConverse = (approvedInstruction: string) => {
            activeConverse?.abort(); // safety: close any previous
            data.commitUserMessage(approvedInstruction);

            // Unfreeze Outer Gemini immediately — Inner Gemini handles audio separately
            sessionRef?.sendToolResponse({
              functionResponses: [{ id: fc.id, name: 'converse', response: { result: 'done' } }],
            });

            let aborted = false;
            let claudeDone = false;
            let stopKeywords: (() => void) | null = null;

            const abort = () => {
              if (aborted) return;
              aborted = true;
              converseApi.abort();
              tts.interrupt();
              stopKeywords?.();
              if (!claudeDone) data.finishTool();
              activeConverse = null;
            };
            activeConverse = { abort };

            const stopMap: Record<string, () => void> = {};
            for (const w of STOP_WORDS) stopMap[w] = () => abort();
            stopKeywords = startKeywordListener(stopMap, { tag: 'stop' });

            converseApi.stream(approvedInstruction, {
              onChunk(text) {
                if (aborted) return;
                data.appendTool(text);
                tts.send(text);
              },
              onBlock(block) {
                if (aborted) return;
                data.appendBlock(block);
              },
              onDone() {
                if (aborted) return;
                claudeDone = true;
                tts.finish();
                data.finishTool();
                // activeConverse stays alive — Inner Gemini may still be draining audio
              },
              onError(msg) {
                if (aborted) return;
                abort();
                data.pushError(msg);
              },
            });
          };

          // Hold for approval with voice + UI. Starts voice listener,
          // gates mic audio away from frozen Gemini, cleans up on resolve.
          const holdWithVoice = (
            approvalPayload: Parameters<typeof data.holdForApproval>[0],
            stopReadback: () => void,
          ) => {
            approvalPending = true;
            let resolved = false;
            let stopVoice: (() => void) | null = null;

            const onAccept = (approved: string) => {
              if (resolved) return;
              resolved = true;
              stopVoice?.();
              stopReadback();
              approvalPending = false;
              executeConverse(approved);
            };
            const onCancel = () => {
              if (resolved) return;
              resolved = true;
              stopVoice?.();
              stopReadback();
              approvalPending = false;
              rejectAndUnfreeze();
            };

            // Voice triggers same store methods the UI buttons use.
            stopVoice = startVoiceApproval(
              () => data.approve(),
              () => data.reject(),
            );

            data.holdForApproval(approvalPayload, onAccept, onCancel);
          };

          if (mode === 'direct') {
            executeConverse(instruction);
          } else {
            console.log(`${ts()} review mode: holding for approval`);
            const stopReadback = deps.readbackInstruction(instruction);
            holdWithVoice({ instruction }, stopReadback);
          }
          continue;
        }

        const result = await handleToolCall(fc.name!, fc.args ?? {});
        console.log(`${ts()} tool result:`, result);
        data.appendTool(JSON.stringify(result));
        data.finishTool();
        sessionRef?.sendToolResponse({
          functionResponses: [{ id: fc.id, name: fc.name, response: result }],
        });
      }
      return;
    }

    // --- GoAway (server about to disconnect) ---
    if (message.goAway) {
      console.log(`%c GEMINI %c ${ts()} ⚠ goAway — timeLeft: ${message.goAway.timeLeft}`, BLUE_BADGE, DIM);
    }

    // --- Usage metadata (periodic token counts) ---
    if (message.usageMetadata) {
      const u = message.usageMetadata;
      const details = u.responseTokensDetails?.map((d: { modality?: string; tokenCount?: number }) => `${d.modality}:${d.tokenCount}`).join(' ') ?? '';
      console.log(`%c GEMINI %c ${ts()} tokens: ${u.totalTokenCount} total ${details}`, BLUE_BADGE, DIM);
    }

    // --- Server content (STT, turn boundaries) ---
    const sc = message.serverContent;
    if (!sc) return;

    if (sc.interrupted) {
      console.log(`%c GEMINI %c ${ts()} interrupted (sc.interrupted)${activeConverse ? ' — aborting active converse' : ''}`, BLUE_BADGE, DIM);
      modelAudioSeen = false;
      activeConverse?.abort();
      data.commitTurn();
      return;
    }

    // User speech — accumulate, let Gemini decide via tool calls
    if (sc.inputTranscription?.text) {
      const transcript = sc.inputTranscription.text;
      console.log(`%c GEMINI %c ${ts()} [user] ${transcript}`, BLUE_BADGE, DIM);
      data.appendInput(transcript);
    }

    // Main session audio playback is ignored (TTS session handles playback)
    // But log first arrival — it timestamps when VAD finalized end-of-speech
    if (sc.modelTurn?.parts) {
      for (const p of sc.modelTurn.parts) {
        if (p.inlineData?.data && !modelAudioSeen) {
          modelAudioSeen = true;
          console.log(`%c GEMINI %c ${ts()} model audio start`, BLUE_BADGE, DIM);
          break;
        }
      }
    }

    // Gemini spoke (debug — should be silent in relay mode)
    if (sc.outputTranscription?.text) {
      console.debug(`%c GEMINI %c ${ts()} [output] ${sc.outputTranscription.text}`, BLUE_BADGE, DIM);
    }

    if (sc.generationComplete) {
      console.log(`%c GEMINI %c ${ts()} generationComplete`, BLUE_BADGE, DIM);
    }

    if (sc.turnComplete) {
      console.log(`%c GEMINI %c ${ts()} done`, BLUE_BADGE, DIM);
      data.commitTurn();
      modelAudioSeen = false;
    }
  }

  try {
    const session = await ai.live.connect({
      model: MODEL,
      config: {
        responseModalities: [Modality.AUDIO],
        tools: TOOLS,
        systemInstruction: BASE_PROMPT,
        inputAudioTranscription: {},
        outputAudioTranscription: {},
      },
      callbacks: {
        onopen: () => {
          console.log(`%c GEMINI %c ${ts()} connected (${Date.now() - t0}ms)`, BLUE_BADGE, DIM);
          data.setStatus('connected');
        },
        onmessage: (msg: LiveServerMessage) => handleMessage(msg),
        onerror: (e: ErrorEvent) => {
          console.error(`${ts()} error:`, e);
          data.pushError(`Error: ${e.message}`);
        },
        onclose: (e: CloseEvent) => {
          const wasExpected = closed; // user-initiated stop() already set this
          closed = true;
          sessionRef = null;
          activeConverse?.abort();
          tts.close();
          console.log(`${ts()} closed: ${e.reason}`);
          data.setStatus('idle');
          if (!wasExpected && e.reason) {
            data.pushError(`Gemini disconnected: ${e.reason}`);
          }
        },
      },
    });
    sessionRef = session;
    converseApi.sessionStart = t0;
    console.log(`%c GEMINI %c ${ts()} [SYSTEM]`, BLUE_BADGE, DIM);
    console.log(`%c${BASE_PROMPT.trim()}`, 'color:#9ca3af;white-space:pre-wrap');

    return {
      sendRealtimeInput: (input) => { if (!closed && !approvalPending) session.sendRealtimeInput(input); },
      sendClientContent: (content) => { if (!closed) session.sendClientContent(content); },
      sendToolResponse: (response) => { if (!closed) session.sendToolResponse(response as LiveSendToolResponseParameters); },
      close: () => { activeConverse?.abort(); tts.close(); closed = true; sessionRef = null; session.close(); },
    };
  } catch (e: unknown) {
    console.error(`${ts()} connect failed:`, e);
    data.pushError(
      `Failed: ${e instanceof Error ? e.message : String(e)}`,
    );
    data.setStatus('idle');
    return null;
  }
}
