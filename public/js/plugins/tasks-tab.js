// Tasks Tab — Tab SDK plugin combining Linear issues + Todo list
import { registerTab } from '../ui/tab-sdk.js';

// ── SVG Icons ────────────────────────────────────────
const ICONS = {
  refresh: `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="23 4 23 10 17 10"/><polyline points="1 20 1 14 7 14"/><path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"/></svg>`,
  star: `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/></svg>`,
  archive: `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="21 8 21 21 3 21 3 8"/><rect x="1" y="3" width="22" height="5"/><line x1="10" y1="12" x2="14" y2="12"/></svg>`,
  unarchive: `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="1 4 1 10 7 10"/><path d="M3.51 15a9 9 0 1 0 2.13-9.36L1 10"/></svg>`,
  starBrag: `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/></svg>`,
  archiveBig: `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="21 8 21 21 3 21 3 8"/><rect x="1" y="3" width="22" height="5"/><line x1="10" y1="12" x2="14" y2="12"/></svg>`,
};

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

registerTab({
  id: 'tasks',
  title: 'Tasks',
  icon: '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 11l3 3L22 4"/><path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11"/></svg>',
  init(ctx) {
    // ── State ────────────────────────────────────────
    const CACHE_TTL = 60_000;
    let cachedLinear = null;
    let linearCacheTime = 0;
    let linearLoading = false;

    let todos = [];
    let brags = [];
    let showArchived = false;
    let showBrags = false;

    const PRIORITY_LABELS = ['none', 'low', 'medium', 'high'];

    // ── Build DOM ────────────────────────────────────
    const root = document.createElement('div');
    root.className = 'tasks-tab';
    root.style.cssText = 'display:flex;flex-direction:column;flex:1;overflow:hidden;';

    root.innerHTML = `
      <div class="tasks-split-section tasks-linear-section">
        <div class="linear-panel-header">
          <h3>Linear Tasks</h3>
          <div class="linear-panel-actions">
            <button class="linear-create-btn" title="Create issue">+</button>
            <button class="linear-refresh-btn" title="Refresh issues">${ICONS.refresh}</button>
          </div>
        </div>
        <div class="linear-issues"></div>
        <div class="linear-panel-footer"></div>
      </div>
      <div class="tasks-split-handle" title="Drag to resize"></div>
      <div class="tasks-split-section tasks-todo-section">
        <div class="todo-panel-header">
          <h3>Todo</h3>
          <div class="todo-header-actions">
            <button class="todo-brag-toggle todo-toggle-btn" title="Show brag list">${ICONS.starBrag}</button>
            <button class="todo-archive-toggle todo-toggle-btn" title="Show archived">${ICONS.archiveBig}</button>
            <button class="todo-add-btn" title="Add todo">+</button>
          </div>
        </div>
        <div class="todo-list"></div>
        <div class="todo-input-bar" style="display:none;">
          <input type="text" class="todo-input" placeholder="New todo..." autocomplete="off">
        </div>
      </div>
    `;

    // Scoped selectors
    const linearSection = root.querySelector('.tasks-linear-section');
    const linearRefreshBtn = root.querySelector('.linear-refresh-btn');
    const linearCreateBtn = root.querySelector('.linear-create-btn');
    const linearIssuesList = root.querySelector('.linear-issues');
    const linearFooter = root.querySelector('.linear-panel-footer');
    const splitHandle = root.querySelector('.tasks-split-handle');

    const todoList = root.querySelector('.todo-list');
    const todoAddBtn = root.querySelector('.todo-add-btn');
    const todoInputBar = root.querySelector('.todo-input-bar');
    const todoInput = root.querySelector('.todo-input');
    const archToggle = root.querySelector('.todo-archive-toggle');
    const bragToggle = root.querySelector('.todo-brag-toggle');
    const todoHeader = root.querySelector('.todo-panel-header h3');

    // ══════════════════════════════════════════════════
    // LINEAR SECTION
    // ══════════════════════════════════════════════════

    function priorityColor(priority) {
      switch (priority) {
        case 1: return 'var(--error)';
        case 2: return 'var(--warning)';
        case 3: return 'var(--accent)';
        case 4: return 'var(--text-dim)';
        default: return 'var(--border)';
      }
    }

    function formatDate(dateStr) {
      if (!dateStr) return null;
      const d = new Date(dateStr);
      return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
    }

    async function loadIssues() {
      if (linearLoading) return;
      linearLoading = true;
      linearRefreshBtn.classList.add('spinning');
      linearIssuesList.innerHTML = '<div class="linear-empty"><span class="linear-empty-icon">&#8987;</span>Loading...</div>';

      try {
        const data = await ctx.api.fetchLinearIssues();
        cachedLinear = data;
        linearCacheTime = Date.now();

        if (data.error && data.issues.length === 0) {
          const isKeyError = data.error.includes('not configured');
          const icon = isKeyError ? '&#128273;' : '&#128196;';
          const hint = isKeyError
            ? '<br><span style="font-size:10px;margin-top:4px;display:block;">Set LINEAR_API_KEY env var</span>'
            : '';
          linearIssuesList.innerHTML = `<div class="linear-empty"><span class="linear-empty-icon">${icon}</span>${data.error}${hint}</div>`;
          linearFooter.textContent = '';
        } else {
          renderIssues(data.issues);
          linearFooter.textContent = `\u2500\u2500\u2500 ${data.issues.length} issue${data.issues.length !== 1 ? 's' : ''} \u2500\u2500\u2500`;
        }
      } catch {
        linearIssuesList.innerHTML = '<div class="linear-empty"><span class="linear-empty-icon">&#128196;</span>Failed to fetch issues</div>';
        linearFooter.textContent = '';
      } finally {
        linearLoading = false;
        linearRefreshBtn.classList.remove('spinning');
      }
    }

    function renderIssues(issues) {
      linearIssuesList.innerHTML = '';
      for (const issue of issues) {
        const a = document.createElement('a');
        a.className = 'linear-issue';
        a.href = issue.url;
        a.target = '_blank';
        a.rel = 'noopener';

        const due = formatDate(issue.dueDate);
        const labels = (issue.labels?.nodes || [])
          .map(l => `<span class="linear-issue-label" style="background:${l.color}22;color:${l.color}">${l.name}</span>`)
          .join('');

        a.innerHTML = `
          <div class="linear-issue-top">
            <span class="linear-issue-priority" style="background:${priorityColor(issue.priority)}" title="${issue.priorityLabel}"></span>
            <span class="linear-issue-id">${issue.identifier}</span>
            <span class="linear-issue-title">${escapeHtml(issue.title)}</span>
          </div>
          <div class="linear-issue-meta">
            <span class="linear-issue-state">
              <span class="linear-issue-state-dot" style="background:${issue.state?.color || 'var(--text-dim)'}"></span>
              ${escapeHtml(issue.state?.name || '')}
            </span>
            ${due ? `<span class="linear-issue-due">Due ${due}</span>` : ''}
            ${labels}
          </div>
        `;
        linearIssuesList.appendChild(a);
      }
    }

    // ── Linear Create Issue Modal ────────────────────
    // Reuse the existing modal in index.html
    const createModal = document.getElementById('linear-create-modal');
    const createForm = document.getElementById('linear-create-form');
    const createTitle = document.getElementById('linear-create-title');
    const createDesc = document.getElementById('linear-create-desc');
    const createTeam = document.getElementById('linear-create-team');
    const createState = document.getElementById('linear-create-state');
    const createClose = document.getElementById('linear-create-close');
    const createCancel = document.getElementById('linear-create-cancel');
    const createSubmit = document.getElementById('linear-create-submit');

    function openCreateModal() {
      if (!createModal) return;
      createModal.classList.remove('hidden');
      createForm.reset();
      createState.disabled = true;
      createState.innerHTML = '<option value="">Select a team first...</option>';
      createSubmit.disabled = false;
      createSubmit.textContent = 'Create';
      createTitle.focus();

      ctx.api.fetchLinearTeams().then((data) => {
        const opts = (data.teams || [])
          .map(t => `<option value="${t.id}">${escapeHtml(t.name)}</option>`)
          .join('');
        createTeam.innerHTML = `<option value="">Select a team...</option>${opts}`;
      });
    }

    function closeCreateModal() {
      if (createModal) createModal.classList.add('hidden');
    }

    function handleTeamChange() {
      const teamId = createTeam.value;
      if (!teamId) {
        createState.disabled = true;
        createState.innerHTML = '<option value="">Select a team first...</option>';
        return;
      }
      createState.disabled = true;
      createState.innerHTML = '<option value="">Loading...</option>';

      ctx.api.fetchLinearTeamStates(teamId).then((data) => {
        const states = data.states || [];
        const opts = states
          .map(s => `<option value="${s.id}">${escapeHtml(s.name)}</option>`)
          .join('');
        createState.innerHTML = `<option value="">Select state...</option>${opts}`;
        createState.disabled = false;
      });
    }

    async function handleCreateSubmit(e) {
      e.preventDefault();
      const title = createTitle.value.trim();
      const teamId = createTeam.value;
      if (!title || !teamId) return;

      createSubmit.disabled = true;
      createSubmit.textContent = 'Creating...';

      try {
        const result = await ctx.api.createLinearIssue({
          title,
          description: createDesc.value.trim() || undefined,
          teamId,
          stateId: createState.value || undefined,
        });

        if (result.success) {
          cachedLinear = null;
          linearCacheTime = 0;
          loadIssues();
          closeCreateModal();
        } else {
          createSubmit.textContent = 'Failed \u2014 retry';
          createSubmit.disabled = false;
        }
      } catch {
        createSubmit.textContent = 'Failed \u2014 retry';
        createSubmit.disabled = false;
      }
    }

    linearRefreshBtn.addEventListener('click', () => loadIssues());
    linearCreateBtn.addEventListener('click', () => openCreateModal());

    if (createClose) createClose.addEventListener('click', closeCreateModal);
    if (createCancel) createCancel.addEventListener('click', closeCreateModal);
    if (createModal) createModal.addEventListener('click', (e) => {
      if (e.target === createModal) closeCreateModal();
    });
    if (createTeam) createTeam.addEventListener('change', handleTeamChange);
    if (createForm) createForm.addEventListener('submit', handleCreateSubmit);

    // ══════════════════════════════════════════════════
    // TODO SECTION
    // ══════════════════════════════════════════════════

    function renderTodos() {
      if (showBrags) {
        renderBrags();
        return;
      }

      const emptyMsg = showArchived ? 'No archived todos' : 'No todos yet';
      if (!todos.length) {
        todoList.innerHTML = `<div class="todo-empty">${emptyMsg}</div>`;
        return;
      }

      todoList.innerHTML = '';
      for (const t of todos) {
        const pri = t.priority || 0;
        const row = document.createElement('div');
        row.className = 'todo-item' + (t.done ? ' done' : '');
        if (pri > 0) row.classList.add(`priority-${pri}`);
        row.dataset.id = t.id;

        const priDot = document.createElement('button');
        priDot.className = `todo-priority-dot priority-${pri}`;
        priDot.title = `Priority: ${PRIORITY_LABELS[pri]} (click to change)`;
        priDot.addEventListener('click', () => handlePriority(t.id, (pri + 1) % 4));

        const cb = document.createElement('input');
        cb.type = 'checkbox';
        cb.checked = !!t.done;
        cb.addEventListener('change', () => handleToggle(t.id, cb.checked ? 1 : 0));

        const span = document.createElement('span');
        span.className = 'todo-text';
        span.textContent = t.text;
        if (!showArchived) span.addEventListener('dblclick', () => startEdit(span, t));

        const actions = document.createElement('span');
        actions.className = 'todo-actions';

        if (!showArchived) {
          const bragBtn = document.createElement('button');
          bragBtn.className = 'todo-action-btn todo-brag-btn';
          bragBtn.title = 'Brag about this';
          bragBtn.innerHTML = ICONS.star;
          bragBtn.addEventListener('click', () => showBragPrompt(t));
          actions.appendChild(bragBtn);
        }

        const archBtn = document.createElement('button');
        archBtn.className = 'todo-action-btn todo-archive-btn';
        archBtn.title = showArchived ? 'Unarchive' : 'Archive';
        archBtn.innerHTML = showArchived ? ICONS.unarchive : ICONS.archive;
        archBtn.addEventListener('click', () => handleArchive(t.id, !showArchived));

        const del = document.createElement('button');
        del.className = 'todo-action-btn todo-delete-btn';
        del.textContent = '\u00d7';
        del.title = 'Delete';
        del.addEventListener('click', () => handleDelete(t.id));

        actions.append(archBtn, del);
        row.append(priDot, cb, span, actions);
        todoList.appendChild(row);
      }
    }

    function renderBrags() {
      if (!brags.length) {
        todoList.innerHTML = '<div class="todo-empty">No brags yet</div>';
        return;
      }
      todoList.innerHTML = '';
      for (const b of brags) {
        const row = document.createElement('div');
        row.className = 'brag-item';

        const text = document.createElement('div');
        text.className = 'brag-text';
        text.textContent = b.text;

        const summary = document.createElement('div');
        summary.className = 'brag-summary';
        summary.textContent = b.summary;

        const date = document.createElement('div');
        date.className = 'brag-date';
        date.textContent = new Date(b.created_at * 1000).toLocaleDateString();

        const del = document.createElement('button');
        del.className = 'todo-action-btn todo-delete-btn brag-delete';
        del.textContent = '\u00d7';
        del.title = 'Delete';
        del.addEventListener('click', async () => {
          try {
            await ctx.api.deleteBragApi(b.id);
            brags = brags.filter(x => x.id !== b.id);
            renderTodos();
            refreshCounts();
          } catch { /* ignore */ }
        });

        row.append(text, summary, date, del);
        todoList.appendChild(row);
      }
    }

    function updateHeaderToggle() {
      archToggle.classList.toggle('active', showArchived);
      archToggle.title = showArchived ? 'Show active todos' : 'Show archived';
      bragToggle.classList.toggle('active', showBrags);
      bragToggle.title = showBrags ? 'Show active todos' : 'Show brag list';
    }

    async function refreshCounts() {
      try {
        const counts = await ctx.api.fetchTodoCounts();
        const label = showBrags ? 'Brags' : showArchived ? 'Archived' : 'Todo';
        const count = showBrags ? counts.brags : showArchived ? counts.archived : counts.active;
        todoHeader.textContent = `${label} (${count})`;
        setBadge(archToggle, counts.archived);
        setBadge(bragToggle, counts.brags);
      } catch { /* ignore */ }
    }

    function setBadge(btn, count) {
      let badge = btn.querySelector('.todo-count-badge');
      if (count > 0) {
        if (!badge) {
          badge = document.createElement('span');
          badge.className = 'todo-count-badge';
          btn.appendChild(badge);
        }
        badge.textContent = count;
      } else if (badge) {
        badge.remove();
      }
    }

    // ── CRUD handlers ────────────────────────────────
    async function loadTodos() {
      try {
        todos = await ctx.api.fetchTodos(showArchived);
        renderTodos();
        refreshCounts();
      } catch { /* ignore */ }
    }

    async function handleToggle(id, done) {
      try {
        await ctx.api.updateTodoApi(id, { done });
        const t = todos.find(x => x.id === id);
        if (t) t.done = done;
        renderTodos();
      } catch { /* ignore */ }
    }

    async function handleArchive(id, archived) {
      try {
        await ctx.api.archiveTodoApi(id, archived);
        todos = todos.filter(x => x.id !== id);
        renderTodos();
        refreshCounts();
      } catch { /* ignore */ }
    }

    async function handlePriority(id, priority) {
      try {
        await ctx.api.updateTodoApi(id, { priority });
        const t = todos.find(x => x.id === id);
        if (t) t.priority = priority;
        renderTodos();
      } catch { /* ignore */ }
    }

    async function handleDelete(id) {
      try {
        await ctx.api.deleteTodoApi(id);
        todos = todos.filter(x => x.id !== id);
        renderTodos();
        refreshCounts();
      } catch { /* ignore */ }
    }

    function showBragPrompt(todo) {
      const existing = document.querySelector('.brag-prompt-overlay');
      if (existing) existing.remove();

      const overlay = document.createElement('div');
      overlay.className = 'brag-prompt-overlay';
      overlay.innerHTML = `
        <div class="brag-prompt">
          <div class="brag-prompt-title">Brag about it!</div>
          <div class="brag-prompt-task">${escapeHtml(todo.text)}</div>
          <textarea class="brag-prompt-input" placeholder="Write a summary of what you accomplished..." maxlength="500" rows="4"></textarea>
          <div class="brag-prompt-counter"><span class="brag-char-count">0</span>/500</div>
          <div class="brag-prompt-actions">
            <button class="brag-prompt-cancel">Cancel</button>
            <button class="brag-prompt-submit">Brag it!</button>
          </div>
        </div>
      `;

      const textarea = overlay.querySelector('.brag-prompt-input');
      const counter = overlay.querySelector('.brag-char-count');
      const submitBtn = overlay.querySelector('.brag-prompt-submit');
      const cancelBtn = overlay.querySelector('.brag-prompt-cancel');

      textarea.addEventListener('input', () => { counter.textContent = textarea.value.length; });
      cancelBtn.addEventListener('click', () => overlay.remove());
      overlay.addEventListener('click', (e) => { if (e.target === overlay) overlay.remove(); });

      submitBtn.addEventListener('click', async () => {
        const summary = textarea.value.trim();
        if (!summary) { textarea.focus(); return; }
        submitBtn.disabled = true;
        submitBtn.textContent = 'Saving...';
        try {
          await ctx.api.bragTodoApi(todo.id, summary);
          overlay.remove();
          todos = todos.filter(x => x.id !== todo.id);
          renderTodos();
          refreshCounts();
        } catch {
          submitBtn.disabled = false;
          submitBtn.textContent = 'Brag it!';
        }
      });

      document.body.appendChild(overlay);
      textarea.focus();
    }

    function startEdit(span, todo) {
      span.contentEditable = 'true';
      span.classList.add('editing');
      span.focus();

      const range = document.createRange();
      range.selectNodeContents(span);
      const sel = window.getSelection();
      sel.removeAllRanges();
      sel.addRange(range);

      const finish = async () => {
        span.contentEditable = 'false';
        span.classList.remove('editing');
        const newText = span.textContent.trim();
        if (newText && newText !== todo.text) {
          try {
            await ctx.api.updateTodoApi(todo.id, { text: newText });
            todo.text = newText;
          } catch {
            span.textContent = todo.text;
          }
        } else {
          span.textContent = todo.text;
        }
      };

      span.addEventListener('blur', finish, { once: true });
      span.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') { e.preventDefault(); span.blur(); }
        if (e.key === 'Escape') { span.textContent = todo.text; span.blur(); }
      });
    }

    // ── Todo event listeners ─────────────────────────
    todoAddBtn.addEventListener('click', () => {
      todoInputBar.style.display = '';
      todoInput.value = '';
      todoInput.focus();
    });

    todoInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        const text = todoInput.value.trim();
        if (!text) return;
        todoInput.value = '';
        todoInputBar.style.display = 'none';
        ctx.api.createTodoApi(text).then(() => loadTodos()).catch(() => {});
      }
      if (e.key === 'Escape') {
        todoInputBar.style.display = 'none';
      }
    });

    archToggle.addEventListener('click', () => {
      showArchived = !showArchived;
      showBrags = false;
      updateHeaderToggle();
      todoAddBtn.style.display = showArchived ? 'none' : '';
      todoInputBar.style.display = 'none';
      loadTodos();
    });

    bragToggle.addEventListener('click', async () => {
      showBrags = !showBrags;
      showArchived = false;
      updateHeaderToggle();
      todoAddBtn.style.display = showBrags ? 'none' : '';
      todoInputBar.style.display = 'none';
      if (showBrags) {
        try { brags = await ctx.api.fetchBrags(); } catch { brags = []; }
        renderTodos();
        refreshCounts();
      } else {
        loadTodos();
      }
    });

    // ── Split drag handle ────────────────────────────
    function initSplitDrag() {
      const saved = localStorage.getItem('tasks-split-ratio');
      const ratio = saved ? parseFloat(saved) : 0.5;
      applyRatio(ratio);

      splitHandle.addEventListener('mousedown', (e) => {
        e.preventDefault();
        splitHandle.classList.add('dragging');
        const startY = e.clientY;
        const handleH = splitHandle.offsetHeight;
        const totalH = root.getBoundingClientRect().height - handleH;
        const startTop = linearSection.getBoundingClientRect().height;

        const onMove = (ev) => {
          const dy = ev.clientY - startY;
          let newTop = startTop + dy;
          const min = 60;
          newTop = Math.max(min, Math.min(totalH - min, newTop));
          applyRatio(newTop / totalH);
        };

        const onUp = () => {
          splitHandle.classList.remove('dragging');
          document.removeEventListener('mousemove', onMove);
          document.removeEventListener('mouseup', onUp);
          const topH = linearSection.getBoundingClientRect().height;
          const tot = root.getBoundingClientRect().height - handleH;
          if (tot > 0) localStorage.setItem('tasks-split-ratio', (topH / tot).toFixed(3));
        };

        document.addEventListener('mousemove', onMove);
        document.addEventListener('mouseup', onUp);
      });
    }

    function applyRatio(ratio) {
      const r = Math.max(0.1, Math.min(0.9, ratio));
      root.style.setProperty('--tasks-split-top', r);
      root.style.setProperty('--tasks-split-bottom', 1 - r);
    }

    initSplitDrag();

    // ── Load data on activate ────────────────────────
    function loadAll() {
      if (!cachedLinear || Date.now() - linearCacheTime > CACHE_TTL) {
        loadIssues();
      }
      loadTodos();
    }

    // Initial load
    loadAll();

    // Store lifecycle hooks on root for onActivate
    root._loadAll = loadAll;
    root._cachedLinear = () => cachedLinear;
    root._linearCacheTime = () => linearCacheTime;
    root._CACHE_TTL = CACHE_TTL;

    return root;
  },

  onActivate() {
    // Reload data when tab becomes visible (if stale)
    const pane = document.querySelector('.right-panel-pane[data-tab="tasks"] .tasks-tab');
    if (pane?._loadAll) {
      pane._loadAll();
    }
  },
});
