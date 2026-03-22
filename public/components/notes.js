let editorEl = null;
let wsRef = null;

export function initNotes(editor, genBtn, saveBtn, copyBtn, ws) {
  editorEl = editor;
  wsRef = ws;

  // Load existing notes
  loadNotes();

  genBtn.onclick = () => {
    genBtn.disabled = true;
    genBtn.textContent = 'Generating...';
    // Send generate command via ws or fetch
    if (wsRef?.readyState === 1) {
      wsRef.send(JSON.stringify({ type: 'generate_mvp_notes' }));
    }
    // Poll for the file to appear
    const poll = setInterval(async () => {
      const loaded = await loadNotes();
      if (loaded) {
        clearInterval(poll);
        genBtn.disabled = false;
        genBtn.textContent = 'Generate';
      }
    }, 3000);
    // Timeout after 60s
    setTimeout(() => { clearInterval(poll); genBtn.disabled = false; genBtn.textContent = 'Generate'; }, 60000);
  };

  saveBtn.onclick = async () => {
    try {
      await fetch('/api/notes', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content: editorEl.value }),
      });
      saveBtn.textContent = 'Saved!';
      setTimeout(() => { saveBtn.textContent = 'Save'; }, 1500);
    } catch {}
  };

  copyBtn.onclick = () => {
    navigator.clipboard.writeText(editorEl.value);
    copyBtn.textContent = 'Copied!';
    setTimeout(() => { copyBtn.textContent = 'Copy'; }, 1500);
  };
}

async function loadNotes() {
  try {
    const resp = await fetch('/api/notes');
    const data = await resp.json();
    if (data.content) {
      editorEl.value = data.content;
      return true;
    }
  } catch {}
  return false;
}
