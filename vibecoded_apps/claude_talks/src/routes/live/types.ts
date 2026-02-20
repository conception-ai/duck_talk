/**
 * Shared types and port interfaces for the live session.
 * No runtime code — everything here is a type or interface.
 */

// --- Domain types ---

export interface RecordedChunk {
  ts: number;   // ms since session start
  data: string; // base64 PCM
}

export interface PendingTool {
  name: string;
  args: Record<string, unknown>;
  text: string;
  streaming: boolean;
}

export type Status = 'idle' | 'connecting' | 'connected';

// --- CC message types (1:1 with models.py) ---

export type ContentBlock =
  | { type: 'text'; text: string }
  | { type: 'thinking'; thinking: string }
  | { type: 'tool_use'; id: string; name: string; input: Record<string, unknown> }
  | { type: 'tool_result'; tool_use_id: string; content: string }
  | { type: 'image'; source: { type: 'base64'; media_type: string; data: string } };

export interface Message {
  role: 'user' | 'assistant';
  content: string | ContentBlock[];
}

export interface VoiceEvent {
  role: 'user' | 'gemini';
  text: string;
  ts: number;
}

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

// --- Interaction mode ---

export type InteractionMode = 'direct' | 'review' | 'correct';

export interface PendingApproval {
  rawInstruction?: string;     // original Gemini arg (only set in 'correct' mode)
  instruction: string;         // what user sees/edits (= raw in review, LLM-corrected in correct)
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
  approve(editedText?: string): void;
  back(): Promise<void>;
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
  stream(
    instruction: string,
    callbacks: {
      onChunk: (text: string) => void;
      onDone?: (cost: number, durationMs: number) => void;
      onError: (msg: string) => void;
    },
  ): Promise<void>;
  abort(): void;
}
