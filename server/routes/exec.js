import { Router } from "express";
import { exec, execFile } from "child_process";
import { resolve } from "path";
import { getWorkspaceDir } from "../workspace-config.js";

const router = Router();

const ALLOWED_COMMANDS = [
  /^git\s+(status|log|diff|branch|show)/,
  /^ls\b/,
  /^cat\b/,
  /^head\b/,
  /^tail\b/,
  /^wc\b/,
  /^find\b/,
  /^grep\b/,
];

router.post("/", (req, res) => {
  const { command, cwd } = req.body;
  if (!command) return res.status(400).json({ error: "command is required" });

  // Whitelist check
  if (!ALLOWED_COMMANDS.some(p => p.test(command))) {
    return res.status(403).json({ error: "Command not allowed" });
  }

  // Validate cwd is within workspace
  const workspaceDir = getWorkspaceDir();
  const resolvedCwd = resolve(cwd || workspaceDir);
  if (!resolvedCwd.startsWith(resolve(workspaceDir))) {
    return res.status(403).json({ error: "cwd outside workspace" });
  }

  const execOpts = {
    cwd: resolvedCwd,
    timeout: 30000,
    maxBuffer: 512 * 1024,
  };

  const callback = (err, stdout, stderr) => {
    res.json({
      command,
      stdout: stdout || "",
      stderr: stderr || "",
      exitCode: err ? (err.code ?? 1) : 0,
    });
  };

  // On Windows, always use exec (shell) so PATH-resolved commands like "code" work
  // On Unix, use execFile for simple commands to avoid shell escaping issues
  const parts = command.split(/\s+/);
  const isSimple = parts.length <= 2 && !command.includes("|") && !command.includes(">") && !command.includes("&");
  if (isSimple && process.platform !== "win32") {
    execFile(parts[0], parts.slice(1), execOpts, callback);
  } else {
    exec(command, execOpts, callback);
  }
});

export default router;
