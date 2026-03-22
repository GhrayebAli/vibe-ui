/**
 * Visual Edit Mode
 * Adds a transparent overlay on the preview iframe.
 * Hovering shows blue border on elements.
 * Clicking locks selection and shows edit panel.
 */

let active = false;
let overlay = null;
let editPanel = null;
let selectedElement = null;
let previewFrame = null;
let onSendPrompt = null;

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
  document.getElementById('visual-edit-btn')?.classList.remove('active');
}

function activate() {
  active = true;
  document.getElementById('visual-edit-btn')?.classList.add('active');

  // Create overlay on top of the iframe
  const wrap = document.getElementById('preview-wrap');
  if (!wrap) return;

  overlay = document.createElement('div');
  overlay.className = 'visual-overlay';
  overlay.innerHTML = '<div class="vo-hint">Click an element to edit it</div>';
  wrap.appendChild(overlay);

  // Mouse tracking over the iframe
  // Since we can't directly interact with iframe content cross-origin,
  // we use the overlay to capture mouse events and proxy them
  overlay.addEventListener('mousemove', handleMouseMove);
  overlay.addEventListener('click', handleClick);
}

function handleMouseMove(e) {
  if (!previewFrame?.contentDocument) return;

  // Get element under cursor in the iframe
  const rect = previewFrame.getBoundingClientRect();
  const x = e.clientX - rect.left;
  const y = e.clientY - rect.top;

  try {
    const iframeDoc = previewFrame.contentDocument;
    const element = iframeDoc.elementFromPoint(x, y);
    if (!element) return;

    // Remove previous highlights
    iframeDoc.querySelectorAll('[data-ve-highlight]').forEach(el => {
      el.style.outline = el.dataset.veOrigOutline || '';
      delete el.dataset.veHighlight;
      delete el.dataset.veOrigOutline;
    });

    // Highlight current element
    if (element !== iframeDoc.body && element !== iframeDoc.documentElement) {
      element.dataset.veOrigOutline = element.style.outline;
      element.style.outline = '2px solid #6366f1';
      element.dataset.veHighlight = 'true';

      // Show tooltip with component name
      const compAttr = findComponentAttr(element);
      const hint = overlay.querySelector('.vo-hint');
      if (hint) {
        hint.textContent = compAttr ? compAttr.split(':')[0] : element.tagName.toLowerCase();
        hint.style.left = (e.offsetX + 10) + 'px';
        hint.style.top = (e.offsetY - 20) + 'px';
      }
    }
  } catch {
    // Cross-origin — show hint
    const hint = overlay.querySelector('.vo-hint');
    if (hint) {
      hint.textContent = 'Click to describe what to change';
      hint.style.left = (e.offsetX + 10) + 'px';
      hint.style.top = (e.offsetY - 20) + 'px';
    }
  }
}

function handleClick(e) {
  const rect = previewFrame.getBoundingClientRect();
  const x = e.clientX - rect.left;
  const y = e.clientY - rect.top;

  let element = null;
  let compName = 'Element';
  let filePath = '';
  let lineNum = '';

  try {
    const iframeDoc = previewFrame.contentDocument;
    element = iframeDoc.elementFromPoint(x, y);
    if (!element || element === iframeDoc.body || element === iframeDoc.documentElement) {
      // Fall through to cross-origin panel
      element = null;
    } else {
      // Lock selection
      selectedElement = element;
      element.style.outline = '2px solid #6366f1';
      const compAttr = findComponentAttr(element);
      if (compAttr) {
        [compName, filePath, lineNum] = compAttr.split(':');
      } else {
        compName = element.tagName.toLowerCase();
      }
    }
  } catch {
    // Cross-origin — show simplified panel
    element = null;
  }

  if (!element) {
    // Cross-origin or no element found — show prompt-only edit panel
    showSimpleEditPanel(x, y);
    return;
  }


    // Show edit panel
    showEditPanel(element, compName, filePath, lineNum);
  } catch {
    // Cross-origin
  }
}

function findComponentAttr(element) {
  let el = element;
  while (el && el !== el.ownerDocument?.body) {
    if (el.dataset?.component) return el.dataset.component;
    el = el.parentElement;
  }
  return null;
}

function showEditPanel(element, compName, filePath, lineNum) {
  if (editPanel) editPanel.remove();

  const rightPanel = document.querySelector('.right-panel');
  if (!rightPanel) return;

  const computedStyle = element.ownerDocument.defaultView.getComputedStyle(element);

  editPanel = document.createElement('div');
  editPanel.className = 'edit-panel';
  editPanel.innerHTML = `
    <div class="ep-header">
      <span class="ep-title">${compName || 'Element'}</span>
      <span class="ep-path">${filePath ? filePath + (lineNum ? ':' + lineNum : '') : ''}</span>
      <button class="ep-close">&times;</button>
    </div>
    <div class="ep-fields">
      <div class="ep-field">
        <label>Text</label>
        <input type="text" class="ep-input" id="ep-text" value="${(element.textContent || '').slice(0, 100).replace(/"/g, '&quot;')}">
      </div>
      <div class="ep-row">
        <div class="ep-field">
          <label>BG Color</label>
          <input type="color" class="ep-color" id="ep-bg" value="${rgbToHex(computedStyle.backgroundColor)}">
        </div>
        <div class="ep-field">
          <label>Text Color</label>
          <input type="color" class="ep-color" id="ep-color" value="${rgbToHex(computedStyle.color)}">
        </div>
      </div>
      <div class="ep-row">
        <div class="ep-field"><label>Top</label><input type="number" class="ep-num" id="ep-pt" value="${parseInt(computedStyle.paddingTop) || 0}"></div>
        <div class="ep-field"><label>Right</label><input type="number" class="ep-num" id="ep-pr" value="${parseInt(computedStyle.paddingRight) || 0}"></div>
        <div class="ep-field"><label>Bottom</label><input type="number" class="ep-num" id="ep-pb" value="${parseInt(computedStyle.paddingBottom) || 0}"></div>
        <div class="ep-field"><label>Left</label><input type="number" class="ep-num" id="ep-pl" value="${parseInt(computedStyle.paddingLeft) || 0}"></div>
      </div>
      <div class="ep-field">
        <label>Font Size</label>
        <input type="number" class="ep-num" id="ep-fs" value="${parseInt(computedStyle.fontSize) || 14}" style="width:60px"> px
      </div>
      <div class="ep-field">
        <label>Custom Change</label>
        <input type="text" class="ep-input" id="ep-custom" placeholder="Describe a change to this element...">
      </div>
    </div>
    <div class="ep-actions">
      <button class="ep-save">Save</button>
      <button class="ep-cancel">Cancel</button>
    </div>
  `;

  // Events
  editPanel.querySelector('.ep-close').onclick = () => { editPanel.remove(); editPanel = null; };
  editPanel.querySelector('.ep-cancel').onclick = () => { editPanel.remove(); editPanel = null; };

  editPanel.querySelector('.ep-save').onclick = () => {
    const custom = editPanel.querySelector('#ep-custom').value.trim();

    if (custom && onSendPrompt) {
      // Send scoped prompt to agent
      const context = filePath ? `In ${filePath}${lineNum ? ' around line ' + lineNum : ''}, component ${compName}: ` : `For the ${compName || 'selected'} element: `;
      onSendPrompt(context + custom);
      deactivate();
    } else {
      // Apply simple CSS changes directly
      try {
        element.style.backgroundColor = editPanel.querySelector('#ep-bg').value;
        element.style.color = editPanel.querySelector('#ep-color').value;
        element.style.paddingTop = editPanel.querySelector('#ep-pt').value + 'px';
        element.style.paddingRight = editPanel.querySelector('#ep-pr').value + 'px';
        element.style.paddingBottom = editPanel.querySelector('#ep-pb').value + 'px';
        element.style.paddingLeft = editPanel.querySelector('#ep-pl').value + 'px';
        element.style.fontSize = editPanel.querySelector('#ep-fs').value + 'px';
      } catch {}
    }

    editPanel.remove();
    editPanel = null;
  };

  rightPanel.appendChild(editPanel);
}

function showSimpleEditPanel(clickX, clickY) {
  if (editPanel) editPanel.remove();

  const rightPanel = document.querySelector('.right-panel');
  if (!rightPanel) return;

  editPanel = document.createElement('div');
  editPanel.className = 'edit-panel';
  editPanel.innerHTML = `
    <div class="ep-header">
      <span class="ep-title">Edit Element</span>
      <span class="ep-path">Click position: ${Math.round(clickX)}, ${Math.round(clickY)}</span>
      <button class="ep-close">&times;</button>
    </div>
    <div class="ep-fields">
      <div class="ep-field">
        <label>Describe what to change</label>
        <input type="text" class="ep-input" id="ep-custom" placeholder="e.g. Make the header blue, increase font size of the table...">
      </div>
    </div>
    <div class="ep-actions">
      <button class="ep-save">Send to Agent</button>
      <button class="ep-cancel">Cancel</button>
    </div>
  `;

  editPanel.querySelector('.ep-close').onclick = () => { editPanel.remove(); editPanel = null; };
  editPanel.querySelector('.ep-cancel').onclick = () => { editPanel.remove(); editPanel = null; };
  editPanel.querySelector('.ep-save').onclick = () => {
    const custom = editPanel.querySelector('#ep-custom').value.trim();
    if (custom && onSendPrompt) {
      onSendPrompt('In the frontend app preview: ' + custom);
      deactivate();
    }
    editPanel.remove();
    editPanel = null;
  };

  // Focus the input
  rightPanel.appendChild(editPanel);
  setTimeout(() => editPanel.querySelector('#ep-custom')?.focus(), 100);
}

function rgbToHex(rgb) {
  if (!rgb || rgb === 'transparent' || rgb === 'rgba(0, 0, 0, 0)') return '#ffffff';
  const match = rgb.match(/\d+/g);
  if (!match || match.length < 3) return '#ffffff';
  return '#' + match.slice(0, 3).map(x => parseInt(x).toString(16).padStart(2, '0')).join('');
}
