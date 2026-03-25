import { initChat, addUserMsg, addAgentMsg, addSystemMsg, addErrorMsg, showThinking, hideThinking, showActivity, hideActivity, hideWorking, showDiffSummary, showTurnCost, clearChat, loadMessages, addScreenshot, detectAndRenderQuestion, getTurnFooter, finalizeTurnFooter } from './components/chat.js';
import { initPreview, refreshPreview, setDevice, navigatePreview } from './components/preview.js';
import { initNotes, onNotesOpen, onNotesGenerated } from './components/notes.js';
import { initStatus, checkHealth } from './components/status.js';
import { initBudget, updateBudget } from './components/budget.js';
import './js/features/welcome.js';
import { initVisualEdit, toggleVisualEdit, deactivate as deactivateVisualEdit, highlightChange, getPendingChangeSelector, toggleHistory } from './components/visual-edit.js';

/* ═══ DOM refs ═══ */
const $ = id => document.getElementById(id);
const chat = $('chat'), input = $('input'), sendBtn = $('send-btn'), stopBtn = $('stop-btn');
const welcome = $('welcome'), starters = $('starters');
const queue = $('queue');

/* ═══ State ═══ */
let ws, sid = null, streaming = false, model = 'sonnet', mode = 'build';
let hasSent = false;
let promptQueue = [];
let currentBranch = 'main';
let pendingAttachments = []; // { path, name, type, preview }
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

  // Track the server-reported active branch
  if (workspaceData.activeBranch) {
    currentBranch = workspaceData.activeBranch;
    // Show branch badge on landing if on an mvp branch
    const badge = $('branch-badge');
    if (badge && currentBranch.startsWith('mvp/')) {
      badge.textContent = currentBranch;
      badge.style.display = '';
    }
  }

  // Budget
  const budgetEl = $('landing-budget');
  if (budgetEl && workspaceData.budget) {
    budgetEl.textContent = `$${workspaceData.budget.spent.toFixed(2)} / $${workspaceData.budget.limit} budget today`;
  }

  // Populate resume branches — show all mvp/* branches (local + remote)
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
      // Highlight the currently active branch
      if (b.name === currentBranch) item.classList.add('landing-branch-active');
      let meta = '';
      if (b.session) {
        meta = formatTimeAgo(b.session.lastUsedAt);
      } else if (b.local === false) {
        meta = 'remote';
      }
      const details = [];
      const commits = b.commitCount || 0;
      const files = b.filesChanged || 0;
      details.push(`${commits} commit${commits !== 1 ? 's' : ''}`);
      details.push(`${files} file${files !== 1 ? 's' : ''}`);
      if (b.cost > 0) details.push(`$${b.cost.toFixed(2)}`);
      if (meta) details.push(meta);
      item.innerHTML = `
        <div class="landing-branch-name">${escapeHtml(b.name.replace('mvp/', ''))}</div>
        <div class="landing-branch-meta">${details.join(' · ')}</div>
      `;
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

/* ═══ Switch Progress Overlay ═══ */
function showSwitchProgress(branchName, steps) {
  const overlay = $('switch-progress');
  const title = $('switch-progress-title');
  const stepsEl = $('switch-progress-steps');

  // Hide landing and chat, show progress
  $('landing').style.display = 'none';
  chat.style.display = 'none';
  $('input-dock').style.display = 'none';
  $('home-btn').style.display = 'none';
  $('mode-toggle').style.display = 'none';
  $('model-picker').style.display = 'none';

  title.textContent = `Switching to ${branchName}...`;
  stepsEl.innerHTML = '';
  for (const step of steps) {
    const el = document.createElement('div');
    el.className = 'switch-step';
    el.id = `step-${step.id}`;
    el.innerHTML = `<span class="switch-step-icon"><span class="step-dot"></span></span><span>${step.label}</span>`;
    stepsEl.appendChild(el);
  }
  overlay.style.display = 'flex';
}

function updateSwitchStep(stepId, status) {
  const el = $(`step-${stepId}`);
  if (!el) return;
  const iconEl = el.querySelector('.switch-step-icon');
  if (status === 'active') {
    el.className = 'switch-step active';
    iconEl.innerHTML = '<span class="step-spinner"></span>';
  } else if (status === 'done') {
    el.className = 'switch-step done';
    iconEl.innerHTML = '<span class="step-check">&#10003;</span>';
  }
}

function hideSwitchProgress() {
  $('switch-progress').style.display = 'none';
  chat.style.display = '';
  $('input-dock').style.display = '';
  $('home-btn').style.display = '';
  $('mode-toggle').style.display = '';
  $('model-picker').style.display = '';
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
  // If already on this branch, just go back to the existing chat — no reload needed
  if (branch.name === currentBranch && hasSent) {
    hideLanding();
    return;
  }

  hideLanding();
  clearChat();

  let wasSkipped = false;
  try {
    const resp = await fetch('/api/switch-branch', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ branch: branch.name }),
    });
    const result = await resp.json();
    if (!result.ok) throw new Error(result.error || 'Switch failed');
    wasSkipped = result.skipped;
  } catch (e) {
    hideSwitchProgress();
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
    // Check if there's an undoable commit and show undo button
    try {
      const preview = await fetch(`/api/sessions/${sid}/undo-preview`).then(r => r.json());
      if (preview.ok && preview.commits.length > 0) attachUndoButton();
    } catch {}
    // Show notes button — branch has prior work
    $('notes-btn').style.display = '';
  } else {
    sid = null;
    addSystemMsg(`Switched to ${branch.name} — no previous session found`);
  }

  // Only refresh preview if we actually switched branches; if skipped, preview is already loaded
  if (!wasSkipped) refreshPreview();
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
  ws = new WebSocket(`${proto}//${location.host}/ws?token=${window.__VIBE_TOKEN}`);

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
      // Show workspace name in top bar
      const wsNameEl = $('workspace-name');
      if (wsNameEl && window.__workspaceConfig.name) {
        wsNameEl.textContent = window.__workspaceConfig.name;
      }
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
      finalizeTurnFooter();
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
      hideActivity();
      hideWorking();
      addAgentMsg(null, false); // finalize
      // Add undo button only when files were changed
      if (sid && msg.filesChanged > 0) attachUndoButton();
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
      // Trigger change confirmation pulse if a visual edit is pending
      { const sel = getPendingChangeSelector();
        if (sel) setTimeout(() => highlightChange(sel), 1500); }
      break;

    case 'screenshot':
      addScreenshot(msg.image, msg.caption);
      // Also refresh the preview iframe
      refreshPreview();
      // Trigger change confirmation pulse if a visual edit is pending
      { const sel = getPendingChangeSelector();
        if (sel) setTimeout(() => highlightChange(sel), 2000); }
      break;

    case 'switch_progress':
      if (msg.phase === 'start') {
        showSwitchProgress(msg.branch, msg.steps);
      } else if (msg.phase === 'step') {
        updateSwitchStep(msg.stepId, msg.status);
      } else if (msg.phase === 'complete') {
        hideSwitchProgress();
      }
      break;

    case 'system':
      addSystemMsg(msg.text);
      break;

    case 'error':
      hideThinking();
      hideActivity();
      hideWorking();
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

    case 'console_entries':
      if (msg.entries && msg.entries.length > 0) {
        msg.entries.forEach(e => addConsoleEntry(e.level, e.message, e.source, e.timestamp));
      }
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
  if (!text.trim() && pendingAttachments.length === 0) return;
  finalizeTurnFooter();

  // Intercept build-intent messages in plan mode
  if (mode === 'plan' && /\b(build|implement|execute|create|code|start building|do it|make it|go ahead)\b/i.test(text)) {
    addSystemMsg('You\'re in Plan mode — switch to Build mode to start implementing.');
    // Highlight the Build button briefly
    const buildBtn = document.querySelector('.mode-btn[data-mode="build"]');
    if (buildBtn) {
      buildBtn.style.animation = 'none';
      buildBtn.offsetHeight; // reflow
      buildBtn.style.animation = 'pulse-highlight .6s ease 2';
    }
    return;
  }

  // Deactivate visual edit mode
  deactivateVisualEdit();

  // Prepend attachment paths to prompt
  let fullText = text;
  if (pendingAttachments.length > 0) {
    const attachRefs = pendingAttachments.map(a =>
      `[Attached ${a.type === 'image' ? 'image' : 'file'}: ${a.path}]`
    ).join('\n');
    fullText = attachRefs + '\n\n' + text;
    // Show attachments in user message
    const previewHtml = pendingAttachments
      .filter(a => a.type === 'image')
      .map(a => `<img src="${a.preview}" class="attach-preview">`)
      .join('');
    addUserMsg(text, previewHtml);
    pendingAttachments = [];
    clearAttachmentPreview();
  } else {
    addUserMsg(text);
  }

  hasSent = true;
  streaming = true;
  sendBtn.disabled = true;
  sendBtn.style.display = 'none';
  stopBtn.style.display = 'flex';

  ws.send(JSON.stringify({
    type: 'chat',
    text: fullText,
    sessionId: sid,
    model,
    mode,
    branch: currentBranch,
  }));
}

function send() {
  const text = input.value.trim();
  if (!text && pendingAttachments.length === 0) return;
  input.value = '';
  input.style.height = 'auto';

  if (streaming) {
    promptQueue.push(text);
    renderQueue();
    return;
  }

  doSend(text);
}

/* ═══ Attachments ═══ */
async function handleAttachment(file) {
  const reader = new FileReader();
  reader.onload = async () => {
    const base64 = reader.result.split(',')[1];
    const isImage = file.type.startsWith('image/');

    try {
      const resp = await fetch('/api/upload', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ filename: file.name, data: base64, mediaType: file.type }),
      });
      const data = await resp.json();
      if (data.path) {
        pendingAttachments.push({
          path: data.path,
          name: file.name,
          type: isImage ? 'image' : 'file',
          preview: isImage ? reader.result : null,
        });
        showAttachmentPreview();
      }
    } catch (e) {
      console.error('[upload]', e);
    }
  };
  reader.readAsDataURL(file);
}

function showAttachmentPreview() {
  let bar = $('attachment-bar');
  if (!bar) {
    bar = document.createElement('div');
    bar.id = 'attachment-bar';
    bar.className = 'attachment-bar';
    // Insert above the input-row, inside input-dock
    const dock = $('input-dock');
    dock.insertBefore(bar, dock.firstChild);
  }
  bar.innerHTML = pendingAttachments.map((a, i) => `
    <div class="attach-chip">
      ${a.type === 'image' ? `<img src="${a.preview}" class="attach-thumb">` : '<span class="attach-file-icon">📄</span>'}
      <span class="attach-name">${a.name}</span>
      <button class="attach-remove" data-idx="${i}">&times;</button>
    </div>
  `).join('');
  bar.querySelectorAll('.attach-remove').forEach(btn => {
    btn.onclick = () => {
      pendingAttachments.splice(parseInt(btn.dataset.idx), 1);
      if (pendingAttachments.length === 0) clearAttachmentPreview();
      else showAttachmentPreview();
    };
  });
}

function clearAttachmentPreview() {
  const bar = $('attachment-bar');
  if (bar) bar.remove();
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

/* ═══ Undo ═══ */
function attachUndoButton() {
  // Remove any existing undo buttons first
  chat.querySelectorAll('.undo-btn').forEach(b => b.remove());

  if (!sid) return;
  // Prefer the last existing turn-footer (e.g. after undo reloads history),
  // only create a new one if none exists yet
  const allFooters = chat.querySelectorAll('.turn-footer');
  const footer = allFooters.length > 0 ? allFooters[allFooters.length - 1] : getTurnFooter();

  const undoBtn = document.createElement('button');
  undoBtn.className = 'undo-btn';
  undoBtn.innerHTML = '\u21A9 Undo';
  undoBtn.onclick = async () => {
    undoBtn.disabled = true;
    undoBtn.textContent = 'Checking\u2026';
    try {
      const preview = await fetch(`/api/sessions/${sid}/undo-preview`).then(r => r.json());
      if (!preview.ok) {
        undoBtn.innerHTML = '\u21A9 Undo';
        undoBtn.disabled = false;
        addSystemMsg(preview.error || 'Nothing to undo');
        return;
      }
      showUndoConfirmation(preview, async () => {
        undoBtn.textContent = 'Reverting\u2026';
        const data = await fetch(`/api/sessions/${sid}/undo`, { method: 'POST' }).then(r => r.json());
        clearChat();
        if (data.messages?.length > 0) loadMessages(data.messages);
        refreshPreview();
        const reverted = data.revertResults?.filter(r => r.status === 'reverted').length || 0;
        addSystemMsg(`Undo complete \u2014 reverted ${reverted} repo${reverted !== 1 ? 's' : ''}`);
        // Re-attach undo to the new last message so user can keep undoing
        attachUndoButton();
      }, () => {
        undoBtn.innerHTML = '\u21A9 Undo';
        undoBtn.disabled = false;
      });
    } catch (err) {
      undoBtn.innerHTML = '\u21A9 Undo';
      undoBtn.disabled = false;
      addSystemMsg('Undo failed: ' + err.message);
    }
  };
  footer.prepend(undoBtn);
}

/* ═══ Undo Confirmation ═══ */
function showUndoConfirmation(preview, onConfirm, onCancel) {
  const overlay = document.createElement('div');
  overlay.className = 'undo-overlay';

  const fileCount = preview.commits.reduce((sum, c) => sum + c.filesChanged.length, 0);
  const repoItems = preview.commits
    .filter(c => c.filesChanged.length > 0)
    .map(c => `<div class="undo-repo"><span class="undo-repo-name">${escapeHtml(c.repo)}</span><span class="undo-repo-files">${c.filesChanged.map(f => escapeHtml(f.split('/').pop())).join(', ')}</span></div>`).join('');

  overlay.innerHTML = `
    <div class="undo-modal">
      <div class="undo-header">Undo last turn?</div>
      <div class="undo-desc">This will revert file changes and remove the last message pair.</div>
      ${repoItems ? `<div class="undo-repos">${repoItems}</div>` : '<div class="undo-no-changes">No file changes to revert</div>'}
      ${fileCount ? `<div class="undo-summary">${fileCount} file${fileCount > 1 ? 's' : ''} across ${preview.commits.length} repo${preview.commits.length > 1 ? 's' : ''} will be reverted</div>` : ''}
      <div class="undo-actions">
        <button class="undo-cancel-btn">Cancel</button>
        <button class="undo-confirm-btn">Undo</button>
      </div>
    </div>
  `;

  overlay.querySelector('.undo-cancel-btn').onclick = () => { overlay.remove(); onCancel(); };
  overlay.querySelector('.undo-confirm-btn').onclick = () => { overlay.remove(); onConfirm(); };
  overlay.onclick = (e) => { if (e.target === overlay) { overlay.remove(); onCancel(); } };
  document.body.appendChild(overlay);
}

/* ═══ Overlays ═══ */
import { trapFocus } from './js/utils/focus-trap.js';
let activeOverlay = null;
let releaseTrap = null;
document.querySelectorAll('.strip-btn[data-overlay]').forEach(btn => {
  btn.onclick = () => {
    const name = btn.dataset.overlay;
    const el = $('overlay-' + name);

    if (activeOverlay === name) {
      el.classList.remove('open');
      btn.classList.remove('active');
      activeOverlay = null;
      releaseTrap?.(); releaseTrap = null;
    } else {
      // Close any open overlay
      if (activeOverlay) {
        $('overlay-' + activeOverlay).classList.remove('open');
        document.querySelector(`.strip-btn[data-overlay="${activeOverlay}"]`).classList.remove('active');
        releaseTrap?.(); releaseTrap = null;
      }
      el.classList.add('open');
      btn.classList.add('active');
      activeOverlay = name;
      releaseTrap = trapFocus(el);

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
      releaseTrap?.(); releaseTrap = null;
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
$('ve-history-btn').onclick = () => toggleHistory();
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
$('console-clear').onclick = () => {
  $('console-view').innerHTML = '';
  consoleEntries = [];
  consoleServiceFilter = 'all';
  consoleSearchTerm = '';
  const searchInput = $('console-search');
  if (searchInput) searchInput.value = '';
  knownServices.clear();
  const tabsContainer = $('console-service-tabs');
  if (tabsContainer) {
    tabsContainer.innerHTML = '<button class="console-service-btn active" data-service="all">All</button>';
    tabsContainer.querySelector('[data-service="all"]').onclick = () => setConsoleServiceFilter('all');
  }
};
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

// Click to attach
$('attach-btn').onclick = () => $('file-input').click();
$('file-input').onchange = (e) => {
  for (const file of e.target.files) handleAttachment(file);
  e.target.value = '';
};

// Paste images/files
input.addEventListener('paste', (e) => {
  const items = e.clipboardData?.items;
  if (!items) return;
  for (const item of items) {
    if (item.kind === 'file') {
      e.preventDefault();
      handleAttachment(item.getAsFile());
    }
  }
});

// Drop files
const inputDock = $('input-dock');
inputDock.addEventListener('dragover', (e) => { e.preventDefault(); inputDock.classList.add('drag-over'); });
inputDock.addEventListener('dragleave', () => inputDock.classList.remove('drag-over'));
inputDock.addEventListener('drop', (e) => {
  e.preventDefault();
  inputDock.classList.remove('drag-over');
  for (const file of e.dataTransfer.files) {
    handleAttachment(file);
  }
});

/* ═══ Cost Init ═══ */
(async () => {
  try {
    const data = await (await fetch('/api/cost')).json();
    updateBudget(data.totalCost, data.dailyBudget);
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
const CONSOLE_MAX_ENTRIES = 1000;
let consoleFilter = 'all'; // 'all' | 'error' | 'warn' | 'info'
let consoleServiceFilter = 'all';
let consoleSearchTerm = '';
let consoleSearchDebounce = null;
let consoleUnread = 0;
let consoleEntries = []; // { level, message, source, timestamp, el }
let consoleAutoScroll = true;
const knownServices = new Set();

// Service badge colors — rotate through a palette
const SERVICE_COLORS = [
  { bg: 'rgba(59,130,246,0.15)', fg: '#3b82f6' },  // blue
  { bg: 'rgba(16,185,129,0.15)', fg: '#10b981' },   // green
  { bg: 'rgba(139,92,246,0.15)', fg: '#8b5cf6' },   // purple
  { bg: 'rgba(245,158,11,0.15)', fg: '#f59e0b' },   // amber
  { bg: 'rgba(236,72,153,0.15)', fg: '#ec4899' },    // pink
  { bg: 'rgba(6,182,212,0.15)', fg: '#06b6d4' },     // cyan
];
const serviceColorMap = new Map();
function getServiceColor(source) {
  if (!source) return SERVICE_COLORS[0];
  if (!serviceColorMap.has(source)) {
    serviceColorMap.set(source, SERVICE_COLORS[serviceColorMap.size % SERVICE_COLORS.length]);
  }
  return serviceColorMap.get(source);
}

function getServiceLabel(source) {
  if (!source) return '??';
  // Strip mock- prefix and return readable name (e.g., "mock-ops-frontend" → "Ops Frontend")
  return source.replace(/^mock-/, '').split('-').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
}

function escapeHtml(str) {
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function highlightSearchTerm(html, term) {
  if (!term) return html;
  const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return html.replace(new RegExp(`(${escaped})`, 'gi'), '<span class="search-highlight">$1</span>');
}

function shouldShowEntry(entry) {
  if (consoleFilter !== 'all' && entry.level !== consoleFilter) return false;
  if (consoleServiceFilter !== 'all' && entry.source !== consoleServiceFilter) return false;
  if (consoleSearchTerm && !entry.message.toLowerCase().includes(consoleSearchTerm.toLowerCase())) return false;
  return true;
}

function renderEntryHTML(entry) {
  const ts = new Date(entry.timestamp || Date.now()).toLocaleTimeString('en-US', { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' });
  const color = getServiceColor(entry.source);
  const shortName = entry.source ? entry.source.replace(/^mock-/, '').split('-')[0] : '';
  let msgHtml = escapeHtml(entry.message);
  if (consoleSearchTerm) {
    msgHtml = highlightSearchTerm(msgHtml, consoleSearchTerm);
  }
  const sourceBadge = entry.source
    ? `<span class="source-badge" style="background:${color.bg};color:${color.fg}" title="${escapeHtml(entry.source)}">${escapeHtml(shortName)}</span>`
    : '';
  return `<span class="ts">${ts}</span>${sourceBadge}<span class="lvl ${entry.level}">${entry.level.toUpperCase()}</span><span class="msg">${msgHtml}</span>`;
}

function addConsoleEntry(level, message, source, timestamp) {
  const view = $('console-view');
  if (!view) return;

  // Extract source from message if not provided (legacy format: "[name] message")
  if (!source) {
    const match = message.match(/^\[([^\]]+)\]\s*(.*)/);
    if (match) {
      source = match[1];
      message = match[2];
    }
  }

  const entryData = { level, message, source: source || '', timestamp: timestamp || Date.now() };

  // Track service and add tab if new
  if (source && !knownServices.has(source)) {
    knownServices.add(source);
    addServiceTab(source);
  }

  // Cap entries
  while (consoleEntries.length >= CONSOLE_MAX_ENTRIES) {
    const removed = consoleEntries.shift();
    if (removed.el && removed.el.parentNode) removed.el.parentNode.removeChild(removed.el);
  }

  const entry = document.createElement('div');
  entry.className = 'console-entry';
  entry.dataset.level = level;
  entry.dataset.source = source || '';
  entry.innerHTML = renderEntryHTML(entryData);
  entryData.el = entry;
  consoleEntries.push(entryData);

  // Apply current filters
  if (!shouldShowEntry(entryData)) {
    entry.style.display = 'none';
  }

  // Smart auto-scroll: check before appending
  const wasAtBottom = consoleAutoScroll;
  view.appendChild(entry);

  if (wasAtBottom) {
    view.scrollTop = view.scrollHeight;
  } else {
    const jumpBtn = $('console-jump');
    if (jumpBtn) jumpBtn.classList.remove('hidden');
  }

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
  document.querySelectorAll('.console-filter-btn').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.filter === filter);
  });
  applyConsoleFilters();
}

function setConsoleServiceFilter(service) {
  consoleServiceFilter = service;
  document.querySelectorAll('.console-service-btn').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.service === service);
  });
  applyConsoleFilters();
}

function applyConsoleFilters() {
  for (const entry of consoleEntries) {
    if (!entry.el) continue;
    const show = shouldShowEntry(entry);
    entry.el.style.display = show ? '' : 'none';
    // Re-render to update search highlights
    if (show && consoleSearchTerm) {
      entry.el.innerHTML = renderEntryHTML(entry);
    }
  }
}

function addServiceTab(source) {
  const container = $('console-service-tabs');
  if (!container) return;
  if (container.querySelector(`[data-service="${CSS.escape(source)}"]`)) return;
  const btn = document.createElement('button');
  btn.className = 'console-service-btn';
  btn.dataset.service = source;
  btn.textContent = getServiceLabel(source);
  btn.title = source;
  const color = getServiceColor(source);
  btn.style.color = color.fg;
  btn.onclick = () => setConsoleServiceFilter(source);
  container.appendChild(btn);
  // Re-wire the "All" button
  const allBtn = container.querySelector('[data-service="all"]');
  if (allBtn) allBtn.onclick = () => setConsoleServiceFilter('all');
}

// Smart auto-scroll detection
(() => {
  const view = $('console-view');
  if (!view) return;
  view.addEventListener('scroll', () => {
    const threshold = 50;
    const atBottom = view.scrollHeight - view.scrollTop - view.clientHeight < threshold;
    consoleAutoScroll = atBottom;
    if (atBottom) {
      const jumpBtn = $('console-jump');
      if (jumpBtn) jumpBtn.classList.add('hidden');
    }
  });
})();

// Jump to latest button
(() => {
  const jumpBtn = $('console-jump');
  if (!jumpBtn) return;
  jumpBtn.onclick = () => {
    const view = $('console-view');
    if (view) {
      view.scrollTop = view.scrollHeight;
      consoleAutoScroll = true;
    }
    jumpBtn.classList.add('hidden');
  };
})();

// Console search
(() => {
  const searchInput = $('console-search');
  if (!searchInput) return;
  searchInput.addEventListener('input', () => {
    clearTimeout(consoleSearchDebounce);
    consoleSearchDebounce = setTimeout(() => {
      consoleSearchTerm = searchInput.value.trim();
      applyConsoleFilters();
    }, 300);
  });
})();

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

// Poll for console output from the server (fallback — reduced to 30s)
async function pollConsole() {
  try {
    const resp = await fetch('/api/console');
    const data = await resp.json();
    if (data.entries && data.entries.length > 0) {
      data.entries.forEach(e => addConsoleEntry(e.level, e.message));
    }
  } catch {}
}
setInterval(pollConsole, 30000);

// Wire up initial "All" service tab button
(() => {
  const allBtn = document.querySelector('.console-service-btn[data-service="all"]');
  if (allBtn) allBtn.onclick = () => setConsoleServiceFilter('all');
})();

// Add initial console message and load initial entries
setTimeout(async () => {
  addConsoleEntry('info', 'vibe-ui console connected (real-time streaming active)', 'vibe-ui');
  try {
    const resp = await fetch('/api/service-health');
    const data = await resp.json();
    if (data.services) {
      const summary = data.services.map(s => `${s.name} :${s.port} ${s.status === 'healthy' ? '\u2713' : '\u2717'}`).join(', ');
      addConsoleEntry('info', `Services: ${summary}`, 'vibe-ui');
    }
  } catch {}
  // Load initial console entries via HTTP (last batch from each source)
  try {
    const resp = await fetch('/api/console?reset=true');
    const data = await resp.json();
    if (data.entries && data.entries.length > 0) {
      data.entries.forEach(e => addConsoleEntry(e.level, e.message));
    }
  } catch {}
}, 1000);

/* ═══ Init ═══ */
initChat(chat);
initNotes($('notes-editor'), $('notes-gen'), $('notes-save'), $('notes-copy'), () => ws);
initStatus($('status-list'));
initBudget($('budget-fill'), $('budget-amount'));

connect();
