import { Router } from "express";
import { readFileSync, writeFileSync, readdirSync, existsSync, mkdirSync, realpathSync } from "fs";
import { join, resolve, sep } from "path";
import { getUpload, saveUpload } from "../../db.js";
import { getWorkspaceDir } from "../workspace-config.js";
import { validateFileExtension, validateMimeType, validateFileSize, getSafeErrorMessage } from "../sanitize.js";

export default function() {
  const router = Router();

  router.get("/uploads/*", (req, res) => {
    try {
      const fileName = req.params[0];
      if (!fileName || fileName.includes('..')) return res.status(403).json({ error: "Access denied" });
      const sanitized = fileName.replace(/[^a-zA-Z0-9._-]/g, "");

      // Reject if sanitization changed the input (contained disallowed characters)
      if (sanitized !== fileName) {
        return res.status(403).json({ error: "Access denied" });
      }

      const uploadsDir = join(getWorkspaceDir(), "tmp", "uploads");
      const filePath = join(uploadsDir, sanitized);

      if (existsSync(filePath)) {
        // Resolve symlinks and verify real path is within uploads directory
        const realPath = realpathSync(filePath);
        const realUploadsDir = realpathSync(uploadsDir);
        if (!realPath.startsWith(realUploadsDir + sep) && realPath !== realUploadsDir) {
          return res.status(403).json({ error: "Access denied" });
        }
        return res.sendFile(realPath);
      }

      const row = getUpload(sanitized);
      if (row) {
        const buf = Buffer.from(row.data, "base64");
        res.set("Content-Type", row.mime_type || "image/png");
        return res.send(buf);
      }
      res.status(404).json({ error: "File not found" });
    } catch (err) {
      res.status(500).json({ error: getSafeErrorMessage(err, "File retrieval") });
    }
  });

  router.get("/file", (req, res) => {
    try {
      const filePath = req.query.path;
      if (!filePath) return res.status(400).json({ error: "Missing path" });
      const workspaceDir = getWorkspaceDir();
      const resolved = resolve(workspaceDir, filePath);
      const resolvedWorkspace = resolve(workspaceDir);

      if (!resolved.startsWith(resolvedWorkspace + sep) && resolved !== resolvedWorkspace) {
        return res.status(403).json({ error: "Access denied" });
      }

      // Resolve symlinks and verify real path is within workspace
      if (!existsSync(resolved)) {
        return res.status(404).json({ error: "File not found" });
      }
      const realPath = realpathSync(resolved);
      const realWorkspace = realpathSync(resolvedWorkspace);
      if (!realPath.startsWith(realWorkspace + sep) && realPath !== realWorkspace) {
        return res.status(403).json({ error: "Access denied" });
      }

      const content = readFileSync(realPath, "utf8");
      res.json({ path: filePath, content });
    } catch (err) {
      if (err.code === "ENOENT") return res.status(404).json({ error: "File not found" });
      res.status(500).json({ error: getSafeErrorMessage(err, "File read") });
    }
  });

  router.get("/files", (_req, res) => {
    const workspaceDir = getWorkspaceDir();
    const files = [];
    const ignore = ["node_modules", ".git", ".yarn", "dist", "build", ".cache", ".tmp", "coverage", "vibe-ui"];
    const extensions = [".js", ".ts", ".tsx", ".jsx", ".json", ".css", ".scss", ".md"];
    const maxDepth = 4;
    const maxFilesPerRepo = 50;

    try {
      const entries = readdirSync(workspaceDir, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isDirectory() || ignore.includes(entry.name) || entry.name.startsWith(".")) continue;
        const repoPath = join(workspaceDir, entry.name);
        try {
          const hasPackageJson = existsSync(join(repoPath, "package.json"));
          const hasGit = existsSync(join(repoPath, ".git"));
          if (!hasPackageJson && !hasGit) continue;
        } catch { continue; }

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

  router.post("/upload", (req, res) => {
    try {
      const { filename, data, mediaType } = req.body;
      if (!data) return res.status(400).json({ error: "Missing data" });

      // Validate file extension
      const ext = filename ? filename.split(".").pop() : (mediaType || "").split("/").pop() || "png";
      const fullFilename = filename || `upload.${ext}`;
      try {
        validateFileExtension(fullFilename);
      } catch {
        return res.status(400).json({ error: "File type not allowed" });
      }

      // Validate MIME type
      if (mediaType) {
        try {
          validateMimeType(mediaType);
        } catch {
          return res.status(400).json({ error: "MIME type not allowed" });
        }
      }

      // Validate file size
      const buffer = Buffer.from(data, "base64");
      try {
        validateFileSize(buffer.length);
      } catch {
        return res.status(413).json({ error: "File too large (max 10MB)" });
      }

      const uploadDir = join(getWorkspaceDir(), "tmp", "uploads");
      mkdirSync(uploadDir, { recursive: true });

      const name = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}.${ext}`;
      const filePath = join(uploadDir, name);

      writeFileSync(filePath, buffer);
      console.log(`[upload] Saved ${filePath} (${Math.round(buffer.length / 1024)}KB)`);

      try {
        saveUpload(name, data, mediaType || "image/png");
      } catch (e) { console.error("[upload] DB save failed:", e.message); }

      res.json({ path: filePath, name });
    } catch (err) {
      res.status(500).json({ error: getSafeErrorMessage(err, "Upload") });
    }
  });

  return router;
}
