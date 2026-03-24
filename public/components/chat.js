let chatEl = null;
let currentAgentBubble = null;
let currentAgentText = '';
let renderPending = false;
let thinkingEl = null;
let activityEl = null;
let activityLog = [];

export function initChat(el) {
  chatEl = el;
}

function timeLabel() {
  return new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

export function addUserMsg(text, attachHtml) {
  const div = document.createElement('div');
  div.className = 'msg msg-user';
  div.innerHTML = `${attachHtml ? `<div class="msg-attachments">${attachHtml}</div>` : ''}<div class="bubble">${escapeHtml(text)}</div><span class="msg-time">${timeLabel()}</span>`;
  chatEl.appendChild(div);
  maybeCollapse(div.querySelector('.bubble'));
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
    if (!renderPending) {
      renderPending = true;
      requestAnimationFrame(() => {
        if (currentAgentBubble) {
          currentAgentBubble.innerHTML = marked.parse(currentAgentText);
          addCopyButtons(currentAgentBubble);
          currentAgentBubble.querySelectorAll('pre code').forEach(b => hljs.highlightElement(b));
          scrollBottom();
        }
        renderPending = false;
      });
    }
  } else if (!streaming) {
    // Finalize
    if (text && !currentAgentBubble) {
      // Single complete message (e.g. loaded from history)
      const div = document.createElement('div');
      div.className = 'msg msg-agent';
      const bubble = document.createElement('div');
      bubble.className = 'bubble';
      bubble.innerHTML = marked.parse(text);
      addCopyButtons(bubble);
      bubble.querySelectorAll('pre code').forEach(b => hljs.highlightElement(b));
      div.appendChild(bubble);
      // Collapse long messages from history
      maybeCollapse(bubble);
      chatEl.appendChild(div);
    }
    if (currentAgentBubble) {
      // Collapse long streamed messages after finalization
      maybeCollapse(currentAgentBubble);
      // Show activity timeline if tools were used
      if (activityLog.length > 0) {
        const timelineEl = document.createElement('div');
        timelineEl.className = 'activity-timeline collapsed';
        const items = activityLog.map(a => `<span class="timeline-item">${a.icon} ${a.label}</span>`).join(' \u2192 ');
        timelineEl.innerHTML = `<button class="timeline-toggle" onclick="this.parentElement.classList.toggle('collapsed')">Activity (${activityLog.length} tools)</button><div class="timeline-items">${items}</div>`;
        currentAgentBubble.parentElement.appendChild(timelineEl);
      }
      // Add timestamp to the parent msg div
      const timeSpan = document.createElement('span');
      timeSpan.className = 'msg-time';
      timeSpan.textContent = timeLabel();
      currentAgentBubble.parentElement.appendChild(timeSpan);
    }
    currentAgentBubble = null;
    currentAgentText = '';
    activityEl = null;
    activityLog = [];
    scrollBottom();
  }
}

// Collapse long agent responses — show first ~4 lines with "Show more"
function maybeCollapse(bubble) {
  const COLLAPSE_THRESHOLD = 600; // chars
  const text = bubble.textContent || '';
  if (text.length < COLLAPSE_THRESHOLD) return;

  bubble.classList.add('collapsed');
  const toggle = document.createElement('button');
  toggle.className = 'collapse-toggle';
  toggle.textContent = 'Show more';
  toggle.onclick = () => {
    const isCollapsed = bubble.classList.toggle('collapsed');
    toggle.textContent = isCollapsed ? 'Show more' : 'Show less';
  };
  bubble.parentElement.appendChild(toggle);
}

let currentTurnFooter = null;

function ensureTurnFooter() {
  if (!currentTurnFooter) {
    currentTurnFooter = document.createElement('div');
    currentTurnFooter.className = 'turn-footer';
    chatEl.appendChild(currentTurnFooter);
  }
  return currentTurnFooter;
}

export function finalizeTurnFooter() {
  currentTurnFooter = null;
}

export function getTurnFooter() {
  return ensureTurnFooter();
}

export function showTurnCost(cost, model) {
  if (!cost || cost <= 0) return;
  const footer = ensureTurnFooter();
  const modelLabel = model ? ` \u00b7 ${model}` : '';
  const span = document.createElement('span');
  span.className = 'turn-cost';
  span.textContent = `$${cost.toFixed(4)}${modelLabel}`;
  span.title = `This turn cost $${cost.toFixed(4)}`;
  footer.appendChild(span);
  scrollBottom();
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

function getToolLabel(tool, input) {
  const icons = { Bash: '\u2699', Edit: '\u270E', Write: '\u270E', Read: '\uD83D\uDCC4', Glob: '\uD83D\uDD0D', Grep: '\uD83D\uDD0D', Agent: '\uD83E\uDD16', WebFetch: '\uD83C\uDF10' };
  const icon = icons[tool] || '\u26A1';
  const label = tool === 'Bash' ? (input?.command || '').slice(0, 70) :
    (tool === 'Edit' || tool === 'Write') ? 'Editing ' + (input?.file_path || '').split('/').pop() :
    tool === 'Read' ? 'Reading ' + (input?.file_path || '').split('/').pop() :
    tool === 'Glob' ? 'Searching ' + (input?.pattern || '') :
    tool === 'Grep' ? 'Searching ' + (input?.pattern || '') :
    tool === 'Agent' ? (input?.description || 'Running sub-agent') :
    tool;
  return { icon, label };
}

export function showActivity(tool, input) {
  const { icon, label } = getToolLabel(tool, input);

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
  }

  // Always keep activity feed at the bottom of chat
  chatEl.appendChild(activityEl);

  // Ensure spinner is visible (hideActivity may have hidden it)
  const spinner = activityEl.querySelector('.activity-spinner');
  if (spinner) spinner.style.display = '';

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
  if (activityEl) {
    const spinner = activityEl.querySelector('.activity-spinner');
    if (spinner) spinner.style.display = 'none';
  }
}

export function showDiffSummary(files) {
  if (!files || files.length === 0) return;
  hideActivity();
  const footer = ensureTurnFooter();
  const div = document.createElement('div');
  div.className = 'diff-summary';
  let filesHtml = files.map(f => {
    const shortName = f.name.split('/').pop();
    const hasStats = (f.additions || 0) > 0 || (f.deletions || 0) > 0;
    const statHtml = hasStats ? `<span class="fstat"><span class="plus">+${f.additions}</span> <span class="minus">-${f.deletions}</span></span>` : '';
    return `<div class="diff-file"><span class="fname" title="${escapeHtml(f.name)}">${escapeHtml(shortName)}</span>${statHtml}</div>`;
  }).join('');
  div.innerHTML = `
    <div class="diff-header"><span class="chevron">\u25BC</span> ${files.length} file${files.length > 1 ? 's' : ''} changed</div>
    <div class="diff-files">${filesHtml}</div>
  `;
  div.querySelector('.diff-header').onclick = () => div.classList.toggle('expanded');
  footer.prepend(div);
  activityEl = null;
  scrollBottom();
}

export function clearChat() {
  chatEl.innerHTML = '';
  currentAgentBubble = null;
  currentAgentText = '';
  activityLog = [];
  currentTurnFooter = null;
}

export function addScreenshot(base64, caption) {
  const div = document.createElement('div');
  div.className = 'msg-screenshot';
  div.innerHTML = `
    <img src="data:image/png;base64,${base64}" alt="Preview screenshot">
    ${caption ? `<div class="screenshot-caption">${caption}</div>` : ''}
  `;
  chatEl.appendChild(div);
  scrollBottom();
}

export function detectAndRenderQuestion(text, onAnswer) {
  // Let the conversation flow naturally — no synthetic UI for agent questions.
  // Matches Claude Code CLI behavior: user reads the response and types a reply.
  return false;
}

function flushToolBatch(batch) {
  if (batch.length === 0) return;
  const timeline = document.createElement('div');
  timeline.className = 'activity-timeline collapsed';
  const items = batch.map(t => `<span class="timeline-item">${t.icon} ${t.label}</span>`).join(' \u2192 ');
  timeline.innerHTML = `<button class="timeline-toggle">Activity (${batch.length} tool${batch.length !== 1 ? 's' : ''})</button><div class="timeline-items">${items}</div>`;
  timeline.querySelector('.timeline-toggle').onclick = () => timeline.classList.toggle('collapsed');
  chatEl.appendChild(timeline);
}

export function loadMessages(msgs) {
  let toolBatch = [];
  msgs.forEach(m => {
    try {
      const parsed = JSON.parse(m.content);
      const text = parsed.text || '';
      const isToolEvent = m.role === 'event' && parsed.type === 'tool_activity';
      if (isToolEvent) {
        const { icon, label } = getToolLabel(parsed.tool, parsed.input);
        toolBatch.push({ icon, label });
        return;
      }
      // Flush any pending tool batch before rendering other message types
      flushToolBatch(toolBatch);
      toolBatch = [];
      if (m.role === 'user') {
        finalizeTurnFooter();
        addUserMsg(text);
      } else if (m.role === 'assistant') addAgentMsg(text, false);
      else if (m.role === 'result') {
        showTurnCost(parsed.cost_usd, parsed.model);
        finalizeTurnFooter();
      } else if (m.role === 'event') {
        if (parsed.type === 'file_diff') showDiffSummary(parsed.files);
        else if (parsed.type === 'system') addSystemMsg(parsed.text);
        else if (parsed.type === 'screenshot') addScreenshot(parsed.image, parsed.caption);
      }
      else addSystemMsg(text);
    } catch {
      if (m.role === 'user') addUserMsg(m.content);
      else addAgentMsg(m.content, false);
    }
  });
  // Flush any remaining tool batch
  flushToolBatch(toolBatch);
}

function addCopyButtons(container) {
  container.querySelectorAll('pre').forEach(pre => {
    if (pre.querySelector('.code-copy')) return;
    const btn = document.createElement('button');
    btn.className = 'code-copy';
    btn.textContent = 'Copy';
    btn.onclick = () => {
      const text = pre.textContent.replace(/Copy(ed!)?/, '').trim();
      try { navigator.clipboard.writeText(text); } catch { const ta = document.createElement('textarea'); ta.value = text; document.body.appendChild(ta); ta.select(); document.execCommand('copy'); document.body.removeChild(ta); }
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
