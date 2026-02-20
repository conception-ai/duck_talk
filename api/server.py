"""FastAPI backend that streams Claude Code responses as SSE."""

import glob
import json
import logging

from pathlib import Path
from typing import cast

from fastapi import FastAPI, HTTPException
from fastapi.responses import StreamingResponse
from pydantic import BaseModel

from claude_client import Claude, TextDelta
from models import AssistantEntry, Conversation, UserEntry, preview

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(name)s %(message)s")
log = logging.getLogger("api")

app = FastAPI()
claude = Claude(cwd="/Users/dhuynh95/claude_talks")

_PROJECT_DIR = Path.home() / ".claude/projects/-Users-dhuynh95-claude-talks"


class SessionInfo(BaseModel):
    id: str
    name: str
    summary: str
    updated_at: str
    message_count: int


def _last_timestamp(path: str) -> str:
    """Read last 8KB of a JSONL file, return the most recent entry timestamp."""
    with open(path, "rb") as f:
        _ = f.seek(0, 2)
        size = f.tell()
        chunk = min(8192, size)
        _ = f.seek(-chunk, 2)
        tail = f.read().decode(errors="replace")
    for line in reversed(tail.strip().split("\n")):
        try:
            data: dict[str, object] = cast(dict[str, object], json.loads(line))
            ts = str(data.get("timestamp", ""))
            if ts:
                return ts
        except (json.JSONDecodeError, AttributeError):
            continue
    return ""


@app.get("/api/sessions")
def list_sessions() -> list[SessionInfo]:
    if not _PROJECT_DIR.is_dir():
        return []
    files = glob.glob(str(_PROJECT_DIR / "*.jsonl"))

    # Fast sort: tail 8KB per file for timestamp (8ms vs 377ms full parse)
    timestamps = {f: _last_timestamp(f) for f in files}
    files.sort(key=lambda f: timestamps[f], reverse=True)

    sessions: list[SessionInfo] = []
    for f in files:
        sid = Path(f).stem
        conv = Conversation.from_jsonl(f)
        name = conv.last_user_message or conv.title
        if not name:
            continue
        sessions.append(
            SessionInfo(
                id=sid,
                name=name,
                summary=conv.last_assistant_message,
                updated_at=timestamps[f],
                message_count=conv.message_count,
            )
        )
    return sessions


def _load_conversation(session_id: str) -> Conversation:
    """Resolve session ID to file and load. Raises 404 if not found."""
    path = _PROJECT_DIR / f"{session_id}.jsonl"
    if not path.is_file():
        raise HTTPException(404, f"Session not found: {session_id}")
    return Conversation.from_jsonl(str(path))


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
    path.reverse()  # walk_path returns leaf→root, we want root→leaf

    messages: list[MessageResponse] = []
    for entry in path:
        if isinstance(entry, UserEntry):
            messages.append(
                MessageResponse(
                    role="user",
                    content=entry.message.content,
                )
            )
        elif isinstance(entry, AssistantEntry):
            blocks: list[dict[str, object]] = [
                block.model_dump(exclude_none=True) for block in entry.message.content
            ]
            messages.append(MessageResponse(role="assistant", content=blocks))
    return messages


def _sse(data: dict[str, object]) -> str:
    return f"data: {json.dumps(data)}\n\n"


class ConverseRequest(BaseModel):
    instruction: str
    session_id: str | None = None
    model: str
    system_prompt: str


@app.post("/api/converse")
async def converse(body: ConverseRequest) -> StreamingResponse:
    log.info(
        "converse: %s | model=%s prompt=%d chars",
        body.instruction,
        body.model,
        len(body.system_prompt),
    )

    async def stream():  # noqa: ANN202
        n_chunks = 0
        async for chunk in claude.converse(
            body.instruction,
            session_id=body.session_id,
            model=body.model,
            system_prompt=body.system_prompt,
        ):
            if isinstance(chunk, TextDelta):
                if chunk.text:
                    n_chunks += 1
                    yield _sse({"text": chunk.text})
            else:
                log.info(
                    "done: %d chunks, cost=$%s, %dms",
                    n_chunks,
                    chunk.cost_usd,
                    chunk.duration_ms,
                )
                yield _sse(
                    {
                        "done": True,
                        "session_id": chunk.session_id,
                        "cost_usd": chunk.cost_usd,
                        "duration_ms": chunk.duration_ms,
                    }
                )

    return StreamingResponse(stream(), media_type="text/event-stream")
