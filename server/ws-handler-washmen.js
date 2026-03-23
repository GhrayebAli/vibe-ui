import { query } from "@anthropic-ai/claude-agent-sdk";
import crypto from "crypto";
import { execSync } from "child_process";
import { readFileSync, readdirSync, existsSync } from "fs";
import { getWorkspaceDir, getConfig, getRepoNames, getFrontendRepo, getFrontendPort, getAdditionalDirs } from "./workspace-config.js";

// Screenshot capture using Playwright
async function takeScreenshot() {
  try {
    const port = getFrontendPort();
    const cwd = getWorkspaceDir();
    const result = execSync(
      `node -e "const{chromium}=require('playwright');(async()=>{const b=await chromium.launch();const p=await b.newPage({viewport:{width:1280,height:720}});await p.goto('http://localhost:${port}',{waitUntil:'networkidle',timeout:10000});await p.waitForTimeout(1000);const buf=await p.screenshot();await b.close();process.stdout.write(buf.toString('base64'));})()"`,
      { cwd, timeout: 20000, maxBuffer: 10 * 1024 * 1024 }
    );
    return result.toString();
  } catch (e) {
    console.error("[screenshot] Failed:", e.message);
    return null;
  }
}
import {
  createSession,
  getSession,
  addMessage,
  addCost,
  getTotalCost,
  updateSessionTitle,
  saveNotes,
} from "../db.js";

const DAILY_BUDGET = 20; // $20/day

// PreToolUse guardrail patterns
const BLOCKED_BASH_PATTERNS = [
  /migrate/i, /db:seed/i, /DROP\s/i, /DELETE\s+FROM/i, /TRUNCATE/i, /ALTER\s+TABLE/i,
  /git\s+push\s+.*\s*(master|main)\b/i,
];

const BLOCKED_CODE_PATTERNS = [
  /\.destroy\s*\(\s*\{\s*\}\s*\)/,  // .destroy({}) — bulk delete
  /\.destroy\s*\(\s*\)/,             // .destroy() — no criteria
  /\.update\s*\(\s*\{\s*\}\s*\)/,    // .update({}) — bulk update
  /\.native\s*\(/,                    // .native()
  /\.getDatastore\(\)\.sendNativeQuery/,
  /require\s*\(\s*['"]child_process['"]\s*\)/,
];

const BLOCKED_FILE_PATTERNS = [
  /\/policies\//i, /\/middleware\//i, /\/auth\//i,
];

function checkPreToolUse(toolName, toolInput) {
  if (toolName === "Bash" || toolName === "bash") {
    const cmd = toolInput?.command || toolInput?.cmd || "";
    for (const pattern of BLOCKED_BASH_PATTERNS) {
      if (pattern.test(cmd)) {
        return { allowed: false, reason: `Blocked: command matches forbidden pattern "${pattern.source}"` };
      }
    }
  }

  if (toolName === "Edit" || toolName === "Write" || toolName === "edit" || toolName === "write") {
    const filePath = toolInput?.file_path || toolInput?.path || "";
    for (const pattern of BLOCKED_FILE_PATTERNS) {
      if (pattern.test(filePath)) {
        return { allowed: false, reason: `Blocked: cannot edit auth/middleware/policy files (${filePath})` };
      }
    }
    const content = toolInput?.new_string || toolInput?.content || "";
    for (const pattern of BLOCKED_CODE_PATTERNS) {
      if (pattern.test(content)) {
        return { allowed: false, reason: `Blocked: code contains forbidden pattern "${pattern.source}"` };
      }
    }
  }

  return { allowed: true };
}

// Create mvp branches across all repos
function createMvpBranches(featureName) {
  const workspaceDir = getWorkspaceDir();
  const repos = [...getRepoNames(), "."];
  const branchName = `mvp/${featureName}`;
  const results = [];

  for (const repo of repos) {
    const repoDir = repo === "." ? workspaceDir : `${workspaceDir}/${repo}`;
    try {
      execSync(`git -C "${repoDir}" checkout -b "${branchName}"`, { stdio: "pipe" });
      results.push({ repo, branch: branchName, status: "created" });
    } catch (err) {
      // Branch might already exist
      try {
        execSync(`git -C "${repoDir}" checkout "${branchName}"`, { stdio: "pipe" });
        results.push({ repo, branch: branchName, status: "switched" });
      } catch {
        results.push({ repo, branch: branchName, status: "error", error: err.message });
      }
    }
  }
  return results;
}

// Create checkpoint tags across all repos — branch-scoped
function createCheckpoint(label, currentBranch) {
  const workspaceDir = getWorkspaceDir();
  const branchSlug = (currentBranch || "main").replace(/\//g, "-");

  // Discover repos dynamically
  const exclude = ["vibe-ui", "node_modules", ".git", ".devcontainer", ".claude", ".github"];
  const repos = [];
  try {
    for (const entry of readdirSync(workspaceDir, { withFileTypes: true })) {
      if (entry.isDirectory() && !exclude.includes(entry.name) && !entry.name.startsWith(".")) {
        if (existsSync(`${workspaceDir}/${entry.name}/.git`)) repos.push(entry.name);
      }
    }
  } catch {}
  if (repos.length === 0) repos.push(...getRepoNames());

  // Find next checkpoint number for this branch
  let maxNum = 0;
  for (const repo of repos) {
    try {
      const tags = execSync(`git -C "${workspaceDir}/${repo}" tag -l "checkpoint/${branchSlug}/*"`, { stdio: "pipe" }).toString().trim();
      for (const tag of tags.split("\n").filter(Boolean)) {
        const parts = tag.split("/");
        const num = parseInt(parts[parts.length - 1]);
        if (num > maxNum) maxNum = num;
      }
    } catch {}
  }

  const checkpointName = `checkpoint/${branchSlug}/${String(maxNum + 1).padStart(3, "0")}`;
  for (const repo of repos) {
    try {
      execSync(`git -C "${workspaceDir}/${repo}" tag -a "${checkpointName}" -m "${label}"`, { stdio: "pipe" });
    } catch {}
  }
  return checkpointName;
}

// Undo to previous checkpoint — branch-scoped
function undoToLastCheckpoint(currentBranch) {
  const workspaceDir = getWorkspaceDir();
  const branchSlug = (currentBranch || "main").replace(/\//g, "-");

  // Discover repos
  const exclude = ["vibe-ui", "node_modules", ".git", ".devcontainer", ".claude", ".github"];
  const repos = [];
  try {
    for (const entry of readdirSync(workspaceDir, { withFileTypes: true })) {
      if (entry.isDirectory() && !exclude.includes(entry.name) && !entry.name.startsWith(".")) {
        if (existsSync(`${workspaceDir}/${entry.name}/.git`)) repos.push(entry.name);
      }
    }
  } catch {}
  if (repos.length === 0) repos.push(...getRepoNames());

  const results = [];
  for (const repo of repos) {
    try {
      const tags = execSync(`git -C "${workspaceDir}/${repo}" tag -l "checkpoint/${branchSlug}/*" --sort=-version:refname`, { stdio: "pipe" })
        .toString().trim().split("\n").filter(Boolean);

      if (tags.length >= 2) {
        const previousTag = tags[1]; // Second most recent
        execSync(`git -C "${workspaceDir}/${repo}" reset --hard "${previousTag}"`, { stdio: "pipe" });
        results.push({ repo, restoredTo: previousTag, status: "ok" });
      } else {
        results.push({ repo, status: "no_previous_checkpoint" });
      }
    } catch (err) {
      results.push({ repo, status: "error", error: err.message });
    }
  }
  return results;
}

export function handleWashmenWs(ws, sessionIds) {
  let currentSessionId = null;
  let currentQuery = null;
  let isFirstMessage = true;

  ws.on("message", async (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      return;
    }

    // Handle different message types
    if (msg.type === "chat") {
      await handleChat(msg, ws, sessionIds);
    } else if (msg.type === "undo") {
      const results = undoToLastCheckpoint(msg.branch);
      ws.send(JSON.stringify({ type: "undo_result", results }));
    } else if (msg.type === "restart_services") {
      ws.send(JSON.stringify({ type: "system", text: "Restarting services..." }));
      // Services are managed by the Codespace — send a signal to restart
      try {
        const workspaceDir = getWorkspaceDir();
        execSync(`bash "${workspaceDir}/.devcontainer/start.sh" &`, { stdio: "pipe", timeout: 5000 });
        ws.send(JSON.stringify({ type: "system", text: "Services restart initiated" }));
      } catch {
        ws.send(JSON.stringify({ type: "system", text: "Service restart failed — try refreshing the Codespace" }));
      }
    } else if (msg.type === "generate_mvp_notes") {
      // Send a special prompt to the agent to generate notes for the current branch
      const noteBranch = msg.branch || "main";
      await handleChat({
        ...msg,
        type: "chat",
        text: `Generate a summary of what was built on branch "${noteBranch}". Read the git log across all repos, examine the code changes, and provide: What was built, Why (problem it solves), What works, What doesn't work yet, Repos changed, New or modified API endpoints, Model changes, Questions for engineers. Output the summary as plain text — it will be saved as notes for this branch.`,
      }, ws, sessionIds);
    } else if (msg.type === "set_model") {
      if (currentQuery) {
        currentQuery.setModel(msg.model === "opus" ? "claude-opus-4-6" : "claude-sonnet-4-6");
        ws.send(JSON.stringify({ type: "model_changed", model: msg.model }));
      }
    }
  });

  async function handleChat(msg, ws, sessionIds) {
    let text = msg.text || msg.prompt || "";
    const sessionId = msg.sessionId || currentSessionId || crypto.randomUUID();
    const model = msg.model === "opus" ? "claude-opus-4-6" : "claude-sonnet-4-6";
    const mode = msg.mode || "build";
    currentSessionId = sessionId;

    // Plan mode — instruct agent to only plan, not execute
    if (mode === "plan") {
      text = `PLAN MODE — Do NOT edit any files, do NOT run any commands, do NOT make any code changes. Only analyze and create a plan.\n\n${text}\n\nRespond with a structured plan:\n1. What needs to change across each layer (frontend, API gateway, core service)\n2. Which specific files will be modified\n3. What the changes will look like\n4. Any risks or considerations\n\nDo NOT write any code. Do NOT use Edit, Write, or Bash tools. Only use Read and Glob to understand the codebase, then respond with the plan.`;
    }

    // Discover mode — read-only exploration
    if (mode === "discover") {
      text = `DISCOVERY MODE — You are exploring the codebase on the main branch. Do NOT edit any files. Do NOT run any commands that modify files. Only use Read, Glob, and Grep to explore and explain the codebase. Answer questions about architecture, patterns, and implementation details.\n\n${text}`;
    }

    // Check daily budget
    const totalCost = getTotalCost();
    if (totalCost >= DAILY_BUDGET) {
      ws.send(JSON.stringify({
        type: "assistant",
        text: `Daily budget reached ($${totalCost.toFixed(2)}/$${DAILY_BUDGET}). Resume tomorrow or contact engineering to increase the limit.`,
        sessionId,
      }));
      return;
    }

    // Lazy context rebuild — on first prompt of resumed session
    let contextPrefix = "";
    if (isFirstMessage && getSession(sessionId)) {
      try {
        const workspaceDir = getWorkspaceDir();
        const gitLogs = [];
        for (const repo of getRepoNames()) {
          try {
            const log = execSync(`git -C "${workspaceDir}/${repo}" log --oneline -5 2>/dev/null`, { stdio: "pipe" }).toString().trim();
            if (log) gitLogs.push(`${repo}:\n${log}`);
          } catch {}
        }
        if (gitLogs.length > 0) {
          contextPrefix = `[Context from previous session — recent git history across repos:\n${gitLogs.join("\n\n")}\n\nContinue from where we left off.]\n\n`;
          console.log("[context] Prepended git history context for resumed session");
        }
      } catch (e) {
        console.error("[context]", e.message);
      }
    }

    // Mark first message processed
    if (isFirstMessage) {
      isFirstMessage = false;
    }

    // Save user message — skip for discover mode
    const branch = msg.branch || null;
    if (mode !== "discover" && !getSession(sessionId)) {
      createSession(sessionId, null, text.slice(0, 50), "", branch);
    }
    if (mode !== "discover") {
      addMessage(sessionId, "user", JSON.stringify({ text }));
    }

    // Determine workspace directories
    const workspaceDir = getWorkspaceDir();
    const additionalDirs = getAdditionalDirs();

    try {
      const q = query({
        prompt: contextPrefix + text,
        options: {
          model,
          tools: { type: "preset", preset: "claude_code" },
          cwd: workspaceDir,
          additionalDirectories: additionalDirs,
          settingSources: ["project"],
          allowedTools: (mode === "plan" || mode === "discover")
            ? ["Read", "Glob", "Grep"]  // Plan/Discover mode: read-only tools
            : ["Read", "Edit", "Write", "Bash", "Glob", "Grep", "WebFetch", "Agent"],
          hooks: {
            PreToolUse: [{
              matcher: ".*",
              callback: (toolName, toolInput) => {
                const check = checkPreToolUse(toolName, toolInput);
                if (!check.allowed) {
                  return { behavior: "deny", message: check.reason };
                }
                // Log tool activity
                ws.send(JSON.stringify({ type: "tool_activity", tool: toolName, input: toolInput }));
                return { behavior: "allow" };
              },
            }],
            PostToolUse: [{
              matcher: ".*",
              callback: (toolName, toolResponse) => {
                ws.send(JSON.stringify({ type: "tool_complete", tool: toolName }));
              },
            }],
          },
        },
      });

      currentQuery = q;

      // Signal thinking state
      ws.send(JSON.stringify({ type: "thinking", sessionId }));

      let fullText = "";
      let gotFirstChunk = false;
      let gotResult = false;
      let lastCost = 0;
      let changedFiles = []; // Track files edited/written by agent
      let lastEditedFile = null;
      const fileContentBefore = new Map(); // Store pre-edit content for diff

      for await (const event of q) {
        if (ws.readyState !== 1) break;

        const etype = event.type;
        const esub = event.subtype || "";

        // Log non-assistant events for debugging
        if (etype !== "assistant") {
          console.log(`[agent] event type=${etype} sub=${esub} keys=${Object.keys(event).join(",")}`);
        }

        // Tool use events — detect from assistant message content blocks
        if (etype === "assistant" && event.message?.content) {
          for (const block of event.message.content) {
            // Stream text
            if (block.type === "text" && block.text) {
              if (!gotFirstChunk) {
                gotFirstChunk = true;
                ws.send(JSON.stringify({ type: "thinking_done", sessionId }));
              }
              fullText += block.text;
              ws.send(JSON.stringify({ type: "assistant_chunk", text: block.text, sessionId }));
            }
            // Tool use block — send activity
            if (block.type === "tool_use") {
              const toolName = block.name || "unknown";
              const toolInput = block.input || {};
              console.log(`[tool] ${toolName}: ${JSON.stringify(toolInput).slice(0, 100)}`);

              // Guardrail check
              const check = checkPreToolUse(toolName, toolInput);
              if (!check.allowed) {
                console.log(`[guardrail] BLOCKED: ${check.reason}`);
              }

              ws.send(JSON.stringify({ type: "tool_activity", tool: toolName, input: toolInput }));

              // Track file changes and reads
              if (toolInput.file_path) {
                if (toolName === "Edit" || toolName === "Write" || toolName === "edit" || toolName === "write") {
                  lastEditedFile = toolInput.file_path;
                  // Capture content before edit for diff
                  if (!fileContentBefore.has(toolInput.file_path)) {
                    try {
                      fileContentBefore.set(toolInput.file_path, readFileSync(toolInput.file_path, "utf8"));
                    } catch { fileContentBefore.set(toolInput.file_path, ""); }
                  }
                  if (!changedFiles.find(f => f.name === toolInput.file_path)) {
                    changedFiles.push({ name: toolInput.file_path, tool: toolName });
                  }
                }
                // Also track reads for Code tab (show last accessed file)
                if (toolName === "Read" || toolName === "read") {
                  if (!lastEditedFile) lastEditedFile = toolInput.file_path;
                }
              }
            }
            // Tool result
            if (block.type === "tool_result") {
              ws.send(JSON.stringify({ type: "tool_complete", tool: block.tool_use_id }));
            }
          }
        }

        // Result event
        if (etype === "result") {
          gotResult = true;
          const cost = event.total_cost_usd || event.cost_usd || event.costUsd || event.usage?.cost_usd || 0;
          lastCost = cost;
          console.log(`[agent] result: cost=$${cost}`);

          if (cost > 0) {
            try { addCost(sessionId, cost); } catch (e) { console.error("[cost]", e.message); }
          }

          // Send file changes for Code tab and diff summary
          if (changedFiles.length > 0) {
            // Compute real line counts
            const filesWithDiff = changedFiles.map(f => {
              try {
                const before = fileContentBefore.get(f.name) || "";
                const after = readFileSync(f.name, "utf8");
                const beforeLines = before.split("\n").length;
                const afterLines = after.split("\n").length;
                const additions = Math.max(0, afterLines - beforeLines);
                const deletions = Math.max(0, beforeLines - afterLines);
                // For edits (same line count), estimate from content diff
                if (additions === 0 && deletions === 0 && before !== after) {
                  const bSet = new Set(before.split("\n"));
                  const aSet = new Set(after.split("\n"));
                  let changed = 0;
                  for (const line of aSet) { if (!bSet.has(line)) changed++; }
                  return { ...f, additions: changed, deletions: changed };
                }
                return { ...f, additions, deletions };
              } catch {
                return { ...f, additions: 0, deletions: 0 };
              }
            });
            ws.send(JSON.stringify({ type: "file_diff", files: filesWithDiff }));
          }
          if (lastEditedFile) {
            try {
              const content = readFileSync(lastEditedFile, "utf8");
              ws.send(JSON.stringify({ type: "code_update", path: lastEditedFile, content }));
            } catch (e) { console.error("[code]", e.message); }
          }

          // Take screenshot if frontend files were changed
          const frontendName = getFrontendRepo()?.name;
          const touchedFrontend = frontendName && changedFiles.some(f => f.name.includes(frontendName));
          if (touchedFrontend) {
            try {
              const screenshotData = await takeScreenshot();
              if (screenshotData) {
                ws.send(JSON.stringify({
                  type: "screenshot",
                  image: screenshotData,
                  caption: changedFiles.filter(f => f.name.includes(frontendName)).map(f => f.name.split("/").pop()).join(", "),
                }));
              }
            } catch (e) { console.error("[screenshot]", e.message); }
          }

          ws.send(JSON.stringify({
            type: "assistant_done",
            text: fullText,
            sessionId,
            cost,
            totalCost: getTotalCost(),
          }));

          if (mode !== "discover") {
            try { addMessage(sessionId, "assistant", JSON.stringify({ text: fullText })); } catch (e) { console.error("[db]", e.message); }
          }

          // Only checkpoint when files were actually changed
          if (changedFiles.length > 0) {
            try {
              // Label from user prompt + files changed (not agent's thinking text)
              const promptClean = text.replace(/^(PLAN MODE|VISUAL EDIT REQUEST)[^\n]*/i, "").trim();
              const promptShort = promptClean.split("\n")[0].slice(0, 40);
              const fileNames = changedFiles.map(f => f.name.split("/").pop()).slice(0, 3).join(", ");
              const label = promptShort + (fileNames ? " → " + fileNames : "");
              const checkpoint = createCheckpoint(label, branch);
              ws.send(JSON.stringify({
                type: "checkpoint_created",
                name: checkpoint,
                label,
                files: changedFiles.length,
              }));
            } catch (e) { console.error("[checkpoint]", e.message); }
          }
        }
      }

      // If loop ended without a result event, still send done
      if (!gotResult && fullText) {
        console.log("[agent] stream ended without result event — sending done");
        try { addMessage(sessionId, "assistant", JSON.stringify({ text: fullText })); } catch {}
        ws.send(JSON.stringify({
          type: "assistant_done",
          text: fullText,
          sessionId,
          cost: lastCost,
          totalCost: getTotalCost(),
        }));
      }

      if (!gotFirstChunk) {
        ws.send(JSON.stringify({ type: "thinking_done", sessionId }));
      }

      if (!gotFirstChunk) {
        ws.send(JSON.stringify({ type: "thinking_done", sessionId }));
      }

      currentQuery = null;
    } catch (err) {
      console.error("[agent] Error:", err.message, err.stack?.split("\n").slice(0, 3).join("\n"));
      try {
        ws.send(JSON.stringify({
          type: "error",
          text: `Agent error: ${err.message}`,
          sessionId,
        }));
      } catch {}
      currentQuery = null;
    }
  }

  ws.on("close", () => {
    if (currentQuery) {
      try { currentQuery.close(); } catch {}
      currentQuery = null;
    }
  });
}
