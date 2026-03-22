let editorEl = null;
let getWs = null;
let notesArea = null;
let spinnerEl = null;

export function initNotes(editor, genBtn, saveBtn, copyBtn, wsGetter) {
  editorEl = editor;
  getWs = wsGetter;
  notesArea = editor.closest('.notes-area');

  // Create spinner element (hidden by default)
  spinnerEl = document.createElement('div');
  spinnerEl.className = 'notes-spinner hidden';
  spinnerEl.innerHTML = '<div class="notes-spin-icon"></div><span>Generating notes...</span>';
  if (notesArea) notesArea.insertBefore(spinnerEl, editor);

  // Load existing notes on init
  loadNotes();

  genBtn.onclick = () => {
    genBtn.disabled = true;
    genBtn.textContent = 'Generating...';
    showSpinner(true);

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
        showSpinner(false);
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
    try { navigator.clipboard.writeText(editorEl.value); } catch { const ta = document.createElement('textarea'); ta.value = editorEl.value; document.body.appendChild(ta); ta.select(); document.execCommand('copy'); document.body.removeChild(ta); }
    copyBtn.textContent = 'Copied!';
    setTimeout(() => { copyBtn.textContent = 'Copy'; }, 1500);
  };
}

// Call this when the notes overlay opens
export function onNotesOpen() {
  loadNotes();
}

function showSpinner(show) {
  if (spinnerEl) spinnerEl.classList.toggle('hidden', !show);
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
