// Linear Tab — Tab SDK plugin combining Linear issues + settings
import { registerTab } from '/js/ui/tab-sdk.js';

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

const ICONS = {
  refresh: `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="23 4 23 10 17 10"/><polyline points="1 20 1 14 7 14"/><path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"/></svg>`,
};

registerTab({
  id: 'linear',
  title: 'Linear',
  icon: '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/></svg>',
  lazy: true,

  init(ctx) {
    const CACHE_TTL = 60_000;
    let cachedLinear = null;
    let linearCacheTime = 0;
    let linearLoading = false;
    let currentView = 'issues'; // 'issues' | 'settings'

    // ── Build DOM ──────────────────────────────────────
    const root = document.createElement('div');
    root.className = 'linear-tab';

    root.innerHTML = `
      <div class="linear-tab-header">
        <div class="linear-tab-nav">
          <button class="linear-nav-btn active" data-view="issues">Issues</button>
          <button class="linear-nav-btn" data-view="settings">Settings</button>
        </div>
        <div class="linear-tab-actions">
          <button class="linear-create-issue-btn" title="Create issue">+</button>
          <button class="linear-refresh-btn" title="Refresh issues">${ICONS.refresh}</button>
        </div>
      </div>

      <div class="linear-view linear-issues-view">
        <div class="linear-issues"></div>
        <div class="linear-panel-footer"></div>
      </div>

      <div class="linear-view linear-settings-view" style="display:none;">
        <div class="ls-form">
          <div class="ls-toggle-row">
            <span class="ls-label">Enable Integration</span>
            <label class="ls-switch">
              <input type="checkbox" class="ls-enabled" />
              <span class="ls-slider"></span>
            </label>
          </div>

          <label class="ls-field">
            <span class="ls-label">API Key</span>
            <input type="password" class="ls-input ls-api-key" placeholder="lin_api_..." autocomplete="off" spellcheck="false" />
            <span class="ls-hint">Generate at Linear &rarr; Settings &rarr; API &rarr; Personal API keys</span>
          </label>

          <label class="ls-field">
            <span class="ls-label">Assignee Email</span>
            <input type="email" class="ls-input ls-email" placeholder="you@company.com" autocomplete="off" spellcheck="false" />
            <span class="ls-hint">New issues will be auto-assigned to this user</span>
          </label>

          <div class="ls-actions">
            <button class="ls-btn ls-save-btn">Save</button>
            <button class="ls-btn ls-test-btn ls-btn-secondary">Test Connection</button>
          </div>

          <div class="ls-status hidden"></div>
        </div>
      </div>
    `;

    // ── Selectors ──────────────────────────────────────
    const issuesView = root.querySelector('.linear-issues-view');
    const settingsView = root.querySelector('.linear-settings-view');
    const navBtns = root.querySelectorAll('.linear-nav-btn');
    const actionsBar = root.querySelector('.linear-tab-actions');
    const refreshBtn = root.querySelector('.linear-refresh-btn');
    const createBtn = root.querySelector('.linear-create-issue-btn');
    const issuesList = root.querySelector('.linear-issues');
    const footer = root.querySelector('.linear-panel-footer');

    // Settings selectors
    const enabledEl = root.querySelector('.ls-enabled');
    const apiKeyEl = root.querySelector('.ls-api-key');
    const emailEl = root.querySelector('.ls-email');
    const saveBtn = root.querySelector('.ls-save-btn');
    const testBtn = root.querySelector('.ls-test-btn');
    const statusEl = root.querySelector('.ls-status');

    // ── View switching ─────────────────────────────────
    navBtns.forEach(btn => {
      btn.addEventListener('click', () => {
        const view = btn.dataset.view;
        if (view === currentView) return;
        currentView = view;
        navBtns.forEach(b => b.classList.toggle('active', b.dataset.view === view));
        issuesView.style.display = view === 'issues' ? '' : 'none';
        settingsView.style.display = view === 'settings' ? '' : 'none';
        actionsBar.style.display = view === 'issues' ? '' : 'none';
        if (view === 'settings') loadSettings();
      });
    });

    // ══════════════════════════════════════════════════
    // ISSUES VIEW
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
      refreshBtn.classList.add('spinning');
      issuesList.innerHTML = '<div class="linear-empty"><span class="linear-empty-icon">&#8987;</span>Loading...</div>';

      try {
        const data = await ctx.api.fetchLinearIssues();
        cachedLinear = data;
        linearCacheTime = Date.now();

        if (data.error && data.issues.length === 0) {
          const isKeyError = data.error.includes('not configured');
          const icon = isKeyError ? '&#128273;' : '&#128196;';
          const hint = isKeyError
            ? '<br><span style="font-size:10px;margin-top:4px;display:block;cursor:pointer;text-decoration:underline;" class="linear-go-settings">Configure in Settings</span>'
            : '';
          issuesList.innerHTML = `<div class="linear-empty"><span class="linear-empty-icon">${icon}</span>${data.error}${hint}</div>`;
          footer.textContent = '';

          const link = issuesList.querySelector('.linear-go-settings');
          if (link) {
            link.addEventListener('click', () => {
              root.querySelector('.linear-nav-btn[data-view="settings"]').click();
            });
          }
        } else {
          renderIssues(data.issues);
          footer.textContent = `\u2500\u2500\u2500 ${data.issues.length} issue${data.issues.length !== 1 ? 's' : ''} \u2500\u2500\u2500`;
        }
      } catch {
        issuesList.innerHTML = '<div class="linear-empty"><span class="linear-empty-icon">&#128196;</span>Failed to fetch issues</div>';
        footer.textContent = '';
      } finally {
        linearLoading = false;
        refreshBtn.classList.remove('spinning');
      }
    }

    function renderIssues(issues) {
      issuesList.innerHTML = '';
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
        issuesList.appendChild(a);
      }
    }

    // ── Create Issue Modal (reuse from index.html) ────
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

    refreshBtn.addEventListener('click', () => loadIssues());
    createBtn.addEventListener('click', () => openCreateModal());

    if (createClose) createClose.addEventListener('click', closeCreateModal);
    if (createCancel) createCancel.addEventListener('click', closeCreateModal);
    if (createModal) createModal.addEventListener('click', (e) => {
      if (e.target === createModal) closeCreateModal();
    });
    if (createTeam) createTeam.addEventListener('change', handleTeamChange);
    if (createForm) createForm.addEventListener('submit', handleCreateSubmit);

    // ══════════════════════════════════════════════════
    // SETTINGS VIEW
    // ══════════════════════════════════════════════════

    function showStatus(msg, isError) {
      statusEl.textContent = msg;
      statusEl.className = `ls-status ${isError ? 'ls-error' : 'ls-success'}`;
      setTimeout(() => { statusEl.className = 'ls-status hidden'; }, 4000);
    }

    async function loadSettings() {
      try {
        const cfg = await ctx.api.fetchLinearConfig();
        enabledEl.checked = cfg.enabled || false;
        apiKeyEl.value = cfg.apiKey || '';
        emailEl.value = cfg.assigneeEmail || '';
      } catch {
        showStatus('Failed to load config', true);
      }
    }

    saveBtn.addEventListener('click', async () => {
      const enabled = enabledEl.checked;
      const apiKey = apiKeyEl.value.trim();
      const assigneeEmail = emailEl.value.trim();

      if (enabled && !apiKey) {
        showStatus('API key is required when enabled', true);
        return;
      }

      saveBtn.disabled = true;
      saveBtn.textContent = 'Saving...';
      try {
        const res = await ctx.api.saveLinearConfig({ enabled, apiKey, assigneeEmail });
        if (res.error) throw new Error(res.error);
        showStatus('Settings saved', false);
        cachedLinear = null;
        linearCacheTime = 0;
        await loadSettings();
      } catch (err) {
        showStatus(`Save failed: ${err.message}`, true);
      } finally {
        saveBtn.disabled = false;
        saveBtn.textContent = 'Save';
      }
    });

    testBtn.addEventListener('click', async () => {
      testBtn.disabled = true;
      testBtn.textContent = 'Testing...';
      try {
        const res = await ctx.api.testLinearConnection();
        if (!res.ok) throw new Error(res.error || 'Connection failed');
        showStatus(`Connected as ${res.user?.name || res.user?.email || 'unknown'}`, false);
      } catch (err) {
        showStatus(`Test failed: ${err.message}`, true);
      } finally {
        testBtn.disabled = false;
        testBtn.textContent = 'Test Connection';
      }
    });

    // ── Initial load ───────────────────────────────────
    function loadAll() {
      if (!cachedLinear || Date.now() - linearCacheTime > CACHE_TTL) {
        loadIssues();
      }
    }

    loadAll();

    root._loadAll = loadAll;
    return root;
  },

  onActivate() {
    const pane = document.querySelector('.right-panel-pane[data-tab="linear"] .linear-tab');
    if (pane?._loadAll) pane._loadAll();
  },
});
