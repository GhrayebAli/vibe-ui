# vibe-ui Architecture

## Active Stack (production) — PRE-REFACTOR STATE
- Entry point: server-washmen.js (all routes inline)
- WebSocket: server/ws-handler-washmen.js
- Database: db.js + inline db.prepare() calls in server-washmen.js
- Frontend: public/app.js → public/components/*.js
- HTML: public/index-v2.html
- CSS: public/styles.css

## Inactive Stack (Stack B — not loaded by the app)
- server/routes/, public/js/features/, public/js/ui/, public/js/panels/, public/css/
- Do NOT edit these files expecting changes in production
- These are reference implementations for features not yet in Stack A

## Key modules (used by active stack)
- server/workspace-config.js — repo/port/service config
- server/sanitize.js — input validation
- server/presence.js — multi-user presence
- server/memory-injector.js, memory-extractor.js — persistent memories

> **After Phase 4:** Update this file to reflect the final architecture
> (routes in server/routes/, SQL consolidated in db.js, Stack B in _legacy/)
