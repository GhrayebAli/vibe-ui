# vibe-ui Architecture

## Active Stack (production)
- Entry point: server-washmen.js (~160 lines — mounts routers, WebSocket, auth)
- Routes: server/routes/*.js (workspace, branches, sessions, files, prompts, notes, services, console, inspect)
- WebSocket: server/ws-handler-washmen.js
- Database: db.js (all SQL lives here as prepared statements)
- Frontend: public/app.js → public/components/*.js
- HTML: public/index-v2.html
- CSS: public/styles.css

## Inactive Stack (in _legacy/, for future porting)
- Do NOT edit _legacy/ files expecting changes in production
- These are reference implementations for features not yet in Stack A
- To port a feature: read from _legacy/, implement in the active stack

## Key modules (used by active stack)
- server/workspace-config.js — repo/port/service config
- server/sanitize.js — input validation
- server/presence.js — multi-user presence
- server/memory-injector.js, memory-extractor.js — persistent memories

## Route modules (server/routes/)
Each exports a factory function: `(deps) => Router`

| File | Endpoints |
|------|-----------|
| workspace.js | /api/workspace-config, /api/health, /api/service-health, /api/cost, /api/workspace, /api/branch, /api/presence |
| branches.js | /api/switch-branch, /api/create-branch |
| sessions.js | /api/sessions, /api/sessions/:id/messages, /api/sessions/:id/truncate-last, /api/sessions/:id/timeline, /api/sessions/:id/undo-preview, /api/sessions/:id/undo, /api/session-changes |
| files.js | /api/file, /api/files, /api/uploads/*, /api/upload |
| prompts.js | /api/prompts |
| notes.js | /api/notes (GET + POST) |
| services.js | /api/restart-service, /api/stop-service |
| console.js | /api/console (+ real-time log streaming via WebSocket) |
| inspect.js | /api/inject-visual-helper, /api/inspect-element |
