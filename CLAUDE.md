# vmExit

## What This Is

A browser-based computing environment where a persistent Claude agent builds and modifies applications from natural language. The user interacts through a quake-style console overlay (backtick to toggle). Apps run full-screen, one at a time, selected via a header dropdown.

## Architecture

Two files do everything:

- **server.js** — Node server (Express + WebSocket). Hosts the static frontend, manages the Claude Agent SDK session, defines MCP tools, bridges tool calls to the browser via WebSocket.
- **public/app.js** — Browser runtime. Manages the state tree, compiles and renders apps, handles event delegation, manages persistence, and executes tool calls from the server.

### State Tree

All UI derives from a single state object:

```
{ activeApp: "app_123", apps: { app_123: { name, data, render, styles, handlers, setup } }, lib: {} }
```

- `render`, `handlers`, `setup`, and `lib` entries are **function strings** (arrow functions stored as strings so they serialize to JSON)
- The runtime compiles them via `new Function('return ' + str)()` with a `Map<string, Function>` cache

### Agent Session

The Claude session starts on WebSocket connect and stays alive via a blocking `wait_for_input` MCP tool. The loop is:

```
send_message → wait_for_input → (user input arrives) → do work → send_message → wait_for_input → ...
```

**Why `send_message` exists:** The SDK doesn't yield messages from `query()`'s async iterator while tools are executing. Since `wait_for_input` blocks indefinitely, text blocks in the same turn are never delivered. `send_message` bypasses this by sending directly via WebSocket from inside the tool handler.

**Why session auto-restarts:** If the model produces a `result` instead of calling `wait_for_input`, the session ends. The `finally` block detects the WS is still open and restarts after 500ms.

**MCP server per session:** A fresh `createSdkMcpServer()` instance is created for each `startSession()` call because the SDK throws "Already connected to a transport" if you reuse one.

### Tool Bridge

Tools execute in the browser, not on the server:

1. Server sends `{type: "exec", id, tool, args}` over WebSocket
2. Browser executes (e.g., reads/writes state tree)
3. Browser returns `{type: "exec_result", id, result, error}`
4. Server resolves the pending Promise

30-second timeout per call. Pending execs tracked by UUID in a `Map`.

### Render Loop

On any state change:

1. Cleanup previous setup (call stored cleanup function)
2. Get/create app container div (`[data-app="appId"]`)
3. Inject/update `<style>` element
4. Compile render function, call with `(data, compiledLib)`, set `container.innerHTML`
5. Save/restore focus across the innerHTML replacement
6. Compile and run setup function

### Event System

- **Declarative:** Single click listener on `#desktop` catches `[data-action]` elements. Walks up to `[data-app]` to find the app. Extra `data-*` attributes become the payload.
- **Imperative:** `setup` function for drag, canvas, timers, fetch. Returns a cleanup function.
- **Input binding:** `data-field="path"` on inputs/textareas auto-syncs DOM values to `app.data` before handlers run via `captureInputs()`.

### Error Recovery

Runtime catches errors in compile, render, setup, and handlers. Sends `[ERROR app=id phase=render] message\nstack` to the agent session. Errors deduped within 5 seconds (same app + phase + message). The agent reads the broken function via `get_state`, patches via `set_state`.

### Persistence

- Debounced 2-second auto-save via POST to `/api/state`
- `navigator.sendBeacon` on `beforeunload` for tab close
- Server-initiated changes (`set_state` from agent) persist immediately
- On page load, state restored from `/api/state` before WebSocket connects

## MCP Tools

| Tool | Purpose |
|------|---------|
| `get_state(path?)` | Read state tree or subtree |
| `set_state(path, value)` | Set value at path, triggers re-render |
| `delete_state(path)` | Remove key, cleanup app if needed |
| `send_message(text)` | Send text to user console |
| `reply_to_app(id, text)` | Reply to `vmExitOS.ask()` call |
| `wait_for_input()` | Block until next user message |

## Browser API (`window.vmExitOS`)

| Method | Purpose |
|--------|---------|
| `ask(prompt, timeout?)` | Call the agent, returns `Promise<string>` |
| `dispatch(appId, action, payload)` | Trigger a handler |
| `read(path)` | Read state at path |
| `subscribe(path, callback)` | Watch state changes |
| `emit(name, data)` | Send event to agent |
| `toast(message, type, duration)` | Show notification |

## WebSocket Message Types

**Client → Server:**
- `message` — user typed in console (prefixed with `[ACTIVE_APP ...]`)
- `event` — app event via `vmExitOS.emit()`
- `llm_call` — app LLM call via `vmExitOS.ask()`
- `error_report` — runtime error for agent to fix
- `exec_result` — tool execution result

**Server → Client:**
- `exec` — execute a tool
- `text` — agent message (via `send_message` tool)
- `result` — session final result
- `status` — `thinking` / `idle`
- `progress` — tool call activity update
- `error` — error message
- `llm_result` — response to `vmExitOS.ask()`

## Running

```
npm install
npm start
```

Opens on `http://localhost:3000`. Press backtick to open console.

## Environment Variables

- `PORT` — server port (default: 3000)

## Known Issues

- The SDK's `unhandledRejection` for `ProcessTransport` errors is suppressed at process level — these fire when sessions end while MCP cleanup is pending
- `set_state` value parameter: if the value isn't valid JSON, it's used as a raw string (handles CSS and function strings that Claude doesn't always JSON-encode)
- Focus restore doesn't restore `el.value` — this is intentional to prevent cross-context value bleed (e.g., switching notes). The render function provides the correct value from state.
