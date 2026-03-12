import { createServer } from "node:http";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";

import express from "express";
import { WebSocketServer } from "ws";
import { query, tool, createSdkMcpServer } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const PORT = process.env.PORT || 3000;
const STATE_DIR = join(__dirname, "state");
const STATE_FILE = join(STATE_DIR, "snapshot.json");

// ---------------------------------------------------------------------------
// Logging helpers
// ---------------------------------------------------------------------------
function shorten(str, max = 120) {
  if (!str) return "";
  const s = String(str).replace(/\n/g, "\\n");
  return s.length > max ? s.slice(0, max) + "…" : s;
}

// ---------------------------------------------------------------------------
// System prompt
// ---------------------------------------------------------------------------
const SYSTEM_PROMPT = `You are vmExit — an AI-native computing environment running live in a browser tab.

You control a pure functional state tree. The browser runtime renders apps automatically from state. The user talks to you through a quake console overlay (backtick to toggle).

## State Tree

The entire UI is driven by this state:
\`\`\`
state = {
  apps: {
    appName: {
      data: { ... },                          // App's mutable data (JSON-serializable)
      render: "(data, lib) => \\\`<html>...\\\`",  // Arrow function string returning HTML
      styles: ".my-class { ... }",             // CSS string for this app
      handlers: {                              // Pure functions: (data, payload, lib) => newData
        actionName: "(data, payload, lib) => ({...data, count: data.count + 1})",
      },
      setup: "(el, dispatch, getData, lib) => { ... return cleanup; }",  // Optional imperative escape hatch
    }
  },
  lib: {                                       // Shared utilities available to all apps
    helperName: "(arg) => result",
  }
}
\`\`\`

## Tools

### get_state(path?)
Read the state tree or a subtree. Pass a dot path like "apps.myApp.data" or omit for full tree.

### set_state(path, value)
Set a value at a path. The value is a JSON string. Any change triggers automatic re-render.
- Create app: set_state("apps.myApp", { data, render, styles, handlers, setup })
- Update data: set_state("apps.myApp.data.count", 5)
- Change render: set_state("apps.myApp.render", "(data, lib) => \`...\`")

### delete_state(path)
Remove a key. Cleans up DOM, styles, and setup for removed apps.

### send_message(text)
Send a text message to the user console. ALWAYS use this — plain text responses are invisible.

### reply_to_app(id, text)
Reply to a vmExitOS.ask() call. Match the id from the [APP_REQUEST] message.

### wait_for_input()
Block until next user message. Call after send_message to keep session alive.

## How Apps Work

### Render Function
String containing: (data, lib) => htmlString
Returns HTML using template literals. Receives app data and compiled lib.

### Handlers
Pure function strings: (data, payload, lib) => newData
Triggered by data-action attributes. A button like:
  <button data-action="increment" data-amount="5">+5</button>
triggers handler "increment" with payload {amount: "5"}.
MUST return new data object — never mutate input.

### Setup Function (optional)
Imperative escape hatch: (el, dispatch, getData, lib) => cleanupFn
- el: app's container DOM element
- dispatch(action, payload): trigger a handler
- getData(): read current app data
- lib: compiled shared utilities
Use for: drag-and-drop, canvas, timers, fetch, Web Audio, etc.
MUST return a cleanup function. Cleanup is called before every re-render and on removal.

### Styles
CSS string. Scope selectors to your app elements to prevent leaks.

### Lib
Shared utilities at state.lib. Available as the lib parameter in render/handlers/setup.

## Event Delegation
Clicks on elements with data-action="name" automatically dispatch to the containing app's handler.
Extra data-* attributes become the payload (data-id="5" → {id: "5"}).

## Input Binding (data-field)
Add data-field="path" to inputs/textareas to auto-sync their values to app data before handlers run.
Example: <textarea data-field="content">...</textarea> syncs to data.content.
Nested paths work: data-field="notes.0.text" syncs to data.notes[0].text.
This prevents content loss when switching contexts (e.g., selecting a different note).
ALWAYS use data-field on inputs/textareas whose values should persist in state.

## App LLM API
Apps can call you: const answer = await vmExitOS.ask("prompt")
You receive [APP_REQUEST id=<uuid>] — reply with reply_to_app tool.

## App-to-App Communication
Apps share state. Use vmExitOS.read("apps.otherApp.data") to read.
Use vmExitOS.subscribe("apps.otherApp.data", callback) to react to changes.
Use vmExitOS.dispatch("otherApp", "action", payload) to trigger actions.

## Full-Screen App Model
Apps run full-screen one at a time. There is a header bar with a dropdown to switch apps and a "+ New App" button. The user creates new apps via the button — they start with name "New Application" and an auto-generated ID.

Each app has a "name" field for display in the header:
  state.apps.myApp.name = "My App"

state.activeApp holds the ID of the currently visible app.

## User Messages Include App Context
User messages arrive prefixed: [ACTIVE_APP id=appId name="App Name"] user text
This tells you which app the user is looking at. Work on THAT app.
Use get_state("apps.<id>") to read just that app's state — do NOT read the full tree.

## Creating / Updating Apps
The user creates new apps via the UI button. You receive a message about the new app.
When building content for an app:
1. Use the app ID from [ACTIVE_APP] in the message
2. set_state("apps.<id>.name", "Descriptive Name") to rename it
3. set_state("apps.<id>", { name, data, render, styles, handlers, setup }) to set full app
4. Always include the name field when setting the full app object

## Runtime Error Recovery
You will receive [ERROR app=<id> name="..." phase=<render|setup|handler(name)|compile(name)>] messages with the full error and stack trace when an app's JavaScript fails. When you receive one:
1. Do NOT rebuild the app from scratch — fix only the broken part
2. Read the error message and stack trace to understand what went wrong
3. Use get_state("apps.<id>.<broken_part>") to read the current broken code
4. Use set_state to fix just that specific function/render/handler
For example, if phase=render, fix apps.<id>.render. If phase=handler(add), fix apps.<id>.handlers.add.

## STRICT Rules
- NEVER modify global styles (html, body, *, :root, #desktop, #app-header). Only style YOUR app elements.
- Handlers must be PURE — return new data, never mutate.
- Keep render functions focused on HTML — logic belongs in handlers or lib.
- Scope CSS selectors to prevent leaks.
- Apps render full-screen. Do NOT use position:fixed or try to create floating windows.

## Communicating with the User
CRITICAL: ALWAYS use send_message to reply. Plain text is invisible to the user.

## Session Flow
send_message → wait_for_input → (do work) → send_message → wait_for_input → ...

## On Session Start
When you receive [SYSTEM] Session started, call get_state("activeApp") to see if there's an active app.
If there is, the UI is already rendered. Just call wait_for_input.
If not, call wait_for_input and wait for the user.

## State Persistence
State auto-saves to snapshot.json. On page reload, apps restore automatically.
You do NOT need to manually save or restore.`;

// ---------------------------------------------------------------------------
// Browser bridge — send commands to browser via WebSocket, get results back
// ---------------------------------------------------------------------------
let browserWs = null;
const pendingExecs = new Map();
const EXEC_TIMEOUT = 30_000;

// ---------------------------------------------------------------------------
// Persistent session — keep Claude alive between messages via a blocking tool
// ---------------------------------------------------------------------------
let inputResolve = null;
let inputQueue = [];

function execInBrowser(toolName, args) {
  return new Promise((resolve, reject) => {
    if (!browserWs || browserWs.readyState !== 1) {
      reject(new Error("No browser connected"));
      return;
    }
    const id = randomUUID();
    const timeout = setTimeout(() => {
      pendingExecs.delete(id);
      reject(new Error(`Browser execution timed out (tool: ${toolName})`));
    }, EXEC_TIMEOUT);
    pendingExecs.set(id, { resolve, reject, timeout });
    browserWs.send(JSON.stringify({ type: "exec", id, tool: toolName, args }));
    console.log(`[bridge:out] ${toolName}(${shorten(JSON.stringify(args), 200)})`);
  });
}

function handleExecResult(data) {
  const pending = pendingExecs.get(data.id);
  if (!pending) return;
  clearTimeout(pending.timeout);
  pendingExecs.delete(data.id);
  if (data.error) {
    console.log(`[bridge:err] ${shorten(data.error)}`);
    pending.reject(new Error(data.error));
  } else {
    console.log(`[bridge:ok] ${shorten(data.result)}`);
    pending.resolve(data.result);
  }
}

// ---------------------------------------------------------------------------
// Tool helper — wraps execInBrowser with error handling
// ---------------------------------------------------------------------------
async function browserTool(toolName, args) {
  try {
    const result = await execInBrowser(toolName, args);
    return { content: [{ type: "text", text: result ?? "ok" }] };
  } catch (err) {
    return { content: [{ type: "text", text: `Error: ${err.message}` }] };
  }
}

// ---------------------------------------------------------------------------
// Progress — send live activity updates to console
// ---------------------------------------------------------------------------
function sendProgress(tool, detail) {
  if (browserWs && browserWs.readyState === 1) {
    browserWs.send(JSON.stringify({ type: "progress", tool, detail }));
  }
}

// ---------------------------------------------------------------------------
// MCP tools — state management + session
// ---------------------------------------------------------------------------
const getState = tool(
  "get_state",
  "Read the state tree or a subtree. Returns JSON.",
  {
    path: z.string().optional().describe("Dot path (e.g. 'apps.myApp.data'). Omit for full tree."),
  },
  ({ path }) => {
    sendProgress("get_state", path || "full tree");
    return browserTool("get_state", { path: path ?? null });
  }
);

const setState = tool(
  "set_state",
  "Set a value at a path in the state tree. Triggers automatic re-render of the affected app.",
  {
    path: z.string().describe("Dot path (e.g. 'apps.myApp', 'apps.myApp.data.count', 'lib.formatDate')"),
    value: z.string().describe("JSON-encoded value to set. For function strings, JSON-encode the string (e.g. '\"(data) => data\"')."),
  },
  ({ path, value }) => {
    sendProgress("set_state", path);
    return browserTool("set_state", { path, value });
  }
);

const deleteState = tool(
  "delete_state",
  "Delete a key from the state tree. Cleans up app DOM, styles, and setup if removing an app.",
  {
    path: z.string().describe("Dot path to delete (e.g. 'apps.calculator', 'lib.formatDate')"),
  },
  ({ path }) => {
    sendProgress("delete_state", path);
    return browserTool("delete_state", { path });
  }
);

const sendMessage = tool(
  "send_message",
  "Send a text message to the user in the console. ALWAYS use this to reply — plain text responses won't be delivered. Call BEFORE wait_for_input.",
  { text: z.string().describe("Message to display to the user") },
  ({ text }) => {
    console.log(`[send_message] ${shorten(text)}`);
    if (browserWs && browserWs.readyState === 1) {
      browserWs.send(JSON.stringify({ type: "text", text }));
    }
    return { content: [{ type: "text", text: "Sent." }] };
  }
);

const replyToApp = tool(
  "reply_to_app",
  "Reply to a programmatic LLM call from a browser app (vmExitOS.ask). Match the id from [APP_REQUEST id=...] message.",
  {
    id: z.string().describe("The request ID from the [APP_REQUEST id=...] message"),
    text: z.string().describe("The response text to send back to the app"),
  },
  ({ id, text }) => {
    console.log(`[reply_to_app] id=${id} ${shorten(text)}`);
    if (browserWs && browserWs.readyState === 1) {
      browserWs.send(JSON.stringify({ type: "llm_result", id, text }));
    }
    return { content: [{ type: "text", text: "Replied." }] };
  }
);

const waitForInput = tool(
  "wait_for_input",
  "Block until the user sends their next message or event. Call after send_message to keep session alive. Returns the next input as a string.",
  {},
  () =>
    new Promise((resolve) => {
      if (browserWs && browserWs.readyState === 1) {
        browserWs.send(JSON.stringify({ type: "status", status: "idle" }));
      }

      if (inputQueue.length > 0) {
        const msg = inputQueue.shift();
        console.log(`[wait_for_input] resolved immediately from queue: ${shorten(msg)}`);
        if (browserWs && browserWs.readyState === 1) {
          browserWs.send(JSON.stringify({ type: "status", status: "thinking" }));
        }
        resolve({ content: [{ type: "text", text: msg }] });
      } else {
        console.log("[wait_for_input] blocking — waiting for user input…");
        inputResolve = (msg) => {
          inputResolve = null;
          console.log(`[wait_for_input] resolved: ${shorten(msg)}`);
          if (browserWs && browserWs.readyState === 1) {
            browserWs.send(JSON.stringify({ type: "status", status: "thinking" }));
          }
          resolve({ content: [{ type: "text", text: msg }] });
        };
      }
    })
);

// Create a fresh MCP server per session (SDK requires one instance per connection)
function createBrowserMcp() {
  return createSdkMcpServer({
    name: "browser",
    tools: [getState, setState, deleteState, sendMessage, replyToApp, waitForInput],
  });
}

// ---------------------------------------------------------------------------
// Express app & static files
// ---------------------------------------------------------------------------
const app = express();
app.use(express.json({ limit: "5mb" }));
app.use(express.static(join(__dirname, "public")));

// State API
app.get("/api/state", async (_req, res) => {
  try {
    if (!existsSync(STATE_FILE)) return res.json(null);
    const data = await readFile(STATE_FILE, "utf-8");
    res.json(JSON.parse(data));
  } catch (err) {
    console.error("[state] read error:", err.message);
    res.json(null);
  }
});

app.post("/api/state", async (req, res) => {
  try {
    if (!existsSync(STATE_DIR)) await mkdir(STATE_DIR, { recursive: true });
    await writeFile(STATE_FILE, JSON.stringify(req.body, null, 2), "utf-8");
    res.json({ ok: true });
  } catch (err) {
    console.error("[state] write error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

// ---------------------------------------------------------------------------
// HTTP + WebSocket server
// ---------------------------------------------------------------------------
const server = createServer(app);
const wss = new WebSocketServer({ server });

wss.on("connection", (ws) => {
  console.log("[ws] Client connected");
  browserWs = ws;

  let sessionId = null;
  let sessionRunning = false;

  function send(payload) {
    if (ws.readyState === ws.OPEN) {
      ws.send(JSON.stringify(payload));
    }
  }

  function feedInput(prompt) {
    if (inputResolve) {
      console.log(`[feed] delivering to wait_for_input: ${shorten(prompt, 200)}`);
      inputResolve(prompt);
    } else if (sessionRunning) {
      console.log(`[feed] session busy, queuing: ${shorten(prompt, 200)}`);
      inputQueue.push(prompt);
      send({ type: "status", status: "thinking" });
    } else {
      startSession(prompt);
    }
  }

  // Start session immediately on connect
  startSession("[SYSTEM] Session started. Initialize and call wait_for_input to wait for the user's first message.");

  async function startSession(prompt) {
    sessionRunning = true;
    inputResolve = null;
    inputQueue = [];
    send({ type: "status", status: "thinking" });
    console.log(`\n[session] starting NEW session`);
    console.log(`[session] prompt: ${shorten(prompt, 200)}`);

    try {
      const opts = {
        model: "claude-opus-4-6",
        cwd: __dirname,
        systemPrompt: SYSTEM_PROMPT,
        mcpServers: { browser: createBrowserMcp() },
        permissionMode: "bypassPermissions",
        allowDangerouslySkipPermissions: true,
        allowedTools: [
          "mcp__browser__get_state",
          "mcp__browser__set_state",
          "mcp__browser__delete_state",
          "mcp__browser__send_message",
          "mcp__browser__reply_to_app",
          "mcp__browser__wait_for_input",
        ],
        maxTurns: 500,
      };

      for await (const message of query({ prompt, options: opts })) {
        if (message.type === "system" && message.subtype === "init") {
          sessionId = message.session_id;
          console.log(`[sys] session: ${sessionId}`);
          continue;
        }

        if (message.type === "system") {
          console.log(`[sys] ${message.subtype}: ${shorten(JSON.stringify(message))}`);
          continue;
        }

        if ("result" in message) {
          console.log(`[result] ${shorten(message.result)}`);
          send({ type: "result", text: message.result });
          continue;
        }

        if (message.content && Array.isArray(message.content)) {
          for (const block of message.content) {
            if (block.type === "tool_use") {
              if (block.name === "mcp__browser__wait_for_input") {
                console.log("[tool] wait_for_input — session idle, waiting for user");
              } else {
                console.log(`[tool] ${block.name}(${shorten(JSON.stringify(block.input), 200)})`);
              }
            } else if (block.type === "tool_result") {
              console.log(`[tool-result] ${shorten(typeof block.content === "string" ? block.content : JSON.stringify(block.content))}`);
            } else if (block.text) {
              console.log(`[text] ${shorten(block.text)}`);
              send({ type: "text", text: block.text });
            } else if (block.type) {
              console.log(`[block] ${block.type}`);
            }
          }
        }
      }
    } catch (err) {
      console.error("[session] Error:", err.message);
      send({ type: "error", text: err.message });
    } finally {
      sessionRunning = false;
      inputResolve = null;
      sessionId = null;
      send({ type: "status", status: "idle" });
      console.log(`[session] ended\n`);

      // Auto-restart session if WS is still connected
      if (ws.readyState === ws.OPEN) {
        console.log("[session] WS still open — restarting session");
        setTimeout(() => {
          if (ws.readyState === ws.OPEN && !sessionRunning) {
            startSession("[SYSTEM] Session restarted. Call get_state() to see current apps, then call wait_for_input.");
          }
        }, 500);
      }
    }
  }

  ws.on("message", (raw) => {
    let data;
    try {
      data = JSON.parse(raw.toString());
    } catch {
      send({ type: "error", text: "Invalid JSON" });
      return;
    }

    if (data.type === "exec_result") {
      handleExecResult(data);
      return;
    }

    console.log(`[ws:in] ${shorten(JSON.stringify(data), 200)}`);

    if (data.type === "message") {
      feedInput(data.text);
    } else if (data.type === "event") {
      feedInput(`[EVENT] ${data.name}: ${JSON.stringify(data.data)}`);
    } else if (data.type === "llm_call") {
      feedInput(`[APP_REQUEST id=${data.id}] ${data.prompt}`);
    } else if (data.type === "error_report") {
      feedInput(data.text);
    } else {
      send({ type: "error", text: `Unknown message type: ${data.type}` });
    }
  });

  ws.on("close", () => {
    console.log("[ws] Client disconnected");
    if (browserWs === ws) browserWs = null;
    if (inputResolve) {
      inputResolve("[SYSTEM] Browser disconnected. End session.");
    }
    for (const [id, pending] of pendingExecs) {
      clearTimeout(pending.timeout);
      pending.reject(new Error("Browser disconnected"));
    }
    pendingExecs.clear();
  });

  ws.on("error", (err) => {
    console.error("[ws] Error:", err.message);
  });
});

// ---------------------------------------------------------------------------
// Prevent SDK transport errors from crashing the process
// ---------------------------------------------------------------------------
process.on("unhandledRejection", (err) => {
  const msg = String(err?.message || err);
  if (msg.includes("ProcessTransport") || msg.includes("Already connected")) {
    console.warn(`[sdk] suppressed: ${msg}`);
  } else {
    console.error("[unhandledRejection]", err);
  }
});

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------
server.listen(PORT, () => {
  console.log(`[vmExit] http://localhost:${PORT}`);
});
