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

  // Poll until the frontend service responds, then load the iframe
  // Extract the frontend port from baseUrl to only wait for that service
  let frontendPort = null;
  try { frontendPort = new URL(baseUrl).port || '3000'; } catch { frontendPort = '3000'; }

  let attempts = 0;
  const maxAttempts = 60; // 60s max for cold starts
  retryTimer = setInterval(async () => {
    attempts++;
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 2000);
      const resp = await fetch('/api/service-health');
      clearTimeout(timeout);
      const data = await resp.json();
      // Only wait for the frontend service, not all services
      const frontend = data.services && data.services.find(s => String(s.port) === String(frontendPort));
      const ready = frontend ? frontend.status === 'healthy' : data.services && data.services.every(s => s.status === 'healthy');
      if (ready) {
        clearRetry();
        frame.src = baseUrl;
        loader.classList.add('hidden');
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
