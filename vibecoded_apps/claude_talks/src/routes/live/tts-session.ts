/**
 * Persistent Gemini Live session that acts as a streaming TTS pipe.
 * Fully self-contained: owns its own Gemini connection, sentence buffer,
 * and audio player.
 *
 * One instance per Gemini Live session, reused across converse calls.
 * `interrupt()` stops playback between calls; `close()` is final teardown.
 *
 * Each sentence-buffer flush is sent directly to Gemini.
 */

import {
  GoogleGenAI,
  Modality,
  type Session,
} from '@google/genai';
import { createSentenceBuffer } from './buffer';
import { createPlayer } from './audio';
import type { StreamingTTS } from './types';

const TTS_MODEL = 'gemini-2.5-flash-native-audio-preview-12-2025';
const TTS_PROMPT = 'You are a text-to-speech reader. Read aloud EXACTLY what the user sends, word for word. NEVER respond, answer questions, or add commentary. Just read the text out loud.';

// Log styles
const GREEN_BADGE = 'background:#059669;color:white;font-weight:bold;padding:1px 6px;border-radius:3px';
const DIM = 'color:#9ca3af';

export function openTTSSession(apiKey: string, onFlush?: (text: string) => void): StreamingTTS {
  const player = createPlayer();
  let session: Session | null = null;
  let closed = false;
  let finishing = false;
  let muted = false;
  let pendingSends = 0;
  let firstSendT0 = 0;
  let ttftLogged = false;
  const preConnectQueue: string[] = [];

  function sendText(text: string) {
    if (!session || closed) {
      console.warn(`%c TTS %c dropped (session dead): ${text}`, GREEN_BADGE, DIM);
      return;
    }
    if (!firstSendT0) firstSendT0 = performance.now();
    pendingSends++;
    console.log(`%c TTS %c ← [${pendingSends}] ${text}`, GREEN_BADGE, DIM);
    session.sendClientContent({
      turns: [{ role: 'user', parts: [{ text: `[READ]: ${text}` }] }],
      turnComplete: true,
    });
  }

  const sentenceBuf = createSentenceBuffer((text) => { sendText(text); onFlush?.(text); });

  // Connect async — buffer text until ready
  const ai = new GoogleGenAI({ apiKey });
  ai.live.connect({
    model: TTS_MODEL,
    config: {
      responseModalities: [Modality.AUDIO],
      systemInstruction: TTS_PROMPT,
      outputAudioTranscription: {},
    },
    callbacks: {
      onopen: () => {
        console.log(`%c TTS %c connected`, GREEN_BADGE, DIM);
      },
      onmessage: (msg) => {
        if (msg.serverContent?.modelTurn?.parts) {
          for (const p of msg.serverContent.modelTurn.parts) {
            if (p.inlineData?.data && !closed && !muted) {
              if (!ttftLogged && firstSendT0) {
                ttftLogged = true;
                console.log(`%c TTS %c TTFT: ${Math.round(performance.now() - firstSendT0)}ms`, GREEN_BADGE, DIM);
              }
              player.play(p.inlineData.data);
            }
          }
        }
        if (msg.serverContent?.outputTranscription?.text) {
          console.log(`%c TTS %c → ${msg.serverContent.outputTranscription.text}`, GREEN_BADGE, DIM);
        }
        if (msg.serverContent?.turnComplete) {
          pendingSends = Math.max(0, pendingSends - 1);
          console.log(`%c TTS %c turnComplete (pending: ${pendingSends})`, GREEN_BADGE, DIM);
          if (finishing && pendingSends === 0) {
            console.log(`%c TTS %c done — ready for next converse`, GREEN_BADGE, DIM);
            finishing = false;
          }
        }
      },
      onerror: (e) => {
        console.error(`%c TTS %c error`, GREEN_BADGE, DIM, e);
      },
      onclose: (e: CloseEvent) => {
        closed = true;
        session = null;
        console.log(`%c TTS %c closed (code=${e.code} reason=${e.reason || 'none'})`, GREEN_BADGE, DIM);
      },
    },
  }).then((s) => {
    if (closed) { s.close(); return; }
    session = s;
    for (const text of preConnectQueue) sentenceBuf.push(text);
    preConnectQueue.length = 0;
  });

  return {
    send(text: string) {
      if (closed) return;
      if (muted) {
        muted = false;
        firstSendT0 = 0;
        ttftLogged = false;
      }
      if (!session) {
        preConnectQueue.push(text);
      } else {
        sentenceBuf.push(text);
      }
    },
    finish() {
      if (closed) return;
      sentenceBuf.flush();
      if (pendingSends === 0) {
        console.log(`%c TTS %c finish (nothing pending) — ready`, GREEN_BADGE, DIM);
        finishing = false;
      } else {
        finishing = true;
      }
    },
    interrupt() {
      if (closed) return;
      muted = true;
      finishing = false;
      pendingSends = 0;
      sentenceBuf.clear();
      player.flush();
      console.log(`%c TTS %c interrupted — muted`, GREEN_BADGE, DIM);
    },
    close() {
      if (closed) return;
      closed = true;
      muted = true;
      finishing = false;
      pendingSends = 0;
      sentenceBuf.clear();
      player.flush();
      player.stop();
      session?.close();
    },
  };
}
