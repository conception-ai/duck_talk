"""Streaming interface to Claude Code via Agent SDK."""

import logging
import os
from collections.abc import AsyncIterator
from dataclasses import dataclass, replace
from typing import cast

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

# To run fully isolated (separate config/creds/sessions):
#   npm install @anthropic-ai/claude-code --prefix ~/.claude-sdk/cli
#   CLAUDECODE= CLAUDE_CONFIG_DIR=~/.claude-sdk ~/.claude-sdk/cli/node_modules/.bin/claude login
# Then pass cli_path and env={"CLAUDE_CONFIG_DIR": ...} to ClaudeAgentOptions.


@dataclass
class TextDelta:
    text: str


@dataclass
class Result:
    session_id: str
    cost_usd: float | None
    duration_ms: int


type Chunk = TextDelta | Result


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

    def __init__(
        self,
        model: str = "haiku",
        cwd: str | None = None,
        system_prompt: str | None = None,
    ):
        self._options = ClaudeAgentOptions(
            model=model,
            cwd=cwd or os.getcwd(),
            system_prompt=system_prompt or "",
            include_partial_messages=True,
            permission_mode="acceptEdits",
            stderr=lambda line: log.debug("sdk: %s", line.rstrip()),
        )

    async def converse(
        self, message: str, session_id: str | None = None
    ) -> AsyncIterator[Chunk]:
        options = self._options
        if session_id:
            options = replace(self._options, resume=session_id)
            log.info("resuming session %s", session_id)

        log.info("query: %s", message[:120])
        async for msg in query(prompt=message, options=options):
            if isinstance(msg, StreamEvent):
                delta = cast(dict[str, str], msg.event.get("delta", {}))
                if text := delta.get("text"):
                    yield TextDelta(text=text)
            elif isinstance(msg, ResultMessage):
                log.info(
                    "result: session=%s, cost=$%s, %dms",
                    msg.session_id,
                    msg.total_cost_usd,
                    msg.duration_ms,
                )
                yield Result(
                    session_id=msg.session_id,
                    cost_usd=msg.total_cost_usd,
                    duration_ms=msg.duration_ms,
                )
