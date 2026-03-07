// File & image attachments
import { $ } from './dom.js';
import { getState, setState } from './store.js';
import * as api from './api.js';
import { registerCommand } from './commands.js';

const SUPPORTED_IMAGE_TYPES = ["image/png", "image/jpeg", "image/gif", "image/webp"];
const MAX_IMAGE_SIZE = 5 * 1024 * 1024; // 5MB

// ── Badge ────────────────────────────────────────────────
export function updateAttachmentBadge() {
  const attachedFiles = getState("attachedFiles");
  const imageAttachments = getState("imageAttachments");
  const total = attachedFiles.length + imageAttachments.length;
  if (total > 0) {
    $.attachBadge.textContent = total;
    $.attachBadge.classList.remove("hidden");
  } else {
    $.attachBadge.classList.add("hidden");
  }
}

// ── File picker (existing) ───────────────────────────────
export async function openFilePicker() {
  const cwd = $.projectSelect.value;
  if (!cwd) return;
  $.fpModal.classList.remove("hidden");
  $.fpSearch.value = "";
  $.fpSearch.focus();

  try {
    const files = await api.fetchFiles(cwd);
    setState("allProjectFiles", files);
    renderFilePicker("");
  } catch (err) {
    console.error("Failed to load files:", err);
    setState("allProjectFiles", []);
    renderFilePicker("");
  }
}

export function renderFilePicker(filter) {
  $.fpList.innerHTML = "";
  const lower = filter.toLowerCase();
  const allProjectFiles = getState("allProjectFiles");
  const attachedFiles = getState("attachedFiles");
  const filtered = lower
    ? allProjectFiles.filter((f) => f.toLowerCase().includes(lower))
    : allProjectFiles;

  for (const filePath of filtered.slice(0, 200)) {
    const item = document.createElement("div");
    item.className = "file-picker-item";
    const isSelected = attachedFiles.some((f) => f.path === filePath);
    if (isSelected) item.classList.add("selected");
    item.textContent = filePath;
    item.addEventListener("click", () => toggleFileAttachment(filePath, item));
    $.fpList.appendChild(item);
  }
}

async function toggleFileAttachment(filePath, itemEl) {
  const attachedFiles = [...getState("attachedFiles")];
  const idx = attachedFiles.findIndex((f) => f.path === filePath);
  if (idx >= 0) {
    attachedFiles.splice(idx, 1);
    setState("attachedFiles", attachedFiles);
    itemEl.classList.remove("selected");
  } else {
    try {
      const cwd = $.projectSelect.value;
      const data = await api.fetchFileContent(cwd, filePath);
      attachedFiles.push({ path: filePath, content: data.content });
      setState("attachedFiles", attachedFiles);
      itemEl.classList.add("selected");
    } catch (err) {
      console.error("Failed to read file:", err);
      return;
    }
  }
  $.fpCount.textContent = `${attachedFiles.length} file${attachedFiles.length !== 1 ? "s" : ""} selected`;
  updateAttachmentBadge();
}

function closeFilePicker() {
  $.fpModal.classList.add("hidden");
}

// ── Image attachments ────────────────────────────────────
export function addImageAttachment(file) {
  if (!SUPPORTED_IMAGE_TYPES.includes(file.type)) {
    showImageError(`Unsupported image type: ${file.type}. Use PNG, JPEG, GIF, or WebP.`);
    return;
  }
  if (file.size > MAX_IMAGE_SIZE) {
    showImageError(`Image too large (${(file.size / 1024 / 1024).toFixed(1)}MB). Max 5MB.`);
    return;
  }

  const reader = new FileReader();
  reader.onload = () => {
    const base64 = reader.result.split(",")[1];
    const images = [...getState("imageAttachments")];
    images.push({ name: file.name, data: base64, mimeType: file.type });
    setState("imageAttachments", images);
    renderImagePreview();
    updateAttachmentBadge();
  };
  reader.readAsDataURL(file);
}

export function removeImageAttachment(index) {
  const images = [...getState("imageAttachments")];
  images.splice(index, 1);
  setState("imageAttachments", images);
  renderImagePreview();
  updateAttachmentBadge();
}

export function getImageAttachments() {
  return getState("imageAttachments");
}

export function clearImageAttachments() {
  setState("imageAttachments", []);
  renderImagePreview();
  updateAttachmentBadge();
}

function renderImagePreview() {
  const strip = $.imagePreviewStrip;
  const images = getState("imageAttachments");
  strip.innerHTML = "";

  if (images.length === 0) {
    strip.classList.add("hidden");
    return;
  }

  strip.classList.remove("hidden");
  images.forEach((img, i) => {
    const item = document.createElement("div");
    item.className = "image-preview-item";

    const imgEl = document.createElement("img");
    imgEl.src = `data:${img.mimeType};base64,${img.data}`;
    imgEl.alt = img.name;
    imgEl.title = img.name;

    const removeBtn = document.createElement("button");
    removeBtn.className = "image-preview-remove";
    removeBtn.textContent = "\u00d7";
    removeBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      removeImageAttachment(i);
    });

    item.appendChild(imgEl);
    item.appendChild(removeBtn);
    strip.appendChild(item);
  });
}

function showImageError(message) {
  // Use toast container if available
  const container = document.getElementById("toast-container");
  if (container) {
    const toast = document.createElement("div");
    toast.className = "toast error";
    toast.textContent = message;
    container.appendChild(toast);
    setTimeout(() => toast.remove(), 4000);
  } else {
    alert(message);
  }
}

// ── Event listeners ──────────────────────────────────────

// File picker buttons
$.attachBtn.addEventListener("click", openFilePicker);
document.getElementById("fp-modal-close").addEventListener("click", closeFilePicker);
document.getElementById("fp-done-btn").addEventListener("click", closeFilePicker);
$.fpModal.addEventListener("click", (e) => {
  if (e.target === $.fpModal) closeFilePicker();
});
$.fpSearch.addEventListener("input", () => {
  renderFilePicker($.fpSearch.value.trim());
});

// Image button → open file picker
$.imageBtn.addEventListener("click", () => {
  $.imageFileInput.click();
});

// Hidden file input change
$.imageFileInput.addEventListener("change", () => {
  for (const file of $.imageFileInput.files) {
    addImageAttachment(file);
  }
  $.imageFileInput.value = "";
});

// Paste handler — detect images in clipboard
document.addEventListener("paste", (e) => {
  // Only handle when focus is in the chat input area
  const active = document.activeElement;
  if (active !== $.messageInput && !$.messageInput.contains(active)) return;

  const items = e.clipboardData?.items;
  if (!items) return;

  for (const item of items) {
    if (item.kind === "file" && SUPPORTED_IMAGE_TYPES.includes(item.type)) {
      e.preventDefault();
      addImageAttachment(item.getAsFile());
    }
  }
});

// Drag-and-drop on message input
$.messageInput.addEventListener("dragover", (e) => {
  if ([...e.dataTransfer.types].includes("Files")) {
    e.preventDefault();
    $.messageInput.classList.add("drag-highlight");
  }
});

$.messageInput.addEventListener("dragleave", () => {
  $.messageInput.classList.remove("drag-highlight");
});

$.messageInput.addEventListener("drop", (e) => {
  $.messageInput.classList.remove("drag-highlight");
  if (!e.dataTransfer.files.length) return;
  e.preventDefault();
  for (const file of e.dataTransfer.files) {
    if (SUPPORTED_IMAGE_TYPES.includes(file.type)) {
      addImageAttachment(file);
    }
  }
});

// ── Commands ─────────────────────────────────────────────
registerCommand("attach", {
  category: "app",
  description: "Attach files to next message",
  execute() {
    openFilePicker();
  },
});
