import { initChat, addUserMsg, addAgentMsg, addSystemMsg, addErrorMsg, showThinking, hideThinking, showActivity, hideActivity, showDiffSummary, showTurnCost, clearChat, loadMessages, addScreenshot, detectAndRenderQuestion } from './components/chat.js';
import { initPreview, refreshPreview, setDevice, navigatePreview } from './components/preview.js';
import { initNotes, onNotesOpen, onNotesGenerated } from './components/notes.js';
import { initStatus, checkHealth } from './components/status.js';
import { initBudget, updateBudget } from './components/budget.js';
import { initVisualEdit, toggleVisualEdit, deactivate as deactivateVisualEdit } from './components/visual-edit.js';

/* ═══ DOM refs ═══ */
const $ = id => document.getElementById(id);
const chat = $('chat'), input = $('input'), sendBtn = $('send-btn'), stopBtn = $('stop-btn');
const welcome = $('welcome'), starters = $('starters');
const queue = $('queue');

/* ═══ State ═══ */
let ws, sid = null, streaming = false, model = 'haiku', mode = 'build';
let hasSent = false;
let promptQueue = [];
let currentBranch = 'main';
let workspaceData = null;

/* ═══ Port URL resolver ═══ */
export function portUrl(port) {
  const host = location.hostname;
  const m = host.match(/^(.+)-(\d+)(\.app\.github\.dev)$/);
  if (m) return location.protocol + '//' + m[1] + '-' + port + m[3];
  const g = host.match(/^(\d+)-(.+)(\.gitpod\.io)$/);
  if (g) return location.protocol + '//' + port + '-' + g[2] + g[3];
  return 'http://localhost:' + port;
}

/* ═══ Landing Screen ═══ */
async function showLanding() {
  const landing = $('landing');
  const inputDock = $('input-dock');
  const homeBtn = $('home-btn');

  // Show landing, hide chat + input
  landing.style.display = 'flex';
  chat.style.display = 'none';
  inputDock.style.display = 'none';
  homeBtn.style.display = 'none';
  $('notes-btn').style.display = 'none';
  // Hide mode toggle and model select on landing (not relevant yet)
  $('mode-toggle').style.display = 'none';
  $('model-picker').style.display = 'none';

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
  const branches = (workspaceData.branches || []).filter(b => b.session);

  if (branches.length > 0) {
    resumeCard.style.display = 'flex';
    resumeCount.textContent = branches.length;
    branchList.innerHTML = '';
    for (const b of branches) {
      const item = document.createElement('div');
      item.className = 'landing-branch-item';
      const meta = b.session ? formatTimeAgo(b.session.lastUsedAt) : (b.lastActivity ? 'no session' : '');
      item.innerHTML = `<span class="landing-branch-name">${escapeHtml(b.name)}</span><span class="landing-branch-meta">${meta}</span>`;
      item.onclick = () => resumeBranch(b);
      branchList.appendChild(item);
    }
  } else {
    resumeCard.style.display = 'none';
  }
}

function hideLanding() {
  $('landing').style.display = 'none';
  chat.style.display = '';
  $('input-dock').style.display = '';
  $('home-btn').style.display = '';
  // Restore mode toggle and model select
  $('mode-toggle').style.display = '';
  $('model-picker').style.display = '';
  // Notes button shown dynamically when branch has changes
}

function startDiscover() {
  mode = 'discover';
  sid = null;
  hideLanding();
  clearChat();
  addSystemMsg('Discovery mode — exploring the codebase on main (read-only)');
  // Hide notes button (not applicable in discover)
  $('notes-btn').style.display = 'none';
  // Set mode toggle to plan (closest to discover)
  document.querySelectorAll('.mode-btn').forEach(b => b.classList.toggle('active', b.dataset.mode === 'plan'));
}

async function resumeBranch(branch) {
  hideLanding();
  clearChat();
  addSystemMsg(`Switching to ${branch.name}...`);

  try {
    const resp = await fetch('/api/switch-branch', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ branch: branch.name }),
    });
    const result = await resp.json();
    if (!result.ok) throw new Error(result.error || 'Switch failed');
  } catch (e) {
    addErrorMsg(`Failed to switch branch: ${e.message}`);
    return;
  }

  mode = 'build';
  currentBranch = branch.name;
  const badge = $('branch-badge');
  if (badge) { badge.textContent = branch.name; badge.style.display = ''; }

  if (branch.session) {
    sid = branch.session.id;
    try {
      const msgs = await (await fetch(`/api/sessions/${sid}/messages`)).json();
      if (msgs.length > 0) loadMessages(msgs);
    } catch {}
    addSystemMsg(`Resumed ${branch.name}`);
    // Show notes button — branch has prior work
    $('notes-btn').style.display = '';
  } else {
    addSystemMsg(`Switched to ${branch.name} — no previous session found`);
  }

  refreshPreview();
}

async function startNewFeature() {
  const nameInput = $('feature-name-input');
  const name = nameInput.value.trim();
  if (!name) return;

  const startBtn = $('feature-start-btn');
  startBtn.disabled = true;
  startBtn.textContent = 'Creating...';

  hideLanding();
  clearChat();
  addSystemMsg(`Creating branch for: ${name}...`);

  try {
    const resp = await fetch('/api/create-branch', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name }),
    });
    const result = await resp.json();
    if (!result.ok) throw new Error(result.error || 'Branch creation failed');

    mode = 'build';
    currentBranch = result.branch;
    sid = null;

    const badge = $('branch-badge');
    if (badge) { badge.textContent = result.branch; badge.style.display = ''; }

    addSystemMsg(`Branch ${result.branch} created — start building!`);
    nameInput.value = '';
  } catch (e) {
    addErrorMsg(`Failed to create branch: ${e.message}`);
  } finally {
    startBtn.disabled = false;
    startBtn.textContent = 'Start';
  }
}

// Wire up landing event listeners
$('landing-discover').onclick = startDiscover;
$('feature-start-btn').onclick = startNewFeature;
$('feature-name-input').addEventListener('keydown', e => {
  if (e.key === 'Enter') startNewFeature();
});
$('home-btn').onclick = () => {
  hasSent = false;
  showLanding();
};

/* ═══ WebSocket ═══ */
let wsInitialized = false;

function connect() {
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  ws = new WebSocket(`${proto}//${location.host}/ws`);

  ws.onopen = async () => {
    console.log('[ws] connected');

    if (!wsInitialized) {
      // First connection — full initialization
      wsInitialized = true;
      try {
        const resp = await fetch('/api/workspace-config');
        const cfg = await resp.json();
        window.__workspaceConfig = cfg;
      } catch { window.__workspaceConfig = { frontendPort: 3000, previewPath: '/', repos: [] }; }
      checkHealth();
      showLanding();
      const cfg = window.__workspaceConfig;
      initPreview(portUrl(cfg.frontendPort) + cfg.previewPath);
      initVisualEdit($('preview-frame'), doSend);
      setInterval(checkHealth, 10000);
    } else {
      // Reconnect — just restore health checks, don't reset UI
      console.log('[ws] reconnected — UI preserved');
      checkHealth();
    }
  };

  ws.onmessage = e => {
    const msg = JSON.parse(e.data);
    handleMessage(msg);
  };

  ws.onclose = () => {
    console.log('[ws] disconnected — reconnecting...');
    setTimeout(connect, 2000);
  };
}

function handleMessage(msg) {
  switch (msg.type) {
    case 'thinking':
      showThinking();
      break;

    case 'thinking_done':
      hideThinking();
      break;

    case 'assistant_chunk':
      hideThinking();
      addAgentMsg(msg.text, true); // streaming=true
      if (msg.sessionId) sid = msg.sessionId;
      break;

    case 'assistant_done':
      hideThinking();
      hideActivity(); // Clear any stuck spinners from the turn
      addAgentMsg(null, false); // finalize
      showTurnCost(msg.cost, model);
      streaming = false;
      sendBtn.disabled = false;
      sendBtn.style.display = 'flex';
      stopBtn.style.display = 'none';
      updateBudget(msg.totalCost);
      // Detect follow-up questions in the response
      if (msg.text) {
        detectAndRenderQuestion(msg.text, (answer) => doSend(answer));
      }
      // Process queue
      if (promptQueue.length > 0) {
        const next = promptQueue.shift();
        renderQueue();
        doSend(next);
      }
      break;

    case 'assistant':
      addAgentMsg(msg.text, false);
      break;

    case 'tool_activity':
      showActivity(msg.tool, msg.input);
      break;

    case 'tool_complete':
      hideActivity(msg.tool, msg.input);
      break;

    case 'file_diff':
      showDiffSummary(msg.files);
      if (msg.files?.length > 0) $('notes-btn').style.display = '';
      break;

    case 'code_update':
      updateCodeTab(msg.path, msg.content);
      break;

    case 'screenshot':
      addScreenshot(msg.image, msg.caption);
      // Also refresh the preview iframe
      refreshPreview();
      break;

    case 'system':
      addSystemMsg(msg.text);
      break;

    case 'error':
      hideThinking();
      hideActivity();
      addErrorMsg(msg.text, () => {
        // "Try to Fix" callback
        doSend('Fix this error: ' + msg.text);
      });
      streaming = false;
      sendBtn.disabled = false;
      sendBtn.style.display = 'flex';
      stopBtn.style.display = 'none';
      break;

    case 'model_changed':
      addSystemMsg('Model: ' + msg.model);
      break;

    case 'notes_generated':
      onNotesGenerated(msg.content);
      break;

    case 'branch_created':
      currentBranch = msg.branch;
      const badge = $('branch-badge');
      if (badge) { badge.textContent = msg.branch; badge.style.display = ''; }
      break;
  }
}

/* ═══ Send ═══ */
function doSend(text) {
  if (!text.trim()) return;

  // Deactivate visual edit mode
  deactivateVisualEdit();

  hasSent = true;
  addUserMsg(text);
  streaming = true;
  sendBtn.disabled = true;
  sendBtn.style.display = 'none';
  stopBtn.style.display = 'flex';

  ws.send(JSON.stringify({
    type: 'chat',
    text,
    sessionId: sid,
    model,
    mode,
    branch: currentBranch,
  }));
}

function send() {
  const text = input.value.trim();
  if (!text) return;
  input.value = '';
  input.style.height = 'auto';

  if (streaming) {
    // Queue it
    promptQueue.push(text);
    renderQueue();
    return;
  }

  doSend(text);
}

/* ═══ Prompt Queue ═══ */
function renderQueue() {
  queue.innerHTML = '';
  promptQueue.forEach((t, i) => {
    const chip = document.createElement('div');
    chip.className = 'queue-chip';
    chip.innerHTML = `<span>${t.slice(0, 40)}${t.length > 40 ? '...' : ''}</span><button data-i="${i}">&times;</button>`;
    chip.querySelector('button').onclick = () => { promptQueue.splice(i, 1); renderQueue(); };
    queue.appendChild(chip);
  });
  if (promptQueue.length > 0) {
    const count = document.createElement('span');
    count.className = 'queue-count';
    count.textContent = promptQueue.length + ' queued';
    queue.appendChild(count);
  }
}

/* ═══ Mode Toggle ═══ */
$('mode-toggle').onclick = e => {
  const btn = e.target.closest('.mode-btn');
  if (!btn || btn.classList.contains('active')) return;
  document.querySelectorAll('.mode-btn').forEach(b => b.classList.remove('active'));
  btn.classList.add('active');
  mode = btn.dataset.mode;
  input.placeholder = mode === 'plan'
    ? 'Describe what you want to plan...'
    : 'Describe what you want to build...';
};

/* ═══ Model Picker ═══ */
document.querySelectorAll('.model-chip').forEach(chip => {
  chip.onclick = () => {
    document.querySelectorAll('.model-chip').forEach(c => c.classList.remove('active'));
    chip.classList.add('active');
    model = chip.dataset.model;
    if (ws?.readyState === 1) {
      ws.send(JSON.stringify({ type: 'set_model', model }));
    }
  };
});

/* ═══ Resize Handle ═══ */
{
  const handle = $('resize-handle'), pane = $('left-panel');
  let dragging = false, startX, startW;
  const stripW = 44; // icon strip width
  handle.onmousedown = e => {
    dragging = true; startX = e.clientX; startW = pane.offsetWidth;
    handle.classList.add('dragging');
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
  };
  document.onmousemove = e => {
    if (!dragging) return;
    const totalW = window.innerWidth - stripW;
    const w = Math.max(totalW * 0.25, Math.min(startW + (e.clientX - startX), totalW * 0.5));
    pane.style.width = w + 'px';
  };
  document.onmouseup = () => {
    if (dragging) {
      dragging = false;
      handle.classList.remove('dragging');
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
    }
  };
}

/* ═══ Overlays ═══ */
let activeOverlay = null;
document.querySelectorAll('.strip-btn[data-overlay]').forEach(btn => {
  btn.onclick = () => {
    const name = btn.dataset.overlay;
    const el = $('overlay-' + name);

    if (activeOverlay === name) {
      el.classList.remove('open');
      btn.classList.remove('active');
      activeOverlay = null;
    } else {
      // Close any open overlay
      if (activeOverlay) {
        $('overlay-' + activeOverlay).classList.remove('open');
        document.querySelector(`.strip-btn[data-overlay="${activeOverlay}"]`).classList.remove('active');
      }
      el.classList.add('open');
      btn.classList.add('active');
      activeOverlay = name;

      // Load data for the overlay — pass branch for scoping
      // history panel removed — git commits are the version history
      if (name === 'status') checkHealth();
      if (name === 'notes') onNotesOpen(currentBranch);
    }
  };
});

// Health dots click → open status overlay
const healthDots = $('health-dots');
if (healthDots) {
  healthDots.onclick = () => {
    const el = $('overlay-status');
    if (activeOverlay === 'status') {
      el.classList.remove('open');
      activeOverlay = null;
    } else {
      if (activeOverlay) {
        $('overlay-' + activeOverlay).classList.remove('open');
        const prevBtn = document.querySelector(`[data-overlay="${activeOverlay}"]`);
        if (prevBtn) prevBtn.classList.remove('active');
      }
      el.classList.add('open');
      activeOverlay = 'status';
      checkHealth();
    }
  };
}

document.querySelectorAll('.overlay-close').forEach(btn => {
  btn.onclick = () => {
    btn.closest('.overlay').classList.remove('open');
    if (activeOverlay) {
      const prevBtn = document.querySelector(`[data-overlay="${activeOverlay}"]`);
      if (prevBtn) prevBtn.classList.remove('active');
      activeOverlay = null;
    }
  };
});

/* ═══ Right Panel Tabs ═══ */
document.querySelectorAll('.panel-tab').forEach(tab => {
  tab.onclick = () => {
    document.querySelectorAll('.panel-tab').forEach(t => t.classList.remove('active'));
    document.querySelectorAll('.tab-content').forEach(t => t.classList.remove('active'));
    tab.classList.add('active');
    $('tab-' + tab.dataset.tab).classList.add('active');
    if (tab.dataset.tab === 'code') loadCodeFiles();
  };
});

/* ═══ Device Toggle ═══ */
document.querySelectorAll('.device-btns .pbar-btn').forEach(btn => {
  btn.onclick = () => {
    document.querySelectorAll('.device-btns .pbar-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    setDevice(btn.dataset.device);
  };
});

/* ═══ Preview Bar ═══ */
$('preview-back').onclick = () => { try { $('preview-frame').contentWindow.history.back(); } catch {} };
$('preview-refresh').onclick = refreshPreview;
$('visual-edit-btn').onclick = () => {
  const isActive = toggleVisualEdit();
  $('visual-edit-btn').classList.toggle('ve-active', isActive);
};
$('preview-url').onkeydown = e => {
  if (e.key === 'Enter') {
    let url = e.target.value.trim();
    const portOnly = url.match(/^(\d{4,5})$/);
    if (portOnly) url = portUrl(portOnly[1]);
    else if (url.match(/^localhost:\d+/)) url = portUrl(url.split(':')[1]);
    else if (!url.startsWith('http')) url = 'http://' + url;
    navigatePreview(url);
  }
};

/* ═══ Console ═══ */
$('console-clear').onclick = () => { $('console-view').innerHTML = ''; };
// Wire up filter buttons (can't use inline onclick with ES modules)
document.querySelectorAll('.console-filter-btn').forEach(btn => {
  btn.onclick = () => setConsoleFilter(btn.dataset.filter);
});

/* ═══ Sessions (legacy — replaced by landing screen) ═══ */

function formatTimeAgo(ts) {
  const seconds = Math.floor(Date.now() / 1000 - ts);
  if (seconds < 60) return 'just now';
  if (seconds < 3600) return Math.floor(seconds / 60) + 'm ago';
  if (seconds < 86400) return Math.floor(seconds / 3600) + 'h ago';
  return Math.floor(seconds / 86400) + 'd ago';
}

/* ═══ Branch Badge ═══ */
// Branch is now set by landing screen actions (resumeBranch, startNewFeature)

/* ═══ Input Events ═══ */
sendBtn.onclick = send;
stopBtn.onclick = () => {
  if (ws && ws.readyState === 1) {
    ws.send(JSON.stringify({ type: 'stop' }));
  }
};
input.onkeydown = e => {
  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); }
};
input.oninput = () => {
  input.style.height = 'auto';
  input.style.height = Math.min(input.scrollHeight, 150) + 'px';
};

/* ═══ Cost Init ═══ */
(async () => {
  try {
    const data = await (await fetch('/api/cost')).json();
    updateBudget(data.totalCost);
  } catch {}
})();

/* ═══ Code Tab ═══ */
let codeFilesLoaded = false;

function updateCodeTab(path, content) {
  const codePath = $('code-path');
  const codeContent = $('code-content');
  if (codePath) codePath.textContent = path || 'Select a file to view';
  if (codeContent && content) {
    // Detect language for syntax highlighting
    const ext = (path || '').split('.').pop();
    const langMap = { tsx: 'typescript', ts: 'typescript', jsx: 'javascript', js: 'javascript', json: 'json', css: 'css', scss: 'scss', md: 'markdown', html: 'html' };
    const lang = langMap[ext] || 'plaintext';

    // Reset and re-highlight — hljs needs clean textContent + language class
    codeContent.textContent = content;
    codeContent.removeAttribute('data-highlighted');
    codeContent.className = 'language-' + lang;
    try {
      hljs.highlightElement(codeContent);
    } catch (e) {
      console.warn('hljs error:', e);
    }
  }
  // Highlight active file in sidebar
  document.querySelectorAll('.tree-file').forEach(f => {
    f.classList.toggle('active', f.dataset.path === path);
  });
}

async function loadCodeFile(path) {
  try {
    const resp = await fetch('/api/file?path=' + encodeURIComponent(path));
    const data = await resp.json();
    if (data.content) {
      updateCodeTab(data.path, data.content);
    }
  } catch {}
}

async function loadCodeFiles() {
  if (codeFilesLoaded) return;
  codeFilesLoaded = true;
  try {
    const resp = await fetch('/api/files');
    const data = await resp.json();
    const sidebar = $('code-sidebar');
    if (!sidebar || !data.files) return;

    // Build tree structure from flat file list
    sidebar.innerHTML = '';

    // Group by repo
    const repos = {};
    for (const f of data.files) {
      if (!repos[f.repo]) repos[f.repo] = [];
      repos[f.repo].push(f);
    }

    for (const [repoName, files] of Object.entries(repos)) {
      // Build nested tree
      const tree = {};
      for (const f of files) {
        const parts = f.name.split('/');
        let node = tree;
        for (let i = 0; i < parts.length; i++) {
          const part = parts[i];
          if (i === parts.length - 1) {
            // File
            if (!node.__files) node.__files = [];
            node.__files.push({ name: part, path: f.path });
          } else {
            // Directory
            if (!node[part]) node[part] = {};
            node = node[part];
          }
        }
      }

      // Render tree recursively
      function renderTree(node, container, depth) {
        // Render directories first, then files
        const dirs = Object.keys(node).filter(k => k !== '__files').sort();
        const files = (node.__files || []).sort((a, b) => a.name.localeCompare(b.name));

        for (const dirName of dirs) {
          const dir = document.createElement('div');
          dir.className = 'tree-dir';

          const toggle = document.createElement('div');
          toggle.className = 'tree-toggle';
          toggle.style.paddingLeft = (depth * 12 + 4) + 'px';
          toggle.innerHTML = `<span class="tree-arrow">▸</span> ${dirName}`;
          toggle.onclick = () => {
            const isOpen = dir.classList.toggle('open');
            toggle.querySelector('.tree-arrow').textContent = isOpen ? '▾' : '▸';
          };

          const children = document.createElement('div');
          children.className = 'tree-children';
          renderTree(node[dirName], children, depth + 1);

          dir.appendChild(toggle);
          dir.appendChild(children);
          container.appendChild(dir);
        }

        for (const file of files) {
          const item = document.createElement('div');
          item.className = 'tree-file';
          item.style.paddingLeft = (depth * 12 + 18) + 'px';
          // File type color dot
          const ext = file.name.split('.').pop();
          const colors = { tsx: '#61dafb', ts: '#3178c6', js: '#f7df1e', jsx: '#61dafb', json: '#cb8742', css: '#563d7c', scss: '#c6538c', md: '#519aba', html: '#e44d26' };
          const color = colors[ext] || '#555';
          item.innerHTML = `<span class="tree-dot" style="background:${color}"></span>${file.name}`;
          item.dataset.path = file.path;
          item.title = file.path;
          item.onclick = () => {
            sidebar.querySelectorAll('.tree-file').forEach(f => f.classList.remove('active'));
            item.classList.add('active');
            loadCodeFile(file.path);
          };
          container.appendChild(item);
        }
      }

      const repoGroup = document.createElement('div');
      repoGroup.className = 'tree-repo';

      const repoHeader = document.createElement('div');
      repoHeader.className = 'tree-repo-header';
      repoHeader.innerHTML = `<span class="tree-arrow">▾</span> ${repoName}`;
      repoHeader.onclick = () => {
        const isOpen = repoGroup.classList.toggle('collapsed');
        repoHeader.querySelector('.tree-arrow').textContent = isOpen ? '▸' : '▾';
      };

      const repoChildren = document.createElement('div');
      repoChildren.className = 'tree-children';
      renderTree(tree, repoChildren, 1);

      repoGroup.appendChild(repoHeader);
      repoGroup.appendChild(repoChildren);
      sidebar.appendChild(repoGroup);
    }

    // Auto-load first file
    if (data.files.length > 0) {
      loadCodeFile(data.files[0].path);
    }
  } catch {}
}


/* ═══ Console ═══ */
const CONSOLE_MAX_ENTRIES = 500;
let consoleFilter = 'all'; // 'all' | 'error' | 'warn' | 'info'
let consoleUnread = 0;

function escapeHtml(str) {
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function addConsoleEntry(level, message) {
  const view = $('console-view');
  if (!view) return;

  // Cap entries
  while (view.children.length >= CONSOLE_MAX_ENTRIES) {
    view.removeChild(view.firstChild);
  }

  const entry = document.createElement('div');
  entry.className = 'console-entry';
  entry.dataset.level = level;
  const ts = new Date().toLocaleTimeString('en-US', { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' });
  entry.innerHTML = `<span class="ts">${ts}</span><span class="lvl ${level}">${level.toUpperCase()}</span><span class="msg">${escapeHtml(message)}</span>`;

  // Apply current filter
  if (consoleFilter !== 'all' && level !== consoleFilter) {
    entry.style.display = 'none';
  }

  view.appendChild(entry);
  view.scrollTop = view.scrollHeight;

  // Update unread badge (errors only) if console tab is not active
  const consoleTab = document.querySelector('[data-tab="console"]');
  if (consoleTab && !consoleTab.classList.contains('active') && level === 'error') {
    consoleUnread++;
    updateConsoleBadge();
  }
}

function updateConsoleBadge() {
  let badge = document.getElementById('console-badge');
  const consoleTab = document.querySelector('[data-tab="console"]');
  if (!consoleTab) return;
  if (consoleUnread > 0) {
    if (!badge) {
      badge = document.createElement('span');
      badge.id = 'console-badge';
      badge.className = 'console-badge';
      consoleTab.appendChild(badge);
    }
    badge.textContent = consoleUnread > 99 ? '99+' : consoleUnread;
    badge.style.display = '';
  } else if (badge) {
    badge.style.display = 'none';
  }
}

function setConsoleFilter(filter) {
  consoleFilter = filter;
  // Update active filter button
  document.querySelectorAll('.console-filter-btn').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.filter === filter);
  });
  // Show/hide entries
  const view = $('console-view');
  if (!view) return;
  for (const entry of view.children) {
    if (filter === 'all' || entry.dataset.level === filter) {
      entry.style.display = '';
    } else {
      entry.style.display = 'none';
    }
  }
}

// Clear unread when switching to console tab
document.addEventListener('click', (e) => {
  const tab = e.target.closest('[data-tab="console"]');
  if (tab) {
    consoleUnread = 0;
    updateConsoleBadge();
  }
});

// Pipe tool activities to console
const _origShowActivity = showActivity;
// Override showActivity to also log to console
const origHandleMessage = handleMessage;

// Poll for console output from the server
async function pollConsole() {
  try {
    const resp = await fetch('/api/console');
    const data = await resp.json();
    if (data.entries && data.entries.length > 0) {
      data.entries.forEach(e => addConsoleEntry(e.level, e.message));
    }
  } catch {}
}
setInterval(pollConsole, 5000);

// Add initial console message — dynamically fetch service status
setTimeout(async () => {
  addConsoleEntry('info', 'vibe-ui console connected');
  try {
    const resp = await fetch('/api/service-health');
    const data = await resp.json();
    if (data.services) {
      const summary = data.services.map(s => `${s.name} :${s.port} ${s.status === 'healthy' ? '✓' : '✗'}`).join(', ');
      addConsoleEntry('info', `Services: ${summary}`);
    }
  } catch {}
}, 1000);

/* ═══ Init ═══ */
initChat(chat);
initNotes($('notes-editor'), $('notes-gen'), $('notes-save'), $('notes-copy'), () => ws);
initStatus($('status-list'));
initBudget($('budget-fill'), $('budget-amount'));

connect();
