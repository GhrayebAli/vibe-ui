/**
 * User Flow Tests
 * Each flow simulates a real user journey from start to finish.
 */
import { chromium } from "playwright";
import {
  flow, step, see, pass, fail, warn, check, screenshot,
  hasVisibleContent, getVisibleState, canUserType,
  results, VIDEO_DIR,
} from "./framework.mjs";

const BASE_URL = process.env.VIBE_URL || "http://localhost:4000";

async function run() {
  console.log("╔══════════════════════════════════════════╗");
  console.log("║   vibe-ui User Flow Tests                ║");
  console.log("║   Testing as a real user would           ║");
  console.log(`║   URL: ${BASE_URL.padEnd(33)}║`);
  console.log("╚══════════════════════════════════════════╝");

  const browser = await chromium.launch();
  const context = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    recordVideo: { dir: VIDEO_DIR, size: { width: 1440, height: 900 } },
  });

  const page = await context.newPage();
  const jsErrors = [];
  page.on("pageerror", err => jsErrors.push(err.message));

  // ═══════════════════════════════════════════
  // FLOW 1: First time user opens the app
  // ═══════════════════════════════════════════
  flow("Flow 1: First Time User");

  step("Open the app");
  await page.goto(BASE_URL);
  await page.waitForTimeout(4000);
  await screenshot(page, "initial-load");

  // Look at what's on screen
  const initState = await getVisibleState(page);
  see(`Top bar ${initState.topBar?.visible ? "visible" : "MISSING"}, Chat area ${initState.chat?.visible ? "visible" : "MISSING"}, Preview ${initState.preview?.visible ? "visible" : "MISSING"}`);

  check(initState.topBar?.visible, "Top bar is visible", "Top bar missing or hidden");
  check(initState.chat?.visible, "Chat area is visible", "Chat area missing or hidden");
  check(initState.preview?.visible, "Preview panel is visible", "Preview panel missing or hidden");
  check(initState.budgetBar?.visible, "Budget bar visible at bottom", "Budget bar missing");

  step("Check if I can start typing");
  const typeCheck = await canUserType(page);
  if (!typeCheck.canType) {
    see(`Can't type: ${typeCheck.reason}`);
    if (initState.branchLocked) {
      see("Branch lock is showing — need to create a branch first");

      step("Create a branch to unlock input");
      const branchInput = await page.$("#branch-input");
      if (branchInput) {
        await branchInput.fill("test-user-flow");
        await branchInput.press("Enter");
        await page.waitForTimeout(3000);
        await screenshot(page, "branch-created");

        const afterBranch = await canUserType(page);
        check(afterBranch.canType, "Input unlocked after branch creation", "Input still locked after branch creation: " + afterBranch.reason);
      } else {
        fail("Branch input element not found");
      }
    } else {
      fail("Can't type and no branch lock — unknown state: " + typeCheck.reason);
    }
  } else {
    pass("Input is ready for typing");
  }

  step("Check welcome state or session history");
  const welcome = await page.$("#welcome");
  const welcomeVisible = welcome ? await welcome.evaluate(el => el.offsetHeight > 0 && el.style.display !== "none") : false;
  const starters = await page.$$(".s-card");
  const visibleStarters = [];
  for (const s of starters) { if (await s.isVisible()) visibleStarters.push(s); }
  const existingMsgs = await page.$$(".msg-user, .msg-agent");

  if (welcomeVisible) {
    see(`Welcome screen with ${visibleStarters.length} prompt starters`);
    check(visibleStarters.length >= 4, `${visibleStarters.length} starter cards visible`, "Too few starter cards: " + visibleStarters.length);
  } else if (existingMsgs.length > 0) {
    see(`Previous session loaded with ${existingMsgs.length} messages`);
    pass("Session history restored");
    // Check for resume message
    const resumeMsg = await page.$$eval(".msg-system", els => els.some(e => e.textContent.includes("Session resumed")));
    check(resumeMsg, "Session resumed message shown", "No session resumed message despite loading history");
  } else {
    see("No welcome and no messages — blank state");
    warn("Unexpected blank state — neither welcome nor history");
  }
  await screenshot(page, "welcome-or-history");

  step("Check health indicators");
  const healthDots = await page.$$eval(".h-dot", dots => dots.map(d => ({ class: d.className, visible: d.offsetWidth > 0 })));
  see(`${healthDots.length} health dots, ${healthDots.filter(d => d.class.includes("ok")).length} green`);
  check(healthDots.length === 3, "3 health dots present", `Expected 3 health dots, got ${healthDots.length}`);
  const allGreen = healthDots.every(d => d.class.includes("ok"));
  check(allGreen, "All services healthy (green)", "Some services not green: " + healthDots.map(d => d.class).join(", "));

  step("Check preview panel shows the frontend app");
  const previewSrc = await page.$eval("#preview-frame", f => f.src);
  see(`Preview iframe src: ${previewSrc}`);
  check(previewSrc !== "about:blank", "Preview has a src URL", "Preview still showing about:blank");

  const previewLoaded = await page.$eval("#preview-loading", el => el.classList.contains("hidden")).catch(() => false);
  if (previewLoaded) {
    see("Preview loaded — frontend app is rendering");
    pass("Preview loaded successfully");
  } else {
    see("Preview still loading or showing error");
    warn("Preview may not have loaded — check if frontend is running");
  }
  await screenshot(page, "preview-state");

  // ═══════════════════════════════════════════
  // FLOW 2: Send a prompt and watch the agent work
  // ═══════════════════════════════════════════
  flow("Flow 2: Chat with Agent");

  step("Type a prompt");
  const canType2 = await canUserType(page);
  if (!canType2.canType) {
    fail("Cannot type in input: " + canType2.reason);
  } else {
    await page.fill("#input", "Show me the routes defined in the API gateway");
    const inputVal = await page.$eval("#input", el => el.value);
    see(`Typed: "${inputVal}"`);
    check(inputVal.includes("routes"), "Text appeared in input", "Input didn't accept text");
    await screenshot(page, "typed-prompt");

    step("Press Send");
    await page.click("#send-btn");
    await page.waitForTimeout(500);

    // User message should appear
    const lastUserMsg = await page.$$eval(".msg-user", els => els[els.length - 1]?.textContent || "");
    see(`User message bubble: "${lastUserMsg.slice(0, 50)}..."`);
    check(lastUserMsg.includes("routes"), "My message appeared in the chat", "User message not rendered");

    // Send button should be disabled
    const sendOff = await page.$eval("#send-btn", el => el.disabled);
    check(sendOff, "Send button disabled while agent works", "Send button still enabled during execution");

    await screenshot(page, "message-sent");

    step("Watch for thinking indicator");
    await page.waitForTimeout(2000);
    const thinking = await page.$(".thinking");
    if (thinking) {
      see("Thinking dots animation visible");
      pass("Thinking indicator appeared");
    } else {
      see("No thinking indicator visible");
      warn("Thinking indicator may have been too brief to capture");
    }
    await screenshot(page, "thinking");

    step("Wait for agent response");
    let gotResponse = false;
    let sawActivity = false;
    const startMsgCount = await page.$$eval(".msg-agent", els => els.length);

    for (let i = 0; i < 20; i++) {
      await page.waitForTimeout(3000);

      // Check for activity feed
      if (!sawActivity) {
        const activity = await page.$(".activity-feed");
        if (activity) {
          sawActivity = true;
          const actLabel = await page.$eval(".activity-label", el => el.textContent).catch(() => "");
          see(`Activity feed: "${actLabel}"`);
        }
      }

      // Check for response
      const currentMsgCount = await page.$$eval(".msg-agent", els => els.length);
      if (currentMsgCount > startMsgCount) {
        gotResponse = true;
        const lastResponse = await page.$$eval(".msg-agent .bubble", els => {
          const last = els[els.length - 1];
          return last ? last.textContent.slice(0, 100) : "";
        });
        see(`Agent responded: "${lastResponse}..."`);
        break;
      }

      // Check for errors
      const errorCards = await page.$$(".msg-error");
      if (errorCards.length > 0) {
        const errText = await errorCards[0].evaluate(el => el.textContent.slice(0, 100));
        see(`Error appeared: "${errText}"`);
        fail("Agent returned error: " + errText);
        break;
      }

      if (i % 4 === 0) see(`Waiting... ${(i + 1) * 3}s`);
      await screenshot(page, `waiting-${(i + 1) * 3}s`);
    }

    check(gotResponse, "Agent responded with content", "No agent response after 60s");
    if (sawActivity) pass("Activity feed showed tool usage");
    else warn("No activity feed seen during execution");

    await screenshot(page, "response-received");

    step("Verify I can send another message");
    const sendEnabled = await page.$eval("#send-btn", el => !el.disabled);
    check(sendEnabled, "Send button re-enabled after response", "Send button still disabled");

    step("Check chat is scrollable and at bottom");
    const scrollState = await page.$eval("#chat", el => ({
      scrollable: el.scrollHeight > el.clientHeight,
      atBottom: Math.abs((el.scrollTop + el.clientHeight) - el.scrollHeight) < 50,
    }));
    if (scrollState.scrollable) {
      check(scrollState.atBottom, "Chat scrolled to show latest message", "Chat not scrolled to bottom — user can't see response");
    } else {
      see("Chat not scrollable yet (not enough messages)");
    }
  }

  // ═══════════════════════════════════════════
  // FLOW 3: Explore the Code tab
  // ═══════════════════════════════════════════
  flow("Flow 3: Code Tab Experience");

  step("Click Code tab");
  await page.click('.panel-tab[data-tab="code"]');
  await page.waitForTimeout(2000);
  await screenshot(page, "code-tab-opened");

  const codeState = await page.evaluate(() => {
    const sidebar = document.getElementById("code-sidebar");
    const content = document.getElementById("code-content");
    const path = document.getElementById("code-path");
    return {
      sidebarFiles: sidebar ? sidebar.querySelectorAll(".code-sidebar-file").length : 0,
      hasContent: content ? content.textContent.trim().length > 0 : false,
      pathText: path ? path.textContent : "",
      contentPreview: content ? content.textContent.slice(0, 80) : "",
    };
  });

  see(`File sidebar: ${codeState.sidebarFiles} files`);
  see(`Current file: ${codeState.pathText}`);
  see(`Content: ${codeState.hasContent ? codeState.contentPreview + "..." : "EMPTY"}`);

  check(codeState.sidebarFiles > 0, `${codeState.sidebarFiles} files in sidebar`, "No files in sidebar — file list didn't load");
  check(codeState.hasContent, "Code content is showing", "Code content is EMPTY — no file loaded");

  step("Click a different file");
  const files = await page.$$(".code-sidebar-file");
  if (files.length > 3) {
    const targetFile = files[3];
    const fileName = await targetFile.evaluate(el => el.textContent);
    await targetFile.click();
    await page.waitForTimeout(1000);
    await screenshot(page, "different-file");

    const newPath = await page.$eval("#code-path", el => el.textContent);
    see(`Switched to: ${newPath}`);
    check(newPath !== codeState.pathText || fileName === codeState.pathText, "File changed when clicked", "File didn't change on click");
  }

  // Go back to preview
  await page.click('.panel-tab[data-tab="preview"]');

  // ═══════════════════════════════════════════
  // FLOW 4: Console tab
  // ═══════════════════════════════════════════
  flow("Flow 4: Console Tab");

  step("Open Console tab");
  await page.click('.panel-tab[data-tab="console"]');
  await page.waitForTimeout(6000); // Wait for poll
  await screenshot(page, "console-tab");

  const consoleContent = await page.$eval("#console-view", el => el.innerText.trim());
  see(`Console shows: ${consoleContent.length > 0 ? consoleContent.slice(0, 100) : "NOTHING"}`);
  check(consoleContent.length > 0, "Console has output", "Console is completely empty — no log entries at all");

  await page.click('.panel-tab[data-tab="preview"]');

  // ═══════════════════════════════════════════
  // FLOW 5: Visual Edit Mode
  // ═══════════════════════════════════════════
  flow("Flow 5: Visual Edit Mode");

  step("Click pencil button to activate");
  await page.click("#visual-edit-btn");
  await page.waitForTimeout(500);
  await screenshot(page, "visual-edit-activated");

  const veOverlay = await page.$(".visual-overlay");
  see(`Overlay: ${veOverlay ? "appeared" : "NOT visible"}`);
  check(!!veOverlay, "Visual edit overlay appeared", "Overlay did not appear on button click");

  if (veOverlay) {
    step("Click on the preview to select an element");
    const box = await veOverlay.boundingBox();
    await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
    await page.waitForTimeout(500);
    await screenshot(page, "element-clicked");

    const editPanel = await page.$(".edit-panel");
    see(`Edit panel: ${editPanel ? "visible" : "NOT visible"}`);
    check(!!editPanel, "Edit panel appeared after clicking", "Edit panel did not appear — click handler may be broken");

    if (editPanel) {
      step("Check edit panel has input fields");
      const customInput = await editPanel.$("#ep-custom");
      const saveBtn = await editPanel.$(".ep-save");
      const cancelBtn = await editPanel.$(".ep-cancel");
      see(`Custom input: ${!!customInput}, Save: ${!!saveBtn}, Cancel: ${!!cancelBtn}`);
      check(!!customInput, "Custom prompt input exists", "Custom input missing from edit panel");
      check(!!saveBtn, "Save button exists", "Save button missing");

      step("Cancel to close");
      if (cancelBtn) await cancelBtn.click();
      await page.waitForTimeout(300);
      const panelGone = !(await page.$(".edit-panel"));
      check(panelGone, "Edit panel closed on Cancel", "Edit panel still visible after Cancel");
    }

    step("Deactivate visual edit");
    await page.click("#visual-edit-btn");
    await page.waitForTimeout(300);
    const overlayGone = !(await page.$(".visual-overlay"));
    check(overlayGone, "Overlay removed on deactivate", "Overlay still present after deactivate");
  }

  // ═══════════════════════════════════════════
  // FLOW 6: Overlays
  // ═══════════════════════════════════════════
  flow("Flow 6: Overlay Panels");

  for (const [name, label] of [["history", "Version History"], ["status", "Service Status"], ["notes", "MVP Notes"]]) {
    step(`Open ${label} overlay`);
    await page.click(`.strip-btn[data-overlay="${name}"]`);
    await page.waitForTimeout(500);
    await screenshot(page, `overlay-${name}`);

    const overlayOpen = await page.$eval(`#overlay-${name}`, el => el.classList.contains("open"));
    see(`${label} overlay: ${overlayOpen ? "open" : "NOT open"}`);
    check(overlayOpen, `${label} overlay opened`, `${label} overlay failed to open`);

    if (overlayOpen) {
      const content = await hasVisibleContent(page, `#overlay-${name}`);
      check(content, `${label} has content`, `${label} overlay is empty`);
    }

    // Close
    await page.click(`.strip-btn[data-overlay="${name}"]`);
    await page.waitForTimeout(300);
  }

  // ═══════════════════════════════════════════
  // FLOW 7: Device toggle and preview controls
  // ═══════════════════════════════════════════
  flow("Flow 7: Preview Controls");

  step("Switch to mobile preview");
  await page.click('.pbar-btn[data-device="mobile"]');
  await page.waitForTimeout(500);
  await screenshot(page, "mobile-preview");

  const mobileWidth = await page.$eval("#preview-frame", el => el.offsetWidth);
  see(`Mobile iframe width: ${mobileWidth}px`);
  check(mobileWidth <= 400, "Mobile preview is narrow", `Mobile preview too wide: ${mobileWidth}px`);

  step("Switch back to desktop");
  await page.click('.pbar-btn[data-device="desktop"]');
  await page.waitForTimeout(300);

  step("Test refresh button");
  await page.click("#preview-refresh");
  await page.waitForTimeout(1000);
  pass("Refresh button clicked without error");

  // ═══════════════════════════════════════════
  // FLOW 8: Plan/Build mode
  // ═══════════════════════════════════════════
  flow("Flow 8: Plan vs Build Mode");

  step("Switch to Plan mode");
  await page.click('.mode-btn[data-mode="plan"]');
  await page.waitForTimeout(300);
  const planPH = await page.$eval("#input", el => el.placeholder);
  see(`Plan placeholder: "${planPH}"`);
  check(planPH.includes("plan"), "Placeholder changed for Plan mode", "Placeholder didn't change");
  await screenshot(page, "plan-mode");

  step("Switch back to Build mode");
  await page.click('.mode-btn[data-mode="build"]');
  await page.waitForTimeout(300);
  const buildPH = await page.$eval("#input", el => el.placeholder);
  check(buildPH.includes("build"), "Placeholder changed for Build mode", "Placeholder didn't change back");

  // ═══════════════════════════════════════════
  // FLOW 9: Resize handle
  // ═══════════════════════════════════════════
  flow("Flow 9: Resize Panel");

  step("Drag resize handle to the right");
  const handle = await page.$("#resize-handle");
  const hBox = await handle.boundingBox();
  const leftWidthBefore = await page.$eval("#left-panel", el => el.offsetWidth);

  await page.mouse.move(hBox.x + 2, hBox.y + hBox.height / 2);
  await page.mouse.down();
  await page.mouse.move(hBox.x + 80, hBox.y + hBox.height / 2, { steps: 5 });
  await page.mouse.up();
  await page.waitForTimeout(300);

  const leftWidthAfter = await page.$eval("#left-panel", el => el.offsetWidth);
  see(`Left panel: ${leftWidthBefore}px → ${leftWidthAfter}px`);
  check(leftWidthAfter > leftWidthBefore, "Panel resized wider", "Panel didn't resize");
  await screenshot(page, "resized");

  // ═══════════════════════════════════════════
  // FINAL: JS Errors & Summary
  // ═══════════════════════════════════════════
  flow("Final Checks");

  step("Check for JS errors");
  const realErrors = jsErrors.filter(e => !e.includes("clipboard") && !e.includes("Clipboard"));
  if (realErrors.length > 0) {
    see(`${realErrors.length} JS errors occurred during testing`);
    realErrors.forEach(e => fail(`JS error: ${e}`));
  } else {
    see("No JS errors during the entire test");
    pass("Zero JS errors");
  }

  await screenshot(page, "final-state");

  // Close
  await context.close();
  await browser.close();

  // ═══════════════════════════════════════════
  // SUMMARY
  // ═══════════════════════════════════════════
  console.log("\n" + "═".repeat(50));
  console.log(`  RESULTS: ${results.passed} passed, ${results.failed} failed, ${results.warnings} warnings`);
  console.log(`  Screenshots: ${results.screenshots.length} captured`);
  console.log("═".repeat(50));

  if (results.bugs.length > 0) {
    console.log("\n  Bugs found:");
    results.bugs.forEach((b, i) => console.log(`    ${i + 1}. [${b.flow}] ${b.desc}`));
  }

  if (results.warnings > 0) {
    console.log(`\n  ${results.warnings} warnings — review screenshots for visual issues`);
  }

  if (results.failed === 0) {
    console.log("\n  🎉 ALL FLOWS PASSED — app works as a real user would expect");
  }

  // Return exit code
  process.exit(results.failed > 0 ? 1 : 0);
}

run().catch(err => {
  console.error("\nTest framework crashed:", err.message);
  process.exit(2);
});
