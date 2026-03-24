let frame = null;
let wrap = null;
let loader = null;
let urlInput = null;
let baseUrl = '';

export function initPreview(url) {
  frame = document.getElementById('preview-frame');
  wrap = document.getElementById('preview-wrap');
  loader = document.getElementById('preview-loading');
  urlInput = document.getElementById('preview-url');

  baseUrl = url;
  urlInput.value = url.replace(/^https?:\/\//, '');

  frame.onload = () => {
    loader.classList.add('hidden');
    // Read the current path from the iframe (same-origin via proxy)
    try {
      urlInput.value = frame.contentWindow.location.pathname || '/';
    } catch {}
  };

  frame.onerror = () => {
    loader.classList.add('hidden');
  };

  // Start loading
  frame.src = url;
}

export function refreshPreview() {
  if (!frame) return;
  loader.classList.remove('hidden');
  frame.src = frame.src;
}

export function setDevice(device) {
  if (!wrap) return;
  wrap.className = 'preview-wrap' + (device !== 'desktop' ? ' ' + device : '');
}

export function navigatePreview(url) {
  if (!frame) return;
  loader.classList.remove('hidden');
  frame.src = url;
  urlInput.value = url.replace(/^https?:\/\//, '');
}
