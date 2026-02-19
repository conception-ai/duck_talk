"""FastAPI backend that streams Claude Code responses as SSE."""

import asyncio
import glob
import json
import logging
import os
import re
from pathlib import Path

from fastapi import FastAPI
from fastapi.responses import StreamingResponse
from pydantic import BaseModel

from claude_client import Claude, TextDelta
from models import Conversation

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(name)s %(message)s")
log = logging.getLogger("api")

_PROMPT_DIR = Path(__file__).resolve().parent / "prompts"
_SYSTEM_PROMPT = (_PROMPT_DIR / "conversational_tone.md").read_text()

log.info("system prompt loaded (%d chars):\n%s", len(_SYSTEM_PROMPT), _SYSTEM_PROMPT)

app = FastAPI()
claude = Claude(cwd="/Users/dhuynh95/claude_talks", system_prompt=_SYSTEM_PROMPT)

_PROJECT_DIR = Path.home() / ".claude/projects/-Users-dhuynh95-claude-talks"


class SessionInfo(BaseModel):
    id: str
    name: str
    summary: str
    last_user_message: str
    last_assistant_message: str
    updated_at: str
    message_count: int


@app.get("/api/sessions")
def list_sessions() -> list[SessionInfo]:
    if not _PROJECT_DIR.is_dir():
        return []
    files = sorted(
        glob.glob(str(_PROJECT_DIR / "*.jsonl")),
        key=os.path.getmtime,
        reverse=True,
    )
    sessions: list[SessionInfo] = []
    for f in files:
        sid = Path(f).stem
        try:
            conv = Conversation.from_jsonl(f)
        except Exception:
            continue
        name = conv.title
        if not name:
            continue
        sessions.append(
            SessionInfo(
                id=sid,
                name=name,
                summary=conv.description,
                last_user_message=conv.last_user_message,
                last_assistant_message=conv.last_assistant_message,
                updated_at=conv.updated_at,
                message_count=conv.message_count,
            )
        )
    return sessions


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


@app.post("/api/converse")
async def converse(body: ConverseRequest) -> StreamingResponse:
    log.info("converse: %s", body.instruction[:120])

    async def stream():  # noqa: ANN202
        buf = ""
        n_chunks = 0
        async for chunk in claude.converse(body.instruction):
            if isinstance(chunk, TextDelta):
                log.info("raw delta: %s", chunk.text[:120])
                buf += chunk.text
                while (idx := _sentence_break(buf)) >= 0:
                    sentence = buf[: idx + 1].strip()
                    buf = buf[idx + 1 :]
                    if sentence:
                        n_chunks += 1
                        log.info("chunk %d: %s", n_chunks, sentence[:80])
                        yield _sse({"text": sentence})
            else:
                if buf.strip():
                    n_chunks += 1
                    log.info("chunk %d (flush): %s", n_chunks, buf.strip()[:80])
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
