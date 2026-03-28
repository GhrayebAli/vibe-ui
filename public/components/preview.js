let frame = null;
let wrap = null;
let loader = null;
let urlInput = null;
let baseUrl = '';
let retryTimer = null;

export function initPreview(url) {
  frame = document.getElementById('preview-frame');
  wrap = document.getElementById('preview-wrap');
  loader = document.getElementById('preview-loading');
  urlInput = document.getElementById('preview-url');

  baseUrl = url;
  urlInput.value = url.replace(/^https?:\/\//, '');

  frame.onload = () => {
    // Check if the iframe actually loaded content (not an error page)
    let loaded = false;
    try {
      // If we can read the iframe and it has a body with content, it's loaded
      const doc = frame.contentDocument || frame.contentWindow.document;
      loaded = doc && doc.body && doc.body.innerHTML.length > 0;
    } catch {
      // Cross-origin — assume loaded if onload fired
      loaded = true;
    }

    if (loaded) {
      clearRetry();
      loader.classList.add('hidden');
      try {
        const path = frame.contentWindow.location.pathname;
        if (path && path !== '/') {
          urlInput.value = urlInput.value.split('/')[0] + path;
        }
      } catch {}
    }
  };

  frame.onerror = () => {
    // Don't hide loader on error — retry will handle it
  };

  // Poll until service is healthy, then load
  refreshPreview();
}

function clearRetry() {
  if (retryTimer) { clearInterval(retryTimer); retryTimer = null; }
}

export function refreshPreview() {
  if (!frame) return;
  clearRetry();
  loader.classList.remove('hidden');

  // Poll the actual preview URL directly — this catches both the local
  // service being down AND external dependencies (auth, Codespace proxy)
  let attempts = 0;
  const maxAttempts = 90; // 90s max for cold starts
  retryTimer = setInterval(async () => {
    attempts++;
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 3000);
      const resp = await fetch(baseUrl, { mode: 'no-cors', signal: controller.signal });
      clearTimeout(timeout);
      // no-cors returns opaque response (status 0) on success — that's fine,
      // it means the URL is reachable. A network error would throw.
      clearRetry();
      frame.src = baseUrl;
      loader.classList.add('hidden');
      return;
    } catch {}
    if (attempts >= maxAttempts) {
      clearRetry();
      loader.innerHTML = `
        <div class="preview-error">
          <div class="preview-error-icon">!</div>
          <div class="preview-error-title">Services not ready</div>
          <div class="preview-error-desc">Frontend service didn't respond after ${maxAttempts} seconds.</div>
          <button class="preview-retry-btn" onclick="window.__retryPreview?.()">Retry</button>
        </div>
      `;
      window.__retryPreview = () => {
        loader.innerHTML = '<div class="ld"></div><div class="status-lines">Connecting to preview...</div>';
        refreshPreview();
      };
    }
  }, 1000);
}

export function setDevice(device) {
  if (!wrap) return;
  wrap.className = 'preview-wrap' + (device !== 'desktop' ? ' ' + device : '');
}

export function navigatePreview(url) {
  if (!frame) return;
  clearRetry();
  loader.classList.remove('hidden');
  frame.src = url;
  urlInput.value = url.replace(/^https?:\/\//, '');
}
