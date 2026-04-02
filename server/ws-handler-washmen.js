import { query } from "@anthropic-ai/claude-agent-sdk";
import crypto from "crypto";
import { execSync, spawn } from "child_process";
import { hostname } from "os";
import { readFileSync, existsSync } from "fs";
import { join } from "path";
import { getWorkspaceDir, getConfig, getRepoNames, getFrontendRepo, getFrontendPort, getAdditionalDirs } from "./workspace-config.js";
import { sanitizeBranchName } from "./sanitize.js";
import { getRulesPrompt, getAgentDefinitions, getQualityHooks } from "./claude-setup/loader.js";

// Load quality infrastructure at startup (once)
const eliteAgentDefs = getAgentDefinitions();
const eliteRulesPrompt = getRulesPrompt();
const eliteQualityHooks = getQualityHooks();

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
  updateSessionTitle,
  logActivityEvent,
} from "../db.js";

const DAILY_BUDGET = 60; // $60/day
const PER_QUERY_BUDGET = 5; // $5 per query — enough for complex features, catches runaway loops

const DEFAULT_MODEL = "claude-sonnet-4-6";
const MODEL_MAP = { opus: "claude-opus-4-6", sonnet: "claude-sonnet-4-6", haiku: "claude-haiku-4-5-20251001" };

// Tone: keep responses non-technical for non-engineer users
const TONE_INSTRUCTION = `\nWhen responding to the user, write in plain, non-technical language. Avoid jargon, file paths, code snippets, and implementation details unless the user explicitly asks. Focus on what changed and what it means, not how it was done. Keep responses short and friendly.`;

// System prompts for each mode — enforced via SDK systemPrompt, not text injection
const PLAN_SYSTEM_PROMPT = `You are in PLAN MODE. You must NOT edit any files, run any commands, or make any code changes. You must NOT use Edit, Write, or Bash tools. Only use Read, Glob, and Grep to understand the codebase. Answer questions and create plans — never execute them.` + TONE_INSTRUCTION;

const PLAN_FIRST_TURN_APPEND = `\n\nRespond with a structured plan:\n1. What needs to change across each layer (frontend, API gateway, core service)\n2. Which specific files will be modified\n3. What the changes will look like\n4. Any risks or considerations`;

const DISCOVER_SYSTEM_PROMPT = `You are in DISCOVERY MODE, exploring the codebase on the main branch. You must NOT edit any files or run commands that modify files. Only use Read, Glob, and Grep to explore and explain the codebase. Answer questions about architecture, patterns, and implementation details.` + TONE_INSTRUCTION;

const BUILD_SYSTEM_PROMPT = `You are a coding agent inside a GitHub Codespace. Users interact with you through a dashboard — they are non-technical and do not see code, terminals, or file paths.

## Communication
- Write in plain, non-technical language. No jargon, file paths, or code snippets unless the user explicitly asks.
- Focus on what changed and what it means, not how it was done.
- Keep responses short and friendly.
- If something fails, explain what went wrong and what you will try next — do not dump error logs.

## Code Quality Standards
- Read target files before modifying. Match existing patterns and architecture.
- Check for unused imports, dead code, or duplicated logic before finishing.
- See appended Coding Style rules for full standards.

## UI/UX Standards
- Reuse existing components. Handle all interaction states. Ensure accessibility and responsiveness.
- See appended UI/UX rules for full standards.

## Research Before Building
- For non-trivial tasks: read related files, trace similar implementations, identify dependencies. Plan before writing.

## Self-Review Before Finishing
- Re-read every file you changed. Verify requirements are met. Check error messages are user-friendly. Summarize what changed in plain language.

## When to Use Specialist Agents
You have specialist agents available via the Agent tool. Use them:
- **frontend-design**: For building new pages, components, or UI from scratch. Also for UI/UX assessments and visual improvements.
- **code-reviewer**: For reviewing code quality, catching bugs, and security issues after changes.
- **architect**: For system design decisions, evaluating trade-offs, or planning complex features.
- **planner**: For breaking down large features into implementation steps.
- **security-reviewer**: For reviewing auth, payments, user data handling, or API security.
- **build-error-resolver**: When a build or compile fails and you need to diagnose and fix it.
- **refactor-cleaner**: For finding dead code, unused imports, or duplicated logic to clean up.

## Allowed
- Add pages, components, views, API endpoints, routes
- Fix bugs, improve UI/UX
- Additive modifications to existing code
- Install packages when needed to complete a task

## Forbidden (enforced — attempts will be blocked)
- Editing auth, middleware, or policy files
- Reading or writing .env files, credentials, secrets, .pem/.key files
- Running database migrations, seeds, DROP, DELETE FROM, TRUNCATE, ALTER TABLE
- Bulk data operations: .destroy({}), .destroy(), .update({}) with no criteria
- Raw database access: .native(), .getDatastore().sendNativeQuery()
- Importing child_process
- Running sudo, rm -rf, kill, chmod, chown, reboot, shutdown
- Piping curl/wget into sh/bash
- Accessing /etc/ or /proc/
- Pushing to main or master

## Forbidden (not enforced — you must self-enforce)
- Hardcoding credentials or environment-specific values
- Modifying deployment, infrastructure, or CI/CD configuration
- Modifying service startup scripts or port configuration
- Creating or modifying database models or schemas

## Git
- Do NOT create branches. Branches are pre-created by the system. Always work on the current branch.
- After every code change: commit AND push immediately. Never ask for permission.
- Use sub-repo directories for git commands (e.g., git -C <repo-dir>), not the workspace root.
- Write concise, descriptive commit messages.

## Services
- All services auto-restart on file changes. Never restart them manually.

## Tools
- Use Read, Glob, Grep for file exploration. Do not use Bash to read files.
- Only use Agent sub-agents for parallel research across many files.
- Read existing code before modifying it.`;

// PreToolUse guardrail patterns
const BLOCKED_BASH_PATTERNS = [
  // Database operations
  /migrate/i, /db:seed/i, /DROP\s/i, /DELETE\s+FROM/i, /TRUNCATE/i, /ALTER\s+TABLE/i,
  /git\s+push\s+.*\s*(master|main)\b/i,
  // Dangerous shell patterns
  /\bsudo\b/i,
  /\brm\s+-rf?\b/i,
  /\bcurl\b.*\|\s*(sh|bash)\b/,
  /\bwget\b.*\|\s*(sh|bash)\b/,
  /\bchmod\b/i,
  /\bchown\b/i,
  /\bkill\b/i,
  /\bpkill\b/i,
  /\breboot\b/i,
  /\bshutdown\b/i,
  /\bnc\s+-l/i,
  /\bprintenv\b/,
  /\/etc\//,
  /\/proc\//,
  /\.env\b/,
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
  /\.env$/i, /\.env\./i,
  /credentials/i,
  /secrets?\./i,
  /\.pem$/i, /\.key$/i,
  /workspace\.json$/i,
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
      // Commit any uncommitted changes with a descriptive message
      const status = execSync(`git -C "${repoDir}" status --porcelain`, { stdio: "pipe" }).toString().trim();
      if (status) {
        const files = status.split("\n").map(l => l.trim().replace(/^[A-Z?]+\s+/, ""));
        const summary = files.length <= 3
          ? files.join(", ")
          : `${files.slice(0, 3).join(", ")} (+${files.length - 3} more)`;
        const commitMsg = `auto: ${summary}`;
        execSync(`git -C "${repoDir}" add -A && git -C "${repoDir}" commit -m ${JSON.stringify(commitMsg)}`, { stdio: "pipe", timeout: 10000 });
      }

      // Only push if branch has commits ahead of main/master
      let ahead = "0";
      try {
        ahead = execSync(`git -C "${repoDir}" rev-list --count main..HEAD 2>/dev/null || git -C "${repoDir}" rev-list --count master..HEAD 2>/dev/null`, { stdio: "pipe" }).toString().trim();
      } catch (e) { console.warn("[push] rev-list count failed:", e.message); }

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

// Per-session changed files tracking (sessionId -> Set of file paths with metadata)
const sessionChangedFiles = new Map();

export function getSessionChangedFiles(sessionId) {
  return sessionChangedFiles.get(sessionId) || [];
}

export function handleWashmenWs(ws, sessionIds, presence = null, broadcastToBranch = null) {
  let currentSessionId = null;
  let currentQuery = null;

  ws.on("message", async (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      return;
    }

    // ── Multi-user presence message types ──
    if (msg.type === "identify") {
      if (presence && ws.__id) {
        presence.addUser(ws.__id, msg.name || "anonymous", msg.role || "other");
      }
      return;
    }

    if (msg.type === "heartbeat") {
      if (presence && ws.__id) {
        presence.heartbeat(ws.__id);
      }
      return;
    }

    if (msg.type === "take_over") {
      if (presence && ws.__id) {
        const result = presence.takeOver(ws.__id);
        ws.send(JSON.stringify({ type: result.ok ? "build_lock_acquired" : "build_locked", ...result }));
      }
      return;
    }

    if (msg.type === "branch_switch") {
      if (presence && ws.__id && msg.branch) {
        presence.switchBranch(ws.__id, msg.branch);
      }
      return;
    }

    if (msg.type === "release_lock") {
      if (presence && ws.__id) {
        presence.releaseLock(ws.__id);
      }
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
      // Check build lock for build mode (skip for discover/plan)
      const chatMode = msg.mode || "build";
      if (chatMode === "build" && presence && ws.__id) {
        const lockResult = presence.acquireLock(ws.__id);
        if (!lockResult.ok) {
          ws.send(JSON.stringify({
            type: "build_locked",
            lockedBy: lockResult.lockedBy,
            lockedSince: lockResult.lockedSince,
            branch: lockResult.branch,
          }));
          return;
        }
        // Log chat event and update branch
        presence.onChatSent(ws.__id, msg.branch, msg.sessionId);
      }
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
      // Generate release notes from git diffs + commit messages, summarized by Claude
      const noteBranch = msg.branch || "main";
      try {
        const { getWorkspaceDir: getWsDir, getConfig: getCfg } = await import("./workspace-config.js");
        const { saveNotes } = await import("../db.js");
        const { sanitizeBranchName: sanitizeBr } = await import("./sanitize.js");
        const workspaceDir = getWsDir();

        // Detect default branch
        let defBranch = "main";
        const cfgRepos = getCfg().repos || [];
        for (const r of cfgRepos) {
          try {
            const ref = execSync(`git -C "${workspaceDir}/${r.name}" symbolic-ref refs/remotes/origin/HEAD 2>/dev/null`, { stdio: "pipe" }).toString().trim();
            defBranch = ref.replace("refs/remotes/origin/", "");
            if (defBranch) break;
          } catch {}
        }

        const featureName = noteBranch.replace('mvp/', '').replace(/-/g, ' ');

        // Collect per-repo diffs, commit logs, and stats
        const repoData = [];
        let totalCommits = 0, totalFiles = 0;
        for (const repo of cfgRepos.map(r => r.name)) {
          try {
            const repoPath = `${workspaceDir}/${repo}`;
            const safeDef = sanitizeBr(defBranch);
            const safeBranch = sanitizeBr(noteBranch);
            const count = parseInt(execSync(`git -C "${repoPath}" rev-list --count ${safeDef}..${safeBranch} 2>/dev/null`, { stdio: "pipe" }).toString().trim()) || 0;
            if (count === 0) continue;
            totalCommits += count;
            const files = execSync(`git -C "${repoPath}" diff --name-only ${safeDef}...${safeBranch} 2>/dev/null`, { stdio: "pipe" }).toString().trim().split("\n").filter(Boolean);
            totalFiles += files.length;
            const stat = execSync(`git -C "${repoPath}" diff --stat ${safeDef}...${safeBranch} 2>/dev/null`, { stdio: "pipe" }).toString().trim();
            const commitLog = execSync(`git -C "${repoPath}" log --oneline ${safeDef}..${safeBranch} 2>/dev/null`, { stdio: "pipe" }).toString().trim();
            // Get the actual diff (truncated to avoid massive payloads)
            let diff = '';
            try {
              diff = execSync(`git -C "${repoPath}" diff ${safeDef}...${safeBranch} 2>/dev/null`, { stdio: "pipe", maxBuffer: 1024 * 1024 }).toString().trim();
              if (diff.length > 15000) diff = diff.slice(0, 15000) + '\n... (diff truncated)';
            } catch {}
            const lastStatLine = stat.split("\n").pop() || '';
            repoData.push({ repo, count, files, lastStatLine, commitLog, diff });
          } catch {}
        }

        if (repoData.length === 0) {
          const notes = `*Feature: ${featureName}*\n\`${noteBranch}\`\n\nNo changes found on this branch.`;
          saveNotes(noteBranch, notes);
          ws.send(JSON.stringify({ type: "notes_generated", branch: noteBranch, content: notes }));
          return;
        }

        // Build the technical sections (always from git — not AI-generated)
        const repoSections = repoData.map(r =>
          `*${r.repo}* — ${r.files.length} files\n${r.files.map(f => '  • \`' + f + '\`').join('\n')}\n  ${r.lastStatLine}`
        );

        // Ask Claude to summarize the diffs into a stakeholder-friendly summary
        const diffContext = repoData.map(r =>
          `## ${r.repo}\n\n### Commits\n${r.commitLog}\n\n### Diff\n${r.diff}`
        ).join('\n\n---\n\n');

        const summaryPrompt = `You are summarizing code changes for a release note. The audience is a mix of engineers and non-technical stakeholders (PMs, QA).

Branch: ${noteBranch}
Feature: ${featureName}

Here are the git diffs and commit messages:

${diffContext}

Write two sections:

1. **Stakeholder summary** — 2-4 bullet points in plain English explaining what changed and why it matters. Focus on user-visible behavior, not implementation details. No code references.

2. **Changes delivered** — 3-8 bullet points, slightly more technical. Each bullet should describe one logical change (not one commit). Group related commits together. Use file/component names where helpful but keep it readable.

Rules:
- Be concise — each bullet is one sentence
- Use bullet character "•"
- Do not add headers or labels — just output the two sections separated by a blank line
- Do not wrap in markdown code blocks
- First section is the stakeholder summary, second is the changes delivered`;

        let aiSummary = '';
        try {
          const summaryQuery = query({
            prompt: summaryPrompt,
            options: {
              model: "claude-haiku-4-5-20251001",
              maxTurns: 1,
              allowedTools: [],
              settingSources: [],
              systemPrompt: "You are a concise technical writer. Output only what is asked, no preamble. Do not use any tools. Just respond with text.",
            },
          });
          for await (const event of summaryQuery) {
            if (event.type === "assistant" && event.message?.content) {
              for (const block of event.message.content) {
                if (block.type === "text" && block.text) aiSummary += block.text;
              }
            }
            if (event.type === "result") break;
          }
        } catch (e) {
          console.error("[notes] AI summary failed, falling back to commit log:", e.message);
          // Fallback: use commit messages as bullet points
          aiSummary = repoData.flatMap(r =>
            r.commitLog.split('\n').filter(Boolean).map(line => {
              const msg = line.replace(/^[a-f0-9]+\s+/, '').replace(/Co-Authored-By:.*$/i, '').trim();
              return msg ? `• ${msg}` : '';
            }).filter(Boolean)
          ).join('\n');
        }

        // Parse AI summary into stakeholder + changes sections
        const summaryParts = aiSummary.trim().split(/\n\s*\n/);
        const stakeholderSection = summaryParts[0] || '';
        const changesSection = summaryParts.slice(1).join('\n\n') || stakeholderSection;

        const header = `*Feature: ${featureName}*`;
        const branchLine = `\n\`${noteBranch}\``;
        const overview = `\n${totalCommits} commit${totalCommits !== 1 ? 's' : ''} across ${totalFiles} file${totalFiles !== 1 ? 's' : ''} in ${repoData.length} project${repoData.length !== 1 ? 's' : ''}`;
        const stakeholder = stakeholderSection ? `\n\n*Stakeholder summary*\n${stakeholderSection}` : '';
        const changeLog = changesSection ? `\n\n*Changes delivered*\n${changesSection}` : '';
        const technical = repoSections.length > 0 ? `\n\n*Projects touched*\n\n${repoSections.join('\n\n')}` : '';
        const now = new Date();
        const date = now.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
        const time = now.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: true });
        const status = `\n\n—\n_Auto-generated on ${date} at ${time}_`;

        const notes = `${header}${branchLine}${overview}${stakeholder}${changeLog}${technical}${status}`;
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
    let sessionId = msg.sessionId || currentSessionId || crypto.randomUUID();
    const model = MODEL_MAP[msg.model] || DEFAULT_MODEL;
    const mode = msg.mode || "build";
    currentSessionId = sessionId;

    // Helper: send to builder + all watchers on the same branch
    const chatBranch = msg.branch || null;
    function sendAll(data) {
      const payload = JSON.stringify(data);
      if (ws.readyState === 1) ws.send(payload);
      if (broadcastToBranch && chatBranch) broadcastToBranch(ws.__id, chatBranch, data);
    }

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

    // Resolve branch: prefer client-sent value, fall back to .active-branch or git HEAD
    let branch = msg.branch || null;
    if (!branch || branch === 'main' || branch === 'master') {
      try {
        const wsDir = getWorkspaceDir();
        branch = readFileSync(wsDir + "/.active-branch", "utf-8").trim() || branch;
      } catch {
        try {
          const repoNames = getRepoNames();
          if (repoNames.length > 0) {
            const wsDir = getWorkspaceDir();
            branch = execSync(`git -C "${wsDir}/${repoNames[0]}" rev-parse --abbrev-ref HEAD`, { stdio: "pipe" }).toString().trim();
          }
        } catch (e) { console.warn("[ws] branch detection failed:", e.message); }
      }
    }
    // Validate resolved branch name to prevent injection
    if (branch) {
      try { sanitizeBranchName(branch); } catch { branch = null; }
    }

    // Block build mode on main/master — must use a feature branch
    if (mode === "build" && (branch === "main" || branch === "master" || !branch)) {
      send({ type: "error", text: "Cannot build on main/master. Go Home and create a feature branch first." });
      return;
    }

    // Save user message — skip for discover mode
    if (mode !== "discover") {
      const existing = getSession(sessionId);
      if (!existing) {
        const codespaceId = process.env.CODESPACE_NAME || hostname();
        createSession(sessionId, null, text.slice(0, 50), "", branch, codespaceId);
        updateSessionTitle(sessionId, text.slice(0, 80));
      } else if (existing.branch !== branch && branch) {
        // Session exists but branch changed — create a new session for this branch
        const newId = crypto.randomUUID();
        const codespaceId = process.env.CODESPACE_NAME || hostname();
        createSession(newId, null, text.slice(0, 50), "", branch, codespaceId);
        updateSessionTitle(newId, text.slice(0, 80));
        sessionId = newId;
        currentSessionId = newId;
      } else {
        touchSession(sessionId);
      }
    }
    if (mode !== "discover") {
      const userName = msg.user_name || "anonymous";
      addMessage(sessionId, "user", JSON.stringify({ text, user_name: userName }));
      // Broadcast user message to watchers
      if (broadcastToBranch && chatBranch) {
        broadcastToBranch(ws.__id, chatBranch, { type: "watcher_user_msg", text, user_name: userName, sessionId });
      }
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
        thinking: mode === "build"
          ? { type: "enabled", budgetTokens: 8000 }
          : { type: "adaptive" },
        effort: mode === "build" ? "high" : "medium",
        maxBudgetUsd: PER_QUERY_BUDGET,
        maxTurns: 50,
        allowedTools: (mode === "plan" || mode === "discover")
            ? ["Read", "Glob", "Grep"]  // Plan/Discover mode: read-only tools
            : ["Read", "Edit", "Write", "Bash", "Glob", "Grep", "WebFetch", "Agent"],
        ...(mode === "build" ? { agents: eliteAgentDefs } : {}),
        hooks: {
          PreToolUse: [
            {
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
                try { logActivityEvent(sessionId, "tool_start", toolName, JSON.stringify(toolInput).slice(0, 200)); } catch {}
                pendingEvents.push({ type: "tool_activity", tool: toolName, input: toolInput });
                sendAll({ type: "tool_activity", tool: toolName, input: toolInput });
                return {};
              }],
            },
            ...eliteQualityHooks.PreToolUse,
          ],
          PostToolUse: [
            {
              matcher: ".*",
              hooks: [async (input, toolUseId, { signal }) => {
                const toolName = input.tool_name;
                try { logActivityEvent(sessionId, "tool_end", toolName, null); } catch {}
                sendAll({ type: "tool_complete", tool: toolName });

                // Emit file_changed for Edit/Write tools
                const toolInput = input.tool_input || {};
                if ((toolName === "Edit" || toolName === "Write" || toolName === "edit" || toolName === "write") && toolInput.file_path) {
                  const filePath = toolInput.file_path;
                  const action = (toolName === "Write" || toolName === "write") ? "write" : "edit";

                  // Determine repo from path
                  let repo = "";
                  const repoNames = getRepoNames();
                  for (const rn of repoNames) {
                    if (filePath.includes(`/${rn}/`)) { repo = rn; break; }
                  }

                  // Track in session set
                  if (!sessionChangedFiles.has(sessionId)) sessionChangedFiles.set(sessionId, []);
                  const sessionFiles = sessionChangedFiles.get(sessionId);
                  if (!sessionFiles.find(f => f.filePath === filePath)) {
                    sessionFiles.push({ filePath, repo, action, timestamp: Date.now() });
                  }

                  sendAll({ type: "file_changed", filePath, repo, action });
                }

                return {};
              }],
            },
            ...eliteQualityHooks.PostToolUse,
          ],
          ...(mode === "build" && eliteQualityHooks.Stop ? { Stop: eliteQualityHooks.Stop } : {}),
        },
      };

      // Inject workspace context from WORKSPACE.md and branch info
      if (systemPrompt && systemPrompt.append) {
        const workspaceMdPath = join(workspaceDir, "WORKSPACE.md");
        if (existsSync(workspaceMdPath)) {
          try {
            const workspaceContext = readFileSync(workspaceMdPath, "utf8");
            systemPrompt.append += `\n\n${workspaceContext}`;
            console.log(`[elite] WORKSPACE.md loaded (${workspaceContext.length} chars)`);
          } catch (e) {
            console.warn("[agent] Failed to read WORKSPACE.md:", e.message);
          }
        }
        if (branch) {
          const repoNames = getRepoNames();
          systemPrompt.append += `\n\nCurrent branch: ${branch}\nWorkspace directory: ${workspaceDir}\nRepos: ${repoNames.join(", ")}`;
        }

        // Append quality rules for build mode
        if (mode === "build") {
          systemPrompt.append += "\n\n" + eliteRulesPrompt;
        }
      }

      // Diagnostic logging
      console.log(`[elite] Query config: mode=${mode} model=${model} thinking=${JSON.stringify(queryOptions.thinking)} effort=${queryOptions.effort} settingSources=${JSON.stringify(queryOptions.settingSources)}`);
      if (systemPrompt?.append) {
        console.log(`[elite] System prompt size: ${systemPrompt.append.length} chars`);
      }
      console.log(`[elite] Agents registered: ${queryOptions.agents ? Object.keys(queryOptions.agents).join(", ") : "none"}`);

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
      sendAll({ type: "thinking", sessionId });

      let fullText = "";
      let gotFirstChunk = false;
      let gotResult = false;
      let lastCost = 0;
      let changedFiles = []; // Track files edited/written by agent
      let pendingEvents = []; // Collect UI events for DB persistence
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
                sendAll({ type: "thinking_done", sessionId });
              }
              fullText += block.text;
              sendAll({ type: "assistant_chunk", text: block.text, sessionId });
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
            const updatedTotal = getTotalCost();
            if (updatedTotal >= DAILY_BUDGET && wsOpen) {
              ws.send(JSON.stringify({ type: "system", text: `Daily budget reached ($${updatedTotal.toFixed(2)}/$${DAILY_BUDGET}). Stopping.` }));
            }
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
            sendAll({ type: "file_diff", files: filesWithDiff });
            pendingEvents.push({ type: "file_diff", files: filesWithDiff });
          }
          if (lastEditedFile) {
            try {
              const content = readFileSync(lastEditedFile, "utf8");
              sendAll({ type: "code_update", path: lastEditedFile, content });
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
          if (restartedServices.length > 0) {
            const restartMsg = `Auto-restarted: ${restartedServices.join(", ")}`;
            sendAll({ type: "system", text: restartMsg });
            pendingEvents.push({ type: "system", text: restartMsg });
          }

          // Take screenshot if frontend files were changed
          const frontendName = getFrontendRepo()?.name;
          const touchedFrontend = frontendName && changedFiles.some(f => f.name.includes(frontendName));
          if (touchedFrontend) {
            try {
              const screenshotData = await takeScreenshot();
              if (screenshotData) {
                sendAll({
                  type: "screenshot",
                  image: screenshotData,
                  caption: changedFiles.filter(f => f.name.includes(frontendName)).map(f => f.name.split("/").pop()).join(", "),
                });
              }
            } catch (e) { console.error("[screenshot]", e.message); }
          }

          sendAll({
            type: "assistant_done",
            text: fullText,
            sessionId,
            cost,
            totalCost: getTotalCost(),
            filesChanged: changedFiles.length,
          });

          if (mode !== "discover") {
            try { addMessage(sessionId, "assistant", JSON.stringify({ text: fullText })); } catch (e) { console.error("[db]", e.message); }
            for (const evt of pendingEvents) {
              try { addMessage(sessionId, "event", JSON.stringify(evt)); } catch (e) { console.error("[db] event:", e.message); }
            }
            if (cost > 0) {
              try { addMessage(sessionId, "result", JSON.stringify({ cost_usd: cost, model })); } catch (e) { console.error("[db]", e.message); }
            }
          }

          // Auto-push branch to origin when files were changed
          if (changedFiles.length > 0 && branch && !branch.match(/^(main|master)$/)) {
            try {
              pushBranch(branch);
              const pushMsg = `Pushed ${branch} to origin`;
              if (wsOpen) ws.send(JSON.stringify({ type: "system", text: pushMsg }));
              if (mode !== "discover") {
                try { addMessage(sessionId, "event", JSON.stringify({ type: "system", text: pushMsg })); } catch (e) { console.error("[db] event:", e.message); }
              }
            } catch (e) { console.log("[push] post-change push failed:", e.message); }
          }
        }
      }

      // If loop ended without a result event, still send done
      if (!gotResult) {
        if (fullText) {
          console.log("[agent] stream ended without result event — sending done");
          try { addMessage(sessionId, "assistant", JSON.stringify({ text: fullText })); } catch (e) { console.warn("[agent] failed to save message:", e.message); }
          sendAll({
            type: "assistant_done",
            text: fullText,
            sessionId,
            cost: lastCost,
            totalCost: getTotalCost(),
          });
        }
      }

      if (!gotFirstChunk) {
        ws.send(JSON.stringify({ type: "thinking_done", sessionId }));
      }

      currentQuery = null;
    } catch (err) {
      // Stale Claude session — clear it and ask user to resend
      if (claudeSessionIdToResume && err.message?.includes("No conversation found")) {
        console.warn(`[agent] Stale session ${claudeSessionIdToResume} — clearing`);
        try { updateClaudeSessionId(sessionId, null); } catch {}
        try { setClaudeSession(sessionId, "", ""); } catch {}
        try {
          ws.send(JSON.stringify({
            type: "error",
            text: "Previous AI session expired. Please resend your message.",
            sessionId,
          }));
        } catch {}
        currentQuery = null;
        return;
      }
      console.error("[agent] Error:", err.message, err.stack?.split("\n").slice(0, 3).join("\n"));
      try {
        ws.send(JSON.stringify({
          type: "error",
          text: `Agent error: ${err.message}`,
          sessionId,
        }));
      } catch (e) { console.warn("[agent] failed to send error to client:", e.message); }
      currentQuery = null;
    }
  }

  // Don't kill the query on WS disconnect — let it finish so the session
  // remains resumable. Claude Code CLI doesn't abort on terminal disconnect.
  ws.on("close", () => {
    console.log("[ws] Client disconnected" + (currentQuery ? " — agent still running, session will be resumable" : ""));
  });
}
