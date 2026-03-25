/**
 * Visual Edit Mode v3 — PostMessage Bridge Architecture
 * Communicates with a bridge script injected into the frontend iframe.
 * No same-origin access required; no Playwright fallback.
 *
 * Bridge protocol (postMessage):
 *   Parent -> Iframe: VE_ENABLE, VE_DISABLE, VE_PING, VE_HOVER, VE_CLICK, VE_HIGHLIGHT_CHANGE
 *   Iframe -> Parent: VE_BRIDGE_READY, VE_PONG, VE_ELEMENT_HOVERED,
 *                     VE_ELEMENT_SELECTED, VE_VIEWPORT_CHANGED
 */

let active = false;
let overlay = null;
let canvas = null;
let ctx = null;
let editPanel = null;
let previewFrame = null;
let onSendPrompt = null;
let pendingChangeSelector = null;
let bridgeReady = false;
let bridgeReadyTimer = null;
let infoToast = null;
const editHistory = [];
let hoverData = null;
let rafId = null;

export function initVisualEdit(frame, sendFn) {
  previewFrame = frame;
  onSendPrompt = sendFn;
  window.addEventListener('message', handleBridgeMessage);
}

export function toggleVisualEdit() {
  if (active) deactivate(); else activate();
  return active;
}

export function isVisualEditActive() { return active; }

export function deactivate() {
  active = false;
  hoverData = null;
  if (rafId) { cancelAnimationFrame(rafId); rafId = null; }
  if (overlay) { overlay.remove(); overlay = null; }
  if (canvas) { canvas.remove(); canvas = null; ctx = null; }
  if (editPanel) { editPanel.remove(); editPanel = null; }
  if (infoToast) { infoToast.remove(); infoToast = null; }
  if (bridgeReadyTimer) { clearTimeout(bridgeReadyTimer); bridgeReadyTimer = null; }
  document.getElementById('visual-edit-btn')?.classList.remove('active', 've-active');
  document.removeEventListener('keydown', handleEsc);
  postToBridge({ type: 'VE_DISABLE' });
}

export function getEditHistory() { return editHistory; }

export function toggleHistory() {
  const existing = document.querySelector('.ve-history-popover');
  if (existing) { existing.remove(); return; }
  const btn = document.getElementById('ve-history-btn');
  if (!btn) return;
  const popover = document.createElement('div');
  popover.className = 've-history-popover';
  if (editHistory.length === 0) {
    popover.innerHTML = '<div class="ve-history-empty">No edits yet</div>';
  } else {
    editHistory.slice(-10).reverse().forEach(entry => {
      const item = document.createElement('div');
      item.className = 've-history-item' + (entry.undone ? ' undone' : '');
      item.innerHTML = `<div class="ve-history-info"><div class="ve-history-name">${esc(entry.friendlyName)}</div><div class="ve-history-action">${esc(entry.action)}</div></div><span class="ve-history-time">${relativeTime(entry.timestamp)}</span>${entry.undone ? '' : '<button class="ve-history-undo">Undo</button>'}`;
      const undoBtn = item.querySelector('.ve-history-undo');
      if (undoBtn) undoBtn.onclick = (e) => { e.stopPropagation(); entry.undone = true; if (onSendPrompt) onSendPrompt('Undo the previous visual edit change to the ' + entry.friendlyName + ': revert ' + entry.action); popover.remove(); updateHistoryBadge(); };
      popover.appendChild(item);
    });
  }
  btn.appendChild(popover);
  const closeOnOutside = (e) => { if (!popover.contains(e.target) && e.target !== btn && !btn.contains(e.target)) { popover.remove(); document.removeEventListener('click', closeOnOutside); } };
  setTimeout(() => document.addEventListener('click', closeOnOutside), 0);
}

export function highlightChange(selector) {
  if (!selector) { pendingChangeSelector = null; return; }
  postToBridge({ type: 'VE_HIGHLIGHT_CHANGE', payload: { selector } });
  pendingChangeSelector = null;
}

export function getPendingChangeSelector() { return pendingChangeSelector; }

// ── Activation / Deactivation ──

function activate() {
  active = true; bridgeReady = false;
  document.getElementById('visual-edit-btn')?.classList.add('active');
  const wrap = document.getElementById('preview-wrap');
  if (!wrap) return;

  // Create canvas overlay for drawing highlights
  canvas = document.createElement('canvas');
  canvas.style.cssText = 'position:absolute;top:0;left:0;width:100%;height:100%;pointer-events:none;z-index:11;';
  wrap.appendChild(canvas);
  ctx = canvas.getContext('2d');
  resizeCanvas();

  // Create transparent interaction overlay (captures mouse events over iframe)
  overlay = document.createElement('div');
  overlay.className = 'visual-overlay';
  overlay.style.cssText = 'position:absolute;top:0;left:0;width:100%;height:100%;z-index:12;cursor:crosshair;';
  overlay.innerHTML = '<div class="ve-instruction">Click any element to edit</div>';
  wrap.appendChild(overlay);

  overlay.addEventListener('mousemove', handleMouseMove);
  overlay.addEventListener('click', handleClick);
  overlay.addEventListener('mouseleave', () => { hoverData = null; });
  document.addEventListener('keydown', handleEsc);

  // Tell bridge to enter selection mode
  postToBridge({ type: 'VE_ENABLE' });
  postToBridge({ type: 'VE_PING' });

  // If bridge doesn't respond in 3s, show fallback message
  bridgeReadyTimer = setTimeout(() => {
    if (!bridgeReady && active) showBridgeNotDetected();
  }, 3000);

  startRenderLoop();
}

function handleEsc(e) { if (e.key === 'Escape') { e.preventDefault(); deactivate(); } }

function postToBridge(msg) {
  try { previewFrame?.contentWindow?.postMessage(msg, '*'); } catch {}
}

// ── Bridge Message Handler ──

function handleBridgeMessage(e) {
  const msg = e.data;
  if (!msg || typeof msg.type !== 'string' || !msg.type.startsWith('VE_')) return;

  if (msg.type === 'VE_BRIDGE_READY' || msg.type === 'VE_PONG') {
    bridgeReady = true;
    if (bridgeReadyTimer) { clearTimeout(bridgeReadyTimer); bridgeReadyTimer = null; }
    if (infoToast) { infoToast.remove(); infoToast = null; }
    if (active) postToBridge({ type: 'VE_ENABLE' });
  } else if (msg.type === 'VE_ELEMENT_HOVERED' && active) {
    hoverData = msg.payload;
  } else if (msg.type === 'VE_ELEMENT_SELECTED' && active) {
    handleElementSelected(msg.payload);
  }
}

// ── Canvas Overlay Rendering ──

function resizeCanvas() {
  if (!canvas || !previewFrame) return;
  const r = previewFrame.getBoundingClientRect();
  canvas.width = r.width * devicePixelRatio;
  canvas.height = r.height * devicePixelRatio;
  canvas.style.width = r.width + 'px';
  canvas.style.height = r.height + 'px';
  if (ctx) ctx.setTransform(devicePixelRatio, 0, 0, devicePixelRatio, 0, 0);
}

function startRenderLoop() {
  function render() {
    if (!active || !ctx || !canvas) return;
    resizeCanvas();
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    if (hoverData && hoverData.rect) {
      const r = hoverData.rect;
      // Blue highlight rectangle
      ctx.strokeStyle = '#3b82f6';
      ctx.lineWidth = 2;
      ctx.setLineDash([]);
      ctx.strokeRect(r.left, r.top, r.width, r.height);
      // Light blue fill
      ctx.fillStyle = 'rgba(59, 130, 246, 0.08)';
      ctx.fillRect(r.left, r.top, r.width, r.height);
      // Label with component name + dimensions
      const label = (hoverData.componentName || hoverData.tagName || 'Element') +
        '  ' + Math.round(r.width) + ' x ' + Math.round(r.height);
      ctx.font = '600 11px "DM Sans", system-ui, sans-serif';
      const tw = ctx.measureText(label).width;
      const lH = 18, lW = tw + 12;
      const lX = r.left;
      const lY = r.top > 24 ? r.top - lH - 4 : r.top + r.height + 4;
      ctx.fillStyle = '#3b82f6';
      ctx.beginPath();
      ctx.roundRect(lX, lY, lW, lH, 3);
      ctx.fill();
      ctx.fillStyle = '#fff';
      ctx.textBaseline = 'middle';
      ctx.fillText(label, lX + 6, lY + lH / 2);
    }
    rafId = requestAnimationFrame(render);
  }
  rafId = requestAnimationFrame(render);
}

// ── Mouse Forwarding ──

function handleMouseMove(e) {
  if (!previewFrame) return;
  const r = previewFrame.getBoundingClientRect();
  postToBridge({ type: 'VE_HOVER', payload: { x: e.clientX - r.left, y: e.clientY - r.top } });
}

function handleClick(e) {
  if (!previewFrame) return;
  const r = previewFrame.getBoundingClientRect();
  postToBridge({ type: 'VE_CLICK', payload: { x: e.clientX - r.left, y: e.clientY - r.top } });
  const inst = overlay?.querySelector('.ve-instruction');
  if (inst) inst.style.opacity = '0';
}

// ── Element Selection Handler ──

function handleElementSelected(payload) {
  if (!payload) return;
  renderEditPanel({
    friendlyName: friendlyNameFromData(payload.tagName, payload.className, payload.componentName),
    text: payload.text || '',
    screenshot: null,
    component: payload.componentName || null,
    filePath: payload.filePath || null,
    lineNum: payload.lineNumber || null,
    selector: payload.selector || '',
    tag: payload.tagName || 'div',
    classes: payload.className || '',
    styles: payload.styles || {},
    ancestors: (payload.ancestors || []).map(a => ({
      element: null,
      name: friendlyNameFromData(a.tagName, a.className, a.componentName)
    })),
    element: null,
  });
}

// ── Friendly Name Helpers ──

const TAG_NAMES = {
  button: 'Button', a: 'Link', img: 'Image', p: 'Paragraph',
  input: 'Input Field', textarea: 'Text Area', select: 'Dropdown',
  table: 'Table', tr: 'Table Row', td: 'Table Cell', th: 'Table Cell',
  ul: 'List', ol: 'List', li: 'List Item', nav: 'Navigation',
  header: 'Header', footer: 'Footer', form: 'Form', label: 'Label',
  span: 'Text', div: 'Section', svg: 'Icon', video: 'Video', audio: 'Audio',
  h1: 'Heading', h2: 'Heading', h3: 'Heading', h4: 'Heading', h5: 'Heading', h6: 'Heading',
  section: 'Section', main: 'Main Content', aside: 'Sidebar', article: 'Article',
};

const MUI_NAMES = {
  MuiButton: 'Button', MuiCard: 'Card', MuiAppBar: 'Top Navigation Bar',
  MuiDrawer: 'Sidebar', MuiTable: 'Table', MuiTextField: 'Text Field',
  MuiSelect: 'Dropdown', MuiChip: 'Tag', MuiAvatar: 'Avatar',
  MuiDialog: 'Dialog', MuiTab: 'Tab', MuiTabs: 'Tab Bar',
  MuiPaper: 'Panel', MuiList: 'List', MuiMenu: 'Menu',
  MuiToolbar: 'Toolbar', MuiIconButton: 'Icon Button', MuiBadge: 'Badge',
  MuiAlert: 'Alert', MuiSnackbar: 'Notification', MuiGrid: 'Grid Layout',
  MuiContainer: 'Container', MuiTypography: 'Text', MuiDivider: 'Divider',
  MuiSwitch: 'Toggle Switch', MuiCheckbox: 'Checkbox', MuiRadio: 'Radio Button',
  MuiStepper: 'Progress Steps', MuiBreadcrumbs: 'Breadcrumb',
  MuiPagination: 'Pagination', MuiAccordion: 'Collapsible Section',
  MuiTooltip: 'Tooltip', MuiSkeleton: 'Loading Placeholder',
  MuiDataGrid: 'Data Table',
};

function friendlyNameFromData(tag, classes, componentName) {
  if (componentName) {
    const w = componentName.replace(/([a-z])([A-Z])/g, '$1 $2').replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2');
    return w.replace(/\s*(Component|Wrapper|Container|View|Page)$/i, '').trim() || componentName;
  }
  if (classes) {
    for (const [k, v] of Object.entries(MUI_NAMES)) {
      if (classes.includes(k)) {
        if (k === 'MuiTypography') {
          if (classes.includes('h1') || classes.includes('h2') || classes.includes('h3')) return 'Heading';
          if (classes.includes('body')) return 'Paragraph';
        }
        return v;
      }
    }
  }
  return TAG_NAMES[tag] || (tag ? tag.charAt(0).toUpperCase() + tag.slice(1) : 'Element');
}

// ── Smart Chips ──

function getChipsForElement(ed) {
  const tag = ed.tag, cls = ed.classes || '', nm = ed.friendlyName;

  if (tag === 'button' || cls.includes('MuiButton') || cls.includes('MuiIconButton'))
    return [{icon:'✏️',label:'Change label',type:'text'},{icon:'🎨',label:'Change color',type:'color'},{icon:'⭕',label:'Make rounded',type:'toggle'},{icon:'▢',label:'Make outlined',type:'toggle'},{icon:'↑',label:'Make larger',type:'toggle'},{icon:'↓',label:'Make smaller',type:'toggle'},{icon:'👁️',label:'Hide element',type:'toggle'}];

  if (/^h[1-6]$/.test(tag) || tag === 'p' || tag === 'span' || cls.includes('MuiTypography'))
    return [{icon:'✏️',label:'Change text',type:'text'},{icon:'🎨',label:'Change color',type:'color'},{icon:'↑',label:'Make larger',type:'toggle'},{icon:'↓',label:'Make smaller',type:'toggle'},{icon:'B',label:'Make bold',type:'toggle'},{icon:'≡',label:'Align center',type:'toggle'},{icon:'👁️',label:'Hide element',type:'toggle'}];

  if (tag === 'img' || cls.includes('MuiAvatar'))
    return [{icon:'↑',label:'Make larger',type:'toggle'},{icon:'↓',label:'Make smaller',type:'toggle'},{icon:'⭕',label:'Make rounded',type:'toggle'},{icon:'🖼️',label:'Add border',type:'toggle'},{icon:'💫',label:'Add shadow',type:'toggle'},{icon:'👁️',label:'Hide element',type:'toggle'}];

  if (cls.includes('MuiCard') || cls.includes('MuiPaper') || cls.includes('card'))
    return [{icon:'🎨',label:'Change background',type:'color'},{icon:'💫',label:'Add shadow',type:'toggle'},{icon:'⭕',label:'Round corners',type:'toggle'},{icon:'↕️',label:'More padding',type:'toggle'},{icon:'↕️',label:'Less padding',type:'toggle'},{icon:'🖼️',label:'Add border',type:'toggle'},{icon:'👁️',label:'Hide element',type:'toggle'}];

  if (tag === 'input' || tag === 'textarea' || cls.includes('MuiTextField') || cls.includes('MuiSelect'))
    return [{icon:'✏️',label:'Change placeholder',type:'text'},{icon:'↑',label:'Make larger',type:'toggle'},{icon:'⭕',label:'Round corners',type:'toggle'},{icon:'🎨',label:'Change border color',type:'color'},{icon:'👁️',label:'Hide element',type:'toggle'}];

  if (tag === 'table' || cls.includes('MuiTable') || cls.includes('MuiDataGrid'))
    return [{icon:'🎨',label:'Stripe rows',type:'toggle'},{icon:'🖼️',label:'Add borders',type:'toggle'},{icon:'↑',label:'Make header bold',type:'toggle'},{icon:'↕️',label:'More row spacing',type:'toggle'},{icon:'👁️',label:'Hide element',type:'toggle'}];

  if (tag === 'nav' || cls.includes('MuiAppBar') || cls.includes('MuiDrawer') || cls.includes('MuiTabs'))
    return [{icon:'🎨',label:'Change background',type:'color'},{icon:'✏️',label:'Change color',type:'color'},{icon:'💫',label:'Add shadow',type:'toggle'},{icon:'👁️',label:'Hide element',type:'toggle'}];

  if (tag === 'ul' || tag === 'ol' || cls.includes('MuiList'))
    return [{icon:'↕️',label:'More spacing',type:'toggle'},{icon:'↕️',label:'Less spacing',type:'toggle'},{icon:'🖼️',label:'Add dividers',type:'toggle'},{icon:'🎨',label:'Alternate colors',type:'toggle'},{icon:'👁️',label:'Hide element',type:'toggle'}];

  // Default
  return [{icon:'🎨',label:'Change background',type:'color'},{icon:'↕️',label:'More padding',type:'toggle'},{icon:'↕️',label:'Less padding',type:'toggle'},{icon:'💫',label:'Add shadow',type:'toggle'},{icon:'🖼️',label:'Add border',type:'toggle'},{icon:'⭕',label:'Round corners',type:'toggle'},{icon:'👁️',label:'Hide element',type:'toggle'}];
}

const COLOR_PRESETS = ['#ef4444','#f59e0b','#22c55e','#3b82f6','#8b5cf6','#ec4899','#ffffff','#000000'];

function renderChips(chips, container, onUpdate) {
  const state = { selected: new Map(), customText: '' };
  const cd = document.createElement('div'); cd.className = 've-chips';
  const ea = document.createElement('div'); ea.className = 've-chip-expand-area';

  chips.forEach(chip => {
    const el = document.createElement('span'); el.className = 've-chip';
    el.innerHTML = '<span>' + chip.icon + '</span> ' + chip.label;
    el.onclick = () => {
      if (chip.type === 'toggle') {
        const s = el.classList.toggle('selected');
        if (s) state.selected.set(chip.label, true); else state.selected.delete(chip.label);
        onUpdate(state);
      } else if (chip.type === 'text') {
        ea.innerHTML = '';
        const inp = document.createElement('input'); inp.type = 'text'; inp.className = 've-chip-input';
        inp.placeholder = 'New ' + chip.label.replace('Change ','').toLowerCase() + '...';
        inp.oninput = () => { if (inp.value.trim()) state.selected.set(chip.label, inp.value.trim()); else state.selected.delete(chip.label); onUpdate(state); };
        const w = document.createElement('div'); w.className = 've-chip-expand';
        w.appendChild(inp); ea.appendChild(w); el.classList.add('selected');
        setTimeout(() => inp.focus(), 50);
      } else if (chip.type === 'color') {
        ea.innerHTML = '';
        const w = document.createElement('div'); w.className = 've-chip-expand';
        const g = document.createElement('div'); g.className = 've-color-grid';
        COLOR_PRESETS.forEach(c => {
          const sw = document.createElement('div'); sw.className = 've-color-swatch'; sw.style.background = c;
          sw.style.border = c === '#ffffff' ? '2px solid var(--border)' : '2px solid transparent';
          sw.onclick = (ev) => {
            ev.stopPropagation(); state.selected.set(chip.label, c); el.classList.add('selected');
            let b = el.querySelector('.ve-chip-color-badge');
            if (!b) { b = document.createElement('span'); b.className = 've-chip-color-badge'; el.appendChild(b); }
            b.style.background = c; ea.innerHTML = ''; onUpdate(state);
          };
          g.appendChild(sw);
        });
        const hi = document.createElement('input'); hi.type = 'text'; hi.className = 've-chip-input';
        hi.placeholder = '#hex'; hi.style.width = '80px';
        hi.oninput = () => {
          if (hi.value.trim()) { state.selected.set(chip.label, hi.value.trim()); el.classList.add('selected'); }
          else { state.selected.delete(chip.label); el.classList.remove('selected'); }
          onUpdate(state);
        };
        w.appendChild(g); w.appendChild(hi); ea.appendChild(w);
      }
    };
    cd.appendChild(el);
  });

  const iw = document.createElement('div'); iw.className = 've-main-input';
  const mi = document.createElement('input'); mi.type = 'text'; mi.className = 've-prompt-input';
  mi.placeholder = 'Describe what you want to change...';
  mi.oninput = () => { state.customText = mi.value.trim(); onUpdate(state); };
  mi.onkeydown = (e) => {
    if (e.key === 'Enter' && (state.customText || state.selected.size > 0)) {
      e.preventDefault();
      const sb = document.querySelector('.ve-send');
      if (sb && !sb.disabled) sb.click();
    }
  };
  iw.appendChild(mi);
  container.appendChild(cd); container.appendChild(ea); container.appendChild(iw);
  setTimeout(() => mi.focus(), 100);
  return state;
}

// ── Edit Panel ──

function renderEditPanel(ed) {
  if (editPanel) editPanel.remove();
  const rp = document.querySelector('.right-panel');
  if (!rp) return;

  editPanel = document.createElement('div');
  editPanel.className = 'edit-panel';

  // Header
  const hd = document.createElement('div'); hd.className = 've-header';
  hd.innerHTML = '<span class="ve-title">' + esc(ed.friendlyName) + '</span><button class="ve-close">&times;</button>';
  hd.querySelector('.ve-close').onclick = () => { editPanel.remove(); editPanel = null; };
  editPanel.appendChild(hd);

  // Breadcrumb
  if (ed.ancestors && ed.ancestors.length > 0) editPanel.appendChild(renderBreadcrumb(ed));

  // File info
  if (ed.filePath) {
    const fi = document.createElement('div'); fi.className = 've-file-info';
    fi.innerHTML = '<span class="ve-file-icon">📄</span> <span class="ve-file-path">' +
      esc(ed.filePath) + (ed.lineNum ? ':' + ed.lineNum : '') + '</span>';
    editPanel.appendChild(fi);
  }

  // Info section (text preview, styles)
  const info = document.createElement('div'); info.className = 've-info';
  let ih = '';
  if (ed.text) {
    const t = ed.text.length > 80 ? ed.text.slice(0, 77) + '...' : ed.text;
    ih += '<div class="ve-text-preview">"' + esc(t) + '"</div>';
  }
  if (ed.styles && Object.values(ed.styles).some(v => v)) {
    const s = ed.styles, p = [];
    if (s.color) p.push('<span class="ve-style-swatch" style="background:' + s.color + '"></span> ' + s.color);
    if (s.backgroundColor && s.backgroundColor !== 'rgba(0, 0, 0, 0)' && s.backgroundColor !== 'transparent')
      p.push('<span class="ve-style-swatch" style="background:' + s.backgroundColor + '"></span> bg: ' + s.backgroundColor);
    if (s.fontSize) p.push(s.fontSize);
    if (p.length) ih += '<div class="ve-styles-preview">' + p.join(' &middot; ') + '</div>';
  }
  if (ih) { info.innerHTML = ih; editPanel.appendChild(info); }

  // Chips section
  const cc = document.createElement('div'); cc.className = 've-chips-section';

  // Actions
  const acts = document.createElement('div'); acts.className = 've-actions';
  const cb = document.createElement('button'); cb.className = 've-cancel'; cb.textContent = 'Cancel';
  cb.onclick = () => { editPanel.remove(); editPanel = null; };
  const sb = document.createElement('button'); sb.className = 've-send'; sb.textContent = 'Send to Agent ✨';
  sb.disabled = true;

  const upd = (st) => {
    const c = st.selected.size + (st.customText ? 1 : 0);
    sb.disabled = c === 0;
    sb.textContent = c > 0 ? 'Send ' + c + ' change' + (c > 1 ? 's' : '') + ' ✨' : 'Send to Agent ✨';
  };
  const cs = renderChips(getChipsForElement(ed), cc, upd);
  editPanel.appendChild(cc);

  sb.onclick = () => {
    if (!onSendPrompt) return;
    const pr = buildPrompt(ed, cs.selected, cs.customText);
    const sm = [...cs.selected.entries()].map(([k,v]) => v === true ? k : k + ' → ' + v).join(', ');
    pendingChangeSelector = ed.selector;
    editHistory.push({
      id: crypto.randomUUID(),
      timestamp: Date.now(),
      friendlyName: ed.friendlyName,
      action: sm || cs.customText || 'Custom change',
      prompt: pr,
      selector: ed.selector,
      undone: false,
    });
    updateHistoryBadge();
    onSendPrompt(pr);
    deactivate();
  };

  acts.appendChild(cb); acts.appendChild(sb);
  editPanel.appendChild(acts);
  rp.appendChild(editPanel);
}

function renderBreadcrumb(ed) {
  const bc = document.createElement('div'); bc.className = 've-breadcrumb';
  [{ name: 'Page' }, ...ed.ancestors, { name: ed.friendlyName }].forEach((item, i, arr) => {
    if (i > 0) {
      const s = document.createElement('span'); s.className = 've-breadcrumb-sep'; s.textContent = '›';
      bc.appendChild(s);
    }
    const sp = document.createElement('span');
    sp.className = 've-breadcrumb-item' + (i === arr.length - 1 ? ' active' : '');
    sp.textContent = item.name;
    bc.appendChild(sp);
  });
  return bc;
}

// ── Prompt Builder ──

function buildPrompt(ed, sel, txt) {
  const l = [
    'VISUAL EDIT REQUEST',
    '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━',
    '',
    'Target: ' + ed.friendlyName + (ed.text ? ' — "' + ed.text.slice(0, 60) + '"' : ''),
  ];
  if (ed.filePath) l.push('File: ' + ed.filePath + (ed.lineNum ? ':' + ed.lineNum : ''));
  if (ed.component) l.push('Component: ' + ed.component);
  if (ed.selector) l.push('Selector: ' + ed.selector);
  if (ed.classes) l.push('Classes: ' + ed.classes);

  if (ed.styles && Object.values(ed.styles).some(v => v)) {
    l.push('', 'Current styles:');
    const s = ed.styles, p = [];
    if (s.color) p.push('color: ' + s.color);
    if (s.backgroundColor) p.push('background: ' + s.backgroundColor);
    if (s.fontSize) p.push('font-size: ' + s.fontSize);
    if (s.padding) p.push('padding: ' + s.padding);
    if (s.margin) p.push('margin: ' + s.margin);
    l.push('  ' + p.join('  |  '));
  }

  l.push('', 'Requested changes:');
  for (const [a, v] of sel) l.push(v === true ? '  • ' + a : '  • ' + a + ' → new value: ' + v);
  if (txt) l.push('  • Custom: ' + txt);

  l.push('', 'IMPORTANT: Only modify the targeted element described above. Do NOT change global theme, MUI theme, layout wrappers, or App-level styles. Apply changes via the component\'s own styles (sx prop, className, or styled-components) scoped to this specific element in ' + (ed.filePath || 'the component file') + '.');

  return l.join('\n');
}

// ── Bridge Not Detected Toast ──

function showBridgeNotDetected() {
  const wrap = document.getElementById('preview-wrap');
  if (!wrap || infoToast) return;
  infoToast = document.createElement('div');
  infoToast.className = 've-bridge-toast';
  infoToast.innerHTML = '<div class="ve-toast-icon">ℹ️</div><div class="ve-toast-text"><strong>Visual editing bridge not detected.</strong><br>Make sure the frontend is running with the visual-bridge script injected.<br><small>The bridge auto-injects when loading the preview through the proxy.</small></div><button class="ve-toast-close" onclick="this.parentElement.remove()">&times;</button>';
  wrap.appendChild(infoToast);
}

// ── Utilities ──

function esc(t) { return t.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'); }

function relativeTime(ts) {
  const d = Date.now() - ts;
  if (d < 60000) return 'just now';
  if (d < 3600000) return Math.floor(d / 60000) + 'm ago';
  if (d < 86400000) return Math.floor(d / 3600000) + 'h ago';
  return Math.floor(d / 86400000) + 'd ago';
}

function updateHistoryBadge() {
  const btn = document.getElementById('ve-history-btn');
  if (!btn) return;
  btn.style.display = editHistory.length > 0 ? '' : 'none';
  let b = btn.querySelector('.ve-history-badge');
  if (editHistory.length > 0) {
    if (!b) { b = document.createElement('span'); b.className = 've-history-badge'; btn.appendChild(b); }
    b.textContent = editHistory.length;
  } else if (b) b.remove();
}
