/**
 * Claude Setup Loader — reads rules, agent definitions, and quality hooks
 * from server/claude-setup/ at startup and exports them for SDK injection.
 */
import { readFileSync, readdirSync } from "fs";
import { join, basename } from "path";
import { fileURLToPath } from "url";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const RULES_DIR = join(__dirname, "rules");
const AGENTS_DIR = join(__dirname, "agents");

const MODEL_MAP = {
  haiku: "claude-haiku-4-5-20251001",
  sonnet: "claude-sonnet-4-6",
  opus: "claude-opus-4-6",
};

/**
 * Parse simple YAML frontmatter from a markdown file.
 * Expects --- delimited frontmatter with key: value pairs.
 * Handles tools as JSON array strings and model as MODEL_MAP lookup.
 */
function parseFrontmatter(content) {
  const normalized = content.replace(/\r\n/g, "\n");
  const match = normalized.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
  if (!match) return { frontmatter: {}, body: normalized };

  const frontmatter = {};
  for (const line of match[1].split("\n")) {
    const colonIdx = line.indexOf(":");
    if (colonIdx === -1 || !line.trim()) continue;
    const key = line.slice(0, colonIdx).trim();
    let value = line.slice(colonIdx + 1).trim();
    // Strip surrounding quotes
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    // Parse JSON arrays (tools field)
    if (value.startsWith("[")) {
      try { value = JSON.parse(value); } catch { /* keep as string */ }
    }
    frontmatter[key] = value;
  }

  return { frontmatter, body: (match[2] || "").trim() };
}

/**
 * Load all rule .md files and concatenate into a single prompt string.
 */
export function getRulesPrompt() {
  const files = readdirSync(RULES_DIR).filter(f => f.endsWith(".md")).sort();
  const rulesText = files
    .map(f => readFileSync(join(RULES_DIR, f), "utf8"))
    .join("\n\n");

  console.log(`[elite] Loaded ${files.length} rules (${rulesText.length} chars): ${files.join(", ")}`);
  return rulesText;
}

/**
 * Load agent .md files and parse into SDK AgentDefinition objects.
 * Returns Record<string, AgentDefinition> for the SDK agents option.
 */
export function getAgentDefinitions() {
  const files = readdirSync(AGENTS_DIR).filter(f => f.endsWith(".md")).sort();
  const agents = {};

  for (const f of files) {
    const content = readFileSync(join(AGENTS_DIR, f), "utf8");
    const { frontmatter, body } = parseFrontmatter(content);

    if (!frontmatter.name) {
      console.warn(`[elite] Agent file missing "name" in frontmatter: ${f}`);
      continue;
    }
    if (!body || body.trim().length === 0) {
      console.warn(`[elite] Agent "${frontmatter.name}" has empty prompt: ${f}`);
      continue;
    }

    agents[frontmatter.name] = {
      description: frontmatter.description || "",
      prompt: body,
      tools: Array.isArray(frontmatter.tools) ? frontmatter.tools : ["Read", "Grep", "Glob"],
      ...(frontmatter.model && MODEL_MAP[frontmatter.model] ? { model: MODEL_MAP[frontmatter.model] } : {}),
    };
  }

  console.log(`[elite] Loaded ${Object.keys(agents).length} agents: ${Object.keys(agents).join(", ")}`);
  return agents;
}

/**
 * Quality hooks for config file protection, console.log detection,
 * and automatic code review on task completion.
 * Returns PreToolUse, PostToolUse, and Stop hook arrays matching SDK signature.
 */
export function getQualityHooks() {
  const PROTECTED_CONFIGS = new Set([
    ".eslintrc", ".eslintrc.json", ".eslintrc.js", ".eslintrc.cjs",
    ".prettierrc", ".prettierrc.json", ".prettierrc.js", ".prettierrc.cjs",
    "tsconfig.json", "biome.json", ".stylelintrc", ".stylelintrc.json",
    "eslint.config.js", "eslint.config.mjs", "eslint.config.cjs",
    "prettier.config.js", "prettier.config.mjs", "prettier.config.cjs",
  ]);

  return {
    PreToolUse: [{
      matcher: "Edit|Write",
      hooks: [async (input, toolUseId, { signal }) => {
        const filePath = input.tool_input?.file_path || input.tool_input?.path || "";
        const fileName = basename(filePath);
        if (PROTECTED_CONFIGS.has(fileName)) {
          console.log(`[elite] BLOCKED config edit: ${filePath} — "Fix the code, not the config"`);
          return {
            decision: "block",
            reason: "Config file protected. Fix the code, not the config.",
            hookSpecificOutput: {
              hookEventName: "PreToolUse",
              permissionDecision: "deny",
              permissionDecisionReason: "Config file protected. Fix the code, not the config.",
            },
          };
        }
        return {};
      }],
    }],
    PostToolUse: [{
      matcher: "Edit|Write",
      hooks: [async (input, toolUseId, { signal }) => {
        const filePath = input.tool_input?.file_path || input.tool_input?.path || "";
        if (!filePath.match(/\.(js|ts|jsx|tsx)$/)) return {};

        // Check the content being written, not the file on disk (may not be flushed yet)
        const newContent = input.tool_input?.new_string || input.tool_input?.content || "";
        if (!newContent) return {};

        const lines = newContent.split("\n");
        const found = [];
        for (let i = 0; i < lines.length; i++) {
          const line = lines[i];
          // Skip comments and string literals containing "console.log"
          if (line.trim().startsWith("//") || line.trim().startsWith("*")) continue;
          if (/console\.log\s*\(/.test(line)) {
            found.push(i + 1);
          }
        }
        if (found.length > 0) {
          console.log(`[elite] console.log detected in ${filePath} at lines: ${found.join(", ")}`);
          return { message: `console.log found at lines: ${found.join(", ")} in ${filePath}. Remove before commit.` };
        }
        return {};
      }],
    }],
    Stop: [{
      matcher: "*",
      hooks: [async (input, toolUseId, { signal }) => {
        // Only nudge if the agent actually made code changes (not just reading/planning)
        const transcript = input.last_assistant_message || "";
        const madeCodeChanges = /\b(Edit|Write|edit|write)\b/.test(transcript)
          || /\b(created|modified|updated|added|changed|fixed|implemented)\b/i.test(transcript);

        if (!madeCodeChanges) return {};

        // Don't trigger if already inside a code-reviewer subagent run
        if (input.stop_hook_active) return {};

        console.log(`[elite] Stop hook: code changes detected, requesting code review + fix`);
        return {
          message: "You made code changes in this session. Before finishing, use the code-reviewer agent to review all files you modified. If the reviewer finds any CRITICAL or HIGH issues, fix them immediately — do not report them to the user. Only mention to the user what you built and that it's ready. The user is non-technical and should never see code review details. IMPORTANT: Do NOT run git commit or git push after fixing — the system handles that automatically.",
        };
      }],
    }],
  };
}
