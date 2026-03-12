# vmExit

A computing environment where a persistent AI agent builds applications from natural language, live in the browser.

No pre-installed software. You open a console, describe what you need, and the agent writes it. The application appears on screen, fully interactive, in seconds.

## How It Works

**You talk. The agent builds.**

vmExit runs a persistent Claude session that stays alive as long as your browser tab is open. There's no cold start between messages — the agent remembers what it built, what you asked for, and what went wrong.

**Apps are state objects.**

Every application is a single JSON-serializable object: data, a render function, event handlers, styles, and an optional setup function for imperative things like drag-and-drop or canvas. The agent creates and modifies these objects. The browser runtime compiles the functions, renders the HTML, and handles events automatically.

**The AI stays inside the app.**

Any application can call the agent at runtime via `vmExitOS.ask()`. A calorie tracker where you type "two eggs and toast" and the agent estimates macros. A notes app where you highlight text and ask "explain this". Intelligence is a native capability, not an external API.

**Errors fix themselves.**

When something breaks, the runtime captures the error and stack trace and sends it back to the agent. The agent reads the broken code, understands the problem, patches the specific function that failed, and the app comes back — usually within a few seconds.

**Everything persists.**

State saves automatically. Close the tab, come back tomorrow — every app is exactly where you left it.

## Quick Start

```
npm install
npm start
```

Open `http://localhost:3000`. Press `` ` `` (backtick) to open the console. Start talking.

## What You Can Build

Anything that runs in a browser. The agent has full access to HTML, CSS, and JavaScript through the state tree. Examples people have built:

- **Calorie tracker** — describe meals in natural language, the agent estimates nutrition
- **Notes app** — sidebar navigation, full-text editing, content persists across sessions
- **Dashboards** — charts, progress bars, live data
- **Games** — canvas-based, interactive, with event handlers
- **Tools** — converters, calculators, form builders

Apps can call the agent at runtime for translation, summarization, classification, or any task that benefits from language understanding.

## Architecture

```
Browser (app.js)                    Server (server.js)
┌──────────────────┐               ┌──────────────────────┐
│  State Tree      │◄──WebSocket──►│  Claude Agent SDK    │
│  Render Runtime  │               │  MCP Tools           │
│  Event Delegation│               │  Session Management  │
│  Persistence     │               │  State API           │
└──────────────────┘               └──────────────────────┘
```

Two files. No build step. No framework.

- **server.js** — Express + WebSocket server, Claude Agent SDK session, MCP tool definitions
- **public/app.js** — State runtime, compiler, renderer, event system, persistence

The agent interacts with the browser through three tools: `get_state`, `set_state`, `delete_state`. These execute in the browser via WebSocket and modify a pure functional state tree that the runtime automatically renders to DOM.

## License

Research project. YOLO.
