import dotenv from "dotenv";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { readFileSync, readdirSync, existsSync } from "fs";
import { execSync } from "child_process";
import { randomUUID } from "crypto";
dotenv.config();

const AUTH_TOKEN = process.env.VIBE_AUTH_TOKEN || randomUUID();

import express from "express";
import rateLimit from "express-rate-limit";
import { createServer } from "http";
import { WebSocketServer } from "ws";
import { getAllSessionMappings } from "./db.js";
import { handleWashmenWs, getSessionChangedFiles } from "./server/ws-handler-washmen.js";
import { getWorkspaceDir, getServicesConfig } from "./server/workspace-config.js";
import { PresenceManager } from "./server/presence.js";

// Route modules
import workspaceRoutes from "./server/routes/workspace.js";
import branchRoutes from "./server/routes/branches.js";
import sessionRoutes from "./server/routes/sessions.js";
import fileRoutes from "./server/routes/files.js";
import promptRoutes from "./server/routes/prompts.js";
import noteRoutes from "./server/routes/notes.js";
import serviceRoutes from "./server/routes/services.js";
import consoleRoutes from "./server/routes/console.js";
import inspectRoutes from "./server/routes/inspect.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

/** Parse a single cookie value from a raw Cookie header string. */
function parseCookie(cookieHeader, name) {
  if (!cookieHeader) return null;
  const match = cookieHeader.match(new RegExp(`(?:^|;\\s*)${name}=([^;]*)`));
  return match ? decodeURIComponent(match[1]) : null;
}

const app = express();
app.set("trust proxy", 1); // Trust first proxy (Codespaces, reverse proxies)
const server = createServer(app);
const wss = new WebSocketServer({ server, path: "/ws" });

app.use(express.json({ limit: "10mb" }));

// Serve UI with httpOnly auth cookie
app.get("/", (_req, res) => {
  const isProduction = process.env.NODE_ENV === "production" || process.env.CODESPACES === "true";
  res.cookie("__vibe_auth", AUTH_TOKEN, {
    httpOnly: true,
    secure: isProduction,
    sameSite: "strict",
    path: "/",
  });
  res.sendFile(join(__dirname, "public", "index-v2.html"));
});
app.get("/v1", (_req, res) => res.redirect("/"));
app.use(express.static(join(__dirname, "public"), { etag: false, maxAge: 0 }));

// Rate limiting — 100 requests per 15 minutes per IP
const apiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 100,
  standardHeaders: true,
  legacyHeaders: false,
});
app.use("/api", apiLimiter);

// Auth middleware — reads token from httpOnly cookie
function requireAuth(req, res, next) {
  const token = parseCookie(req.headers.cookie, "__vibe_auth");
  if (token !== AUTH_TOKEN) return res.status(401).json({ error: "Unauthorized" });
  next();
}
app.use("/api", requireAuth);

// Session mappings (restored from DB at startup)
const sessionIds = new Map();
{
  const rows = getAllSessionMappings();
  for (const row of rows) {
    sessionIds.set(row.id, row.claude_session_id);
  }
  console.log(`Restored ${sessionIds.size} session mappings from DB`);
}

// Broadcast to all connected WebSocket clients
function wsBroadcast(data) {
  const msg = JSON.stringify(data);
  wss.clients.forEach(c => { if (c.readyState === 1) c.send(msg); });
}

// Multi-user presence
const presence = new PresenceManager();
presence.setBroadcast(wsBroadcast);

// Workspace auto-discovery helpers (shared by workspace + branches routers)
function discoverRepos() {
  const workspaceDir = getWorkspaceDir();
  const exclude = ["vibe-ui", "core", "node_modules", ".git", ".devcontainer", ".claude", ".github", "docs", "tmp"];
  const repos = [];
  try {
    const entries = readdirSync(workspaceDir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory() || exclude.includes(entry.name) || entry.name.startsWith(".")) continue;
      const repoPath = join(workspaceDir, entry.name);
      if (!existsSync(join(repoPath, ".git"))) continue;

      const repo = { name: entry.name, path: repoPath };
      if (existsSync(join(repoPath, "yarn.lock"))) repo.packageManager = "yarn";
      else if (existsSync(join(repoPath, "pnpm-lock.yaml"))) repo.packageManager = "pnpm";
      else repo.packageManager = "npm";

      repo.hasPackageJson = existsSync(join(repoPath, "package.json"));

      if (repo.hasPackageJson) {
        try {
          const pkg = JSON.parse(readFileSync(join(repoPath, "package.json"), "utf8"));
          if (pkg.scripts?.start) {
            repo.startCommand = repo.packageManager === "yarn" ? "yarn start" : "npm start";
          } else if (pkg.scripts?.dev) {
            repo.startCommand = repo.packageManager === "yarn" ? "yarn dev" : "npm run dev";
          }
          const startScript = pkg.scripts?.start || pkg.scripts?.dev || "";
          const portMatch = startScript.match(/--port[= ](\d+)|PORT=(\d+)|-p (\d+)/);
          if (portMatch) repo.port = parseInt(portMatch[1] || portMatch[2] || portMatch[3]);
        } catch {}
      }
      if (!repo.startCommand) {
        if (existsSync(join(repoPath, "app.js"))) repo.startCommand = "node app.js";
        else if (existsSync(join(repoPath, "server.js"))) repo.startCommand = "node server.js";
      }

      try {
        repo.branch = execSync(`git -C "${repoPath}" rev-parse --abbrev-ref HEAD`, { stdio: "pipe" }).toString().trim();
      } catch { repo.branch = "unknown"; }

      repos.push(repo);
    }
  } catch {}
  return repos;
}

function detectDefaultBranch(repos) {
  for (const repo of repos) {
    try {
      const ref = execSync(`git -C "${repo.path}" symbolic-ref refs/remotes/origin/HEAD 2>/dev/null`, { stdio: "pipe" }).toString().trim();
      const branch = ref.replace("refs/remotes/origin/", "");
      if (branch) return branch;
    } catch {}
  }
  return "main";
}

// Service health config
const configuredServices = process.env.SERVICES
  ? process.env.SERVICES.split(",").map(s => {
      const [name, port, healthPath] = s.trim().split(":");
      const p = parseInt(port, 10);
      const path = healthPath || "/health";
      return { name: name.trim(), url: `http://localhost:${p}${path}`, port: p };
    })
  : getServicesConfig();

// Shared dependencies for route factories
const deps = { presence, discoverRepos, detectDefaultBranch, configuredServices, wsBroadcast, getSessionChangedFiles };

// Mount routers
app.use("/api", workspaceRoutes(deps));
app.use("/api", branchRoutes(deps));
app.use("/api", sessionRoutes(deps));
app.use("/api", fileRoutes());
app.use("/api", promptRoutes());
app.use("/api", noteRoutes());
app.use("/api", serviceRoutes(deps));
app.use("/api", consoleRoutes(deps));
app.use("/api", inspectRoutes());

// WebSocket handling (with cookie auth)
wss.on("connection", (ws, req) => {
  const token = parseCookie(req.headers.cookie, "__vibe_auth");
  if (token !== AUTH_TOKEN) {
    ws.close(4001, "Unauthorized");
    return;
  }

  ws.__id = randomUUID();

  ws.on("close", () => {
    presence.removeUser(ws.__id);
  });

  function broadcastToBranch(senderWsId, branch, data) {
    if (!branch) return;
    const msg = JSON.stringify(data);
    const presenceUsers = presence.getPresence().users;
    const branchUserIds = new Set(presenceUsers.filter(u => u.branch === branch).map(u => u.id));
    wss.clients.forEach(c => {
      if (c.readyState === 1 && c.__id !== senderWsId && branchUserIds.has(c.__id)) {
        c.send(msg);
      }
    });
  }

  handleWashmenWs(ws, sessionIds, presence, broadcastToBranch);
});

const PORT = process.env.PORT || 4000;
server.listen(PORT, () => {
  console.log(`vibe-ui running on http://localhost:${PORT}`);
});
