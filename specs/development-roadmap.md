# WashVibe Product Development Roadmap

**Created:** 2026-03-26
**Status:** Living document
**Note:** Not sorted by priority

---

## Expand Reach

### New Workspaces for More Products

**What:** Stand up WashVibe workspaces for Facility Core, New WF+ Facility, and PWA (Customer App) — same experience that exists today for Ops.

**Why:** Right now only the Ops team benefits from WashVibe. Every product team should be able to vibe-code on their own stack.

**What's involved per workspace:**
- Write `workspace.json` defining the repos, ports, dev commands, and health endpoints
- Map out env variables and secrets each service needs (pull from existing `.env.example` or team knowledge)
- Verify auto-discovery correctly identifies frontend vs backend repos
- Test the full flow: create branch, build with Claude, preview in iframe, service health, auto-restart
- Decide if any workspace needs custom guardrails (e.g., PWA touches customer-facing code — stricter rules?)

**Workspaces to create:**

| Workspace | Key Repos | Frontend | Notes |
|-----------|-----------|----------|-------|
| Facility Core | facility-frontend, srv-facility-backend, internal-public-api | React | Order processing, facility capacity |
| New WF+ Facility | wf-plus-frontend, srv-facility-ops-backend | React (modern) | New facility experience |
| PWA (Customer App) | washmen-pwa, internal-public-api, srv-customer-backend | PWA/React | Customer-facing — order placement, tracking |

---

### React Native Support

**What:** Make WashVibe capable of running and previewing React Native / Expo projects, so teams can vibe-code mobile apps the same way they do web apps.

**Why:** Washmen has mobile products. Today WashVibe assumes everything is a web app loaded in an iframe. RN needs a different preview, different health checks, different restart behavior.

**Full spec:** `specs/react-native-support.md` (38 acceptance criteria)

**Key changes:**
- Detect RN/Expo projects from `package.json` dependencies
- Whitelist Expo/RN CLI commands in guardrails (`npx expo start`, `eas build`, `pod install`)
- Health check Metro bundler via `/status` endpoint instead of generic HTTP
- Preview via Expo Web (`--web` flag) in the existing iframe
- Claude system prompts gain RN-specific context (HMR, native vs JS changes, Expo conventions)
- Smart restart: JS changes use HMR (no restart), config changes restart Metro, native changes warn user

---

### Stakeholder Self-Serve

**What:** Let non-technical stakeholders (PMs, ops managers, product leads) spin up WashVibe workspace instances on their own, without engineering help.

**Why:** If only engineers can launch workspaces, adoption stays limited. Stakeholders should be able to click a button and start building.

**What's involved:**
- Set up GitHub org accounts with Codespace access (role: Collaborator — can read, create Codespaces, create branches, but NOT push to main)
- One-click workspace launch: a "Launch WashVibe" button in the repo README that creates a Codespace with the right devcontainer config
- Permission tiers: **Viewer** (Discover mode only), **Builder** (Build mode, mvp/* branches), **Admin** (full access)
- Workspace catalog: landing page listing all available workspaces with descriptions and launch buttons
- Onboarding flow: first-time user tour customized per workspace (existing `tour.js` can be extended)

---

## Smarter Building

### Inject Washmen Intelligence

**What:** Give Claude deep context about Washmen's design system, architecture, API contracts, code conventions, and domain language — so it builds features that match the codebase instead of generic patterns.

**Why:** Today Claude writes correct code but doesn't know Washmen's conventions. It might use wrong colors, create endpoints that don't match the API gateway pattern, or use generic terms instead of Washmen domain language. Every output needs manual correction.

**What's involved:**
- **Design system** — color palette, typography, MUI customizations, spacing, component patterns
- **Architecture guide** — service map, API gateway patterns, data flow (DynamoDB -> Sails -> API -> React), Cognito auth flow
- **API contracts** — available endpoints, request/response shapes, error codes (OpenAPI/Swagger summaries)
- **Code conventions** — file naming, folder structure, import ordering, error handling, state management
- **Domain glossary** — Washmen-specific terms: facility, laundry, driver, order lifecycle, promo, billing cycle, customer segment
- **Contextual injection** — system prompt dynamically includes relevant sections based on what Claude is editing (UI work gets design system, API work gets architecture guide)

**Delivery format:** CLAUDE.md per repo for essentials (always in context), MCP resources for detailed references (queried on demand to save tokens).

---

### Parallel Database Support

*Suggested by @hossein.khadishi & @Rami Shaar*

**What:** Let users define custom data attributes (e.g., "VIP flag on customer", "facility capacity override") using a parallel database (Supabase, SQLite, or JSON) — without touching production schemas.

**Why:** Today, adding a new attribute requires an engineer to modify production DB schemas, run migrations, update APIs. This creates a bottleneck. Non-engineers should be able to extend data models for their own use cases and prototype new features without waiting on engineering or DevOps.

**What's involved:**
- Choose a parallel DB strategy (Supabase for hosted Postgres with instant REST API, SQLite for local zero-config, JSON for quick prototyping)
- Build a schema-on-write layer: user describes what they need in plain language, Claude creates the schema and generates read/write APIs
- Data bridge: read from production (via existing APIs, read-only) + read/write to parallel DB. Claude generates views that combine both.
- Guardrail separation: parallel DB operations are allowed, production DB guardrails stay strict
- Simple UI for attribute management: list custom attributes, their types, which entity they belong to
- Migration path: when a parallel attribute proves valuable, generate a script to formalize it into the production schema (hand off to engineering)

```
Production (read-only)          Parallel DB (read-write)
┌──────────────────┐            ┌──────────────────────┐
│ DynamoDB         │            │ Supabase / SQLite    │
│ Postgres (RDS)   │◄──join────►│ Custom attributes    │
│ Redshift         │            │ User-defined fields  │
└──────────────────┘            └──────────────────────┘
         │                                │
         └────────┬───────────────────────┘
                  │
          ┌───────▼──────────┐
          │  Unified API     │
          │  (generated by   │
          │   Claude)        │
          └──────────────────┘
```

---

### Connect with MCPs

**What:** Pre-configure MCP integrations with the tools teams already use — Notion, Jira, Figma — so Claude has full context while building.

**Why:** MCP infrastructure already works in WashVibe (full CRUD UI, stdio/http/sse support, global + project scopes). But no integrations are pre-configured. Users have to set them up manually.

**What's involved per MCP:**
- Identify the MCP server package
- Add default config to workspace.json or `.claude/settings.json`
- Document the auth setup (API key, OAuth)
- Test: Claude can query the MCP during BUILD mode
- Add a quick-setup button in the MCP manager for common integrations

**Target integrations:**

| MCP | Value |
|-----|-------|
| **Notion** | Pull PRDs, specs, meeting notes into Claude's context while building |
| **Jira** | Pull tickets and acceptance criteria, link commits to issues |
| **Figma** | Pull design tokens, component specs, layout references. Claude references designs while building UI |

---

## Better UX

### Edit Last Message, Manage Context & Re-Prompt

*Suggested by @hossein.khadishi*

**What:** Let users edit their last message, regenerate Claude's response, see what's in context, and prune old turns.

**Why:** Today messages are fire-and-forget. If Claude misunderstands, the only option is to send a new message clarifying. Users should be able to revise and retry like they can in ChatGPT or Claude.ai.

**What's involved:**
- **Edit last message** — click to edit inline, resubmit, conversation forks from that point
- **Regenerate** — button on the last assistant message to re-run the same prompt
- **Context viewer** — side panel showing what Claude sees: system prompt, conversation turns, attached files, token count per item
- **Context pruning** — remove or collapse earlier turns to free up context window space
- **Re-prompt from history** — select any earlier user message, modify it, re-send as a new branch

---

### Solidify Visual Edit & Re-Enable

**What:** Fix whatever broke the visual edit feature, harden it, and turn it back on.

**Why:** Visual edit is a differentiating feature — click an element in the preview, Claude knows what you're pointing at. It's currently disabled (`display:none` in the HTML, comment says "will re-enable after enhancements"). The full implementation exists (1000+ lines in `visual-edit.js`).

**What's involved:**
- Figure out why it was disabled (likely Codespace cross-origin iframe issues, Playwright reliability, or MUI component detection gaps)
- Fix the root issues
- Add error boundaries so failures degrade gracefully (never crash the main app)
- Re-enable with a workspace-level toggle (on for web frontends, off for backends and RN)
- Test across multiple ops-frontend pages: element detection, hover highlight, click selection, style extraction, edit history, undo

---

### Workspace Usage Metrics & Analytics

**What:** Track and visualize how each workspace is being used — who's building what, how much it costs, what's working.

**Why:** Comprehensive analytics already exist (cost, sessions, tokens, errors, tool usage). But there's no per-workspace dimension, no way to compare adoption across products, and no stakeholder-friendly summary.

**What's involved:**
- Tag every session, cost entry, and tool use with the workspace name (currently everything is in one flat SQLite DB)
- Workspace comparison dashboard: side-by-side usage across Ops, Facility, PWA, etc.
- Adoption metrics: unique users per workspace per week, session duration, features completed (branches merged), time from first message to PR
- Cost attribution: break down API costs by workspace, by user, by mode (Plan/Discover/Build)
- Stakeholder summary: weekly digest of features built, cost breakdown, adoption trends — exportable or sendable via Slack

---

## Platform Hardening

### Dynamically Pull Env Variables & Secrets

**What:** Automatically pull environment variables and secrets from GitHub (repository/environment secrets) and AWS (Secrets Manager, Parameter Store) at workspace startup — instead of hardcoding them in `workspace.json` or `.env` templates.

**Why:** Today, env files are defined as static strings in `workspace.json.envFiles`. This means secrets are baked into config, need manual updates when they rotate, and risk being committed. A dynamic approach keeps secrets out of version control and always current.

**What's involved:**
- Integrate with GitHub repository secrets / environment secrets API to pull values at Codespace startup
- Integrate with AWS Secrets Manager or SSM Parameter Store for production-grade secrets
- Update the env file generation logic in workspace-core startup scripts to resolve `$SECRET_NAME` placeholders dynamically
- Support a clear precedence: AWS secrets > GitHub secrets > workspace.json defaults > `.env.example` fallbacks
- Log which secrets were resolved vs which are missing (without logging values)
- Ensure secrets are never written to files that could be committed (`.gitignore` enforcement)

---

### Solidify Security & Run Audit by DevOps

**What:** Document every security surface, close known gaps, add audit logging, and get a formal sign-off from the DevOps team.

**Why:** WashVibe has multi-layered security (pre-tool-use guardrails, input sanitization, token auth, permission modals, mode-based prompts) — but it's never been formally audited. Before giving stakeholders access, this needs a clean bill of health.

**What's involved:**
- Document all security surfaces in a reviewable format: token auth flow, every blocked pattern (bash/code/file), permission modes, how guardrails are enforced
- Review blocked patterns for bypass vectors (e.g., `bash -c` to evade command checks, heredocs, subshells, backticks)
- Add test cases for every blocked pattern
- Add audit logging: log every `checkPreToolUse()` decision (allowed/blocked) to SQLite with timestamp, user, tool name, pattern matched
- Add rate limiting: per-session and per-day caps on tool executions (not just cost budget)
- Hand off to DevOps for formal review, iterate on findings

---

### Move All Artifacts to Org Account

**What:** Transfer all repos (workspace-core, vibe-ui, product repos) from personal GitHub accounts to the Washmen GitHub org.

**Why:** Shared infrastructure shouldn't live under personal accounts. Blocks team access, Codespace provisioning, and stakeholder self-serve.

**What's involved:**
- Inventory every repo involved
- Transfer ownership on GitHub
- Update all remote URLs, `.gitmodules` (workspace-core submodule), `workspace.json` repo URLs
- Update any CI/CD or Codespace configs that reference old paths
- Verify all team members can create Codespaces from org repos

---

## AI Capabilities

### SDK Abstraction — Swap AI Providers

**What:** Abstract the AI provider layer so WashVibe can work with different agent SDKs — Claude, OpenAI Codex, Cursor Compose, or others.

**Why:** Avoids vendor lock-in. Different providers may be better for different tasks. Teams should be able to choose.

**Current state:** Direct `import { query } from "@anthropic-ai/claude-agent-sdk"` in 5+ files. Two SDK versions mixed. Tight coupling.

**What's involved:**
- Create a unified provider interface: `{ query, stream, getModels, name }`
- Build `server/ai-provider.js` — all call sites migrate to this single entry point
- Consolidate the two SDK versions currently in use (`claude-agent-sdk` + `claude-code`)
- Implement providers: Claude (default), OpenAI Assistants API, evaluate Cursor (API not public — may need subprocess bridge)
- Provider selector in UI: per-workspace or per-session override
- Tool mapping layer: translate WashVibe's tool format (Read, Edit, Write, Bash, Glob, Grep) to each provider's native format
- Cost normalization: track spend in USD regardless of provider
- Guardrails stay in WashVibe (not the SDK) — security works regardless of provider

---

### Claude Skills, Loop & Multi-Agent Workflows

**What:** Integrate Claude's extended capabilities — Skills, Loop, multi-agent orchestration — into WashVibe.

**Why:** Today WashVibe uses Claude as a single-turn Q&A agent. Claude can do much more: run pre-defined workflows (Skills), orchestrate multi-step processes (Loop), and work autonomously in the background.

**What's involved:**
- **Skills** — register WashVibe-specific skills: `/deploy-preview`, `/run-tests`, `/create-pr`, `/update-jira`. Each skill is a pre-defined multi-step workflow with Claude orchestrating.
- **Loop / Multi-agent** — enable plan -> build -> review pipelines: one agent plans, another implements, a third reviews the diff. Foundation exists in `orchestrator.js` and `agent-loop.js`.
- **Custom skill builder** — UI for non-engineers to define new skills: trigger phrase, steps, guardrails. Stored per-workspace.
- **Workflow templates** — pre-built patterns: "Add a new page" (creates route, component, nav entry), "Add API endpoint" (creates controller, route, model).

---

### Integrate with CodeRabbit for AI Review

**What:** Connect CodeRabbit to the PR workflow so every branch created through WashVibe gets an automated AI code review before human review.

**Why:** Claude builds the feature, but there's no automated quality check. CodeRabbit provides AI-powered code review that catches bugs, security issues, and style violations. This closes the loop: build with AI, review with AI, then human approval.

**What's involved:**
- Set up CodeRabbit on the Washmen GitHub org (or per-repo)
- Configure CodeRabbit rules to align with Washmen's code conventions and guardrails
- Surface CodeRabbit review comments inside WashVibe (pull via GitHub API or MCP) so users can see feedback without leaving the workspace
- Optionally: let Claude read CodeRabbit's feedback and auto-fix issues in the same session

---

### Background Agents

**What:** Long-running agents that watch for events and take action autonomously — without a user actively in a session.

**Why:** Some tasks don't need a human in the loop: watching for a failed CI run and fixing the issue, monitoring a deploy and reporting status, or automatically picking up the next ticket from a queue.

**What's involved:**
- Build on existing `background-sessions.js` foundation
- Define trigger types: GitHub webhook events (PR created, check failed, issue assigned), scheduled (cron), manual start
- Agent runs with the same guardrails as interactive sessions
- Notification when agent completes or needs human input (Telegram, Slack, push notification)
- Dashboard to see active background agents, their status, and cost
