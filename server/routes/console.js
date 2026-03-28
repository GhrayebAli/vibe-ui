import { Router } from "express";
import { readFileSync, existsSync, statSync, readdirSync, openSync, readSync, fstatSync, closeSync, watch } from "fs";
import { getConfig, getFrontendPort } from "../workspace-config.js";

export default function({ wsBroadcast }) {
  const router = Router();

  // Track last read position per log file
  const logPositions = {};

  // Log sources
  const explicitLogSources = process.env.LOG_SOURCES
    ? process.env.LOG_SOURCES.split(",").map(s => { const [n, f] = s.split(":"); return [n.trim(), f.trim()]; })
    : null;

  function getLogSources() {
    if (explicitLogSources) return explicitLogSources;
    const serviceNames = new Set(getConfig().repos.map(r => r.name));
    try {
      return readdirSync("/tmp")
        .filter(f => f.endsWith(".log") && serviceNames.has(f.replace(/\.log$/, "")))
        .map(f => [f.replace(/\.log$/, ""), f]);
    } catch { return []; }
  }

  // Browser console buffer
  const browserConsoleBuffer = [];
  let browserConsoleStarted = false;

  async function startBrowserConsoleListener() {
    if (browserConsoleStarted) return;
    browserConsoleStarted = true;
    try {
      let chromium;
      try { ({ chromium } = await import("playwright")); }
      catch {
        try {
          const wsDir = process.cwd();
          ({ chromium } = await import(`${wsDir}/node_modules/playwright/index.mjs`));
        } catch {
          ({ chromium } = await import("playwright"));
        }
      }
      const browser = await chromium.launch();
      const page = await browser.newPage();

      const seenBrowserMsgs = new Set();
      page.on("console", msg => {
        const type = msg.type();
        if (type === "error" || type === "warning" || type === "warn") {
          const text = msg.text();
          if (text.match(/failed to parse source map|ENOENT.*node_modules.*\.tsx?/i)) return;
          if (seenBrowserMsgs.has(text)) return;
          seenBrowserMsgs.add(text);
          if (seenBrowserMsgs.size > 200) seenBrowserMsgs.clear();
          browserConsoleBuffer.push({
            level: type === "warning" || type === "warn" ? "warn" : "error",
            message: `[browser] ${text}`,
            ts: Date.now(),
          });
          if (browserConsoleBuffer.length > 50) browserConsoleBuffer.splice(0, 25);
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
    } catch (err) {
      console.error("[console] Failed to start browser listener:", err.message);
      browserConsoleStarted = false;
    }
  }

  setTimeout(() => {
    startBrowserConsoleListener().catch(e => console.error("[console] listener failed:", e.message));
  }, 10000);

  // Cross-poll dedup
  const recentlySentErrors = new Map();
  const DEDUP_WINDOW_MS = 5 * 60 * 1000;

  router.get("/console", (req, res) => {
    const entries = [];
    const reset = req.query.reset === "true";
    if (reset) recentlySentErrors.clear();

    for (const key of Object.keys(logPositions)) {
      if (!existsSync(`/tmp/${key}`)) delete logPositions[key];
    }

    for (const [name, logFile] of getLogSources()) {
      try {
        const path = `/tmp/${logFile}`;
        const log = readFileSync(path, "utf8");
        const allLines = log.split("\n").filter(Boolean);

        const lastPos = reset ? 0 : (logPositions[logFile] || Math.max(0, allLines.length - 5));
        const newLines = allLines.slice(lastPos);
        logPositions[logFile] = allLines.length;

        for (const line of newLines) {
          const trimmed = line.trim();
          if (!trimmed || trimmed.length < 3) continue;
          if (trimmed.match(/^[\s\-=~_.·•|\\/<>,'`^]+$/)) continue;
          if (trimmed.match(/^\s*(info|debug|verbose|silly|trace|error|warn):\s*$/i)) continue;
          if (trimmed.match(/^\[(tool|agent|session|push|context|checkpoint|console|workspace|code|inspect|screenshot|cost|db|switch|create-branch|memory)\]/)) continue;
          if (trimmed.match(/\bat\s+([\w$.]+\s+\(|\/|node:)/)) continue;
          if (trimmed.match(/\b(hot[- ]?update|webpack|hmr|compiled|bundle)\b/i)) continue;
          if (trimmed.match(/failed to parse source map/i)) continue;
          if (trimmed.match(/ENOENT.*node_modules.*\.tsx?'/)) continue;
          if (trimmed.match(/sentry is not enabled|skipping error capture/i)) continue;
          if (trimmed.match(/custom response.*called with an error/i)) continue;

          const lower = trimmed.toLowerCase();
          let level = "info";
          if (lower.includes("eaddrinuse") || lower.includes("enoent") ||
              lower.includes("eacces") || lower.includes("econnrefused") || lower.includes("uncaught") || lower.includes("unhandled") ||
              lower.includes("throw ") || lower.includes("fatal") || lower.includes("crash") ||
              lower.includes("typeerror") || lower.includes("referenceerror") || lower.includes("syntaxerror") || lower.includes("rangeerror") ||
              lower.includes("cannot read prop") || lower.includes("is not defined") || lower.includes("is not a function") ||
              lower.includes("module not found") || lower.includes("command failed") ||
              (lower.includes("missing") && (lower.includes("env") || lower.includes("variable") || lower.includes("module") || lower.includes("package"))) ||
              lower.startsWith("error") || lower.match(/\berr(?:or)?:/)) {
            level = "error";
          } else if (lower.includes("deprecat") || lower.includes("experimental") ||
                     lower.includes("not recommended") || lower.includes("will be removed") ||
                     lower.startsWith("warn")) {
            level = "warn";
          }

          entries.push({ level, message: `[${name}] ${trimmed}` });
        }
      } catch {}
    }

    const browserEntries = browserConsoleBuffer.splice(0, browserConsoleBuffer.length);
    entries.push(...browserEntries);

    const deduped = [];
    const seen = new Map();
    for (const entry of entries) {
      const key = `${entry.level}|${entry.message}`;
      if (seen.has(key)) {
        seen.get(key).count++;
      } else {
        const e = { ...entry, count: 1 };
        seen.set(key, e);
        deduped.push(e);
      }
    }
    for (const e of deduped) {
      if (e.count > 1) e.message += ` (\u00d7${e.count})`;
      delete e.count;
    }

    const now = Date.now();
    for (const [k, ts] of recentlySentErrors) {
      if (now - ts > DEDUP_WINDOW_MS) recentlySentErrors.delete(k);
    }
    const fresh = deduped.filter(e => {
      const key = `${e.level}|${e.message}`;
      if (recentlySentErrors.has(key)) return false;
      recentlySentErrors.set(key, now);
      return true;
    });

    res.json({ entries: fresh });
  });

  // Real-time log streaming via WebSocket
  const logWatchers = new Map();
  const LOG_BATCH_MS = 100;
  let pendingLogEntries = [];
  let logBatchTimer = null;

  function classifyLogLine(trimmed) {
    const lower = trimmed.toLowerCase();
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
    return level;
  }

  function isNoiseLine(trimmed) {
    if (!trimmed || trimmed.length < 3) return true;
    if (trimmed.match(/^[\s\-=~_.·•|\\/<>,'`^]+$/)) return true;
    if (trimmed.match(/^\s*(info|debug|verbose|silly|trace|error|warn):\s*$/i)) return true;
    if (trimmed.match(/^\[(tool|agent|session|push|context|checkpoint|console|workspace|code|inspect|screenshot|cost|db|switch|create-branch)\]/)) return true;
    return false;
  }

  function flushLogBatch() {
    logBatchTimer = null;
    if (pendingLogEntries.length === 0) return;
    const entries = pendingLogEntries.splice(0, pendingLogEntries.length);
    wsBroadcast({ type: "console_entries", entries });
  }

  function queueLogEntry(entry) {
    pendingLogEntries.push(entry);
    if (!logBatchTimer) {
      logBatchTimer = setTimeout(flushLogBatch, LOG_BATCH_MS);
    }
  }

  function readNewBytes(logFile, sourceName) {
    const filePath = `/tmp/${logFile}`;
    try {
      const fd = openSync(filePath, "r");
      const stat = fstatSync(fd);
      const watcher = logWatchers.get(logFile);
      const startPos = watcher ? watcher.bytePos : Math.max(0, stat.size - 2048);
      if (stat.size <= startPos) { closeSync(fd); return; }
      const bytesToRead = stat.size - startPos;
      const buf = Buffer.alloc(bytesToRead);
      readSync(fd, buf, 0, bytesToRead, startPos);
      closeSync(fd);
      if (watcher) watcher.bytePos = stat.size;

      const text = buf.toString("utf8");
      const lines = text.split("\n");
      for (const line of lines) {
        const trimmed = line.trim();
        if (isNoiseLine(trimmed)) continue;
        const level = classifyLogLine(trimmed);
        queueLogEntry({
          source: sourceName,
          level,
          message: trimmed,
          timestamp: Date.now(),
        });
      }
    } catch {}
  }

  function startLogWatcher(logFile, sourceName) {
    if (logWatchers.has(logFile)) return;
    const filePath = `/tmp/${logFile}`;
    if (!existsSync(filePath)) return;

    let bytePos;
    try {
      const stat = statSync(filePath);
      bytePos = stat.size;
    } catch { bytePos = 0; }

    try {
      const fsWatcher = watch(filePath, { persistent: false }, (eventType) => {
        if (eventType === "change") {
          readNewBytes(logFile, sourceName);
        }
      });
      logWatchers.set(logFile, { watcher: fsWatcher, bytePos });
      console.log(`[console] Watching ${logFile} for ${sourceName}`);
    } catch {
      const pollId = setInterval(() => {
        readNewBytes(logFile, sourceName);
      }, 500);
      logWatchers.set(logFile, { watcher: null, bytePos, pollId });
      console.log(`[console] Polling ${logFile} for ${sourceName} (fs.watch unavailable)`);
    }
  }

  function refreshLogWatchers() {
    for (const [name, logFile] of getLogSources()) {
      startLogWatcher(logFile, name);
    }
  }

  setTimeout(() => {
    refreshLogWatchers();
    setInterval(refreshLogWatchers, 15000);
  }, 2000);

  return router;
}
