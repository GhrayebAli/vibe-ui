// Input sanitization utilities for shell command safety

/**
 * Validate and sanitize a git branch name.
 * Only allows alphanumeric, hyphens, underscores, forward slashes, and dots.
 * Rejects shell metacharacters, backticks, $(), semicolons, etc.
 */
export function sanitizeBranchName(name) {
  if (!name || typeof name !== "string") {
    throw new Error("Branch name is required");
  }
  if (!/^[a-zA-Z0-9\-_\/.]+$/.test(name)) {
    throw new Error(`Invalid branch name: "${name}"`);
  }
  // Block directory traversal
  if (name.includes("..")) {
    throw new Error(`Invalid branch name: "${name}"`);
  }
  return name;
}

/**
 * Validate a port number.
 */
export function sanitizePort(port) {
  const str = String(port).trim();
  if (!/^\d+$/.test(str)) {
    throw new Error(`Invalid port: "${port}"`);
  }
  const p = parseInt(str, 10);
  if (p < 1 || p > 65535) {
    throw new Error(`Invalid port: "${port}"`);
  }
  return p;
}

/**
 * Validate a workspace.json dev command against an allowlist.
 */
const ALLOWED_DEV_PATTERNS = [
  /^(npm|yarn|pnpm)\s+(run\s+)?(dev|start|serve)([\s:].*)?$/,
  /^node\s+[\w\-\.\/]+\.m?js(\s+.*)?$/,
  /^npx\s+[\w\-@\/]+(\s+.*)?$/,
  /^nodemon\s+/,
];

// Env var prefix pattern: KEY=value (no shell metacharacters in value)
const ENV_PREFIX_RE = /^([A-Z_][A-Z0-9_]*=[\w\-\.\/\+:]+\s+)+/;

export function validateDevCommand(cmd) {
  if (!cmd || typeof cmd !== "string") return false;
  let trimmed = cmd.trim();
  // Strip safe env var prefixes (e.g. NODE_OPTIONS=--openssl-legacy-provider)
  trimmed = trimmed.replace(ENV_PREFIX_RE, "");
  return ALLOWED_DEV_PATTERNS.some((p) => p.test(trimmed));
}
