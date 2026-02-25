"""FastAPI backend that streams Claude Code responses as SSE."""

import glob
import json
import logging
import os
from pathlib import Path
from typing import Literal, cast

from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import StreamingResponse
from pydantic import BaseModel

from reduck.claude_client import (
    Claude,
    ClaudeConfig,
    ContentBlockChunk,
    TextDelta,
)
from reduck.models import (
    AssistantEntry,
    Conversation,
    UserEntry,
    fork_session,
    path_to_slug,
    preview,
)

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(name)s %(message)s")
log = logging.getLogger("api")

# ── Config from env vars ────────────────────────────────────────────────────

_cli_path = os.environ.get("CLAUDE_CLI_PATH")
config = ClaudeConfig(
    config_dir=os.environ.get("CLAUDE_CONFIG_DIR", "~/.claude"),
    cli_path=os.path.expanduser(_cli_path) if _cli_path else None,
)

claude = Claude(config=config)

# ── Project scope (derived from launch cwd) ───────────────────────────────

PROJECT_CWD = os.getcwd()
PROJECT_SLUG = path_to_slug(PROJECT_CWD)

app = FastAPI()

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)


# ── Helpers ─────────────────────────────────────────────────────────────────


def _projects_root() -> Path:
    return Path(os.path.expanduser(config.config_dir)) / "projects"


def _project_dir() -> Path:
    return _projects_root() / PROJECT_SLUG


def _find_session_file(session_id: str) -> Path | None:
    """Find a session JSONL in the project directory."""
    candidate = _project_dir() / f"{session_id}.jsonl"
    return candidate if candidate.is_file() else None


def _load_conversation(session_id: str) -> Conversation:
    """Resolve session ID to file and load. Raises 404 if not found."""
    path = _find_session_file(session_id)
    if not path:
        raise HTTPException(404, f"Session not found: {session_id}")
    return Conversation.from_jsonl(str(path))


def _read_tail(path: str, nbytes: int = 32768) -> list[dict[str, object]]:
    """Read last N bytes of a JSONL file, return parsed lines (newest first)."""
    with open(path, "rb") as f:
        _ = f.seek(0, 2)
        size = f.tell()
        chunk = min(nbytes, size)
        _ = f.seek(-chunk, 2)
        tail = f.read().decode(errors="replace")
    result: list[dict[str, object]] = []
    for line in reversed(tail.strip().split("\n")):
        try:
            result.append(cast(dict[str, object], json.loads(line)))
        except (json.JSONDecodeError, AttributeError):
            continue
    return result


def _extract_preview(
    entries: list[dict[str, object]],
) -> tuple[str, str, str]:
    """Extract (name, summary, timestamp) from parsed JSONL entries (newest-first)."""
    ts = ""
    name = ""
    summary = ""
    for entry in entries:
        entry_type = entry.get("type")
        if not ts:
            t = entry.get("timestamp")
            if isinstance(t, str) and t:
                ts = t
        if not name and entry_type == "user":
            msg = entry.get("message")
            if isinstance(msg, dict):
                msg_dict = cast(dict[str, object], msg)
                raw_content = msg_dict.get("content", "")
                if isinstance(raw_content, str) and raw_content.strip():
                    name = raw_content.strip()[:200]
        if not summary and entry_type == "assistant":
            msg = entry.get("message")
            if isinstance(msg, dict):
                msg_dict = cast(dict[str, object], msg)
                blocks = msg_dict.get("content")
                if isinstance(blocks, list):
                    for block_obj in cast(list[object], blocks):
                        if not isinstance(block_obj, dict):
                            continue
                        block = cast(dict[str, object], block_obj)
                        if block.get("type") == "text":
                            text_val = block.get("text", "")
                            if isinstance(text_val, str) and text_val.strip():
                                summary = text_val.strip()[:300]
                                break
        if ts and name and summary:
            break
    return name, summary, ts


_TAIL_START = 32768
_TAIL_MAX = 262144


def _session_preview(path: str) -> tuple[str, str, str]:
    """Extract (name, summary, timestamp) from the tail of a JSONL file.

    Starts at 32KB and doubles up to 256KB until a user message with
    string content is found. Handles long sessions with large tool-result
    entries that push human messages out of a fixed-size window.
    """
    ts = ""
    nbytes = _TAIL_START
    while nbytes <= _TAIL_MAX:
        entries = _read_tail(path, nbytes)
        name, summary, ts = _extract_preview(entries)
        if name:
            return name, summary, ts
        nbytes *= 2
    return "", "", ts


# ── Endpoints ───────────────────────────────────────────────────────────────


@app.get("/api/config")
def get_config() -> dict[str, str]:
    return {"config_dir": config.config_dir, "project_cwd": PROJECT_CWD}


class SessionInfo(BaseModel):
    id: str
    name: str
    summary: str
    updated_at: str


@app.get("/api/sessions")
def list_sessions() -> list[SessionInfo]:
    pdir = _project_dir()
    if not pdir.is_dir():
        return []
    files = glob.glob(str(pdir / "*.jsonl"))

    # Single tail read per file: extract name, summary, and timestamp
    previews: dict[str, tuple[str, str, str]] = {}
    seen: set[str] = set()
    for f in files:
        sid = Path(f).stem
        if sid in seen:
            continue
        seen.add(sid)
        previews[f] = _session_preview(f)

    # Sort by timestamp descending
    files = [f for f in previews if previews[f][0]]  # skip empty sessions
    files.sort(key=lambda f: previews[f][2], reverse=True)

    return [
        SessionInfo(
            id=Path(f).stem,
            name=previews[f][0],
            summary=previews[f][1],
            updated_at=previews[f][2],
        )
        for f in files
    ]


class LeafInfo(BaseModel):
    uuid: str
    type: str
    depth: int
    preview: str
    is_active: bool


@app.get("/api/sessions/{session_id}/leaves")
def get_leaves(session_id: str) -> list[LeafInfo]:
    conv = _load_conversation(session_id)
    active = conv.active_leaf
    active_uuid = active.uuid if active else None
    result: list[LeafInfo] = []
    for leaf in conv.leaves:
        result.append(
            LeafInfo(
                uuid=leaf.uuid,
                type=leaf.type,
                depth=len(conv.walk_path(leaf.uuid)),
                preview=preview(leaf),
                is_active=leaf.uuid == active_uuid,
            )
        )
    result.sort(key=lambda x: x.depth, reverse=True)
    return result


class PathEntry(BaseModel):
    uuid: str
    type: str
    role: str | None
    preview: str


@app.get("/api/sessions/{session_id}/path")
def get_path(
    session_id: str,
    leaf: str | None = None,
    filter: str | None = None,
) -> list[PathEntry]:
    conv = _load_conversation(session_id)
    if leaf:
        leaf_uuid = leaf
    else:
        active = conv.active_leaf
        if not active:
            raise HTTPException(404, "No active leaf found")
        leaf_uuid = active.uuid

    path = conv.walk_path(leaf_uuid)
    if not path:
        raise HTTPException(404, f"UUID not found in tree: {leaf_uuid}")

    if filter == "messages":
        path = [e for e in path if e.type in ("user", "assistant")]

    return [
        PathEntry(
            uuid=e.uuid,
            type=e.type,
            role=e.message.role if isinstance(e, (UserEntry, AssistantEntry)) else None,
            preview=preview(e),
        )
        for e in path
    ]


class MessageResponse(BaseModel):
    uuid: str
    role: str
    content: str | list[dict[str, object]]


@app.get("/api/sessions/{session_id}/messages")
def get_messages(session_id: str) -> list[MessageResponse]:
    """Return the active-path messages with faithful content blocks."""
    conv = _load_conversation(session_id)
    active = conv.active_leaf
    if not active:
        raise HTTPException(404, "No active leaf found")

    path = conv.walk_path(active.uuid)
    path.reverse()

    messages: list[MessageResponse] = []
    for entry in path:
        if isinstance(entry, UserEntry):
            messages.append(
                MessageResponse(
                    uuid=entry.uuid,
                    role="user",
                    content=entry.message.content,
                )
            )
        elif isinstance(entry, AssistantEntry):
            blocks: list[dict[str, object]] = [
                block.model_dump(exclude_none=True) for block in entry.message.content
            ]
            messages.append(
                MessageResponse(uuid=entry.uuid, role="assistant", content=blocks)
            )
    return messages


def _sse(data: dict[str, object]) -> str:
    return f"data: {json.dumps(data)}\n\n"


class ConverseRequest(BaseModel):
    instruction: str
    session_id: str | None = None
    leaf_uuid: str | None = None
    model: str
    system_prompt: str
    permission_mode: Literal["default", "acceptEdits", "plan", "bypassPermissions"] = (
        "plan"
    )


@app.post("/api/converse")
async def converse(body: ConverseRequest) -> StreamingResponse:
    log.info(
        "converse: %s | model=%s prompt=%d chars",
        body.instruction,
        body.model,
        len(body.system_prompt),
    )

    # Fork if rewinding to a specific leaf
    session_id = body.session_id
    should_fork = False
    if body.leaf_uuid and body.session_id:
        session_path = _find_session_file(body.session_id)
        if session_path:
            session_id = fork_session(str(session_path), body.leaf_uuid)
            should_fork = True
            log.info(
                "forked session %s -> %s at leaf %s",
                body.session_id,
                session_id,
                body.leaf_uuid,
            )

    async def stream():  # noqa: ANN202
        n_chunks = 0
        async for chunk in claude.converse(
            body.instruction,
            session_id=session_id,
            model=body.model,
            system_prompt=body.system_prompt,
            cwd=PROJECT_CWD,
            permission_mode=body.permission_mode,
            fork=should_fork,
        ):
            if isinstance(chunk, TextDelta):
                if chunk.text:
                    n_chunks += 1
                    yield _sse({"text": chunk.text})
            elif isinstance(chunk, ContentBlockChunk):
                yield _sse({"block": chunk.block})
            else:
                log.info(
                    "done: %d chunks, cost=$%s, %dms",
                    n_chunks,
                    chunk.cost_usd,
                    chunk.duration_ms,
                )
                event: dict[str, object] = {
                    "done": True,
                    "session_id": chunk.session_id,
                    "cost_usd": chunk.cost_usd,
                    "duration_ms": chunk.duration_ms,
                }
                if chunk.error:
                    event["error"] = chunk.error
                yield _sse(event)

    return StreamingResponse(stream(), media_type="text/event-stream")
