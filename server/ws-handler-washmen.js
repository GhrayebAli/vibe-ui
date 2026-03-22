import { query } from "@anthropic-ai/claude-agent-sdk";
import crypto from "crypto";
import { execSync } from "child_process";
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
        prompt: text,
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

      let fullText = "";
      for await (const event of q) {
        if (ws.readyState !== 1) break;

        if (event.type === "assistant" && event.message?.content) {
          for (const block of event.message.content) {
            if (block.type === "text") {
              fullText += block.text;
              ws.send(JSON.stringify({
                type: "assistant_chunk",
                text: block.text,
                sessionId,
              }));
            }
          }
        }

        if (event.type === "result") {
          // Extract cost
          const cost = event.cost_usd || 0;
          if (cost > 0) addCost(sessionId, cost);

          ws.send(JSON.stringify({
            type: "assistant_done",
            text: fullText,
            sessionId,
            cost,
            totalCost: getTotalCost(),
          }));

          // Save assistant message
          addMessage(sessionId, "assistant", JSON.stringify({ text: fullText }));

          // Check if we should create a checkpoint
          if (fullText.includes("✓") || fullText.includes("done") || fullText.includes("complete")) {
            try {
              const checkpoint = createCheckpoint(text.slice(0, 40));
              ws.send(JSON.stringify({ type: "checkpoint_created", name: checkpoint }));
            } catch {}
          }
        }
      }

      currentQuery = null;
    } catch (err) {
      ws.send(JSON.stringify({
        type: "error",
        text: `Agent error: ${err.message}`,
        sessionId,
      }));
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
