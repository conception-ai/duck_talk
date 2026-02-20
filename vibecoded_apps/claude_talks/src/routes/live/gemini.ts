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

const BASE_PROMPT = `
You are a voice relay between a user and Claude Code (a powerful coding agent).

<RULES>
1. When the user asks a question or gives an instruction followed by "OVER", ALWAYS call the converse tool, ALWAYS respond with "Asking Claude" and NEVER answer yourself.
2. Then stop after saying "Asking Claude" and only start speaking again by reciting verbatim what Claude converse call will share to you.
3. When you receive a message prefixed with [CLAUDE]:, read it aloud naturally and conversationally. Do not mention the [CLAUDE] prefix.
4. Do not add your own commentary, corrections, or opinions to Claude Code's responses — just relay them faithfully.
5. Make the relay conversation-friendly: skip bullet markers, dashes, code formatting symbols, and random IDs.
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
  pttMode: boolean;
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

  async function handleMessage(message: LiveServerMessage) {
    // --- Tool calls ---
    if (message.toolCall?.functionCalls) {
      userSpokeInTurn = false; // Tool was called, don't nudge
      // Snapshot BEFORE commitTurn clears the buffer
      const mode = deps.getMode();
      const audioChunks = mode !== 'direct' ? data.snapshotUtterance().audioChunks : [];

      data.commitTurn();
      for (const fc of message.toolCall.functionCalls) {
        console.log(`[${tag}] tool call:`, fc.name, fc.args);

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
            converseApi.stream(approvedInstruction, {
              onChunk(text) {
                // Store Claude's text in the tool result (visible in UI)
                data.appendTool(text);
                if (sessionRef) {
                  // First chunk: transition suppressing→relaying so Gemini's
                  // audio (reading Claude's text) starts playing through.
                  if (conversePhase === 'suppressing') conversePhase = 'relaying';
                  // Feed Claude's text to Gemini as a user message.
                  // The [CLAUDE] prefix tells Gemini to read it aloud verbatim.
                  sessionRef.sendClientContent({
                    turns: [
                      { role: 'user', parts: [{ text: `[CLAUDE]: ${text}` }] },
                    ],
                    turnComplete: true,
                  });
                } else {
                  console.error('[converse] session is null, cannot send chunk');
                }
              },
              onDone() {
                conversePhase = 'idle';
                data.finishTool();
              },
              onError(msg) {
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
            console.log(`[${tag}] correct mode: running LLM correction`);
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
            console.log(`[${tag}] review mode: holding converse for approval`);
            data.holdForApproval(
              { instruction, audioChunks },
              executeConverse,
              () => { conversePhase = 'idle'; },
            );
          }
          continue;
        }

        const result = await handleToolCall(fc.name!, fc.args ?? {});
        console.log(`[${tag}] tool result:`, result);
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
      console.log(`[${tag}] interrupted`);
      userSpokeInTurn = false;
      player.flush();
      data.commitTurn();
      return;
    }

    // User speech — always pass through, even during converse.
    if (sc.inputTranscription?.text) {
      console.log(`[user STT] ${sc.inputTranscription.text}`);
      data.appendInput(sc.inputTranscription.text);
      userSpokeInTurn = true;
    }

    // Gemini's speech text. During converse this is either its own chatter
    // or [CLAUDE]: echo text — both are noise (real text is in appendTool).
    // "Asking Claude" arrives BEFORE the toolCall message, so it naturally
    // passes through while conversePhase is still 'idle'.
    if (sc.outputTranscription?.text && conversePhase === 'idle') {
      console.log(`[gemini] ${sc.outputTranscription.text}`);
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
      data.commitTurn();

      // Nudge: Gemini completed without calling converse after user spoke
      if (userSpokeInTurn && conversePhase === 'idle') {
        console.log(`[${tag}] no tool call after user speech, nudging`);
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
        ...(deps.pttMode && {
          realtimeInputConfig: {
            automaticActivityDetection: { disabled: true },
          },
        }),
      },
      callbacks: {
        onopen: () => {
          console.log(`[${tag}] connected`);
          data.setStatus('connected');
        },
        onmessage: (msg: LiveServerMessage) => handleMessage(msg),
        onerror: (e: ErrorEvent) => {
          console.error(`[${tag}] error:`, e);
          data.pushError(`Error: ${e.message}`);
        },
        onclose: (e: CloseEvent) => {
          console.log(`[${tag}] closed:`, e.reason);
          data.setStatus('idle');
        },
      },
    });
    sessionRef = session;
    console.log(
      `%c[${tag}] SYSTEM PROMPT%c\n${BASE_PROMPT.trim()}`,
      'background:#7c3aed;color:white;font-weight:bold;padding:2px 6px;border-radius:3px',
      'color:#7c3aed;white-space:pre-wrap',
    );

    return {
      sendRealtimeInput: (input) => session.sendRealtimeInput(input),
      sendClientContent: (content) => session.sendClientContent(content),
      sendToolResponse: (response) =>
        session.sendToolResponse(response as LiveSendToolResponseParameters),
      close: () => session.close(),
    };
  } catch (e: unknown) {
    console.error(`[${tag}] connect failed:`, e);
    data.pushError(
      `Failed: ${e instanceof Error ? e.message : String(e)}`,
    );
    data.setStatus('idle');
    return null;
  }
}
