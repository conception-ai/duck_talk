/**
 * Render-relevant domain types shared across routes.
 * No runtime code — everything here is a type or interface.
 */

// --- CC message types (1:1 with models.py) ---

export type ContentBlock =
  | { type: 'text'; text: string }
  | { type: 'thinking'; thinking: string }
  | { type: 'tool_use'; id: string; name: string; input: Record<string, unknown> }
  | { type: 'tool_result'; tool_use_id: string; content: string }
  | { type: 'image'; source: { type: 'base64'; media_type: string; data: string } };

export interface Message {
  uuid?: string;
  role: 'user' | 'assistant';
  content: string | ContentBlock[];
}

// --- UI state types ---

export interface PendingTool {
  name: string;
  args: Record<string, unknown>;
  text: string;
  blocks: ContentBlock[];
  streaming: boolean;
}

export type Status = 'idle' | 'connecting' | 'connected';

export interface PendingApproval {
  instruction: string;
}

export type InteractionMode = 'direct' | 'review';

// --- Supporting types ---

export interface VoiceEvent {
  role: 'user' | 'gemini';
  text: string;
  ts: number;
}

export interface Correction {
  id: string;
  original: string;
  corrected: string;
}
