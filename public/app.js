import { initChat, addUserMsg, addAgentMsg, addSystemMsg, addErrorMsg, showThinking, hideThinking, showActivity, hideActivity, showDiffSummary, clearChat, loadMessages } from './components/chat.js';
import { initPreview, refreshPreview, setDevice, navigatePreview } from './components/preview.js';
import { initHistory, loadHistory } from './components/history.js';
import { initNotes } from './components/notes.js';
import { initStatus, checkHealth } from './components/status.js';
import { initBudget, updateBudget } from './components/budget.js';

/* ═══ DOM refs ═══ */
const $ = id => document.getElementById(id);
const chat = $('chat'), input = $('input'), sendBtn = $('send-btn');
const welcome = $('welcome'), starters = $('starters');
const queue = $('queue'), branchLock = $('branch-lock'), branchInput = $('branch-input');
const inputDock = $('input-dock');

/* ═══ State ═══ */
let ws, sid = null, streaming = false, model = 'sonnet', mode = 'build';
let hasSent = false;
let promptQueue = [];
let currentBranch = 'main';

/* ═══ Port URL resolver ═══ */
export function portUrl(port) {
  const host = location.hostname;
  const m = host.match(/^(.+)-(\d+)(\.app\.github\.dev)$/);
  if (m) return location.protocol + '//' + m[1] + '-' + port + m[3];
  const g = host.match(/^(\d+)-(.+)(\.gitpod\.io)$/);
  if (g) return location.protocol + '//' + port + '-' + g[2] + g[3];
  return 'http://localhost:' + port;
}

/* ═══ WebSocket ═══ */
function connect() {
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  ws = new WebSocket(`${proto}//${location.host}/ws`);

  ws.onopen = () => {
    console.log('[ws] connected');
    checkHealth();
    loadStarters();
    loadSessions();
    loadChatHistory();
    initPreview(portUrl(3000));
    setInterval(checkHealth, 10000);
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
      addAgentMsg(null, false); // finalize
      streaming = false;
      sendBtn.disabled = false;
      updateBudget(msg.totalCost);
      loadSessions();
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
      break;

    case 'system':
      addSystemMsg(msg.text);
      break;

    case 'error':
      hideThinking();
      addErrorMsg(msg.text, () => {
        // "Try to Fix" callback
        doSend('Fix this error: ' + msg.text);
      });
      streaming = false;
      sendBtn.disabled = false;
      break;

    case 'undo_result':
      addSystemMsg('Restored to previous checkpoint');
      refreshPreview();
      break;

    case 'checkpoint_created':
      addSystemMsg('Checkpoint: ' + msg.name);
      loadHistory();
      break;

    case 'model_changed':
      addSystemMsg('Model: ' + msg.model);
      break;

    case 'branch_created':
      addSystemMsg('Branch created: ' + msg.branch);
      currentBranch = msg.branch;
      branchLock.style.display = 'none';
      inputDock.style.display = '';
      break;
  }
}

/* ═══ Send ═══ */
function doSend(text) {
  if (!text.trim()) return;

  // Hide welcome
  if (!hasSent) {
    hasSent = true;
    welcome.style.display = 'none';
    starters.style.display = 'none';
  }

  addUserMsg(text);
  streaming = true;
  sendBtn.disabled = true;

  ws.send(JSON.stringify({
    type: 'chat',
    text,
    sessionId: sid,
    model,
    mode, // 'plan' or 'build'
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

/* ═══ Model Select ═══ */
$('model-select').onchange = e => {
  model = e.target.value;
  if (ws?.readyState === 1) {
    ws.send(JSON.stringify({ type: 'set_model', model }));
  }
};

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

      // Load data for the overlay
      if (name === 'history') loadHistory();
      if (name === 'status') checkHealth();
    }
  };
});

document.querySelectorAll('.overlay-close').forEach(btn => {
  btn.onclick = () => {
    btn.closest('.overlay').classList.remove('open');
    if (activeOverlay) {
      document.querySelector(`.strip-btn[data-overlay="${activeOverlay}"]`).classList.remove('active');
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

/* ═══ Starters ═══ */
const starterData = [
  { t: 'Add a new data table page', d: 'Create a page with a sortable, paginated data grid' },
  { t: 'Add a filter to an existing page', d: 'Add filter bar with dropdowns to an existing table' },
  { t: 'Add a form that submits to the API', d: 'Build a form with validation that posts to an endpoint' },
  { t: 'Add a metric card', d: 'Dashboard card that fetches and auto-refreshes data' },
  { t: 'Modify an existing page', d: 'Add fields, columns, or sections to a page' },
  { t: 'Add a new API endpoint', d: 'New route consuming an existing hook method' },
];

async function loadStarters() {
  try {
    const data = await (await fetch('/api/prompts')).json();
    starters.innerHTML = '';
    (data.starters || starterData).forEach(s => {
      const card = document.createElement('div');
      card.className = 's-card';
      card.innerHTML = `<div class="st">${s.title || s.t}</div><div class="sd">${(s.prompt || s.d || '').slice(0, 80)}</div>`;
      card.onclick = () => {
        input.value = s.prompt || s.d || s.t;
        input.focus();
        input.dispatchEvent(new Event('input'));
      };
      starters.appendChild(card);
    });
  } catch {
    // Use fallback data
    starters.innerHTML = '';
    starterData.forEach(s => {
      const card = document.createElement('div');
      card.className = 's-card';
      card.innerHTML = `<div class="st">${s.t}</div><div class="sd">${s.d}</div>`;
      card.onclick = () => { input.value = s.t; input.focus(); };
      starters.appendChild(card);
    });
  }
}

/* ═══ Sessions ═══ */
async function loadSessions() {
  // Sessions are shown in history overlay now
}

async function loadChatHistory() {
  try {
    const sessions = await (await fetch('/api/sessions')).json();
    if (sessions.length > 0) {
      sid = sessions[0].id;
      const msgs = await (await fetch('/api/sessions/' + sid + '/messages')).json();
      if (msgs.length > 0) {
        hasSent = true;
        welcome.style.display = 'none';
        starters.style.display = 'none';
        loadMessages(msgs);
      }
    }
  } catch {}
}

/* ═══ Branch Check ═══ */
async function checkBranch() {
  try {
    const resp = await fetch('/api/branch');
    const data = await resp.json();
    currentBranch = data.branch || 'main';
    if (currentBranch === 'main' || currentBranch === 'master') {
      branchLock.style.display = 'flex';
      inputDock.style.display = 'none';
    }
  } catch {
    // Branch API might not exist yet — show input
  }
}

branchInput.onkeydown = e => {
  if (e.key === 'Enter') {
    const name = branchInput.value.trim().replace(/\s+/g, '-').toLowerCase();
    if (!name) return;
    ws.send(JSON.stringify({ type: 'create_branch', name }));
    branchInput.value = '';
  }
};

/* ═══ Input Events ═══ */
sendBtn.onclick = send;
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

/* ═══ Init ═══ */
initChat(chat);
initHistory($('history-list'));
initNotes($('notes-editor'), $('notes-gen'), $('notes-save'), $('notes-copy'), ws);
initStatus($('status-list'));
initBudget($('budget-fill'), $('budget-amount'));

connect();
