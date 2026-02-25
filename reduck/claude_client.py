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

from reduck.models import path_to_slug

type PermissionMode = Literal["default", "acceptEdits", "plan", "bypassPermissions"]

log = logging.getLogger("claude")

# Prevent nested session error when running inside Claude Code
_ = os.environ.pop("CLAUDECODE", None)


# ── Config ──────────────────────────────────────────────────────────────────


@dataclass(frozen=True)
class ClaudeConfig:
    """Claude Code environment config.

    Two fields, one method. Built from env vars at server startup.

    Config loading order (later wins):
      1. Defaults (~/.claude, claude on PATH)
      2. .env file in cwd (loaded via python-dotenv)
      3. Actual env vars (override .env)
    """

    config_dir: str = "~/.claude"
    cli_path: str | None = None  # None = `claude` on PATH

    def subprocess_env(self) -> dict[str, str]:
        """Build env dict for the SDK subprocess."""
        env = {k: v for k, v in os.environ.items() if k != "CLAUDECODE"}
        expanded = os.path.expanduser(self.config_dir)
        if self.config_dir != "~/.claude":
            env["CLAUDE_CONFIG_DIR"] = expanded
        return env

    def project_dir(self, cwd: str) -> Path:
        """Session directory for a given project cwd."""
        return (
            Path(os.path.expanduser(self.config_dir)) / "projects" / path_to_slug(cwd)
        )


# ── Chunk types ─────────────────────────────────────────────────────────────


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


# ── Client ──────────────────────────────────────────────────────────────────


class Claude:
    """Streaming Claude Code interface.

    Stateless — holds config only. cwd is per-call (different sessions
    can target different projects).
    """

    _config: ClaudeConfig
    _stderr: Callable[[str], None]

    def __init__(self, config: ClaudeConfig):
        self._config = config
        self._stderr = lambda line: log.debug("sdk: %s", line.rstrip())

    async def converse(
        self,
        message: str,
        model: str,
        system_prompt: str,
        cwd: str,
        session_id: str | None = None,
        permission_mode: PermissionMode = "plan",
        fork: bool = False,
    ) -> AsyncIterator[Chunk]:
        options = ClaudeAgentOptions(
            model=model,
            cwd=cwd,
            system_prompt=system_prompt,
            include_partial_messages=True,
            permission_mode=permission_mode,
            allowed_tools=["Read", "WebSearch"],
            disallowed_tools=["AskUserQuestion", "Skill"],
            env=self._config.subprocess_env(),
            stderr=self._stderr,
        )
        if self._config.cli_path:
            options = replace(
                options, cli_path=os.path.expanduser(self._config.cli_path)
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
