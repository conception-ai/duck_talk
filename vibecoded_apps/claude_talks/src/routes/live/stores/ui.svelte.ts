/**
 * UI store — screen state owned by UI components.
 * Distinct from core app data (stores/data).
 * Can persist across sessions (e.g. user preferences).
 * Grows as UI complexity grows.
 */

const STORAGE_KEY = 'claude-talks:ui';

interface Persisted {
  voiceEnabled: boolean;
  apiKey: string | null;
}

function load(): Persisted {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) return JSON.parse(raw);
  } catch { /* corrupted — fall through to default */ }
  return { voiceEnabled: true, apiKey: null };
}

function save(state: Persisted) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
}

export function createUIStore() {
  const persisted = load();
  let voiceEnabled = $state(persisted.voiceEnabled);
  let apiKey = $state<string | null>(persisted.apiKey);
  let apiKeyModalOpen = $state(!apiKey);

  function persist() {
    save({ voiceEnabled, apiKey });
  }

  function toggleVoice() {
    voiceEnabled = !voiceEnabled;
    persist();
  }

  function setApiKey(key: string) {
    const trimmed = key.trim();
    if (!trimmed) return;
    apiKey = trimmed;
    apiKeyModalOpen = false;
    persist();
  }

  function openApiKeyModal() {
    apiKeyModalOpen = true;
  }

  function closeApiKeyModal() {
    apiKeyModalOpen = false;
  }

  return {
    get voiceEnabled() { return voiceEnabled; },
    get apiKey() { return apiKey; },
    get apiKeyModalOpen() { return apiKeyModalOpen; },
    toggleVoice,
    setApiKey,
    openApiKeyModal,
    closeApiKeyModal,
  };
}
