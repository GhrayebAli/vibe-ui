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
    listEl.innerHTML = '<div style="padding:14px;color:var(--text-muted);font-size:12px">Failed to load checkpoints.</div>';
  }
}

function renderHistory(checkpoints) {
  listEl.innerHTML = '';

  if (checkpoints.length === 0) {
    listEl.innerHTML = '<div style="padding:14px;color:var(--text-muted);font-size:12px">No checkpoints yet. Checkpoints are created automatically after each code change.</div>';
    return;
  }

  checkpoints.forEach((cp, i) => {
    const div = document.createElement('div');
    div.className = 'history-item' + (cp.current ? ' current' : '');

    const timeAgo = cp.timestamp ? formatTimeAgo(cp.timestamp) : '';

    div.innerHTML = `
      <div class="history-row">
        <span class="history-dot ${cp.current ? 'dot-current' : ''}"></span>
        <div class="history-info">
          <div class="history-label">${cp.label || cp.id}</div>
          <div class="history-meta">${timeAgo}</div>
        </div>
        ${!cp.current ? '<button class="history-restore">Restore</button>' : '<span class="history-current-badge">Current</span>'}
      </div>
    `;

    const restoreBtn = div.querySelector('.history-restore');
    if (restoreBtn) {
      restoreBtn.onclick = async () => {
        if (!confirm(`Restore to "${cp.label || cp.id}"?\n\nAll changes after this point will be lost.`)) return;
        restoreBtn.textContent = 'Restoring...';
        restoreBtn.disabled = true;
        try {
          const resp = await fetch('/api/restore', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ checkpointId: cp.id }),
          });
          const data = await resp.json();
          if (data.ok) {
            restoreBtn.textContent = 'Restored!';
            // Reload history and refresh preview
            setTimeout(() => loadHistory(), 1000);
          } else {
            restoreBtn.textContent = 'Failed';
          }
        } catch {
          restoreBtn.textContent = 'Error';
        }
      };
    }

    listEl.appendChild(div);
  });
}

function formatTimeAgo(ts) {
  const seconds = Math.floor(Date.now() / 1000 - ts);
  if (seconds < 60) return 'just now';
  if (seconds < 3600) return Math.floor(seconds / 60) + 'm ago';
  if (seconds < 86400) return Math.floor(seconds / 3600) + 'h ago';
  return Math.floor(seconds / 86400) + 'd ago';
}
