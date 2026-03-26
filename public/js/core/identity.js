/**
 * Identity Manager — Multi-User Awareness (Phase 1)
 * Prompts user for name + role before connecting to WebSocket.
 * Stores identity in localStorage for pre-fill on return visits.
 */

const STORAGE_KEY = 'washvibe_identity';

let _identity = null; // { name, role }

/** Load saved identity from localStorage */
function loadIdentity() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (parsed.name && parsed.role) {
        _identity = parsed;
        return _identity;
      }
    }
  } catch {}
  return null;
}

/** Save identity to localStorage */
function saveIdentity(name, role) {
  _identity = { name: name.trim(), role };
  localStorage.setItem(STORAGE_KEY, JSON.stringify(_identity));
}

/** Get current identity (or null if not set) */
export function getIdentity() {
  if (_identity) return _identity;
  return loadIdentity();
}

/**
 * Show the identity modal and resolve when the user submits.
 * If identity already exists in localStorage, resolves immediately.
 * Returns { name, role }.
 */
export function requireIdentity() {
  return new Promise((resolve) => {
    const existing = getIdentity();
    if (existing) {
      resolve(existing);
      return;
    }

    const modal = document.getElementById('identity-modal');
    const nameInput = document.getElementById('identity-name');
    const roleSelect = document.getElementById('identity-role');
    const submitBtn = document.getElementById('identity-submit');
    const errorEl = document.getElementById('identity-error');

    // Pre-fill from localStorage if partial
    const saved = loadIdentity();
    if (saved?.name) nameInput.value = saved.name;
    if (saved?.role) roleSelect.value = saved.role;

    modal.style.display = 'flex';

    function submit() {
      const name = nameInput.value.trim();
      const role = roleSelect.value;

      if (!name) {
        errorEl.textContent = 'Please enter your name';
        errorEl.style.display = 'block';
        nameInput.focus();
        return;
      }

      if (name.length < 2) {
        errorEl.textContent = 'Name must be at least 2 characters';
        errorEl.style.display = 'block';
        nameInput.focus();
        return;
      }

      errorEl.style.display = 'none';
      saveIdentity(name, role);
      modal.style.display = 'none';
      resolve({ name, role });
    }

    submitBtn.onclick = submit;
    nameInput.onkeydown = (e) => {
      if (e.key === 'Enter') submit();
    };

    // Focus the name input
    setTimeout(() => nameInput.focus(), 100);
  });
}

export default { requireIdentity, getIdentity };
