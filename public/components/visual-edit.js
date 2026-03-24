/**
 * Visual Edit Mode v2 — Smart Component Editor
 * Non-engineer friendly visual element editor with:
 * - Friendly labels, breadcrumb navigation, smart chips
 * - Unified edit panel, structured prompt builder
 * - Edit history with undo, change confirmation pulse
 */

// ── State ──
let active = false;
let overlay = null;
let editPanel = null;
let selectedElement = null;
let previewFrame = null;
let onSendPrompt = null;
let injectedStyle = null;
let pendingChangeSelector = null;
const editHistory = [];

// ── Public API ──

export function initVisualEdit(frame, sendFn) {
  previewFrame = frame;
  onSendPrompt = sendFn;
}

export function toggleVisualEdit() {
  if (active) deactivate();
  else activate();
  return active;
}

export function isVisualEditActive() {
  return active;
}

export function deactivate() {
  active = false;
  if (overlay) { overlay.remove(); overlay = null; }
  if (editPanel) { editPanel.remove(); editPanel = null; }
  selectedElement = null;
  cleanupIframeStyles();
  document.getElementById('visual-edit-btn')?.classList.remove('active');
  document.getElementById('visual-edit-btn')?.classList.remove('ve-active');
  document.removeEventListener('keydown', handleEsc);
}

export function getEditHistory() {
  return editHistory;
}

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
    const items = editHistory.slice(-10).reverse();
    items.forEach(entry => {
      const item = document.createElement('div');
      item.className = 've-history-item' + (entry.undone ? ' undone' : '');
      item.innerHTML = `
        <div class="ve-history-info">
          <div class="ve-history-name">${entry.friendlyName}</div>
          <div class="ve-history-action">${entry.action}</div>
        </div>
        <span class="ve-history-time">${relativeTime(entry.timestamp)}</span>
        ${entry.undone ? '' : '<button class="ve-history-undo">Undo</button>'}
      `;
      const undoBtn = item.querySelector('.ve-history-undo');
      if (undoBtn) {
        undoBtn.onclick = (e) => {
          e.stopPropagation();
          entry.undone = true;
          if (onSendPrompt) {
            onSendPrompt(`Undo the previous visual edit change to the ${entry.friendlyName}: revert ${entry.action}`);
          }
          popover.remove();
          updateHistoryBadge();
        };
      }
      popover.appendChild(item);
    });
  }

  btn.appendChild(popover);

  // Close on outside click
  const closeOnOutside = (e) => {
    if (!popover.contains(e.target) && e.target !== btn && !btn.contains(e.target)) {
      popover.remove();
      document.removeEventListener('click', closeOnOutside);
    }
  };
  setTimeout(() => document.addEventListener('click', closeOnOutside), 0);
}

export function highlightChange(selector) {
  if (!selector) { pendingChangeSelector = null; return; }
  try {
    const iframeDoc = previewFrame?.contentDocument;
    if (!iframeDoc) { pendingChangeSelector = null; return; }

    const el = iframeDoc.querySelector(selector);
    if (!el) { pendingChangeSelector = null; return; }

    // Inject pulse animation if not already present
    let style = iframeDoc.getElementById('ve-confirm-styles');
    if (!style) {
      style = iframeDoc.createElement('style');
      style.id = 've-confirm-styles';
      style.textContent = `
        @keyframes ve-confirm-pulse {
          0%   { box-shadow: 0 0 0 0 rgba(51, 209, 122, 0.5); }
          50%  { box-shadow: 0 0 0 8px rgba(51, 209, 122, 0.15); }
          100% { box-shadow: 0 0 0 0 rgba(51, 209, 122, 0); }
        }
        .ve-change-confirmed { animation: ve-confirm-pulse 0.6s ease 3; }
      `;
      iframeDoc.head.appendChild(style);
    }

    el.classList.add('ve-change-confirmed');
    setTimeout(() => {
      el.classList.remove('ve-change-confirmed');
    }, 2000);
  } catch {
    // Cross-origin — skip silently
  }
  pendingChangeSelector = null;
}

export function getPendingChangeSelector() {
  return pendingChangeSelector;
}

// ── Activation ──

function activate() {
  active = true;
  document.getElementById('visual-edit-btn')?.classList.add('active');

  const wrap = document.getElementById('preview-wrap');
  if (!wrap) return;

  overlay = document.createElement('div');
  overlay.className = 'visual-overlay';
  overlay.innerHTML = `
    <div class="ve-instruction">Click any element to edit</div>
    <div class="ve-label" style="opacity:0"></div>
  `;
  wrap.appendChild(overlay);

  // Inject hover styles into iframe
  injectIframeStyles();

  overlay.addEventListener('mousemove', handleMouseMove);
  overlay.addEventListener('click', handleClick);
  document.addEventListener('keydown', handleEsc);
}

function handleEsc(e) {
  if (e.key === 'Escape') {
    e.preventDefault();
    deactivate();
  }
}

// ── Iframe style injection ──

function injectIframeStyles() {
  try {
    const iframeDoc = previewFrame?.contentDocument;
    if (!iframeDoc) return;
    if (iframeDoc.getElementById('ve-injected-styles')) return;

    injectedStyle = iframeDoc.createElement('style');
    injectedStyle.id = 've-injected-styles';
    injectedStyle.textContent = `
      .ve-hover {
        outline: 2px solid #33d17a !important;
        background-color: rgba(51, 209, 122, 0.06) !important;
      }
      .ve-selected {
        outline: 2px solid #33d17a !important;
        box-shadow: 0 0 0 4px rgba(51, 209, 122, 0.15) !important;
      }
    `;
    iframeDoc.head.appendChild(injectedStyle);
  } catch {
    // Cross-origin — no iframe access
  }
}

function cleanupIframeStyles() {
  try {
    const iframeDoc = previewFrame?.contentDocument;
    if (!iframeDoc) return;
    iframeDoc.getElementById('ve-injected-styles')?.remove();
    iframeDoc.querySelectorAll('.ve-hover, .ve-selected').forEach(el => {
      el.classList.remove('ve-hover', 've-selected');
    });
    injectedStyle = null;
  } catch {
    // Cross-origin
  }
}

// ── Mouse handling ──

function handleMouseMove(e) {
  const label = overlay?.querySelector('.ve-label');

  try {
    const iframeDoc = previewFrame?.contentDocument;
    if (!iframeDoc) throw new Error('no access');

    const rect = previewFrame.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;

    const element = iframeDoc.elementFromPoint(x, y);
    if (!element) return;

    // Remove previous hover
    iframeDoc.querySelectorAll('.ve-hover').forEach(el => el.classList.remove('ve-hover'));

    if (element !== iframeDoc.body && element !== iframeDoc.documentElement) {
      element.classList.add('ve-hover');

      const compAttr = findComponentAttr(element);
      const name = friendlyName(element, compAttr);
      if (label) {
        label.textContent = name;
        label.style.opacity = '1';
        label.style.left = (e.offsetX + 12) + 'px';
        label.style.top = (e.offsetY - 24) + 'px';
      }
    }
  } catch {
    // Cross-origin
    if (label) {
      label.textContent = 'Click to select';
      label.style.opacity = '1';
      label.style.left = (e.offsetX + 12) + 'px';
      label.style.top = (e.offsetY - 24) + 'px';
    }
  }
}

function handleClick(e) {
  const rect = previewFrame.getBoundingClientRect();
  const x = e.clientX - rect.left;
  const y = e.clientY - rect.top;

  let element = null;

  try {
    const iframeDoc = previewFrame.contentDocument;
    element = iframeDoc.elementFromPoint(x, y);
    if (!element || element === iframeDoc.body || element === iframeDoc.documentElement) {
      element = null;
    }
  } catch {
    element = null;
  }

  // Hide instruction pill
  const instruction = overlay?.querySelector('.ve-instruction');
  if (instruction) instruction.style.opacity = '0';

  if (element) {
    // Same-origin — direct DOM access
    selectedElement = element;

    // Clear hover, apply selection
    try {
      const iframeDoc = previewFrame.contentDocument;
      iframeDoc.querySelectorAll('.ve-hover, .ve-selected').forEach(el => el.classList.remove('ve-hover', 've-selected'));
      element.classList.add('ve-selected');
    } catch {}

    const compAttr = findComponentAttr(element);
    const computedStyle = element.ownerDocument.defaultView.getComputedStyle(element);
    let component = null, filePath = null, lineNum = null;
    if (compAttr) {
      [component, filePath, lineNum] = compAttr.split(':');
    }

    const elementData = {
      friendlyName: friendlyName(element, compAttr),
      text: (element.textContent || '').trim().slice(0, 80),
      screenshot: null,
      component: component,
      filePath: filePath,
      lineNum: lineNum,
      selector: buildSelectorPath(element),
      tag: element.tagName.toLowerCase(),
      classes: element.className || '',
      styles: {
        color: computedStyle.color,
        backgroundColor: computedStyle.backgroundColor,
        fontSize: computedStyle.fontSize,
        padding: computedStyle.padding,
      },
      ancestors: buildAncestors(element),
      element: element,
    };

    renderEditPanel(elementData);
  } else {
    // Cross-origin — use server inspection
    showLoadingPanel(x, y);
  }
}

// ── Friendly Names (Task 2) ──

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

function friendlyName(element, componentAttr) {
  // Highest priority: data-component attribute
  if (componentAttr) {
    const name = componentAttr.split(':')[0];
    // Split PascalCase into words
    const words = name.replace(/([a-z])([A-Z])/g, '$1 $2').replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2');
    // Remove generic suffixes
    return words.replace(/\s*(Component|Wrapper|Container|View|Page)$/i, '').trim() || name;
  }

  // If element is a string (from server data), try tag-based
  if (typeof element === 'string') {
    return TAG_NAMES[element.toLowerCase()] || element.charAt(0).toUpperCase() + element.slice(1);
  }

  // MUI class-based mapping (higher priority)
  if (element?.classList) {
    const classes = element.className || '';
    for (const [muiClass, name] of Object.entries(MUI_NAMES)) {
      if (classes.includes(muiClass)) {
        // Special handling for MuiTypography — infer from variant
        if (muiClass === 'MuiTypography') {
          if (classes.includes('h1') || classes.includes('h2') || classes.includes('h3')) return 'Heading';
          if (classes.includes('body')) return 'Paragraph';
          if (classes.includes('caption')) return 'Caption';
          if (classes.includes('subtitle')) return 'Subtitle';
        }
        return name;
      }
    }
  }

  // Tag-based fallback
  const tag = element?.tagName?.toLowerCase() || '';
  return TAG_NAMES[tag] || (tag ? tag.charAt(0).toUpperCase() + tag.slice(1) : 'Element');
}

// Also export for server-response data (tag string, classes string, component string)
function friendlyNameFromData(tag, classes, component) {
  if (component) return friendlyName(null, component);
  if (classes) {
    for (const [muiClass, name] of Object.entries(MUI_NAMES)) {
      if (classes.includes(muiClass)) return name;
    }
  }
  return TAG_NAMES[tag] || (tag ? tag.charAt(0).toUpperCase() + tag.slice(1) : 'Element');
}

// ── Component detection ──

function findComponentAttr(element) {
  let el = element;
  while (el && el !== el.ownerDocument?.body) {
    if (el.dataset?.component) return el.dataset.component;
    el = el.parentElement;
  }
  return null;
}

// ── Breadcrumb (Task 3) ──

function buildAncestors(element) {
  const ancestors = [];
  let el = element.parentElement;
  while (el && el !== el.ownerDocument?.body && ancestors.length < 4) {
    // Skip generic wrappers (css-*, jss-*, MuiBox, MuiGrid with single child)
    const cls = el.className || '';
    const isGenericWrapper = /^(css-|jss-)/.test(cls) ||
      (/MuiBox/.test(cls) && el.children.length === 1) ||
      (/MuiGrid/.test(cls) && el.children.length === 1);

    if (!isGenericWrapper) {
      const compAttr = findComponentAttr(el) !== findComponentAttr(element) ? findComponentAttr(el) : null;
      ancestors.push({
        element: el,
        name: friendlyName(el, compAttr),
      });
    }
    el = el.parentElement;
  }
  return ancestors.reverse(); // root → leaf order
}

function renderBreadcrumb(elementData, onSelect) {
  const bc = document.createElement('div');
  bc.className = 've-breadcrumb';

  // Add "Page" root
  const items = [{ name: 'Page', element: null }, ...elementData.ancestors, { name: elementData.friendlyName, element: elementData.element }];

  items.forEach((item, i) => {
    if (i > 0) {
      const sep = document.createElement('span');
      sep.className = 've-breadcrumb-sep';
      sep.textContent = '›';
      bc.appendChild(sep);
    }
    const span = document.createElement('span');
    span.className = 've-breadcrumb-item' + (i === items.length - 1 ? ' active' : '');
    span.textContent = item.name;
    if (i < items.length - 1 && item.element) {
      span.onclick = () => {
        // Shift selection to this ancestor
        selectedElement = item.element;
        try {
          const iframeDoc = previewFrame.contentDocument;
          iframeDoc.querySelectorAll('.ve-selected').forEach(el => el.classList.remove('ve-selected'));
          item.element.classList.add('ve-selected');
        } catch {}

        const compAttr = findComponentAttr(item.element);
        const computedStyle = item.element.ownerDocument.defaultView.getComputedStyle(item.element);
        let component = null, filePath = null, lineNum = null;
        if (compAttr) [component, filePath, lineNum] = compAttr.split(':');

        const newData = {
          friendlyName: friendlyName(item.element, compAttr),
          text: (item.element.textContent || '').trim().slice(0, 80),
          screenshot: null,
          component, filePath, lineNum,
          selector: buildSelectorPath(item.element),
          tag: item.element.tagName.toLowerCase(),
          classes: item.element.className || '',
          styles: {
            color: computedStyle.color,
            backgroundColor: computedStyle.backgroundColor,
            fontSize: computedStyle.fontSize,
            padding: computedStyle.padding,
          },
          ancestors: buildAncestors(item.element),
          element: item.element,
        };
        onSelect(newData);
      };
    }
    bc.appendChild(span);
  });

  return bc;
}

// ── Chip system (Task 4) ──

function getChipsForElement(elementData) {
  const tag = elementData.tag;
  const classes = elementData.classes || '';
  const name = elementData.friendlyName;

  // Detect element category
  const isText = /^h[1-6]$/.test(tag) || tag === 'p' || tag === 'span' || classes.includes('MuiTypography');
  const isButton = tag === 'button' || (tag === 'a' && classes.includes('btn')) || classes.includes('MuiButton') || classes.includes('MuiIconButton');
  const isImage = tag === 'img' || classes.includes('MuiAvatar') || (tag === 'svg' && name === 'Icon');
  const isCard = classes.includes('MuiCard') || classes.includes('MuiPaper') || classes.includes('card');
  const isInput = tag === 'input' || tag === 'textarea' || classes.includes('MuiTextField') || classes.includes('MuiSelect');
  const isTable = tag === 'table' || classes.includes('MuiTable') || classes.includes('MuiDataGrid');
  const isNav = tag === 'nav' || classes.includes('MuiAppBar') || classes.includes('MuiDrawer') || classes.includes('MuiTabs');
  const isList = tag === 'ul' || tag === 'ol' || classes.includes('MuiList');

  let chips = [];

  if (isButton) {
    chips = [
      { icon: '✏️', label: 'Change label', type: 'text' },
      { icon: '🎨', label: 'Change color', type: 'color' },
      { icon: '⭕', label: 'Make rounded', type: 'toggle' },
      { icon: '▢', label: 'Make outlined', type: 'toggle' },
      { icon: '↑', label: 'Make larger', type: 'toggle' },
      { icon: '↓', label: 'Make smaller', type: 'toggle' },
    ];
  } else if (isText) {
    chips = [
      { icon: '✏️', label: 'Change text', type: 'text' },
      { icon: '🎨', label: 'Change color', type: 'color' },
      { icon: '↑', label: 'Make larger', type: 'toggle' },
      { icon: '↓', label: 'Make smaller', type: 'toggle' },
      { icon: 'B', label: 'Make bold', type: 'toggle' },
      { icon: '≡', label: 'Align center', type: 'toggle' },
    ];
  } else if (isImage) {
    chips = [
      { icon: '↑', label: 'Make larger', type: 'toggle' },
      { icon: '↓', label: 'Make smaller', type: 'toggle' },
      { icon: '⭕', label: 'Make rounded', type: 'toggle' },
      { icon: '🖼️', label: 'Add border', type: 'toggle' },
      { icon: '💫', label: 'Add shadow', type: 'toggle' },
    ];
  } else if (isCard) {
    chips = [
      { icon: '🎨', label: 'Change background', type: 'color' },
      { icon: '💫', label: 'Add shadow', type: 'toggle' },
      { icon: '⭕', label: 'Round corners', type: 'toggle' },
      { icon: '↕️', label: 'More padding', type: 'toggle' },
      { icon: '↕️', label: 'Less padding', type: 'toggle' },
      { icon: '🖼️', label: 'Add border', type: 'toggle' },
    ];
  } else if (isInput) {
    chips = [
      { icon: '✏️', label: 'Change placeholder', type: 'text' },
      { icon: '↑', label: 'Make larger', type: 'toggle' },
      { icon: '⭕', label: 'Round corners', type: 'toggle' },
      { icon: '🎨', label: 'Change border color', type: 'color' },
    ];
  } else if (isTable) {
    chips = [
      { icon: '🎨', label: 'Stripe rows', type: 'toggle' },
      { icon: '🖼️', label: 'Add borders', type: 'toggle' },
      { icon: '↑', label: 'Make header bold', type: 'toggle' },
      { icon: '↕️', label: 'More row spacing', type: 'toggle' },
    ];
  } else if (isNav) {
    chips = [
      { icon: '🎨', label: 'Change background', type: 'color' },
      { icon: '✏️', label: 'Change color', type: 'color' },
      { icon: '💫', label: 'Add shadow', type: 'toggle' },
    ];
  } else if (isList) {
    chips = [
      { icon: '↕️', label: 'More spacing', type: 'toggle' },
      { icon: '↕️', label: 'Less spacing', type: 'toggle' },
      { icon: '🖼️', label: 'Add dividers', type: 'toggle' },
      { icon: '🎨', label: 'Alternate colors', type: 'toggle' },
    ];
  } else {
    // Container / generic
    chips = [
      { icon: '🎨', label: 'Change background', type: 'color' },
      { icon: '↕️', label: 'More padding', type: 'toggle' },
      { icon: '↕️', label: 'Less padding', type: 'toggle' },
      { icon: '💫', label: 'Add shadow', type: 'toggle' },
      { icon: '🖼️', label: 'Add border', type: 'toggle' },
      { icon: '⭕', label: 'Round corners', type: 'toggle' },
    ];
  }

  // Universal chip
  chips.push({ icon: '👁️', label: 'Hide element', type: 'toggle' });
  return chips;
}

const COLOR_PRESETS = ['#ef4444', '#f59e0b', '#22c55e', '#3b82f6', '#8b5cf6', '#ec4899', '#ffffff', '#000000'];

function renderChips(chips, container, onUpdate) {
  const state = { selected: new Map(), customText: '' };
  const chipsDiv = document.createElement('div');
  chipsDiv.className = 've-chips';

  const expandArea = document.createElement('div');
  expandArea.className = 've-chip-expand-area';

  chips.forEach(chip => {
    const el = document.createElement('span');
    el.className = 've-chip';
    el.innerHTML = `<span>${chip.icon}</span> ${chip.label}`;
    el.onclick = () => {
      if (chip.type === 'toggle') {
        const isSelected = el.classList.toggle('selected');
        if (isSelected) state.selected.set(chip.label, true);
        else state.selected.delete(chip.label);
        onUpdate(state);
      } else if (chip.type === 'text') {
        expandArea.innerHTML = '';
        const input = document.createElement('input');
        input.type = 'text';
        input.className = 've-chip-input';
        input.placeholder = `New ${chip.label.replace('Change ', '').toLowerCase()}...`;
        input.oninput = () => {
          if (input.value.trim()) state.selected.set(chip.label, input.value.trim());
          else state.selected.delete(chip.label);
          onUpdate(state);
        };
        const wrapper = document.createElement('div');
        wrapper.className = 've-chip-expand';
        wrapper.appendChild(input);
        expandArea.appendChild(wrapper);
        el.classList.add('selected');
        setTimeout(() => input.focus(), 50);
      } else if (chip.type === 'color') {
        expandArea.innerHTML = '';
        const wrapper = document.createElement('div');
        wrapper.className = 've-chip-expand';
        const grid = document.createElement('div');
        grid.className = 've-color-grid';
        COLOR_PRESETS.forEach(color => {
          const swatch = document.createElement('div');
          swatch.className = 've-color-swatch';
          swatch.style.background = color;
          swatch.style.border = color === '#ffffff' ? '2px solid var(--border)' : '2px solid transparent';
          swatch.onclick = (ev) => {
            ev.stopPropagation();
            grid.querySelectorAll('.ve-color-swatch').forEach(s => s.classList.remove('selected'));
            swatch.classList.add('selected');
            state.selected.set(chip.label, color);
            el.classList.add('selected');
            onUpdate(state);
          };
          grid.appendChild(swatch);
        });
        const hexInput = document.createElement('input');
        hexInput.type = 'text';
        hexInput.className = 've-chip-input';
        hexInput.placeholder = '#hex';
        hexInput.style.width = '80px';
        hexInput.oninput = () => {
          if (hexInput.value.trim()) {
            state.selected.set(chip.label, hexInput.value.trim());
            el.classList.add('selected');
          } else {
            state.selected.delete(chip.label);
            el.classList.remove('selected');
          }
          onUpdate(state);
        };
        wrapper.appendChild(grid);
        wrapper.appendChild(hexInput);
        expandArea.appendChild(wrapper);
      }
    };
    chipsDiv.appendChild(el);
  });

  // Custom text toggle
  const customToggle = document.createElement('div');
  customToggle.className = 've-custom-toggle';
  customToggle.textContent = '+ Describe something else...';
  let customExpanded = false;
  customToggle.onclick = () => {
    if (customExpanded) return;
    customExpanded = true;
    customToggle.style.display = 'none';
    const input = document.createElement('input');
    input.type = 'text';
    input.className = 've-chip-input';
    input.placeholder = 'Describe what you want to change...';
    input.style.width = '100%';
    input.oninput = () => {
      state.customText = input.value.trim();
      onUpdate(state);
    };
    const wrapper = document.createElement('div');
    wrapper.className = 've-chip-expand';
    wrapper.appendChild(input);
    expandArea.appendChild(wrapper);
    setTimeout(() => input.focus(), 50);
  };

  container.appendChild(chipsDiv);
  container.appendChild(expandArea);
  container.appendChild(customToggle);

  return state;
}

// ── Unified Edit Panel (Task 5) ──

function renderEditPanel(elementData) {
  if (editPanel) editPanel.remove();

  const rightPanel = document.querySelector('.right-panel');
  if (!rightPanel) return;

  editPanel = document.createElement('div');
  editPanel.className = 'edit-panel';

  // Header
  const header = document.createElement('div');
  header.className = 've-header';
  header.innerHTML = `
    <span class="ve-title">${elementData.friendlyName}</span>
    <button class="ve-close">&times;</button>
  `;
  header.querySelector('.ve-close').onclick = () => { editPanel.remove(); editPanel = null; };
  editPanel.appendChild(header);

  // Breadcrumb
  if (elementData.ancestors && elementData.ancestors.length > 0) {
    const bc = renderBreadcrumb(elementData, (newData) => {
      renderEditPanel(newData);
    });
    editPanel.appendChild(bc);
  }

  // Element info
  const info = document.createElement('div');
  info.className = 've-info';
  let infoHtml = '';
  if (elementData.screenshot) {
    infoHtml += `<img src="data:image/png;base64,${elementData.screenshot}" class="ve-screenshot">`;
  }
  if (elementData.text) {
    const truncated = elementData.text.length > 80 ? elementData.text.slice(0, 77) + '...' : elementData.text;
    infoHtml += `<div class="ve-text-preview">"${escapeHtml(truncated)}"</div>`;
  }
  if (infoHtml) {
    info.innerHTML = infoHtml;
    editPanel.appendChild(info);
  }

  // Chips
  const chipsContainer = document.createElement('div');
  chipsContainer.className = 've-chips-section';
  const chips = getChipsForElement(elementData);
  let chipState = null;

  // Action bar
  const actions = document.createElement('div');
  actions.className = 've-actions';
  const cancelBtn = document.createElement('button');
  cancelBtn.className = 've-cancel';
  cancelBtn.textContent = 'Cancel';
  cancelBtn.onclick = () => { editPanel.remove(); editPanel = null; };

  const sendBtn = document.createElement('button');
  sendBtn.className = 've-send';
  sendBtn.textContent = 'Send to Agent ✨';
  sendBtn.disabled = true;

  const updateSendBtn = (state) => {
    const count = state.selected.size + (state.customText ? 1 : 0);
    sendBtn.disabled = count === 0;
    sendBtn.textContent = count > 0 ? `Send ${count} change${count > 1 ? 's' : ''} ✨` : 'Send to Agent ✨';
  };

  chipState = renderChips(chips, chipsContainer, updateSendBtn);
  editPanel.appendChild(chipsContainer);

  sendBtn.onclick = () => {
    if (!onSendPrompt) return;
    const prompt = buildPrompt(elementData, chipState.selected, chipState.customText);
    const actionSummary = [...chipState.selected.entries()].map(([k, v]) => v === true ? k : `${k} → ${v}`).join(', ');

    // Store pending change selector for confirmation pulse
    pendingChangeSelector = elementData.selector;

    // Add to history
    editHistory.push({
      id: crypto.randomUUID(),
      timestamp: Date.now(),
      friendlyName: elementData.friendlyName,
      action: actionSummary || chipState.customText || 'Custom change',
      prompt: prompt,
      selector: elementData.selector,
      undone: false,
    });
    updateHistoryBadge();

    onSendPrompt(prompt);
    deactivate();
  };

  actions.appendChild(cancelBtn);
  actions.appendChild(sendBtn);
  editPanel.appendChild(actions);

  rightPanel.appendChild(editPanel);
}

// ── Cross-origin loading panel ──

async function showLoadingPanel(clickX, clickY) {
  if (editPanel) editPanel.remove();

  const rightPanel = document.querySelector('.right-panel');
  if (!rightPanel) return;

  editPanel = document.createElement('div');
  editPanel.className = 'edit-panel';
  editPanel.innerHTML = `
    <div class="ve-header">
      <span class="ve-title">Identifying element...</span>
      <button class="ve-close">&times;</button>
    </div>
    <div class="ve-loading">
      <div class="activity-spinner" style="margin:0 auto 8px"></div>
      Inspecting element...
    </div>
  `;
  editPanel.querySelector('.ve-close').onclick = () => { editPanel.remove(); editPanel = null; };
  rightPanel.appendChild(editPanel);

  // Call server
  let elementInfo = null;
  try {
    const iframe = document.getElementById('preview-frame');
    const pctX = clickX / iframe.offsetWidth;
    const pctY = clickY / iframe.offsetHeight;
    const currentUrl = document.getElementById('preview-url')?.value || '/';

    const resp = await fetch('/api/inspect-element', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pctX, pctY, currentUrl }),
    });
    const data = await resp.json();
    if (data.found) elementInfo = data;
  } catch (e) {
    console.error('[visual-edit] inspect failed:', e);
  }

  // Build normalized elementData from server response
  const el = elementInfo?.element || {};
  const component = el.component?.split(':')[0] || null;
  const filePath = el.component?.split(':')[1] || null;
  const lineNum = el.component?.split(':')[2] || null;

  const elementData = {
    friendlyName: friendlyNameFromData(el.tag, el.classes, el.component),
    text: el.text || '',
    screenshot: elementInfo?.screenshot || null,
    component: component,
    filePath: filePath,
    lineNum: lineNum,
    selector: el.selector || '',
    tag: el.tag || 'div',
    classes: el.classes || '',
    styles: el.currentStyles || {},
    ancestors: [], // Can't build from server data
    element: null,
  };

  renderEditPanel(elementData);
}

// ── Prompt Builder (Task 7) ──

function buildPrompt(elementData, selectedChips, customText) {
  let lines = [];
  lines.push('VISUAL EDIT REQUEST');
  lines.push('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  lines.push('');

  const textPreview = elementData.text ? ` — "${elementData.text.slice(0, 60)}"` : '';
  lines.push(`Target: ${elementData.friendlyName}${textPreview}`);

  if (elementData.filePath) {
    lines.push(`File: ${elementData.filePath}${elementData.lineNum ? ':' + elementData.lineNum : ''}`);
  }
  if (elementData.component) lines.push(`Component: ${elementData.component}`);
  if (elementData.selector) lines.push(`Selector: ${elementData.selector}`);
  if (elementData.classes) lines.push(`Classes: ${elementData.classes}`);

  if (elementData.styles && Object.values(elementData.styles).some(v => v)) {
    lines.push('');
    lines.push('Current styles:');
    const s = elementData.styles;
    const parts = [];
    if (s.color) parts.push(`color: ${s.color}`);
    if (s.backgroundColor) parts.push(`background: ${s.backgroundColor}`);
    if (s.fontSize) parts.push(`font-size: ${s.fontSize}`);
    if (s.padding) parts.push(`padding: ${s.padding}`);
    lines.push('  ' + parts.join('  |  '));
  }

  lines.push('');
  lines.push('Requested changes:');

  for (const [action, value] of selectedChips) {
    if (value === true) {
      lines.push(`  • ${action}`);
    } else {
      lines.push(`  • ${action} → new value: ${value}`);
    }
  }

  if (customText) {
    lines.push(`  • Custom: ${customText}`);
  }

  lines.push('');
  const file = elementData.filePath || 'the component file';
  lines.push(`IMPORTANT: Only modify the targeted element described above. Do NOT change global theme, MUI theme, layout wrappers, or App-level styles. Apply changes via the component's own styles (sx prop, className, or styled-components) scoped to this specific element in ${file}.`);

  return lines.join('\n');
}

// ── Helpers ──

function buildSelectorPath(element) {
  const parts = [];
  let el = element;
  for (let i = 0; i < 3 && el && el !== el.ownerDocument?.body; i++) {
    let selector = el.tagName.toLowerCase();
    if (el.id) selector += '#' + el.id;
    else if (el.classList?.length > 0) {
      const meaningful = [...el.classList].filter(c => !c.startsWith('css-') && !c.startsWith('jss-')).slice(0, 2);
      if (meaningful.length > 0) selector += '.' + meaningful.join('.');
    }
    parts.unshift(selector);
    el = el.parentElement;
  }
  return parts.join(' > ');
}

function escapeHtml(text) {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function rgbToHex(rgb) {
  if (!rgb || rgb === 'transparent' || rgb === 'rgba(0, 0, 0, 0)') return '#ffffff';
  const match = rgb.match(/\d+/g);
  if (!match || match.length < 3) return '#ffffff';
  return '#' + match.slice(0, 3).map(x => parseInt(x).toString(16).padStart(2, '0')).join('');
}

function relativeTime(ts) {
  const diff = Date.now() - ts;
  if (diff < 60000) return 'just now';
  if (diff < 3600000) return Math.floor(diff / 60000) + 'm ago';
  if (diff < 86400000) return Math.floor(diff / 3600000) + 'h ago';
  return Math.floor(diff / 86400000) + 'd ago';
}

function updateHistoryBadge() {
  const btn = document.getElementById('ve-history-btn');
  if (!btn) return;
  const activeCount = editHistory.filter(e => !e.undone).length;
  btn.style.display = editHistory.length > 0 ? '' : 'none';
  let badge = btn.querySelector('.ve-history-badge');
  if (editHistory.length > 0) {
    if (!badge) {
      badge = document.createElement('span');
      badge.className = 've-history-badge';
      btn.appendChild(badge);
    }
    badge.textContent = editHistory.length;
  } else if (badge) {
    badge.remove();
  }
}
