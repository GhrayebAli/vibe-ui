let editorEl = null;
let getWs = null;

export function initNotes(editor, genBtn, saveBtn, copyBtn, wsGetter) {
  editorEl = editor;
  getWs = wsGetter;

  // Load existing notes when overlay opens
  loadNotes();

  genBtn.onclick = () => {
    genBtn.disabled = true;
    genBtn.textContent = 'Generating...';

    // Send generate command via WebSocket
    const ws = typeof getWs === 'function' ? getWs() : getWs;
    if (ws?.readyState === 1) {
      ws.send(JSON.stringify({ type: 'generate_mvp_notes' }));
    }

    // Poll for the file to appear
    let attempts = 0;
    const poll = setInterval(async () => {
      attempts++;
      const loaded = await loadNotes();
      if (loaded || attempts > 20) {
        clearInterval(poll);
        genBtn.disabled = false;
        genBtn.textContent = 'Generate';
      }
    }, 3000);
  };

  saveBtn.onclick = async () => {
    try {
      const resp = await fetch('/api/notes', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content: editorEl.value }),
      });
      if (resp.ok) {
        saveBtn.textContent = 'Saved!';
        saveBtn.style.background = 'var(--green)';
      } else {
        saveBtn.textContent = 'Error';
        saveBtn.style.background = 'var(--red)';
      }
      setTimeout(() => { saveBtn.textContent = 'Save'; saveBtn.style.background = ''; }, 2000);
    } catch {
      saveBtn.textContent = 'Error';
      setTimeout(() => { saveBtn.textContent = 'Save'; }, 2000);
    }
  };

  copyBtn.onclick = () => {
    navigator.clipboard.writeText(editorEl.value);
    copyBtn.textContent = 'Copied!';
    setTimeout(() => { copyBtn.textContent = 'Copy'; }, 1500);
  };
}

export async function loadNotes() {
  if (!editorEl) return false;
  try {
    const resp = await fetch('/api/notes');
    const data = await resp.json();
    if (data.content && data.content.trim()) {
      editorEl.value = data.content;
      return true;
    }
  } catch {}
  return false;
}
