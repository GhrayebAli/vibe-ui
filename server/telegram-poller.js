/**
 * Telegram long-poller — listens for callback_query events (Approve/Deny button presses)
 * and routes them back to the pendingApprovals Map used by the permission system.
 *
 * Also sends a WebSocket message to the frontend so the permission modal auto-dismisses
 * when approval comes from Telegram.
 */
import {
  getRawBotToken,
  isEnabled,
  answerCallbackQuery,
  editMessageText,
  editMessageReplyMarkup,
} from "./telegram-sender.js";

let polling = false;
let pollAbort = null;
let lastUpdateId = 0;

// Registry: approvalId → { resolve, timer, toolInput, telegramMessageId, ws }
// Shared reference set by ws-handler via registerApprovalBridge
let pendingApprovalsRef = null;
let broadcastToSessionRef = null;

/**
 * Register the bridge so the poller can resolve pending approvals and notify the frontend.
 * @param {Map} pendingApprovals - The Map from ws-handler
 * @param {Function} broadcastToSession - fn(sessionId, payload) to send WS msg to frontend
 */
export function registerApprovalBridge(pendingApprovals, broadcastToSession) {
  pendingApprovalsRef = pendingApprovals;
  broadcastToSessionRef = broadcastToSession;
}

/**
 * Track a Telegram message ID for a given approval so we can edit it later.
 */
const approvalMessages = new Map(); // approvalId → { messageId, toolName }

export function trackApprovalMessage(approvalId, messageId, toolName) {
  approvalMessages.set(approvalId, { messageId, toolName });
}

export function removeApprovalMessage(approvalId) {
  const entry = approvalMessages.get(approvalId);
  approvalMessages.delete(approvalId);
  return entry;
}

/**
 * Mark a Telegram permission message as resolved (from web UI).
 * Called when the user approves/denies via the web modal.
 */
export async function markTelegramMessageResolved(approvalId, behavior) {
  const entry = removeApprovalMessage(approvalId);
  if (!entry) return;

  const icon = behavior === "allow" ? "\u{2705}" : "\u{274C}";
  const label = behavior === "allow" ? "Approved" : "Denied";

  await editMessageText(
    entry.messageId,
    `${icon} <b>${label} via Web</b>\n<s>${entry.toolName}</s>`
  );
}

// ── Polling loop ──

async function pollOnce() {
  const token = getRawBotToken();
  if (!token) return;

  pollAbort = new AbortController();

  try {
    const res = await fetch(
      `https://api.telegram.org/bot${token}/getUpdates`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          offset: lastUpdateId + 1,
          timeout: 30,
          allowed_updates: ["callback_query"],
        }),
        signal: pollAbort.signal,
      }
    );

    if (!res.ok) {
      console.error("Telegram poll error:", res.status, await res.text());
      return;
    }

    const data = await res.json();
    if (!data.ok || !data.result?.length) return;

    for (const update of data.result) {
      lastUpdateId = Math.max(lastUpdateId, update.update_id);
      if (update.callback_query) {
        await handleCallback(update.callback_query);
      }
    }
  } catch (err) {
    if (err.name === "AbortError") return;
    console.error("Telegram poll error:", err.message);
  }
}

async function handleCallback(cb) {
  const data = cb.data || "";
  const [action, approvalId] = data.split(":");

  if (!approvalId || (action !== "approve" && action !== "deny")) {
    await answerCallbackQuery(cb.id, "Unknown action");
    return;
  }

  const behavior = action === "approve" ? "allow" : "deny";
  const icon = action === "approve" ? "\u{2705}" : "\u{274C}";
  const label = action === "approve" ? "Approved" : "Denied";

  // Try to resolve the pending approval
  let resolved = false;

  if (pendingApprovalsRef) {
    const pending = pendingApprovalsRef.get(approvalId);
    if (pending) {
      clearTimeout(pending.timer);
      pendingApprovalsRef.delete(approvalId);

      if (behavior === "allow") {
        pending.resolve({ behavior: "allow", updatedInput: pending.toolInput });
      } else {
        pending.resolve({ behavior: "deny", message: "Denied via Telegram" });
      }

      resolved = true;

      // Notify the frontend to dismiss the permission modal
      if (pending.ws && pending.ws.readyState === 1) {
        pending.ws.send(JSON.stringify({
          type: "permission_response_external",
          id: approvalId,
          behavior,
          source: "telegram",
        }));
      }
    }
  }

  // Update the Telegram message
  const entry = removeApprovalMessage(approvalId);
  if (entry) {
    await editMessageText(
      entry.messageId,
      `${icon} <b>${label} via Telegram</b>\n<s>${entry.toolName || "Tool"}</s>`
    );
  } else if (cb.message?.message_id) {
    // Fallback: remove buttons even if we lost track
    await editMessageReplyMarkup(cb.message.message_id);
  }

  // Answer the callback to dismiss the loading spinner
  await answerCallbackQuery(cb.id, resolved ? `${label}!` : "Already resolved");
}

// ── Lifecycle ──

export function startTelegramPoller() {
  if (polling) return;
  if (!isEnabled()) {
    console.log("Telegram poller: disabled (not configured)");
    return;
  }

  polling = true;
  console.log("Telegram poller: started");

  (async () => {
    while (polling) {
      await pollOnce();
      // Small delay between polls to avoid hammering on errors
      if (polling) await new Promise((r) => setTimeout(r, 500));
    }
  })();
}

export function stopTelegramPoller() {
  polling = false;
  if (pollAbort) {
    pollAbort.abort();
    pollAbort = null;
  }
  console.log("Telegram poller: stopped");
}

/**
 * Restart the poller (e.g., after config change).
 */
export function restartTelegramPoller() {
  stopTelegramPoller();
  // Small delay to let the old poll abort cleanly
  setTimeout(() => startTelegramPoller(), 1000);
}
