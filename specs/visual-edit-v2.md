# Spec: Visual Edit Mode v2 — Smart Component Editor

## Overview

Transform the existing Visual Edit Mode from a developer-oriented CSS inspector into an intuitive, non-engineer-friendly visual editor. Users should be able to click any element in the live preview, understand what it is in plain language, pick from smart suggested actions, see changes live before committing, and undo mistakes — all without writing a single line of CSS or knowing any technical terminology.

---

## User Flow

```
User clicks ✏️ Visual Edit button in preview toolbar
  │
  ▼
┌─────────────────────────────────────────────────────────┐
│  Preview iframe gets crosshair overlay                   │
│  Floating instruction pill: "Click any element to edit"  │
│                                                          │
│  On hover:                                               │
│    → Element gets highlighted (indigo outline + fill)    │
│    → Floating label shows friendly name: "Button",       │
│      "Heading", "Card", "Navigation Bar"                 │
│                                                          │
│  On click:                                               │
│    → Element locks with selection ring                   │
│    → Breadcrumb bar appears: Page > Card > Title         │
│    → Edit panel slides up from bottom-right              │
└─────────────────────────────────────────────────────────┘
  │
  ▼
┌─────────────────────────────────────────────────────────┐
│  EDIT PANEL (slides up inside right-panel)               │
│                                                          │
│  ┌ Breadcrumb ─────────────────────────────────────────┐ │
│  │ Page  ›  Sidebar  ›  Card  ›  [Title Text]         │ │
│  └─────────────────────────────────────────────────────┘ │
│                                                          │
│  ┌ Element Info ───────────────────────────────────────┐ │
│  │ 🏷️ "Order Summary Card"     src/OrderCard.tsx:42   │ │
│  │ Current text: "Recent Orders"                       │ │
│  └─────────────────────────────────────────────────────┘ │
│                                                          │
│  ┌ Quick Actions (chips) ─────────────────────────────┐ │
│  │ [Change text] [Change color] [Make larger]          │ │
│  │ [Make smaller] [Add shadow] [Make rounded]          │ │
│  │ [More padding] [Less padding] [Hide element]        │ │
│  └─────────────────────────────────────────────────────┘ │
│                                                          │
│  ┌ Custom Change ─────────────────────────────────────┐ │
│  │ 💬 "Describe what you want..."                      │ │
│  └─────────────────────────────────────────────────────┘ │
│                                                          │
│  [ Cancel ]                        [ Send to Agent ✨ ]  │
└─────────────────────────────────────────────────────────┘
  │
  ├─ User clicks a chip (e.g., "Change color")
  │    → Chip expands inline: color picker / text input / slider
  │    → User picks value
  │    → Live preview applies CSS override in iframe instantly
  │    → "Send to Agent" button becomes active
  │
  ├─ User types custom text
  │    → "Send to Agent" button becomes active
  │
  ▼
  User clicks "Send to Agent"
    → Structured prompt sent to chat with full context
    → Edit panel closes, visual edit mode deactivates
    → Chat shows the visual edit request as a user message
    → Agent processes and modifies the code
    → Preview auto-refreshes
    → Modified element pulses green briefly (change confirmation)
```

---

## Detailed Requirements

### Task 1: Fix Bugs in Current Implementation

**File:** `public/components/visual-edit.js`

1. **Remove duplicate panel append** — `showSimpleEditPanel()` calls `rightPanel.appendChild(editPanel)` twice (lines 376 and 380) and `setTimeout(focus)` twice (lines 377 and 381). Remove the second pair.

**Acceptance Criteria:**
- [ ] `showSimpleEditPanel()` contains exactly ONE `rightPanel.appendChild(editPanel)` call
- [ ] `showSimpleEditPanel()` contains exactly ONE `setTimeout(() => ... focus(), 100)` call
- [ ] Cross-origin element selection still works end-to-end (click element → loading → panel appears → send to agent)

---

### Task 2: Friendly Element Labels

Replace raw HTML tag names and technical component names with human-readable labels throughout the edit panel and hover tooltip.

**File:** `public/components/visual-edit.js`

Add a `friendlyName(element, componentAttr)` function that maps elements to plain-English names:

```
Tag-based mapping (fallback):
  button        → "Button"
  a             → "Link"
  img           → "Image"
  h1-h6         → "Heading"
  p             → "Paragraph"
  input         → "Input Field"
  textarea      → "Text Area"
  select        → "Dropdown"
  table         → "Table"
  tr            → "Table Row"
  td/th         → "Table Cell"
  ul/ol         → "List"
  li            → "List Item"
  nav           → "Navigation"
  header        → "Header"
  footer        → "Footer"
  form          → "Form"
  label         → "Label"
  span          → "Text"
  div           → "Section"
  svg           → "Icon"
  video         → "Video"
  audio         → "Audio"

MUI class-based mapping (higher priority, check classList):
  MuiButton     → "Button"
  MuiCard       → "Card"
  MuiAppBar     → "Top Navigation Bar"
  MuiDrawer     → "Sidebar"
  MuiTable      → "Table"
  MuiTextField  → "Text Field"
  MuiSelect     → "Dropdown"
  MuiChip       → "Tag"
  MuiAvatar     → "Avatar"
  MuiDialog     → "Dialog"
  MuiTab        → "Tab"
  MuiTabs       → "Tab Bar"
  MuiPaper      → "Panel"
  MuiList       → "List"
  MuiMenu       → "Menu"
  MuiToolbar    → "Toolbar"
  MuiIconButton → "Icon Button"
  MuiBadge      → "Badge"
  MuiAlert      → "Alert"
  MuiSnackbar   → "Notification"
  MuiGrid       → "Grid Layout"
  MuiContainer  → "Container"
  MuiTypography → (infer from variant: h1→"Heading", body1→"Paragraph", caption→"Caption")
  MuiDivider    → "Divider"
  MuiSwitch     → "Toggle Switch"
  MuiCheckbox   → "Checkbox"
  MuiRadio      → "Radio Button"
  MuiStepper    → "Progress Steps"
  MuiBreadcrumbs → "Breadcrumb"
  MuiPagination → "Pagination"
  MuiAccordion  → "Collapsible Section"
  MuiTooltip    → "Tooltip"
  MuiSkeleton   → "Loading Placeholder"

Component attr mapping (highest priority):
  If data-component exists, use first part (before ":"), then:
    - Split camelCase/PascalCase into words: "OrderSummaryCard" → "Order Summary Card"
    - Remove generic suffixes: "Component", "Wrapper", "Container", "View", "Page"
```

**Acceptance Criteria:**
- [ ] Hover tooltip shows friendly name (e.g., "Button" not `<button>`, "Card" not `MuiCard-root`)
- [ ] Edit panel title shows friendly name
- [ ] Technical details (file path, CSS selector) are NOT shown in the panel UI — only sent in the agent prompt
- [ ] `friendlyName()` is a single pure function that takes `(element, componentAttr)` and returns a string
- [ ] MUI class detection takes priority over raw tag name; component attr takes priority over both
- [ ] Unknown elements fall back to capitalized tag name (e.g., `<section>` → "Section")

---

### Task 3: Breadcrumb Navigator

Add a clickable breadcrumb bar at the top of the edit panel showing the element's ancestor chain in friendly names. Clicking any breadcrumb shifts selection to that ancestor.

**File:** `public/components/visual-edit.js`

**Logic:**
1. Walk up from selected element to `<body>`, collecting up to 4 ancestors that are "meaningful" (skip generic wrappers: elements whose only class matches `/^(css-|jss-|MuiBox|MuiGrid)/` and have exactly one child)
2. Build breadcrumb: `[Page] › [ancestor3] › [ancestor2] › [selected]`
3. Each breadcrumb item is a clickable `<span>` — on click, shift selection to that element and rebuild the edit panel for it
4. Current (deepest) element is highlighted with `color: var(--accent)`

**CSS additions to `public/css/core/components.css` (or closest match):**

```css
.ve-breadcrumb {
  display: flex;
  align-items: center;
  gap: 4px;
  padding: 8px 12px;
  border-bottom: 1px solid var(--border);
  font-size: 12px;
  color: var(--text-secondary);
  overflow-x: auto;
  white-space: nowrap;
}
.ve-breadcrumb-item {
  cursor: pointer;
  padding: 2px 6px;
  border-radius: var(--radius);
  transition: all 0.15s ease;
}
.ve-breadcrumb-item:hover {
  background: var(--accent-dim);
  color: var(--text);
}
.ve-breadcrumb-item.active {
  color: var(--accent);
  font-weight: 600;
}
.ve-breadcrumb-sep {
  color: var(--text-dim);
  font-size: 10px;
  user-select: none;
}
```

**Acceptance Criteria:**
- [ ] Breadcrumb appears at the top of the edit panel, below the header
- [ ] Shows up to 4 levels: `Page › [ancestor] › [ancestor] › [Selected]`
- [ ] Generic wrapper divs with no semantic meaning are skipped
- [ ] Clicking a breadcrumb item shifts selection to that element — the highlight in the preview moves, and the edit panel rebuilds with that element's info and actions
- [ ] Current element is visually distinguished (accent color, bold)
- [ ] Breadcrumb scrolls horizontally if it overflows
- [ ] Works in both same-origin and cross-origin modes (cross-origin builds breadcrumb from server response data)

---

### Task 4: Smart Suggestion Chips

Replace the blank "Custom Change" text input with contextual quick-action chips that appear based on the type of element selected. Chips are the primary interaction — the custom text input is secondary (collapsed by default, expandable).

**File:** `public/components/visual-edit.js`

**Chip sets by element type:**

```
Text elements (h1-h6, p, span, MuiTypography):
  [✏️ Change text]  [🎨 Change color]  [↑ Make larger]
  [↓ Make smaller]  [B Make bold]  [center Align center]

Buttons (button, a.btn, MuiButton, MuiIconButton):
  [✏️ Change label]  [🎨 Change color]  [⭕ Make rounded]
  [▢ Make outlined]  [↑ Make larger]  [↓ Make smaller]

Images (img, MuiAvatar, svg with role=img):
  [↑ Make larger]  [↓ Make smaller]  [⭕ Make rounded]
  [🖼️ Add border]  [💫 Add shadow]

Cards / Panels (MuiCard, MuiPaper, [class*=card]):
  [🎨 Change background]  [💫 Add shadow]  [⭕ Round corners]
  [↕️ More padding]  [↕️ Less padding]  [🖼️ Add border]

Inputs (input, textarea, MuiTextField, MuiSelect):
  [✏️ Change placeholder]  [↑ Make larger]  [⭕ Round corners]
  [🎨 Change border color]

Tables (table, MuiTable, MuiDataGrid):
  [🎨 Stripe rows]  [🖼️ Add borders]  [↑ Make header bold]
  [↕️ More row spacing]

Containers / Layout (div, section, MuiContainer, MuiGrid, MuiBox):
  [🎨 Change background]  [↕️ More padding]  [↕️ Less padding]
  [💫 Add shadow]  [🖼️ Add border]  [⭕ Round corners]

Navigation (nav, MuiAppBar, MuiDrawer, MuiTabs):
  [🎨 Change background]  [✏️ Change color]  [💫 Add shadow]

Lists (ul, ol, MuiList):
  [↕️ More spacing]  [↕️ Less spacing]  [🖼️ Add dividers]
  [🎨 Alternate colors]

Universal (always appended last):
  [👁️ Hide element]
```

**Chip behavior:**
- Clicking a chip sets it as the active action
- For chips that need a value (Change text, Change color, Change background):
  - "Change text" → expands an inline text input below the chip row
  - "Change color" / "Change background" → expands an inline color picker with 8 preset swatches + custom hex input
  - Presets: `#ef4444` (red), `#f59e0b` (amber), `#22c55e` (green), `#3b82f6` (blue), `#8b5cf6` (purple), `#ec4899` (pink), `#ffffff` (white), `#000000` (black)
- For chips that are immediate (Make larger, Add shadow, Make rounded, etc.):
  - Single click selects them (visual toggle — chip gets accent background)
  - Multiple immediate chips can be selected simultaneously
- Selected chips build the prompt automatically — user doesn't need to type anything
- "Send to Agent" button shows a count: "Send 3 changes ✨"

**Custom text input:**
- Below the chips, show a collapsed row: `"+ Describe something else..."` as a clickable text link
- Clicking expands the text input
- If custom text is entered, it appends to the chip-generated prompt

**CSS for chips:**

```css
.ve-chips {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  padding: 10px 12px;
}
.ve-chip {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 5px 10px;
  border-radius: var(--radius-pill);
  border: 1px solid var(--border);
  background: var(--bg);
  color: var(--text-secondary);
  font-size: 12px;
  font-weight: 500;
  cursor: pointer;
  transition: all 0.15s ease;
  user-select: none;
}
.ve-chip:hover {
  border-color: var(--accent);
  color: var(--text);
  background: var(--accent-dim);
}
.ve-chip.selected {
  border-color: var(--accent);
  background: var(--accent-mid);
  color: var(--accent);
}
.ve-chip-expand {
  padding: 8px 12px;
  border-top: 1px solid var(--border);
  animation: fadeInUp 0.15s ease;
}
.ve-color-grid {
  display: flex;
  gap: 6px;
  padding: 4px 0;
}
.ve-color-swatch {
  width: 24px;
  height: 24px;
  border-radius: 50%;
  border: 2px solid transparent;
  cursor: pointer;
  transition: all 0.15s ease;
}
.ve-color-swatch:hover {
  transform: scale(1.15);
}
.ve-color-swatch.selected {
  border-color: var(--accent);
  box-shadow: var(--glow);
}
.ve-custom-toggle {
  padding: 6px 12px;
  font-size: 12px;
  color: var(--text-dim);
  cursor: pointer;
  transition: color 0.15s ease;
}
.ve-custom-toggle:hover {
  color: var(--accent);
}
```

**Acceptance Criteria:**
- [ ] Chips appear in the edit panel below the element info section
- [ ] The correct chip set renders based on the selected element type (use `friendlyName` detection logic from Task 2 to classify)
- [ ] Clicking "Change text" expands an inline text input directly below the chip row
- [ ] Clicking "Change color" or "Change background" expands an inline color picker with 8 swatches + hex input
- [ ] Immediate action chips (Make larger, Add shadow, etc.) toggle on/off with visual state change
- [ ] Multiple chips can be selected simultaneously — the prompt combines all selected actions
- [ ] "Send to Agent" button label updates to show count: "Send to Agent ✨" → "Send 2 changes ✨"
- [ ] Custom text input is collapsed by default, expandable via "+ Describe something else..."
- [ ] If ONLY custom text is entered (no chips), the prompt uses that text
- [ ] If chips + custom text, the prompt includes both
- [ ] Empty state (nothing selected, nothing typed) → "Send to Agent" button is disabled
- [ ] The old raw CSS property inputs (BG Color, Text Color, Padding T/R/B/L, Font Size) from the same-origin panel are REMOVED — replaced entirely by chips
- [ ] The cross-origin panel also uses chips (same chip UI, same behavior)

---

### Task 5: Unified Edit Panel

Merge `showEditPanel()` (same-origin) and `showSimpleEditPanel()` (cross-origin) into a single `showEditPanel()` function that handles both cases. The panel structure should be identical regardless of origin.

**File:** `public/components/visual-edit.js`

**Panel structure (top to bottom):**
1. **Header row:** Friendly name (left) + Close ✕ button (right)
2. **Breadcrumb bar** (from Task 3)
3. **Element info section:** Shows current text content if any (truncated to 80 chars). Shows a small screenshot thumbnail if available (cross-origin only). NO file paths, selectors, or technical info shown.
4. **Quick action chips** (from Task 4)
5. **Chip expansion area** (inline inputs that appear when value-requiring chips are clicked)
6. **Custom change toggle + input** (collapsed by default)
7. **Action bar:** `[Cancel]` + `[Send to Agent ✨]`

**Data resolution:**
- Same-origin: extract data directly from DOM (`element.textContent`, `getComputedStyle()`, `findComponentAttr()`)
- Cross-origin: call `/api/inspect-element`, use response data
- Both paths feed the same panel renderer: `renderEditPanel(elementData)` where `elementData` is a normalized object:

```javascript
{
  friendlyName: "Button",         // from friendlyName()
  text: "Submit Order",           // element text content
  screenshot: null | "base64...", // only from server inspection
  component: "OrderButton",      // data-component name or null
  filePath: "src/Order.tsx",     // file path or null
  lineNum: "42",                 // line number or null
  selector: "div.card > button", // CSS selector path
  tag: "button",                 // raw tag name
  classes: "MuiButton-root",    // class list string
  styles: {                      // computed styles
    color, backgroundColor, fontSize, padding
  },
  ancestors: [                   // for breadcrumb
    { element: el, name: "Card" },
    { element: el, name: "Page" }
  ]
}
```

**Acceptance Criteria:**
- [ ] Only ONE `showEditPanel()` function exists — `showSimpleEditPanel()` is removed
- [ ] Panel looks identical for same-origin and cross-origin elements
- [ ] Same-origin elements show panel instantly (no loading spinner)
- [ ] Cross-origin elements show a brief loading state while `/api/inspect-element` resolves, then render the same panel layout
- [ ] Screenshot thumbnail (120px height, full width, rounded corners, border) shows only when available
- [ ] Element text content shown only when non-empty, truncated to 80 chars with ellipsis
- [ ] File path and CSS selector are NOT visible in the panel — they are only included in the prompt sent to the agent
- [ ] All data flows through a single `renderEditPanel(elementData)` function

---

### Task 6: Improved Hover & Selection UX

Upgrade the hover highlight from a plain outline to a more polished, Figma-like selection experience.

**File:** `public/components/visual-edit.js`

**Hover state:**
- Replace `2px solid #6366f1` outline with: `outline: 2px solid var(--accent)` + semi-transparent overlay fill `background: rgba(51, 209, 122, 0.06)`
- Apply via adding/removing a CSS class on the element rather than inline styles (inject a `<style>` tag into the iframe document once on activate, remove on deactivate)

**Selection state (after click):**
- Locked element gets: `outline: 2px solid var(--accent)` + `box-shadow: 0 0 0 4px rgba(51, 209, 122, 0.15)` (selection ring)
- Previous hover highlight is cleared

**Floating label (tooltip):**
- Instead of the current `.vo-hint` that says "Click an element to edit it" and then switches to tag name:
  - On activate: show a fixed instruction pill at the top-center of the overlay: `"Click any element to edit"` — styled as a pill with `background: var(--bg-elevated); border: 1px solid var(--border); border-radius: var(--radius-pill); padding: 4px 12px; font-size: 11px;`
  - On hover: show a floating label near the cursor with the friendly element name — styled as `background: var(--accent); color: #000; padding: 2px 8px; border-radius: var(--radius); font-size: 11px; font-weight: 600; pointer-events: none;`
  - On click/selection: instruction pill fades out, floating label stays on selected element

**CSS:**
```css
.ve-instruction {
  position: absolute;
  top: 12px;
  left: 50%;
  transform: translateX(-50%);
  background: var(--bg-elevated);
  border: 1px solid var(--border);
  border-radius: var(--radius-pill);
  padding: 6px 14px;
  font-size: 11px;
  color: var(--text-secondary);
  font-weight: 500;
  z-index: 12;
  pointer-events: none;
  animation: fadeInUp 0.2s var(--ease-out-expo);
  box-shadow: var(--shadow-sm);
}
.ve-label {
  position: absolute;
  background: var(--accent);
  color: #000;
  padding: 2px 8px;
  border-radius: var(--radius);
  font-size: 11px;
  font-weight: 600;
  pointer-events: none;
  white-space: nowrap;
  z-index: 12;
  box-shadow: var(--shadow-sm);
  transition: opacity 0.1s ease;
}
```

**Acceptance Criteria:**
- [ ] On activate, a centered instruction pill "Click any element to edit" appears at the top of the overlay
- [ ] On hover, elements get an accent-colored outline + subtle fill overlay (NOT using inline `style.outline` — use an injected stylesheet class)
- [ ] Floating label near cursor shows the friendly name from Task 2
- [ ] On click, selected element gets a distinct selection ring (outline + outer glow)
- [ ] Instruction pill fades out after selection
- [ ] On deactivate, all injected styles are cleaned up from the iframe document
- [ ] Cross-origin mode still works — falls back to overlay-only hints (no iframe DOM access)

---

### Task 7: Prompt Builder

Upgrade the prompt sent to the agent to be more structured and effective. The prompt should clearly communicate the user's intent with enough context for the agent to make precise, scoped changes.

**File:** `public/components/visual-edit.js`

Create a `buildPrompt(elementData, selectedChips, customText)` function:

```
VISUAL EDIT REQUEST
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

Target: {friendlyName} — "{text content truncated to 60 chars}"
{if filePath}: File: {filePath}{if lineNum}:{lineNum}{/if}
{if component}: Component: {component}
{if selector}: Selector: {selector}
{if classes}: Classes: {classes}

Current styles:
  color: {color}  |  background: {bg}  |  font-size: {fontSize}  |  padding: {padding}

Requested changes:
{for each selected chip}
  • {chip action in plain english}
    {if chip has value}: → new value: {value}
{/for}
{if customText}
  • Custom: {customText}
{/if}

IMPORTANT: Only modify the targeted element described above. Do NOT change global theme, MUI theme, layout wrappers, or App-level styles. Apply changes via the component's own styles (sx prop, className, or styled-components) scoped to this specific element.
```

**Acceptance Criteria:**
- [ ] `buildPrompt()` is a pure function — takes data in, returns prompt string
- [ ] Prompt includes all selected chip actions in a bulleted list
- [ ] Prompt includes custom text if provided
- [ ] Prompt includes file/component/selector context when available
- [ ] Prompt includes current styles so the agent knows the baseline
- [ ] Prompt includes the scoping instruction (do not change global styles)
- [ ] Prompt reads naturally — a human could understand the request without any code context
- [ ] If no file path is available, the prompt still works (uses selector + description instead)

---

### Task 8: Change Confirmation Pulse

After the agent finishes processing a visual edit request and the preview refreshes, briefly highlight the modified area to confirm the change was applied.

**Files:** `public/app.js`, `public/components/visual-edit.js`

**Logic:**
1. In `visual-edit.js`, export a `highlightChange(selector)` function
2. When a visual edit prompt is sent, store the `elementData.selector` in module state as `pendingChangeSelector`
3. In `app.js`, after receiving a `code_update` or `screenshot` WebSocket message that follows a visual edit prompt:
   - Call `highlightChange(pendingChangeSelector)`
   - The function tries to find the element in the iframe by selector
   - If found: apply a green pulse animation for 2 seconds, then remove
   - If not found (element may have changed): skip silently

**Pulse animation CSS (inject into iframe):**
```css
@keyframes ve-confirm-pulse {
  0%   { box-shadow: 0 0 0 0 rgba(51, 209, 122, 0.5); }
  50%  { box-shadow: 0 0 0 8px rgba(51, 209, 122, 0.15); }
  100% { box-shadow: 0 0 0 0 rgba(51, 209, 122, 0); }
}
.ve-change-confirmed {
  animation: ve-confirm-pulse 0.6s ease 3;
}
```

**Acceptance Criteria:**
- [ ] After a visual edit request completes, the target element pulses green 3 times over ~2 seconds
- [ ] Pulse animation is injected into the iframe, not the parent document
- [ ] If the element can't be found by selector after the change, no error — just skip
- [ ] The pulse only triggers for visual edit changes, not regular chat responses
- [ ] `pendingChangeSelector` is cleared after use (no stale state)
- [ ] Works in same-origin mode only (cross-origin can't inject styles — skip gracefully)

---

### Task 9: Edit History Sidebar

Track all visual edit requests in the current session with the ability to review and undo changes.

**Files:** `public/components/visual-edit.js`, `public/css/core/components.css`

**Data model (in-memory array, per session):**
```javascript
const editHistory = [];
// Each entry:
{
  id: crypto.randomUUID(),
  timestamp: Date.now(),
  friendlyName: "Button",
  action: "Change color → #3b82f6, Make rounded",  // human-readable summary
  prompt: "VISUAL EDIT REQUEST...",                  // full prompt sent
  selector: "div.card > button",
  undone: false
}
```

**UI:**
- Add a small history button (clock icon) next to the Visual Edit button in the preview toolbar
- Clicking it opens a dropdown/popover showing the last 10 edits
- Each entry shows:
  - Friendly name + short action summary (1 line, truncated)
  - Relative timestamp ("2m ago", "just now")
  - "Undo" button (sends a revert prompt to the agent: `"Undo the previous visual edit change to the {friendlyName}: revert {action}"`)
- Undone entries show with strikethrough and muted color
- Empty state: "No edits yet — click ✏️ to start"

**CSS:**
```css
.ve-history-btn {
  position: relative;
}
.ve-history-badge {
  position: absolute;
  top: -2px;
  right: -2px;
  min-width: 14px;
  height: 14px;
  border-radius: 7px;
  background: var(--accent);
  color: #000;
  font-size: 9px;
  font-weight: 700;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 0 3px;
}
.ve-history-popover {
  position: absolute;
  bottom: calc(100% + 8px);
  right: 0;
  width: 280px;
  max-height: 320px;
  overflow-y: auto;
  background: var(--bg-elevated);
  border: 1px solid var(--border);
  border-radius: var(--radius-md);
  box-shadow: var(--shadow-md);
  z-index: 20;
  animation: fadeInUp 0.15s var(--ease-out-expo);
}
.ve-history-item {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 8px 12px;
  border-bottom: 1px solid var(--border-subtle);
  font-size: 12px;
  gap: 8px;
}
.ve-history-item:last-child {
  border-bottom: none;
}
.ve-history-item.undone {
  opacity: 0.4;
  text-decoration: line-through;
}
.ve-history-info {
  flex: 1;
  min-width: 0;
}
.ve-history-name {
  color: var(--text);
  font-weight: 500;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.ve-history-action {
  color: var(--text-secondary);
  font-size: 11px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.ve-history-time {
  color: var(--text-dim);
  font-size: 10px;
  white-space: nowrap;
}
.ve-history-undo {
  background: none;
  border: 1px solid var(--border);
  border-radius: var(--radius);
  color: var(--text-secondary);
  font-size: 11px;
  padding: 2px 8px;
  cursor: pointer;
  white-space: nowrap;
  transition: all 0.15s ease;
}
.ve-history-undo:hover {
  border-color: var(--error);
  color: var(--error);
}
.ve-history-empty {
  padding: 20px;
  text-align: center;
  color: var(--text-dim);
  font-size: 12px;
}
```

**Acceptance Criteria:**
- [ ] A clock icon button appears in the preview toolbar next to the ✏️ Visual Edit button
- [ ] The button shows a badge with the count of edits (hidden when 0)
- [ ] Clicking the button toggles a popover with the edit history
- [ ] Each history entry shows: friendly name, action summary, relative time, undo button
- [ ] Clicking "Undo" sends a revert prompt to the agent via the same `onSendPrompt` callback
- [ ] Undone entries are visually marked (muted + strikethrough) and their undo button is disabled
- [ ] History persists for the current session only (cleared on page reload)
- [ ] Popover closes when clicking outside of it
- [ ] Empty state message shows when there are no edits

---

### Task 10: HTML & Initialization Updates

Update the HTML and app initialization to wire up all new features.

**Files:** `public/index-v2.html`, `public/app.js`

**HTML changes to `index-v2.html`:**
- Add the history button next to the visual edit button in the preview bar:
```html
<button class="pbar-btn ve-history-btn" id="ve-history-btn" title="Edit History" style="display:none">
  <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2">
    <circle cx="12" cy="12" r="10"/>
    <polyline points="12 6 12 12 16 14"/>
  </svg>
</button>
```

**App.js changes:**
- Import new exports from `visual-edit.js`: `highlightChange`, `getEditHistory`, `toggleHistory`
- Wire up the history button click handler
- After `code_update` or `screenshot` WS messages, call `highlightChange()` if a visual edit was pending
- Show the history button only when edit history has entries

**Acceptance Criteria:**
- [ ] History button appears in the preview toolbar only when there are edits in history
- [ ] History button has the clock SVG icon consistent with existing toolbar button styling
- [ ] `highlightChange()` is called after agent completes a visual edit
- [ ] All new visual-edit.js exports are properly imported in app.js
- [ ] No console errors on page load or during visual edit flow
- [ ] ESC key still deactivates visual edit mode
- [ ] The existing preview bar layout is not disrupted (buttons stay aligned)

---

## CSS File Organization

All new CSS should be added to `public/styles.css` under a clearly commented section:

```css
/* ═══ Visual Edit v2 ═══ */
```

Place it after the existing visual edit styles (around line 341). Replace the old `.edit-panel`, `.ep-*` styles with the new ones. Keep `.visual-overlay` as-is (just update the hint to `.ve-instruction` and `.ve-label`).

---

## Files Modified (Summary)

| File | Changes |
|------|---------|
| `public/components/visual-edit.js` | Major rewrite — unified panel, friendly names, chips, breadcrumb, history, prompt builder, highlight |
| `public/styles.css` | Replace old `.ep-*` styles with new `.ve-*` styles |
| `public/index-v2.html` | Add history button to preview toolbar |
| `public/app.js` | Import new exports, wire up history button and change confirmation |

No server-side changes required — the `/api/inspect-element` endpoint already returns all needed data.

---

## Testing — `test/visual-edit.mjs`

Every task MUST be validated by adding corresponding test steps to `test/visual-edit.mjs`. This file uses the existing test framework (`test/framework.mjs`) with Playwright. After completing each task, run the tests with: `node test/visual-edit.mjs`

The test file MUST be created as part of **Task 1** and extended with new test steps as each subsequent task is completed. The server must be running at `http://localhost:4000` (or `VIBE_URL` env var). Since the preview iframe may not have a real frontend running, tests should validate the vibe-ui chrome (overlay, panels, buttons, chips) rather than iframe content.

### Test File Structure

```javascript
/**
 * Visual Edit v2 — Automated Tests
 * Validates all visual edit features against a running vibe-ui instance.
 * Run: node test/visual-edit.mjs
 * Requires: VIBE_URL=http://localhost:4000 (default)
 */
import { chromium } from "playwright";
import {
  flow, step, see, pass, fail, warn, check, screenshot,
  hasVisibleContent, getVisibleState, canUserType,
  results, VIDEO_DIR,
} from "./framework.mjs";

const BASE_URL = process.env.VIBE_URL || "http://localhost:4000";
```

### Required Test Flows

**Flow 1: Visual Edit Activation & Deactivation** (Task 1, 6)
```
step: Click Visual Edit button → verify overlay appears over preview
step: Verify instruction pill "Click any element to edit" is visible and centered
step: Press ESC → verify overlay is removed
step: Click Visual Edit button again → verify it re-activates
step: Click Visual Edit button again → verify it toggles off
step: No console errors throughout
```

**Flow 2: Friendly Labels & Hover** (Task 2, 6)
```
step: Activate visual edit mode
step: Hover over preview area → verify floating label appears near cursor
step: Verify label uses friendly names (not raw HTML tags)
step: Move mouse → verify label follows cursor
step: Verify previous hover highlights are cleaned up (no stacking)
```

**Flow 3: Edit Panel & Breadcrumb** (Task 3, 5)
```
step: Activate visual edit, click on preview area
step: Verify edit panel slides up in right-panel
step: Verify panel has: header with friendly name, close button
step: Verify breadcrumb bar is present with at least 1 segment
step: Verify breadcrumb current item has accent color
step: Click close button → verify panel is removed
step: Verify only ONE edit panel exists in DOM (no duplicates — regression for Task 1 bug)
```

**Flow 4: Smart Chips** (Task 4)
```
step: Activate visual edit, click on preview area, wait for panel
step: Verify .ve-chips container exists with at least 3 chips
step: Verify chips have correct styling (pill shape, border, hover state)
step: Click a chip → verify it gets .selected class
step: Click same chip again → verify it toggles off
step: Click multiple chips → verify all get .selected class
step: Verify "Send to Agent" button shows count when chips selected
step: Verify "Send to Agent" button is disabled when nothing selected
step: Verify "+ Describe something else..." toggle is present and collapsed
step: Click the toggle → verify custom text input expands
```

**Flow 5: Prompt Builder** (Task 7)
```
step: Activate visual edit, click element, select 2 chips
step: Type custom text in expanded input
step: Click "Send to Agent"
step: Verify visual edit mode deactivates
step: Verify chat area received a new user message
step: Verify the message contains "VISUAL EDIT REQUEST"
step: Verify the message contains chip action descriptions
step: Verify the message contains custom text
step: Verify the message contains "Do NOT change global theme"
```

**Flow 6: Edit History** (Task 9, 10)
```
step: Verify history button is hidden initially (no edits yet)
step: Perform a visual edit (activate, click, select chip, send)
step: Verify history button appears with badge count "1"
step: Click history button → verify popover opens
step: Verify history entry shows: friendly name, action summary, time, undo button
step: Click outside popover → verify it closes
step: Perform second visual edit
step: Open history → verify 2 entries, badge shows "2"
step: Click "Undo" on first entry → verify it sends an undo prompt to chat
step: Verify undone entry has .undone class (muted + strikethrough)
```

**Flow 7: Full Integration Smoke Test** (All tasks)
```
step: Load page, verify no console errors
step: Verify visual edit button exists in preview toolbar
step: Full cycle: activate → hover → click → see panel with breadcrumb + chips → select chip → send → verify chat message → verify history
step: Verify ESC deactivates at any point
step: Verify all buttons are keyboard-accessible (tab navigation)
step: Screenshot final state for visual review
```

### Test Validation Rules

Each task's acceptance criteria maps to specific `check()` assertions in the test file. When implementing:

1. **After Task 1**: Create `test/visual-edit.mjs` with Flow 1 (activation/deactivation) + Flow 3 panel duplicate check. Run and pass.
2. **After Task 2**: Add Flow 2 (friendly labels). Run all flows, all must pass.
3. **After Task 3**: Extend Flow 3 (breadcrumb). Run all flows, all must pass.
4. **After Task 4**: Add Flow 4 (chips). Run all flows, all must pass.
5. **After Task 5**: All existing flows must still pass with unified panel.
6. **After Task 6**: Extend Flow 1 + Flow 2 with new hover UX checks. Run all, all must pass.
7. **After Task 7**: Add Flow 5 (prompt). Run all flows, all must pass.
8. **After Task 8**: Add change confirmation check to Flow 5. Run all, all must pass.
9. **After Task 9**: Add Flow 6 (history). Run all flows, all must pass.
10. **After Task 10**: Add Flow 7 (full integration). Run ALL flows. ALL must pass. Zero `fail()` results.

### npm script

Add to `package.json`:
```json
"test:visual-edit": "node test/visual-edit.mjs"
```

---

## Out of Scope

- Live CSS preview (applying changes in iframe before sending to agent) — future enhancement
- Screenshot annotation / drawing on screenshot — future enhancement
- Multi-element selection — future enhancement
- Before/After comparison view — future enhancement
- Template gallery / preset change library — future enhancement
- Persisting edit history across sessions — future enhancement
