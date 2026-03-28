import { Router } from "express";
import { getNotes, saveNotes } from "../../db.js";

export default function() {
  const router = Router();

  router.get("/notes", (req, res) => {
    const branch = req.query.branch;
    if (!branch) return res.json({ content: "" });
    const row = getNotes(branch);
    res.json({ content: row ? row.content : "" });
  });

  router.post("/notes", (req, res) => {
    const { branch, content } = req.body;
    if (!branch) return res.status(400).json({ error: "branch required" });
    saveNotes(branch, content || "");
    res.json({ ok: true });
  });

  return router;
}
