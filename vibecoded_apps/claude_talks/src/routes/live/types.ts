/**
 * Live session types.
 * Re-exports render types from lib, defines port interfaces locally.
 */

// --- Re-export render types (shared with other routes) ---

export type {
  ContentBlock,
  Correction,
  InteractionMode,
  Message,
  PendingApproval,
  PendingTool,
  Status,
  VoiceEvent,
} from '../../lib/chat-types';

import type { ContentBlock, PendingApproval, Status } from '../../lib/chat-types';

// --- Port: Data store mutations ---
// Plain interface so gemini.ts stays a regular .ts file (no rune imports).

export interface DataStoreMethods {
  appendInput(text: string): void;
  startTool(name: string, args: Record<string, unknown>): void;
  appendTool(text: string): void;
  appendBlock(block: ContentBlock): void;
  finishTool(): void;
  commitUserMessage(text: string): void;
  commitTurn(): void;
  pushError(text: string): void;
  setStatus(s: Status): void;
  holdForApproval(
    approval: PendingApproval,
    execute: (instruction: string) => void,
    cancel?: () => void,
  ): void;
  approve(editedText?: string): void;
  reject(): void;
}

// --- Port: Streaming TTS ---

export interface StreamingTTS {
  send(text: string): void;
  finish(): void;
  interrupt(): void;
  close(): void;
}

// --- Port: Audio ---

export interface AudioSource {
  stop(): void;
}

export interface AudioSink {
  play(base64: string): void;
  flush(): void;
  stop(): void;
}

export interface AudioPort {
  startMic(onChunk: (base64: string) => void): Promise<AudioSource>;
}

// --- Port: Gemini session backend ---

export interface RealtimeInput {
  audio?: { data: string; mimeType: string };
}

export interface ContentPart {
  text?: string;
  inlineData?: { data: string; mimeType: string };
}

export interface LiveBackend {
  sendRealtimeInput(input: RealtimeInput): void;
  sendClientContent(content: {
    turns: { role: string; parts: ContentPart[] }[];
    turnComplete: boolean;
  }): void;
  sendToolResponse(response: unknown): void;
  close(): void;
}

// --- Port: Claude Code converse API ---

export interface ConverseApi {
  sessionId: string | null;
  sessionStart: number;
  leafUuid: string | null;
  stream(
    instruction: string,
    callbacks: {
      onChunk: (text: string) => void;
      onBlock?: (block: ContentBlock) => void;
      onDone?: (cost: number, durationMs: number) => void;
      onError: (msg: string) => void;
    },
  ): Promise<void>;
  abort(): void;
}
