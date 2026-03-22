let listEl = null;

export function initHistory(el) {
  listEl = el;
}

export async function loadHistory() {
  if (!listEl) return;
  try {
    const resp = await fetch('/api/checkpoints');
    const data = await resp.json();
    renderHistory(data.checkpoints || []);
  } catch {
    // Fallback — load from sessions
    try {
      const sessions = await (await fetch('/api/sessions')).json();
      renderHistory(sessions.map((s, i) => ({
        label: s.title || s.project_name || 'Session',
        timestamp: s.last_used_at || s.created_at,
        files: [],
        current: i === 0,
        id: s.id,
      })));
    } catch {}
  }
}

function renderHistory(checkpoints) {
  listEl.innerHTML = '';
  if (checkpoints.length === 0) {
    listEl.innerHTML = '<div style="padding:14px;color:var(--text-muted);font-size:12px">No checkpoints yet. Start building to create version history.</div>';
    return;
  }

  checkpoints.forEach(cp => {
    const div = document.createElement('div');
    div.className = 'history-item' + (cp.current ? ' current' : '');

    const timeAgo = cp.timestamp ? formatTimeAgo(cp.timestamp) : '';
    const fileCount = cp.files ? cp.files.length + ' files' : '';

    div.innerHTML = `
      <div class="history-label">${cp.label || 'Checkpoint'}</div>
      <div class="history-meta">
        <span>${timeAgo}</span>
        ${fileCount ? '<span>' + fileCount + '</span>' : ''}
      </div>
      ${!cp.current ? '<button class="history-restore">Restore</button>' : ''}
    `;

    const restoreBtn = div.querySelector('.history-restore');
    if (restoreBtn) {
      restoreBtn.onclick = () => {
        if (confirm('Restore to "' + (cp.label || 'this version') + '"? All changes after this point will be lost.')) {
          fetch('/api/restore', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ checkpointId: cp.id }),
          });
        }
      };
    }

    listEl.appendChild(div);
  });
}

function formatTimeAgo(ts) {
  const seconds = Math.floor((Date.now() / 1000) - ts);
  if (seconds < 60) return 'just now';
  if (seconds < 3600) return Math.floor(seconds / 60) + 'm ago';
  if (seconds < 86400) return Math.floor(seconds / 3600) + 'h ago';
  return Math.floor(seconds / 86400) + 'd ago';
}
