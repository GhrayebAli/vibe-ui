/**
 * QA Test Harness for vibe-ui
 * Tests real user interactions, not just DOM existence.
 * Every test scrolls, clicks, types, and verifies VISIBLE outcomes.
 */
import { chromium } from "playwright";

const RESULTS = [];
let currentSection = "";
let bugCount = 0;
let passCount = 0;
let screenshotIdx = 0;

function section(name) {
  currentSection = name;
  console.log(`\n━━━ ${name} ━━━`);
}

function pass(desc) {
  passCount++;
  RESULTS.push({ section: currentSection, desc, ok: true });
  console.log(`  ✓ ${desc}`);
}

function fail(desc) {
  bugCount++;
  RESULTS.push({ section: currentSection, desc, ok: false });
  console.log(`  ✗ BUG: ${desc}`);
}

function check(condition, passMsg, failMsg) {
  if (condition) pass(passMsg);
  else fail(failMsg);
}

async function screenshot(page, label) {
  screenshotIdx++;
  const path = `/tmp/qa-${String(screenshotIdx).padStart(2, "0")}-${label}.png`;
  await page.screenshot({ path });
  return path;
}

// Helper: check if element is actually scrollable (has overflow content)
async function isScrollable(page, selector) {
  return page.$eval(selector, el => el.scrollHeight > el.clientHeight);
}

// Helper: check if text is visible in viewport of a scrollable container
async function isTextVisibleIn(page, containerSel, text) {
  return page.$eval(containerSel, (el, t) => {
    const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
    while (walker.nextNode()) {
      if (walker.currentNode.textContent.includes(t)) {
        const range = document.createRange();
        range.selectNode(walker.currentNode);
        const rect = range.getBoundingClientRect();
        const containerRect = el.getBoundingClientRect();
        // Check if the text node is within the visible scroll area
        return rect.top >= containerRect.top && rect.bottom <= containerRect.bottom;
      }
    }
    return false;
  }, text);
}

// Helper: get all visible text in element
async function visibleText(page, selector) {
  return page.$eval(selector, el => el.innerText || el.textContent || "");
}

async function run() {
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });

  // Capture JS errors
  const jsErrors = [];
  page.on("pageerror", err => jsErrors.push(err.message));
  page.on("console", msg => { if (msg.type() === "error") jsErrors.push(msg.text()); });

  console.log("╔══════════════════════════════════════╗");
  console.log("║     vibe-ui QA Test Harness          ║");
  console.log("╚══════════════════════════════════════╝");

  await page.goto("http://localhost:4000");
  await page.waitForTimeout(4000);

  // ═══════════════════════════════════════
  section("1. CHAT SCROLLING");
  // ═══════════════════════════════════════

  // First check if chat has content
  const chatMsgCount = await page.$$eval(".msg-user, .msg-agent, .msg-system", els => els.length);
  console.log(`  (${chatMsgCount} messages in chat)`);

  if (chatMsgCount > 0) {
    // Is the chat area scrollable?
    const chatScrollable = await isScrollable(page, "#chat");
    check(chatScrollable, "Chat area is scrollable (content overflows)", "Chat area NOT scrollable — content doesn't overflow or overflow is hidden");

    if (chatScrollable) {
      // Can we scroll up?
      const scrollBefore = await page.$eval("#chat", el => el.scrollTop);
      await page.$eval("#chat", el => el.scrollTop = 0);
      await page.waitForTimeout(300);
      const scrollAfter = await page.$eval("#chat", el => el.scrollTop);
      check(scrollBefore !== scrollAfter || scrollBefore === 0, "Can scroll chat to top", "Chat scroll to top failed");

      // Can we scroll down?
      await page.$eval("#chat", el => el.scrollTop = el.scrollHeight);
      await page.waitForTimeout(300);
      const scrollDown = await page.$eval("#chat", el => el.scrollTop);
      check(scrollDown > 0 || chatMsgCount < 5, "Can scroll chat to bottom", "Chat scroll to bottom failed");
    }

    // Is the latest message visible at the bottom?
    const lastMsgVisible = await page.$eval("#chat", el => {
      const msgs = el.querySelectorAll(".msg-user, .msg-agent");
      if (msgs.length === 0) return true;
      const last = msgs[msgs.length - 1];
      const rect = last.getBoundingClientRect();
      const chatRect = el.getBoundingClientRect();
      return rect.bottom <= chatRect.bottom + 50; // Allow 50px tolerance
    });
    check(lastMsgVisible, "Latest message visible at bottom of chat", "Latest message NOT visible — chat not auto-scrolled to bottom");
  } else {
    pass("No messages yet — scrolling N/A (empty state shown)");
  }

  await screenshot(page, "chat-scroll");

  // ═══════════════════════════════════════
  section("2. CHAT INPUT & SEND");
  // ═══════════════════════════════════════

  // Type a message
  await page.fill("#input", "Show me the routes in mock-api-gateway");
  const inputVal = await page.$eval("#input", el => el.value);
  check(inputVal.includes("routes"), "Can type in input field", "Input field not accepting text");

  // Send
  await page.click("#send-btn");
  await page.waitForTimeout(500);

  // User message should appear
  const newUserMsg = await page.$$eval(".msg-user", els => {
    const last = els[els.length - 1];
    return last ? last.textContent : "";
  });
  check(newUserMsg.includes("routes"), "User message rendered in chat after send", "User message NOT rendered after send");

  // Input should be cleared
  const inputCleared = await page.$eval("#input", el => el.value === "");
  check(inputCleared, "Input cleared after send", "Input NOT cleared after send");

  // Send button should be disabled
  const sendDisabled = await page.$eval("#send-btn", el => el.disabled);
  check(sendDisabled, "Send button disabled while agent works", "Send button NOT disabled during agent work");

  await screenshot(page, "after-send");

  // ═══════════════════════════════════════
  section("3. AGENT RESPONSE FLOW");
  // ═══════════════════════════════════════

  // Wait for thinking indicator
  let sawThinking = false;
  let sawActivity = false;
  let sawResponse = false;
  let sendReEnabled = false;
  const existingAgentMsgs = await page.$$eval(".msg-agent", els => els.length);

  for (let i = 0; i < 30; i++) {
    await page.waitForTimeout(2000);

    if (!sawThinking && await page.$(".thinking")) sawThinking = true;
    if (!sawActivity && await page.$(".activity-feed")) sawActivity = true;

    const currentAgentMsgs = await page.$$eval(".msg-agent", els => els.length);
    if (currentAgentMsgs > existingAgentMsgs) sawResponse = true;

    const disabled = await page.$eval("#send-btn", el => el.disabled);
    if (!disabled && sawResponse) sendReEnabled = true;

    if (i % 5 === 0) {
      await screenshot(page, `response-${i}s`);
      console.log(`  ... ${(i+1)*2}s: thinking=${sawThinking} activity=${sawActivity} response=${sawResponse} sendEnabled=${sendReEnabled}`);
    }

    if (sendReEnabled) break;

    // Check for error
    const errors = await page.$$eval(".msg-system, .msg-error", els => els.map(e => e.textContent));
    if (errors.some(e => e.includes("Error"))) {
      fail("Agent returned error: " + errors.find(e => e.includes("Error")));
      break;
    }
  }

  check(sawThinking, "Thinking indicator appeared", "Thinking indicator never appeared");
  check(sawActivity, "Activity feed showed tool usage", "Activity feed never appeared — tool events not reaching frontend");
  check(sawResponse, "Agent response rendered", "Agent response never appeared");
  check(sendReEnabled, "Send button re-enabled after completion", "Send button stayed disabled after response");

  await screenshot(page, "response-done");

  // ═══════════════════════════════════════
  section("4. CHAT SCROLL AFTER NEW MESSAGES");
  // ═══════════════════════════════════════

  // After agent response, is chat scrolled to show the new content?
  const chatAtBottom = await page.$eval("#chat", el => {
    return Math.abs((el.scrollTop + el.clientHeight) - el.scrollHeight) < 50;
  });
  check(chatAtBottom, "Chat auto-scrolled to bottom after new messages", "Chat NOT auto-scrolled — user can't see latest response");

  // Send another short message to test scroll behavior
  if (sendReEnabled) {
    await page.fill("#input", "Thanks, what about the models?");
    await page.click("#send-btn");
    await page.waitForTimeout(1000);
    const scrolledAfterSend = await page.$eval("#chat", el => {
      return Math.abs((el.scrollTop + el.clientHeight) - el.scrollHeight) < 50;
    });
    check(scrolledAfterSend, "Chat stays at bottom when sending new message", "Chat jumped away from bottom on new send");
  }

  // ═══════════════════════════════════════
  section("5. CODE TAB");
  // ═══════════════════════════════════════

  await page.click('.panel-tab[data-tab="code"]');
  await page.waitForTimeout(500);

  const codeTabActive = await page.$eval('#tab-code', el => el.classList.contains("active"));
  check(codeTabActive, "Code tab activates", "Code tab did not activate");

  const codePathText = await visibleText(page, "#code-path");
  const codeContentText = await visibleText(page, "#code-content");

  if (codeContentText.trim().length > 0) {
    pass(`Code tab shows content: ${codeContentText.slice(0, 60)}...`);
  } else if (codePathText.includes("No file")) {
    fail("Code tab shows 'No file selected' — should show last changed file or a default project file");
  } else {
    fail(`Code tab has path "${codePathText}" but no content`);
  }

  await screenshot(page, "code-tab");

  // ═══════════════════════════════════════
  section("6. CONSOLE TAB");
  // ═══════════════════════════════════════

  await page.click('.panel-tab[data-tab="console"]');
  await page.waitForTimeout(500);

  const consoleTabActive = await page.$eval('#tab-console', el => el.classList.contains("active"));
  check(consoleTabActive, "Console tab activates", "Console tab did not activate");

  const consoleText = await visibleText(page, "#console-view");
  if (consoleText.trim().length > 0) {
    pass(`Console has output: ${consoleText.slice(0, 80)}...`);
  } else {
    fail("Console tab is empty — should show dev server errors/warnings or at least a 'No output' message");
  }

  await screenshot(page, "console-tab");

  // Switch back to preview
  await page.click('.panel-tab[data-tab="preview"]');
  await page.waitForTimeout(300);

  // ═══════════════════════════════════════
  section("7. PREVIEW PANEL");
  // ═══════════════════════════════════════

  const iframeSrc = await page.$eval("#preview-frame", f => f.src);
  check(iframeSrc !== "about:blank", `Preview iframe has src: ${iframeSrc}`, "Preview iframe still showing about:blank");

  // Check if the iframe actually rendered content (not connection refused)
  // We can check if the loader is hidden
  const loaderState = await page.$eval("#preview-loading", el => ({
    hidden: el.classList.contains("hidden"),
    display: window.getComputedStyle(el).display,
  }));
  check(loaderState.hidden, "Preview loader hidden (content loaded)", `Preview loader still visible — iframe content may not have loaded (display: ${loaderState.display})`);

  // Check preview URL bar has value
  const urlBarVal = await page.$eval("#preview-url", el => el.value);
  check(urlBarVal.length > 0, `URL bar shows: ${urlBarVal}`, "URL bar is empty");

  await screenshot(page, "preview");

  // ═══════════════════════════════════════
  section("8. DEVICE TOGGLE");
  // ═══════════════════════════════════════

  await page.click('.pbar-btn[data-device="mobile"]');
  await page.waitForTimeout(500);
  const mobileWrapClass = await page.$eval("#preview-wrap", el => el.className);
  check(mobileWrapClass.includes("mobile"), "Mobile mode applied to preview", `Mobile class missing: "${mobileWrapClass}"`);

  // Check iframe width actually changed
  const iframeWidth = await page.$eval("#preview-frame", el => el.offsetWidth);
  check(iframeWidth <= 400, `Mobile iframe width: ${iframeWidth}px`, `Mobile iframe too wide: ${iframeWidth}px (should be ~390)`);

  await screenshot(page, "mobile-preview");
  await page.click('.pbar-btn[data-device="desktop"]');
  await page.waitForTimeout(300);

  // ═══════════════════════════════════════
  section("9. OVERLAYS — REAL CONTENT");
  // ═══════════════════════════════════════

  // History overlay
  await page.click('.strip-btn[data-overlay="history"]');
  await page.waitForTimeout(500);
  const historyContent = await visibleText(page, "#history-list");
  check(historyContent.length > 10, `History has content: "${historyContent.slice(0, 60)}..."`, "History overlay is empty or has no useful content");
  await screenshot(page, "overlay-history");
  await page.click('.strip-btn[data-overlay="history"]'); // close
  await page.waitForTimeout(300);

  // Status overlay
  await page.click('.strip-btn[data-overlay="status"]');
  await page.waitForTimeout(500);
  const statusContent = await visibleText(page, "#status-list");
  check(statusContent.includes("Running") || statusContent.includes("frontend"), `Status shows services: "${statusContent.slice(0, 80)}"`, "Status overlay has no service info");
  const runningBadges = await page.$$eval(".status-svc-badge.running", els => els.length);
  check(runningBadges === 3, `All 3 services show Running (${runningBadges}/3)`, `Only ${runningBadges}/3 services running`);
  await screenshot(page, "overlay-status");
  await page.click('.strip-btn[data-overlay="status"]');
  await page.waitForTimeout(300);

  // Notes overlay
  await page.click('.strip-btn[data-overlay="notes"]');
  await page.waitForTimeout(500);
  const notesEditorExists = await page.$("#notes-editor");
  check(!!notesEditorExists, "Notes overlay has editor textarea", "Notes editor missing");
  const genBtnExists = await page.$("#notes-gen");
  check(!!genBtnExists, "Generate button exists", "Generate button missing");
  await screenshot(page, "overlay-notes");
  await page.click('.strip-btn[data-overlay="notes"]');
  await page.waitForTimeout(300);

  // ═══════════════════════════════════════
  section("10. PLAN/BUILD MODE");
  // ═══════════════════════════════════════

  await page.click('.mode-btn[data-mode="plan"]');
  await page.waitForTimeout(200);
  const planPH = await page.$eval("#input", el => el.placeholder);
  check(planPH.includes("plan"), `Plan placeholder: "${planPH}"`, `Wrong placeholder in plan mode: "${planPH}"`);

  // Plan mode button should be visually active
  const planBtnActive = await page.$eval('.mode-btn[data-mode="plan"]', el => el.classList.contains("active"));
  check(planBtnActive, "Plan button highlighted", "Plan button not highlighted");

  await page.click('.mode-btn[data-mode="build"]');
  await page.waitForTimeout(200);

  // ═══════════════════════════════════════
  section("11. RESIZE HANDLE");
  // ═══════════════════════════════════════

  const leftPanelWidthBefore = await page.$eval("#left-panel", el => el.offsetWidth);
  const handle = await page.$("#resize-handle");
  const handleBox = await handle.boundingBox();

  // Drag handle to the right
  await page.mouse.move(handleBox.x + 2, handleBox.y + handleBox.height / 2);
  await page.mouse.down();
  await page.mouse.move(handleBox.x + 100, handleBox.y + handleBox.height / 2, { steps: 5 });
  await page.mouse.up();
  await page.waitForTimeout(300);

  const leftPanelWidthAfter = await page.$eval("#left-panel", el => el.offsetWidth);
  check(Math.abs(leftPanelWidthAfter - leftPanelWidthBefore) > 10, `Resize worked: ${leftPanelWidthBefore}px → ${leftPanelWidthAfter}px`, `Resize failed: width didn't change (${leftPanelWidthBefore}px → ${leftPanelWidthAfter}px)`);

  await screenshot(page, "resized");

  // ═══════════════════════════════════════
  section("12. BUDGET BAR");
  // ═══════════════════════════════════════

  const budgetText = await visibleText(page, "#budget-amount");
  check(budgetText.includes("$") && budgetText.includes("/"), `Budget displays: "${budgetText}"`, `Budget text wrong: "${budgetText}"`);

  const budgetBarVisible = await page.$eval(".budget-bar", el => el.offsetHeight > 0);
  check(budgetBarVisible, "Budget bar is visible", "Budget bar hidden or zero height");

  // ═══════════════════════════════════════
  section("13. HEALTH INDICATORS");
  // ═══════════════════════════════════════

  for (const { id, label } of [{ id: "h-fe", label: "Frontend" }, { id: "h-gw", label: "Gateway" }, { id: "h-core", label: "Core" }]) {
    const cls = await page.$eval(`#${id}`, el => el.className);
    const visible = await page.$eval(`#${id}`, el => el.offsetWidth > 0);
    check(cls.includes("ok") && visible, `${label} health dot green and visible`, `${label} health: class="${cls}" visible=${visible}`);
  }

  // ═══════════════════════════════════════
  section("14. VISUAL ISSUES");
  // ═══════════════════════════════════════

  // Check nothing overflows the viewport
  const bodyOverflow = await page.$eval("body", el => {
    return { scrollW: document.documentElement.scrollWidth, clientW: document.documentElement.clientWidth, scrollH: document.documentElement.scrollHeight, clientH: document.documentElement.clientHeight };
  });
  check(bodyOverflow.scrollW <= bodyOverflow.clientW + 5, "No horizontal overflow", `Horizontal overflow: scroll=${bodyOverflow.scrollW} client=${bodyOverflow.clientW}`);
  check(bodyOverflow.scrollH <= bodyOverflow.clientH + 5, "No vertical overflow (body)", `Vertical overflow: scroll=${bodyOverflow.scrollH} client=${bodyOverflow.clientH}`);

  // Check left panel doesn't overflow
  const leftPanelOverflow = await page.$eval("#left-panel", el => ({
    scrollH: el.scrollHeight, clientH: el.clientHeight, overflowY: window.getComputedStyle(el).overflowY
  }));
  console.log(`  Left panel: scrollH=${leftPanelOverflow.scrollH} clientH=${leftPanelOverflow.clientH} overflow=${leftPanelOverflow.overflowY}`);

  // Check chat area has proper overflow
  const chatOverflow = await page.$eval("#chat", el => ({
    overflowY: window.getComputedStyle(el).overflowY,
    scrollH: el.scrollHeight,
    clientH: el.clientHeight,
  }));
  check(chatOverflow.overflowY === "auto" || chatOverflow.overflowY === "scroll", `Chat overflow-y: ${chatOverflow.overflowY}`, `Chat overflow-y is "${chatOverflow.overflowY}" — should be auto or scroll`);

  await screenshot(page, "final");

  // ═══════════════════════════════════════
  section("15. JS ERRORS");
  // ═══════════════════════════════════════

  if (jsErrors.length > 0) {
    jsErrors.forEach(e => fail(`JS error: ${e}`));
  } else {
    pass("No JS errors during entire test");
  }

  // ═══════════════════════════════════════
  // SUMMARY
  // ═══════════════════════════════════════
  console.log("\n╔══════════════════════════════════════╗");
  console.log(`║  PASSED: ${passCount}  |  FAILED: ${bugCount}            ║`);
  console.log("╚══════════════════════════════════════╝");

  if (bugCount > 0) {
    console.log("\nBugs to fix:");
    RESULTS.filter(r => !r.ok).forEach((r, i) => {
      console.log(`  ${i + 1}. [${r.section}] ${r.desc}`);
    });
  } else {
    console.log("\n🎉 ALL TESTS PASSED!");
  }

  await browser.close();
}

run().catch(err => {
  console.error("Test crashed:", err.message);
  process.exit(1);
});
