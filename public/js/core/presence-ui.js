/**
 * Presence UI — Multi-User Awareness (Phase 4)
 * Renders online user avatars, build lock indicator, and presence dropdown.
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
  const container = document.getElementById('presence-bar');
  if (!container) return;

  // Close any open dropdown before re-rendering (prevents orphaned DOM + stale listeners)
  const openDD = document.getElementById('presence-dropdown');
  if (openDD) openDD.remove();

  const identity = getIdentity();
  const myName = identity?.name;

  // Filter out current user from the avatar stack
  const others = _users.filter(u => u.name !== myName);
  const total = _users.length;

  // Build HTML
  let html = '';

  // Online count pill
  html += `<div class="presence-count" title="${total} user${total !== 1 ? 's' : ''} online">
    <span class="presence-dot"></span>${total}
  </div>`;

  // Avatar stack (max 5)
  if (others.length > 0) {
    html += '<div class="presence-avatars">';
    const shown = others.slice(0, 5);
    for (const u of shown) {
      const initials = u.name.split(/\s+/).map(w => w[0]).join('').toUpperCase().slice(0, 2);
      const color = roleColors[u.role] || roleColors.other;
      const statusDot = u.status === 'building' ? ' presence-building' : (u.status === 'active' ? ' presence-active' : '');
      html += `<div class="presence-avatar${statusDot}" style="background:${color}" title="${esc(u.name)} (${esc(u.role)}) — ${esc(u.status)}${u.branch ? ' on ' + esc(u.branch) : ''}">${initials}</div>`;
    }
    if (others.length > 5) {
      html += `<div class="presence-avatar presence-more" title="${others.length - 5} more">+${others.length - 5}</div>`;
    }
    html += '</div>';
  }

  // Build lock indicator
  if (_buildLock) {
    const isMe = _buildLock.userName === myName;
    if (isMe) {
      html += `<div class="presence-lock presence-lock-mine" title="You hold the build lock">
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>
        <span>You're building</span>
        <button class="presence-lock-release" title="Release lock">✕</button>
      </div>`;
    } else {
      html += `<div class="presence-lock presence-lock-other" title="${esc(_buildLock.userName)} is building">
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>
        <span>${esc(_buildLock.userName)} building</span>
        <button class="presence-lock-takeover" title="Take over build lock">Take over</button>
      </div>`;
    }
  }

  // Branch conflict warning — others on same branch
  if (_currentBranch) {
    const sameBranch = others.filter(u => u.branch === _currentBranch);
    if (sameBranch.length > 0) {
      const names = sameBranch.map(u => u.name).join(', ');
      html += `<div class="presence-branch-warn" title="${esc(names)} also on ${esc(_currentBranch)}">
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>
        <span>${sameBranch.length === 1 ? esc(sameBranch[0].name) : sameBranch.length + ' others'} on same branch</span>
      </div>`;
    }
  }

  // Dropdown toggle
  html += `<button class="presence-toggle" title="Show online users">
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/></svg>
  </button>`;

  container.innerHTML = html;
  container.style.display = total > 0 ? 'flex' : 'none';

  // Wire up event listeners
  const releaseBtn = container.querySelector('.presence-lock-release');
  if (releaseBtn) {
    releaseBtn.onclick = () => {
      if (_ws?.readyState === 1) {
        _ws.send(JSON.stringify({ type: 'release_lock' }));
      }
    };
  }

  const takeoverBtn = container.querySelector('.presence-lock-takeover');
  if (takeoverBtn) {
    takeoverBtn.onclick = () => {
      if (_ws?.readyState === 1) {
        _ws.send(JSON.stringify({ type: 'take_over' }));
      }
    };
  }

  const toggle = container.querySelector('.presence-toggle');
  if (toggle) {
    toggle.onclick = (e) => {
      e.stopPropagation();
      toggleDropdown();
    };
  }
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
          <div class="presence-dd-meta">${u.role}${u.branch ? ' · ' + esc(u.branch) : ''}${isBuilding ? ' · 🔨 building' : ''}</div>
        </div>
      </div>`;
    }
  }

  dd.innerHTML = html;

  // Position dropdown below the toggle button
  const toggle = document.querySelector('.presence-toggle');
  if (toggle) {
    const rect = toggle.getBoundingClientRect();
    dd.style.top = (rect.bottom + 6) + 'px';
    dd.style.right = (window.innerWidth - rect.right) + 'px';
  }
  document.body.appendChild(dd);

  // Close on outside click
  const close = (e) => {
    if (!dd.contains(e.target) && !e.target.closest('.presence-toggle')) {
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
