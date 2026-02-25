"""CLI entry point for reduck."""

import argparse
import os
import sys
from dataclasses import dataclass
from typing import cast


@dataclass
class Args:
    port: int
    host: str
    no_browser: bool


def parse_args() -> Args:
    parser = argparse.ArgumentParser(
        description="reduck - voice interface for Claude Code"
    )
    _ = parser.add_argument("--port", type=int, default=8000)
    _ = parser.add_argument("--host", default="127.0.0.1")
    _ = parser.add_argument("--no-browser", action="store_true")
    ns = parser.parse_args()
    return Args(
        port=cast(int, ns.port),
        host=cast(str, ns.host),
        no_browser=cast(bool, ns.no_browser),
    )


def main() -> None:
    args = parse_args()

    # Load .env if present
    try:
        from dotenv import load_dotenv

        _ = load_dotenv()
    except ImportError:
        pass

    # Check prerequisites
    if not os.environ.get("ANTHROPIC_API_KEY"):
        print("Error: Set ANTHROPIC_API_KEY to use Claude Code", file=sys.stderr)
        sys.exit(1)

    import shutil

    cli_path = os.environ.get("CLAUDE_CLI_PATH")
    if cli_path:
        cli_path = os.path.expanduser(cli_path)
    if cli_path and not os.path.isfile(cli_path):
        print(f"Error: CLAUDE_CLI_PATH not found: {cli_path}", file=sys.stderr)
        sys.exit(1)
    elif not cli_path and not shutil.which("claude"):
        print(
            "Error: Claude Code CLI not found on PATH. Install it first.",
            file=sys.stderr,
        )
        sys.exit(1)

    if not args.no_browser:
        import threading
        import webbrowser

        url = f"http://{args.host}:{args.port}"
        _ = threading.Timer(1.5, lambda: webbrowser.open(url))
        _.start()

    import uvicorn

    uvicorn.run("reduck.server:app", host=args.host, port=args.port)


if __name__ == "__main__":
    main()
