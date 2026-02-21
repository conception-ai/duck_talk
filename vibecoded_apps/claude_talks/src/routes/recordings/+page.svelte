<script lang="ts">
  import { push } from 'svelte-spa-router';
  import { getAllRecordings, deleteRecording, clearAllRecordings, type StoredRecording } from '../../lib/recording-db';
  import { chunksToWav } from '../../lib/stt';
  import { playPcmChunks } from '../live/audio';

  let recordings = $state<StoredRecording[]>([]);
  let loading = $state(true);
  let playing = $state<number | null>(null);
  let playHandle: { stop: () => void } | null = null;

  async function load() {
    recordings = (await getAllRecordings()).reverse();
    loading = false;
  }
  load();

  function duration(rec: StoredRecording): string {
    const totalBytes = rec.chunks.reduce((sum, c) => sum + atob(c.data).length, 0);
    const seconds = totalBytes / 2 / 16000;
    return seconds < 1 ? '<1s' : `${seconds.toFixed(1)}s`;
  }

  function relativeTime(ts: number): string {
    const diff = Date.now() - ts;
    const mins = Math.floor(diff / 60000);
    if (mins < 1) return 'just now';
    if (mins < 60) return `${mins}m ago`;
    const hours = Math.floor(mins / 60);
    if (hours < 24) return `${hours}h ago`;
    return `${Math.floor(hours / 24)}d ago`;
  }

  function play(rec: StoredRecording) {
    stopPlayback();
    playing = rec.id ?? null;
    playHandle = playPcmChunks(
      rec.chunks.map((c) => c.data),
      16000,
      () => { playing = null; playHandle = null; },
    );
  }

  function stopPlayback() {
    playHandle?.stop();
    playHandle = null;
    playing = null;
  }

  function download(rec: StoredRecording) {
    const wavB64 = chunksToWav(rec.chunks, 16000);
    const bin = atob(wavB64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([bytes], { type: 'audio/wav' }));
    a.download = `utterance-${rec.id}.wav`;
    a.click();
  }

  async function remove(rec: StoredRecording) {
    if (rec.id == null) return;
    await deleteRecording(rec.id);
    recordings = recordings.filter((r) => r.id !== rec.id);
  }

  async function clearAll() {
    await clearAllRecordings();
    recordings = [];
  }
</script>

<main>
  <header>
    <button class="back" onclick={() => push('/')}>Home</button>
    <h1>Recordings</h1>
    {#if recordings.length > 0}
      <button class="danger" onclick={clearAll}>Clear all</button>
    {/if}
  </header>

  {#if loading}
    <p class="status">Loading...</p>
  {:else if recordings.length === 0}
    <p class="status">No recordings yet.</p>
  {:else}
    <div class="list">
      {#each recordings as rec (rec.id)}
        <div class="row">
          <div class="info">
            <span class="transcript">{rec.transcript || '(no transcript)'}</span>
            <span class="meta">{duration(rec)} &middot; {relativeTime(rec.createdAt)}</span>
          </div>
          <div class="actions">
            <button
              class="action"
              onclick={() => playing === rec.id ? stopPlayback() : play(rec)}
              title={playing === rec.id ? 'Stop' : 'Play'}
            >
              {playing === rec.id ? '⏹' : '▶'}
            </button>
            <button class="action" onclick={() => download(rec)} title="Download">
              ⬇
            </button>
            <button class="action delete" onclick={() => remove(rec)} title="Delete">
              ✕
            </button>
          </div>
        </div>
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
    padding: 0.5rem 1rem;
    font-size: 0.9rem;
    cursor: pointer;
    border: 1px solid currentColor;
    border-radius: 0.25rem;
    background: none;
  }

  .danger {
    color: #dc2626;
    border-color: #dc2626;
  }

  .status {
    color: #9ca3af;
    text-align: center;
    margin-top: 3rem;
  }

  .list {
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
  }

  .row {
    display: flex;
    align-items: center;
    gap: 1rem;
    padding: 0.75rem 1rem;
    border: 1px solid #e5e7eb;
    border-radius: 0.5rem;
  }

  .row:hover {
    background: #f9fafb;
    border-color: #d1d5db;
  }

  .info {
    flex: 1;
    display: flex;
    flex-direction: column;
    gap: 0.25rem;
    min-width: 0;
  }

  .transcript {
    font-weight: 600;
    font-size: 0.9rem;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .meta {
    font-size: 0.75rem;
    color: #9ca3af;
  }

  .actions {
    display: flex;
    gap: 0.25rem;
  }

  .action {
    padding: 0.25rem 0.5rem;
    font-size: 1rem;
    border: none;
    background: none;
    cursor: pointer;
    opacity: 0.6;
  }

  .action:hover {
    opacity: 1;
  }

  .delete:hover {
    color: #dc2626;
  }
</style>
