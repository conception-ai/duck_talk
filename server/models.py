"""
Claude Code session file models.

Claude Code stores conversations as JSONL files in ~/.claude/projects/-{cwd}/{session-id}.jsonl
These files can be created programmatically to "inject" conversation history, then resumed.

Key insights:
- Sessions use a TREE structure via parentUuid (not a flat list)
- Each message must have a DISTINCT timestamp (30s+ apart) or Claude may branch incorrectly
- No validation/signatures - Claude Code trusts any well-formed JSONL file

Usage:
    from claude_session import Session

    session = Session.from_messages([
        {"role": "user", "content": "Hello"},
        {"role": "assistant", "content": "Hi there!"},
    ], cwd="/path/to/project")
    session.save()
    # CLI: claude -r <session.session_id>
    # SDK: query(prompt, options={"resume": session.session_id})
"""

from __future__ import annotations

import json
import uuid
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from collections.abc import Iterable
from typing import Any, ClassVar, Literal, TypedDict, cast

from pydantic import BaseModel, ConfigDict, Field, PrivateAttr, TypeAdapter


# --- Slug helpers ---


def path_to_slug(path: str) -> str:
    """Convert absolute path to Claude's project slug.

    Matches the CLI's sanitization: everything except [a-zA-Z0-9-] becomes a hyphen.
    /Users/foo/my_project → -Users-foo-my-project
    """
    import os
    import re

    return re.sub(r"[^a-zA-Z0-9-]", "-", os.path.abspath(path))


def slug_to_path(slug: str) -> str:
    """Best-effort reverse of path_to_slug. Display-only — lossy for paths with hyphens."""
    # Double-hyphen (--) came from /. (dot-dir like .claude), restore as /.
    result = "/" + slug.lstrip("-").replace("--", "/.")
    return result.replace("-", "/")


# JSON data (use Any since pydantic can't handle recursive types)
type JsonDict = dict[str, Any]  # pyright: ignore[reportExplicitAny]


class MessageDict(TypedDict, total=False):
    role: str
    content: str | list[JsonDict]


# --- Content Blocks ---


class TextContent(BaseModel):
    type: Literal["text"] = "text"
    text: str


class ThinkingContent(BaseModel):
    type: Literal["thinking"] = "thinking"
    thinking: str
    signature: str | None = None


class ToolUseContent(BaseModel):
    type: Literal["tool_use"] = "tool_use"
    id: str
    name: str
    input: JsonDict = Field(default_factory=dict)


class ToolResultContent(BaseModel):
    type: Literal["tool_result"] = "tool_result"
    tool_use_id: str
    content: str | list[JsonDict] = ""


class ImageSource(BaseModel):
    type: Literal["base64"] = "base64"
    media_type: str
    data: str


class ImageContent(BaseModel):
    type: Literal["image"] = "image"
    source: ImageSource


ContentBlock = (
    TextContent | ThinkingContent | ToolUseContent | ToolResultContent | ImageContent
)


# --- Usage Stats ---


class CacheCreation(BaseModel):
    ephemeral_5m_input_tokens: int = 0
    ephemeral_1h_input_tokens: int = 0


class ServerToolUse(BaseModel):
    web_search_requests: int = 0
    web_fetch_requests: int = 0


class Usage(BaseModel):
    input_tokens: int = 0
    output_tokens: int = 0
    cache_creation_input_tokens: int = 0
    cache_read_input_tokens: int = 0
    cache_creation: CacheCreation = Field(default_factory=CacheCreation)
    server_tool_use: ServerToolUse | None = None
    service_tier: str | None = None


# --- Message Payloads ---


class UserMessagePayload(BaseModel):
    role: Literal["user"] = "user"
    content: str | list[JsonDict]  # String or list of content blocks


class AssistantMessagePayload(BaseModel):
    id: str = Field(default_factory=lambda: f"msg_{uuid.uuid4().hex[:24]}")
    model: str = "claude-sonnet-4-5-20250514"
    role: Literal["assistant"] = "assistant"
    type: Literal["message"] = "message"
    content: list[ContentBlock]
    stop_reason: str | None = "end_turn"
    stop_sequence: str | None = None
    usage: Usage = Field(default_factory=Usage)


# --- Session Entry Types ---


def _make_timestamp(offset_seconds: int = 0) -> str:
    """Generate ISO timestamp with optional offset."""
    ts = datetime.now(timezone.utc) + timedelta(seconds=offset_seconds)
    return ts.isoformat(timespec="milliseconds").replace("+00:00", "Z")


class BaseSessionEntry(BaseModel):
    """Base class for all session entries."""

    timestamp: str = Field(
        default_factory=lambda: datetime.now(timezone.utc)
        .isoformat(timespec="milliseconds")
        .replace("+00:00", "Z")
    )

    def to_jsonl_line(self) -> str:
        return self.model_dump_json(exclude_none=True)


class QueueOperation(BaseSessionEntry):
    """Queue operation entry (appears at session start/resume)."""

    type: Literal["queue-operation"] = "queue-operation"
    operation: str = "dequeue"
    sessionId: str
    content: str | None = None


class UserEntry(BaseSessionEntry):
    """User message entry. parentUuid links to previous message (None for first)."""

    model_config: ClassVar[ConfigDict] = ConfigDict(extra="allow")

    type: Literal["user"] = "user"
    uuid: str = Field(default_factory=lambda: str(uuid.uuid4()))
    parentUuid: str | None = None  # None for first message, else previous msg's uuid
    sessionId: str
    message: UserMessagePayload
    cwd: str = "."
    isSidechain: bool = False
    userType: Literal["external", "internal"] = "external"
    version: str = "2.1.5"
    gitBranch: str | None = "main"
    # Optional fields from real sessions
    slug: str | None = None
    isMeta: bool | None = None
    thinkingMetadata: JsonDict | None = None
    todos: list[Any] | None = None  # pyright: ignore[reportExplicitAny]
    permissionMode: str | None = None
    toolUseResult: JsonDict | str | list[object] | None = None
    sourceToolAssistantUUID: str | None = None
    imagePasteIds: list[object] | None = None


class AssistantEntry(BaseSessionEntry):
    """Assistant message entry. parentUuid links to the user message it responds to."""

    model_config: ClassVar[ConfigDict] = ConfigDict(extra="allow")

    type: Literal["assistant"] = "assistant"
    uuid: str = Field(default_factory=lambda: str(uuid.uuid4()))
    parentUuid: str  # Required: uuid of the message this responds to
    sessionId: str
    message: AssistantMessagePayload
    cwd: str = "."
    isSidechain: bool = False
    userType: Literal["external", "internal"] = "external"
    version: str = "2.1.5"
    gitBranch: str | None = "main"
    requestId: str | None = None
    slug: str | None = None
    isApiErrorMessage: bool | None = None


class ProgressEntry(BaseSessionEntry):
    """Progress update entry (hook execution updates)."""

    model_config: ClassVar[ConfigDict] = ConfigDict(extra="allow")

    type: Literal["progress"] = "progress"
    uuid: str = Field(default_factory=lambda: str(uuid.uuid4()))
    parentUuid: str | None = None
    sessionId: str
    data: JsonDict = Field(default_factory=dict)
    toolUseID: str | None = None
    parentToolUseID: str | None = None
    cwd: str = "."
    gitBranch: str | None = None
    version: str = "2.1.5"
    userType: str = "external"
    isSidechain: bool = False
    slug: str | None = None


class SystemEntry(BaseSessionEntry):
    """System notification entry (stop hooks, turn duration, compaction boundaries)."""

    model_config: ClassVar[ConfigDict] = ConfigDict(extra="allow")

    type: Literal["system"] = "system"
    uuid: str = Field(default_factory=lambda: str(uuid.uuid4()))
    parentUuid: str | None = None
    sessionId: str | None = None
    subtype: str | None = None
    level: str | None = None
    cwd: str = "."
    gitBranch: str | None = None
    version: str = "2.1.5"
    userType: str = "external"
    isSidechain: bool = False
    slug: str | None = None
    stopReason: str | None = None
    toolUseID: str | None = None
    hasOutput: bool | None = None
    hookCount: int | None = None
    hookErrors: list[object] | None = None
    hookInfos: list[object] | None = None
    preventedContinuation: bool | None = None
    content: str | None = None
    durationMs: int | None = None
    isMeta: bool | None = None
    logicalParentUuid: str | None = None
    compactMetadata: JsonDict | None = None
    microcompactMetadata: JsonDict | None = None


class FileHistorySnapshot(BaseSessionEntry):
    """File history snapshot entry."""

    model_config: ClassVar[ConfigDict] = ConfigDict(extra="allow")

    type: Literal["file-history-snapshot"] = "file-history-snapshot"
    messageId: str
    snapshot: JsonDict = Field(default_factory=dict)
    isSnapshotUpdate: bool = False


class SummaryEntry(BaseSessionEntry):
    """Conversation summary entry."""

    model_config: ClassVar[ConfigDict] = ConfigDict(extra="allow")

    type: Literal["summary"] = "summary"
    uuid: str = Field(default_factory=lambda: str(uuid.uuid4()))
    summary: str = ""
    leafUuid: str | None = None
    leafUuids: list[str] = Field(default_factory=list)


class CustomTitleEntry(BaseSessionEntry):
    """Custom session title entry."""

    model_config: ClassVar[ConfigDict] = ConfigDict(extra="allow")

    type: Literal["custom-title"] = "custom-title"
    customTitle: str = ""
    sessionId: str | None = None


class PrLinkEntry(BaseSessionEntry):
    """Links a session to a GitHub PR."""

    model_config: ClassVar[ConfigDict] = ConfigDict(extra="allow")

    type: Literal["pr-link"] = "pr-link"
    sessionId: str
    prNumber: int
    prUrl: str
    prRepository: str


SessionEntry = (
    QueueOperation
    | UserEntry
    | AssistantEntry
    | ProgressEntry
    | SystemEntry
    | FileHistorySnapshot
    | SummaryEntry
    | CustomTitleEntry
    | PrLinkEntry
)

# Entries that participate in the UUID tree (have both uuid and parentUuid)
TreeEntry = UserEntry | AssistantEntry | ProgressEntry | SystemEntry


# --- Tree Index ---


@dataclass(frozen=True)
class _TreeIndex:
    """Lazy-built index for tree navigation."""

    by_uuid: dict[str, list[TreeEntry]]
    parent_refs: frozenset[str]

    @staticmethod
    def build(records: list[SessionEntry]) -> _TreeIndex:
        by_uuid: dict[str, list[TreeEntry]] = {}
        parent_refs: set[str] = set()
        for r in records:
            if not isinstance(
                r, (UserEntry, AssistantEntry, ProgressEntry, SystemEntry)
            ):
                continue
            by_uuid.setdefault(r.uuid, []).append(r)
            if r.parentUuid:
                parent_refs.add(r.parentUuid)
        return _TreeIndex(by_uuid=by_uuid, parent_refs=frozenset(parent_refs))


def preview(entry: TreeEntry, limit: int = 100) -> str:
    """One-line human-readable summary of a tree entry."""
    uid = entry.uuid[:8]
    etype = entry.type

    if not isinstance(entry, (UserEntry, AssistantEntry)):
        extra = ""
        if isinstance(entry, SystemEntry) and entry.subtype:
            extra = entry.subtype
        return f"{etype:10s} {uid}  {extra}"

    content = entry.message.content
    if isinstance(content, str):
        text = content.strip().replace("\n", " ")[:limit]
    else:
        parts: list[str] = []
        for b in content:
            # AssistantEntry: content blocks are pydantic models
            if isinstance(b, TextContent):
                parts.append(b.text.replace("\n", " ")[:60])
            elif isinstance(b, ThinkingContent):
                parts.append("[think]")
            elif isinstance(b, ToolUseContent):
                parts.append(f"[tool:{b.name}]")
            elif isinstance(b, ToolResultContent):
                parts.append("[result]")
            # UserEntry: content blocks are raw dicts (tool_result payloads)
            elif isinstance(b, dict):
                btype = cast(str, b.get("type", ""))
                if btype == "tool_result":
                    parts.append("[result]")
                elif btype == "text":
                    parts.append(cast(str, b.get("text", "")).replace("\n", " ")[:60])
                else:
                    parts.append(f"[{btype or 'dict'}]")
            else:
                parts.append(f"[{type(b).__name__}]")
        text = " | ".join(parts)[:limit]
    return f"{etype:10s} {uid}  {text}"


# --- High-Level Session ---


class Session(BaseModel):
    """
    Claude Code session. Chain: queue-op -> user -> assistant -> user -> assistant -> ...
    Each message's parentUuid points to the previous message's uuid.
    """

    session_id: str = Field(default_factory=lambda: str(uuid.uuid4()))
    cwd: str = "."
    git_branch: str | None = "main"
    version: str = "2.1.5"
    entries: list[SessionEntry] = Field(default_factory=list)

    @classmethod
    def from_messages(
        cls,
        messages: list[MessageDict],
        session_id: str | None = None,
        cwd: str = ".",
        git_branch: str | None = "main",
    ) -> Session:
        """
        Create a Session from an Anthropic API-style messages array.

        Args:
            messages: List of {"role": "user"|"assistant", "content": "..."} dicts
            session_id: Optional session ID (generates UUID if not provided)
            cwd: Working directory
            git_branch: Git branch name

        Returns:
            Session object ready to be saved
        """
        sid = session_id or str(uuid.uuid4())
        session = cls(session_id=sid, cwd=cwd, git_branch=git_branch)

        # Add queue operation
        session.entries.append(
            QueueOperation(sessionId=sid, timestamp=_make_timestamp(0))
        )

        parent_uuid: str | None = None

        for i, msg in enumerate(messages):
            role = msg.get("role", "")
            content = msg.get("content", "")
            # Each message gets a distinct timestamp (30s apart)
            ts = _make_timestamp((i + 1) * 30)

            if role == "user":
                user_content = content if isinstance(content, str) else ""
                user_entry = UserEntry(
                    sessionId=sid,
                    parentUuid=parent_uuid,
                    message=UserMessagePayload(content=user_content),
                    cwd=cwd,
                    gitBranch=git_branch,
                    timestamp=ts,
                )
                session.entries.append(user_entry)
                parent_uuid = user_entry.uuid

            elif role == "assistant":
                # Handle string content or list of content blocks
                content_blocks: list[ContentBlock] = []
                if isinstance(content, str):
                    content_blocks = [TextContent(text=content)]
                else:
                    for block in content:
                        block_type: object = block.get("type")
                        if block_type == "text":
                            text_val = cast(object, block.get("text", ""))
                            if isinstance(text_val, str):
                                content_blocks.append(TextContent(text=text_val))
                        elif block_type == "thinking":
                            thinking_val = cast(object, block.get("thinking", ""))
                            if isinstance(thinking_val, str):
                                content_blocks.append(
                                    ThinkingContent(thinking=thinking_val)
                                )

                asst_entry = AssistantEntry(
                    sessionId=sid,
                    parentUuid=parent_uuid or "",
                    message=AssistantMessagePayload(content=content_blocks),
                    cwd=cwd,
                    gitBranch=git_branch,
                    timestamp=ts,
                )
                session.entries.append(asst_entry)
                parent_uuid = asst_entry.uuid

        return session

    def to_jsonl(self) -> str:
        """Convert session to JSONL string."""
        lines = [entry.to_jsonl_line() for entry in self.entries]
        return "\n".join(lines) + "\n"

    def save(self, base_path: str | None = None) -> str:
        """
        Save session to Claude Code sessions directory.

        Args:
            base_path: Override the default path. If None, uses ~/.claude/projects/...
                       based on cwd.

        Returns:
            Path to the saved file
        """
        import os

        if base_path is None:
            slug = path_to_slug(self.cwd)
            base_path = f"~/.claude/projects/{slug}"

        expanded_path = os.path.expanduser(base_path)
        os.makedirs(expanded_path, exist_ok=True)

        file_path = os.path.join(expanded_path, f"{self.session_id}.jsonl")
        with open(file_path, "w") as f:
            _ = f.write(self.to_jsonl())

        return file_path


def fork_session(original_path: str, leaf_uuid: str) -> str:
    """Create a new session JSONL forked at leaf_uuid. Returns new session_id.

    The CLI ignores SummaryEntry.leafUuid — it always resumes from the deepest
    leaf.  So the only way to "rewind" is to create a fresh JSONL containing
    only the path entries up to leaf_uuid.
    """
    import os

    conv = Conversation.from_jsonl(original_path)
    path_entries = conv.walk_path(leaf_uuid)
    if not path_entries:
        raise ValueError(f"UUID not found in tree: {leaf_uuid}")
    path_entries.reverse()  # walk_path returns leaf→root; we need root→leaf

    new_sid = str(uuid.uuid4())
    new_path = os.path.join(os.path.dirname(original_path), f"{new_sid}.jsonl")

    with open(new_path, "w") as f:
        qop = QueueOperation(sessionId=new_sid)
        _ = f.write(qop.to_jsonl_line() + "\n")
        for entry in path_entries:
            raw = cast(dict[str, object], json.loads(entry.to_jsonl_line()))
            raw["sessionId"] = new_sid
            _ = f.write(json.dumps(raw) + "\n")

    return new_sid


# --- Read-Only Conversation Loader ---


class Conversation(BaseModel):
    """Read-only container for loading and querying JSONL conversation files."""

    records: list[SessionEntry] = Field(default_factory=list)
    _tree_cache: _TreeIndex | None = PrivateAttr(default=None)

    @classmethod
    def from_jsonl(cls, path: str) -> Conversation:
        """Load a conversation from a JSONL file, skipping malformed lines."""
        adapter: TypeAdapter[SessionEntry] = TypeAdapter(SessionEntry)
        records: list[SessionEntry] = []
        with open(path) as f:
            for line in f:
                line = line.strip()
                if not line:
                    continue
                try:
                    data: object = cast(object, json.loads(line))
                except json.JSONDecodeError:
                    continue
                record: SessionEntry = adapter.validate_python(data)
                records.append(record)
        return cls(records=records)

    @property
    def user_entries(self) -> list[UserEntry]:
        return [r for r in self.records if isinstance(r, UserEntry)]

    @property
    def assistant_entries(self) -> list[AssistantEntry]:
        return [r for r in self.records if isinstance(r, AssistantEntry)]

    @property
    def progress_entries(self) -> list[ProgressEntry]:
        return [r for r in self.records if isinstance(r, ProgressEntry)]

    @property
    def system_entries(self) -> list[SystemEntry]:
        return [r for r in self.records if isinstance(r, SystemEntry)]

    @property
    def summaries(self) -> list[SummaryEntry]:
        return [r for r in self.records if isinstance(r, SummaryEntry)]

    @property
    def snapshots(self) -> list[FileHistorySnapshot]:
        return [r for r in self.records if isinstance(r, FileHistorySnapshot)]

    @property
    def title(self) -> str:
        """Human-readable title: custom title > first user question > empty."""
        for r in self.records:
            if isinstance(r, CustomTitleEntry) and r.customTitle:
                return r.customTitle
        text = self._first_user_text(self.user_entries)
        return text[:120] if text else ""

    @property
    def description(self) -> str:
        """First non-empty assistant text (skips thinking/tool_use blocks)."""
        return self._first_assistant_text(self.assistant_entries)

    @property
    def last_user_message(self) -> str:
        """Last meaningful user text."""
        return self._first_user_text(reversed(self.user_entries))

    @property
    def last_assistant_message(self) -> str:
        """Last meaningful assistant text."""
        return self._first_assistant_text(reversed(self.assistant_entries))

    @property
    def updated_at(self) -> str:
        """Timestamp of the last record."""
        return self.records[-1].timestamp if self.records else ""

    @property
    def message_count(self) -> int:
        """Number of user + assistant entries."""
        return len(self.user_entries) + len(self.assistant_entries)

    # ── Tree navigation ──

    @property
    def _tree(self) -> _TreeIndex:
        if self._tree_cache is None:
            self._tree_cache = _TreeIndex.build(self.records)
        return self._tree_cache

    @property
    def leaves(self) -> list[TreeEntry]:
        """Entries whose uuid is never referenced as another entry's parentUuid."""
        t = self._tree
        return [
            elist[-1] for uid, elist in t.by_uuid.items() if uid not in t.parent_refs
        ]

    @property
    def active_leaf(self) -> TreeEntry | None:
        """Tip of the active branch (deepest leaf in the tree)."""
        all_leaves = self.leaves
        if not all_leaves:
            return None
        return max(all_leaves, key=lambda e: len(self.walk_path(e.uuid)))

    def walk_path(self, leaf_uuid: str) -> list[TreeEntry]:
        """Walk parentUuid chain from leaf to root. Returns [leaf, ..., root]."""
        t = self._tree
        path: list[TreeEntry] = []
        seen: set[str] = set()
        uid: str | None = leaf_uuid
        while uid and uid not in seen:
            seen.add(uid)
            elist = t.by_uuid.get(uid)
            if not elist:
                break
            entry = elist[-1]  # last occurrence handles retried dupes
            path.append(entry)
            uid = entry.parentUuid
        return path

    # ── Private helpers ──

    @staticmethod
    def _first_user_text(entries: Iterable[UserEntry]) -> str:
        for entry in entries:
            if isinstance(entry.message.content, str):
                text = entry.message.content.strip()
                if text:
                    return text[:200]
        return ""

    @staticmethod
    def _first_assistant_text(entries: Iterable[AssistantEntry]) -> str:
        for entry in entries:
            for block in entry.message.content:
                if isinstance(block, TextContent):
                    text = block.text.strip()
                    if text:
                        return text[:300]
        return ""
