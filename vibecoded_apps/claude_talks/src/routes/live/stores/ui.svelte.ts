/**
 * UI store — screen state owned by UI components.
 * Distinct from core app data (stores/data).
 * Can persist across sessions (e.g. user preferences).
 * Grows as UI complexity grows.
 */

import type { InteractionMode } from '../types';
import { DEFAULT_MODEL, DEFAULT_PERMISSION_MODE, DEFAULT_SYSTEM_PROMPT } from '../defaults';

const STORAGE_KEY = 'claude-talks:ui';

interface Persisted {
  voiceEnabled: boolean;
  readbackEnabled: boolean;
  apiKey: string | null;
  mode: InteractionMode;
  model: string;
  systemPrompt: string;
  permissionMode: string;
}

const DEFAULTS: Persisted = {
  voiceEnabled: true,
  readbackEnabled: false,
  apiKey: null,
  mode: 'direct',
  model: DEFAULT_MODEL,
  systemPrompt: DEFAULT_SYSTEM_PROMPT,
  permissionMode: DEFAULT_PERMISSION_MODE,
};

function load(): Persisted {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      // Migrate old learningMode boolean → mode enum
      if ('learningMode' in parsed && !('mode' in parsed)) {
        parsed.mode = parsed.learningMode ? 'review' : 'direct';
      }
      return { ...DEFAULTS, ...parsed };
    }
  } catch { /* corrupted — fall through to default */ }
  return { ...DEFAULTS };
}

function save(state: Persisted) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
}

export function createUIStore() {
  const persisted = load();
  let voiceEnabled = $state(persisted.voiceEnabled);
  let readbackEnabled = $state(persisted.readbackEnabled);
  let apiKey = $state<string | null>(persisted.apiKey);
  let mode = $state<InteractionMode>(persisted.mode);
  let model = $state(persisted.model);
  let systemPrompt = $state(persisted.systemPrompt);
  let permissionMode = $state(persisted.permissionMode);

  function persist() {
    save({ voiceEnabled, readbackEnabled, apiKey, mode, model, systemPrompt, permissionMode });
  }

  function toggleVoice() {
    voiceEnabled = !voiceEnabled;
    persist();
  }

  function setApiKey(key: string) {
    const trimmed = key.trim();
    if (!trimmed) return;
    apiKey = trimmed;
    persist();
  }

  function setMode(m: InteractionMode) {
    mode = m;
    persist();
  }

  return {
    get voiceEnabled() { return voiceEnabled; },
    get readbackEnabled() { return readbackEnabled; },
    setReadbackEnabled(v: boolean) { readbackEnabled = v; persist(); },
    get apiKey() { return apiKey; },
    get mode() { return mode; },
    toggleVoice,
    setApiKey,
    setMode,
    get model() { return model; },
    get systemPrompt() { return systemPrompt; },
    setModel(m: string) { model = m; persist(); },
    setSystemPrompt(p: string) { systemPrompt = p; persist(); },
    resetSystemPrompt() { systemPrompt = DEFAULT_SYSTEM_PROMPT; persist(); },
    get permissionMode() { return permissionMode; },
    setPermissionMode(m: string) { permissionMode = m; persist(); },
    cyclePermissionMode() {
      permissionMode = permissionMode === 'plan' ? 'acceptEdits' : 'plan';
      persist();
    },
  };
}
