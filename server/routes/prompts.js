import { Router } from "express";
import { readFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));

export default function() {
  const router = Router();

  router.get("/prompts", (_req, res) => {
    try {
      const promptsPath = join(__dirname, "..", "..", "..", "PROMPTS.md");
      const content = readFileSync(promptsPath, "utf8");
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

  return router;
}
