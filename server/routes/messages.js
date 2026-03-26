import { Router } from "express";
import { getMessages, getMessagesByChatId, getMessagesNoChatId, deleteMessagesFrom, getLastUserMessage } from "../../db.js";

const router = Router();

// Get all messages for a session
router.get("/:id/messages", (req, res) => {
  try {
    const messages = getMessages(req.params.id);
    res.json(messages);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Get messages filtered by chatId
router.get("/:id/messages/:chatId", (req, res) => {
  try {
    const messages = getMessagesByChatId(req.params.id, req.params.chatId);
    res.json(messages);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Get messages where chat_id IS NULL (single-mode)
router.get("/:id/messages-single", (req, res) => {
  try {
    const messages = getMessagesNoChatId(req.params.id);
    res.json(messages);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Delete the last user message and everything after it (for edit & re-prompt)
router.delete("/:id/truncate-last", (req, res) => {
  try {
    const chatId = req.query.chatId || null;
    const lastMsg = getLastUserMessage(req.params.id, chatId);
    if (!lastMsg) {
      return res.status(404).json({ error: "No user message found" });
    }
    const result = deleteMessagesFrom(req.params.id, lastMsg.id, chatId);
    res.json({ deleted: result.changes, fromMessageId: lastMsg.id });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

export default router;
