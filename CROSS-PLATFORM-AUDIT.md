# Cross-Platform Compatibility Audit

Audit of CodeDeck for Windows and Linux compatibility before NPX publishing.

---

## Critical (Must Fix)

### 1. `process.env.HOME` undefined on Windows

`process.env.HOME` is not set on Windows. Must use `os.homedir()`.

| File | Line | Code |
|------|------|------|
| `server/routes/exec.js` | 11 | `cwd: cwd \|\| process.env.HOME` |
| `server/routes/stats.js` | 21 | `join(process.env.HOME \|\| "", ".local", "bin", "claude")` |
| `server/agent-loop.js` | 100 | `const resolvedCwd = (cwd && existsSync(cwd)) ? cwd : process.env.HOME` |
| `server/ws-handler.js` | 364 | `const wfCwd = (cwd && existsSync(cwd)) ? cwd : process.env.HOME` |
| `server/ws-handler.js` | 452 | `const resolvedCwd = (cwd && existsSync(cwd)) ? cwd : process.env.HOME` |

**Fix:** Replace all with `os.homedir()`.

### 2. Hardcoded `/` path validation rejects Windows paths

```javascript
// server/routes/projects.js:67
if (!current.startsWith("/")) {
  return res.status(400).json({ error: "Invalid path" });
}
```

Windows paths like `C:\Users\...` are rejected.

**Fix:** Use `path.isAbsolute(current)` instead of `startsWith("/")`.

### 3. Hardcoded `/` in file path building

```javascript
// server/routes/files.js:86
const relPath = dir ? `${dir}/${entry.name}` : entry.name;

// server/routes/files.js:163
const relPath = relDir ? `${relDir}/${entry.name}` : entry.name;
```

**Fix:** Use `path.join(dir, entry.name)` or `path.posix.join()` if paths must use forward slashes for the frontend.

---

## High Priority

### 4. Path traversal security checks break on Windows

```javascript
// files.js, projects.js — multiple locations
if (!resolved.startsWith(base)) return res.status(403).json({...});
```

String comparison fails with mixed `\` and `/` separators on Windows. Example: `C:/Projects/app` vs `C:\Projects\app`.

**Fix:** Normalize both paths with `path.resolve()` and compare with `path.sep`:
```javascript
const normalized = path.resolve(resolved);
const basePath = path.resolve(base);
if (!normalized.startsWith(basePath + path.sep) && normalized !== basePath) { ... }
```

### 5. Claude binary lookup is Linux-only

```javascript
// server/routes/stats.js:20-24
function findClaudeBinary() {
  const localBin = join(process.env.HOME || "", ".local", "bin", "claude");
  if (existsSync(localBin)) return localBin;
  return "claude"; // fallback to PATH
}
```

Only checks `~/.local/bin` (Linux convention). Doesn't check macOS `/usr/local/bin` or Windows `%APPDATA%`.

**Fix:** Check multiple platform-specific paths or just rely on PATH lookup:
```javascript
function findClaudeBinary() {
  const home = os.homedir();
  const candidates = [
    join(home, ".local", "bin", "claude"),           // Linux
    join(home, ".claude", "local", "claude"),         // alt
  ];
  if (process.platform === 'win32') {
    candidates.push(join(home, "AppData", "Local", "Programs", "claude", "claude.exe"));
  }
  for (const p of candidates) {
    if (existsSync(p)) return p;
  }
  return "claude"; // fallback to PATH
}
```

---

## Medium Priority

### 6. Frontend path splitting assumes `/` separator

```javascript
// public/js/features/projects.js:156
const base = data.current.split("/").filter(Boolean).pop() || "";

// public/js/features/projects.js:165
const parts = pathStr.split("/").filter(Boolean);
```

Breadcrumb navigation breaks on Windows `\` paths.

**Fix:** Normalize paths on the server before sending to frontend (always use `/`), or split on both:
```javascript
const parts = pathStr.split(/[/\\]/).filter(Boolean);
```

### 7. VS Code launch with spaces in path

```javascript
// public/js/features/projects.js:276
body: JSON.stringify({ command: "code .", cwd: path }),
```

Passed through `exec()` — shell escaping varies by platform. Paths with spaces or special characters may fail on Windows `cmd.exe`.

**Fix:** Use `execFile("code", ["."], { cwd: path })` instead of `exec()` to avoid shell interpretation.

---

## No Issues Found (Already Compatible)

| Component | Notes |
|-----------|-------|
| `db.js` | Uses `path.join(__dirname, "data.db")` correctly |
| `server/routes/mcp.js` | Already uses `os.homedir()` |
| WebSocket setup | Platform-agnostic |
| Express server | Platform-agnostic |
| `package.json` scripts | Just `node server.js` |
| Database (better-sqlite3) | Has native bindings but `npm install` handles platform detection |

---

## Fix Order

1. Replace `process.env.HOME` → `os.homedir()` (5 locations)
2. Replace `startsWith("/")` → `path.isAbsolute()` (1 location)
3. Replace hardcoded `/` path joins → `path.join()` (2 locations)
4. Normalize path traversal security checks (4 locations)
5. Fix Claude binary lookup (1 location)
6. Fix frontend path splitting (2 locations)
7. Fix exec → execFile for VS Code launch (1 location)
