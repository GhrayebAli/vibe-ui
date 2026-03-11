// Telegram notification settings — UI for configuring bot token + chat ID
import { $ } from '../core/dom.js';
import { registerCommand } from '../ui/commands.js';

async function loadConfig() {
  try {
    const res = await fetch("/api/telegram/config");
    if (!res.ok) return null;
    return await res.json();
  } catch { return null; }
}

function showStatus(msg, isError) {
  $.telegramStatus.textContent = msg;
  $.telegramStatus.className = `telegram-status ${isError ? "error" : "success"}`;
  $.telegramStatus.classList.remove("hidden");
  setTimeout(() => $.telegramStatus.classList.add("hidden"), 4000);
}

function updateLabel(enabled) {
  $.telegramLabel.textContent = enabled ? "Telegram (on)" : "Telegram";
}

async function openModal() {
  const config = await loadConfig();
  if (config) {
    $.telegramEnabled.checked = config.enabled;
    $.telegramBotToken.value = config.botToken || "";
    $.telegramChatId.value = config.chatId || "";
    updateLabel(config.enabled);
  }
  $.telegramModal.classList.remove("hidden");
}

function closeModal() {
  $.telegramModal.classList.add("hidden");
}

async function save() {
  const enabled = $.telegramEnabled.checked;
  const botToken = $.telegramBotToken.value.trim();
  const chatId = $.telegramChatId.value.trim();

  if (enabled && (!botToken || !chatId)) {
    showStatus("Bot token and chat ID are required", true);
    return;
  }

  try {
    const res = await fetch("/api/telegram/config", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ enabled, botToken, chatId }),
    });
    if (!res.ok) throw new Error((await res.json()).error);
    showStatus("Settings saved", false);
    updateLabel(enabled);
  } catch (err) {
    showStatus(`Save failed: ${err.message}`, true);
  }
}

async function test() {
  $.telegramTestBtn.disabled = true;
  $.telegramTestBtn.textContent = "Sending...";
  try {
    const res = await fetch("/api/telegram/test", { method: "POST" });
    if (!res.ok) throw new Error((await res.json()).error || "Send failed");
    showStatus("Test message sent — check Telegram", false);
  } catch (err) {
    showStatus(`Test failed: ${err.message}`, true);
  } finally {
    $.telegramTestBtn.disabled = false;
    $.telegramTestBtn.textContent = "Send Test";
  }
}

// Wire up
$.telegramBtn.addEventListener("click", openModal);
$.telegramClose.addEventListener("click", closeModal);
$.telegramModal.addEventListener("click", (e) => {
  if (e.target === $.telegramModal) closeModal();
});
$.telegramSaveBtn.addEventListener("click", save);
$.telegramTestBtn.addEventListener("click", test);

// Register slash command
registerCommand("telegram", {
  category: "settings",
  description: "Open Telegram notification settings",
  execute() { openModal(); },
});

// Load initial state
loadConfig().then(config => {
  if (config) updateLabel(config.enabled);
});
