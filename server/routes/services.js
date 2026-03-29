import { Router } from "express";
import { execSync, spawn } from "child_process";
import { writeFileSync } from "fs";
import { getWorkspaceDir, getConfig } from "../workspace-config.js";
import { sanitizePort, validateDevCommand } from "../sanitize.js";

export default function({ wsBroadcast }) {
  const router = Router();

  router.post("/restart-service", (req, res) => {
    try {
      const workspaceDir = getWorkspaceDir();
      const svcName = req.body.service;
      const repo = getConfig().repos.find(r => r.name === svcName);
      if (!repo || !repo.dev) return res.status(400).json({ error: `Unknown service: ${svcName}` });

      if (!validateDevCommand(repo.dev)) {
        return res.status(403).json({ error: `Blocked unsafe dev command: ${repo.dev}` });
      }
      if (repo.port) {
        const safePort = sanitizePort(repo.port);
        try { execSync(`kill $(lsof -ti:${safePort} -sTCP:LISTEN) 2>/dev/null`, { stdio: "pipe" }); } catch {}
      }
      const logFile = `/tmp/${repo.name}.log`;
      try { writeFileSync(logFile, ""); } catch {}
      const child = spawn("bash", ["-c", `cd "${workspaceDir}/${repo.name}" && ${repo.dev} >> ${logFile} 2>&1`], { detached: true, stdio: "ignore" });
      child.unref();
      child.on("error", (err) => {
        console.error(`[spawn] ${repo.name} failed:`, err.message);
        wsBroadcast({ type: "system", text: `Failed to start ${repo.name}. Check server logs for details.` });
      });
      if (process.env.CODESPACES === "true" && repo.port) {
        setTimeout(() => {
          try { execSync(`gh codespace ports visibility ${repo.port}:public 2>/dev/null`, { stdio: "pipe", timeout: 10000 }); } catch {}
        }, 5000);
      }
      res.json({ ok: true });
    } catch (err) {
      console.error("[restart-service]", err);
      res.status(500).json({ error: "Failed to restart service" });
    }
  });

  router.post("/stop-service", (req, res) => {
    try {
      const port = req.body.port;
      if (!port) return res.status(400).json({ error: "Missing port" });
      const safePort = sanitizePort(port);
      const vibePort = process.env.PORT || 4000;
      if (String(safePort) === String(vibePort)) return res.status(400).json({ error: "Cannot stop vibe-ui" });
      try { execSync(`kill $(lsof -ti:${safePort} -sTCP:LISTEN) 2>/dev/null`, { stdio: "pipe" }); } catch {}
      res.json({ ok: true });
    } catch (err) {
      console.error("[stop-service]", err);
      const status = err.message?.startsWith("Invalid port") ? 400 : 500;
      const msg = status === 400 ? "Invalid port" : "Failed to stop service";
      res.status(status).json({ error: msg });
    }
  });

  return router;
}
