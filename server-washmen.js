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
// Track last read position per log file to only return new lines
const logPositions = {};

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
    catch { ({ chromium } = await import("/workspaces/washmen-mvp-workspace/node_modules/playwright/index.mjs")); }
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
        if (browserConsoleBuffer.length > 200) browserConsoleBuffer.splice(0, 100);
      }
    });

    page.on("pageerror", err => {
      browserConsoleBuffer.push({
        level: "error",
        message: `[browser] Uncaught: ${err.message}`,
        ts: Date.now(),
      });
    });

    await page.goto("http://localhost:3000", { waitUntil: "domcontentloaded", timeout: 15000 }).catch(() => {});
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

  for (const [name, logFile] of [["frontend", "fe.log"], ["gateway", "gw.log"], ["core", "core.log"], ["vibe-ui", "vibe.log"]]) {
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
        if (!trimmed || trimmed.length < 5) continue;

        // Skip Sails boilerplate — ASCII art, decoration, help text
        if (trimmed.match(/^[\s\-=~_.·•|\\/<>,'`^]+$/) || trimmed.match(/^\s*(info|debug|error):\s*$/)) continue;
        if (trimmed.match(/Sails\s|__---___|\.-.\.-.|-'.-==|`--'---/) ) continue;
        if (trimmed.includes("sailsjs.com") || trimmed.includes("CTRL") || trimmed.includes("Troubleshooting")) continue;
        if (trimmed.includes("Hold tight") || trimmed.includes("Auto-migrat") || trimmed.includes("session secret")) continue;
        if (trimmed.match(/^\s*(v1\.\d|\/\|\\|,'|`--|Environment|Port\s|Local\s)/)) continue;

        const lower = trimmed.toLowerCase();

        // Meaningful messages only
        if (lower.includes("eaddrinuse") || lower.includes("enoent") || lower.includes("uncaught") || lower.includes("throw ") || lower.includes("fatal") || lower.includes("crash")) {
          entries.push({ level: "error", message: `[${name}] ${trimmed}` });
        } else if (lower.includes("deprecat") || lower.includes("warning:")) {
          entries.push({ level: "warn", message: `[${name}] ${trimmed}` });
        } else if (lower.includes("server lifted") || lower.includes("running on") || lower.includes("listening") || lower.includes("hook") || lower.includes("seed data") || lower.includes("migration complete")) {
          entries.push({ level: "info", message: `[${name}] ${trimmed}` });
        }
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

// Inspect element at coordinates — for visual edit mode
// Cached Playwright browser for element inspection — avoids 10s startup per click
let inspectBrowser = null;
let inspectPage = null;
let inspectLastPath = null;

async function getInspectPage(targetPath) {
  if (!inspectBrowser) {
    let chromium;
    try { ({ chromium } = await import("playwright")); }
    catch { ({ chromium } = await import("/workspaces/washmen-mvp-workspace/node_modules/playwright/index.mjs")); }
    inspectBrowser = await chromium.launch();
    inspectPage = await inspectBrowser.newPage({ viewport: { width: 1280, height: 720 } });
    // Login by actually clicking the Login button (sets Redux state + Axios headers properly)
    await inspectPage.goto("http://localhost:3000", { waitUntil: "networkidle", timeout: 15000 });
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
    await inspectPage.goto("http://localhost:3000" + targetPath, { waitUntil: "networkidle", timeout: 10000 }).catch(() => {});
    await inspectPage.waitForTimeout(500);
    inspectLastPath = targetPath;
  }
  return inspectPage;
}

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
