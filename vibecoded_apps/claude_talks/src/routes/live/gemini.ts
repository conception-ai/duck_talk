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
 * 1. **serverContent** — STT transcriptions, model audio, turn boundaries
 * 2. **toolCall** — Gemini wants to invoke a declared function
 *
 * ## The converse tool (BLOCKING)
 *
 * The `converse` tool is declared as BLOCKING so Gemini is frozen by the
 * API during approval + Claude streaming startup. The tool response is
 * deferred until ~1s of Claude text is buffered, then sent to unfreeze
 * Gemini. Remaining chunks are relayed via sendClientContent.
 *
 * An `isRelaying` boolean suppresses outputTranscription (echo noise)
 * while Claude chunks are flowing. Audio always plays — during BLOCKING
 * Gemini produces no audio, and after unfreezing it reads Claude aloud.
 */

import {
  GoogleGenAI,
  Modality,
  type LiveSendToolResponseParameters,
  type Session,
  type LiveServerMessage,
} from '@google/genai';
import { createChunkBuffer } from './buffer';
import { TOOLS, handleToolCall } from './tools';
import { startVoiceApproval } from './voice-approval';
import type { AudioSink, ConverseApi, DataStoreMethods, InteractionMode, LiveBackend } from './types';

// --- Log styles ---
const BLUE_BADGE = 'background:#2563eb;color:white;font-weight:bold;padding:1px 6px;border-radius:3px';
const BLUE_TEXT = 'color:#60a5fa';
const ORANGE_BADGE = 'background:#d97706;color:white;font-weight:bold;padding:1px 6px;border-radius:3px';
const DIM = 'color:#9ca3af';

const BASE_PROMPT = `
You are a voice relay between a user and Claude Code (a powerful coding agent).

<RULES>
1. When the user asks a question or gives an instruction, ALWAYS call the converse tool, and NEVER answer yourself.
2. Only start speaking as soon as you have received information and start reciting verbatim what Claude converse call will share to you. They are marked with prefix [CLAUDE]:, read it aloud naturally and conversationally. Do not mention the [CLAUDE] prefix.
4. Do not add your own commentary, corrections, or opinions to Claude Code's responses — just relay them faithfully.
6 - When user says "STOP" you just stop and not answer anything.
</RULES>

You are a transparent bridge. The user is talking TO Claude Code THROUGH you. You never answer on Claude Code's behalf.

`;

const MODEL = 'gemini-2.5-flash-native-audio-preview-12-2025';

interface ConnectDeps {
  data: DataStoreMethods;
  player: AudioSink;
  converseApi: ConverseApi;
  tag: string;
  apiKey: string;
  getMode: () => InteractionMode;
  correctInstruction: (instruction: string) => Promise<string>;
  readbackInstruction: (text: string) => () => void;
}

/**
 * Connect to Gemini Live and return a LiveBackend handle.
 * Returns null on failure (error is pushed to data store).
 */
export async function connectGemini(deps: ConnectDeps): Promise<LiveBackend | null> {
  const { data, player, converseApi, tag, apiKey } = deps;

  const ai = new GoogleGenAI({ apiKey });
  data.setStatus('connecting');

  // Mutable ref — handleMessage closes over this, assigned after connect().
  let sessionRef: Session | null = null;
  let closed = false; // hoisted so onclose callback can reach it
  let isRelaying = false; // true while Claude chunks are flowing to Gemini
  let approvalPending = false; // true during BLOCKING approval hold — gates sendRealtimeInput
  let audioChunksInTurn = 0; // count audio chunks in current turn for envelope logging
  let audioTurnT0 = 0; // timestamp of first audio chunk in current turn
  let userSpokeInTurn = false;
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
      userSpokeInTurn = false; // Tool was called, don't nudge
      // Snapshot BEFORE commitTurn clears the buffer
      const mode = deps.getMode();
      const audioChunks = mode !== 'direct' ? data.snapshotUtterance().audioChunks : [];

      data.commitTurn();
      for (const fc of message.toolCall.functionCalls) {
        console.log(`%c GEMINI %c ${ts()} tool: ${fc.name}`, BLUE_BADGE, DIM, fc.args);

        data.startTool(fc.name!, fc.args ?? {});

        if (fc.name === 'converse') {
          isRelaying = true;
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
            isRelaying = false;
          };

          // Streams Claude's response via SSE. Defers the tool response
          // until ~1s of text is buffered, then unfreezes Gemini with it.
          // Remaining chunks are relayed via sendClientContent.
          const executeConverse = (approvedInstruction: string) => {
            let toolResponseSent = false;
            let initialBuffer = '';
            let bufferTimer: ReturnType<typeof setTimeout> | undefined;

            // Phase 2 buffer: after tool response, feeds sendClientContent
            const geminiBuffer = createChunkBuffer((text) => {
              console.log(`%c GEMINI %c ${ts()} ← sendClientContent (${text.length} chars): ${text}`, BLUE_BADGE, DIM);
              sessionRef?.sendClientContent({
                turns: [{ role: 'user', parts: [{ text: `[CLAUDE]: ${text}` }] }],
                turnComplete: true,
              });
            }, 1000);

            // Phase 1 → Phase 2 transition: send tool response to unfreeze
            const flushAndUnfreeze = () => {
              if (toolResponseSent) return;
              toolResponseSent = true;
              if (bufferTimer) { clearTimeout(bufferTimer); bufferTimer = undefined; }
              console.log(`%c GEMINI %c ${ts()} ← toolResponse (${initialBuffer.length} chars): ${initialBuffer}`, BLUE_BADGE, DIM);
              sessionRef?.sendToolResponse({
                functionResponses: [{
                  id: fc.id, name: 'converse',
                  response: { result: initialBuffer || '...' },
                }],
              });
            };

            converseApi.stream(approvedInstruction, {
              onChunk(text) {
                data.appendTool(text); // UI always immediate
                if (!sessionRef) {
                  console.error(`%c CLAUDE %c session is null, cannot send chunk`, ORANGE_BADGE, DIM);
                  return;
                }

                if (!toolResponseSent) {
                  // Phase 1: accumulate for deferred tool response
                  initialBuffer += text;
                  if (!bufferTimer) {
                    bufferTimer = setTimeout(flushAndUnfreeze, 1000);
                  }
                } else {
                  // Phase 2: stream to Gemini via sendClientContent
                  console.log(`%c GEMINI %c ${ts()} phase2 chunk (${text.length} chars)`, BLUE_BADGE, DIM);
                  geminiBuffer.push(text);
                }
              },
              onBlock(block) {
                data.appendBlock(block);
              },
              onDone() {
                flushAndUnfreeze(); // if Claude finished within buffer window
                console.log(`%c GEMINI %c ${ts()} onDone — flushing geminiBuffer`, BLUE_BADGE, DIM);
                geminiBuffer.flush();
                isRelaying = false;
                data.finishTool();
              },
              onError(msg) {
                flushAndUnfreeze(); // unfreeze even on error
                geminiBuffer.clear();
                isRelaying = false;
                data.finishTool();
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
            // approve() → store pendingExecute → onAccept
            // reject() → store pendingCancel → onCancel
            stopVoice = startVoiceApproval(
              () => data.approve(),
              () => data.reject(),
            );

            data.holdForApproval(approvalPayload, onAccept, onCancel);
          };

          if (mode === 'direct') {
            executeConverse(instruction);
          } else if (mode === 'correct') {
            console.log(`${ts()} correct mode: running LLM correction`);
            deps.correctInstruction(instruction).then(
              (corrected) => {
                const stopReadback = deps.readbackInstruction(corrected);
                holdWithVoice(
                  { rawInstruction: instruction, instruction: corrected, audioChunks },
                  stopReadback,
                );
              },
              () => {
                const stopReadback = deps.readbackInstruction(instruction);
                holdWithVoice({ instruction, audioChunks }, stopReadback);
              },
            );
          } else {
            console.log(`${ts()} review mode: holding for approval`);
            const stopReadback = deps.readbackInstruction(instruction);
            holdWithVoice({ instruction, audioChunks }, stopReadback);
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

    // --- Server content (STT, TTS audio, turn boundaries) ---
    const sc = message.serverContent;
    if (!sc) return;

    if (sc.interrupted) {
      console.log(`%c GEMINI %c ${ts()} interrupted`, BLUE_BADGE, DIM);
      audioChunksInTurn = 0;
      userSpokeInTurn = false;
      player.flush();
      data.commitTurn();
      return;
    }

    // User speech — always pass through, even during converse.
    if (sc.inputTranscription?.text) {
      console.log(`${ts()} [user] ${sc.inputTranscription.text}`);
      data.appendInput(sc.inputTranscription.text);
      userSpokeInTurn = true;
    }

    // Gemini's speech text. During relay this is [CLAUDE]: echo — noise.
    // Real Claude text is already in appendTool. Suppress during relay.
    if (sc.outputTranscription?.text && !isRelaying) {
      console.log(`%c${sc.outputTranscription.text}`, BLUE_TEXT);
      data.appendOutput(sc.outputTranscription.text);
    }

    // Gemini's audio output. Always play — during BLOCKING Gemini is frozen
    // (no audio to suppress), after unfreezing it reads Claude aloud.
    if (sc.modelTurn?.parts) {
      for (const part of sc.modelTurn.parts) {
        if (part.inlineData?.data) {
          if (audioChunksInTurn === 0) {
            audioTurnT0 = Date.now();
            console.log(`%c GEMINI %c ${ts()} 🔊 audio start${isRelaying ? ' (relay)' : ''}`, BLUE_BADGE, DIM);
          }
          audioChunksInTurn++;
          player.play(part.inlineData.data);
        }
      }
    }

    if (sc.turnComplete) {
      const audioInfo = audioChunksInTurn > 0
        ? ` (${audioChunksInTurn} audio chunks, ${((Date.now() - audioTurnT0) / 1000).toFixed(1)}s)`
        : '';
      console.log(`%c GEMINI %c ${ts()} done${audioInfo}`, BLUE_BADGE, DIM);
      audioChunksInTurn = 0;
      data.commitTurn();

      // Nudge: Gemini completed without calling converse after user spoke
      if (userSpokeInTurn && !isRelaying) {
        console.log(`${ts()} [nudge] no tool call after user speech`);
        sessionRef?.sendClientContent({
          turns: [{ role: 'user', parts: [{ text: 'You did not call the converse tool. Please call it now.' }] }],
          turnComplete: true,
        });
      }
      userSpokeInTurn = false;
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
          console.log(`${ts()} connected`);
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
          isRelaying = false;
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
    console.log(
      `%c SYSTEM %c\n${BASE_PROMPT.trim()}`,
      'background:#6b7280;color:white;font-weight:bold;padding:1px 6px;border-radius:3px',
      'color:#9ca3af;white-space:pre-wrap',
    );

    return {
      sendRealtimeInput: (input) => { if (!closed && !approvalPending) session.sendRealtimeInput(input); },
      sendClientContent: (content) => { if (!closed) session.sendClientContent(content); },
      sendToolResponse: (response) => { if (!closed) session.sendToolResponse(response as LiveSendToolResponseParameters); },
      close: () => { closed = true; sessionRef = null; session.close(); },
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
