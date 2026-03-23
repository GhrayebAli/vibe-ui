# Spec: Onboarding, Session & Branch Experience v2

## Overview

Replace the current "What are you building?" welcome screen with a structured landing experience that gives users three clear paths: **Discover** (read-only exploration), **Resume** (continue an existing feature), or **Build New** (start a fresh feature branch). The landing screen is the project hub — it appears on first load and when the user clicks "Home".

---

## User Flow

```
User opens Codespace → vibe-ui loads at port 4000
  │
  ├─ GET /api/workspace → detect repos, default branch, existing mvp/* branches
  ├─ GET /api/sessions → get saved sessions
  │
  ▼
┌─────────────────────────────────────────────┐
│           Landing Screen (full left panel)   │
│                                             │
│  [Discover]  Read-only explore on main      │
│  [Resume]    List of mvp/* branches         │
│  [Build New] Text input → create branch     │
│                                             │
│           $0.57 / $20 budget today          │
└─────────────────────────────────────────────┘
  │
  ├─ User clicks "Discover"
  │    → Stay on main, set mode=discover, hide landing, show chat
  │    → Agent restricted to Read/Glob/Grep
  │    → Session NOT saved to DB
  │
  ├─ User clicks a branch under "Resume"
  │    → git checkout <branch> across all repos
  │    → Run install if lockfile changed
  │    → Restart services on configured ports
  │    → Load chat history from matching session
  │    → Hide landing, show chat with restored messages
  │
  └─ User types feature name + clicks "Start"
       → Derive branch: mvp/<slugified-name>
       → git checkout -b mvp/<slug> across all repos
       → Create fresh session in DB with branch column
       → Hide landing, show empty chat
```

---

## Workspace Auto-Discovery

### New endpoint: `GET /api/workspace`

Scans the workspace directory for git repos (subdirectories containing `.git/`). Returns repo metadata used by the landing screen, branch switching, and service management.

**Response:**
```json
{
  "defaultBranch": "main",
  "repos": [
    {
      "name": "ops-frontend",
      "path": "/workspaces/washmen-ops-workspace/ops-frontend",
      "branch": "mvp/order-list-page",
      "hasPackageJson": true,
      "packageManager": "yarn",
      "startCommand": "yarn start",
      "port": 3000
    },
    {
      "name": "api-gateway",
      "path": "/workspaces/washmen-ops-workspace/api-gateway",
      "branch": "mvp/order-list-page",
      "hasPackageJson": true,
      "packageManager": "npm",
      "startCommand": "node app.js",
      "port": 1337
    }
  ],
  "branches": [
    {
      "name": "mvp/order-list-page",
      "lastActivity": "2026-03-23T10:30:00Z",
      "session": {
        "id": "abc-123",
        "messageCount": 24,
        "lastUsedAt": 1711187400
      }
    },
    {
      "name": "mvp/user-dashboard",
      "lastActivity": "2026-03-22T08:00:00Z",
      "session": null
    }
  ],
  "budget": {
    "spent": 0.57,
    "limit": 20,
    "remaining": 19.43
  }
}
```

**Implementation details:**

1. **Repo detection**: Scan `workspaceDir` for subdirectories. A subdirectory is a repo if it contains `.git/`. Exclude `vibe-ui`, `node_modules`, `.git`, `.devcontainer`.

2. **Default branch detection**: Run `git -C <first-repo> symbolic-ref refs/remotes/origin/HEAD 2>/dev/null` and parse the branch name. Fallback to `"main"`.

3. **Package manager detection**: Check for `yarn.lock` → yarn, `pnpm-lock.yaml` → pnpm, else npm.

4. **Port detection**: Read `package.json` scripts for port numbers, or use a config file `vibe-workspace.json` at workspace root (optional, falls back to scanning).

5. **Branch listing**: Run `git -C <repo> branch --list "mvp/*" --format="%(refname:short)"` on the first repo. For each branch, find a matching session in DB by the `branch` column.

6. **Start command detection**: Check `package.json` scripts — if `start` exists, use the package manager's start command. If not, check for `app.js` → `node app.js`. If not, check for `server.js` → `node server.js`.

**File: `server-washmen.js`** — Add new route handler at approximately line 95 (after `/api/prompts`).

---

## Database Schema Change

### Add `branch` column to `sessions` table

**File: `db.js`**

Add migration logic after table creation (approximately line 20):

```javascript
// Add branch column if not exists
try {
  db.exec(`ALTER TABLE sessions ADD COLUMN branch TEXT`);
} catch (e) {
  // Column already exists, ignore
}
```

Add index:
```javascript
db.exec(`CREATE INDEX IF NOT EXISTS idx_sessions_branch ON sessions(branch)`);
```

Update `createSession` prepared statement to include `branch`:
```sql
INSERT INTO sessions (id, claude_session_id, project_name, project_path, branch, created_at, last_used_at)
VALUES (?, ?, ?, ?, ?, unixepoch(), unixepoch())
```

Update the exported `createSession` function signature:
```javascript
function createSession(id, claudeSessionId, projectName, projectPath, branch)
```

Add new query function:
```javascript
function getSessionByBranch(branch) {
  return db.prepare('SELECT * FROM sessions WHERE branch = ? ORDER BY last_used_at DESC LIMIT 1').get(branch);
}
```

Export `getSessionByBranch`.

---

## New endpoint: `POST /api/switch-branch`

Switches all detected repos to the specified branch, installs dependencies if lockfiles changed, and restarts services.

**File: `server-washmen.js`**

**Request:**
```json
{
  "branch": "mvp/order-list-page"
}
```

**Response:**
```json
{
  "ok": true,
  "switched": ["ops-frontend", "api-gateway"],
  "installed": ["ops-frontend"],
  "restarted": [3000, 1337]
}
```

**Implementation:**

```
1. For each detected repo:
   a. Save current lockfile hash (sha256 of yarn.lock or package-lock.json)
   b. Run: git -C <repo> checkout <branch>
   c. Compare new lockfile hash
   d. If changed: run install command (yarn install / npm install)

2. For each repo with a configured port:
   a. Kill process on that port: kill $(lsof -ti:<port>)
   b. Relaunch with the start command (background, redirect to /tmp/<name>.log)

3. Wait 2 seconds, then return response
```

---

## New endpoint: `POST /api/create-branch`

Creates a new `mvp/<slug>` branch across all repos from the default branch.

**File: `server-washmen.js`**

**Request:**
```json
{
  "name": "order list page with filters"
}
```

**Response:**
```json
{
  "ok": true,
  "branch": "mvp/order-list-page-with-filters",
  "repos": ["ops-frontend", "api-gateway"]
}
```

**Implementation:**

```
1. Slugify name: lowercase, replace non-alphanumeric with hyphens, trim hyphens, truncate to 50 chars
2. Branch name: "mvp/" + slug
3. For each detected repo:
   a. git -C <repo> checkout <defaultBranch>
   b. git -C <repo> pull origin <defaultBranch> (ignore errors for shallow clones)
   c. git -C <repo> checkout -b <branchName>
4. Return branch name and repo list
```

---

## WebSocket Handler Changes

**File: `server/ws-handler-washmen.js`**

### New `mode` values

The `chat` message now accepts these mode values:
- `"discover"` — Read-only exploration on main branch
- `"build"` — Full tool access (existing behavior)
- `"plan"` — Existing plan mode (read-only, kept for backward compat)

### Changes to `handleChat` function

**Remove automatic branch creation on first message** (delete lines 241-289). Branch creation is now handled by the `/api/create-branch` endpoint before the first chat message.

**Discover mode** (add after line 206):
```javascript
if (mode === "discover") {
  text = `DISCOVERY MODE — You are exploring the codebase on the main branch. Do NOT edit any files. Do NOT run any commands that modify files. Only use Read, Glob, and Grep to explore and explain the codebase. Answer questions about architecture, patterns, and implementation details.\n\n${text}`;
}
```

**Tool restrictions** — Update the `allowedTools` logic (approximately line 314):
```javascript
allowedTools: (mode === "plan" || mode === "discover")
  ? ["Read", "Glob", "Grep"]
  : ["Read", "Edit", "Write", "Bash", "Glob", "Grep", "WebFetch", "Agent"],
```

**Session storage** — When creating a session in `handleChat` (approximately line 293), pass the branch:
```javascript
createSession(sessionId, null, title, workspaceDir, currentBranch);
```

**Discover mode session skip** — Do not create or save sessions in discover mode:
```javascript
if (mode !== "discover") {
  createSession(sessionId, null, title, workspaceDir, currentBranch);
}
```

---

## Frontend Changes

### HTML Changes

**File: `public/index-v2.html`**

Add landing screen HTML inside `#left-panel`, before `#chat`. Add a Home button in the top bar.

**Add after line 39 (after model-select), inside `.top-bar-left`:**
```html
<button id="home-btn" class="strip-btn" title="Home" style="display:none;">
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
    <path d="M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>
    <polyline points="9 22 9 12 15 12 15 22"/>
  </svg>
</button>
```

**Add after line 49 (after `#chat` div opening), as a sibling to `#welcome`:**
```html
<div id="landing" class="landing">
  <div class="landing-header">
    <div class="landing-title">Washmen Ops</div>
    <div class="landing-subtitle">What would you like to do?</div>
  </div>

  <div class="landing-cards">
    <!-- Discover Card -->
    <button class="landing-card" id="landing-discover">
      <div class="landing-card-icon">🔍</div>
      <div class="landing-card-content">
        <div class="landing-card-title">Discover the Codebase</div>
        <div class="landing-card-desc">Explore architecture, models, and routes on the main branch. Read-only.</div>
      </div>
    </button>

    <!-- Resume Card -->
    <div class="landing-card landing-card-resume" id="landing-resume" style="display:none;">
      <div class="landing-card-icon">▶</div>
      <div class="landing-card-content">
        <div class="landing-card-title">Resume Feature <span class="landing-card-badge" id="resume-count"></span></div>
        <div class="landing-branch-list" id="branch-list">
          <!-- Populated dynamically -->
        </div>
      </div>
    </div>

    <!-- Build New Card -->
    <div class="landing-card" id="landing-build">
      <div class="landing-card-icon">✚</div>
      <div class="landing-card-content">
        <div class="landing-card-title">Build a New Feature</div>
        <div class="landing-card-desc">Create a new branch and start building.</div>
        <div class="landing-build-row">
          <input type="text" id="feature-name-input" placeholder="Describe your feature..." class="landing-input" />
          <button id="feature-start-btn" class="landing-start-btn">Start</button>
        </div>
      </div>
    </div>
  </div>

  <div class="landing-footer">
    <div class="landing-budget" id="landing-budget"></div>
  </div>
</div>
```

### CSS Changes

**File: `public/styles.css`**

Add at the end of the file (before any media queries if present):

```css
/* ── Landing Screen ── */
.landing { display: flex; flex-direction: column; align-items: center; justify-content: center; flex: 1; padding: 24px 16px; gap: 20px; animation: fadeIn .3s ease; }
.landing-header { text-align: center; }
.landing-title { font-size: 22px; font-weight: 700; color: var(--text); margin-bottom: 4px; }
.landing-subtitle { font-size: 14px; color: var(--text-dim); }
.landing-cards { display: flex; flex-direction: column; gap: 10px; width: 100%; max-width: 400px; }
.landing-card { background: var(--surface); border: 1px solid var(--border); border-radius: var(--radius-lg); padding: 16px; cursor: pointer; transition: all var(--transition); display: flex; gap: 12px; align-items: flex-start; text-align: left; color: var(--text); font-family: var(--font); }
.landing-card:hover { border-color: var(--accent); background: var(--accent-soft); }
.landing-card-icon { font-size: 20px; flex-shrink: 0; width: 32px; height: 32px; display: flex; align-items: center; justify-content: center; background: var(--surface2); border-radius: var(--radius); }
.landing-card-content { flex: 1; min-width: 0; }
.landing-card-title { font-size: 14px; font-weight: 600; margin-bottom: 4px; display: flex; align-items: center; gap: 8px; }
.landing-card-desc { font-size: 12px; color: var(--text-dim); line-height: 1.4; }
.landing-card-badge { font-size: 10px; background: var(--accent); color: #fff; padding: 1px 7px; border-radius: 10px; font-weight: 600; }
.landing-branch-list { display: flex; flex-direction: column; gap: 4px; margin-top: 8px; }
.landing-branch-item { display: flex; align-items: center; justify-content: space-between; padding: 8px 10px; background: var(--bg); border: 1px solid var(--border); border-radius: var(--radius); cursor: pointer; transition: all var(--transition); }
.landing-branch-item:hover { border-color: var(--accent); background: var(--accent-soft); }
.landing-branch-name { font-size: 12px; font-weight: 500; font-family: var(--mono); color: var(--text); }
.landing-branch-meta { font-size: 11px; color: var(--text-muted); }
.landing-build-row { display: flex; gap: 8px; margin-top: 8px; }
.landing-input { flex: 1; background: var(--bg); border: 1px solid var(--border); border-radius: var(--radius); padding: 8px 10px; color: var(--text); font-size: 12px; font-family: var(--font); outline: none; transition: border-color var(--transition); }
.landing-input:focus { border-color: var(--accent); }
.landing-start-btn { background: var(--accent); color: #fff; border: none; border-radius: var(--radius-pill); padding: 8px 18px; font-size: 12px; font-weight: 600; cursor: pointer; font-family: var(--font); transition: all var(--transition); white-space: nowrap; }
.landing-start-btn:hover { filter: brightness(1.15); transform: scale(1.02); }
.landing-start-btn:disabled { opacity: .4; cursor: not-allowed; transform: none; }
.landing-footer { text-align: center; }
.landing-budget { font-size: 11px; color: var(--text-muted); }
.landing-card-resume { cursor: default; }
.landing-card-resume:hover { border-color: var(--border); background: var(--surface); }
```

### JavaScript Changes

**File: `public/app.js`**

#### New global state (add at line 19):
```javascript
let workspaceData = null; // cached /api/workspace response
```

#### New function: `showLanding()` (add after line 30):
```javascript
async function showLanding() {
  const landing = $('landing');
  const chat = $('chat');
  const welcome = $('welcome');
  const starters = $('starters');
  const inputDock = $('input-dock');
  const homeBtn = $('home-btn');

  // Show landing, hide chat elements
  landing.style.display = 'flex';
  if (welcome) welcome.style.display = 'none';
  if (starters) starters.style.display = 'none';
  inputDock.style.display = 'none';
  homeBtn.style.display = 'none';

  // Fetch workspace data
  try {
    const resp = await fetch('/api/workspace');
    workspaceData = await resp.json();
  } catch (e) {
    console.error('Failed to load workspace', e);
    return;
  }

  // Budget
  const budgetEl = $('landing-budget');
  if (budgetEl && workspaceData.budget) {
    budgetEl.textContent = `$${workspaceData.budget.spent.toFixed(2)} / $${workspaceData.budget.limit} budget today`;
  }

  // Populate resume branches
  const resumeCard = $('landing-resume');
  const branchList = $('branch-list');
  const resumeCount = $('resume-count');
  const branches = workspaceData.branches || [];

  if (branches.length > 0) {
    resumeCard.style.display = 'flex';
    resumeCount.textContent = branches.length;
    branchList.innerHTML = '';
    for (const b of branches) {
      const item = document.createElement('div');
      item.className = 'landing-branch-item';
      item.innerHTML = `
        <span class="landing-branch-name">${b.name}</span>
        <span class="landing-branch-meta">${formatTimeAgo(b.lastActivity)}</span>
      `;
      item.onclick = () => resumeBranch(b);
      branchList.appendChild(item);
    }
  } else {
    resumeCard.style.display = 'none';
  }
}
```

#### New function: `hideLanding()` (add after `showLanding`):
```javascript
function hideLanding() {
  const landing = $('landing');
  const inputDock = $('input-dock');
  const homeBtn = $('home-btn');
  landing.style.display = 'none';
  inputDock.style.display = '';
  homeBtn.style.display = '';
}
```

#### New function: `startDiscover()` (add after `hideLanding`):
```javascript
function startDiscover() {
  mode = 'discover';
  sid = null;
  hideLanding();
  clearChat();
  addSystemMsg('Discovery mode — exploring the codebase on main (read-only)');
  // Update mode toggle UI
  document.querySelectorAll('.mode-btn').forEach(b => b.classList.toggle('active', b.dataset.mode === 'plan'));
}
```

#### New function: `resumeBranch(branch)` (add after `startDiscover`):
```javascript
async function resumeBranch(branch) {
  hideLanding();
  clearChat();
  addSystemMsg(`Switching to ${branch.name}...`);

  try {
    const resp = await fetch('/api/switch-branch', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ branch: branch.name })
    });
    const result = await resp.json();
    if (!result.ok) throw new Error(result.error || 'Switch failed');
  } catch (e) {
    addErrorMsg(`Failed to switch branch: ${e.message}`);
    return;
  }

  // Restore session if exists
  mode = 'build';
  currentBranch = branch.name;
  const badge = $('branch-badge');
  if (badge) { badge.textContent = branch.name; badge.style.display = ''; }

  if (branch.session) {
    sid = branch.session.id;
    const msgs = await fetch(`/api/sessions/${sid}/messages`).then(r => r.json());
    if (msgs.length > 0) {
      loadMessages(msgs);
    }
    addSystemMsg(`Resumed ${branch.name} — ${formatTimeAgo(branch.lastActivity)}`);
  } else {
    addSystemMsg(`Switched to ${branch.name} — no previous session found`);
  }

  refreshPreview();
}
```

#### New function: `startNewFeature()` (add after `resumeBranch`):
```javascript
async function startNewFeature() {
  const input = $('feature-name-input');
  const name = input.value.trim();
  if (!name) return;

  hideLanding();
  clearChat();
  addSystemMsg(`Creating branch for: ${name}...`);

  try {
    const resp = await fetch('/api/create-branch', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name })
    });
    const result = await resp.json();
    if (!result.ok) throw new Error(result.error || 'Branch creation failed');

    mode = 'build';
    currentBranch = result.branch;
    sid = null; // fresh session, will be created on first message

    const badge = $('branch-badge');
    if (badge) { badge.textContent = result.branch; badge.style.display = ''; }

    addSystemMsg(`Branch ${result.branch} created — start building!`);
  } catch (e) {
    addErrorMsg(`Failed to create branch: ${e.message}`);
  }
}
```

#### Wire up event listeners (add after existing DOMContentLoaded or init block):
```javascript
$('landing-discover').onclick = startDiscover;
$('feature-start-btn').onclick = startNewFeature;
$('feature-name-input').addEventListener('keydown', e => {
  if (e.key === 'Enter') startNewFeature();
});
$('home-btn').onclick = () => {
  hasSent = false;
  showLanding();
};
```

#### Modify WebSocket `onopen` handler (lines 36-45):

Replace the current init logic:
```javascript
ws.onopen = () => {
  checkHealth();
  showLanding(); // <-- replaces loadStarters + loadChatHistory + loadSessions
  initPreview(portUrl(3000) + '/v2/');
};
```

#### Modify `doSend()` (lines 157-181):

Add `branch` to the WebSocket message:
```javascript
ws.send(JSON.stringify({ type: 'chat', text, sessionId: sid, model, mode, branch: currentBranch }));
```

#### Remove old welcome/starters logic:
- Remove `loadStarters()` function and its call
- Remove `#welcome` and `#starters` show/hide logic from `doSend()`
- Keep `clearChat()` and message rendering functions

---

## Version History (Checkpoints) — Branch-Scoped

### Problem
Currently checkpoints are global git tags (`checkpoint/001`). With multiple feature branches, checkpoints from one branch appear when viewing another.

### Solution
Prefix checkpoint tags with the branch slug so they're scoped per-feature.

**Tag format change:**
- Before: `checkpoint/001`
- After: `checkpoint/<branch-slug>/001` (e.g., `checkpoint/mvp-order-list-page/001`)

### Changes to `ws-handler-washmen.js`

**`createCheckpoint()` function (approximately lines 103-126):**

Update tag naming to include branch prefix:
```javascript
// Before:
const tagName = `checkpoint/${String(maxNum + 1).padStart(3, '0')}`;

// After:
const branchSlug = currentBranch.replace(/\//g, '-'); // "mvp/order-list" → "mvp-order-list"
const tagName = `checkpoint/${branchSlug}/${String(maxNum + 1).padStart(3, '0')}`;
```

Update tag listing to filter by current branch:
```javascript
// Before:
const tags = execSync('git tag -l "checkpoint/*"', ...).split('\n');

// After:
const branchSlug = currentBranch.replace(/\//g, '-');
const tags = execSync(`git tag -l "checkpoint/${branchSlug}/*"`, ...).split('\n');
```

**`undoToLastCheckpoint()` function (approximately lines 129-151):**

Same branch-scoped tag filtering when finding the previous checkpoint.

### Changes to `server-washmen.js`

**`GET /api/checkpoints` (approximately lines 334-346):**

Accept query param `?branch=mvp/order-list-page` and filter tags:
```javascript
app.get('/api/checkpoints', (req, res) => {
  const branch = req.query.branch || 'main';
  const branchSlug = branch.replace(/\//g, '-');
  // List only tags matching: checkpoint/<branchSlug>/*
});
```

### Changes to `app.js`

**History overlay (approximately lines 334-346):**

Pass `currentBranch` when fetching checkpoints:
```javascript
fetch(`/api/checkpoints?branch=${encodeURIComponent(currentBranch)}`)
```

### UI Visibility per Mode

| Mode | Version History button | Behavior |
|------|----------------------|----------|
| Discover | Hidden | No changes to track |
| Resume | Visible | Shows checkpoints scoped to resumed branch |
| Build New | Visible | Empty initially, grows as agent makes changes |

**`hideLanding()` should show the history button. `startDiscover()` should hide it:**
```javascript
// In startDiscover():
document.querySelector('[data-overlay="history"]').style.display = 'none';

// In hideLanding() (for resume/build):
document.querySelector('[data-overlay="history"]').style.display = '';
```

---

## MVP Notes — Branch-Scoped

### Problem
Currently a single `MVP_NOTES.md` file is shared across all features. With multiple branches, notes from one feature pollute another.

### Solution
Store notes in the database linked to the branch name. Remove file-based notes.

### Database Changes (`db.js`)

Add new table:
```sql
CREATE TABLE IF NOT EXISTS branch_notes (
  branch TEXT PRIMARY KEY,
  content TEXT DEFAULT '',
  updated_at INTEGER
)
```

Add helper functions:
```javascript
function getNotes(branch) {
  return db.prepare('SELECT content FROM branch_notes WHERE branch = ?').get(branch);
}

function saveNotes(branch, content) {
  db.prepare(`
    INSERT INTO branch_notes (branch, content, updated_at) VALUES (?, ?, unixepoch())
    ON CONFLICT(branch) DO UPDATE SET content = ?, updated_at = unixepoch()
  `).run(branch, content, content);
}
```

Export both functions.

### API Changes (`server-washmen.js`)

**Replace `GET /api/notes` (approximately lines 313-321):**
```javascript
app.get('/api/notes', (req, res) => {
  const branch = req.query.branch;
  if (!branch) return res.json({ content: '' });
  const row = getNotes(branch);
  res.json({ content: row ? row.content : '' });
});
```

**Replace `POST /api/notes` (approximately lines 323-331):**
```javascript
app.post('/api/notes', (req, res) => {
  const { branch, content } = req.body;
  if (!branch) return res.status(400).json({ error: 'branch required' });
  saveNotes(branch, content);
  res.json({ ok: true });
});
```

### Frontend Changes (`app.js`)

**Notes overlay open (approximately lines 280-290):**

Pass `currentBranch` when loading notes:
```javascript
// When notes overlay opens:
fetch(`/api/notes?branch=${encodeURIComponent(currentBranch)}`)
  .then(r => r.json())
  .then(data => { $('notes-editor').value = data.content || ''; });
```

**Notes save:**
```javascript
// When saving notes:
fetch('/api/notes', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ branch: currentBranch, content: $('notes-editor').value })
});
```

**`generate_mvp_notes` WebSocket message:**

Include `currentBranch` so the agent knows which branch to summarize, and the server saves to the correct branch:
```javascript
ws.send(JSON.stringify({ type: 'generate_mvp_notes', branch: currentBranch }));
```

### `ws-handler-washmen.js` Changes

**`generate_mvp_notes` handler (approximately line 182):**

After the agent generates notes, save to DB instead of writing `MVP_NOTES.md`:
```javascript
// Before: writeFileSync(join(workspaceDir, 'MVP_NOTES.md'), notesContent);
// After:
saveNotes(msg.branch || 'main', notesContent);
```

### UI Visibility per Mode

| Mode | MVP Notes button | Behavior |
|------|-----------------|----------|
| Discover | Hidden | No feature to document |
| Resume | Visible | Loads notes for the branch |
| Build New | Visible | Empty, can generate after building |

**Same pattern as Version History — hide in discover, show otherwise:**
```javascript
// In startDiscover():
document.querySelector('[data-overlay="notes"]').style.display = 'none';

// In hideLanding() (for resume/build):
document.querySelector('[data-overlay="notes"]').style.display = '';
```

---

## Acceptance Criteria

### AC-1: Landing screen displays on load
- [ ] When vibe-ui loads, the landing screen is visible in the left panel
- [ ] The chat input dock is hidden
- [ ] The right panel (preview/code/console) is visible and functional
- [ ] Budget info shows current spend / $20

### AC-2: Discover mode works
- [ ] Clicking "Discover the Codebase" hides landing, shows chat
- [ ] Mode is set to `discover`
- [ ] Agent can only use Read, Glob, Grep tools
- [ ] Agent cannot edit files or run bash commands
- [ ] System message shows "Discovery mode" indicator
- [ ] No session is saved to the database
- [ ] Repos stay on the default branch (main/master)

### AC-3: Resume feature works
- [ ] If `mvp/*` branches exist, the Resume card is visible with branch count badge
- [ ] Each branch shows its name and last activity time
- [ ] Clicking a branch triggers `POST /api/switch-branch`
- [ ] All detected repos switch to the selected branch
- [ ] If lockfile changed after checkout, `npm install` / `yarn install` runs
- [ ] Services on configured ports are restarted
- [ ] Previous chat messages are restored if a matching session exists
- [ ] Branch badge updates in the top bar
- [ ] Preview iframe refreshes after switch
- [ ] If no session exists for the branch, a system message says so

### AC-4: Build new feature works
- [ ] Text input accepts a feature description
- [ ] Pressing Enter or clicking "Start" creates a new branch
- [ ] Branch name is derived: `mvp/<slugified-description>` (max 50 chars)
- [ ] All detected repos get the new branch created from default branch
- [ ] Landing hides, empty chat shows
- [ ] Branch badge updates
- [ ] First chat message creates a new session with the `branch` column set

### AC-5: Home button returns to landing
- [ ] A Home button appears in the top bar after leaving the landing screen
- [ ] Clicking Home returns to the landing screen
- [ ] Landing re-fetches workspace data (branches may have changed)
- [ ] Chat input dock is hidden again

### AC-6: Workspace auto-discovery
- [ ] `GET /api/workspace` scans subdirectories for `.git/` repos
- [ ] vibe-ui itself is excluded from the repo list
- [ ] Package manager is detected from lockfiles (yarn.lock, pnpm-lock.yaml, package-lock.json)
- [ ] Default branch is detected from git symbolic-ref
- [ ] `mvp/*` branches are listed with matching session info from DB

### AC-7: Database migration
- [ ] `branch` column is added to `sessions` table (ALTER TABLE with try/catch)
- [ ] New sessions store the branch name
- [ ] `getSessionByBranch()` returns the most recent session for a branch
- [ ] Existing sessions without branch column still work (NULL branch)

### AC-8: Branch creation removed from WebSocket handler
- [ ] The auto-branch-creation logic in `handleChat` (lines 241-289) is removed
- [ ] Branch is passed from the client in the chat message
- [ ] Session creation uses the branch from the message

### AC-9: Service restart on branch switch
- [ ] After `git checkout`, services on detected ports are killed and relaunched
- [ ] Logs are redirected to `/tmp/<repo-name>.log`
- [ ] Frontend dev server (Vite/Webpack) auto-reloads on file changes
- [ ] API gateway is manually restarted since it has no file watcher

### AC-10: Version History is branch-scoped
- [ ] Checkpoint tags use format `checkpoint/<branch-slug>/NNN`
- [ ] `GET /api/checkpoints?branch=mvp/x` returns only checkpoints for that branch
- [ ] Undo restores only the current branch's previous checkpoint
- [ ] Version History button is hidden in Discover mode
- [ ] Version History button is visible in Resume and Build modes
- [ ] Existing global checkpoints (if any) are not broken — they just won't appear under any branch filter

### AC-11: MVP Notes are branch-scoped
- [ ] `branch_notes` table is created in the database
- [ ] `GET /api/notes?branch=mvp/x` returns notes for that branch
- [ ] `POST /api/notes` saves notes linked to a branch
- [ ] Notes overlay loads the correct branch's notes on open
- [ ] "Generate Notes" sends `currentBranch` and saves result to DB (not flat file)
- [ ] MVP Notes button is hidden in Discover mode
- [ ] MVP Notes button is visible in Resume and Build modes
- [ ] Different branches have independent notes

### AC-12: No regressions
- [ ] Existing chat functionality works in build mode
- [ ] Plan mode still works (restricted tools)
- [ ] Cost tracking still works
- [ ] Checkpoint system still works
- [ ] Code tab, console tab, preview tab all functional
- [ ] Health checks still run
- [ ] Mode toggle (Plan/Build) still works in chat view
- [ ] Visual edit feature still works

---

## Files Changed Summary

| File | Type | Changes |
|------|------|---------|
| `db.js` | Modify | Add `branch` column to sessions, add `branch_notes` table, update `createSession`, add `getSessionByBranch`, `getNotes`, `saveNotes` |
| `server-washmen.js` | Modify | Add `/api/workspace`, `/api/switch-branch`, `/api/create-branch`; update `/api/checkpoints` with branch filter; update `/api/notes` to use DB |
| `server/ws-handler-washmen.js` | Modify | Remove auto-branch logic, add discover mode, accept branch in chat msg, branch-scope checkpoints, save notes to DB |
| `public/index-v2.html` | Modify | Add landing screen HTML, home button |
| `public/styles.css` | Modify | Add landing screen styles |
| `public/app.js` | Modify | Add landing logic, remove old welcome flow, wire up event listeners, pass branch to checkpoints/notes APIs, hide icon strip buttons in discover mode |

---

## Out of Scope

- Multi-user support (single user per Codespace)
- Branch deletion from the UI
- Merging branches back to main
- Custom workspace config file (`vibe-workspace.json`) — auto-discovery only for now
- Authentication or access control
- Persistent discover mode sessions
