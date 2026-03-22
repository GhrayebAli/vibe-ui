import { query } from "@anthropic-ai/claude-agent-sdk";
import crypto from "crypto";
import { execSync } from "child_process";
import { readFileSync } from "fs";

// Screenshot capture using Playwright
async function takeScreenshot() {
  try {
    const result = execSync(
      'node -e "const{chromium}=require(\'playwright\');(async()=>{const b=await chromium.launch();const p=await b.newPage({viewport:{width:1280,height:720}});await p.goto(\'http://localhost:3000\',{waitUntil:\'networkidle\',timeout:10000});await p.waitForTimeout(1000);const buf=await p.screenshot();await b.close();process.stdout.write(buf.toString(\'base64\'));})()"',
      { cwd: "/workspaces/washmen-mvp-workspace", timeout: 20000, maxBuffer: 10 * 1024 * 1024 }
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
  const workspaceDir = process.env.WORKSPACE_DIR || "/workspaces/washmen-mvp-workspace";
  const repos = ["mock-ops-frontend", "mock-api-gateway", "mock-core-service", "."];
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

// Create checkpoint tags across all repos
function createCheckpoint(label) {
  const workspaceDir = process.env.WORKSPACE_DIR || "/workspaces/washmen-mvp-workspace";
  const repos = ["mock-ops-frontend", "mock-api-gateway", "mock-core-service"];

  // Find next checkpoint number
  let maxNum = 0;
  for (const repo of repos) {
    try {
      const tags = execSync(`git -C "${workspaceDir}/${repo}" tag -l "checkpoint/*"`, { stdio: "pipe" }).toString().trim();
      for (const tag of tags.split("\n")) {
        const num = parseInt(tag.split("/")[1]);
        if (num > maxNum) maxNum = num;
      }
    } catch {}
  }

  const checkpointName = `checkpoint/${String(maxNum + 1).padStart(3, "0")}`;
  for (const repo of repos) {
    try {
      execSync(`git -C "${workspaceDir}/${repo}" tag -a "${checkpointName}" -m "${label}"`, { stdio: "pipe" });
    } catch {}
  }
  return checkpointName;
}

// Undo to previous checkpoint
function undoToLastCheckpoint() {
  const workspaceDir = process.env.WORKSPACE_DIR || "/workspaces/washmen-mvp-workspace";
  const repos = ["mock-ops-frontend", "mock-api-gateway", "mock-core-service"];
  const results = [];

  for (const repo of repos) {
    try {
      const tags = execSync(`git -C "${workspaceDir}/${repo}" tag -l "checkpoint/*" --sort=-version:refname`, { stdio: "pipe" })
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
      const results = undoToLastCheckpoint();
      ws.send(JSON.stringify({ type: "undo_result", results }));
    } else if (msg.type === "restart_services") {
      ws.send(JSON.stringify({ type: "system", text: "Restarting services..." }));
      // Services are managed by the Codespace — send a signal to restart
      try {
        const workspaceDir = process.env.WORKSPACE_DIR || "/workspaces/washmen-mvp-workspace";
        execSync(`bash "${workspaceDir}/.devcontainer/start.sh" &`, { stdio: "pipe", timeout: 5000 });
        ws.send(JSON.stringify({ type: "system", text: "Services restart initiated" }));
      } catch {
        ws.send(JSON.stringify({ type: "system", text: "Service restart failed — try refreshing the Codespace" }));
      }
    } else if (msg.type === "generate_mvp_notes") {
      // Send a special prompt to the agent to generate MVP_NOTES.md
      await handleChat({
        ...msg,
        type: "chat",
        text: `Generate MVP_NOTES.md in the workspace root (/workspaces/washmen-mvp-workspace/MVP_NOTES.md). Read the git log across all repos, examine the code changes, and populate all sections: What was built, Why (problem it solves), What works, What doesn't work yet, Repos changed, New or modified API endpoints, Model changes, Hooks consumed, Questions for engineers.`,
      }, ws, sessionIds);
    } else if (msg.type === "set_model") {
      if (currentQuery) {
        currentQuery.setModel(msg.model === "opus" ? "claude-opus-4-6" : "claude-sonnet-4-6");
        ws.send(JSON.stringify({ type: "model_changed", model: msg.model }));
      }
    }
  });

  async function handleChat(msg, ws, sessionIds) {
    const text = msg.text || msg.prompt || "";
    const sessionId = msg.sessionId || currentSessionId || crypto.randomUUID();
    const model = msg.model === "opus" ? "claude-opus-4-6" : "claude-sonnet-4-6";
    currentSessionId = sessionId;

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
        const workspaceDir = process.env.WORKSPACE_DIR || "/workspaces/washmen-mvp-workspace";
        const gitLogs = [];
        for (const repo of ["mock-ops-frontend", "mock-api-gateway", "mock-core-service"]) {
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

    // Onboarding: first message creates branches
    if (isFirstMessage && !msg.skipOnboarding) {
      isFirstMessage = false;

      // Check if we're already on an mvp/* branch
      try {
        const workspaceDir = process.env.WORKSPACE_DIR || "/workspaces/washmen-mvp-workspace";
        const branch = execSync(`git -C "${workspaceDir}/mock-ops-frontend" rev-parse --abbrev-ref HEAD`, { stdio: "pipe" }).toString().trim();
        if (branch.startsWith("mvp/")) {
          // Already on an mvp branch — session resume
          ws.send(JSON.stringify({
            type: "assistant",
            text: `Welcome back! You're on branch \`${branch}\`. Let me check where you left off...`,
            sessionId,
          }));
        }
      } catch {}
    }

    // Save user message
    if (!getSession(sessionId)) {
      createSession(sessionId, null, text.slice(0, 50), "");
    }
    addMessage(sessionId, "user", JSON.stringify({ text }));

    // Determine workspace directories
    const workspaceDir = process.env.WORKSPACE_DIR || "/workspaces/washmen-mvp-workspace";
    const additionalDirs = [
      `${workspaceDir}/mock-ops-frontend`,
      `${workspaceDir}/mock-api-gateway`,
      `${workspaceDir}/mock-core-service`,
    ];

    try {
      const q = query({
        prompt: contextPrefix + text,
        options: {
          model,
          tools: { type: "preset", preset: "claude_code" },
          cwd: workspaceDir,
          additionalDirectories: additionalDirs,
          settingSources: ["project"],
          allowedTools: ["Read", "Edit", "Write", "Bash", "Glob", "Grep", "WebFetch", "Agent"],
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
          const touchedFrontend = changedFiles.some(f => f.name.includes("mock-ops-frontend"));
          if (touchedFrontend) {
            try {
              const screenshotData = await takeScreenshot();
              if (screenshotData) {
                ws.send(JSON.stringify({
                  type: "screenshot",
                  image: screenshotData,
                  caption: changedFiles.filter(f => f.name.includes("mock-ops-frontend")).map(f => f.name.split("/").pop()).join(", "),
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

          try { addMessage(sessionId, "assistant", JSON.stringify({ text: fullText })); } catch (e) { console.error("[db]", e.message); }

          if (fullText.toLowerCase().match(/done|complete|✓|finished/)) {
            try {
              const checkpoint = createCheckpoint(text.slice(0, 40));
              ws.send(JSON.stringify({ type: "checkpoint_created", name: checkpoint }));
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
