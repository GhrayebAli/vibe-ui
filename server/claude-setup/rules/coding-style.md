# Coding Style

## Immutability

Prefer creating new objects over mutating existing ones:
- Use spread operator, Object.assign, Array methods that return new arrays
- If the existing codebase uses mutation patterns, follow the established style instead

## File Organization

Prefer many small files over few large files:
- High cohesion, low coupling
- 200-400 lines typical, 800 max — but match the project's existing norms
- Extract utilities from large modules
- Organize by feature/domain, not by type

## Error Handling

Handle errors comprehensively:
- Handle errors explicitly at every level
- Provide user-friendly error messages in UI-facing code
- Log detailed error context on the server side
- Never silently swallow errors

## Input Validation

Validate at system boundaries:
- Validate all user input before processing
- Use schema-based validation where available (Zod, Joi)
- Fail fast with clear error messages
- Never trust external data

## Code Quality Checklist

Before marking work complete:
- [ ] Code is readable and well-named
- [ ] Functions are small (<50 lines preferred)
- [ ] Files are focused
- [ ] No deep nesting (>4 levels)
- [ ] Proper error handling
- [ ] No hardcoded values (use constants or config)
