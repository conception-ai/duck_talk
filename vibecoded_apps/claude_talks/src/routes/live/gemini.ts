/**
 * Gemini Live API connection and message handling.
 * Plain .ts — no runes, no reactive state.
 * Receives DataStoreMethods via dependency injection.
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
          conversePhase = 'suppressing';
          player.flush();

          // Always send SILENT response so Gemini keeps talking
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

          const executeConverse = (approvedInstruction: string) => {
            converseApi.stream(approvedInstruction, {
              onChunk(text) {
                console.log(
                  `[converse] chunk: session=${!!sessionRef}`,
                  text.slice(0, 80),
                );
                data.appendTool(text);
                if (sessionRef) {
                  if (conversePhase === 'suppressing') conversePhase = 'relaying';
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
            // Learning mode: hold for user approval
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
            // Normal mode: execute immediately
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

    // --- Server content ---
    const sc = message.serverContent;
    if (!sc) return;

    if (sc.interrupted) {
      console.log(`[${tag}] interrupted`);
      player.flush();
      data.commitTurn();
      return;
    }

    if (sc.inputTranscription?.text) data.appendInput(sc.inputTranscription.text);

    // Suppress Gemini's output text during converse (ack arrives pre-tool-call, passes through)
    if (sc.outputTranscription?.text && conversePhase === 'idle') {
      data.appendOutput(sc.outputTranscription.text);
    }

    if (sc.modelTurn?.parts) {
      for (const part of sc.modelTurn.parts) {
        // Suppress Gemini's own audio between tool call and first Claude chunk
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
