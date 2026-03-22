import dotenv from "dotenv";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { readFileSync } from "fs";
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

// Serve washmen.html as the default page
app.get("/", (_req, res) => res.sendFile(join(__dirname, "public", "washmen.html")));
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
  const db = getDb();
  const sessions = db.prepare("SELECT * FROM sessions ORDER BY updated_at DESC LIMIT 50").all();
  res.json(sessions);
});

app.get("/api/sessions/:id/messages", (req, res) => {
  const db = getDb();
  const messages = db.prepare("SELECT * FROM messages WHERE session_id = ? ORDER BY created_at ASC").all(req.params.id);
  res.json(messages);
});

// WebSocket handling
wss.on("connection", (ws) => {
  handleWashmenWs(ws, sessionIds);
});

const PORT = process.env.PORT || 4000;
server.listen(PORT, () => {
  console.log(`vibe-ui running on http://localhost:${PORT}`);
});
