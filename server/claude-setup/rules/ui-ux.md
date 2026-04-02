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
