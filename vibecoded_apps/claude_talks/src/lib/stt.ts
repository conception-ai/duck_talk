/**
 * Speech-to-text via Gemini audio understanding.
 *
 * Usage:
 *   const stt = createSTT({ apiKey });
 *   const text = await stt(chunksToWav(recording.chunks, recording.sampleRate), 'audio/wav');
 */

import { GoogleGenAI } from '@google/genai';

const DEFAULT_MODEL = 'gemini-3-flash-preview';

const clients = new Map<string, GoogleGenAI>();

function getClient(apiKey: string): GoogleGenAI {
  let client = clients.get(apiKey);
  if (!client) {
    client = new GoogleGenAI({ apiKey });
    clients.set(apiKey, client);
  }
  return client;
}

/** Combine sequential base64 PCM chunks into a single base64 PCM string. */
export function combineChunks(chunks: { data: string }[]): string {
  const parts: Uint8Array[] = [];
  for (const chunk of chunks) {
    const raw = atob(chunk.data);
    const bytes = new Uint8Array(raw.length);
    for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i);
    parts.push(bytes);
  }
  const totalLen = parts.reduce((sum, b) => sum + b.length, 0);
  const combined = new Uint8Array(totalLen);
  let offset = 0;
  for (const part of parts) { combined.set(part, offset); offset += part.length; }
  return btoa(String.fromCharCode(...combined));
}

/** Convert base64 PCM chunks to a base64 WAV string. */
export function chunksToWav(chunks: { data: string }[], sampleRate = 16000): string {
  const pcm = Uint8Array.from(atob(combineChunks(chunks)), (c) => c.charCodeAt(0));
  const header = new ArrayBuffer(44);
  const v = new DataView(header);
  const w = (off: number, s: string) => s.split('').forEach((c, i) => v.setUint8(off + i, c.charCodeAt(0)));
  w(0, 'RIFF'); v.setUint32(4, 36 + pcm.length, true);
  w(8, 'WAVE'); w(12, 'fmt ');
  v.setUint32(16, 16, true); v.setUint16(20, 1, true);  // PCM
  v.setUint16(22, 1, true);                              // mono
  v.setUint32(24, sampleRate, true);
  v.setUint32(28, sampleRate * 2, true);                 // byte rate
  v.setUint16(32, 2, true); v.setUint16(34, 16, true);  // block align, bits
  w(36, 'data'); v.setUint32(40, pcm.length, true);
  const wav = new Uint8Array(44 + pcm.length);
  wav.set(new Uint8Array(header)); wav.set(pcm, 44);
  return btoa(String.fromCharCode(...wav));
}

export interface STT {
  (audio: string, mimeType: string): Promise<string>;
}

export interface STTConfig {
  apiKey: string;
  model?: string;
}

export function createSTT(cfg: STTConfig): STT {
  const client = getClient(cfg.apiKey);
  const model = cfg.model ?? DEFAULT_MODEL;

  return async (audio, mimeType) => {
    const response = await client.models.generateContent({
      model,
      contents: [{
        role: 'user',
        parts: [
          { text: 'Transcribe this audio exactly as spoken. Return only the transcription, no commentary.' },
          { inlineData: { data: audio, mimeType } },
        ],
      }],
    });
    return response.text ?? '';
  };
}
