import dotenv from "dotenv";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { readFileSync, writeFileSync } from "fs";
import { execSync } from "child_process";
dotenv.config();

import express from "express";
import { createServer } from "http";
import { WebSocketServer } from "ws";
import { getDb, createSession, getSession, addMessage, addCost, getTotalCost } from "./db.js";
import { handleWashmenWs } from "./server/ws-handler-washmen.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const app = express();
const server = createServer(app);
const wss = new WebSocketServer({ server, path: "/ws" });

app.use(express.json());

// Serve new Lovable-style UI as default
app.get("/", (_req, res) => res.sendFile(join(__dirname, "public", "index-v2.html")));
// Keep old UI accessible
app.get("/v1", (_req, res) => res.sendFile(join(__dirname, "public", "washmen.html")));
app.use(express.static(join(__dirname, "public")));

// Session mappings
const sessionIds = new Map();
{
  const db = getDb();
  const rows = db.prepare("SELECT id, claude_session_id FROM sessions WHERE claude_session_id IS NOT NULL").all();
  for (const row of rows) {
    sessionIds.set(row.id, row.claude_session_id);
  }
  console.log(`Restored ${sessionIds.size} session mappings from DB`);
}

// Health endpoint for vibe-ui itself
app.get("/api/health", (_req, res) => res.json({ status: "ok", service: "vibe-ui", port: 4000 }));

// Service health check endpoint — checks all 3 services
app.get("/api/service-health", async (_req, res) => {
  const services = [
    { name: "frontend", url: "http://localhost:3000", port: 3000 },
    { name: "api-gateway", url: "http://localhost:1337/health", port: 1337 },
    { name: "core-service", url: "http://localhost:2339/health", port: 2339 },
  ];

  const results = await Promise.all(
    services.map(async (svc) => {
      try {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 3000);
        const resp = await fetch(svc.url, { signal: controller.signal });
        clearTimeout(timeout);
        return { name: svc.name, status: resp.ok ? "healthy" : "unhealthy", port: svc.port };
      } catch {
        return { name: svc.name, status: "unhealthy", port: svc.port };
      }
    })
  );
  res.json({ services: results });
});

// Cost tracking endpoint
app.get("/api/cost", (_req, res) => {
  const totalCost = getTotalCost();
  const dailyBudget = 20;
  res.json({ totalCost, dailyBudget, remaining: Math.max(0, dailyBudget - totalCost), budgetExceeded: totalCost >= dailyBudget });
});

// Prompts endpoint — serves PROMPTS.md content
app.get("/api/prompts", (_req, res) => {
  try {
    const promptsPath = join(__dirname, "..", "PROMPTS.md");
    const content = readFileSync(promptsPath, "utf8");
    // Parse prompt starters from markdown
    const starters = [];
    const lines = content.split("\n");
    let currentTitle = "";
    for (const line of lines) {
      if (line.startsWith("## ")) {
        currentTitle = line.replace("## ", "").trim();
      } else if (line.startsWith("> ")) {
        starters.push({ title: currentTitle, prompt: line.replace("> ", "").trim() });
      }
    }
    res.json({ starters });
  } catch {
    res.json({ starters: [] });
  }
});

// Sessions API
app.get("/api/sessions", (_req, res) => {
  try {
    const db = getDb();
    const sessions = db.prepare("SELECT * FROM sessions ORDER BY last_used_at DESC LIMIT 50").all();
    res.json(sessions);
  } catch (err) {
    console.error("Sessions API error:", err.message);
    res.json([]);
  }
});

app.get("/api/sessions/:id/messages", (req, res) => {
  const db = getDb();
  const messages = db.prepare("SELECT * FROM messages WHERE session_id = ? ORDER BY created_at ASC").all(req.params.id);
  res.json(messages);
});

// File read API — for Code tab
app.get("/api/file", (req, res) => {
  try {
    const filePath = req.query.path;
    if (!filePath) return res.status(400).json({ error: "Missing path" });
    const workspaceDir = process.env.WORKSPACE_DIR || "/workspaces/washmen-mvp-workspace";
    const fullPath = filePath.startsWith("/") ? filePath : join(workspaceDir, filePath);
    const content = readFileSync(fullPath, "utf8");
    res.json({ path: filePath, content });
  } catch (err) {
    res.status(404).json({ error: err.message });
  }
});

// Project files API — list key files across repos
app.get("/api/files", (_req, res) => {
  const workspaceDir = process.env.WORKSPACE_DIR || "/workspaces/washmen-mvp-workspace";
  const files = [];
  const repos = [
    { name: "mock-ops-frontend", icon: "FE", key: ["src/App.tsx", "src/api/client.ts", "src/api/UserAPI.ts", "src/features/users/components/UsersList.tsx", "src/features/dashboard/components/Dashboard.tsx", "vite.config.ts"] },
    { name: "mock-api-gateway", icon: "GW", key: ["config/routes.js", "config/bootstrap.js", "api/controllers/UserController.js", "api/controllers/AuthController.js", "api/policies/isAuthenticated.js", "api/dtos/index.js"] },
    { name: "mock-core-service", icon: "Core", key: ["config/routes.js", "config/bootstrap.js", "api/models/User.js", "api/models/Order.js", "api/controllers/UserController.js", "api/dtos/index.js"] },
  ];
  for (const repo of repos) {
    for (const f of repo.key) {
      try {
        const full = join(workspaceDir, repo.name, f);
        readFileSync(full); // just check existence
        files.push({ path: `${repo.name}/${f}`, repo: repo.name, icon: repo.icon, name: f });
      } catch {}
    }
  }
  res.json({ files });
});

// Console output — read last lines from service logs
app.get("/api/console", (_req, res) => {
  const entries = [];
  const workspaceDir = process.env.WORKSPACE_DIR || "/workspaces/washmen-mvp-workspace";
  try {
    for (const [name, logFile] of [["frontend", "fe.log"], ["gateway", "gw.log"], ["core", "core.log"]]) {
      try {
        const log = readFileSync(`/tmp/${logFile}`, "utf8");
        const lines = log.split("\n").filter(Boolean).slice(-20);
        for (const line of lines) {
          const lower = line.toLowerCase();
          if (lower.includes("error") || lower.includes("err ")) {
            entries.push({ level: "error", message: `[${name}] ${line.trim()}` });
          } else if (lower.includes("warn")) {
            entries.push({ level: "warn", message: `[${name}] ${line.trim()}` });
          }
        }
      } catch {}
    }
  } catch {}
  res.json({ entries: entries.slice(-50) });
});

// Branch check
app.get("/api/branch", (_req, res) => {
  try {
    const workspaceDir = process.env.WORKSPACE_DIR || "/workspaces/washmen-mvp-workspace";
    const branch = execSync(`git -C "${workspaceDir}/mock-ops-frontend" rev-parse --abbrev-ref HEAD`, { stdio: "pipe" }).toString().trim();
    res.json({ branch });
  } catch {
    res.json({ branch: "unknown" });
  }
});

// Notes API
app.get("/api/notes", (_req, res) => {
  try {
    const workspaceDir = process.env.WORKSPACE_DIR || "/workspaces/washmen-mvp-workspace";
    const content = readFileSync(join(workspaceDir, "MVP_NOTES.md"), "utf8");
    res.json({ content });
  } catch {
    res.json({ content: "" });
  }
});

app.post("/api/notes", (req, res) => {
  try {
    const workspaceDir = process.env.WORKSPACE_DIR || "/workspaces/washmen-mvp-workspace";
    writeFileSync(join(workspaceDir, "MVP_NOTES.md"), req.body.content || "");
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Checkpoints API
app.get("/api/checkpoints", (_req, res) => {
  try {
    const workspaceDir = process.env.WORKSPACE_DIR || "/workspaces/washmen-mvp-workspace";
    const tags = execSync(`git -C "${workspaceDir}/mock-ops-frontend" tag -l "checkpoint/*" --sort=-version:refname --format="%(refname:short)|%(creatordate:unix)|%(subject)"`, { stdio: "pipe" }).toString().trim();
    const checkpoints = tags.split("\n").filter(Boolean).map((line, i) => {
      const [name, ts, label] = line.split("|");
      return { id: name, label: label || name, timestamp: parseInt(ts), current: i === 0 };
    });
    res.json({ checkpoints });
  } catch {
    res.json({ checkpoints: [] });
  }
});

// Restart service
app.post("/api/restart-service", (req, res) => {
  try {
    const workspaceDir = process.env.WORKSPACE_DIR || "/workspaces/washmen-mvp-workspace";
    const svc = req.body.service;
    if (svc === "frontend") {
      execSync(`cd "${workspaceDir}/mock-ops-frontend" && npx vite --host &`, { stdio: "pipe", timeout: 5000 });
    } else if (svc === "api-gateway") {
      execSync(`cd "${workspaceDir}/mock-api-gateway" && node app.js &`, { stdio: "pipe", timeout: 5000 });
    } else if (svc === "core-service") {
      execSync(`cd "${workspaceDir}/mock-core-service" && node app.js &`, { stdio: "pipe", timeout: 5000 });
    }
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// WebSocket handling
wss.on("connection", (ws) => {
  handleWashmenWs(ws, sessionIds);
});

const PORT = process.env.PORT || 4000;
server.listen(PORT, () => {
  console.log(`vibe-ui running on http://localhost:${PORT}`);
});
