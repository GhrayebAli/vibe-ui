let chatEl = null;
let currentAgentBubble = null;
let currentAgentText = '';
let thinkingEl = null;
let activityEl = null;
let activityLog = [];

export function initChat(el) {
  chatEl = el;
}

export function addUserMsg(text) {
  const div = document.createElement('div');
  div.className = 'msg msg-user';
  div.innerHTML = `<div class="bubble">${escapeHtml(text)}</div>`;
  chatEl.appendChild(div);
  scrollBottom();
}

export function addAgentMsg(text, streaming) {
  if (streaming && text) {
    if (!currentAgentBubble) {
      const div = document.createElement('div');
      div.className = 'msg msg-agent';
      const bubble = document.createElement('div');
      bubble.className = 'bubble';
      div.appendChild(bubble);
      chatEl.appendChild(div);
      currentAgentBubble = bubble;
      currentAgentText = '';
    }
    currentAgentText += text;
    currentAgentBubble.innerHTML = marked.parse(currentAgentText);
    addCopyButtons(currentAgentBubble);
    currentAgentBubble.querySelectorAll('pre code').forEach(b => hljs.highlightElement(b));
    scrollBottom();
  } else if (!streaming) {
    // Finalize
    if (text && !currentAgentBubble) {
      // Single complete message
      const div = document.createElement('div');
      div.className = 'msg msg-agent';
      const bubble = document.createElement('div');
      bubble.className = 'bubble';
      bubble.innerHTML = marked.parse(text);
      addCopyButtons(bubble);
      bubble.querySelectorAll('pre code').forEach(b => hljs.highlightElement(b));
      div.appendChild(bubble);
      chatEl.appendChild(div);
    }
    currentAgentBubble = null;
    currentAgentText = '';
    activityLog = [];
    scrollBottom();
  }
}

export function addSystemMsg(text) {
  const div = document.createElement('div');
  div.className = 'msg msg-system';
  div.innerHTML = `<div class="mc">${escapeHtml(text)}</div>`;
  chatEl.appendChild(div);
  scrollBottom();
}

export function addErrorMsg(text, onFix) {
  const div = document.createElement('div');
  div.className = 'msg-error';
  div.innerHTML = `<div class="err-text">${escapeHtml(text)}</div><button class="fix-btn">Try to Fix</button>`;
  div.querySelector('.fix-btn').onclick = () => onFix();
  chatEl.appendChild(div);
  scrollBottom();
}

export function showThinking() {
  if (thinkingEl) return;
  thinkingEl = document.createElement('div');
  thinkingEl.className = 'thinking';
  thinkingEl.innerHTML = '<div class="think-dots"><span></span><span></span><span></span></div> Thinking\u2026';
  chatEl.appendChild(thinkingEl);
  scrollBottom();
}

export function hideThinking() {
  if (thinkingEl) { thinkingEl.remove(); thinkingEl = null; }
}

export function showActivity(tool, input) {
  const icons = { Bash: '\u2699', Edit: '\u270E', Write: '\u270E', Read: '\uD83D\uDCC4', Glob: '\uD83D\uDD0D', Grep: '\uD83D\uDD0D' };
  const icon = icons[tool] || '\u26A1';
  const label = tool === 'Bash' ? (input?.command || '').slice(0, 70) :
    (tool === 'Edit' || tool === 'Write') ? 'Editing ' + (input?.file_path || '').split('/').pop() :
    tool === 'Read' ? 'Reading ' + (input?.file_path || '').split('/').pop() :
    tool === 'Glob' ? 'Searching ' + (input?.pattern || '') :
    tool === 'Grep' ? 'Searching ' + (input?.pattern || '') :
    tool;

  activityLog.push({ icon, label, ts: Date.now() });

  if (!activityEl) {
    activityEl = document.createElement('div');
    activityEl.className = 'activity-feed';
    activityEl.innerHTML = `
      <div class="activity-current">
        <span class="activity-spinner"></span>
        <span class="activity-label"></span>
        <span class="activity-chevron">\u25BC</span>
      </div>
      <div class="activity-log"></div>
    `;
    activityEl.querySelector('.activity-current').onclick = () => activityEl.classList.toggle('expanded');
    chatEl.appendChild(activityEl);
  }

  activityEl.querySelector('.activity-label').textContent = icon + ' ' + label;

  const log = activityEl.querySelector('.activity-log');
  const entry = document.createElement('div');
  entry.className = 'activity-entry';
  entry.textContent = icon + ' ' + label;
  log.appendChild(entry);
  log.scrollTop = log.scrollHeight;

  scrollBottom();
}

export function hideActivity() {
  // Don't remove — keep the log visible during the turn
  // Just remove the spinner
  if (activityEl) {
    const spinner = activityEl.querySelector('.activity-spinner');
    if (spinner) spinner.style.display = 'none';
  }
}

export function showDiffSummary(files) {
  if (!files || files.length === 0) return;
  const div = document.createElement('div');
  div.className = 'diff-summary';
  let filesHtml = files.map(f =>
    `<div class="diff-file"><span class="fname">${f.name}</span><span class="fstat"><span class="plus">+${f.additions || 0}</span> <span class="minus">-${f.deletions || 0}</span></span></div>`
  ).join('');
  div.innerHTML = `
    <div class="diff-header"><span class="chevron">\u25BC</span> ${files.length} file${files.length > 1 ? 's' : ''} changed</div>
    <div class="diff-files">${filesHtml}</div>
  `;
  div.querySelector('.diff-header').onclick = () => div.classList.toggle('expanded');
  chatEl.appendChild(div);
  activityEl = null; // Reset for next turn
  scrollBottom();
}

export function clearChat() {
  chatEl.innerHTML = '';
  currentAgentBubble = null;
  currentAgentText = '';
  activityLog = [];
}

export function loadMessages(msgs) {
  msgs.forEach(m => {
    try {
      const parsed = JSON.parse(m.content);
      const text = parsed.text || '';
      if (m.role === 'user') addUserMsg(text);
      else if (m.role === 'assistant') addAgentMsg(text, false);
      else addSystemMsg(text);
    } catch {
      if (m.role === 'user') addUserMsg(m.content);
      else addAgentMsg(m.content, false);
    }
  });
}

function addCopyButtons(container) {
  container.querySelectorAll('pre').forEach(pre => {
    if (pre.querySelector('.code-copy')) return;
    const btn = document.createElement('button');
    btn.className = 'code-copy';
    btn.textContent = 'Copy';
    btn.onclick = () => {
      navigator.clipboard.writeText(pre.textContent.replace(/Copy(ed!)?/, '').trim());
      btn.textContent = 'Copied!';
      btn.classList.add('copied');
      setTimeout(() => { btn.textContent = 'Copy'; btn.classList.remove('copied'); }, 1500);
    };
    pre.style.position = 'relative';
    pre.appendChild(btn);
  });
}

function scrollBottom() {
  chatEl.scrollTop = chatEl.scrollHeight;
}

function escapeHtml(s) {
  const d = document.createElement('div');
  d.textContent = s;
  return d.innerHTML;
}
