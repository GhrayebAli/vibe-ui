/**
 * User-First Test Framework for vibe-ui
 *
 * Philosophy: Test like a user, not like a DOM inspector.
 * Every test step: screenshot → look → describe → verify → decide.
 */
import { chromium } from "playwright";
import { writeFileSync, mkdirSync, existsSync, readFileSync } from "fs";
import { join } from "path";

const SCREENSHOT_DIR = "/tmp/qa-screenshots";
const BASELINE_DIR = "/tmp/qa-baselines";
const VIDEO_DIR = "/tmp/qa-videos";

mkdirSync(SCREENSHOT_DIR, { recursive: true });
mkdirSync(BASELINE_DIR, { recursive: true });
mkdirSync(VIDEO_DIR, { recursive: true });

// ── Results tracking ──
const results = { passed: 0, failed: 0, warnings: 0, bugs: [], screenshots: [] };
let currentFlow = "";
let stepIdx = 0;

function flow(name) {
  currentFlow = name;
  stepIdx = 0;
  console.log(`\n${"═".repeat(50)}`);
  console.log(`  ${name}`);
  console.log(`${"═".repeat(50)}`);
}

function step(desc) {
  stepIdx++;
  console.log(`\n  Step ${stepIdx}: ${desc}`);
}

function see(desc) {
  console.log(`    👁  I see: ${desc}`);
}

function pass(desc) {
  results.passed++;
  console.log(`    ✓  ${desc}`);
}

function fail(desc) {
  results.failed++;
  results.bugs.push({ flow: currentFlow, step: stepIdx, desc });
  console.log(`    ✗  BUG: ${desc}`);
}

function warn(desc) {
  results.warnings++;
  console.log(`    ⚠  ${desc}`);
}

function check(condition, passMsg, failMsg) {
  if (condition) pass(passMsg);
  else fail(failMsg);
}

async function screenshot(page, label) {
  const filename = `${currentFlow.replace(/\s+/g, "-").toLowerCase()}-${stepIdx}-${label}.png`;
  const path = join(SCREENSHOT_DIR, filename);
  await page.screenshot({ path });
  results.screenshots.push({ flow: currentFlow, step: stepIdx, label, path });
  console.log(`    📸 ${filename}`);
  return path;
}

// ── Visual analysis helpers ──

// Check if an area of the page has visible content (not blank)
async function hasVisibleContent(page, selector) {
  return page.$eval(selector, el => {
    const rect = el.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) return false;
    const text = el.innerText || el.textContent || "";
    const children = el.querySelectorAll("*");
    return text.trim().length > 0 || children.length > 2;
  });
}

// Get what's actually visible on screen (not hidden by overflow)
async function getVisibleState(page) {
  return page.evaluate(() => {
    const state = {};
    // Check key areas
    const areas = {
      chat: "#chat",
      input: "#input",
      preview: "#preview-frame",
      topBar: ".top-bar",
      budgetBar: ".budget-bar",
      codeTab: "#tab-code",
      consoleTab: "#tab-console",
    };
    for (const [name, sel] of Object.entries(areas)) {
      const el = document.querySelector(sel);
      if (!el) { state[name] = "missing"; continue; }
      const rect = el.getBoundingClientRect();
      const style = window.getComputedStyle(el);
      state[name] = {
        visible: rect.width > 0 && rect.height > 0 && style.display !== "none" && style.visibility !== "hidden",
        size: `${Math.round(rect.width)}x${Math.round(rect.height)}`,
        hasContent: (el.innerText || "").trim().length > 0,
      };
    }
    // Active tab
    const activeTab = document.querySelector(".panel-tab.active");
    state.activeTab = activeTab?.dataset?.tab || "none";
    // Overlays
    const openOverlay = document.querySelector(".overlay.open");
    state.overlay = openOverlay ? openOverlay.id : "none";
    // Branch lock
    const branchLock = document.getElementById("branch-lock");
    state.branchLocked = branchLock && branchLock.style.display !== "none" && branchLock.offsetHeight > 0;
    // Input enabled
    const input = document.getElementById("input");
    state.inputEnabled = input && !input.disabled && input.offsetHeight > 0;
    return state;
  });
}

// Check if the user can actually interact with the input
async function canUserType(page) {
  const state = await getVisibleState(page);
  if (state.branchLocked) return { canType: false, reason: "Branch lock is showing — input hidden" };
  if (!state.inputEnabled) return { canType: false, reason: "Input is disabled or hidden" };
  if (!state.input?.visible) return { canType: false, reason: "Input not visible on screen" };
  return { canType: true };
}

// ── Exports ──
export {
  flow, step, see, pass, fail, warn, check, screenshot,
  hasVisibleContent, getVisibleState, canUserType,
  results, SCREENSHOT_DIR, VIDEO_DIR,
};
