/**
 * Presence UI — Multi-User Awareness (Phase 4)
 *
 * Renders into two separate containers:
 *   #presence-bar  — top bar: online count + avatar stack + dropdown toggle
 *   #status-strip  — below controls bar: build lock + branch conflict (only visible when active)
 */

import { getIdentity } from './identity.js';

let _users = [];
let _buildLock = null;
let _ws = null;
let _currentBranch = null;

const roleColors = {
  pm: '#f59e0b',
  engineer: '#9b87f5',
  designer: '#22c55e',
  qa: '#3b82f6',
  other: '#8E8EA0',
};

/** Initialize presence UI — call once after DOM ready */
export function initPresenceUI(ws) {
  _ws = ws;
  render();
}

/** Update WS reference on reconnect */
export function setPresenceWs(ws) {
  _ws = ws;
}

/** Update current branch — call when branch changes */
export function setPresenceBranch(branch) {
  _currentBranch = branch;
  render();
}

/** Called when server sends presence_update */
export function updatePresence(users, buildLock) {
  _users = users || [];
  _buildLock = buildLock || null;
  render();
}

/** Called when build_lock_acquired is received */
export function onBuildLockAcquired(msg) {
  _buildLock = { userId: msg.userId, userName: msg.userName, branch: msg.branch };
  render();
}

/** Called when build_lock_released is received */
export function onBuildLockReleased() {
  _buildLock = null;
  render();
}

function render() {
  renderPresenceBar();
  renderStatusStrip();
}

/** Render #presence-bar — merged: online count + avatar stack + own badge, all clickable */
function renderPresenceBar() {
  const container = document.getElementById('presence-bar');
  if (!container) return;

  // Close any open dropdown before re-rendering
  const openDD = document.getElementById('presence-dropdown');
  if (openDD) openDD.remove();

  const identity = getIdentity();
  if (!identity) { container.style.display = 'none'; return; }
  const myName = identity.name;
  const myRole = identity.role;
  const others = _users.filter(u => u.name !== myName);
  const total = _users.length;

  let html = '';

  // Online count pill
  html += `<span class="presence-dot"></span><span class="presence-count-num">${total}</span>`;

  // Avatar stack (max 3 others)
  if (others.length > 0) {
    html += '<div class="presence-avatars">';
    const shown = others.slice(0, 3);
    for (const u of shown) {
      const initials = u.name.split(/\s+/).map(w => w[0]).join('').toUpperCase().slice(0, 2);
      const color = roleColors[u.role] || roleColors.other;
      const ring = u.status === 'building' ? ' presence-building' : (u.status === 'active' ? ' presence-active' : '');
      html += `<div class="presence-avatar${ring}" style="background:${color}" title="${esc(u.name)} (${esc(u.role)}) — ${esc(u.status)}${u.branch ? ' on ' + esc(u.branch) : ''}">${initials}</div>`;
    }
    if (others.length > 3) {
      html += `<div class="presence-avatar presence-more" title="${others.length - 3} more">+${others.length - 3}</div>`;
    }
    html += '</div>';
  }

  // Own avatar (always last)
  const myInitials = myName.split(/\s+/).map(w => w[0]).join('').toUpperCase().slice(0, 2);
  const myColor = roleColors[myRole] || roleColors.other;
  html += `<div class="presence-me" style="background:${myColor}" title="${esc(myName)} (${esc(myRole)})">${myInitials}</div>`;

  container.innerHTML = html;
  container.style.display = 'flex';
  container.title = `${total} user${total !== 1 ? 's' : ''} online`;
  container.style.cursor = 'pointer';

  // Whole bar toggles dropdown
  container.onclick = (e) => {
    e.stopPropagation();
    toggleDropdown();
  };
}

/** Render #status-strip — build lock + branch conflict warnings */
function renderStatusStrip() {
  const strip = document.getElementById('status-strip');
  if (!strip) return;

  const identity = getIdentity();
  const myName = identity?.name;
  const others = _users.filter(u => u.name !== myName);

  let items = [];

  // Build lock indicator
  if (_buildLock) {
    const isMe = _buildLock.userName === myName;
    if (isMe) {
      items.push(`<div class="status-chip status-lock-mine">
        <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>
        <span>You're building</span>
        <button class="status-chip-action" data-action="release" title="Release lock">&times;</button>
      </div>`);
    } else {
      items.push(`<div class="status-chip status-lock-other">
        <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>
        <span>${esc(_buildLock.userName)} is building</span>
        <button class="status-chip-action status-chip-takeover" data-action="takeover">Take over</button>
      </div>`);
    }
  }

  // Branch conflict warning
  if (_currentBranch) {
    const sameBranch = others.filter(u => u.branch === _currentBranch);
    if (sameBranch.length > 0) {
      const names = sameBranch.map(u => u.name).join(', ');
      items.push(`<div class="status-chip status-branch-warn" title="${esc(names)} also on ${esc(_currentBranch)}">
        <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>
        <span>${sameBranch.length === 1 ? esc(sameBranch[0].name) : sameBranch.length + ' others'} on same branch</span>
      </div>`);
    }
  }

  if (items.length === 0) {
    strip.style.display = 'none';
    strip.innerHTML = '';
    return;
  }

  strip.innerHTML = items.join('');
  strip.style.display = 'flex';

  // Wire actions
  strip.querySelectorAll('[data-action]').forEach(btn => {
    btn.onclick = () => {
      if (!_ws || _ws.readyState !== 1) return;
      const action = btn.dataset.action;
      if (action === 'release') _ws.send(JSON.stringify({ type: 'release_lock' }));
      if (action === 'takeover') _ws.send(JSON.stringify({ type: 'take_over' }));
    };
  });
}

function toggleDropdown() {
  let dd = document.getElementById('presence-dropdown');
  if (dd) {
    dd.remove();
    return;
  }

  const identity = getIdentity();
  const myName = identity?.name;

  dd = document.createElement('div');
  dd.id = 'presence-dropdown';
  dd.className = 'presence-dropdown';

  let html = '<div class="presence-dd-title">Online now</div>';

  if (_users.length === 0) {
    html += '<div class="presence-dd-empty">No one else is online</div>';
  } else {
    for (const u of _users) {
      const initials = u.name.split(/\s+/).map(w => w[0]).join('').toUpperCase().slice(0, 2);
      const color = roleColors[u.role] || roleColors.other;
      const isMe = u.name === myName;
      const isBuilding = _buildLock?.userName === u.name;
      html += `<div class="presence-dd-user">
        <div class="presence-dd-avatar" style="background:${color}">${initials}</div>
        <div class="presence-dd-info">
          <div class="presence-dd-name">${esc(u.name)}${isMe ? ' <span class="presence-dd-you">(you)</span>' : ''}</div>
          <div class="presence-dd-meta">${esc(u.role)}${u.branch ? ' · ' + esc(u.branch) : ''}${isBuilding ? ' · building' : ''}</div>
        </div>
      </div>`;
    }
  }

  dd.innerHTML = html;

  // Position dropdown below the presence bar
  const bar = document.getElementById('presence-bar');
  if (bar) {
    const rect = bar.getBoundingClientRect();
    dd.style.top = (rect.bottom + 6) + 'px';
    dd.style.right = (window.innerWidth - rect.right) + 'px';
  }
  document.body.appendChild(dd);

  // Close on outside click
  const close = (e) => {
    if (!dd.contains(e.target) && !e.target.closest('.presence-bar')) {
      dd.remove();
      document.removeEventListener('click', close);
    }
  };
  setTimeout(() => document.addEventListener('click', close), 0);
}

function esc(str) {
  const d = document.createElement('div');
  d.textContent = str;
  return d.innerHTML;
}

export default { initPresenceUI, setPresenceWs, setPresenceBranch, updatePresence, onBuildLockAcquired, onBuildLockReleased };
