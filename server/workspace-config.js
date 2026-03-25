import { readFileSync, existsSync, readdirSync } from "fs";
import { join } from "path";

let _config = null;

/**
 * Load workspace.json from the workspace root directory.
 * Falls back to auto-discovery if workspace.json is missing.
 */
export function loadWorkspaceConfig() {
  const workspaceDir = getWorkspaceDir();
  const configPath = join(workspaceDir, "workspace.json");

  if (existsSync(configPath)) {
    try {
      _config = JSON.parse(readFileSync(configPath, "utf8"));
      // Resolve path for each repo
      for (const repo of _config.repos) {
        if (!repo.path) repo.path = join(workspaceDir, repo.name);
      }
      console.log(`[workspace] Loaded config: ${_config.name} (${_config.repos.length} repos)`);
    } catch (e) {
      console.error("[workspace] Failed to parse workspace.json:", e.message);
      _config = null;
    }
  }

  if (!_config) {
    console.log("[workspace] No workspace.json found — using auto-discovery");
    _config = autoDiscover(workspaceDir);
  }

  return _config;
}

/**
 * Auto-discover repos when no workspace.json exists.
 * Scans workspace dir for git repos with package.json.
 */
function autoDiscover(workspaceDir) {
  const exclude = ["vibe-ui", "node_modules", ".git", ".devcontainer", ".claude", ".github"];
  const repos = [];

  try {
    for (const entry of readdirSync(workspaceDir, { withFileTypes: true })) {
      if (!entry.isDirectory() || exclude.includes(entry.name) || entry.name.startsWith(".")) continue;
      const repoPath = join(workspaceDir, entry.name);
      if (!existsSync(join(repoPath, ".git"))) continue;

      const repo = { name: entry.name, type: "backend", healthPath: "/health" };

      // Detect frontend by common indicators
      if (existsSync(join(repoPath, "src", "App.tsx")) ||
          existsSync(join(repoPath, "src", "App.jsx")) ||
          existsSync(join(repoPath, "src", "App.js")) ||
          existsSync(join(repoPath, "vite.config.ts")) ||
          existsSync(join(repoPath, "vite.config.js"))) {
        repo.type = "frontend";
        repo.healthPath = "/";
      }

      // Detect port from package.json scripts or app.js
      try {
        const pkg = JSON.parse(readFileSync(join(repoPath, "package.json"), "utf8"));
        const startScript = pkg.scripts?.start || pkg.scripts?.dev || "";
        const portMatch = startScript.match(/--port[= ](\d+)|PORT=(\d+)|-p (\d+)/);
        if (portMatch) repo.port = parseInt(portMatch[1] || portMatch[2] || portMatch[3]);

        // Detect dev command
        if (pkg.scripts?.dev) repo.dev = "npm run dev";
        else if (pkg.scripts?.start) repo.dev = "npm start";
      } catch {}

      // Try to detect port from app.js (Sails pattern)
      if (!repo.port) {
        try {
          const appJs = readFileSync(join(repoPath, "app.js"), "utf8");
          const portMatch = appJs.match(/port:\s*(\d+)/);
          if (portMatch) repo.port = parseInt(portMatch[1]);
        } catch {}
      }

      // Try vite.config for port
      if (!repo.port) {
        for (const viteConfig of ["vite.config.ts", "vite.config.js"]) {
          try {
            const content = readFileSync(join(repoPath, viteConfig), "utf8");
            const portMatch = content.match(/port:\s*(\d+)/);
            if (portMatch) repo.port = parseInt(portMatch[1]);
          } catch {}
        }
      }

      repos.push(repo);
    }
  } catch {}

  return {
    name: "Workspace",
    repos,
    previewPath: "/",
  };
}

/** Get workspace root directory */
export function getWorkspaceDir() {
  return process.env.WORKSPACE_DIR || "/workspaces/workspace";
}

/** Get the loaded config (call loadWorkspaceConfig first) */
export function getConfig() {
  if (!_config) loadWorkspaceConfig();
  return _config;
}

/** Get all repo names */
export function getRepoNames() {
  return getConfig().repos.map(r => r.name);
}

/** Get the frontend repo (first repo with type "frontend") */
export function getFrontendRepo() {
  return getConfig().repos.find(r => r.type === "frontend") || getConfig().repos[0];
}

/** Get frontend port */
export function getFrontendPort() {
  return getFrontendRepo()?.port || 3000;
}

/** Get the preview path for iframe */
export function getPreviewPath() {
  return getConfig().previewPath || "/";
}

/** Get additional directories for Claude agent context */
export function getAdditionalDirs() {
  const dir = getWorkspaceDir();
  return getConfig().repos.map(r => `${dir}/${r.name}`);
}

/** Get services config for health checks (compatible with SERVICES env format) */
export function getServicesConfig() {
  return getConfig().repos
    .filter(r => r.port)
    .map(r => ({
      name: r.name,
      port: r.port,
      url: `http://localhost:${r.port}${r.healthPath || "/health"}`,
    }));
}

/** Get client-safe config (served to browser via API) */
export function getClientConfig() {
  const cfg = getConfig();
  return {
    name: cfg.name,
    previewPath: cfg.previewPath || "/",
    frontendPort: getFrontendPort(),
    repos: cfg.repos.map(r => ({ name: r.name, type: r.type, port: r.port })),
  };
}
