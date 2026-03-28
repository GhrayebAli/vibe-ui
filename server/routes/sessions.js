import { Router } from "express";
import { execSync } from "child_process";
import { join } from "path";
import { getSession, getMessages, undoLastTurn, listRecentSessions, getLastUserMessage, deleteMessagesFrom, getActivityTimeline, getLastUserMessageTimestamp, getLastAssistantMessage } from "../../db.js";
import { getWorkspaceDir, getRepoNames } from "../workspace-config.js";
import { sanitizeBranchName } from "../sanitize.js";

export default function({ getSessionChangedFiles, wsBroadcast }) {
  const router = Router();

  router.get("/sessions", (_req, res) => {
    try {
      res.json(listRecentSessions(50));
    } catch (err) {
      console.error("Sessions API error:", err.message);
      res.json([]);
    }
  });

  router.get("/sessions/:id/messages", (req, res) => {
    res.json(getMessages(req.params.id));
  });

  router.delete("/sessions/:id/truncate-last", (req, res) => {
    try {
      const lastMsg = getLastUserMessage(req.params.id);
      if (!lastMsg) return res.status(404).json({ error: "No user message found" });
      const result = deleteMessagesFrom(req.params.id, lastMsg.id);
      res.json({ deleted: result.changes, fromMessageId: lastMsg.id });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  router.get("/sessions/:id/timeline", (req, res) => {
    res.json(getActivityTimeline(req.params.id));
  });

  router.get("/sessions/:id/undo-preview", (req, res) => {
    try {
      const session = getSession(req.params.id);
      if (!session) return res.json({ ok: false, error: "Session not found" });

      const branch = session.branch;
      if (!branch || branch === "main" || branch === "master") {
        return res.json({ ok: false, error: "Cannot undo on main/master" });
      }

      const workspaceDir = getWorkspaceDir();
      const repos = getRepoNames();
      const commits = [];

      const turnStart = getLastUserMessageTimestamp(req.params.id)?.created_at || 0;

      for (const repo of repos) {
        const repoDir = join(workspaceDir, repo);
        try {
          const lastMsg = execSync(`git -C "${repoDir}" log -1 --pretty=%s`, { stdio: "pipe" }).toString().trim();
          if (lastMsg.startsWith("auto: ")) {
            const commitTs = parseInt(execSync(`git -C "${repoDir}" log -1 --format=%ct`, { stdio: "pipe" }).toString().trim()) || 0;
            if (commitTs >= turnStart) {
              const files = execSync(`git -C "${repoDir}" diff --name-only HEAD~1..HEAD`, { stdio: "pipe" }).toString().trim().split("\n").filter(Boolean);
              commits.push({ repo, filesChanged: files });
            }
          }
        } catch {}
      }

      const lastAssistant = getLastAssistantMessage(req.params.id);
      let preview = '';
      try { preview = JSON.parse(lastAssistant?.content || '{}').text || ''; } catch { preview = lastAssistant?.content || ''; }

      res.json({ ok: true, commits, messagePreview: preview.slice(0, 200), branch });
    } catch (err) {
      res.status(500).json({ ok: false, error: err.message });
    }
  });

  router.post("/sessions/:id/undo", async (req, res) => {
    try {
      const session = getSession(req.params.id);
      if (!session) return res.status(404).json({ error: "Session not found" });

      const branch = session.branch;
      if (!branch || branch === "main" || branch === "master") {
        return res.status(400).json({ error: "Cannot undo on main/master" });
      }

      const workspaceDir = getWorkspaceDir();
      const repos = getRepoNames();
      const revertResults = [];

      const turnStart = getLastUserMessageTimestamp(req.params.id)?.created_at || 0;

      for (const repo of repos) {
        const repoDir = join(workspaceDir, repo);
        try {
          const lastMsg = execSync(`git -C "${repoDir}" log -1 --pretty=%s`, { stdio: "pipe" }).toString().trim();
          if (lastMsg.startsWith("auto: ")) {
            const commitTs = parseInt(execSync(`git -C "${repoDir}" log -1 --format=%ct`, { stdio: "pipe" }).toString().trim()) || 0;
            if (commitTs >= turnStart) {
              const files = execSync(`git -C "${repoDir}" diff --name-only HEAD~1..HEAD`, { stdio: "pipe" }).toString().trim();
              execSync(`git -C "${repoDir}" reset --hard HEAD~1`, { stdio: "pipe", timeout: 10000 });
              try { execSync(`git -C "${repoDir}" push --force origin "${sanitizeBranchName(branch)}"`, { stdio: "pipe", timeout: 30000 }); } catch {}
              revertResults.push({ repo, status: "reverted", files: files.split("\n").filter(Boolean) });
            } else {
              revertResults.push({ repo, status: "skipped" });
            }
          } else {
            revertResults.push({ repo, status: "skipped" });
          }
        } catch (e) {
          revertResults.push({ repo, status: "error", error: e.message });
        }
      }

      const deleted = undoLastTurn(req.params.id);
      const messages = getMessages(req.params.id);

      wsBroadcast({ type: "system", text: "Undo complete \u2014 files reverted." });

      res.json({ ok: true, deleted, revertResults, messages });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  router.get("/session-changes", (req, res) => {
    const sessionId = req.query.sessionId;
    if (!sessionId) return res.json({ files: [] });
    const files = getSessionChangedFiles(sessionId);
    res.json({ files });
  });

  return router;
}
