/**
 * Corrections store — persisted speech corrections.
 * Same localStorage pattern as ui.svelte.ts.
 */

import type { RecordedChunk } from '../../recorder';
import type { STTCorrection } from '../types';

const STORAGE_KEY = 'claude-talks:corrections';

interface Persisted {
  corrections: STTCorrection[];
}

function load(): Persisted {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) return JSON.parse(raw);
  } catch { /* corrupted — fall through to default */ }
  return { corrections: [] };
}

function save(state: Persisted) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
}

export function createCorrectionsStore() {
  const persisted = load();
  let corrections = $state<STTCorrection[]>(persisted.corrections);

  function persist() {
    save({ corrections });
  }

  function addSTT(heard: string, meant: string, audioChunks: RecordedChunk[]): STTCorrection {
    const correction: STTCorrection = {
      type: 'stt',
      id: crypto.randomUUID(),
      createdAt: new Date().toISOString(),
      heard,
      meant,
      audioChunks,
    };
    corrections.push(correction);
    persist();
    return correction;
  }

  function remove(id: string) {
    corrections = corrections.filter((c) => c.id !== id);
    persist();
  }

  return {
    get corrections() { return corrections; },
    addSTT,
    remove,
  };
}
