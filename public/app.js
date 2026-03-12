/* ============================================================
   vmExit — Frontend Application
   v0.2: Pure Functional State Management
   ============================================================ */

// ---- DOM References ----

const consoleEl = document.getElementById("console");
const consoleOutput = document.getElementById("console-output");
const consoleInput = document.getElementById("console-input");
const desktop = document.getElementById("desktop");
const appSelector = document.getElementById("app-selector");
const newAppBtn = document.getElementById("new-app-btn");

// ---- UI State ----

let ws = null;
let reconnectAttempts = 0;
const MAX_RECONNECT = 5;
const RECONNECT_DELAY = 2000;
let isThinking = false;
const commandHistory = [];
let historyIndex = -1;
const pendingLlmCalls = new Map();

// ---- Message Display ----

function addMessage(role, text) {
  const div = document.createElement("div");
  div.className = `msg ${role}`;
  div.textContent = text;
  consoleOutput.appendChild(div);
  scrollToBottom();
}

function scrollToBottom() {
  requestAnimationFrame(() => {
    consoleOutput.scrollTop = consoleOutput.scrollHeight;
  });
}

// ---- Activity Indicator ----

let activityEl = null;

function showThinking() {
  if (isThinking) return;
  isThinking = true;

  activityEl = document.createElement("div");
  activityEl.className = "activity";

  const dots = document.createElement("div");
  dots.className = "activity-dots";
  for (let i = 0; i < 3; i++) dots.appendChild(document.createElement("span"));
  activityEl.appendChild(dots);

  consoleOutput.appendChild(activityEl);
  scrollToBottom();

  consoleInput.disabled = true;
}

function addProgress(tool, detail) {
  if (!activityEl) showThinking();

  const line = document.createElement("div");
  line.className = "activity-line";
  line.textContent = `${tool} ${detail}`;
  activityEl.appendChild(line);

  // Keep only last 6 progress lines
  const lines = activityEl.querySelectorAll(".activity-line");
  if (lines.length > 6) lines[0].remove();

  scrollToBottom();
}

function hideThinking() {
  if (!isThinking) return;
  isThinking = false;

  if (activityEl) {
    activityEl.remove();
    activityEl = null;
  }

  consoleInput.disabled = false;
  consoleInput.focus();
}

// ---- Console Toggle ----

function openConsole() {
  consoleEl.classList.add("open");
  consoleInput.focus();
}

function closeConsole() {
  consoleEl.classList.remove("open");
  consoleInput.blur();
}

function toggleConsole() {
  if (consoleEl.classList.contains("open")) {
    closeConsole();
  } else {
    openConsole();
  }
}

// ---- Keyboard Handling ----

document.addEventListener("keydown", (e) => {
  if (e.key === "`") {
    const active = document.activeElement;
    const isExternalInput =
      active &&
      (active.tagName === "INPUT" || active.tagName === "TEXTAREA") &&
      active !== consoleInput;

    if (isExternalInput) return;

    e.preventDefault();
    toggleConsole();
    return;
  }

  if (e.key === "Escape") {
    closeConsole();
    return;
  }
});

consoleInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter") {
    e.preventDefault();
    const text = consoleInput.value.trim();
    if (!text || isThinking) return;

    commandHistory.push(text);
    historyIndex = commandHistory.length;

    addMessage("user", text);
    consoleInput.value = "";

    sendUserMessage(text);
    return;
  }

  if (e.key === "ArrowUp") {
    e.preventDefault();
    if (commandHistory.length === 0) return;
    if (historyIndex > 0) historyIndex--;
    consoleInput.value = commandHistory[historyIndex] || "";
    return;
  }

  if (e.key === "ArrowDown") {
    e.preventDefault();
    if (historyIndex < commandHistory.length - 1) {
      historyIndex++;
      consoleInput.value = commandHistory[historyIndex] || "";
    } else {
      historyIndex = commandHistory.length;
      consoleInput.value = "";
    }
    return;
  }
});

// =========================================================================
// STATE RUNTIME
// =========================================================================

// ---- State Tree ----

let state = { activeApp: null, apps: {}, lib: {} };

// ---- Path Utilities ----

function getByPath(obj, path) {
  if (!path) return obj;
  const parts = path.split(".");
  let current = obj;
  for (const part of parts) {
    if (current == null) return undefined;
    current = current[part];
  }
  return current;
}

function setByPath(obj, path, value) {
  if (!path) return value;
  const parts = path.split(".");
  const result = structuredClone(obj);
  let current = result;
  for (let i = 0; i < parts.length - 1; i++) {
    if (current[parts[i]] == null) current[parts[i]] = {};
    current = current[parts[i]];
  }
  current[parts[parts.length - 1]] = value;
  return result;
}

function deleteByPath(obj, path) {
  const parts = path.split(".");
  const result = structuredClone(obj);
  let current = result;
  for (let i = 0; i < parts.length - 1; i++) {
    if (current[parts[i]] == null) return result;
    current = current[parts[i]];
  }
  delete current[parts[parts.length - 1]];
  return result;
}

// ---- Error Reporting to Agent ----

const recentErrors = new Map(); // key → timestamp, dedup within 5s
const ERROR_DEDUP_MS = 5000;

function reportError(appId, phase, error) {
  const key = `${appId}:${phase}:${error.message}`;
  const now = Date.now();
  if (recentErrors.has(key) && now - recentErrors.get(key) < ERROR_DEDUP_MS) return;
  recentErrors.set(key, now);

  const appName = state.apps[appId]?.name || appId;
  const stack = error.stack || "";
  const msg = `[ERROR app=${appId} name="${appName}" phase=${phase}] ${error.message}\n${stack}`;

  console.error(`[reportError] ${msg}`);

  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ type: "error_report", text: msg }));
  }
}

// ---- Function Compilation Cache ----

const compiledCache = new Map();

function compile(fnString) {
  if (!compiledCache.has(fnString)) {
    compiledCache.set(fnString, new Function("return " + fnString)());
  }
  return compiledCache.get(fnString);
}

// ---- Lib Compilation ----

let compiledLib = {};

function recompileLib() {
  const lib = {};
  for (const [name, fnStr] of Object.entries(state.lib || {})) {
    try {
      lib[name] = compile(fnStr);
    } catch (e) {
      console.error(`[lib] failed to compile ${name}:`, e);
      reportError("lib", `compile(${name})`, e);
    }
  }
  compiledLib = Object.freeze(lib);
}

// ---- Setup Cleanups ----

const setupCleanups = new Map();

// ---- App Header & Active App Management ----

function renderAppHeader() {
  const apps = state.apps || {};
  const ids = Object.keys(apps);

  // Rebuild select options
  appSelector.innerHTML = "";

  if (ids.length === 0) {
    const opt = document.createElement("option");
    opt.value = "";
    opt.textContent = "No apps";
    opt.disabled = true;
    opt.selected = true;
    appSelector.appendChild(opt);
  } else {
    for (const id of ids) {
      const opt = document.createElement("option");
      opt.value = id;
      opt.textContent = apps[id].name || id;
      if (id === state.activeApp) opt.selected = true;
      appSelector.appendChild(opt);
    }
  }
}

function setActiveApp(appId) {
  state.activeApp = appId;

  // Toggle visibility
  for (const container of desktop.querySelectorAll(".app-container")) {
    container.classList.toggle("active", container.dataset.app === appId);
  }

  renderAppHeader();
  schedulePersist();
}

function createNewApp() {
  const appId = `app_${Date.now()}`;
  state.apps[appId] = {
    name: "New Application",
    data: {},
    render: "",
    styles: "",
    handlers: {},
  };
  renderApp(appId);
  setActiveApp(appId);
  persistState();
}

// Header event listeners
appSelector.addEventListener("change", (e) => {
  if (e.target.value) setActiveApp(e.target.value);
});

newAppBtn.addEventListener("click", () => {
  createNewApp();
});

// ---- Focus Save/Restore ----

function saveFocus(container) {
  const el = document.activeElement;
  if (!el || !container.contains(el)) return null;

  // Build a path to relocate the element after re-render
  let selector = null;
  if (el.id) {
    selector = `#${el.id}`;
  } else if (el.name) {
    selector = `[name="${CSS.escape(el.name)}"]`;
  } else {
    // Build nth-of-type path relative to container
    const parts = [];
    let cur = el;
    while (cur && cur !== container) {
      const parent = cur.parentElement;
      if (!parent) break;
      const tag = cur.tagName.toLowerCase();
      const siblings = [...parent.children].filter(c => c.tagName === cur.tagName);
      parts.unshift(siblings.length > 1
        ? `${tag}:nth-of-type(${siblings.indexOf(cur) + 1})`
        : tag);
      cur = parent;
    }
    selector = parts.join(" > ");
  }

  return {
    selector,
    value: el.value ?? "",
    selStart: el.selectionStart ?? null,
    selEnd: el.selectionEnd ?? null,
    scrollTop: el.scrollTop,
  };
}

function restoreFocus(container, saved) {
  if (!saved) return;
  try {
    const el = container.querySelector(saved.selector);
    if (!el) return;

    // DON'T restore el.value — the render function sets the correct value from state.
    // Restoring the old value would overwrite content when switching contexts
    // (e.g., selecting a different note).
    el.focus();

    // Restore cursor position only if the value length supports it
    if (el.setSelectionRange && saved.selStart !== null) {
      const len = (el.value || "").length;
      el.setSelectionRange(
        Math.min(saved.selStart, len),
        Math.min(saved.selEnd, len)
      );
    }
    if (saved.scrollTop) el.scrollTop = saved.scrollTop;
  } catch {
    // selector may be invalid, just skip
  }
}

// ---- App Renderer ----

function renderApp(appId) {
  const app = state.apps[appId];
  if (!app) return;

  // 1. Cleanup previous setup
  const oldCleanup = setupCleanups.get(appId);
  if (typeof oldCleanup === "function") {
    try { oldCleanup(); } catch (e) { console.error(`[cleanup] ${appId}:`, e); }
    setupCleanups.delete(appId);
  }

  // 2. Get or create container
  let container = desktop.querySelector(`[data-app="${appId}"]`);
  if (!container) {
    container = document.createElement("div");
    container.dataset.app = appId;
    container.className = "app-container";
    desktop.appendChild(container);
  }

  // Set visibility
  container.classList.toggle("active", appId === state.activeApp);

  // 3. Inject/update styles
  let styleEl = document.getElementById(`app-style-${appId}`);
  if (app.styles) {
    if (!styleEl) {
      styleEl = document.createElement("style");
      styleEl.id = `app-style-${appId}`;
      document.head.appendChild(styleEl);
    }
    styleEl.textContent = app.styles;
  } else if (styleEl) {
    styleEl.remove();
  }

  // 4. Render HTML (save/restore focus across innerHTML replacement)
  if (app.render) {
    const focusState = saveFocus(container);
    try {
      const renderFn = compile(app.render);
      const html = renderFn(app.data || {}, compiledLib);
      container.innerHTML = html;
      restoreFocus(container, focusState);
    } catch (e) {
      container.innerHTML = `<div class="app-error">
        <div class="app-error-title">Render Error</div>
        <pre class="app-error-msg">${e.message}</pre>
        <div class="app-error-fixing"><span></span><span></span><span></span> Agent is fixing this…</div>
      </div>`;
      console.error(`[render] ${appId}:`, e);
      reportError(appId, "render", e);
    }
  }

  // 5. Run setup
  if (app.setup) {
    try {
      const setupFn = compile(app.setup);
      const dispatch = (action, payload) => dispatchAction(appId, action, payload);
      const getData = () => state.apps[appId]?.data || {};
      const cleanup = setupFn(container, dispatch, getData, compiledLib);
      if (typeof cleanup === "function") {
        setupCleanups.set(appId, cleanup);
      }
    } catch (e) {
      console.error(`[setup] ${appId}:`, e);
      reportError(appId, "setup", e);
    }
  }
}

function unmountApp(appId) {
  // Cleanup
  const cleanup = setupCleanups.get(appId);
  if (typeof cleanup === "function") {
    try { cleanup(); } catch (e) { console.error(`[cleanup] ${appId}:`, e); }
    setupCleanups.delete(appId);
  }

  // Remove container
  const container = desktop.querySelector(`[data-app="${appId}"]`);
  if (container) container.remove();

  // Remove style
  const styleEl = document.getElementById(`app-style-${appId}`);
  if (styleEl) styleEl.remove();
}

// ---- Event Delegation ----

desktop.addEventListener("click", (e) => {
  const actionEl = e.target.closest("[data-action]");
  if (!actionEl) return;

  const action = actionEl.dataset.action;
  const appContainer = actionEl.closest("[data-app]");
  if (!appContainer) return;

  const appId = appContainer.dataset.app;

  // Build payload from data-* attributes (excluding data-action and data-app)
  const payload = {};
  for (const [key, val] of Object.entries(actionEl.dataset)) {
    if (key !== "action" && key !== "app") {
      payload[key] = val;
    }
  }

  dispatchAction(appId, action, payload);
});

// ---- Input Capture ----
// Before running handlers, capture dirty input/textarea values so the handler
// operates on up-to-date state. Uses data-field="path" to map DOM → state.

function captureInputs(appId) {
  const container = desktop.querySelector(`[data-app="${appId}"]`);
  if (!container) return;

  const app = state.apps[appId];
  if (!app) return;

  let dirty = false;

  // Capture elements with data-field (explicit binding to data path)
  for (const el of container.querySelectorAll("[data-field]")) {
    const field = el.dataset.field;
    const value = el.type === "checkbox" ? el.checked : el.value;
    if (getByPath(app.data, field) !== value) {
      // Mutate in place to avoid triggering re-render
      setNestedValue(app.data, field, value);
      dirty = true;
    }
  }

  if (dirty) schedulePersist();
}

// Set a nested value in an object by dot path (mutates in place)
function setNestedValue(obj, path, value) {
  const parts = path.split(".");
  let current = obj;
  for (let i = 0; i < parts.length - 1; i++) {
    if (current[parts[i]] == null) current[parts[i]] = {};
    current = current[parts[i]];
  }
  current[parts[parts.length - 1]] = value;
}

// ---- Dispatch ----

function dispatchAction(appId, action, payload = {}) {
  const app = state.apps[appId];
  if (!app || !app.handlers || !app.handlers[action]) {
    console.warn(`[dispatch] no handler: ${appId}.${action}`);
    return;
  }

  // Capture any dirty input values to state before handler runs
  captureInputs(appId);

  try {
    const handlerFn = compile(app.handlers[action]);
    const newData = handlerFn(app.data || {}, payload, compiledLib);
    state.apps[appId] = { ...state.apps[appId], data: newData };
    renderApp(appId);
    notifySubscribers(`apps.${appId}.data`);
    schedulePersist();
  } catch (e) {
    console.error(`[handler] ${appId}.${action}:`, e);
    reportError(appId, `handler(${action})`, e);
  }
}

// ---- Subscriptions ----

const subscribers = new Map();

function subscribe(path, callback) {
  if (!subscribers.has(path)) subscribers.set(path, new Set());
  subscribers.get(path).add(callback);
  return () => subscribers.get(path)?.delete(callback);
}

function notifySubscribers(changedPath) {
  for (const [path, callbacks] of subscribers) {
    if (changedPath.startsWith(path) || path.startsWith(changedPath)) {
      for (const cb of callbacks) {
        try { cb(getByPath(state, path)); } catch (e) { console.error("[subscribe]", e); }
      }
    }
  }
}

// ---- State Change Handling ----

function handleStateChange(path, immediate = false) {
  const parts = path.split(".");
  const persist = immediate ? () => persistState() : schedulePersist;

  if (parts[0] === "activeApp") {
    setActiveApp(state.activeApp);
    notifySubscribers(path);
    persist();
    return;
  }

  if (parts[0] === "lib") {
    recompileLib();
    for (const appId of Object.keys(state.apps || {})) {
      renderApp(appId);
    }
    renderAppHeader();
    notifySubscribers(path);
    persist();
    return;
  }

  if (parts[0] === "apps" && parts.length >= 2) {
    const appId = parts[1];
    renderApp(appId);
    // Re-render header if name changed or whole app was set
    if (parts.length === 2 || parts[2] === "name") {
      renderAppHeader();
    }
    notifySubscribers(path);
    persist();
    return;
  }

  notifySubscribers(path);
  persist();
}

function handleStateDeletion(path, immediate = false) {
  const parts = path.split(".");
  const persist = immediate ? () => persistState() : schedulePersist;

  if (parts[0] === "apps" && parts.length === 2) {
    const removedId = parts[1];
    unmountApp(removedId);

    // If deleted app was active, switch to another
    if (state.activeApp === removedId) {
      const remaining = Object.keys(state.apps || {});
      state.activeApp = remaining.length > 0 ? remaining[0] : null;
      setActiveApp(state.activeApp);
    }
    renderAppHeader();
  }

  if (parts[0] === "lib") {
    recompileLib();
    for (const appId of Object.keys(state.apps || {})) {
      renderApp(appId);
    }
  }

  notifySubscribers(path);
  persist();
}

// ---- Persistence ----

let persistTimer = null;
const PERSIST_DELAY = 2000;

function schedulePersist() {
  if (persistTimer) clearTimeout(persistTimer);
  persistTimer = setTimeout(persistState, PERSIST_DELAY);
}

async function persistState() {
  persistTimer = null;
  try {
    const response = await fetch("/api/state", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(state),
    });
    if (!response.ok) console.error("[persist] server error:", response.status);
    else console.log("[persist] state saved");
  } catch (e) {
    console.error("[persist] failed:", e);
  }
}

function persistStateSync() {
  // Synchronous persist for beforeunload — uses sendBeacon
  const blob = new Blob([JSON.stringify(state)], { type: "application/json" });
  navigator.sendBeacon("/api/state", blob);
}

// Flush pending state on page unload
window.addEventListener("beforeunload", () => {
  if (persistTimer) {
    clearTimeout(persistTimer);
    persistStateSync();
  }
});

// ---- State Restoration ----

async function restoreState() {
  try {
    const response = await fetch("/api/state");
    const saved = await response.json();
    if (saved && saved.apps) {
      state = saved;
      if (!state.lib) state.lib = {};
      if (!state.activeApp) state.activeApp = null;
      recompileLib();
      for (const appId of Object.keys(state.apps)) {
        renderApp(appId);
      }

      // If active app no longer exists, pick first
      if (state.activeApp && !state.apps[state.activeApp]) {
        const ids = Object.keys(state.apps);
        state.activeApp = ids.length > 0 ? ids[0] : null;
      }

      setActiveApp(state.activeApp);
      console.log(`[restore] restored ${Object.keys(state.apps).length} apps, active: ${state.activeApp}`);
    }
  } catch (e) {
    console.log("[restore] no saved state or error:", e);
  }

  // Create a default app if none exist
  if (Object.keys(state.apps).length === 0) {
    createNewApp();
  }

  renderAppHeader();
}

// =========================================================================
// TOOL EXECUTOR — handles exec messages from server
// =========================================================================

async function handleExec(msg) {
  const { id, tool: toolName, args } = msg;
  let result = null;
  let error = null;

  try {
    switch (toolName) {
      case "get_state": {
        const value = args.path ? getByPath(state, args.path) : state;
        result = JSON.stringify(value, null, 2);
        break;
      }

      case "set_state": {
        let parsed;
        try {
          parsed = JSON.parse(args.value);
        } catch {
          // If not valid JSON, use the raw string (CSS, function strings, etc.)
          parsed = args.value;
        }
        state = setByPath(state, args.path, parsed);
        handleStateChange(args.path, true);
        result = "ok";
        break;
      }

      case "delete_state": {
        state = deleteByPath(state, args.path);
        handleStateDeletion(args.path, true);
        result = "ok";
        break;
      }

      default:
        error = `Unknown tool: ${toolName}`;
    }
  } catch (err) {
    error = err.message || String(err);
  }

  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ type: "exec_result", id, result, error }));
  }
}

// =========================================================================
// WEBSOCKET CLIENT
// =========================================================================

function connectWebSocket() {
  const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
  ws = new WebSocket(`${protocol}//${window.location.host}`);

  ws.addEventListener("open", () => {
    reconnectAttempts = 0;
    console.log("[ws] connected");
    addMessage("system", "connected");
  });

  ws.addEventListener("message", (event) => {
    let msg;
    try {
      msg = JSON.parse(event.data);
    } catch {
      return;
    }

    console.log(`[ws:in] ${msg.type}`, msg.type === "exec" ? msg.tool : msg.text ?? msg.status ?? "");

    switch (msg.type) {
      case "text":
      case "result":
        hideThinking();
        addMessage("assistant", msg.text);
        break;

      case "status":
        if (msg.status === "thinking") {
          showThinking();
        } else if (msg.status === "idle") {
          hideThinking();
        }
        break;

      case "progress":
        addProgress(msg.tool, msg.detail);
        break;

      case "error":
        hideThinking();
        addMessage("error", msg.text);
        break;

      case "exec":
        handleExec(msg);
        break;

      case "llm_result": {
        const pending = pendingLlmCalls.get(msg.id);
        if (pending) {
          clearTimeout(pending.timeout);
          pendingLlmCalls.delete(msg.id);
          console.log(`[llm:result] id=${msg.id} ${(msg.text || "").slice(0, 80)}`);
          pending.resolve(msg.text);
        }
        break;
      }

      default:
        console.log(`[ws:in] unknown message type: ${msg.type}`);
        break;
    }
  });

  ws.addEventListener("close", () => {
    console.log("[ws] disconnected");
    addMessage("system", "disconnected");
    hideThinking();

    if (reconnectAttempts < MAX_RECONNECT) {
      reconnectAttempts++;
      addMessage(
        "system",
        `reconnecting (${reconnectAttempts}/${MAX_RECONNECT})...`
      );
      setTimeout(connectWebSocket, RECONNECT_DELAY);
    } else {
      addMessage("error", "connection lost — reload to retry");
    }
  });

  ws.addEventListener("error", () => {});
}

function sendUserMessage(text) {
  if (!ws || ws.readyState !== WebSocket.OPEN) {
    addMessage("error", "not connected to server");
    return;
  }

  // Prepend active app context
  let payload = text;
  if (state.activeApp && state.apps[state.activeApp]) {
    const app = state.apps[state.activeApp];
    payload = `[ACTIVE_APP id=${state.activeApp} name="${app.name || state.activeApp}"] ${text}`;
  }

  console.log(`[ws:out] message: ${payload}`);
  ws.send(JSON.stringify({ type: "message", text: payload }));
}

function sendEvent(name, data = {}) {
  if (!ws || ws.readyState !== WebSocket.OPEN) return;
  ws.send(JSON.stringify({ type: "event", name, data }));
}

// =========================================================================
// vmExitOS GLOBAL API
// =========================================================================

window.vmExitOS = {
  // Send event to Claude session
  emit: (name, data = {}) => {
    sendEvent(name, data);
  },

  // Show toast notification
  toast: (message, type = "info", duration = 3000) => {
    const toast = document.createElement("div");
    toast.className = `toast ${type}`;
    toast.textContent = message;
    toast.style.setProperty("--duration", `${duration / 1000}s`);
    document.getElementById("toast-container").appendChild(toast);
    setTimeout(() => toast.remove(), duration + 300);
  },

  // Call the LLM from a browser app
  ask: (prompt, timeoutMs = 60000) => {
    return new Promise((resolve, reject) => {
      if (!ws || ws.readyState !== WebSocket.OPEN) {
        reject(new Error("Not connected to server"));
        return;
      }
      const id = crypto.randomUUID();
      const timeout = setTimeout(() => {
        pendingLlmCalls.delete(id);
        reject(new Error("LLM call timed out"));
      }, timeoutMs);
      pendingLlmCalls.set(id, { resolve, reject, timeout });
      console.log(`[llm:ask] id=${id} ${prompt.slice(0, 80)}`);
      ws.send(JSON.stringify({ type: "llm_call", id, prompt }));
    });
  },

  // Dispatch an action to an app's handler
  dispatch: (appId, action, payload = {}) => {
    dispatchAction(appId, action, payload);
  },

  // Read state at a path
  read: (path) => {
    return getByPath(state, path);
  },

  // Subscribe to state changes at a path
  subscribe: (path, callback) => {
    return subscribe(path, callback);
  },
};

// =========================================================================
// BOOT
// =========================================================================

async function boot() {
  addMessage("system", "vmExit v0.2 — press ` to open console");
  await restoreState();
  connectWebSocket();
}

boot();
