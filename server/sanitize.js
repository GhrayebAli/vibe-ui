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

/**
 * Allowed file extensions for uploads.
 */
const ALLOWED_EXTENSIONS = new Set([
  ".jpg", ".jpeg", ".png", ".gif", ".webp",
  ".txt", ".md", ".pdf", ".json",
  ".js", ".ts", ".tsx", ".jsx", ".css", ".html",
]);

/**
 * Allowed MIME types for uploads.
 */
const ALLOWED_MIME_TYPES = new Set([
  "image/jpeg", "image/png", "image/gif", "image/webp",
  "text/plain", "text/markdown", "application/pdf", "application/json",
  "text/javascript", "text/typescript", "text/css", "text/html",
  "application/javascript", "application/typescript",
]);

const MAX_UPLOAD_BYTES = 10 * 1024 * 1024; // 10MB

/**
 * Validate file extension against whitelist.
 * Returns the lowercase extension if valid, throws otherwise.
 */
export function validateFileExtension(filename) {
  if (!filename || typeof filename !== "string") {
    throw new Error("Filename is required");
  }
  const dotIdx = filename.lastIndexOf(".");
  if (dotIdx === -1) throw new Error("File has no extension");
  const ext = filename.slice(dotIdx).toLowerCase();
  if (!ALLOWED_EXTENSIONS.has(ext)) {
    throw new Error(`File type not allowed: ${ext}`);
  }
  return ext;
}

/**
 * Validate MIME type against whitelist.
 */
export function validateMimeType(mediaType) {
  if (!mediaType || typeof mediaType !== "string") {
    throw new Error("MIME type is required");
  }
  const normalized = mediaType.toLowerCase().split(";")[0].trim();
  if (!ALLOWED_MIME_TYPES.has(normalized)) {
    throw new Error(`MIME type not allowed: ${normalized}`);
  }
  return normalized;
}

/**
 * Validate upload file size in bytes.
 */
export function validateFileSize(byteLength) {
  if (byteLength > MAX_UPLOAD_BYTES) {
    throw new Error("File too large");
  }
}

export { MAX_UPLOAD_BYTES };

/**
 * Log the full error server-side and return a generic message for the client.
 */
export function getSafeErrorMessage(error, context) {
  console.error(`[${context}]`, error);
  return `${context} failed`;
}

export function validateDevCommand(cmd) {
  if (!cmd || typeof cmd !== "string") return false;
  let trimmed = cmd.trim();
  // Strip safe env var prefixes (e.g. NODE_OPTIONS=--openssl-legacy-provider)
  trimmed = trimmed.replace(ENV_PREFIX_RE, "");
  return ALLOWED_DEV_PATTERNS.some((p) => p.test(trimmed));
}
