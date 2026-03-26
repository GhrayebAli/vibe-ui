// Message rendering
import { escapeHtml, getToolDetail, scrollToBottom } from '../core/utils.js';
import { renderMarkdown, highlightCodeBlocks, addCopyButtons, renderMermaidBlocks } from './formatting.js';
import { renderDiffView, renderAdditionsView } from './diff.js';
import { getState, setState } from '../core/store.js';
import { $ } from '../core/dom.js';
import { getPane } from './parallel.js';
import * as api from '../core/api.js';

// Will be set by chat.js to avoid circular dependency
let _sendEditedMessage = null;
export function _setEditMessageFn(fn) { _sendEditedMessage = fn; }

export function showWhalyPlaceholder(pane) {
  pane = pane || getPane(null);
  removeWhalyPlaceholder(pane);
  const el = document.createElement("div");
  el.className = "whaly-placeholder";
  el.innerHTML = `<img src="/icons/whaly.png" alt="Whaly" draggable="false"><div class="whaly-text">~ start chatting with claude ~</div><div class="whaly-hint">Type a message or select a prompt template</div>`;
  pane.messagesDiv.appendChild(el);
}

export function removeWhalyPlaceholder(pane) {
  pane = pane || getPane(null);
  const existing = pane.messagesDiv.querySelector(".whaly-placeholder");
  if (existing) existing.remove();
}

export function addUserMessage(text, pane, images = [], filePaths = []) {
  pane = pane || getPane(null);
  removeWhalyPlaceholder(pane);
  pane.currentAssistantMsg = null;
  const div = document.createElement("div");
  div.className = "msg msg-user";
  div.dataset.originalText = text;

  const label = document.createElement("span");
  label.className = "msg-user-label";
  label.textContent = "YOU";

  div.appendChild(label);

  if (filePaths && filePaths.length > 0) {
    const filesDiv = document.createElement("div");
    filesDiv.className = "msg-user-files";
    for (const fp of filePaths) {
      const fileTag = document.createElement("span");
      fileTag.className = "msg-user-file-tag";
      fileTag.textContent = fp;
      fileTag.title = fp;
      filesDiv.appendChild(fileTag);
    }
    div.appendChild(filesDiv);
  }

  const body = document.createElement("span");
  body.className = "msg-user-body";
  body.textContent = text;

  div.appendChild(body);

  if (images && images.length > 0) {
    renderChatImages(images, div);
  }

  pane.messagesDiv.appendChild(div);
  scrollToBottom(pane);
  updateEditButtons(pane);
}

function renderChatImages(images, container) {
  const strip = document.createElement("div");
  strip.className = "chat-image-strip";

  for (const img of images) {
    const imgEl = document.createElement("img");
    imgEl.className = "chat-image-thumb";
    imgEl.src = `data:${img.mimeType};base64,${img.data}`;
    imgEl.alt = img.name || "attached image";
    imgEl.title = img.name || "attached image";
    imgEl.addEventListener("click", () => {
      const overlay = document.createElement("div");
      overlay.className = "chat-image-overlay";
      const fullImg = document.createElement("img");
      fullImg.src = imgEl.src;
      overlay.appendChild(fullImg);
      overlay.addEventListener("click", () => overlay.remove());
      document.body.appendChild(overlay);
    });
    strip.appendChild(imgEl);
  }

  container.appendChild(strip);
}

export function appendAssistantText(text, pane) {
  pane = pane || getPane(null);
  if (!pane.currentAssistantMsg) {
    const div = document.createElement("div");
    div.className = "msg msg-assistant";
    const content = document.createElement("div");
    content.className = "text-content";
    div.appendChild(content);
    pane.messagesDiv.appendChild(div);
    pane.currentAssistantMsg = content;
  }
  pane.currentAssistantMsg.dataset.raw =
    (pane.currentAssistantMsg.dataset.raw || "") + text;
  if (!pane._renderPending) {
    pane._renderPending = true;
    const currentPane = pane;
    requestAnimationFrame(() => {
      if (currentPane.currentAssistantMsg) {
        currentPane.currentAssistantMsg.innerHTML = renderMarkdown(currentPane.currentAssistantMsg.dataset.raw || "");
        highlightCodeBlocks(currentPane.currentAssistantMsg);
        addCopyButtons(currentPane.currentAssistantMsg);
        renderMermaidBlocks(currentPane.currentAssistantMsg);
        scrollToBottom(currentPane);
      }
      currentPane._renderPending = false;
    });
  }

  // Update streaming token counter
  let count = getState("streamingCharCount") + text.length;
  setState("streamingCharCount", count);
  const tokenEst = Math.round(count / 4);
  if ($.streamingTokens) {
    if ($.streamingTokensValue) $.streamingTokensValue.textContent = `~${tokenEst} tokens`;
    $.streamingTokens.classList.remove("hidden");
    if ($.streamingTokensSep) $.streamingTokensSep.classList.remove("hidden");
  }
}

export function appendToolIndicator(name, input, pane, toolId, isLive = true) {
  pane = pane || getPane(null);
  const div = document.createElement("div");
  div.className = "msg";

  // Diff view for Edit tool
  if (name === "Edit" && input && input.old_string != null && input.new_string != null) {
    const diffEl = renderDiffView(input.old_string, input.new_string, input.file_path);
    if (diffEl) {
      div.appendChild(diffEl);
      pane.messagesDiv.appendChild(div);
      pane.currentAssistantMsg = null;
      scrollToBottom(pane);
      return;
    }
  }

  // Additions view for Write tool
  if (name === "Write" && input && input.content != null) {
    const addEl = renderAdditionsView(input.content, input.file_path);
    if (addEl) {
      div.appendChild(addEl);
      pane.messagesDiv.appendChild(div);
      pane.currentAssistantMsg = null;
      scrollToBottom(pane);
      return;
    }
  }

  // Default tool indicator — show spinner only for live streaming tools
  const indicator = document.createElement("div");
  indicator.className = isLive ? "tool-indicator tool-running" : "tool-indicator";
  if (toolId) indicator.dataset.toolId = toolId;
  indicator.innerHTML = `
    <span class="tool-spinner" ${!isLive ? 'style="display:none;"' : ""}></span>
    <span class="tool-status-icon" style="display:none;"></span>
    <span class="tool-name">${escapeHtml(name)}</span>
    <span class="tool-detail">${getToolDetail(name, input)}</span>
    <div class="tool-body">${escapeHtml(JSON.stringify(input, null, 2))}</div>
    <div class="tool-result-preview" style="display:none;"></div>
  `;
  indicator.addEventListener("click", () => {
    indicator.classList.toggle("expanded");
  });

  div.appendChild(indicator);
  pane.messagesDiv.appendChild(div);
  pane.currentAssistantMsg = null;
  scrollToBottom(pane);
}

export function appendToolResult(toolUseId, content, isError, pane) {
  pane = pane || getPane(null);

  // Try to find the matching tool indicator and update it in-place
  const existing = toolUseId
    ? pane.messagesDiv.querySelector(`.tool-indicator[data-tool-id="${toolUseId}"]`)
    : null;

  if (existing) {
    // Update the existing indicator: stop spinner, show status icon + result
    existing.classList.remove("tool-running");
    existing.classList.add(isError ? "tool-error" : "tool-done");

    const spinner = existing.querySelector(".tool-spinner");
    if (spinner) spinner.style.display = "none";

    const statusIcon = existing.querySelector(".tool-status-icon");
    if (statusIcon) {
      statusIcon.style.display = "";
      statusIcon.style.color = isError ? "var(--error)" : "var(--success)";
      statusIcon.innerHTML = isError ? "&#10007;" : "&#10003;";
    }

    // Show result preview inline
    const resultPreview = existing.querySelector(".tool-result-preview");
    if (resultPreview && content) {
      const preview = typeof content === "string" ? content.slice(0, 150) : "";
      resultPreview.textContent = preview;
      resultPreview.style.display = "";
      resultPreview.className = "tool-result-preview" + (isError ? " error" : "");
    }

    // Append full result to tool-body
    const body = existing.querySelector(".tool-body");
    if (body && content) {
      body.innerHTML += "\n\n─── Result ───\n" + escapeHtml(content || "");
    }

    scrollToBottom(pane);
    return;
  }

  // Fallback: create a standalone result element (for old messages without tool IDs)
  const div = document.createElement("div");
  div.className = "msg";

  const indicator = document.createElement("div");
  indicator.className = "tool-indicator " + (isError ? "tool-error" : "tool-done");
  const preview = typeof content === "string" ? content.slice(0, 120) : "";
  const iconColor = isError ? "var(--error)" : "var(--success)";
  const icon = isError ? "&#10007;" : "&#10003;";
  indicator.innerHTML = `
    <span class="tool-status-icon" style="color: ${iconColor};">${icon}</span>
    <span class="tool-name">${isError ? "Error" : "Result"}</span>
    <span class="tool-detail">${escapeHtml(preview)}</span>
    <div class="tool-body">${escapeHtml(content || "")}</div>
  `;
  indicator.addEventListener("click", () => {
    indicator.classList.toggle("expanded");
  });

  div.appendChild(indicator);
  pane.messagesDiv.appendChild(div);
  pane.currentAssistantMsg = null;
  scrollToBottom(pane);
}

export function showThinking(label, pane) {
  pane = pane || getPane(null);
  removeThinking(pane);
  const div = document.createElement("div");
  div.className = "thinking-bar";
  div.dataset.thinkingBar = "true";
  div.innerHTML = `
    <div class="thinking-dot-container">
      <span class="thinking-dot"></span>
      <span class="thinking-dot"></span>
      <span class="thinking-dot"></span>
    </div>
    <span class="thinking-label">${escapeHtml(label)}</span>
  `;
  pane.messagesDiv.appendChild(div);
  if (pane.statusEl) {
    pane.statusEl.textContent = "streaming";
    pane.statusEl.className = "chat-pane-status streaming";
  }
  scrollToBottom(pane);
}

export function removeThinking(pane) {
  pane = pane || getPane(null);
  const el = pane.messagesDiv.querySelector('[data-thinking-bar="true"]');
  if (el) el.remove();
}

export function addResultSummary(msg, pane) {
  pane = pane || getPane(null);
  const parts = [];
  if (msg.model) parts.push(msg.model);
  if (msg.num_turns != null) parts.push(`${msg.num_turns} turn${msg.num_turns !== 1 ? "s" : ""}`);
  if (msg.duration_ms != null) {
    const secs = (msg.duration_ms / 1000).toFixed(1);
    parts.push(`${secs}s`);
  }
  if (msg.cost_usd != null) parts.push(`$${msg.cost_usd.toFixed(4)}`);
  const inTok = msg.input_tokens || 0;
  const outTok = msg.output_tokens || 0;
  if (inTok > 0 || outTok > 0) {
    const fmtTok = (n) => n >= 1000 ? (n / 1000).toFixed(1) + 'k' : String(n);
    parts.push(`${fmtTok(inTok)} in / ${fmtTok(outTok)} out`);
  }
  if (msg.stop_reason && msg.stop_reason !== "success") {
    parts.push(`[${msg.stop_reason}]`);
  }
  if (parts.length > 0) {
    addStatus(parts.join(" \u00b7 "), false, pane);
  }
}

export function addStatus(text, isError, pane) {
  pane = pane || getPane(null);
  const div = document.createElement("div");
  div.className = "status" + (isError ? " error" : "");
  div.textContent = text;
  pane.messagesDiv.appendChild(div);
  scrollToBottom(pane);
}

export function appendCliOutput(data, pane) {
  pane = pane || getPane(null);
  const div = document.createElement("div");
  div.className = "msg";

  const block = document.createElement("div");
  block.className = "cli-output";

  const isOk = data.exitCode === 0;
  block.innerHTML = `
    <div class="cli-output-header">
      <span class="cli-icon ${isOk ? "success" : "error"}">${isOk ? "&#10003;" : "&#10007;"}</span>
      <span class="cli-cmd">${escapeHtml(data.command)}</span>
      <span class="cli-exit">exit ${data.exitCode}</span>
    </div>
    <div class="cli-output-body">
      ${data.stdout ? `<pre>${escapeHtml(data.stdout)}</pre>` : ""}
      ${data.stderr ? `<pre class="cli-output-stderr">${escapeHtml(data.stderr)}</pre>` : ""}
      ${!data.stdout && !data.stderr ? `<pre>(no output)</pre>` : ""}
    </div>
  `;

  div.appendChild(block);
  pane.messagesDiv.appendChild(div);
  pane.currentAssistantMsg = null;
  scrollToBottom(pane);
}

export function updateEditButtons(pane) {
  pane = pane || getPane(null);
  // Remove all existing edit buttons
  pane.messagesDiv.querySelectorAll(".msg-edit-btn").forEach(btn => btn.remove());

  // Don't show edit button while streaming
  if (pane.isStreaming) return;

  // Find the last user message
  const userMsgs = pane.messagesDiv.querySelectorAll(".msg-user");
  if (userMsgs.length === 0) return;
  const lastUserMsg = userMsgs[userMsgs.length - 1];

  // Add edit button
  const editBtn = document.createElement("button");
  editBtn.className = "msg-edit-btn";
  editBtn.title = "Edit & re-send";
  editBtn.innerHTML = "&#9998;"; // pencil
  editBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    enterEditMode(lastUserMsg, pane);
  });

  // Insert after the label
  const label = lastUserMsg.querySelector(".msg-user-label");
  if (label) {
    label.style.position = "relative";
    label.appendChild(editBtn);
  }
}

function enterEditMode(msgDiv, pane) {
  const body = msgDiv.querySelector(".msg-user-body");
  if (!body || msgDiv.classList.contains("editing")) return;
  msgDiv.classList.add("editing");

  const originalText = msgDiv.dataset.originalText || body.textContent;

  // Replace body with textarea
  const textarea = document.createElement("textarea");
  textarea.className = "msg-edit-textarea";
  textarea.value = originalText;
  textarea.rows = Math.max(2, originalText.split("\n").length);

  const actions = document.createElement("div");
  actions.className = "msg-edit-actions";

  const saveBtn = document.createElement("button");
  saveBtn.className = "msg-edit-save";
  saveBtn.textContent = "Send";

  const cancelBtn = document.createElement("button");
  cancelBtn.className = "msg-edit-cancel";
  cancelBtn.textContent = "Cancel";

  actions.appendChild(saveBtn);
  actions.appendChild(cancelBtn);

  body.style.display = "none";
  msgDiv.appendChild(textarea);
  msgDiv.appendChild(actions);
  textarea.focus();
  textarea.setSelectionRange(textarea.value.length, textarea.value.length);

  // Remove edit button while in edit mode
  const editBtn = msgDiv.querySelector(".msg-edit-btn");
  if (editBtn) editBtn.style.display = "none";

  function cancel() {
    msgDiv.classList.remove("editing");
    body.style.display = "";
    textarea.remove();
    actions.remove();
    if (editBtn) editBtn.style.display = "";
  }

  async function save() {
    const newText = textarea.value.trim();
    if (!newText) return;

    const sessionId = getState("sessionId");
    if (!sessionId) return;

    const parallelMode = getState("parallelMode");
    const chatId = parallelMode && pane.chatId ? pane.chatId : null;

    // Delete last exchange from DB
    await api.truncateLastExchange(sessionId, chatId);

    // Remove all DOM elements from this message onward
    let sibling = msgDiv.nextElementSibling;
    while (sibling) {
      const next = sibling.nextElementSibling;
      sibling.remove();
      sibling = next;
    }
    msgDiv.remove();

    // Send the edited message
    if (_sendEditedMessage) {
      _sendEditedMessage(newText, pane);
    }
  }

  saveBtn.addEventListener("click", save);
  cancelBtn.addEventListener("click", cancel);

  textarea.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      e.preventDefault();
      cancel();
    }
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      save();
    }
  });
}

export function renderMessagesIntoPane(messages, pane) {
  pane.messagesDiv.innerHTML = "";
  pane.currentAssistantMsg = null;
  // Reset streaming counter — we're loading saved messages, not streaming
  setState("streamingCharCount", 0);
  if (!messages || messages.length === 0) {
    showWhalyPlaceholder(pane);
    return;
  }
  for (const msg of messages) {
    const data = JSON.parse(msg.content);
    switch (msg.role) {
      case "user": {
        // Extract file paths from saved <file path="..."> blocks
        const filePathMatches = (data.text || "").match(/<file path="([^"]+)">/g);
        const savedFilePaths = filePathMatches
          ? filePathMatches.map(m => m.match(/<file path="([^"]+)">/)[1])
          : [];
        // Show only the user's actual text, not the file content blocks
        const cleanText = savedFilePaths.length > 0
          ? (data.text || "").replace(/<file path="[^"]*">[\s\S]*?<\/file>\s*/g, "").trim()
          : (data.text || "");
        addUserMessage(cleanText, pane, data.images || [], savedFilePaths);
        break;
      }
      case "assistant":
        appendAssistantText(data.text, pane);
        break;
      case "tool":
        appendToolIndicator(data.name, data.input, pane, data.id, false);
        break;
      case "tool_result":
        appendToolResult(data.toolUseId, data.content, data.isError, pane);
        break;
      case "result":
        addResultSummary(data, pane);
        break;
      case "error": {
        const errorParts = [];
        if (data.subtype) errorParts.push(`[${data.subtype}]`);
        if (data.error) errorParts.push(data.error);
        if (data.cost_usd != null) errorParts.push(`$${data.cost_usd.toFixed(4)}`);
        if (data.model) errorParts.push(data.model);
        addStatus(errorParts.join(" \u00b7 ") || "Error", true, pane);
        break;
      }
      case "aborted":
        addStatus("Aborted", true, pane);
        break;
    }
  }
  pane.currentAssistantMsg = null;
  // Hide token counter and reset — loading saved messages shouldn't show streaming stats
  setState("streamingCharCount", 0);
  if ($.streamingTokens) $.streamingTokens.classList.add("hidden");
  if ($.streamingTokensSep) $.streamingTokensSep.classList.add("hidden");
  highlightCodeBlocks(pane.messagesDiv);
  addCopyButtons(pane.messagesDiv);
  renderMermaidBlocks(pane.messagesDiv);
  updateEditButtons(pane);
}
