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
 * ## The converse tool (core complexity)
 *
 * The `converse` tool is the bridge to Claude Code. When Gemini decides
 * the user wants something done, it calls `converse({ instruction })`.
 * The tool is declared as NON_BLOCKING so Gemini can speak an
 * acknowledgment ("Asking Claude") while we stream Claude's response
 * in the background.
 *
 * The response flow:
 *   1. Gemini says "Asking Claude" (audio + outputTranscription)
 *   2. Gemini emits toolCall → we send a SILENT tool response
 *   3. We stream Claude's answer via /api/converse (SSE)
 *   4. Each Claude chunk is fed back as sendClientContent([CLAUDE]: text)
 *   5. Gemini reads the [CLAUDE] text aloud → produces new model audio
 *
 * ## conversePhase — suppression state machine
 *
 * Problem: between steps 2-4 Gemini keeps emitting its own audio/text.
 * Without gating, this leaks into the UI (echo text, duplicate audio).
 *
 * ```
 * idle ──→ suppressing ──→ relaying ──→ idle
 *       (tool call)    (1st Claude   (stream
 *       + flush audio   chunk sent)   done)
 * ```
 *
 * | Phase       | Audio (modelTurn)     | outputTranscription    |
 * |-------------|-----------------------|------------------------|
 * | idle        | play                  | append to pendingOutput |
 * | suppressing | BLOCK (+ flush)       | BLOCK                  |
 * | relaying    | play (Gemini reads    | BLOCK ([CLAUDE]: echo  |
 * |             | Claude's text aloud)  | is noise; real text is |
 * |             |                       | in appendTool)         |
 *
 * inputTranscription (user speech) always passes through.
 *
 * In learning mode, the stream doesn't start until the user approves.
 * The phase stays `suppressing` the whole time — audio and text are
 * blocked while waiting. On reject, the cancel callback resets to idle.
 */

import {
  GoogleGenAI,
  Modality,
  FunctionResponseScheduling,
  type LiveSendToolResponseParameters,
  type Session,
  type LiveServerMessage,
} from '@google/genai';
import { TOOLS, handleToolCall } from './tools';
import type { AudioSink, ConverseApi, DataStoreMethods, InteractionMode, LiveBackend } from './types';

// --- Log styles ---
const BLUE = 'background:#2563eb;color:white;font-weight:bold;padding:1px 6px;border-radius:3px';
const ORANGE = 'background:#d97706;color:white;font-weight:bold;padding:1px 6px;border-radius:3px';
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
  // Converse phase: idle → suppressing (tool call) → relaying (1st Claude chunk) → idle (done)
  let conversePhase: 'idle' | 'suppressing' | 'relaying' = 'idle';
  let userSpokeInTurn = false;
  let lastUserSpeechAt = 0;
  let geminiTTFTLogged = false;
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
        console.log(`%c GEMINI %c ${ts()} tool: ${fc.name}`, BLUE, DIM, fc.args);

        if (fc.name === 'accept_instruction') {
          data.approve();
          sessionRef?.sendToolResponse({
            functionResponses: [{ id: fc.id, name: fc.name, response: { status: 'ok' } }],
          });
          continue;
        }

        data.startTool(fc.name!, fc.args ?? {});

        if (fc.name === 'converse') {
          // Enter suppressing: block all Gemini audio/text until Claude's
          // first chunk arrives (see conversePhase doc at top of file).
          conversePhase = 'suppressing';
          player.flush(); // cancel queued "Asking Claude" audio remnants

          // SILENT = Gemini won't wait for our text response before speaking.
          // It can start its acknowledgment immediately.
          sessionRef?.sendToolResponse({
            functionResponses: [
              {
                id: fc.id,
                name: fc.name,
                response: { status: 'started' },
                scheduling: FunctionResponseScheduling.SILENT,
              },
            ],
          });

          const instruction = String(
            (fc.args as Record<string, unknown>)?.instruction ?? '',
          );

          // Called immediately (normal mode) or after user approval (learning mode).
          // Streams Claude's response via SSE and feeds each chunk back to Gemini
          // so it reads the answer aloud.
          const executeConverse = (approvedInstruction: string) => {
            // Gemini TTS accumulation: buffer chunks for 1s, then passthrough.
            // Visual display (appendTool) is always immediate.
            let geminiBuf = '';
            let geminiFlushed = false;
            let geminiTimer: ReturnType<typeof setTimeout> | undefined;

            const sendToGemini = (text: string) => {
              sessionRef?.sendClientContent({
                turns: [{ role: 'user', parts: [{ text: `[CLAUDE]: ${text}` }] }],
                turnComplete: true,
              });
            };

            const flushGeminiBuf = () => {
              if (geminiBuf) {
                sendToGemini(geminiBuf);
                geminiBuf = '';
              }
              geminiFlushed = true;
              geminiTimer = undefined;
            };

            converseApi.stream(approvedInstruction, {
              onChunk(text) {
                data.appendTool(text);
                if (!sessionRef) {
                  console.error(`%c CLAUDE %c session is null, cannot send chunk`, ORANGE, DIM);
                  return;
                }
                if (conversePhase === 'suppressing') conversePhase = 'relaying';

                if (geminiFlushed) {
                  sendToGemini(text);
                  return;
                }
                geminiBuf += text;
                if (!geminiTimer) {
                  geminiTimer = setTimeout(flushGeminiBuf, 1000);
                }
              },
              onBlock(block) {
                data.appendBlock(block);
              },
              onDone() {
                flushGeminiBuf();
                conversePhase = 'idle';
                data.finishTool();
              },
              onError(msg) {
                if (geminiTimer) clearTimeout(geminiTimer);
                conversePhase = 'idle';
                data.finishTool();
                data.pushError(msg);
              },
            });
          };

          if (mode === 'direct') {
            executeConverse(instruction);
          } else if (mode === 'correct') {
            // LLM auto-corrects, then hold for approval
            console.log(`${ts()} correct mode: running LLM correction`);
            deps.correctInstruction(instruction).then(
              (corrected) => {
                data.holdForApproval(
                  { rawInstruction: instruction, instruction: corrected, audioChunks },
                  executeConverse,
                  () => { conversePhase = 'idle'; },
                );
              },
              () => {
                // Fallback: show uncorrected on LLM error
                data.holdForApproval(
                  { instruction, audioChunks },
                  executeConverse,
                  () => { conversePhase = 'idle'; },
                );
              },
            );
          } else {
            // review mode
            console.log(`${ts()} review mode: holding for approval`);
            data.holdForApproval(
              { instruction, audioChunks },
              executeConverse,
              () => { conversePhase = 'idle'; },
            );
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
      console.log(`%c GEMINI %c ${ts()} interrupted`, BLUE, DIM);
      userSpokeInTurn = false;
      player.flush();
      data.commitTurn();
      return;
    }

    // User speech — always pass through, even during converse.
    if (sc.inputTranscription?.text) {
      console.log(`${ts()} [user] ${sc.inputTranscription.text}`);
      lastUserSpeechAt = Date.now();
      geminiTTFTLogged = false;
      data.appendInput(sc.inputTranscription.text);
      userSpokeInTurn = true;
    }

    // Gemini's speech text. During converse this is either its own chatter
    // or [CLAUDE]: echo text — both are noise (real text is in appendTool).
    // "Asking Claude" arrives BEFORE the toolCall message, so it naturally
    // passes through while conversePhase is still 'idle'.
    if (sc.outputTranscription?.text && conversePhase === 'idle') {
      if (lastUserSpeechAt && !geminiTTFTLogged) {
        console.log(`%c GEMINI %c ${ts()} TTFT: ${Date.now() - lastUserSpeechAt}ms`, BLUE, DIM);
        geminiTTFTLogged = true;
      }
      console.log(`%c GEMINI %c ${ts()} ${sc.outputTranscription.text}`, BLUE, DIM);
      data.appendOutput(sc.outputTranscription.text);
    }

    // Gemini's audio output. During 'suppressing' this is residual audio
    // from Gemini's own generation (pre-tool-call remnants). During
    // 'relaying' this is Gemini reading Claude's text aloud — we want that.
    if (sc.modelTurn?.parts) {
      for (const part of sc.modelTurn.parts) {
        if (part.inlineData?.data && conversePhase !== 'suppressing') {
          player.play(part.inlineData.data);
        }
      }
    }

    if (sc.turnComplete) {
      console.log(`%c GEMINI %c ${ts()} done`, BLUE, DIM);
      data.commitTurn();

      // Nudge: Gemini completed without calling converse after user spoke
      if (userSpokeInTurn && conversePhase === 'idle') {
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
          console.log(`${ts()} closed: ${e.reason}`);
          data.setStatus('idle');
        },
      },
    });
    sessionRef = session;
    console.log(
      `%c SYSTEM %c\n${BASE_PROMPT.trim()}`,
      'background:#6b7280;color:white;font-weight:bold;padding:1px 6px;border-radius:3px',
      'color:#9ca3af;white-space:pre-wrap',
    );

    let closed = false;

    return {
      sendRealtimeInput: (input) => { if (!closed) session.sendRealtimeInput(input); },
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
