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
import type { AudioSink, ConverseApi, DataStoreMethods, LiveBackend } from './types';

const SYSTEM_PROMPT = `
You are a voice relay between a user and Claude Code (a powerful coding agent).

<RULES>
1. When the user asks a question or gives an instruction, ALWAYS call the converse tool. NEVER answer yourself.
2. While waiting for Claude Code's response, say only a brief acknowledgment like "Asking Claude" or "On it". Do NOT attempt to answer the question.
3. When you receive a message prefixed with [CLAUDE]:, read it aloud naturally and conversationally. Do not mention the [CLAUDE] prefix.
4. Do not add your own commentary, corrections, or opinions to Claude Code's responses — just relay them faithfully.
5. Make the relay conversation-friendly: skip bullet markers, dashes, code formatting symbols, and random IDs.
</RULES>

You are a transparent bridge. The user is talking TO Claude Code THROUGH you. You never answer on Claude Code's behalf.
`;

const MODEL = 'gemini-2.5-flash-native-audio-preview-12-2025';
const CONFIG = {
  responseModalities: [Modality.AUDIO],
  tools: TOOLS,
  systemInstruction: SYSTEM_PROMPT,
  inputAudioTranscription: {},
  outputAudioTranscription: {},
};

interface ConnectDeps {
  data: DataStoreMethods;
  player: AudioSink;
  converseApi: ConverseApi;
  tag: string;
  apiKey: string;
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

  async function handleMessage(message: LiveServerMessage) {
    console.log(`[${tag}] message:`, JSON.stringify(message).slice(0, 300));

    // --- Tool calls ---
    if (message.toolCall?.functionCalls) {
      data.commitTurn();
      for (const fc of message.toolCall.functionCalls) {
        console.log(`[${tag}] tool call:`, fc.name, fc.args);
        data.startTool(fc.name!);

        if (fc.name === 'converse') {
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
          converseApi.stream(instruction, {
            onChunk(text) {
              console.log(
                `[converse] chunk: session=${!!sessionRef}`,
                text.slice(0, 80),
              );
              data.appendTool(text);
              if (sessionRef) {
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
              data.finishTool();
            },
            onError(msg) {
              data.finishTool();
              data.pushError(msg);
            },
          });
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
    if (sc.outputTranscription?.text) data.appendOutput(sc.outputTranscription.text);

    if (sc.modelTurn?.parts) {
      for (const part of sc.modelTurn.parts) {
        if (part.inlineData?.data) player.play(part.inlineData.data);
      }
    }

    if (sc.turnComplete) {
      console.log(`[${tag}] turn complete`);
      data.commitTurn();
    }
  }

  try {
    const session = await ai.live.connect({
      model: MODEL,
      config: CONFIG,
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
