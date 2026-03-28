import { Router } from "express";
import { getWorkspaceDir, getFrontendPort } from "../workspace-config.js";

export default function() {
  const router = Router();

  // Cached Playwright browser for element inspection
  let inspectBrowser = null;
  let inspectPage = null;
  let inspectLastPath = null;

  async function getInspectPage(targetPath) {
    if (!inspectBrowser) {
      let chromium;
      try { ({ chromium } = await import("playwright")); }
      catch {
        try { ({ chromium } = await import(`${getWorkspaceDir()}/vibe-ui/node_modules/playwright/index.mjs`)); }
        catch { ({ chromium } = await import(`${getWorkspaceDir()}/node_modules/playwright/index.mjs`)); }
      }
      inspectBrowser = await chromium.launch();
      inspectPage = await inspectBrowser.newPage({ viewport: { width: 1280, height: 720 } });
      await inspectPage.goto(`http://localhost:${getFrontendPort()}`, { waitUntil: "networkidle", timeout: 15000 });
      await inspectPage.waitForTimeout(1000);
      try {
        const loginBtn = await inspectPage.$('button:has-text("Login"), button:has-text("LOGIN")');
        if (loginBtn) {
          await loginBtn.click();
          await inspectPage.waitForNavigation({ waitUntil: "networkidle", timeout: 10000 }).catch(() => {});
          await inspectPage.waitForTimeout(1500);
        }
      } catch (e) {
        console.log("[inspect] Login click failed, trying localStorage fallback");
        await inspectPage.evaluate(() => { localStorage.setItem("auth_token", "mock-jwt-token-usr-001"); });
        await inspectPage.reload({ waitUntil: "networkidle", timeout: 10000 });
        await inspectPage.waitForTimeout(1000);
      }
      console.log("[inspect] Browser cached, URL:", inspectPage.url());
      inspectLastPath = new URL(inspectPage.url()).pathname;
    }
    if (targetPath && targetPath !== inspectLastPath) {
      await inspectPage.goto(`http://localhost:${getFrontendPort()}` + targetPath, { waitUntil: "networkidle", timeout: 10000 }).catch(() => {});
      await inspectPage.waitForTimeout(500);
      inspectLastPath = targetPath;
    }
    return inspectPage;
  }

  router.post("/inject-visual-helper", async (req, res) => {
    try {
      const page = await getInspectPage(null);
      await page.evaluate(() => {
        if (window.__veHelperActive) return;
        window.__veHelperActive = true;

        const TAG_NAMES = {
          button:'Button',a:'Link',img:'Image',p:'Paragraph',input:'Input Field',
          textarea:'Text Area',select:'Dropdown',table:'Table',tr:'Table Row',
          td:'Table Cell',th:'Table Cell',ul:'List',ol:'List',li:'List Item',
          nav:'Navigation',header:'Header',footer:'Footer',form:'Form',label:'Label',
          span:'Text',div:'Section',svg:'Icon',h1:'Heading',h2:'Heading',h3:'Heading',
          h4:'Heading',h5:'Heading',h6:'Heading',section:'Section',main:'Main Content',
        };
        const MUI_NAMES = {
          MuiButton:'Button',MuiCard:'Card',MuiAppBar:'Top Navigation Bar',
          MuiDrawer:'Sidebar',MuiTable:'Table',MuiTextField:'Text Field',
          MuiSelect:'Dropdown',MuiChip:'Tag',MuiAvatar:'Avatar',MuiDialog:'Dialog',
          MuiPaper:'Panel',MuiList:'List',MuiIconButton:'Icon Button',MuiToolbar:'Toolbar',
          MuiTypography:'Text',MuiContainer:'Container',MuiGrid:'Grid Layout',
        };
        function getName(el) {
          const cls = el.className || '';
          for (const [k,v] of Object.entries(MUI_NAMES)) { if (cls.includes(k)) return v; }
          return TAG_NAMES[el.tagName?.toLowerCase()] || el.tagName?.toLowerCase() || 'Element';
        }

        let highlightEl = null;
        const style = document.createElement('style');
        style.textContent = '.ve-iframe-highlight { outline: 2px solid rgba(66,133,244,0.8) !important; background-color: rgba(66,133,244,0.08) !important; } .ve-iframe-selected { outline: 2px solid #33d17a !important; box-shadow: 0 0 0 3px rgba(51,209,122,0.2) !important; background-color: rgba(51,209,122,0.06) !important; }';
        document.head.appendChild(style);

        window.addEventListener('message', (e) => {
          const msg = e.data;
          if (!msg || !msg.type?.startsWith('ve-')) return;

          if (msg.type === 've-mousemove') {
            const el = document.elementFromPoint(msg.x, msg.y);
            if (highlightEl) highlightEl.classList.remove('ve-iframe-highlight');
            if (el && el !== document.body && el !== document.documentElement) {
              highlightEl = el;
              el.classList.add('ve-iframe-highlight');
              const r = el.getBoundingClientRect();
              window.parent.postMessage({
                source: 've-helper', type: 've-hover',
                rect: { left: r.left, top: r.top, width: r.width, height: r.height, bottom: r.bottom },
                name: getName(el),
                tag: el.tagName?.toLowerCase(),
                classes: el.className || '',
                text: (el.textContent || '').trim().slice(0, 80),
              }, '*');
            }
          } else if (msg.type === 've-click') {
            const el = document.elementFromPoint(msg.x, msg.y);
            if (highlightEl) highlightEl.classList.remove('ve-iframe-highlight');
            document.querySelectorAll('.ve-iframe-selected').forEach(e => e.classList.remove('ve-iframe-selected'));
            if (el && el !== document.body && el !== document.documentElement) {
              el.classList.add('ve-iframe-selected');
              const r = el.getBoundingClientRect();
              const cs = getComputedStyle(el);
              window.parent.postMessage({
                source: 've-helper', type: 've-click',
                rect: { left: r.left, top: r.top, width: r.width, height: r.height },
                name: getName(el),
                tag: el.tagName?.toLowerCase(),
                classes: el.className || '',
                text: (el.textContent || '').trim().slice(0, 80),
                styles: { color: cs.color, backgroundColor: cs.backgroundColor, fontSize: cs.fontSize, padding: cs.padding },
              }, '*');
            }
          } else if (msg.type === 've-deactivate') {
            if (highlightEl) highlightEl.classList.remove('ve-iframe-highlight');
            document.querySelectorAll('.ve-iframe-selected').forEach(e => e.classList.remove('ve-iframe-selected'));
            window.__veHelperActive = false;
          }
        });
      });
      res.json({ ok: true });
    } catch (e) {
      res.json({ ok: false, error: e.message });
    }
  });

  router.post("/inspect-element", async (req, res) => {
    const { x, y, pctX, pctY, currentUrl } = req.body;
    if (x == null && pctX == null) return res.status(400).json({ error: "Missing coordinates" });

    try {
      let targetPath = "/";
      if (currentUrl) {
        try {
          const full = currentUrl.startsWith("http") ? currentUrl : "http://" + currentUrl;
          targetPath = new URL(full).pathname || "/";
        } catch {
          targetPath = currentUrl.startsWith("/") ? currentUrl : "/";
        }
      }
      console.log(`[inspect] targetPath="${targetPath}" from currentUrl="${currentUrl}"`);
      const page = await getInspectPage(targetPath);

      const viewportSize = page.viewportSize();
      const actualX = pctX != null ? Math.round(pctX * viewportSize.width) : x;
      const actualY = pctY != null ? Math.round(pctY * viewportSize.height) : y;
      console.log(`[inspect] coordinates: pct=(${pctX},${pctY}) actual=(${actualX},${actualY}) viewport=${viewportSize.width}x${viewportSize.height}`);

      const { writeFileSync: wfs } = await import("fs");
      const debugScreenshot = await page.screenshot({ type: "png" });
      wfs("/tmp/inspect-debug.png", debugScreenshot);
      console.log("[inspect] debug screenshot saved to /tmp/inspect-debug.png");
      console.log("[inspect] current URL:", page.url());

      const info = await page.evaluate(({ cx, cy }) => {
        const points = [[cx, cy]];
        for (const [dx, dy] of [[0,20],[0,40],[0,-20],[20,0],[-20,0],[20,20],[-20,20],[0,60],[0,-40],[40,20],[-40,20],[0,80]]) {
          points.push([cx + dx, cy + dy]);
        }

        const candidates = [];
        const seen = new Set();
        for (const [px, py] of points) {
          const e = document.elementFromPoint(px, py);
          if (!e || seen.has(e)) continue;
          seen.add(e);

          let compEl = e;
          while (compEl && compEl !== document.body) {
            if (compEl.dataset && compEl.dataset.component) break;
            compEl = compEl.parentElement;
          }
          const comp = compEl?.dataset?.component || null;
          const area = e.offsetWidth * e.offsetHeight;
          candidates.push({ el: e, comp, area, compEl });
        }

        candidates.sort((a, b) => {
          if (a.comp && !b.comp) return -1;
          if (!a.comp && b.comp) return 1;
          return a.area - b.area;
        });

        const best = candidates[0];
        if (!best) return null;
        const el = best.comp ? best.compEl : best.el;
        if (!el) return null;

        const comp = best.comp;
        const tag = el.tagName.toLowerCase();
        const classes = el.className ? String(el.className).split(" ").filter(Boolean).slice(0, 3).join(".") : "";
        const text = (el.textContent || "").trim().slice(0, 50);
        const id = el.id || "";
        const role = el.getAttribute("role") || "";
        const ariaLabel = el.getAttribute("aria-label") || "";

        const style = window.getComputedStyle(el);
        const currentStyles = {
          color: style.color,
          backgroundColor: style.backgroundColor,
          fontSize: style.fontSize,
          padding: style.padding,
        };

        let selectorParts = [];
        let n = el;
        for (let i = 0; i < 3 && n && n !== document.body; i++) {
          let part = n.tagName.toLowerCase();
          if (n.id) part += "#" + n.id;
          else if (n.className && typeof n.className === "string") {
            const cls = n.className.trim().split(/\s+/).slice(0, 2).join(".");
            if (cls) part += "." + cls;
          }
          selectorParts.unshift(part);
          n = n.parentElement;
        }
        const selector = selectorParts.join(" > ");

        let parentComp = null;
        if (el.parentElement) {
          let p = el.parentElement;
          while (p && p !== document.body) {
            if (p.dataset && p.dataset.component) {
              parentComp = p.dataset.component;
              break;
            }
            p = p.parentElement;
          }
        }

        return {
          tag, classes, text, id, role, ariaLabel,
          component: comp,
          parentComponent: parentComp,
          selector,
          currentStyles,
          outerHTML: el.outerHTML.slice(0, 200),
        };
      }, { cx: actualX, cy: actualY });

      const screenshot = await page.screenshot({ type: "png" });

      if (!info) return res.json({ found: false });

      let description = "";
      if (info.component) {
        const [name, file, line] = info.component.split(":");
        description = `Component: ${name} in ${file}${line ? `:${line}` : ""}`;
      } else {
        description = `<${info.tag}${info.classes ? "." + info.classes : ""}>${info.text ? ' "' + info.text + '"' : ""}`;
      }

      res.json({
        found: true,
        description,
        element: info,
        screenshot: screenshot.toString("base64"),
      });
    } catch (err) {
      console.error("[inspect]", err.message);
      res.status(500).json({ error: err.message });
    }
  });

  return router;
}
