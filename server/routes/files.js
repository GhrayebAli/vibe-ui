import { Router } from "express";
import { readFileSync, writeFileSync, readdirSync, existsSync, mkdirSync } from "fs";
import { join, resolve, sep } from "path";
import { getUpload, saveUpload } from "../../db.js";
import { getWorkspaceDir } from "../workspace-config.js";

export default function() {
  const router = Router();

  router.get("/uploads/*", (req, res) => {
    try {
      const fileName = req.params[0];
      if (!fileName || fileName.includes('..')) return res.status(400).json({ error: "Invalid path" });
      const sanitized = fileName.replace(/[^a-zA-Z0-9._-]/g, "");
      const filePath = join(getWorkspaceDir(), "tmp", "uploads", sanitized);
      if (existsSync(filePath)) return res.sendFile(filePath);
      const row = getUpload(sanitized);
      if (row) {
        const buf = Buffer.from(row.data, "base64");
        res.set("Content-Type", row.mime_type || "image/png");
        return res.send(buf);
      }
      res.status(404).json({ error: "Not found" });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  router.get("/file", (req, res) => {
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

      const uploadDir = join(getWorkspaceDir(), "tmp", "uploads");
      mkdirSync(uploadDir, { recursive: true });

      const ext = filename ? filename.split(".").pop() : (mediaType || "").split("/").pop() || "png";
      const name = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}.${ext}`;
      const filePath = join(uploadDir, name);

      writeFileSync(filePath, Buffer.from(data, "base64"));
      console.log(`[upload] Saved ${filePath} (${Math.round(Buffer.from(data, "base64").length / 1024)}KB)`);

      try {
        saveUpload(name, data, mediaType || "image/png");
      } catch (e) { console.error("[upload] DB save failed:", e.message); }

      res.json({ path: filePath, name });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  return router;
}
