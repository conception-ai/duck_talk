/**
 * Shared types and port interfaces for the live session.
 * No runtime code — everything here is a type or interface.
 */

import type { RecordedChunk } from './recorder';

// --- Domain types ---

export interface ToolCall {
  name: string;
  args: Record<string, unknown>;
}

export interface PendingTool {
  name: string;
  args: Record<string, unknown>;
  text: string;
  streaming: boolean;
}

export interface Turn {
  role: 'user' | 'assistant';
  text: string;
  toolCall?: ToolCall;
  toolResult?: string;
}

export type Status = 'idle' | 'connecting' | 'connected' | 'recording';

// --- Corrections ---

export interface STTCorrection {
  type: 'stt';
  id: string;
  createdAt: string;
  heard: string;
  meant: string;
  audioChunks: RecordedChunk[];
}

export type Correction = STTCorrection;

// --- Learning mode approval ---

export interface PendingApproval {
  stage: 'stt' | 'tool-call';
  toolCall: ToolCall;
  transcription: string;
  audioChunks: RecordedChunk[];
}

// --- Port: Data store mutations ---
// Plain interface so gemini.ts stays a regular .ts file (no rune imports).

export interface DataStoreMethods {
  appendInput(text: string): void;
  appendOutput(text: string): void;
  startTool(name: string, args: Record<string, unknown>): void;
  appendTool(text: string): void;
  finishTool(): void;
  commitTurn(): void;
  pushError(text: string): void;
  setStatus(s: Status): void;
  snapshotUtterance(): { transcription: string; audioChunks: RecordedChunk[] };
  holdForApproval(
    approval: PendingApproval,
    execute: (instruction: string) => void,
    cancel?: () => void,
  ): void;
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
  createPlayer(): AudioSink;
}

// --- Port: Gemini session backend ---

export interface RealtimeInput {
  audio?: { data: string; mimeType: string };
  activityStart?: Record<string, never>;
  activityEnd?: Record<string, never>;
}

export interface LiveBackend {
  sendRealtimeInput(input: RealtimeInput): void;
  sendClientContent(content: {
    turns: { role: string; parts: { text: string }[] }[];
    turnComplete: boolean;
  }): void;
  sendToolResponse(response: unknown): void;
  close(): void;
}

// --- Port: Claude Code converse API ---

export interface ConverseApi {
  stream(
    instruction: string,
    callbacks: {
      onChunk: (text: string) => void;
      onDone?: (cost: number, durationMs: number) => void;
      onError: (msg: string) => void;
    },
  ): Promise<void>;
}
