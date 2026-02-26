# Correction Audio Blows Up localStorage

Status: diagnosed, not started
Created: 2026-02-23

## The problem

After ~20 STT corrections, `localStorage.setItem()` throws
`QuotaExceededError`. The settings modal breaks. New corrections are
lost. The app doesn't recover until the user manually clears storage.

## Why it happens

localStorage has a ~5MB quota per origin. The corrections store
serializes everything — text AND audio — into one JSON blob.

```
STTCorrection = {
  heard: "what's the latest complete?"     ~50 bytes
  meant: "what's the latest commit?"       ~50 bytes
  audioChunks: RecordedChunk[]             ~200KB per utterance (base64 PCM @ 16kHz)
}
```

One correction ≈ 200KB. 25 corrections ≈ 5MB. Boom.

## The fundamental mistake

Two kinds of data with opposite characteristics are stored the same way.

```
                    Text (heard/meant)          Audio (PCM chunks)
                    ──────────────────          ──────────────────
Size per item       ~100 bytes                  ~200KB
Growth rate         Linear with corrections     Linear with corrections
Access pattern      Always loaded (UI list)     On-demand (play/download)
Storage fit         localStorage (sync, small)  IndexedDB (async, large)
```

localStorage is a key-value string store with a hard 5MB cap.
IndexedDB is a structured object store with essentially no cap.

Putting binary blobs in localStorage is like storing images in a
spreadsheet cell — it works until it doesn't, and then it fails hard.

## Where audio enters the correction

```
User speaks
  │
  ▼
snapshotUtterance()          ← captures audioBuffer (PCM chunks accumulated during speech)
  │
  ▼
PendingApproval              ← ephemeral, in-memory. Holds audio for playback during approval.
  │                             This is fine — it's never persisted.
  │
  ├── User clicks Accept     → audio discarded (never stored)
  │
  └── User clicks Edit       → handleSubmitEdit()
      └── corrections.addSTT(heard, meant, audioChunks)
          └── persist()
              └── JSON.stringify(corrections)   ← audioChunks included
                  └── localStorage.setItem()    ← QUOTA EXCEEDED
```

The audio is useful in two places:
1. **During approval** — user replays what they said (ephemeral, in-memory). Fine.
2. **In corrections list** — user replays/downloads past corrections. This is
   what blows up — it roundtrips through localStorage.

## The fix (principle)

**Split storage by data characteristics.** Text stays in localStorage.
Audio goes to IndexedDB. Link them by correction ID.

```
                ┌─────────────────────┐
                │   addSTT(heard,     │
                │     meant, chunks)  │
                └─────────┬───────────┘
                          │
              ┌───────────┴───────────┐
              ▼                       ▼
    ┌──────────────────┐    ┌──────────────────┐
    │   localStorage   │    │    IndexedDB     │
    │                  │    │                  │
    │  { id, heard,    │    │  { id, chunks }  │
    │    meant,        │    │                  │
    │    hasAudio }    │    │  ~200KB/entry    │
    │                  │    │  no practical    │
    │  ~150 bytes/item │    │  size limit      │
    └──────────────────┘    └──────────────────┘
              │                       │
              ▼                       ▼
    Always loaded               Loaded on demand
    (corrections list UI)       (play / download click)
```

The in-memory `STTCorrection` type keeps its `audioChunks` field — it's
still populated during the ephemeral approval flow. But when persisted,
`audioChunks` is always `[]` and `hasAudio: boolean` tells the UI whether
to show play/download buttons.

## What already exists

The project has `src/lib/recording-db.ts` — a thin IndexedDB CRUD wrapper
for utterance recordings. Same pattern, different domain. Don't extend it
(shared DB requires version migration). Create a parallel module for
correction audio.

```
recording-db.ts    ← existing, for utterance recorder
correction-db.ts   ← new, for correction audio (same pattern, own DB)
```

Three functions: `saveAudio(id, chunks)`, `getAudio(id)`, `deleteAudio(id)`.

## Migration

Existing corrections in localStorage have `audioChunks` populated. After
the fix, `load()` strips them and sets `hasAudio: false`. Old audio is
lost. This is acceptable — it's debugging data, and the alternative
(migrating blobs from localStorage to IndexedDB on first load) adds
complexity for a one-time operation on non-critical data.

## What changes

| Area | What |
|------|------|
| New IndexedDB module | `correction-db.ts` — save/get/delete audio by correction ID |
| Corrections store | `addSTT` writes audio to IndexedDB, text to localStorage. `remove` deletes from both. `load` strips old audio. |
| STTCorrection type | Add `hasAudio: boolean` |
| Play/download in UI | Become async — load audio from IndexedDB on demand |
| Approval flow | Unchanged — still ephemeral in-memory audio |

## Verification

1. Type-check: `npm run check`
2. Create a correction (speak → edit → submit in review/correct mode)
3. DevTools → Application → localStorage → `claude-talks:corrections` should have NO large base64 blobs, just text + `hasAudio: true`
4. DevTools → Application → IndexedDB → correction audio DB → entry exists
5. Settings → Corrections → play and download buttons work
6. Delete a correction → IndexedDB entry also removed
7. Repeat ~30 times → no `QuotaExceededError`

## Key files

| File | Role |
|------|------|
| `vibecoded_apps/claude_talks/src/routes/live/stores/corrections.svelte.ts` | The store that persists corrections (the bug is here) |
| `vibecoded_apps/claude_talks/src/routes/live/types.ts` | `STTCorrection` type definition |
| `vibecoded_apps/claude_talks/src/routes/live/+page.svelte` | Play/download correction handlers, approval flow |
| `vibecoded_apps/claude_talks/src/lib/recording-db.ts` | Existing IndexedDB pattern to follow |
