# Spec: Make vibe-ui's Agent Produce Elite Output

## Problem

vibe-ui wraps Claude Code via `@anthropic-ai/claude-agent-sdk`. The agent produces functional but mediocre output because:
- The BUILD_SYSTEM_PROMPT (44 lines) contains only communication/safety rules — zero guidance on code quality, UI/UX, or research methodology
- `settingSources: []` means the agent ignores CLAUDE.md files in target repos
- `thinking: { type: "adaptive" }` lets the model skip deep reasoning on "routine" tasks
- `effort` is not set in query options
- Agent-loop and orchestrator prompts are generic boilerplate
- The user's local Claude setup (~/.claude/rules, agents, hooks) — which enforces elite standards — never reaches the vibe-ui agent

## Two-Layer Context Architecture

vibe-ui has two context layers for AI. Both need improvement, but in different ways.

### Layer 1: vibe-ui Level (universal, all workspaces)

**What exists today:**
- `BUILD_SYSTEM_PROMPT` / `PLAN_SYSTEM_PROMPT` / `DISCOVER_SYSTEM_PROMPT` — hardcoded in `server/ws-handler-washmen.js`
- Guardrail hooks (PreToolUse blocks dangerous commands, PostToolUse tracks file changes)
- SDK query options: model, tools, budget, maxTurns

**What's missing:**
- Code quality standards (read before write, match patterns, no dead code)
- UI/UX standards (accessibility, responsive, interaction states, design tokens)
- Research-before-build workflow
- Self-review before finishing
- Subagent definitions (code-reviewer, architect, planner, etc.)
- Quality hooks (config file protection, console.log detection)
- SDK options: `effort`, forced `thinking`, `settingSources`, `agents`

### Layer 2: Workspace Level (per-workspace context)

**What exists today:**
- `WORKSPACE.md` in workspace root — appended to system prompt (`ws-handler-washmen.js:680-690`)
- `workspace.json` — repo names, ports, types (auto-discovered or manual)
- Branch info and repo names injected into prompt
- Persistent memories from database (per-project)
- `getProjectSystemPrompt(cwd)` — imported by agent-loop/orchestrator but **broken** (imports from `server/routes/projects.js` which doesn't exist in active stack)

**What's missing:**
- Nothing architecturally — the mechanism works. But the broken `getProjectSystemPrompt` import means agent-loop and orchestrator don't get workspace context.

## Architecture Decision

**Bundle quality infrastructure into vibe-ui's Layer 1** as a `server/claude-setup/` directory:
- Rules as `.md` files — loaded at startup, injected into system prompts
- Agent definitions as `.md` files — parsed at startup, passed via SDK `agents` option
- Hooks as JS functions — added to SDK `hooks` option alongside existing guardrails

This is version-controlled, deploys to Codespaces, and doesn't pollute target workspaces.

---

## Implementation

### Step 1: Create `server/claude-setup/` directory

```
server/claude-setup/
  rules/
    coding-style.md
    security.md
    ui-ux.md             (NEW)
  agents/
    planner.md
    architect.md
    code-reviewer.md
    security-reviewer.md
    build-error-resolver.md
    refactor-cleaner.md
    frontend-design.md   (from ~/.claude/skills/frontend-design/SKILL.md)
  loader.js              (NEW)
```

**Agent subset rationale:**
- Include: `planner`, `architect`, `code-reviewer`, `security-reviewer` — directly improve output quality
- Include: `build-error-resolver` — critical for autonomous recovery when builds fail
- Include: `refactor-cleaner` — catches dead code the agent creates
- Include: `frontend-design` — creative direction for greenfield UI work (new pages, new components from scratch). Sourced from the `/frontend-design` skill SKILL.md. **Needs frontmatter adaptation when copied:** add `tools: ["Read", "Write", "Edit", "Glob", "Grep", "Bash"]` and `model: sonnet`, remove `license` field. Complements the always-on `ui-ux.md` rules (engineering discipline) with creative design direction.
- Exclude: `tdd-guide`, `e2e-runner`, `doc-updater`, `performance-optimizer` — vibe-ui users don't run tests or write docs; add later if needed

**Rules subset rationale:**
- Include: `coding-style.md` — immutability, file organization, error handling. **Must be softened when copied:** change absolute directives ("ALWAYS/NEVER") to preferences ("Prefer") so they yield to existing codebase patterns. The BUILD_SYSTEM_PROMPT's "match existing patterns" instruction takes precedence over these rules when they conflict with what the codebase already does.
- Include: `security.md` — input validation, secret management (always relevant)
- Include: `ui-ux.md` — NEW, covers the accepted gap (accessibility, responsive, design tokens, interaction states)
- Exclude: `testing.md`, `git-workflow.md`, `hooks.md`, `patterns.md`, `performance.md`, `development-workflow.md`, `agents.md`, `code-review.md` — either not applicable to vibe-ui users, already enforced by BUILD_SYSTEM_PROMPT forbidden lists, or too prescriptive for the agent

### Step 2: Create `server/claude-setup/loader.js`

Module responsibilities:
1. Read all `.md` files from `rules/` and `agents/` at startup (sync, once)
2. Parse YAML frontmatter from agent files using a simple regex splitter (no new dependency — frontmatter is just `key: value` pairs between `---` delimiters). Parse `tools` as JSON array, `model` as string mapped through MODEL_MAP.
3. Export three functions:

**`getRulesPrompt()`** — returns concatenated rules text for system prompt injection

**`getAgentDefinitions()`** — returns `Record<string, AgentDefinition>` for SDK `agents` option:
```javascript
{
  "planner": {
    description: "Expert planning specialist for complex features...",
    prompt: "<body of planner.md>",
    tools: ["Read", "Grep", "Glob"],
    model: "claude-opus-4-6"
  },
  "code-reviewer": {
    description: "Code quality reviewer for catching bugs...",
    prompt: "<body of code-reviewer.md>",
    tools: ["Read", "Grep", "Glob"],
    model: "claude-sonnet-4-6"
  },
  "frontend-design": {
    description: "Creative frontend design specialist for building new UI from scratch. Use when creating new pages, components, or interfaces that don't have existing patterns to follow.",
    prompt: "<body of frontend-design SKILL.md>",
    tools: ["Read", "Write", "Edit", "Glob", "Grep", "Bash"],
    model: "claude-sonnet-4-6"
  },
  // ... etc
}
```

**`getQualityHooks()`** — returns hook functions matching the existing SDK signature `async (input, toolUseId, { signal }) => {...}`:
- **PreToolUse (Edit|Write):** Block modifications to linter/formatter config files (.eslintrc, .prettierrc, tsconfig.json, biome.json, eslint.config, prettier.config). Returns `{ decision: "block", reason: "Config file protected. Fix the code, not the config." }`
- **PostToolUse (Edit|Write):** Detect console.log in JS/TS files after edit. Returns `{ message: "console.log found at lines: X, Y in path" }` so the agent sees the warning and can clean up.

### Step 3: Rewrite BUILD_SYSTEM_PROMPT

**File:** `server/ws-handler-washmen.js` lines 55-99

Keep the existing structure (Communication, Allowed, Forbidden, Git, Services, Tools) unchanged. Insert four new **brief** sections between "Communication" and "Allowed". These are summaries only — the full standards are in the rule files appended via `getRulesPrompt()`:

**Code Quality Standards:**
- Read target files before modifying. Match existing patterns and architecture.
- Check for unused imports, dead code, or duplicated logic before finishing.
- See appended Coding Style rules for full standards.

**UI/UX Standards:**
- Reuse existing components. Handle all interaction states. Ensure accessibility and responsiveness.
- See appended UI/UX rules for full standards.

**Research Before Building:**
- For non-trivial tasks: read related files, trace similar implementations, identify dependencies. Plan before writing.

**Self-Review Before Finishing:**
- Re-read every file you changed. Verify requirements are met. Check error messages are user-friendly. Summarize what changed in plain language.

After the system prompt is assembled, append `getRulesPrompt()` output (the full rule files from `server/claude-setup/rules/`). The inline sections above are brief pointers; the rule files are the authoritative source. No duplication — the prompt summarizes, the rules detail.

### Step 4: Update SDK query options in ws-handler

**File:** `server/ws-handler-washmen.js` lines 607-718

Import from loader at top of file:
```javascript
import { getRulesPrompt, getAgentDefinitions, getQualityHooks } from "./claude-setup/loader.js";
```

Load at module level (outside handleChat, runs once at startup):
```javascript
const agentDefs = getAgentDefinitions();
const rulesPrompt = getRulesPrompt();
const qualityHooks = getQualityHooks();
```

Changes to `queryOptions` object:

| Option | Current | New |
|--------|---------|-----|
| `settingSources` | `[]` | `["project"]` (note: SDK looks in `cwd` which is workspace root, not sub-repos. Only `/workspaces/workspace/CLAUDE.md` or `/workspaces/workspace/.claude/` are picked up — not per-repo CLAUDE.md files) |
| `thinking` | `{ type: "adaptive" }` | Build: `{ type: "enabled", budgetTokens: 8000 }`, Plan/Discover: `{ type: "adaptive" }` |
| `effort` | not set | Build: `"high"`, Plan/Discover: `"medium"` |
| `agents` | not set | Build: `agentDefs`, Plan/Discover: `undefined` |

Merge quality hooks with existing hooks:
- PreToolUse: existing guardrail hook + quality config-protection hook
- PostToolUse: existing file-tracking hook + quality console.log-detection hook

Append rules to system prompt for build mode:
```javascript
if (mode === "build") {
  systemPrompt.append += "\n\n" + rulesPrompt;
}
```

### Step 5: Fix broken imports in agent-loop and orchestrator

**Files:** `server/agent-loop.js:31`, `server/orchestrator.js:26`

Both import `getProjectSystemPrompt` from `./routes/projects.js` which doesn't exist in the active stack. This would crash at runtime if these modules are loaded.

**Fix:** Replace the dead import with workspace-level context loading, matching the pattern already used in ws-handler:

```javascript
// Replace: import { getProjectSystemPrompt } from "./routes/projects.js";
// With: workspace context loading
import { readFileSync, existsSync } from "fs";
import { join } from "path";

function getWorkspaceContext(cwd) {
  if (!cwd) return "";
  const mdPath = join(cwd, "WORKSPACE.md");
  if (existsSync(mdPath)) {
    try { return readFileSync(mdPath, "utf8"); } catch { return ""; }
  }
  return "";
}
```

Then where `getProjectSystemPrompt(cwd)` was used:
```javascript
const workspaceContext = getWorkspaceContext(cwd);
if (workspaceContext) opts.appendSystemPrompt = workspaceContext;
```

### Step 6: Wire loader into agent-loop.js

**File:** `server/agent-loop.js`

Import from loader:
```javascript
import { getAgentDefinitions, getRulesPrompt } from "./claude-setup/loader.js";
```

Add to `opts` object (lines 141-147):
```javascript
opts.settingSources = ["project"];
opts.thinking = { type: "enabled", budgetTokens: 5000 };
opts.effort = "high";
opts.agents = getAgentDefinitions();
```

Enhance `buildAgentPrompt` instructions (lines 68-73) — replace generic "break into steps" with:
```
- Read relevant source files before making changes. Follow existing code patterns and naming conventions.
- Break the goal into logical steps and execute them one by one.
- Use tools (read files, search, write, run commands) as needed.
- For UI work: reuse existing components, handle all states (loading, empty, error), ensure accessibility.
- After completing all steps, re-read your changes and provide a final summary covering:
  * What files were modified and why
  * Architectural decisions made
  * How the change can be validated
- If you encounter a blocker you cannot resolve, explain it clearly and stop.
```

### Step 7: Wire loader into orchestrator.js

**File:** `server/orchestrator.js`

Same pattern as agent-loop:
- Import loader
- Add settingSources, thinking, effort to `plannerOpts` (lines 151-161)
- Add settingSources, thinking, effort to synthesis opts

Enhance `buildOrchestratorPrompt` (lines 42-69):
- Add "Analysis Before Delegation" section requiring the orchestrator to think about dependencies between sub-tasks before dispatching
- Add prerequisite/dependency context requirement to dispatch rules

Enhance `buildSynthesisPrompt` (lines 82-91):
- Replace "provide a concise summary" with structured synthesis: objective, key changes, integration, validation, remaining work

### Step 8: Create `server/claude-setup/rules/ui-ux.md`

New rule file. Content:

```markdown
# UI/UX Standards

These standards apply when building new features or adding to existing UI. When the user explicitly asks to change the design, theme, or visual style, follow their intent — update the design tokens/theme files themselves rather than hardcoding overrides, so the change propagates consistently.

## Design Token Adherence
When adding new UI, use existing design tokens — don't hardcode values:
- Read the project's theme/variables/tokens before writing any CSS
- Colors, spacing, typography, border-radius, shadows — reference tokens, not raw values
- When the user asks to change the design system itself, update the tokens at the source

## Interaction States
EVERY interactive element must handle ALL applicable states:
- Default, hover, active, focus-visible, disabled
- Loading (skeleton or spinner, never blank)
- Error (inline message, never silent failure)
- Empty (meaningful message + action, never blank screen)

## Accessibility (WCAG 2.1 AA)
- Semantic HTML: button not div, nav not div, heading hierarchy
- ARIA labels on icons, images, and non-text interactive elements
- Keyboard navigation: Tab/Enter/Escape reach all actions
- Focus indicators: visible, never removed
- Color contrast: 4.5:1 text, 3:1 UI components
- Never convey meaning through color alone

## Responsive Design
- Mobile-first: base styles for small screens, scale up
- Touch targets: minimum 44x44px on mobile
- No horizontal scroll on any viewport
- Flexible layouts: relative units, flex, grid — avoid fixed widths

## Animation
- 150-300ms for micro-interactions, 300-500ms for layout shifts
- Purpose: guide attention or feedback — never decorative
- Respect prefers-reduced-motion

## Component Patterns
- Search codebase for existing similar components before creating new ones
- When extending the UI, match existing component API patterns (props, events, slots)
- When the user asks to redesign or replace a component, follow their direction

## Checklist
Before marking UI work complete:
- [ ] New UI references design tokens (no magic numbers for colors/spacing/typography)
- [ ] All interaction states handled
- [ ] Keyboard accessible
- [ ] Readable at 320px mobile width
- [ ] No horizontal scroll
- [ ] Semantic HTML (not div soup)
```

---

## Implementation Order

1. Create `server/claude-setup/` with rules, agents, loader.js (Steps 1-2)
2. Create `server/claude-setup/rules/ui-ux.md` (Step 8)
3. Rewrite BUILD_SYSTEM_PROMPT (Step 3)
4. Wire loader into ws-handler queryOptions (Step 4)
5. Fix agent-loop broken import + wire loader (Steps 5-6)
6. Fix orchestrator broken import + wire loader (Step 7)
7. Add diagnostic logging — `[elite]` prefix (Step 9)
8. Test end-to-end — vibe a real task, then `grep "[elite]"` server output to validate

Each step is independently deployable. If thinking budget causes cost issues, reduce budgetTokens (8000 -> 5000 -> 3000).

### Step 9: Add diagnostic logging

Add structured logging at every decision point so behavior can be investigated after vibing. All logs use `[elite]` prefix for easy filtering (`grep "\[elite\]"` in server output).

**In `server/claude-setup/loader.js` — at startup:**
```javascript
// After loading rules:
console.log(`[elite] Loaded ${files.length} rules (${rulesText.length} chars): ${files.join(", ")}`);

// After loading agents:
console.log(`[elite] Loaded ${Object.keys(agents).length} agents: ${Object.keys(agents).join(", ")}`);
```

**In `server/ws-handler-washmen.js` — per query:**
```javascript
// After assembling queryOptions, before calling query():
console.log(`[elite] Query config: mode=${mode} model=${model} thinking=${JSON.stringify(queryOptions.thinking)} effort=${queryOptions.effort} settingSources=${JSON.stringify(queryOptions.settingSources)}`);
console.log(`[elite] System prompt size: ${systemPrompt.append.length} chars`);
console.log(`[elite] Agents registered: ${queryOptions.agents ? Object.keys(queryOptions.agents).join(", ") : "none"}`);

// When WORKSPACE.md is loaded:
console.log(`[elite] WORKSPACE.md loaded (${workspaceContext.length} chars)`);

// When CLAUDE.md would be loaded via settingSources:
// (SDK handles this internally, but we log that we enabled it)
console.log(`[elite] settingSources=["project"] — SDK will load CLAUDE.md from ${workspaceDir} if present`);
```

**In quality hooks — when they fire:**
```javascript
// Config protection hook (PreToolUse):
console.log(`[elite] BLOCKED config edit: ${path} — "Fix the code, not the config"`);

// console.log detection hook (PostToolUse):
console.log(`[elite] console.log detected in ${path} at lines: ${found.join(", ")}`);
```

**In `server/agent-loop.js` — per agent run:**
```javascript
// After building agent opts:
console.log(`[elite] Agent "${agentDef.title}" opts: thinking=${JSON.stringify(opts.thinking)} effort=${opts.effort} agents=${opts.agents ? Object.keys(opts.agents).length : 0}`);
```

**In `server/orchestrator.js` — per orchestration:**
```javascript
// After building planner opts:
console.log(`[elite] Orchestrator planner opts: thinking=${JSON.stringify(plannerOpts.thinking)} effort=${plannerOpts.effort}`);
```

**Log output example after a build query:**
```
[elite] Loaded 3 rules (2847 chars): coding-style.md, security.md, ui-ux.md
[elite] Loaded 7 agents: planner, architect, code-reviewer, security-reviewer, build-error-resolver, refactor-cleaner, frontend-design
[elite] Query config: mode=build model=claude-sonnet-4-6 thinking={"type":"enabled","budgetTokens":8000} effort=high settingSources=["project"]
[elite] System prompt size: 4932 chars
[elite] Agents registered: planner, architect, code-reviewer, security-reviewer, build-error-resolver, refactor-cleaner, frontend-design
[elite] WORKSPACE.md loaded (1240 chars)
[elite] settingSources=["project"] — SDK will load CLAUDE.md from /workspaces/workspace if present
[guardrail] allowed: Read /workspaces/workspace/frontend/src/components/Header.tsx
[elite] console.log detected in /workspaces/workspace/frontend/src/pages/Settings.tsx at lines: 12, 45
```

This lets you:
- `grep "\[elite\]"` to see only the new system's behavior
- Verify rules/agents loaded correctly at startup
- Confirm thinking/effort/settingSources are set per query
- See when quality hooks fire
- Compare system prompt size across sessions
- Diagnose if WORKSPACE.md or CLAUDE.md is being picked up

---

## Verification

Test with a build query like "Add a settings page with dark mode toggle":

- [ ] Agent reads existing component files before creating new ones
- [ ] Agent mentions patterns found ("I see you use X, so I'll follow that")
- [ ] Agent handles loading/empty/error states in new UI
- [ ] Agent uses semantic HTML, keyboard navigation
- [ ] Agent self-reviews at end
- [ ] console.log detection fires if agent leaves debug logs
- [ ] Config file protection blocks .eslintrc modification attempts
- [ ] Cost stays under $5/query
- [ ] If workspace has WORKSPACE.md, its context appears in agent behavior
- [ ] Subagents (code-reviewer, architect) available when agent invokes them

---

## Budget Impact

- Thinking overhead per build query: ~$0.10-0.15 (thinking tokens at $0.15/1M, heavily discounted)
- Rules appended to system prompt: ~2KB additional context (negligible)
- Agent definitions loaded but only used when Agent tool invoked (no idle cost)
- Well within $5/query and $60/day limits

---

## Critical Files

| File | Changes |
|------|---------|
| `server/claude-setup/loader.js` | NEW — loads rules, agents, hooks from files |
| `server/claude-setup/rules/ui-ux.md` | NEW — UI/UX quality standards |
| `server/claude-setup/rules/coding-style.md` | Copied from `~/.claude/rules/` |
| `server/claude-setup/rules/security.md` | Copied from `~/.claude/rules/` |
| `server/claude-setup/agents/*.md` | 6 from `~/.claude/agents/` + `frontend-design.md` from `~/.claude/skills/frontend-design/SKILL.md` (7 total) |
| `server/ws-handler-washmen.js` | Rewrite BUILD_SYSTEM_PROMPT + update queryOptions |
| `server/agent-loop.js` | Fix broken import + add quality standards + update opts |
| `server/orchestrator.js` | Fix broken import + enhance prompts + update opts |

## What This Does NOT Change

- Layer 2 (WORKSPACE.md, workspace.json, memories) — untouched
- Guardrails (blocked bash/code/file patterns) — kept, quality hooks added alongside
- Communication style (TONE_INSTRUCTION) — preserved
- Budgets ($5/query, $60/day) — unchanged
- Session resumption — unchanged
- Memory system — unchanged
- Plan/Discover modes — get `settingSources: ["project"]` and `effort: "medium"` but no rules injection, no agents, no forced thinking (read-only modes don't need quality enforcement)
- Release notes query (ws-handler lines 420-437) — uses haiku with maxTurns:1, unchanged
- The second query() call in ws-handler for MVP notes generation — unchanged
