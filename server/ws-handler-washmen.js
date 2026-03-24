import { query } from "@anthropic-ai/claude-agent-sdk";
import crypto from "crypto";
import { execSync, spawn } from "child_process";
import { readFileSync } from "fs";
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
  touchSession,
  addMessage,
  addCost,
  getTotalCost,
  updateClaudeSessionId,
  getClaudeSessionId,
  setClaudeSession,
} from "../db.js";

const DAILY_BUDGET = 20; // $20/day
const PER_QUERY_BUDGET = 5; // $5 per query — enough for complex features, catches runaway loops

const DEFAULT_MODEL = "claude-sonnet-4-6";
const MODEL_MAP = { opus: "claude-opus-4-6", sonnet: "claude-sonnet-4-6", haiku: "claude-haiku-4-5-20251001" };

// System prompts for each mode — enforced via SDK systemPrompt, not text injection
const PLAN_SYSTEM_PROMPT = `You are in PLAN MODE. You must NOT edit any files, run any commands, or make any code changes. You must NOT use Edit, Write, or Bash tools. Only use Read, Glob, and Grep to understand the codebase. Answer questions and create plans — never execute them.`;

const PLAN_FIRST_TURN_APPEND = `\n\nRespond with a structured plan:\n1. What needs to change across each layer (frontend, API gateway, core service)\n2. Which specific files will be modified\n3. What the changes will look like\n4. Any risks or considerations`;

const DISCOVER_SYSTEM_PROMPT = `You are in DISCOVERY MODE, exploring the codebase on the main branch. You must NOT edit any files or run commands that modify files. Only use Read, Glob, and Grep to explore and explain the codebase. Answer questions about architecture, patterns, and implementation details.`;

const BUILD_SYSTEM_PROMPT = `Important workspace rules:
- Use Read, Glob, and Grep directly for file exploration. Only use Agent sub-agents for tasks that genuinely require parallel deep research across many files.
- After modifying backend files (controllers, routes, models, config), backend services are auto-restarted by the system — do NOT restart them yourself.`;

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

// Push only repos with actual changes to origin (non-blocking, fail-silent)
function pushBranch(branch) {
  const workspaceDir = getWorkspaceDir();
  const repos = getRepoNames();

  for (const repo of repos) {
    const repoDir = `${workspaceDir}/${repo}`;
    try {
      // Commit any uncommitted changes
      const status = execSync(`git -C "${repoDir}" status --porcelain`, { stdio: "pipe" }).toString().trim();
      if (status) {
        execSync(`git -C "${repoDir}" add -A && git -C "${repoDir}" commit -m "auto: checkpoint"`, { stdio: "pipe", timeout: 10000 });
      }

      // Only push if branch has commits ahead of main/master
      let ahead = "0";
      try {
        ahead = execSync(`git -C "${repoDir}" rev-list --count main..HEAD 2>/dev/null || git -C "${repoDir}" rev-list --count master..HEAD 2>/dev/null`, { stdio: "pipe" }).toString().trim();
      } catch {}

      if (ahead !== "0") {
        execSync(`git -C "${repoDir}" push -u origin "${branch}" 2>/dev/null`, { stdio: "pipe", timeout: 30000 });
        console.log(`[push] ${repo}: pushed ${branch} (${ahead} commits ahead)`);
      } else {
        console.log(`[push] ${repo}: no changes, skipped`);
      }
    } catch (e) {
      console.log(`[push] ${repo}: skipped (${e.message.split("\n")[0]})`);
    }
  }
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

  // Push newly created branches to origin
  pushBranch(branchName);

  return results;
}

export function handleWashmenWs(ws, sessionIds) {
  let currentSessionId = null;
  let currentQuery = null;

  ws.on("message", async (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      return;
    }

    // Handle different message types
    if (msg.type === "stop") {
      if (currentQuery) {
        try { currentQuery.close(); } catch {}
        currentQuery = null;
        ws.send(JSON.stringify({ type: "system", text: "Agent stopped." }));
        ws.send(JSON.stringify({ type: "assistant_done", text: "", sessionId: currentSessionId, cost: 0, totalCost: 0 }));
      }
      return;
    }

    if (msg.type === "chat") {
      await handleChat(msg, ws, sessionIds);
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
      // Generate notes via direct API call — no agent, no chat pollution
      const noteBranch = msg.branch || "main";
      const workspaceDir = getWorkspaceDir();
      let diffContext = "";
      for (const repo of getRepoNames()) {
        try {
          const log = execSync(`git -C "${workspaceDir}/${repo}" log --oneline main..HEAD 2>/dev/null || git -C "${workspaceDir}/${repo}" log --oneline master..HEAD 2>/dev/null`, { stdio: "pipe", timeout: 5000 }).toString().trim();
          const diff = execSync(`git -C "${workspaceDir}/${repo}" diff main..HEAD --stat 2>/dev/null || git -C "${workspaceDir}/${repo}" diff master..HEAD --stat 2>/dev/null`, { stdio: "pipe", timeout: 5000 }).toString().trim();
          if (log || diff) {
            diffContext += `\n## ${repo}\nCommits:\n${log || "(no commits)"}\n\nFiles changed:\n${diff || "(none)"}\n`;
          } else {
            diffContext += `\n## ${repo}\n(no changes on this branch)\n`;
          }
        } catch { diffContext += `\n## ${repo}\n(no changes or not on a feature branch)\n`; }
      }

      try {
        const apiKey = process.env.ANTHROPIC_API_KEY;
        if (!apiKey) throw new Error("ANTHROPIC_API_KEY not set");

        const resp = await fetch("https://api.anthropic.com/v1/messages", {
          method: "POST",
          headers: {
            "x-api-key": apiKey,
            "content-type": "application/json",
            "anthropic-version": "2023-06-01",
          },
          body: JSON.stringify({
            model: "claude-sonnet-4-20250514",
            max_tokens: 1024,
            messages: [{
              role: "user",
              content: `Summarize what was built on branch "${noteBranch}". Be concise — 4 sections max.\n\n${diffContext}\n\nFormat:\n## What was built\n## What works\n## What's left\n## Questions for engineers`,
            }],
          }),
        });
        const data = await resp.json();
        const notes = data.content?.[0]?.text || "No changes found on this branch.";

        // Save to DB and send directly to notes panel
        const { saveNotes } = await import("../db.js");
        saveNotes(noteBranch, notes);
        ws.send(JSON.stringify({ type: "notes_generated", branch: noteBranch, content: notes }));
      } catch (e) {
        console.error("[notes]", e.message);
        ws.send(JSON.stringify({ type: "notes_generated", branch: noteBranch, content: `Error generating notes: ${e.message}` }));
      }
    } else if (msg.type === "set_model") {
      if (currentQuery) {
        currentQuery.setModel(MODEL_MAP[msg.model] || DEFAULT_MODEL);
        ws.send(JSON.stringify({ type: "model_changed", model: msg.model }));
      }
    }
  });

  async function handleChat(msg, ws, sessionIds) {
    let text = msg.text || msg.prompt || "";
    const sessionId = msg.sessionId || currentSessionId || crypto.randomUUID();
    const model = MODEL_MAP[msg.model] || DEFAULT_MODEL;
    const mode = msg.mode || "build";
    currentSessionId = sessionId;

    // Build system prompt based on mode
    let systemPrompt = undefined;
    if (mode === "plan") {
      const isFirstTurn = !getSession(sessionId);
      systemPrompt = {
        type: "preset",
        preset: "claude_code",
        append: isFirstTurn ? PLAN_SYSTEM_PROMPT + PLAN_FIRST_TURN_APPEND : PLAN_SYSTEM_PROMPT,
      };
    } else if (mode === "discover") {
      systemPrompt = {
        type: "preset",
        preset: "claude_code",
        append: DISCOVER_SYSTEM_PROMPT,
      };
    } else {
      // Build mode
      systemPrompt = {
        type: "preset",
        preset: "claude_code",
        append: BUILD_SYSTEM_PROMPT,
      };
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

    // Session resumption — resume on every turn so the agent has conversation context.
    // Each handleChat creates a new query(), so without resume it starts with zero history.
    let claudeSessionIdToResume = null;
    if (getSession(sessionId)) {
      try {
        const stored = getClaudeSessionId(sessionId, "");
        if (stored) {
          claudeSessionIdToResume = stored;
          console.log(`[context] Resuming Claude session: ${stored}`);
        } else {
          console.log("[context] No Claude session ID stored — starting fresh");
        }
      } catch (e) {
        console.error("[context]", e.message);
      }
    }

    // Save user message — skip for discover mode
    const branch = msg.branch || null;
    if (mode !== "discover" && !getSession(sessionId)) {
      createSession(sessionId, null, text.slice(0, 50), "", branch);
    } else if (mode !== "discover") {
      touchSession(sessionId);
    }
    if (mode !== "discover") {
      addMessage(sessionId, "user", JSON.stringify({ text }));
    }

    // Determine workspace directories
    const workspaceDir = getWorkspaceDir();
    const additionalDirs = getAdditionalDirs();

    try {
      const queryOptions = {
        model,
        tools: { type: "preset", preset: "claude_code" },
        cwd: workspaceDir,
        additionalDirectories: additionalDirs,
        settingSources: ["project"],
        thinking: { type: "adaptive" },
        maxBudgetUsd: PER_QUERY_BUDGET,
        maxTurns: 50,
        allowedTools: (mode === "plan" || mode === "discover")
            ? ["Read", "Glob", "Grep"]  // Plan/Discover mode: read-only tools
            : ["Read", "Edit", "Write", "Bash", "Glob", "Grep", "WebFetch", "Agent"],
        hooks: {
          PreToolUse: [{
            matcher: ".*",
            hooks: [async (input, toolUseId, { signal }) => {
              const toolName = input.tool_name;
              const toolInput = input.tool_input || {};
              const check = checkPreToolUse(toolName, toolInput);
              if (!check.allowed) {
                console.log(`[guardrail] BLOCKED: ${check.reason}`);
                return {
                  decision: "block",
                  reason: check.reason,
                  hookSpecificOutput: {
                    hookEventName: "PreToolUse",
                    permissionDecision: "deny",
                    permissionDecisionReason: check.reason,
                  },
                };
              }
              if (ws.readyState === 1) {
                ws.send(JSON.stringify({ type: "tool_activity", tool: toolName, input: toolInput }));
              }
              return {};
            }],
          }],
          PostToolUse: [{
            matcher: ".*",
            hooks: [async (input, toolUseId, { signal }) => {
              const toolName = input.tool_name;
              if (ws.readyState === 1) {
                ws.send(JSON.stringify({ type: "tool_complete", tool: toolName }));
              }
              return {};
            }],
          }],
        },
      };

      // Use systemPrompt for mode constraints (more authoritative than text injection)
      if (systemPrompt) {
        queryOptions.systemPrompt = systemPrompt;
      }

      // Resume previous Claude session if available
      if (claudeSessionIdToResume) {
        queryOptions.resume = claudeSessionIdToResume;
        console.log(`[agent] Resuming session ${claudeSessionIdToResume}`);
      }

      const q = query({
        prompt: text,
        options: queryOptions,
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
        const wsOpen = ws.readyState === 1;
        const etype = event.type;
        const esub = event.subtype || "";

        // Log non-assistant events for debugging
        if (etype !== "assistant") {
          const extra = (etype === "system" && esub === "init") ? ` model=${event.model}` : "";
          console.log(`[agent] event type=${etype} sub=${esub}${extra}`);
        }

        // Capture Claude session ID from init event and store it
        if (etype === "system" && esub === "init" && event.session_id) {
          try {
            updateClaudeSessionId(sessionId, event.session_id);
            setClaudeSession(sessionId, "", event.session_id);
            console.log(`[session] Stored Claude session ID: ${event.session_id} for session ${sessionId}`);
          } catch (e) {
            console.error("[session] Failed to store Claude session ID:", e.message);
          }
        }

        // Tool use events — detect from assistant message content blocks
        if (etype === "assistant" && event.message?.content) {
          for (const block of event.message.content) {
            // Stream text
            if (block.type === "text" && block.text) {
              if (!gotFirstChunk) {
                gotFirstChunk = true;
                if (wsOpen) ws.send(JSON.stringify({ type: "thinking_done", sessionId }));
              }
              fullText += block.text;
              if (wsOpen) ws.send(JSON.stringify({ type: "assistant_chunk", text: block.text, sessionId }));
            }
            // Tool use block — track file changes (guardrail runs in PreToolUse hook)
            if (block.type === "tool_use") {
              const toolName = block.name || "unknown";
              const toolInput = block.input || {};
              console.log(`[tool] ${toolName}: ${JSON.stringify(toolInput).slice(0, 100)}`);

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
            // Tool result — PostToolUse hook handles tool_complete, no duplicate needed
          }
        }

        // Result event
        if (etype === "result") {
          gotResult = true;
          const cost = event.total_cost_usd || event.cost_usd || event.costUsd || event.usage?.cost_usd || 0;
          lastCost = cost;
          const subtype = event.subtype || "";
          console.log(`[agent] result: cost=$${cost} subtype=${subtype}`);

          // Notify user if query was cut short by limits
          if (subtype === "error_max_budget_usd" && wsOpen) {
            ws.send(JSON.stringify({ type: "system", text: `Query stopped — reached $${PER_QUERY_BUDGET} budget limit. Send another message to continue.` }));
          } else if (subtype === "error_max_turns" && wsOpen) {
            ws.send(JSON.stringify({ type: "system", text: "Query stopped — reached turn limit. Send another message to continue." }));
          }

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
            if (wsOpen) ws.send(JSON.stringify({ type: "file_diff", files: filesWithDiff }));
          }
          if (lastEditedFile) {
            try {
              const content = readFileSync(lastEditedFile, "utf8");
              if (wsOpen) ws.send(JSON.stringify({ type: "code_update", path: lastEditedFile, content }));
            } catch (e) { console.error("[code]", e.message); }
          }

          // Auto-restart backend services when their files were modified
          // Sails.js (and most Node backends) don't hot-reload controllers/routes/models
          const configRepos = getConfig().repos;
          const restartedServices = [];
          for (const repo of configRepos) {
            if (repo.type === "frontend" || !repo.port || !repo.dev) continue;
            const touchedBackend = changedFiles.some(f => f.name.includes(repo.name));
            if (touchedBackend) {
              try {
                try { execSync(`kill $(lsof -ti:${repo.port} -sTCP:LISTEN) 2>/dev/null`, { stdio: "pipe" }); } catch {}
                const logFile = `/tmp/${repo.name}.log`;
                spawn("bash", ["-c", `cd "${workspaceDir}/${repo.name}" && ${repo.dev} >> ${logFile} 2>&1`], { detached: true, stdio: "ignore" }).unref();
                restartedServices.push(repo.name);
                console.log(`[auto-restart] ${repo.name} on :${repo.port}`);
              } catch (e) { console.error(`[auto-restart] ${repo.name} failed:`, e.message); }
            }
          }
          if (restartedServices.length > 0 && wsOpen) {
            ws.send(JSON.stringify({ type: "system", text: `Auto-restarted: ${restartedServices.join(", ")}` }));
          }

          // Take screenshot if frontend files were changed
          const frontendName = getFrontendRepo()?.name;
          const touchedFrontend = frontendName && changedFiles.some(f => f.name.includes(frontendName));
          if (touchedFrontend) {
            try {
              const screenshotData = await takeScreenshot();
              if (screenshotData) {
                if (wsOpen) ws.send(JSON.stringify({
                  type: "screenshot",
                  image: screenshotData,
                  caption: changedFiles.filter(f => f.name.includes(frontendName)).map(f => f.name.split("/").pop()).join(", "),
                }));
              }
            } catch (e) { console.error("[screenshot]", e.message); }
          }

          if (wsOpen) ws.send(JSON.stringify({
            type: "assistant_done",
            text: fullText,
            sessionId,
            cost,
            totalCost: getTotalCost(),
          }));

          if (mode !== "discover") {
            try { addMessage(sessionId, "assistant", JSON.stringify({ text: fullText })); } catch (e) { console.error("[db]", e.message); }
          }

          // Auto-push branch to origin when files were changed
          if (changedFiles.length > 0 && branch && !branch.match(/^(main|master)$/)) {
            try {
              pushBranch(branch);
              if (wsOpen) ws.send(JSON.stringify({ type: "system", text: `Pushed ${branch} to origin` }));
            } catch (e) { console.log("[push] post-change push failed:", e.message); }
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

  // Don't kill the query on WS disconnect — let it finish so the session
  // remains resumable. Claude Code CLI doesn't abort on terminal disconnect.
  ws.on("close", () => {
    console.log("[ws] Client disconnected" + (currentQuery ? " — agent still running, session will be resumable" : ""));
  });
}
