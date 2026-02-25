<script lang="ts">
  import { push } from 'svelte-spa-router';

  interface SessionInfo {
    id: string;
    name: string;
    summary: string;
    updated_at: string;
  }

  let sessions = $state<SessionInfo[]>([]);
  let loading = $state(true);
  let error = $state('');

  async function loadSessions() {
    loading = true;
    error = '';
    try {
      const res = await fetch('/api/sessions');
      if (!res.ok) throw new Error(`${res.status}`);
      sessions = await res.json();
    } catch (e) {
      error = `Failed to load sessions: ${e instanceof Error ? e.message : String(e)}`;
    } finally {
      loading = false;
    }
  }

  loadSessions();

  function relativeTime(iso: string): string {
    const diff = Date.now() - new Date(iso).getTime();
    const mins = Math.floor(diff / 60000);
    if (mins < 1) return 'just now';
    if (mins < 60) return `${mins}m ago`;
    const hours = Math.floor(mins / 60);
    if (hours < 24) return `${hours}h ago`;
    const days = Math.floor(hours / 24);
    return `${days}d ago`;
  }
</script>

<main>
  <header>
    <h1>Sessions</h1>
    <button onclick={() => push('/live')}>New</button>
  </header>

  {#if loading}
    <p class="status">Loading...</p>
  {:else if error}
    <p class="status error">{error}</p>
  {:else if sessions.length === 0}
    <p class="status">No sessions yet.</p>
  {:else}
    <div class="session-list">
      {#each sessions as s (s.id)}
        <button class="session-row" onclick={() => push(`/live/${s.id}`)}>
          <div class="session-header">
            <span class="session-name">{s.name}</span>
            <span class="session-meta">{relativeTime(s.updated_at)}</span>
          </div>
          {#if s.summary}
            <p class="session-summary">{s.summary}</p>
          {/if}
        </button>
      {/each}
    </div>
  {/if}
</main>

<style>
  main {
    max-width: 600px;
    margin: 2rem auto;
    font-family: system-ui, sans-serif;
  }

  header {
    display: flex;
    align-items: center;
    gap: 1rem;
    margin-bottom: 1.5rem;
  }

  h1 {
    margin: 0;
    flex: 1;
  }

  button {
    padding: 0.5rem 1.5rem;
    font-size: 0.9rem;
    cursor: pointer;
    border: 1px solid currentColor;
    border-radius: 0.25rem;
    background: none;
  }

  .status {
    color: #9ca3af;
    text-align: center;
    margin-top: 3rem;
  }

  .status.error {
    color: #dc2626;
  }

  .session-list {
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
  }

  .session-row {
    width: 100%;
    text-align: left;
    padding: 0.75rem 1rem;
    border: 1px solid #e5e7eb;
    border-radius: 0.5rem;
    background: none;
    cursor: pointer;
    display: flex;
    flex-direction: column;
    gap: 0.25rem;
  }

  .session-row:hover {
    background: #f9fafb;
    border-color: #d1d5db;
  }

  .session-header {
    display: flex;
    justify-content: space-between;
    align-items: baseline;
    gap: 1rem;
  }

  .session-name {
    font-weight: 600;
    font-size: 0.9rem;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    flex: 1;
  }

  .session-meta {
    font-size: 0.75rem;
    color: #9ca3af;
    white-space: nowrap;
  }

  .session-summary {
    font-size: 0.8rem;
    color: #6b7280;
    margin: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
</style>
