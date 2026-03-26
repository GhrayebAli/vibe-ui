let editorEl = null;
let getWs = null;
let notesArea = null;
let spinnerEl = null;
let genBtnEl = null;
let currentNoteBranch = null;
let saveTimer = null;

function autoSave() {
  if (!editorEl || !currentNoteBranch) return;
  clearTimeout(saveTimer);
  saveTimer = setTimeout(async () => {
    try {
      await fetch('/api/notes', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ branch: currentNoteBranch, content: editorEl.value }),
      });
    } catch {}
  }, 800);
}

export function initNotes(editor, genBtn, saveBtn, copyBtn, wsGetter) {
  editorEl = editor;
  getWs = wsGetter;
  genBtnEl = genBtn;
  notesArea = editor.closest('.notes-area');

  // Hide save button — auto-save on edit
  if (saveBtn) saveBtn.style.display = 'none';

  // Auto-save on every keystroke (debounced)
  editor.oninput = autoSave;

  // Create spinner element (hidden by default)
  spinnerEl = document.createElement('div');
  spinnerEl.className = 'notes-spinner hidden';
  spinnerEl.innerHTML = '<div class="notes-spin-icon"></div><span>Generating notes...</span>';
  if (notesArea) notesArea.insertBefore(spinnerEl, editor);

  genBtn.onclick = () => {
    genBtn.disabled = true;
    genBtn.textContent = 'Generating...';
    showSpinner(true);

    const ws = typeof getWs === 'function' ? getWs() : getWs;
    if (ws?.readyState === 1) {
      ws.send(JSON.stringify({ type: 'generate_mvp_notes', branch: currentNoteBranch }));
    }
  };

  copyBtn.onclick = () => {
    try { navigator.clipboard.writeText(editorEl.value); } catch { const ta = document.createElement('textarea'); ta.value = editorEl.value; document.body.appendChild(ta); ta.select(); document.execCommand('copy'); document.body.removeChild(ta); }
    copyBtn.textContent = 'Copied!';
    setTimeout(() => { copyBtn.textContent = 'Copy'; }, 1500);
  };
}

// Called when notes_generated WebSocket message arrives
export function onNotesGenerated(content) {
  if (editorEl) editorEl.value = content;
  if (genBtnEl) {
    genBtnEl.disabled = false;
    genBtnEl.textContent = 'Regenerate';
  }
  showSpinner(false);
  // Auto-save the generated notes
  autoSave();
}

// Call this when the notes overlay opens
export function onNotesOpen(branch) {
  currentNoteBranch = branch || null;
  loadNotes(branch);
}

function showSpinner(show) {
  if (spinnerEl) spinnerEl.classList.toggle('hidden', !show);
}

export async function loadNotes(branch) {
  if (!editorEl) return false;
  const branchParam = branch ? `?branch=${encodeURIComponent(branch)}` : '';
  try {
    const resp = await fetch('/api/notes' + branchParam);
    const data = await resp.json();
    console.debug('[notes] load', branch, 'status:', resp.status, 'content:', !!data.content);
    if (data.content && data.content.trim()) {
      editorEl.value = data.content;
      if (genBtnEl && genBtnEl.textContent === 'Generate') genBtnEl.textContent = 'Regenerate';
      return true;
    }
  } catch (e) { console.warn('[notes] load failed:', e.message); }
  return false;
}
