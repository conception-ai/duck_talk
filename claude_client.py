"""Streaming interface to Claude Code via Agent SDK."""

import logging
import os
from collections.abc import AsyncIterator, Callable
from dataclasses import dataclass, replace
from typing import Literal, cast

from claude_agent_sdk import (
    AssistantMessage,
    ClaudeAgentOptions,
    ResultMessage,
    ToolResultBlock,
    ToolUseBlock,
    UserMessage,
    query,
)
from claude_agent_sdk.types import StreamEvent

type PermissionMode = Literal["default", "acceptEdits", "plan", "bypassPermissions"]

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
class ContentBlockChunk:
    block: dict[str, object]


@dataclass
class Result:
    session_id: str
    cost_usd: float | None
    duration_ms: int
    error: str | None = None


type Chunk = TextDelta | ContentBlockChunk | Result


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

    _cwd: str
    _stderr: Callable[[str], None]

    def __init__(self, cwd: str | None = None):
        self._cwd = cwd or os.getcwd()
        self._stderr = lambda line: log.debug("sdk: %s", line.rstrip())

    async def converse(
        self,
        message: str,
        model: str,
        system_prompt: str,
        session_id: str | None = None,
        permission_mode: PermissionMode = "plan",
    ) -> AsyncIterator[Chunk]:
        options = ClaudeAgentOptions(
            model=model,
            cwd=self._cwd,
            system_prompt=system_prompt,
            include_partial_messages=True,
            permission_mode=permission_mode,
            allowed_tools=["Read", "WebSearch"],
            disallowed_tools=["AskUserQuestion", "Skill"],
            stderr=self._stderr,
        )
        if session_id:
            options = replace(options, resume=session_id)
            log.info("resuming session %s", session_id)

        log.info("query: %s", message[:120])
        async for msg in query(prompt=message, options=options):
            if isinstance(msg, StreamEvent):
                delta = cast(dict[str, str], msg.event.get("delta", {}))
                if text := delta.get("text"):
                    yield TextDelta(text=text)
            elif isinstance(msg, AssistantMessage):
                for block in msg.content:
                    if isinstance(block, ToolUseBlock):
                        yield ContentBlockChunk(
                            block={
                                "type": "tool_use",
                                "id": block.id,
                                "name": block.name,
                                "input": block.input,
                            }
                        )
            elif isinstance(msg, UserMessage):
                for block in msg.content if isinstance(msg.content, list) else []:
                    if isinstance(block, ToolResultBlock):
                        raw = block.content
                        yield ContentBlockChunk(
                            block={
                                "type": "tool_result",
                                "tool_use_id": block.tool_use_id,
                                "content": raw
                                if isinstance(raw, str)
                                else str(raw)
                                if raw
                                else "",
                            }
                        )
            elif isinstance(msg, ResultMessage):
                error = msg.result if msg.is_error else None
                log.info(
                    "result: session=%s, cost=$%s, %dms, error=%s",
                    msg.session_id,
                    msg.total_cost_usd,
                    msg.duration_ms,
                    error,
                )
                yield Result(
                    session_id=msg.session_id,
                    cost_usd=msg.total_cost_usd,
                    duration_ms=msg.duration_ms,
                    error=error,
                )
