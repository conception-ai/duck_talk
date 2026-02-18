"""Streaming interface to Claude Code via Agent SDK."""

import logging
import os
import tempfile
from collections.abc import AsyncIterator
from dataclasses import dataclass, replace
from pathlib import Path
from typing import Union, cast

from claude_agent_sdk import (
    ClaudeAgentOptions,
    ResultMessage,
    query,
)
from claude_agent_sdk.types import StreamEvent

log = logging.getLogger("claude")

# The SDK subprocess inherits os.environ and checks CLAUDECODE.
# Pop it from the process so the child won't see it.
_ = os.environ.pop("CLAUDECODE", None)

# Fully isolated Claude Code installation for the SDK subprocess.
# Setup once:
#   npm install @anthropic-ai/claude-code --prefix ~/.claude-sdk/cli
#   CLAUDECODE= CLAUDE_CONFIG_DIR=~/.claude-sdk ~/.claude-sdk/cli/node_modules/.bin/claude login
_SDK_HOME = Path.home() / ".claude-sdk"
_SDK_CLI_PATH = _SDK_HOME / "cli/node_modules/.bin/claude"
_SDK_CONFIG_DIR = str(_SDK_HOME)


@dataclass
class TextDelta:
    text: str


@dataclass
class Result:
    cost_usd: float | None
    duration_ms: int


Chunk = Union[TextDelta, Result]


class Claude:
    """Streaming Claude Code interface with persistent conversation.

    Uses standalone query() with `resume` to maintain conversation across
    calls. Each call spawns a fresh subprocess but resumes the same session.

    Usage:
        claude = Claude()
        async for chunk in claude.converse("fix the bug"):
            if isinstance(chunk, TextDelta):
                print(chunk.text, end="")
        # Follow-up — Claude remembers context:
        async for chunk in claude.converse("what did you just do?"):
            ...
    """

    _options: ClaudeAgentOptions
    _session_id: str | None

    def __init__(self, model: str = "haiku", cwd: str | None = None):
        self._options = ClaudeAgentOptions(
            model=model,
            cwd=cwd or tempfile.mkdtemp(prefix="claude_api_"),
            include_partial_messages=True,
            permission_mode="acceptEdits",
            cli_path=_SDK_CLI_PATH,
            env={"CLAUDE_CONFIG_DIR": _SDK_CONFIG_DIR},
            stderr=lambda line: log.debug("sdk: %s", line.rstrip()),
        )
        self._session_id = None

    async def converse(self, message: str) -> AsyncIterator[Chunk]:
        options = self._options
        if self._session_id:
            options = replace(self._options, resume=self._session_id)
            log.info("resuming session %s", self._session_id)

        log.info("query: %s", message[:120])
        async for msg in query(prompt=message, options=options):
            if isinstance(msg, StreamEvent):
                delta = cast(dict[str, str], msg.event.get("delta", {}))
                if text := delta.get("text"):
                    yield TextDelta(text=text)
            elif isinstance(msg, ResultMessage):
                self._session_id = msg.session_id
                log.info(
                    "result: session=%s, cost=$%s, %dms",
                    msg.session_id,
                    msg.total_cost_usd,
                    msg.duration_ms,
                )
                yield Result(
                    cost_usd=msg.total_cost_usd,
                    duration_ms=msg.duration_ms,
                )
        log.info("response complete")
