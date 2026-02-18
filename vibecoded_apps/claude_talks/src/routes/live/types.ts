/**
 * Shared types and port interfaces for the live session.
 * No runtime code — everything here is a type or interface.
 */

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

export interface LiveBackend {
  sendRealtimeInput(audio: { data: string; mimeType: string }): void;
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
