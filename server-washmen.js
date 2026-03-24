import dotenv from "dotenv";
import { join, dirname, resolve, sep } from "path";
import { fileURLToPath } from "url";
import { readFileSync, writeFileSync, readdirSync, existsSync, statSync, mkdirSync } from "fs";
import { execSync, spawn } from "child_process";
import { createHash, randomUUID } from "crypto";
dotenv.config();

const AUTH_TOKEN = process.env.VIBE_AUTH_TOKEN || randomUUID();
console.log(`[auth] Token: ${AUTH_TOKEN}`);

import express from "express";
import { createServer } from "http";
import { WebSocketServer } from "ws";
import { getDb, createSession, getSession, addMessage, addCost, getTotalCost, getSessionByBranch, getNotes, saveNotes, getBranchCosts } from "./db.js";
import { handleWashmenWs } from "./server/ws-handler-washmen.js";
import { loadWorkspaceConfig, getWorkspaceDir, getConfig, getFrontendRepo, getFrontendPort, getServicesConfig, getRepoNames, getClientConfig } from "./server/workspace-config.js";
import { sanitizeBranchName, sanitizePort, validateDevCommand } from "./server/sanitize.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const app = express();
const server = createServer(app);
const wss = new WebSocketServer({ server, path: "/ws" });

app.use(express.json({ limit: "10mb" }));

// Serve new Lovable-style UI as default (with embedded auth token)
app.get("/", (_req, res) => {
  let html = readFileSync(join(__dirname, "public", "index-v2.html"), "utf8");
  html = html.replace("</head>", `<script>window.__VIBE_TOKEN="${AUTH_TOKEN}";(function(){const _f=window.fetch;window.fetch=function(u,o){o=o||{};o.headers=new Headers(o.headers||{});o.headers.set("X-Vibe-Token",window.__VIBE_TOKEN);return _f.call(this,u,o);}})();</script></head>`);
  res.send(html);
});
// Legacy UI — redirect to v2
app.get("/v1", (_req, res) => res.redirect("/"));
app.use(express.static(join(__dirname, "public"), { etag: false, maxAge: 0 }));

// Auth middleware for all /api/* routes
function requireAuth(req, res, next) {
  const token = req.headers["x-vibe-token"] || req.query.token;
  if (token !== AUTH_TOKEN) return res.status(401).json({ error: "Unauthorized" });
  next();
}
app.use("/api", requireAuth);

// Serve workspace config to browser
app.get("/api/workspace-config", (_req, res) => res.json(getClientConfig()));

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

// Service health — reads from workspace.json, falls back to SERVICES env var
const configuredServices = process.env.SERVICES
  ? process.env.SERVICES.split(",").map(s => {
      const [name, port, healthPath] = s.trim().split(":");
      const p = parseInt(port, 10);
      const path = healthPath || "/health";
      return { name: name.trim(), url: `http://localhost:${p}${path}`, port: p };
    })
  : getServicesConfig();

app.get("/api/service-health", async (_req, res) => {
  const services = configuredServices;

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
  const dailyBudget = 30;
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

// ── Workspace auto-discovery ──
function discoverRepos() {
  const workspaceDir = getWorkspaceDir();
  const exclude = ["vibe-ui", "node_modules", ".git", ".devcontainer", ".claude", ".github"];
  const repos = [];
  try {
    const entries = readdirSync(workspaceDir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory() || exclude.includes(entry.name) || entry.name.startsWith(".")) continue;
      const repoPath = join(workspaceDir, entry.name);
      if (!existsSync(join(repoPath, ".git"))) continue;

      const repo = { name: entry.name, path: repoPath };
      // Detect package manager
      if (existsSync(join(repoPath, "yarn.lock"))) repo.packageManager = "yarn";
      else if (existsSync(join(repoPath, "pnpm-lock.yaml"))) repo.packageManager = "pnpm";
      else repo.packageManager = "npm";

      // Detect package.json
      repo.hasPackageJson = existsSync(join(repoPath, "package.json"));

      // Detect start command
      if (repo.hasPackageJson) {
        try {
          const pkg = JSON.parse(readFileSync(join(repoPath, "package.json"), "utf8"));
          if (pkg.scripts?.start) {
            repo.startCommand = repo.packageManager === "yarn" ? "yarn start" : "npm start";
          } else if (pkg.scripts?.dev) {
            repo.startCommand = repo.packageManager === "yarn" ? "yarn dev" : "npm run dev";
          }
          // Try to detect port from scripts
          const startScript = pkg.scripts?.start || pkg.scripts?.dev || "";
          const portMatch = startScript.match(/--port[= ](\d+)|PORT=(\d+)|-p (\d+)/);
          if (portMatch) repo.port = parseInt(portMatch[1] || portMatch[2] || portMatch[3]);
        } catch {}
      }
      if (!repo.startCommand) {
        if (existsSync(join(repoPath, "app.js"))) repo.startCommand = "node app.js";
        else if (existsSync(join(repoPath, "server.js"))) repo.startCommand = "node server.js";
      }

      // Current branch
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

app.get("/api/workspace", (_req, res) => {
  try {
    const repos = discoverRepos();
    const defaultBranch = detectDefaultBranch(repos);
    const workspaceDir = getWorkspaceDir();

    // Detect currently active branch from .active-branch file or git HEAD
    let activeBranch = null;
    try {
      activeBranch = readFileSync(join(workspaceDir, ".active-branch"), "utf-8").trim();
    } catch (e) { console.warn("[workspace] .active-branch read failed:", e.message); }
    if (!activeBranch && repos.length > 0) {
      try {
        activeBranch = execSync(`git -C "${repos[0].path}" rev-parse --abbrev-ref HEAD`, { stdio: "pipe" }).toString().trim();
      } catch (e) { console.warn("[workspace] git HEAD detection failed:", e.message); }
    }

    // List mvp/* branches from first repo (local + remote)
    const branches = [];
    const seenBranches = new Set();
    // Build cost-per-branch lookup
    const branchCostMap = {};
    try {
      for (const row of getBranchCosts()) {
        branchCostMap[row.branch] = row.total_cost;
      }
    } catch {}

    if (repos.length > 0) {
      const repoPath = repos[0].path;
      // Fetch latest remote refs
      try { execSync(`git -C "${repoPath}" fetch origin --prune 2>/dev/null`, { stdio: "pipe", timeout: 10000 }); } catch (e) { console.warn("[workspace] git fetch prune failed:", e.message); }

      // Local branches
      try {
        const branchList = execSync(
          `git -C "${repoPath}" branch --list "mvp/*" --format="%(refname:short)|%(committerdate:unix)"`,
          { stdio: "pipe" }
        ).toString().trim();
        for (const line of branchList.split("\n").filter(Boolean)) {
          const [name, ts] = line.split("|");
          seenBranches.add(name);
          const session = getSessionByBranch(name);
          const msgCount = session ? getDb().prepare("SELECT COUNT(*) as c FROM messages WHERE session_id = ?").get(session.id)?.c || 0 : 0;
          let commitCount = 0, lastCommitMsg = '', filesChanged = 0;
          try {
            commitCount = parseInt(execSync(
              `git -C "${repoPath}" rev-list --count ${sanitizeBranchName(defaultBranch)}..${sanitizeBranchName(name)}`,
              { stdio: "pipe" }
            ).toString().trim()) || 0;
          } catch {}
          try {
            lastCommitMsg = execSync(
              `git -C "${repoPath}" log -1 --pretty=%s ${sanitizeBranchName(name)}`,
              { stdio: "pipe" }
            ).toString().trim().slice(0, 100);
          } catch {}
          try {
            filesChanged = execSync(
              `git -C "${repoPath}" diff --name-only ${sanitizeBranchName(defaultBranch)}..${sanitizeBranchName(name)}`,
              { stdio: "pipe" }
            ).toString().trim().split("\n").filter(Boolean).length;
          } catch {}
          branches.push({
            name,
            local: true,
            lastActivity: ts ? new Date(parseInt(ts) * 1000).toISOString() : null,
            session: session ? { id: session.id, messageCount: msgCount, lastUsedAt: session.last_used_at, title: session.title || session.project_name || null } : null,
            commitCount,
            lastCommitMsg,
            filesChanged,
            cost: branchCostMap[name] || 0,
          });
        }
      } catch (e) { console.warn("[workspace] local branch listing failed:", e.message); }

      // Remote-only branches (not yet checked out locally)
      try {
        const remoteBranches = execSync(
          `git -C "${repoPath}" branch -r --list "origin/mvp/*" --format="%(refname:short)|%(committerdate:unix)"`,
          { stdio: "pipe" }
        ).toString().trim();
        for (const line of remoteBranches.split("\n").filter(Boolean)) {
          const [ref, ts] = line.split("|");
          const name = ref.replace("origin/", "");
          if (seenBranches.has(name)) continue;
          seenBranches.add(name);
          branches.push({
            name,
            local: false,
            lastActivity: ts ? new Date(parseInt(ts) * 1000).toISOString() : null,
            session: null,
          });
        }
      } catch (e) { console.warn("[workspace] remote branch listing failed:", e.message); }
    }
    // Sort by most recent activity — prefer session lastUsedAt, fall back to git committerdate
    branches.sort((a, b) => {
      const aTime = a.session?.lastUsedAt || (a.lastActivity ? new Date(a.lastActivity).getTime() / 1000 : 0);
      const bTime = b.session?.lastUsedAt || (b.lastActivity ? new Date(b.lastActivity).getTime() / 1000 : 0);
      return bTime - aTime;
    });

    const totalCost = getTotalCost();
    res.json({
      defaultBranch,
      activeBranch,
      repos,
      branches,
      budget: { spent: totalCost, limit: 30, remaining: Math.max(0, 30 - totalCost) },
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Branch switching ──
app.post("/api/switch-branch", async (req, res) => {
  const { branch } = req.body;
  if (!branch) return res.status(400).json({ error: "Missing branch" });
  try { sanitizeBranchName(branch); } catch (e) { return res.status(400).json({ error: e.message }); }

  const workspaceDir = getWorkspaceDir();
  const configRepos = getConfig().repos;

  // Check if already on this branch — skip the entire switch cycle
  let alreadyOnBranch = true;
  for (const cfgRepo of configRepos) {
    try {
      const current = execSync(`git -C "${join(workspaceDir, cfgRepo.name)}" rev-parse --abbrev-ref HEAD`, { stdio: "pipe" }).toString().trim();
      if (current !== branch) { alreadyOnBranch = false; break; }
    } catch { alreadyOnBranch = false; break; }
  }

  if (alreadyOnBranch) {
    // Save active branch (in case .active-branch was missing)
    try { writeFileSync(join(workspaceDir, ".active-branch"), branch); } catch {}
    return res.json({ ok: true, branch, switched: [], installed: [], restarted: [], skipped: true });
  }

  const switched = [];
  const installed = [];
  const restarted = [];

  // Build step list for progress tracking
  const steps = [];
  for (const cfgRepo of configRepos) {
    steps.push({ id: `checkout-${cfgRepo.name}`, label: `Switching ${cfgRepo.name}` });
    steps.push({ id: `deps-${cfgRepo.name}`, label: `Checking dependencies` });
    if (cfgRepo.port && cfgRepo.dev) {
      steps.push({ id: `restart-${cfgRepo.name}`, label: `Restarting ${cfgRepo.name}` });
    }
  }
  steps.push({ id: 'services-ready', label: 'Waiting for services' });

  wsBroadcast({ type: 'switch_progress', phase: 'start', branch, steps });

  for (const cfgRepo of configRepos) {
    const repoPath = join(workspaceDir, cfgRepo.name);
    try {
      // Try checkout — branch may not exist in all repos
      wsBroadcast({ type: 'switch_progress', phase: 'step', stepId: `checkout-${cfgRepo.name}`, status: 'active' });
      try {
        execSync(`git -C "${repoPath}" checkout "${branch}"`, { stdio: "pipe" });
        switched.push(cfgRepo.name);
      } catch {
        // Branch doesn't exist in this repo — try fetching it, else stay on current branch
        try {
          execSync(`git -C "${repoPath}" fetch origin "${branch}" 2>/dev/null && git -C "${repoPath}" checkout "${branch}"`, { stdio: "pipe" });
          switched.push(cfgRepo.name);
        } catch {
          console.log(`[switch] ${cfgRepo.name}: branch ${branch} not found, staying on current`);
        }
      }
      wsBroadcast({ type: 'switch_progress', phase: 'step', stepId: `checkout-${cfgRepo.name}`, status: 'done' });

      // Check if lockfile changed → reinstall
      wsBroadcast({ type: 'switch_progress', phase: 'step', stepId: `deps-${cfgRepo.name}`, status: 'active' });
      if (switched.includes(cfgRepo.name)) {
        const lockfile = existsSync(join(repoPath, "yarn.lock")) ? "yarn.lock" : "package-lock.json";
        try {
          const changed = execSync(`git -C "${repoPath}" diff HEAD~1 --name-only 2>/dev/null`, { stdio: "pipe" }).toString();
          if (changed.includes(lockfile)) {
            const installCmd = existsSync(join(repoPath, "yarn.lock")) ? "yarn install" : "npm install";
            execSync(`cd "${repoPath}" && ${installCmd}`, { stdio: "pipe", timeout: 120000 });
            installed.push(cfgRepo.name);
          }
        } catch {}
      }
      wsBroadcast({ type: 'switch_progress', phase: 'step', stepId: `deps-${cfgRepo.name}`, status: 'done' });

      // Restart service using workspace.json dev command
      if (cfgRepo.port && cfgRepo.dev) {
        const safePort = sanitizePort(cfgRepo.port);
        if (!validateDevCommand(cfgRepo.dev)) {
          console.warn(`[switch] Blocked unsafe dev command for ${cfgRepo.name}: ${cfgRepo.dev}`);
        } else {
        wsBroadcast({ type: 'switch_progress', phase: 'step', stepId: `restart-${cfgRepo.name}`, status: 'active' });
        try { execSync(`kill $(lsof -ti:${safePort} -sTCP:LISTEN) 2>/dev/null`, { stdio: "pipe" }); } catch {}
        const logFile = `/tmp/${cfgRepo.name}.log`;
        try { writeFileSync(logFile, ""); } catch {} // Truncate on restart
        const child = spawn("bash", ["-c", `cd "${repoPath}" && ${cfgRepo.dev} >> ${logFile} 2>&1`], { detached: true, stdio: "ignore" });
        child.unref();
        child.on("error", (err) => {
          console.error(`[spawn] ${cfgRepo.name} failed:`, err.message);
          wsBroadcast({ type: "system", text: `Failed to start ${cfgRepo.name}: ${err.message}` });
        });
        restarted.push(cfgRepo.name);
        wsBroadcast({ type: 'switch_progress', phase: 'step', stepId: `restart-${cfgRepo.name}`, status: 'done' });
        }
      }
    } catch (err) {
      console.error(`[switch] Failed for ${cfgRepo.name}:`, err.message);
    }
  }

  // Save active branch for codespace restarts
  try {
    writeFileSync(join(workspaceDir, ".active-branch"), branch);
  } catch {}

  // Poll for services to be healthy instead of hardcoded wait
  wsBroadcast({ type: 'switch_progress', phase: 'step', stepId: 'services-ready', status: 'active' });
  const maxWait = 30000, pollInterval = 1000;
  const startTime = Date.now();
  while (Date.now() - startTime < maxWait) {
    await new Promise(r => setTimeout(r, pollInterval));
    const allHealthy = await Promise.all(
      configuredServices.map(async (svc) => {
        try {
          const controller = new AbortController();
          const timeout = setTimeout(() => controller.abort(), 2000);
          const resp = await fetch(svc.url, { signal: controller.signal });
          clearTimeout(timeout);
          return resp.ok;
        } catch { return false; }
      })
    );
    if (allHealthy.every(Boolean)) break;
  }
  wsBroadcast({ type: 'switch_progress', phase: 'step', stepId: 'services-ready', status: 'done' });
  wsBroadcast({ type: 'switch_progress', phase: 'complete', branch });

  res.json({ ok: true, branch, switched, installed, restarted });
});

// ── Branch creation ──
app.post("/api/create-branch", (req, res) => {
  const { name } = req.body;
  if (!name) return res.status(400).json({ error: "Missing name" });

  const slug = name.toLowerCase().replace(/[^a-z0-9\s]/g, "").trim().replace(/\s+/g, "-").slice(0, 50).replace(/-+$/, "");
  const branchName = `mvp/${slug || "feature-" + Date.now().toString(36)}`;
  try { sanitizeBranchName(branchName); } catch (e) { return res.status(400).json({ error: e.message }); }

  const repos = discoverRepos();
  const defaultBranch = detectDefaultBranch(repos);
  const created = [];

  for (const repo of repos) {
    try {
      // Ensure on default branch first
      try { execSync(`git -C "${repo.path}" checkout "${defaultBranch}"`, { stdio: "pipe" }); } catch {}
      try { execSync(`git -C "${repo.path}" pull origin "${defaultBranch}" 2>/dev/null`, { stdio: "pipe", timeout: 10000 }); } catch {}
      execSync(`git -C "${repo.path}" checkout -b "${branchName}"`, { stdio: "pipe" });
      created.push(repo.name);
    } catch (err) {
      // Branch might already exist
      try {
        execSync(`git -C "${repo.path}" checkout "${branchName}"`, { stdio: "pipe" });
        created.push(repo.name);
      } catch { console.error(`[create-branch] ${repo.name}:`, err.message); }
    }
  }

  // Save active branch
  try { writeFileSync(join(getWorkspaceDir(), ".active-branch"), branchName); } catch {}

  res.json({ ok: true, branch: branchName, repos: created });
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

// File read API — for Code tab (restricted to workspace)
app.get("/api/file", (req, res) => {
  try {
    const filePath = req.query.path;
    if (!filePath) return res.status(400).json({ error: "Missing path" });
    const workspaceDir = getWorkspaceDir();
    const resolved = resolve(workspaceDir, filePath);
    if (!resolved.startsWith(resolve(workspaceDir) + sep) && resolved !== resolve(workspaceDir)) {
      return res.status(403).json({ error: "Access denied: path outside workspace" });
    }
    const content = readFileSync(resolved, "utf8");
    res.json({ path: filePath, content });
  } catch (err) {
    res.status(404).json({ error: err.message });
  }
});

// File upload API — saves to workspace /tmp/uploads/ for agent to read
app.post("/api/upload", (req, res) => {
  try {
    const { filename, data, mediaType } = req.body;
    if (!data) return res.status(400).json({ error: "Missing data" });

    const uploadDir = join(getWorkspaceDir(), "tmp", "uploads");
    mkdirSync(uploadDir, { recursive: true });

    const ext = filename ? filename.split(".").pop() : (mediaType || "").split("/").pop() || "png";
    const name = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}.${ext}`;
    const filePath = join(uploadDir, name);

    // data is base64
    writeFileSync(filePath, Buffer.from(data, "base64"));
    console.log(`[upload] Saved ${filePath} (${Math.round(Buffer.from(data, "base64").length / 1024)}KB)`);

    res.json({ path: filePath, name });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Project files API — dynamically discover files from workspace repos
app.get("/api/files", (_req, res) => {
  const workspaceDir = getWorkspaceDir();
  const files = [];
  const ignore = ["node_modules", ".git", ".yarn", "dist", "build", ".cache", ".tmp", "coverage", "vibe-ui"];
  const extensions = [".js", ".ts", ".tsx", ".jsx", ".json", ".css", ".scss", ".md"];
  const maxDepth = 4;
  const maxFilesPerRepo = 50;

  // Find all repo directories (top-level dirs that have a package.json or .git)
  try {
    const entries = readdirSync(workspaceDir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory() || ignore.includes(entry.name) || entry.name.startsWith(".")) continue;
      const repoPath = join(workspaceDir, entry.name);
      // Check if it's a project (has package.json or .git)
      try {
        const hasPackageJson = existsSync(join(repoPath, "package.json"));
        const hasGit = existsSync(join(repoPath, ".git"));
        if (!hasPackageJson && !hasGit) continue;
      } catch { continue; }

      // Walk the repo to find source files
      const repoFiles = [];
      function walk(dir, depth) {
        if (depth > maxDepth || repoFiles.length >= maxFilesPerRepo) return;
        try {
          const items = readdirSync(dir, { withFileTypes: true });
          for (const item of items) {
            if (ignore.includes(item.name) || item.name.startsWith(".")) continue;
            const fullPath = join(dir, item.name);
            if (item.isDirectory()) {
              walk(fullPath, depth + 1);
            } else if (extensions.some(ext => item.name.endsWith(ext))) {
              const relativePath = fullPath.replace(repoPath + "/", "");
              repoFiles.push({ path: `${entry.name}/${relativePath}`, repo: entry.name, name: relativePath });
            }
          }
        } catch {}
      }
      walk(repoPath, 0);

      // Sort: config files first, then src files
      repoFiles.sort((a, b) => {
        const aIsConfig = a.name.startsWith("config/") || a.name.includes("package.json") ? 0 : 1;
        const bIsConfig = b.name.startsWith("config/") || b.name.includes("package.json") ? 0 : 1;
        return aIsConfig - bIsConfig || a.name.localeCompare(b.name);
      });

      files.push(...repoFiles);
    }
  } catch {}
  res.json({ files });
});

// Console output — read last lines from service logs
// Track last read position per log file to only return new lines
const logPositions = {};

// Log sources — configured via LOG_SOURCES env: "name:file,name:file,..."
// e.g. LOG_SOURCES="frontend:fe.log,api:gw.log,vibe-ui:vibe.log"
// If not set, auto-discovers all *.log files in /tmp/ on each poll
const explicitLogSources = process.env.LOG_SOURCES
  ? process.env.LOG_SOURCES.split(",").map(s => { const [n, f] = s.split(":"); return [n.trim(), f.trim()]; })
  : null;

function getLogSources() {
  if (explicitLogSources) return explicitLogSources;
  try {
    return readdirSync("/tmp")
      .filter(f => f.endsWith(".log"))
      .map(f => [f.replace(/\.log$/, ""), f]);
  } catch { return []; }
}

// Browser console buffer — populated by a background Playwright listener
const browserConsoleBuffer = [];
let browserConsoleStarted = false;

async function startBrowserConsoleListener() {
  if (browserConsoleStarted) return;
  browserConsoleStarted = true;
  try {
    // Playwright is installed in the workspace root, not in vibe-ui
    let chromium;
    try { ({ chromium } = await import("playwright")); }
    catch {
      try { ({ chromium } = await import(`${getWorkspaceDir()}/vibe-ui/node_modules/playwright/index.mjs`)); }
      catch { ({ chromium } = await import(`${getWorkspaceDir()}/node_modules/playwright/index.mjs`)); }
    }
    const browser = await chromium.launch();
    const page = await browser.newPage();

    page.on("console", msg => {
      const type = msg.type();
      if (type === "error" || type === "warning" || type === "warn") {
        browserConsoleBuffer.push({
          level: type === "warning" || type === "warn" ? "warn" : "error",
          message: `[browser] ${msg.text()}`,
          ts: Date.now(),
        });
        // Keep buffer manageable
        if (browserConsoleBuffer.length > 100) browserConsoleBuffer.splice(0, 50);
      }
    });

    page.on("pageerror", err => {
      browserConsoleBuffer.push({
        level: "error",
        message: `[browser] Uncaught: ${err.message}`,
        ts: Date.now(),
      });
    });

    await page.goto(`http://localhost:${getFrontendPort()}`, { waitUntil: "domcontentloaded", timeout: 15000 }).catch(() => {});
    console.log("[console] Browser console listener started");

    // Periodically reload to catch new errors after HMR
    setInterval(async () => {
      try { await page.reload({ waitUntil: "domcontentloaded", timeout: 10000 }); } catch {}
    }, 30000);
  } catch (err) {
    console.error("[console] Failed to start browser listener:", err.message);
    browserConsoleStarted = false;
  }
}

// Start listener after services are likely up
setTimeout(() => {
  startBrowserConsoleListener().catch(e => console.error("[console] listener failed:", e.message));
}, 10000);

app.get("/api/console", (req, res) => {
  const entries = [];
  const reset = req.query.reset === "true";

  // Clean up logPositions for files that no longer exist
  for (const key of Object.keys(logPositions)) {
    if (!existsSync(`/tmp/${key}`)) delete logPositions[key];
  }

  for (const [name, logFile] of getLogSources()) {
    try {
      const path = `/tmp/${logFile}`;
      const log = readFileSync(path, "utf8");
      const allLines = log.split("\n").filter(Boolean);

      // Only return lines we haven't sent before
      const lastPos = reset ? 0 : (logPositions[logFile] || Math.max(0, allLines.length - 5)); // On first call show last 5 lines
      const newLines = allLines.slice(lastPos);
      logPositions[logFile] = allLines.length;

      for (const line of newLines) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.length < 3) continue;

        // Skip universal noise — pure decoration lines (dashes, equals, dots, ASCII art)
        if (trimmed.match(/^[\s\-=~_.·•|\\/<>,'`^]+$/)) continue;
        // Skip bare log-level labels with no content (e.g. "info:" or "debug:" alone)
        if (trimmed.match(/^\s*(info|debug|verbose|silly|trace|error|warn):\s*$/i)) continue;
        // Skip vibe-ui agent internal logs (tool calls, agent events) — not service errors
        if (trimmed.match(/^\[(tool|agent|session|push|context|checkpoint|console|workspace|code|inspect|screenshot|cost|db|switch|create-branch)\]/)) continue;

        const lower = trimmed.toLowerCase();

        // Classify severity — broad pattern matching
        let level = "info";
        if (lower.includes("error") || lower.includes("err:") || lower.includes("eaddrinuse") || lower.includes("enoent") ||
            lower.includes("eacces") || lower.includes("econnrefused") || lower.includes("uncaught") || lower.includes("unhandled") ||
            lower.includes("throw ") || lower.includes("fatal") || lower.includes("crash") || lower.includes("failed") ||
            lower.includes("typeerror") || lower.includes("referenceerror") || lower.includes("syntaxerror") || lower.includes("rangeerror") ||
            lower.includes("cannot read prop") || lower.includes("is not defined") || lower.includes("is not a function") ||
            lower.includes("module not found") || lower.includes("command failed") || lower.includes("exit code") ||
            (lower.includes("missing") && (lower.includes("env") || lower.includes("variable") || lower.includes("module") || lower.includes("package"))) ||
            (lower.includes("undefined") && (lower.includes("env") || lower.includes("variable") || lower.includes("config"))) ||
            lower.match(/^\s*at\s+/) || lower.startsWith("error")) {
          level = "error";
        } else if (lower.includes("warn") || lower.includes("deprecat") || lower.includes("experimental") ||
                   lower.includes("not recommended") || lower.includes("will be removed")) {
          level = "warn";
        }

        entries.push({ level, message: `[${name}] ${trimmed}` });
      }
    } catch {}
  }

  // Add browser console entries
  const browserEntries = browserConsoleBuffer.splice(0, browserConsoleBuffer.length);
  entries.push(...browserEntries);

  res.json({ entries });
});

// Branch check
app.get("/api/branch", (_req, res) => {
  try {
    const workspaceDir = getWorkspaceDir();
    const frontendRepo = getFrontendRepo();
    const branch = execSync(`git -C "${workspaceDir}/${frontendRepo.name}" rev-parse --abbrev-ref HEAD`, { stdio: "pipe" }).toString().trim();
    res.json({ branch });
  } catch {
    res.json({ branch: "unknown" });
  }
});

// Notes API — branch-scoped (stored in DB)
app.get("/api/notes", (req, res) => {
  const branch = req.query.branch;
  if (!branch) return res.json({ content: "" });
  const row = getNotes(branch);
  res.json({ content: row ? row.content : "" });
});

app.post("/api/notes", (req, res) => {
  const { branch, content } = req.body;
  if (!branch) return res.status(400).json({ error: "branch required" });
  saveNotes(branch, content || "");
  res.json({ ok: true });
});

// Inspect element at coordinates — for visual edit mode
// Cached Playwright browser for element inspection — avoids 10s startup per click
let inspectBrowser = null;
let inspectPage = null;
let inspectLastPath = null;

async function getInspectPage(targetPath) {
  if (!inspectBrowser) {
    let chromium;
    try { ({ chromium } = await import("playwright")); }
    catch {
      try { ({ chromium } = await import(`${getWorkspaceDir()}/vibe-ui/node_modules/playwright/index.mjs`)); }
      catch { ({ chromium } = await import(`${getWorkspaceDir()}/node_modules/playwright/index.mjs`)); }
    }
    inspectBrowser = await chromium.launch();
    inspectPage = await inspectBrowser.newPage({ viewport: { width: 1280, height: 720 } });
    // Login by actually clicking the Login button (sets Redux state + Axios headers properly)
    await inspectPage.goto(`http://localhost:${getFrontendPort()}`, { waitUntil: "networkidle", timeout: 15000 });
    await inspectPage.waitForTimeout(1000);
    try {
      // The login page has pre-filled email and a Login button
      const loginBtn = await inspectPage.$('button:has-text("Login"), button:has-text("LOGIN")');
      if (loginBtn) {
        await loginBtn.click();
        await inspectPage.waitForNavigation({ waitUntil: "networkidle", timeout: 10000 }).catch(() => {});
        await inspectPage.waitForTimeout(1500);
      }
    } catch (e) {
      console.log("[inspect] Login click failed, trying localStorage fallback");
      await inspectPage.evaluate(() => { localStorage.setItem("auth_token", "mock-jwt-token-usr-001"); });
      await inspectPage.reload({ waitUntil: "networkidle", timeout: 10000 });
      await inspectPage.waitForTimeout(1000);
    }
    console.log("[inspect] Browser cached, URL:", inspectPage.url());
    inspectLastPath = new URL(inspectPage.url()).pathname;
  }
  // Navigate if path changed
  if (targetPath && targetPath !== inspectLastPath) {
    await inspectPage.goto(`http://localhost:${getFrontendPort()}` + targetPath, { waitUntil: "networkidle", timeout: 10000 }).catch(() => {});
    await inspectPage.waitForTimeout(500);
    inspectLastPath = targetPath;
  }
  return inspectPage;
}

// Inject visual edit helper script into the frontend iframe (cross-origin workaround)
app.post("/api/inject-visual-helper", async (req, res) => {
  try {
    const page = await getInspectPage(null);
    await page.evaluate(() => {
      if (window.__veHelperActive) return;
      window.__veHelperActive = true;

      // Tag-to-friendly-name mapping
      const TAG_NAMES = {
        button:'Button',a:'Link',img:'Image',p:'Paragraph',input:'Input Field',
        textarea:'Text Area',select:'Dropdown',table:'Table',tr:'Table Row',
        td:'Table Cell',th:'Table Cell',ul:'List',ol:'List',li:'List Item',
        nav:'Navigation',header:'Header',footer:'Footer',form:'Form',label:'Label',
        span:'Text',div:'Section',svg:'Icon',h1:'Heading',h2:'Heading',h3:'Heading',
        h4:'Heading',h5:'Heading',h6:'Heading',section:'Section',main:'Main Content',
      };
      const MUI_NAMES = {
        MuiButton:'Button',MuiCard:'Card',MuiAppBar:'Top Navigation Bar',
        MuiDrawer:'Sidebar',MuiTable:'Table',MuiTextField:'Text Field',
        MuiSelect:'Dropdown',MuiChip:'Tag',MuiAvatar:'Avatar',MuiDialog:'Dialog',
        MuiPaper:'Panel',MuiList:'List',MuiIconButton:'Icon Button',MuiToolbar:'Toolbar',
        MuiTypography:'Text',MuiContainer:'Container',MuiGrid:'Grid Layout',
      };
      function getName(el) {
        const cls = el.className || '';
        for (const [k,v] of Object.entries(MUI_NAMES)) { if (cls.includes(k)) return v; }
        return TAG_NAMES[el.tagName?.toLowerCase()] || el.tagName?.toLowerCase() || 'Element';
      }

      let highlightEl = null;
      const style = document.createElement('style');
      style.textContent = '.ve-iframe-highlight { outline: 2px solid rgba(66,133,244,0.8) !important; background-color: rgba(66,133,244,0.08) !important; } .ve-iframe-selected { outline: 2px solid #33d17a !important; box-shadow: 0 0 0 3px rgba(51,209,122,0.2) !important; background-color: rgba(51,209,122,0.06) !important; }';
      document.head.appendChild(style);

      window.addEventListener('message', (e) => {
        const msg = e.data;
        if (!msg || !msg.type?.startsWith('ve-')) return;

        if (msg.type === 've-mousemove') {
          const el = document.elementFromPoint(msg.x, msg.y);
          if (highlightEl) highlightEl.classList.remove('ve-iframe-highlight');
          if (el && el !== document.body && el !== document.documentElement) {
            highlightEl = el;
            el.classList.add('ve-iframe-highlight');
            const r = el.getBoundingClientRect();
            window.parent.postMessage({
              source: 've-helper', type: 've-hover',
              rect: { left: r.left, top: r.top, width: r.width, height: r.height, bottom: r.bottom },
              name: getName(el),
              tag: el.tagName?.toLowerCase(),
              classes: el.className || '',
              text: (el.textContent || '').trim().slice(0, 80),
            }, '*');
          }
        } else if (msg.type === 've-click') {
          const el = document.elementFromPoint(msg.x, msg.y);
          if (highlightEl) highlightEl.classList.remove('ve-iframe-highlight');
          document.querySelectorAll('.ve-iframe-selected').forEach(e => e.classList.remove('ve-iframe-selected'));
          if (el && el !== document.body && el !== document.documentElement) {
            el.classList.add('ve-iframe-selected');
            const r = el.getBoundingClientRect();
            const cs = getComputedStyle(el);
            window.parent.postMessage({
              source: 've-helper', type: 've-click',
              rect: { left: r.left, top: r.top, width: r.width, height: r.height },
              name: getName(el),
              tag: el.tagName?.toLowerCase(),
              classes: el.className || '',
              text: (el.textContent || '').trim().slice(0, 80),
              styles: { color: cs.color, backgroundColor: cs.backgroundColor, fontSize: cs.fontSize, padding: cs.padding },
            }, '*');
          }
        } else if (msg.type === 've-deactivate') {
          if (highlightEl) highlightEl.classList.remove('ve-iframe-highlight');
          document.querySelectorAll('.ve-iframe-selected').forEach(e => e.classList.remove('ve-iframe-selected'));
          window.__veHelperActive = false;
        }
      });
    });
    res.json({ ok: true });
  } catch (e) {
    res.json({ ok: false, error: e.message });
  }
});

app.post("/api/inspect-element", async (req, res) => {
  const { x, y, pctX, pctY, currentUrl } = req.body;
  // Accept either absolute x,y or percentage pctX,pctY
  if (x == null && pctX == null) return res.status(400).json({ error: "Missing coordinates" });

  try {
    // Extract just the pathname from the URL bar value
    // URL bar may contain: "localhost:3000", "localhost:3000/users", "codespace-3000.app.github.dev", "/users", etc.
    let targetPath = "/";
    if (currentUrl) {
      try {
        const full = currentUrl.startsWith("http") ? currentUrl : "http://" + currentUrl;
        targetPath = new URL(full).pathname || "/";
      } catch {
        targetPath = currentUrl.startsWith("/") ? currentUrl : "/";
      }
    }
    console.log(`[inspect] targetPath="${targetPath}" from currentUrl="${currentUrl}"`);
    const page = await getInspectPage(targetPath);

    // Scale coordinates from preview iframe size to actual page size
    // The preview iframe might be a different size than 1280x720
    // Convert percentage to actual viewport pixels
    const viewportSize = page.viewportSize();
    const actualX = pctX != null ? Math.round(pctX * viewportSize.width) : x;
    const actualY = pctY != null ? Math.round(pctY * viewportSize.height) : y;
    console.log(`[inspect] coordinates: pct=(${pctX},${pctY}) actual=(${actualX},${actualY}) viewport=${viewportSize.width}x${viewportSize.height}`);
    // Debug: save what the inspect browser actually sees
    const { writeFileSync: wfs } = await import("fs");
    const debugScreenshot = await page.screenshot({ type: "png" });
    wfs("/tmp/inspect-debug.png", debugScreenshot);
    console.log("[inspect] debug screenshot saved to /tmp/inspect-debug.png");
    const debugUrl = page.url();
    console.log("[inspect] current URL:", debugUrl);

    const info = await page.evaluate(({ cx, cy }) => {
      // Sample the click point and surrounding area, find the best (most specific) element
      const points = [[cx, cy]];
      for (const [dx, dy] of [[0,20],[0,40],[0,-20],[20,0],[-20,0],[20,20],[-20,20],[0,60],[0,-40],[40,20],[-40,20],[0,80]]) {
        points.push([cx + dx, cy + dy]);
      }

      // Find all unique elements at these points
      const candidates = [];
      const seen = new Set();
      for (const [px, py] of points) {
        const e = document.elementFromPoint(px, py);
        if (!e || seen.has(e)) continue;
        seen.add(e);

        // Find the closest data-component ancestor
        let compEl = e;
        while (compEl && compEl !== document.body) {
          if (compEl.dataset && compEl.dataset.component) break;
          compEl = compEl.parentElement;
        }
        const comp = compEl?.dataset?.component || null;
        const area = e.offsetWidth * e.offsetHeight;
        candidates.push({ el: e, comp, area, compEl });
      }

      // Pick the best candidate: prefer smallest element with a data-component
      candidates.sort((a, b) => {
        // Prefer elements with data-component
        if (a.comp && !b.comp) return -1;
        if (!a.comp && b.comp) return 1;
        // Among those with component, prefer the smallest (most specific)
        return a.area - b.area;
      });

      const best = candidates[0];
      if (!best) return null;
      const el = best.comp ? best.compEl : best.el;
      if (!el) return null;

      // Component already found by the candidate selection above
      const comp = best.comp;
      const node = el;

      // Get element details
      const tag = el.tagName.toLowerCase();
      const classes = el.className ? String(el.className).split(" ").filter(Boolean).slice(0, 3).join(".") : "";
      const text = (el.textContent || "").trim().slice(0, 50);
      const id = el.id || "";
      const role = el.getAttribute("role") || "";
      const ariaLabel = el.getAttribute("aria-label") || "";

      // Get computed styles
      const style = window.getComputedStyle(el);
      const currentStyles = {
        color: style.color,
        backgroundColor: style.backgroundColor,
        fontSize: style.fontSize,
        padding: style.padding,
      };

      // Build a CSS selector path
      let selectorParts = [];
      let n = el;
      for (let i = 0; i < 3 && n && n !== document.body; i++) {
        let part = n.tagName.toLowerCase();
        if (n.id) part += "#" + n.id;
        else if (n.className && typeof n.className === "string") {
          const cls = n.className.trim().split(/\s+/).slice(0, 2).join(".");
          if (cls) part += "." + cls;
        }
        selectorParts.unshift(part);
        n = n.parentElement;
      }
      const selector = selectorParts.join(" > ");

      // Get parent component context
      let parentComp = null;
      if (node && node.parentElement) {
        let p = node.parentElement;
        while (p && p !== document.body) {
          if (p.dataset && p.dataset.component) {
            parentComp = p.dataset.component;
            break;
          }
          p = p.parentElement;
        }
      }

      return {
        tag, classes, text, id, role, ariaLabel,
        component: comp,
        parentComponent: parentComp,
        selector,
        currentStyles,
        outerHTML: el.outerHTML.slice(0, 200),
      };
    }, { cx: actualX, cy: actualY });

    // Take a screenshot
    const screenshot = await page.screenshot({ type: "png" });

    if (!info) return res.json({ found: false });

    // Build a human-readable description
    let description = "";
    if (info.component) {
      const [name, file, line] = info.component.split(":");
      description = `Component: ${name} in ${file}${line ? `:${line}` : ""}`;
    } else {
      description = `<${info.tag}${info.classes ? "." + info.classes : ""}>${info.text ? ' "' + info.text + '"' : ""}`;
    }

    res.json({
      found: true,
      description,
      element: info,
      screenshot: screenshot.toString("base64"),
    });
  } catch (err) {
    console.error("[inspect]", err.message);
    res.status(500).json({ error: err.message });
  }
});

// Restart service — looks up dev command from workspace.json
app.post("/api/restart-service", (req, res) => {
  try {
    const workspaceDir = getWorkspaceDir();
    const svcName = req.body.service;
    const repo = getConfig().repos.find(r => r.name === svcName);
    if (!repo || !repo.dev) return res.status(400).json({ error: `Unknown service: ${svcName}` });

    if (!validateDevCommand(repo.dev)) {
      return res.status(403).json({ error: `Blocked unsafe dev command: ${repo.dev}` });
    }
    // Kill existing process on the port, then start
    if (repo.port) {
      const safePort = sanitizePort(repo.port);
      try { execSync(`kill $(lsof -ti:${safePort} -sTCP:LISTEN) 2>/dev/null`, { stdio: "pipe" }); } catch {}
    }
    const logFile = `/tmp/${repo.name}.log`;
    try { writeFileSync(logFile, ""); } catch {} // Truncate on restart
    const child = spawn("bash", ["-c", `cd "${workspaceDir}/${repo.name}" && ${repo.dev} >> ${logFile} 2>&1`], { detached: true, stdio: "ignore" });
    child.unref();
    child.on("error", (err) => {
      console.error(`[spawn] ${repo.name} failed:`, err.message);
      wsBroadcast({ type: "system", text: `Failed to start ${repo.name}: ${err.message}` });
    });
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Stop service by killing process on port
app.post("/api/stop-service", (req, res) => {
  try {
    const port = req.body.port;
    if (!port) return res.status(400).json({ error: "Missing port" });
    const vibePort = process.env.PORT || 4000;
    if (String(port) === String(vibePort)) return res.status(400).json({ error: "Cannot stop vibe-ui" });
    try { execSync(`kill $(lsof -ti:${port} -sTCP:LISTEN) 2>/dev/null`, { stdio: "pipe" }); } catch {}
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Broadcast to all connected WebSocket clients
function wsBroadcast(data) {
  const msg = JSON.stringify(data);
  wss.clients.forEach(c => { if (c.readyState === 1) c.send(msg); });
}

// WebSocket handling (with auth)
wss.on("connection", (ws, req) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const token = url.searchParams.get("token");
  if (token !== AUTH_TOKEN) {
    ws.close(4001, "Unauthorized");
    return;
  }
  handleWashmenWs(ws, sessionIds);
});

const PORT = process.env.PORT || 4000;
server.listen(PORT, () => {
  console.log(`vibe-ui running on http://localhost:${PORT}`);
});
