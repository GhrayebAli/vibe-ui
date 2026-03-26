# PRD: Mid-Turn Redirect (Agent Nudge)

## Introduction

When the Claude agent is working on a long task (e.g., a 10-minute recursive grep), the user has no way to course-correct without stopping the session entirely. This feature lets the user send a "nudge" message mid-turn that aborts the current tool and redirects the agent — without losing conversation context.

**Real example:** Agent runs `grep -r "@progress/kendo-react-grid" /workspaces/washmen-ops-workspace` scanning all of `node_modules` for 577+ seconds. User wants to say "skip node_modules, just search src/" but can't.

## Goals

- Allow users to redirect the agent while it's actively working
- Abort the currently running tool when a redirect is sent
- Preserve full session context (no restart, no lost history)
- Keep the UI simple — one input field, one interaction model
- Zero regression on existing chat, stop, resume, model-switch, and parallel-pane features

## User Stories

### US-001: Switch SDK from single-message to streaming input mode
**Description:** As a developer, I need the server to use the Claude Code SDK's streaming input mode so mid-turn messages can be delivered to the agent.

**Acceptance Criteria:**
- [ ] `query()` receives an async generator as `prompt` instead of a string
- [ ] First yield sends the user's original message
- [ ] Generator stays open during the agent's turn, ready to yield follow-up messages
- [ ] Generator exits cleanly when: (a) query completes naturally, (b) `currentQuery.close()` is called, or (c) WebSocket disconnects
- [ ] On WS disconnect, generator stops yielding but does NOT abort the query — agent finishes for session resumability (matches current behavior)
- [ ] Session resumption (`resume` in `queryOptions`) works identically — `resume` stays in options, not in the generator
- [ ] `currentQuery.setModel()` works mid-turn (model switch via "set_model" WS message)
- [ ] Agent responses stream back identically to current behavior — all event types (thinking, assistant_chunk, tool_use, tool_result, system/init, result) emit unchanged
- [ ] PreToolUse and PostToolUse hooks fire exactly as before
- [ ] Parallel panes: each `handleChat` call creates its own generator — no cross-contamination between panes
- [ ] Typecheck/lint passes

### US-002: Fix stop/abort message type mismatch
**Description:** As a developer, I need the client and server to agree on the stop message type so the stop button works reliably before adding redirect.

**Acceptance Criteria:**
- [ ] Client sends `"stop"` (not `"abort"`) to match the server handler
- [ ] OR server handles both `"stop"` and `"abort"` as the same action
- [ ] Stop button aborts the current query, closes the generator, and emits `assistant_done`
- [ ] Verified: clicking Stop during an active agent turn ends the turn immediately
- [ ] Typecheck/lint passes

### US-003: Server accepts redirect messages during an active turn
**Description:** As a developer, I need the WebSocket handler to accept a new message type `"redirect"` while a query is in progress, and deliver it to the agent via the streaming input generator.

**Acceptance Criteria:**
- [ ] New WebSocket message type `"redirect"` accepted alongside existing `"chat"`, `"stop"`, etc.
- [ ] If no query is active, `"redirect"` is rejected with `{ type: "error", text: "No active agent turn to redirect" }`
- [ ] If a query is active, the redirect text resolves the generator's waiting promise, yielding the message to the SDK
- [ ] The redirect message is saved to the session's message history in the database with `role: "user"`
- [ ] Only one redirect can be pending at a time — if a redirect is already waiting to be consumed by the generator, a second one is rejected with `{ type: "error", text: "Wait for the agent to respond before redirecting again" }`
- [ ] Server emits `{ type: "redirect_delivered", sessionId }` to the client once the generator yields the redirect
- [ ] Typecheck/lint passes

### US-004: Enable input field during agent work
**Description:** As a user, I want the chat input to remain usable while the agent is working so I can type a redirect.

**Acceptance Criteria:**
- [ ] Input field is enabled and focusable while agent is working ("Working..." / "Thinking..." shown)
- [ ] Placeholder text changes to "Nudge the agent..." during active work
- [ ] Send button is visible and uses a distinct redirect icon (e.g., a diagonal arrow) to differentiate from the normal send
- [ ] Stop button remains visible alongside the send button — both are available
- [ ] Pressing Enter sends the message as a `"redirect"` type (not a new `"chat"`)
- [ ] After sending a redirect, input disables and placeholder shows "Redirecting..." until the agent responds
- [ ] Input re-enables when the agent sends its next `assistant_chunk` or `assistant_done`
- [ ] In idle state (no active query), input reverts to normal chat behavior — `"chat"` type, normal placeholder, normal send icon
- [ ] Typecheck/lint passes
- [ ] Verify in browser using dev-browser skill

### US-005: Display redirect message in chat stream
**Description:** As a user, I want to see my redirect message appear inline in the chat so I know it was sent and delivered.

**Acceptance Criteria:**
- [ ] Redirect message appears as a user message bubble in the chat stream immediately on send (optimistic)
- [ ] A small "redirect" label (styled subtly, e.g., `color: var(--text-muted)`) appears below the bubble to distinguish it from normal messages
- [ ] When loading message history, redirect messages render with the same "redirect" label
- [ ] Redirect messages are stored in the DB with a `redirect: true` flag (or similar) so they render correctly on reload
- [ ] Typecheck/lint passes
- [ ] Verify in browser using dev-browser skill

### US-006: Agent acknowledges the redirect
**Description:** As a user, I want visible feedback that the agent received my redirect and is changing course.

**Acceptance Criteria:**
- [ ] The currently running tool indicator updates to show "Cancelled" state (not "completed" or "error") when the tool is aborted by a redirect
- [ ] The agent's next response appears in the chat stream as a continuation of the same turn
- [ ] The "Working..." timer resets when the redirect is delivered (agent is now working on the new direction)
- [ ] If the agent was in "Thinking..." state, it transitions cleanly to processing the redirect
- [ ] Typecheck/lint passes
- [ ] Verify in browser using dev-browser skill

## Functional Requirements

- FR-1: Replace `query({ prompt: string })` with `query({ prompt: asyncGenerator })` using the SDK's streaming input mode
- FR-2: The async generator yields `{ type: "user", message: { role: "user", content: text } }` for the initial message and each redirect
- FR-3: The generator uses a promise-based signal pattern: `await new Promise(resolve => { redirectResolver = resolve; })`. When a redirect arrives via WS, `redirectResolver(text)` is called
- FR-4: The generator exits (returns) when: the query event loop finishes (`for await` ends), `close()` is called, or WS disconnects. Use a `done` flag set in a `finally` block after the event loop
- FR-5: Accept `"redirect"` WebSocket messages only when `currentQuery` is active AND no redirect is already pending
- FR-6: On redirect: resolve the generator's promise with the redirect text → generator yields it to the SDK → SDK aborts the current tool and processes the redirect
- FR-7: Client sends `{ type: "redirect", text: "...", sessionId: "..." }` over WebSocket
- FR-8: Input field state is driven by a `queryActive` flag: `false` = chat mode, `true` = redirect mode
- FR-9: The Stop button remains available alongside redirect — stop kills the turn entirely (`currentQuery.close()`), redirect course-corrects within the turn
- FR-10: Reconcile client stop message type: handle both `"stop"` and `"abort"` on the server

## Non-Goals

- No "queue for next turn" — user can wait and send a normal message after the turn
- No progress-check queries ("what are you doing?") — the UI already shows the current tool
- No multi-message queue — one redirect at a time
- No changes to plan/discover mode — redirect only works in build mode
- No automatic abort detection (e.g., "if tool runs > 60s, suggest redirect")

## Technical Considerations

### SDK Streaming Input Mode

The key change is in `ws-handler-washmen.js`. Currently (line 619):
```javascript
const q = query({ prompt: text, options: queryOptions });
```

Becomes:
```javascript
let redirectResolver = null;
let redirectPending = false;
let generatorDone = false;

async function* messageGenerator() {
  // First message — the user's original prompt
  yield { type: "user", message: { role: "user", content: text } };

  // Wait for redirects until the query completes
  while (!generatorDone) {
    const redirect = await new Promise((resolve) => {
      redirectResolver = resolve;
    });
    redirectResolver = null;
    if (!redirect || generatorDone) break;
    redirectPending = false;
    sendAll({ type: "redirect_delivered", sessionId });
    yield { type: "user", message: { role: "user", content: redirect } };
  }
}

const q = query({ prompt: messageGenerator(), options: queryOptions });
currentQuery = q;

// ... existing for-await event loop ...

// After event loop exits:
generatorDone = true;
if (redirectResolver) redirectResolver(null); // unblock generator so it exits
```

### Redirect delivery (WS handler addition)

```javascript
if (msg.type === "redirect") {
  if (!currentQuery) {
    ws.send(JSON.stringify({ type: "error", text: "No active agent turn to redirect" }));
    return;
  }
  if (redirectPending || !redirectResolver) {
    ws.send(JSON.stringify({ type: "error", text: "Wait for the agent to respond before redirecting again" }));
    return;
  }
  redirectPending = true;
  // Save to DB
  addMessage(currentSessionId, "user", JSON.stringify({ text: msg.text, redirect: true }));
  // Deliver to generator
  redirectResolver(msg.text);
  return;
}
```

### Generator cleanup on WS disconnect

```javascript
ws.on("close", () => {
  generatorDone = true;
  if (redirectResolver) redirectResolver(null);
  // Do NOT call currentQuery.close() — let the agent finish for resumability
});
```

### Existing features preserved

| Feature | How it's preserved |
|---------|-------------------|
| **Session resume** | `queryOptions.resume` is unchanged — passed in `options`, not the generator |
| **Model switch** | `currentQuery.setModel()` operates on the query object, not the prompt — unaffected |
| **Stop button** | `currentQuery.close()` still works; also sets `generatorDone = true` and resolves the generator |
| **PreToolUse/PostToolUse** | Hooks are in `options` — completely independent of prompt delivery |
| **Parallel panes** | Each `handleChat()` creates its own generator, resolver, and flags — scoped per call |
| **WS disconnect** | Generator exits, query continues — same as current "don't kill on disconnect" behavior |
| **Notes generation** | Uses a separate `query()` call — completely unaffected |

### Client-side state machine

The input field has two states driven by a `queryActive` boolean:

| State | `queryActive` | Placeholder | Send type | Send icon | Stop visible |
|-------|--------------|-------------|-----------|-----------|-------------|
| Idle | `false` | "Describe what you want to build..." | `"chat"` | Normal send | No |
| Active | `true` | "Nudge the agent..." | `"redirect"` | Redirect arrow | Yes |
| Redirect pending | `true` | "Redirecting..." | Disabled | Disabled | Yes |

Transitions:
- Idle → Active: on `"thinking"` WS event
- Active → Idle: on `"assistant_done"` or `"result"` WS event
- Active → Redirect pending: on redirect send
- Redirect pending → Active: on next `"assistant_chunk"` or `"redirect_delivered"` WS event

## Files Changed

| File | Change |
|------|--------|
| `server/ws-handler-washmen.js` | Generator pattern, redirect handler, stop/abort reconciliation, generator cleanup |
| `public/js/features/chat.js` | Input state machine, redirect send logic, redirect message rendering |
| `public/components/chat.js` | `addUserMsg` supports redirect badge, `loadMessages` renders redirect messages |
| `public/styles.css` | Redirect badge styling, redirect send icon |

## Success Metrics

- User can redirect a stuck agent in under 3 seconds (type + send)
- Agent acknowledges redirect within 5 seconds of tool abort
- Zero lost session context — conversation continues seamlessly after redirect
- No regression in: normal chat, stop, resume, model switch, parallel panes, WS disconnect/reconnect

## Prerequisites

### P-1: Fix stop/abort message type mismatch (live bug)
The client (`public/js/features/chat.js` line 190) sends `{ type: "abort" }` but the server (`ws-handler-washmen.js` line 250) checks for `"stop"`. **The stop button may already be broken.** This must be fixed before adding redirect — otherwise users have no way to stop a runaway agent at all. Fix: server should handle both `"stop"` and `"abort"` as the same action.

### P-2: Add per-tool timeout (safety net)
Currently a single Bash/Grep command can run indefinitely (the 577s grep had no timeout). The SDK has `maxBudgetUsd` and `maxTurns` but no per-tool time limit. Redirect solves "user can intervene" but a timeout is the safety net when the user isn't watching. Add a configurable tool timeout (default 120s) — either via the `PreToolUse` hook rejecting long-running patterns, or by wrapping tool execution with an `AbortController` + `setTimeout`. Tools that exceed the timeout should be aborted with a clear message to the agent: "Tool timed out after 120s — consider a more targeted approach."

### P-3: Verify SDK version supports streaming input
The project uses `@anthropic-ai/claude-agent-sdk` v0.2.81. Streaming input mode (async generator as `prompt`) may require a newer version. Before starting implementation, check the SDK changelog and confirm the installed version supports the generator pattern. If not, bump the dependency first and verify all existing tests pass before making any other changes.

## Open Questions

None — all risks have mitigation strategies defined above.
