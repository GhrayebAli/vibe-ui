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
    let loaded = false;
    try {
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
          const base = urlInput.value.split('/')[0];
          urlInput.value = base + path;
        }
      } catch {}
    }
  };

  frame.onerror = () => {};

  // Load directly from the frontend URL — bridge is injected by Vite plugin
  frame.src = url;
}

function clearRetry() {
  if (retryTimer) { clearInterval(retryTimer); retryTimer = null; }
}

export function refreshPreview() {
  if (!frame) return;
  clearRetry();
  loader.classList.remove('hidden');

  let attempts = 0;
  const maxAttempts = 30;
  retryTimer = setInterval(async () => {
    attempts++;
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 2000);
      const resp = await fetch('/api/service-health');
      clearTimeout(timeout);
      const data = await resp.json();
      const allHealthy = data.services && data.services.every(s => s.status === 'healthy');
      if (allHealthy) {
        clearRetry();
        frame.src = frame.src;
        return;
      }
    } catch {}
    if (attempts >= maxAttempts) {
      clearRetry();
      loader.innerHTML = `
        <div class="preview-error">
          <div class="preview-error-icon">!</div>
          <div class="preview-error-title">Services not ready</div>
          <div class="preview-error-desc">Frontend service didn't respond after 30 seconds.</div>
          <button class="preview-retry-btn" onclick="window.__retryPreview?.()">Retry</button>
        </div>
      `;
      window.__retryPreview = () => {
        loader.innerHTML = '<div class="ld"></div><div class="status-lines">Retrying...</div>';
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
