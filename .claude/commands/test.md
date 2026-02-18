1. If not started
- 
    - Start both servers in background:
        - `source /Users/dhuynh95/.claude/venv/bin/activate && uvicorn api.server:app --port 8000`
        - `cd vibecoded_apps/claude_talks && npx vite --port 5173`
- Otherwise use currently run servers
2. Use Chrome MCP to navigate to `http://localhost:5173/#/live`
3. Take a snapshot to confirm the page loads (buttons: Start, Record, Replay, plus saved recordings)
4. Check console for errors (`list_console_messages`)
5. Run the **converse** scenario: click the `converse_closure_question` button (a saved recording that triggers the full converse pipeline via replay — Gemini → tool call → SSE → sendClientContent). Verify messages appear and no console errors.

- Saved recordings: `vibecoded_apps/claude_talks/public/recordings/` — `.json` files that can be replayed in the UI to test the full E2E pipeline without a mic