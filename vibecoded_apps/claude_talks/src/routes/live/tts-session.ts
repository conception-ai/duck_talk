/**
 * Ephemeral Gemini Live session that acts as a streaming TTS pipe.
 * Fully self-contained: owns its own Gemini connection, sentence buffer,
 * queue-based sender, and audio player.
 *
 * One instance per `converse` call. Opened when Claude starts streaming,
 * closed on done/error/interrupt.
 *
 * Queue-based sending: first sentence-buffer flush is sent immediately
 * with turnComplete:true. Subsequent flushes are queued and drained
 * one at a time on turnComplete — avoids mid-sentence cuts.
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
const TTS_PROMPT = 'Read aloud exactly what is sent to you. Do not add any commentary.';

// Log styles
const GREEN_BADGE = 'background:#059669;color:white;font-weight:bold;padding:1px 6px;border-radius:3px';
const DIM = 'color:#9ca3af';

export function openTTSSession(apiKey: string): StreamingTTS {
  const player = createPlayer();
  let session: Session | null = null;
  let closed = false;
  let finishing = false; // set by finish() — close session when queue drains
  let ttsIdle = true;
  let firstSendT0 = 0; // timestamp of first sendClientContent — for TTFT
  let ttftLogged = false;
  const queue: string[] = [];
  const preConnectQueue: string[] = [];

  function sendBatch(text: string) {
    if (!session || closed) return;
    if (ttsIdle) {
      ttsIdle = false;
      if (!firstSendT0) firstSendT0 = performance.now();
      console.log(`%c TTS %c → send: ${text}`, GREEN_BADGE, DIM);
      session.sendClientContent({
        turns: [{ role: 'user', parts: [{ text }] }],
        turnComplete: true,
      });
    } else {
      console.log(`%c TTS %c → queue: ${text}`, GREEN_BADGE, DIM);
      queue.push(text);
    }
  }

  function drainQueue() {
    if (queue.length > 0) {
      // Join all queued text into one batch — avoids 1.5s gaps between sentences
      const all = queue.join(' ');
      queue.length = 0;
      ttsIdle = false;
      console.log(`%c TTS %c → drain: ${all}`, GREEN_BADGE, DIM);
      session?.sendClientContent({
        turns: [{ role: 'user', parts: [{ text: all }] }],
        turnComplete: true,
      });
    } else if (finishing) {
      // All text spoken, close cleanly
      console.log(`%c TTS %c done — closing`, GREEN_BADGE, DIM);
      session?.close();
      player.stop();
    } else {
      ttsIdle = true;
    }
  }

  // Sentence buffer → queue-based sender
  const sentenceBuf = createSentenceBuffer(sendBatch);

  // Connect async — buffer text until ready
  const ai = new GoogleGenAI({ apiKey });
  ai.live.connect({
    model: TTS_MODEL,
    config: {
      responseModalities: [Modality.AUDIO],
      systemInstruction: TTS_PROMPT,
    },
    callbacks: {
      onopen: () => {
        console.log(`%c TTS %c connected`, GREEN_BADGE, DIM);
      },
      onmessage: (msg) => {
        if (msg.serverContent?.modelTurn?.parts) {
          for (const p of msg.serverContent.modelTurn.parts) {
            if (p.inlineData?.data && !closed) {
              if (!ttftLogged && firstSendT0) {
                ttftLogged = true;
                console.log(`%c TTS %c TTFT: ${Math.round(performance.now() - firstSendT0)}ms`, GREEN_BADGE, DIM);
              }
              player.play(p.inlineData.data);
            }
          }
        }
        if (msg.serverContent?.turnComplete) {
          drainQueue();
        }
      },
      onerror: (e) => {
        console.error(`%c TTS %c error`, GREEN_BADGE, DIM, e);
      },
      onclose: () => {
        console.log(`%c TTS %c closed`, GREEN_BADGE, DIM);
      },
    },
  }).then((s) => {
    if (closed) { s.close(); return; }
    session = s;
    // Drain any text that arrived before connection was ready
    for (const text of preConnectQueue) sentenceBuf.push(text);
    preConnectQueue.length = 0;
  });

  return {
    send(text: string) {
      if (closed) return;
      if (!session) {
        preConnectQueue.push(text);
      } else {
        sentenceBuf.push(text);
      }
    },
    finish() {
      if (closed) return;
      sentenceBuf.flush();
      finishing = true;
      // If nothing is playing/queued, close immediately
      if (ttsIdle && queue.length === 0) {
        console.log(`%c TTS %c finish (nothing queued) — closing`, GREEN_BADGE, DIM);
        closed = true;
        session?.close();
        player.stop();
      }
      // Otherwise drainQueue will close when queue empties
    },
    close() {
      closed = true;
      finishing = false;
      sentenceBuf.clear();
      queue.length = 0;
      player.flush();
      player.stop();
      session?.close();
    },
  };
}
