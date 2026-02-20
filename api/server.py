"""FastAPI backend that streams Claude Code responses as SSE."""

import asyncio
import glob
import json
import logging
import re
from pathlib import Path
from typing import cast

from fastapi import FastAPI, HTTPException
from fastapi.responses import StreamingResponse
from pydantic import BaseModel

from claude_client import Claude, TextDelta
from models import AssistantEntry, Conversation, UserEntry, preview

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(name)s %(message)s")
log = logging.getLogger("api")

_PROMPT_DIR = Path(__file__).resolve().parent / "prompts"
_SYSTEM_PROMPT = (_PROMPT_DIR / "conversational_tone.md").read_text()

log.info("system prompt loaded (%d chars)", len(_SYSTEM_PROMPT))

app = FastAPI()
claude = Claude(cwd="/Users/dhuynh95/claude_talks", system_prompt=_SYSTEM_PROMPT)

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
        try:
            conv = Conversation.from_jsonl(f)
        except Exception:
            continue
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


# Sentence-ending punctuation followed by space/newline, or standalone newline
_BREAK = re.compile(r"(?<=[.!?])\s|(?<=\n)")


def _sentence_break(buf: str) -> int:
    """Find the last sentence boundary in buf, or force-break at 200+ chars."""
    last = -1
    for m in _BREAK.finditer(buf):
        last = m.start()
    if last >= 0:
        return last
    return 0 if len(buf) > 200 else -1


def _sse(data: dict[str, object]) -> str:
    return f"data: {json.dumps(data)}\n\n"


class ConverseRequest(BaseModel):
    instruction: str
    session_id: str | None = None


@app.post("/api/converse")
async def converse(body: ConverseRequest) -> StreamingResponse:
    log.info("converse: %s", body.instruction[:120])

    async def stream():  # noqa: ANN202
        buf = ""
        n_chunks = 0
        async for chunk in claude.converse(
            body.instruction, session_id=body.session_id
        ):
            if isinstance(chunk, TextDelta):
                buf += chunk.text
                while (idx := _sentence_break(buf)) >= 0:
                    sentence = buf[: idx + 1].strip()
                    buf = buf[idx + 1 :]
                    if sentence:
                        n_chunks += 1
                        yield _sse({"text": sentence})
            else:
                if buf.strip():
                    n_chunks += 1
                    yield _sse({"text": buf.strip()})
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


_TEST_CHUNKS = [
    "A closure in Python is a function that remembers variables from the enclosing scope even after that scope has finished executing.",
    "For example, if you define a function inside another function, and the inner function references a variable from the outer function, that variable is captured.",
    "When you return the inner function and call it later, it still has access to that captured variable, even though the outer function is long gone.",
    "This is really useful for things like factory functions, decorators, and callback patterns.",
    "The key thing to understand is that the closure captures the variable itself, not just its value at the time of creation.",
]


@app.post("/api/converse/test")
async def converse_test(_body: ConverseRequest) -> StreamingResponse:
    """Simulated endpoint: streams 5 chunks over ~5 seconds, no Claude Code."""
    log.info("converse/test: starting simulated stream")

    async def stream():  # noqa: ANN202
        for i, chunk in enumerate(_TEST_CHUNKS):
            log.info("test chunk %d: %s", i + 1, chunk[:80])
            yield _sse({"text": chunk})
            await asyncio.sleep(1.0)
        log.info("test done: %d chunks", len(_TEST_CHUNKS))
        yield _sse({"done": True, "cost_usd": 0, "duration_ms": 5000})

    return StreamingResponse(stream(), media_type="text/event-stream")
