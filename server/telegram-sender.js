// Telegram notification sender — two-way: rich notifications + permission approvals
import { readFile, writeFile } from "fs/promises";
import { configPath } from "./paths.js";

const configFile = configPath("telegram-config.json");

const DEFAULT_CONFIG = {
  enabled: false,
  botToken: "",
  chatId: "",
  afkTimeoutMinutes: 15,
  notify: {
    sessionComplete: true,
    workflowComplete: true,
    chainComplete: true,
    agentComplete: true,
    orchestratorComplete: true,
    dagComplete: true,
    errors: true,
    permissionRequests: true,
    taskStart: true,
  },
};

let config = { ...DEFAULT_CONFIG };

async function readConfig() {
  try {
    const raw = await readFile(configFile, "utf-8");
    const saved = JSON.parse(raw);
    return { ...DEFAULT_CONFIG, ...saved, notify: { ...DEFAULT_CONFIG.notify, ...saved.notify } };
  } catch {
    return { ...DEFAULT_CONFIG };
  }
}

export async function initTelegramSender() {
  config = await readConfig();
}

export async function saveTelegramConfig(newConfig) {
  const merged = {
    ...DEFAULT_CONFIG,
    ...newConfig,
    notify: { ...DEFAULT_CONFIG.notify, ...newConfig.notify },
  };
  await writeFile(configFile, JSON.stringify(merged, null, 2) + "\n");
  config = merged;
}

export function getTelegramConfig() {
  return {
    enabled: config.enabled,
    botToken: config.botToken ? maskToken(config.botToken) : "",
    chatId: config.chatId || "",
    afkTimeoutMinutes: config.afkTimeoutMinutes || 15,
    notify: { ...config.notify },
  };
}

export function getRawBotToken() {
  return config.botToken || "";
}

export function isEnabled() {
  return !!(config.enabled && config.botToken && config.chatId);
}

export function getConfig() {
  return config;
}

function maskToken(token) {
  if (!token || token.length < 8) return "****";
  return "****:" + token.slice(-6);
}

// ── Telegram Bot API helpers ──

async function apiCall(method, body) {
  if (!config.botToken) return null;
  try {
    const res = await fetch(
      `https://api.telegram.org/bot${config.botToken}/${method}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      }
    );
    if (!res.ok) {
      const err = await res.text();
      console.error(`Telegram ${method} failed:`, res.status, err);
      return null;
    }
    return await res.json();
  } catch (err) {
    console.error(`Telegram ${method} error:`, err.message);
    return null;
  }
}

// ── Rich notification messages ──

function formatDuration(ms) {
  if (!ms || ms < 1000) return "<1s";
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const rs = s % 60;
  if (m < 60) return rs ? `${m}m ${rs}s` : `${m}m`;
  const h = Math.floor(m / 60);
  const rm = m % 60;
  return rm ? `${h}h ${rm}m` : `${h}h`;
}

function formatCost(usd) {
  if (!usd) return "$0.00";
  return usd < 0.01 ? `$${usd.toFixed(4)}` : `$${usd.toFixed(2)}`;
}

function formatTokens(n) {
  if (!n) return "0";
  if (n >= 1000000) return `${(n / 1000000).toFixed(1)}M`;
  if (n >= 1000) return `${(n / 1000).toFixed(1)}K`;
  return String(n);
}

const EVENT_ICONS = {
  session: "\u{1F4AC}",      // 💬
  workflow: "\u{2699}\u{FE0F}",  // ⚙️
  chain: "\u{1F517}",        // 🔗
  agent: "\u{1F916}",        // 🤖
  orchestrator: "\u{1F3AF}", // 🎯
  dag: "\u{1F310}",          // 🌐
  error: "\u{26A0}\u{FE0F}", // ⚠️
  start: "\u{25B6}\u{FE0F}", // ▶️
  permission: "\u{1F512}",   // 🔒
};

/**
 * Send a rich notification with optional metrics.
 * @param {string} eventType - One of: session, workflow, chain, agent, orchestrator, dag, error, start
 * @param {string} title - Main title
 * @param {string} body - Description
 * @param {object} [metrics] - { durationMs, costUsd, inputTokens, outputTokens, model, turns, steps, succeeded, failed }
 */
export async function sendTelegramNotification(eventType, title, body, metrics = {}) {
  if (!isEnabled()) return;

  // Check notification preference
  const prefMap = {
    session: "sessionComplete",
    workflow: "workflowComplete",
    chain: "chainComplete",
    agent: "agentComplete",
    orchestrator: "orchestratorComplete",
    dag: "dagComplete",
    error: "errors",
    start: "taskStart",
  };
  const pref = prefMap[eventType];
  if (pref && config.notify && config.notify[pref] === false) return;

  const icon = EVENT_ICONS[eventType] || "";
  let text = `${icon} <b>${escapeHtml(title)}</b>\n${escapeHtml(body)}`;

  // Build metrics line
  const parts = [];
  if (metrics.durationMs) parts.push(`\u{23F1} ${formatDuration(metrics.durationMs)}`);
  if (metrics.costUsd) parts.push(`\u{1F4B0} ${formatCost(metrics.costUsd)}`);
  if (metrics.inputTokens || metrics.outputTokens) {
    parts.push(`\u{1F4CA} ${formatTokens(metrics.inputTokens)}in / ${formatTokens(metrics.outputTokens)}out`);
  }
  if (metrics.model) parts.push(`\u{1F9E0} ${escapeHtml(metrics.model)}`);
  if (metrics.turns) parts.push(`\u{1F504} ${metrics.turns} turns`);
  if (metrics.steps) parts.push(`\u{1F4CB} ${metrics.steps} steps`);
  if (typeof metrics.succeeded === "number" && typeof metrics.failed === "number") {
    parts.push(`\u{2705} ${metrics.succeeded} / \u{274C} ${metrics.failed}`);
  }

  if (parts.length) {
    text += `\n\n${parts.join("  \u{00B7}  ")}`;
  }

  return apiCall("sendMessage", {
    chat_id: config.chatId,
    text,
    parse_mode: "HTML",
    disable_notification: eventType === "start",
  });
}

/**
 * Send a permission request with Approve/Deny inline keyboard.
 * Returns the sent message (with message_id) or null.
 */
export async function sendPermissionRequest(approvalId, toolName, toolInput, sessionTitle) {
  if (!isEnabled() || config.notify?.permissionRequests === false) return null;

  const summary = getToolSummary(toolName, toolInput);
  const label = sessionTitle ? `\n\u{1F4C1} ${escapeHtml(sessionTitle)}` : "";

  const text =
    `${EVENT_ICONS.permission} <b>Tool Approval Needed</b>${label}\n\n` +
    `<b>${escapeHtml(toolName)}</b>\n` +
    `<code>${escapeHtml(summary)}</code>`;

  return apiCall("sendMessage", {
    chat_id: config.chatId,
    text,
    parse_mode: "HTML",
    reply_markup: {
      inline_keyboard: [
        [
          { text: "\u{2705} Approve", callback_data: `approve:${approvalId}` },
          { text: "\u{274C} Deny", callback_data: `deny:${approvalId}` },
        ],
      ],
    },
  });
}

/**
 * Edit a message (e.g., after approval/denial to update status).
 */
export async function editMessageText(messageId, newText) {
  if (!isEnabled()) return null;
  return apiCall("editMessageText", {
    chat_id: config.chatId,
    message_id: messageId,
    text: newText,
    parse_mode: "HTML",
  });
}

/**
 * Remove inline keyboard from a message.
 */
export async function editMessageReplyMarkup(messageId) {
  if (!isEnabled()) return null;
  return apiCall("editMessageReplyMarkup", {
    chat_id: config.chatId,
    message_id: messageId,
    reply_markup: { inline_keyboard: [] },
  });
}

/**
 * Answer a callback query (required by Telegram to dismiss the loading indicator).
 */
export async function answerCallbackQuery(callbackQueryId, text) {
  if (!config.botToken) return null;
  return apiCall("answerCallbackQuery", {
    callback_query_id: callbackQueryId,
    text: text || "",
  });
}

// ── Tool summary helper ──

function getToolSummary(toolName, input) {
  if (!input) return toolName;
  const maxLen = 200;
  let summary = "";

  switch (toolName) {
    case "Bash":
    case "Shell":
      summary = input.command || "";
      break;
    case "Read":
    case "Write":
      summary = input.file_path || "";
      break;
    case "Edit":
      summary = input.file_path ? `${input.file_path}` : "";
      break;
    case "Glob":
      summary = input.pattern || "";
      break;
    case "Grep":
      summary = `/${input.pattern || ""}/ in ${input.path || "."}`;
      break;
    case "WebSearch":
      summary = input.query || "";
      break;
    case "WebFetch":
      summary = input.url || "";
      break;
    default:
      summary = JSON.stringify(input);
  }

  if (summary.length > maxLen) summary = summary.slice(0, maxLen) + "...";
  return summary;
}

// ── HTML escaping ──

function escapeHtml(str) {
  if (!str) return "";
  return String(str).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
