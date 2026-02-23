"""Streaming interface to Claude Code via Agent SDK."""

import logging
import os
from collections.abc import AsyncIterator, Callable
from dataclasses import dataclass, replace
from pathlib import Path
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

# ── SDK Isolation (DO NOT REMOVE) ─────────────────────────────────────────────
#
# The Claude Agent SDK spawns a `claude` subprocess. When THIS process is itself
# running inside Claude Code, three isolation layers prevent conflicts:
#
# 1. Pop CLAUDECODE env var — without this the child detects a "nested session"
#    and refuses to start.
#
# 2. cli_path → separate binary installed under ~/.claude-sdk/cli/ so the child
#    doesn't collide with the parent Claude Code instance.
#    One-time setup:
#      npm install @anthropic-ai/claude-code --prefix ~/.claude-sdk/cli
#
# 3. env with CLAUDE_CONFIG_DIR → separate config/creds/sessions directory.
#    One-time setup:
#      CLAUDECODE= CLAUDE_CONFIG_DIR=~/.claude-sdk \
#        ~/.claude-sdk/cli/node_modules/.bin/claude login
#
# 4. PATH must include /opt/homebrew/bin (or wherever `node` lives) because the
#    CLI shebang is #!/usr/bin/env node. The SDK's `env` parameter REPLACES the
#    subprocess environment, so without explicitly passing PATH, node is not found
#    (exit code 127). We merge os.environ + our overrides to preserve PATH.
#
# ──────────────────────────────────────────────────────────────────────────────

_ = os.environ.pop("CLAUDECODE", None)  # Layer 1: prevent nested session error

_SDK_DIR = os.path.expanduser("~/.claude-sdk")
_CLI_PATH = os.path.join(_SDK_DIR, "cli/node_modules/.bin/claude")  # Layer 2
_SDK_ENV = {  # Layers 3 + 4
    **os.environ,
    "CLAUDE_CONFIG_DIR": _SDK_DIR,
    "PATH": f"/opt/homebrew/bin:{os.environ.get('PATH', '')}",
}

# ── Project paths ────────────────────────────────────────────────────────────

_CWD = "/Users/dhuynh95/claude_talks"
_PROJECT_SLUG = "-Users-dhuynh95-claude-talks"


@dataclass(frozen=True)
class ClaudeConfig:
    """Paths for a Claude Code environment (CLI or SDK)."""

    config_dir: str
    cwd: str = _CWD

    @property
    def project_dir(self) -> Path:
        return Path(self.config_dir) / "projects" / _PROJECT_SLUG


REGULAR_CONFIG = ClaudeConfig(config_dir=os.path.expanduser("~/.claude"))
ISOLATED_CONFIG = ClaudeConfig(config_dir=_SDK_DIR)


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
        fork: bool = False,
    ) -> AsyncIterator[Chunk]:
        options = ClaudeAgentOptions(
            model=model,
            cwd=self._cwd,
            system_prompt=system_prompt,
            include_partial_messages=True,
            permission_mode=permission_mode,
            allowed_tools=["Read", "WebSearch"],
            disallowed_tools=["AskUserQuestion", "Skill"],
            cli_path=_CLI_PATH,
            env=_SDK_ENV,
            stderr=self._stderr,
        )
        if session_id:
            options = replace(options, resume=session_id, fork_session=fork)
            log.info("resuming session %s (fork=%s)", session_id, fork)

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
