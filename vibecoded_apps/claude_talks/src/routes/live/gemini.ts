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
import type { AudioSink, Correction, ConverseApi, DataStoreMethods, LiveBackend } from './types';

const BASE_PROMPT = `
You are a voice relay between a user and Claude Code (a powerful coding agent).

<RULES>
1. When the user asks a question or gives an instruction, ALWAYS call the converse tool, ALWAYS respond with "Asking Claude" and NEVER answer yourself.
2. Then stop after saying "Asking Claude" and only start speaking again by reciting verbatim what Claude converse call will share to you.
3. When you receive a message prefixed with [CLAUDE]:, read it aloud naturally and conversationally. Do not mention the [CLAUDE] prefix.
4. Do not add your own commentary, corrections, or opinions to Claude Code's responses — just relay them faithfully.
5. Make the relay conversation-friendly: skip bullet markers, dashes, code formatting symbols, and random IDs.
</RULES>

You are a transparent bridge. The user is talking TO Claude Code THROUGH you. You never answer on Claude Code's behalf.
`;

function buildSystemPrompt(corrections: Correction[]): string {
  const stt = corrections.filter((c) => c.type === 'stt');
  if (!stt.length) return BASE_PROMPT;

  const lines = stt.map(
    (c) => `- You transcribed: "${c.heard}" → They said: "${c.meant}"`,
  );
  return `${BASE_PROMPT}
<STT_CORRECTIONS>
Your transcription often gets these wrong with this user:
${lines.join('\n')}
</STT_CORRECTIONS>
`;
}

const MODEL = 'gemini-2.5-flash-native-audio-preview-12-2025';

interface ConnectDeps {
  data: DataStoreMethods;
  player: AudioSink;
  converseApi: ConverseApi;
  tag: string;
  apiKey: string;
  getLearningMode: () => boolean;
  corrections: Correction[];
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

  async function handleMessage(message: LiveServerMessage) {
    console.log(`[${tag}] message:`, JSON.stringify(message).slice(0, 300));

    // --- Tool calls ---
    if (message.toolCall?.functionCalls) {
      // Snapshot BEFORE commitTurn clears the buffer
      const learningMode = deps.getLearningMode();
      const utterance = learningMode ? data.snapshotUtterance() : null;

      data.commitTurn();
      for (const fc of message.toolCall.functionCalls) {
        console.log(`[${tag}] tool call:`, fc.name, fc.args);
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
                console.log(
                  `[converse] chunk: session=${!!sessionRef}`,
                  text.slice(0, 80),
                );
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

          if (utterance) {
            // Learning mode: pause for user to Accept/Edit/Reject the STT
            // and tool call before executing. Phase stays `suppressing` the
            // entire time — no audio or text leaks while waiting.
            // Third arg: cancel callback resets phase if user rejects.
            console.log(`[${tag}] learning mode: holding converse for approval`);
            data.holdForApproval(
              {
                stage: 'stt',
                toolCall: { name: fc.name!, args: fc.args ?? {} },
                transcription: utterance.transcription,
                audioChunks: utterance.audioChunks,
              },
              executeConverse,
              () => { conversePhase = 'idle'; },
            );
          } else {
            executeConverse(instruction);
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
      player.flush();
      data.commitTurn();
      return;
    }

    // User speech — always pass through, even during converse.
    if (sc.inputTranscription?.text) data.appendInput(sc.inputTranscription.text);

    // Gemini's speech text. During converse this is either its own chatter
    // or [CLAUDE]: echo text — both are noise (real text is in appendTool).
    // "Asking Claude" arrives BEFORE the toolCall message, so it naturally
    // passes through while conversePhase is still 'idle'.
    if (sc.outputTranscription?.text && conversePhase === 'idle') {
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
      console.log(`[${tag}] turn complete`);
      data.commitTurn();
    }
  }

  try {
    const systemPrompt = buildSystemPrompt(deps.corrections);
    console.log(`[${tag}] system prompt:`, systemPrompt.slice(0, 200));
    const session = await ai.live.connect({
      model: MODEL,
      config: {
        responseModalities: [Modality.AUDIO],
        tools: TOOLS,
        systemInstruction: systemPrompt,
        inputAudioTranscription: {},
        outputAudioTranscription: {},
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

    return {
      sendRealtimeInput: (audio) => session.sendRealtimeInput({ audio }),
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
