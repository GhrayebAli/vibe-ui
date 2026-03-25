/**
 * Visual Edit Bridge — runs INSIDE the frontend iframe
 * Injected by the preview proxy in server-washmen.js
 *
 * Listens for commands from the parent (vibe-ui) via postMessage
 * and sends element metadata back.
 *
 * Protocol:
 *   Parent -> Bridge: VE_ENABLE, VE_DISABLE, VE_PING, VE_HOVER, VE_CLICK, VE_HIGHLIGHT_CHANGE
 *   Bridge -> Parent: VE_BRIDGE_READY, VE_PONG, VE_ELEMENT_HOVERED, VE_ELEMENT_SELECTED, VE_VIEWPORT_CHANGED
 */
(function () {
  'use strict';

  // Prevent double-init
  if (window.__VE_BRIDGE_INIT) return;
  window.__VE_BRIDGE_INIT = true;

  let selectionMode = false;
  let lastHighlightEl = null;
  let changeHighlightEl = null;

  // --- React fiber walking ---
  function getReactFiber(el) {
    const key = Object.keys(el).find(function (k) { return k.startsWith('__reactFiber$'); });
    if (!key) return null;
    var fiber = el[key];
    while (fiber) {
      if (typeof fiber.type === 'function' || typeof fiber.type === 'object') return fiber;
      fiber = fiber['return'];
    }
    return null;
  }

  function getFiberDebugSource(fiber) {
    if (!fiber) return null;
    // Walk up looking for _debugSource
    var f = fiber;
    var depth = 0;
    while (f && depth < 20) {
      if (f._debugSource) {
        return {
          fileName: f._debugSource.fileName || '',
          lineNumber: f._debugSource.lineNumber || 0,
          componentName: getComponentName(f)
        };
      }
      f = f['return'];
      depth++;
    }
    return { fileName: '', lineNumber: 0, componentName: getComponentName(fiber) };
  }

  function getComponentName(fiber) {
    if (!fiber || !fiber.type) return '';
    if (typeof fiber.type === 'string') return '';
    return fiber.type.displayName || fiber.type.name || '';
  }

  function getAncestorChain(fiber, maxDepth) {
    var ancestors = [];
    if (!fiber) return ancestors;
    var f = fiber['return'];
    var depth = 0;
    while (f && depth < (maxDepth || 5)) {
      if (typeof f.type === 'function' || typeof f.type === 'object') {
        var name = getComponentName(f);
        if (name) {
          var src = f._debugSource;
          ancestors.push({
            componentName: name,
            tagName: typeof f.type === 'string' ? f.type : 'div',
            className: '',
            filePath: src ? src.fileName : '',
            lineNumber: src ? src.lineNumber : 0
          });
        }
      }
      f = f['return'];
      depth++;
    }
    return ancestors;
  }

  // --- Computed styles extraction ---
  function getKeyStyles(el) {
    try {
      var cs = window.getComputedStyle(el);
      return {
        color: cs.color,
        backgroundColor: cs.backgroundColor,
        fontSize: cs.fontSize,
        fontWeight: cs.fontWeight,
        padding: cs.padding,
        margin: cs.margin,
        borderRadius: cs.borderRadius,
        display: cs.display
      };
    } catch (e) {
      return {};
    }
  }

  // --- Build CSS selector ---
  function buildSelector(el) {
    var parts = [];
    var n = el;
    for (var i = 0; i < 3 && n && n !== document.body; i++) {
      var part = n.tagName.toLowerCase();
      if (n.id) part += '#' + n.id;
      else if (n.className && typeof n.className === 'string') {
        var cls = n.className.trim().split(/\s+/).slice(0, 2).join('.');
        if (cls) part += '.' + cls;
      }
      parts.unshift(part);
      n = n.parentElement;
    }
    return parts.join(' > ');
  }

  // --- Highlight management ---
  function clearHighlight() {
    if (lastHighlightEl) {
      lastHighlightEl.style.outline = lastHighlightEl.__ve_orig_outline || '';
      lastHighlightEl.style.outlineOffset = lastHighlightEl.__ve_orig_outlineOffset || '';
      lastHighlightEl = null;
    }
  }

  function highlightElement(el) {
    clearHighlight();
    if (!el) return;
    el.__ve_orig_outline = el.style.outline;
    el.__ve_orig_outlineOffset = el.style.outlineOffset;
    el.style.outline = '2px solid #3b82f6';
    el.style.outlineOffset = '-2px';
    lastHighlightEl = el;
  }

  // --- Element metadata extraction ---
  function getElementMeta(el) {
    if (!el || el === document.body || el === document.documentElement) return null;
    var rect = el.getBoundingClientRect();
    var fiber = getReactFiber(el);
    var debugInfo = getFiberDebugSource(fiber);
    var styles = getKeyStyles(el);

    return {
      rect: { left: rect.left, top: rect.top, width: rect.width, height: rect.height },
      tagName: el.tagName.toLowerCase(),
      className: typeof el.className === 'string' ? el.className : '',
      id: el.id || '',
      role: el.getAttribute('role') || '',
      componentName: debugInfo ? debugInfo.componentName : '',
      filePath: debugInfo ? debugInfo.fileName : '',
      lineNumber: debugInfo ? debugInfo.lineNumber : 0,
      styles: styles,
      selector: buildSelector(el)
    };
  }

  // --- Hover handler (coordinates from parent) ---
  function handleHover(payload) {
    if (!selectionMode) return;
    var el = document.elementFromPoint(payload.x, payload.y);
    if (!el || el === document.body || el === document.documentElement) {
      clearHighlight();
      return;
    }
    highlightElement(el);
    var meta = getElementMeta(el);
    if (meta) {
      window.parent.postMessage({ type: 'VE_ELEMENT_HOVERED', payload: meta }, '*');
    }
  }

  // --- Click handler (coordinates from parent) ---
  function handleClick(payload) {
    if (!selectionMode) return;
    var el = document.elementFromPoint(payload.x, payload.y);
    if (!el || el === document.body || el === document.documentElement) return;

    var meta = getElementMeta(el);
    if (!meta) return;

    // Add extra info for selection
    meta.text = (el.textContent || '').trim().slice(0, 100);
    var fiber = getReactFiber(el);
    meta.ancestors = getAncestorChain(fiber, 5);

    window.parent.postMessage({ type: 'VE_ELEMENT_SELECTED', payload: meta }, '*');
  }

  // --- Change highlight ---
  function handleHighlightChange(payload) {
    if (changeHighlightEl) {
      changeHighlightEl.style.outline = changeHighlightEl.__ve_change_outline || '';
      changeHighlightEl = null;
    }
    if (!payload || !payload.selector) return;
    try {
      var el = document.querySelector(payload.selector);
      if (el) {
        changeHighlightEl = el;
        el.__ve_change_outline = el.style.outline;
        el.style.outline = '3px solid #22c55e';
        setTimeout(function () {
          if (changeHighlightEl === el) {
            el.style.outline = el.__ve_change_outline || '';
            changeHighlightEl = null;
          }
        }, 3000);
      }
    } catch (e) {}
  }

  // --- Viewport change reporting ---
  var vpDebounce = null;
  function reportViewport() {
    clearTimeout(vpDebounce);
    vpDebounce = setTimeout(function () {
      window.parent.postMessage({
        type: 'VE_VIEWPORT_CHANGED',
        payload: {
          scrollX: window.scrollX,
          scrollY: window.scrollY,
          width: window.innerWidth,
          height: window.innerHeight
        }
      }, '*');
    }, 100);
  }
  window.addEventListener('scroll', reportViewport, { passive: true });
  window.addEventListener('resize', reportViewport, { passive: true });

  // --- Message listener ---
  window.addEventListener('message', function (e) {
    var msg = e.data;
    if (!msg || typeof msg.type !== 'string') return;

    switch (msg.type) {
      case 'VE_ENABLE':
        selectionMode = true;
        break;
      case 'VE_DISABLE':
        selectionMode = false;
        clearHighlight();
        break;
      case 'VE_PING':
        window.parent.postMessage({ type: 'VE_PONG' }, '*');
        break;
      case 'VE_HOVER':
        handleHover(msg.payload);
        break;
      case 'VE_CLICK':
        handleClick(msg.payload);
        break;
      case 'VE_HIGHLIGHT_CHANGE':
        handleHighlightChange(msg.payload);
        break;
    }
  });

  // --- Announce readiness ---
  function announceReady() {
    window.parent.postMessage({ type: 'VE_BRIDGE_READY' }, '*');
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', announceReady);
  } else {
    announceReady();
  }

  // Re-announce periodically in case parent loads after bridge
  var readyInterval = setInterval(function () {
    window.parent.postMessage({ type: 'VE_BRIDGE_READY' }, '*');
  }, 2000);
  // Stop after 30 seconds
  setTimeout(function () { clearInterval(readyInterval); }, 30000);

  console.log('[visual-bridge] Bridge script loaded and ready');
})();
