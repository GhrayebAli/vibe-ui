import { Router } from "express";
import { execSync } from "child_process";
import { readFileSync, writeFileSync, existsSync } from "fs";
import { join } from "path";
import { getSessionByBranch, saveNotes, getMessagePreviews } from "../../db.js";
import { getWorkspaceDir, getConfig } from "../workspace-config.js";
import { sanitizeBranchName, sanitizePort, validateDevCommand } from "../sanitize.js";
import { spawn } from "child_process";

export default function({ presence, discoverRepos, detectDefaultBranch, configuredServices, wsBroadcast }) {
  const router = Router();

  router.post("/switch-branch", async (req, res) => {
    const { branch } = req.body;
    if (!branch) return res.status(400).json({ error: "Missing branch" });
    try { sanitizeBranchName(branch); } catch (e) { return res.status(400).json({ error: e.message }); }

    const lock = presence.getPresence().buildLock;
    if (lock && lock.branch !== branch) {
      return res.status(423).json({ error: "locked", lockedBy: lock.userName, branch: lock.branch });
    }

    const workspaceDir = getWorkspaceDir();
    const configRepos = getConfig().repos;

    let alreadyOnBranch = true;
    for (const cfgRepo of configRepos) {
      try {
        const current = execSync(`git -C "${join(workspaceDir, cfgRepo.name)}" rev-parse --abbrev-ref HEAD`, { stdio: "pipe" }).toString().trim();
        if (current !== branch) { alreadyOnBranch = false; break; }
      } catch { alreadyOnBranch = false; break; }
    }

    if (alreadyOnBranch) {
      try { writeFileSync(join(workspaceDir, ".active-branch"), branch); } catch {}
      return res.json({ ok: true, branch, switched: [], installed: [], restarted: [], skipped: true });
    }

    const switched = [];
    const installed = [];
    const restarted = [];
    const defaultBranch = detectDefaultBranch(discoverRepos());

    // Auto-save notes for the branch we're leaving
    try {
      const currentBranchFile = join(workspaceDir, ".active-branch");
      const leavingBranch = existsSync(currentBranchFile) ? readFileSync(currentBranchFile, "utf-8").trim() : null;
      if (leavingBranch && leavingBranch !== branch && leavingBranch.startsWith("mvp/")) {
        const repos = discoverRepos();
        const defBranch = detectDefaultBranch(repos);
        let hasChanges = false;

        for (const repo of repos) {
          try {
            const c = parseInt(execSync(`git -C "${repo.path}" rev-list --count ${defBranch}..HEAD 2>/dev/null`, { stdio: "pipe" }).toString().trim()) || 0;
            if (c > 0) { hasChanges = true; break; }
          } catch {}
        }

        if (hasChanges) {
          const session = getSessionByBranch(leavingBranch);
          const featureName = leavingBranch.replace('mvp/', '').replace(/-/g, ' ');

          const changes = [];
          if (session) {
            try {
              const msgs = getMessagePreviews(session.id);
              let lastUserMsg = '';
              for (const m of msgs) {
                try {
                  const parsed = JSON.parse(m.preview);
                  if (m.role === 'user' && parsed.text) {
                    lastUserMsg = parsed.text.replace(/\[Attached image:[^\]]+\]\s*/g, '').trim();
                  } else if (m.role === 'assistant' && parsed.text && lastUserMsg) {
                    const response = parsed.text.replace(/^(Done!?|Here'?s?|I'll|Let me|OK|Sure|Perfect)[.!,\s]*/i, '').trim();
                    const summary = response.split(/[.\n]/)[0]?.trim();
                    if (summary && summary.length > 15 && !summary.startsWith('What') && !summary.startsWith('Which')) {
                      changes.push(`- ${summary}`);
                    } else if (lastUserMsg.length > 5) {
                      changes.push(`- ${lastUserMsg}`);
                    }
                    lastUserMsg = '';
                  }
                } catch {}
              }
            } catch {}
          }

          const repoSections = [];
          let totalCommits = 0, totalFiles = 0;
          for (const repo of repos) {
            try {
              const count = parseInt(execSync(`git -C "${repo.path}" rev-list --count ${defBranch}..HEAD 2>/dev/null`, { stdio: "pipe" }).toString().trim()) || 0;
              if (count === 0) continue;
              totalCommits += count;
              const files = execSync(`git -C "${repo.path}" diff --name-only ${defBranch}..HEAD 2>/dev/null`, { stdio: "pipe" }).toString().trim().split("\n").filter(Boolean);
              totalFiles += files.length;
              const stat = execSync(`git -C "${repo.path}" diff --stat ${defBranch}..HEAD 2>/dev/null`, { stdio: "pipe" }).toString().trim();
              const lastLine = stat.split("\n").pop() || '';
              repoSections.push(`*${repo.name}* — ${files.length} files\n${files.map(f => '  \u2022 \`' + f + '\`').join('\n')}\n  ${lastLine}`);
            } catch {}
          }

          const header = `*Feature: ${featureName}*`;
          const branchLine = `\n\`${leavingBranch}\``;
          const overview = `\n${totalCommits} changes across ${totalFiles} files in ${repoSections.length} project${repoSections.length > 1 ? 's' : ''}`;

          let stakeholderSummary = '';
          if (changes.length > 0 || repoSections.length > 0) {
            const touchedRepos = repos.filter(r => repoSections.some(s => s.startsWith(`*${r.name}*`))).map(r => r.name);
            const summaryParts = [];
            if (changes.length > 0) {
              const topChanges = changes.slice(0, 5).map(c => c.replace(/^- /, '').trim());
              summaryParts.push(topChanges.join('; '));
            }
            if (touchedRepos.length > 0) {
              summaryParts.push(`Affected areas: ${touchedRepos.join(', ')}`);
            }
            stakeholderSummary = `\n\n*Stakeholder summary*\n${summaryParts.join('. ')}.`;
          }

          const changeLog = changes.length > 0
            ? `\n\n*Changes delivered*\n${changes.map(c => c.replace(/^- /, '\u2022 ')).join('\n')}`
            : '';
          const technical = repoSections.length > 0
            ? `\n\n*Projects touched*\n\n${repoSections.join('\n\n')}`
            : '';
          const now = new Date();
          const date = now.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
          const time = now.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: true });
          const status = `\n\n\u2014\n_Auto-generated on ${date} at ${time}_`;

          saveNotes(leavingBranch, `${header}${branchLine}${overview}${stakeholderSummary}${changeLog}${technical}${status}`);
        }
      }
    } catch (e) {
      console.warn('[switch] Auto-notes failed:', e.message);
    }

    const steps = [];
    steps.push({ id: 'save-notes', label: 'Saving branch notes' });
    for (const cfgRepo of configRepos) {
      steps.push({ id: `checkout-${cfgRepo.name}`, label: `Switching ${cfgRepo.name}` });
      steps.push({ id: `deps-${cfgRepo.name}`, label: `Checking dependencies` });
      if (cfgRepo.port && cfgRepo.dev) {
        steps.push({ id: `restart-${cfgRepo.name}`, label: `Restarting ${cfgRepo.name}` });
      }
    }
    steps.push({ id: 'services-ready', label: 'Waiting for services' });

    wsBroadcast({ type: 'switch_progress', phase: 'start', branch, steps });
    wsBroadcast({ type: 'switch_progress', phase: 'step', stepId: 'save-notes', status: 'done' });

    for (const cfgRepo of configRepos) {
      const repoPath = join(workspaceDir, cfgRepo.name);
      const isMonorepo = cfgRepo.type === "monorepo";
      try {
        // Monorepos: stop all services before checkout to avoid working tree conflicts
        if (isMonorepo && cfgRepo.ports && cfgRepo.dev) {
          console.log(`[switch] Stopping ${cfgRepo.name} services before checkout (monorepo)`);
          for (const p of cfgRepo.ports) {
            try { execSync(`kill $(lsof -ti:${sanitizePort(p)} -sTCP:LISTEN) 2>/dev/null`, { stdio: "pipe" }); } catch {}
          }
          // Wait for processes to exit
          execSync("sleep 2", { stdio: "pipe" });
        }

        wsBroadcast({ type: 'switch_progress', phase: 'step', stepId: `checkout-${cfgRepo.name}`, status: 'active' });
        try {
          execSync(`git -C "${repoPath}" checkout "${branch}"`, { stdio: "pipe" });
          switched.push(cfgRepo.name);
        } catch {
          try {
            execSync(`git -C "${repoPath}" fetch origin "${branch}" 2>/dev/null && git -C "${repoPath}" checkout "${branch}"`, { stdio: "pipe" });
            switched.push(cfgRepo.name);
          } catch (checkoutErr) {
            console.log(`[switch] ${cfgRepo.name}: checkout failed for ${branch} — ${checkoutErr.stderr?.toString().trim() || checkoutErr.message}`);
          }
        }
        wsBroadcast({ type: 'switch_progress', phase: 'step', stepId: `checkout-${cfgRepo.name}`, status: 'done' });

        let changedFilesInRepo = [];
        wsBroadcast({ type: 'switch_progress', phase: 'step', stepId: `deps-${cfgRepo.name}`, status: 'active' });
        if (switched.includes(cfgRepo.name)) {
          try {
            changedFilesInRepo = execSync(`git -C "${repoPath}" diff ${sanitizeBranchName(defaultBranch)}..HEAD --name-only 2>/dev/null`, { stdio: "pipe" }).toString().trim().split("\n").filter(Boolean);
          } catch {}

          const lockfile = existsSync(join(repoPath, "yarn.lock")) ? "yarn.lock" : "package-lock.json";
          if (changedFilesInRepo.includes(lockfile)) {
            const installCmd = existsSync(join(repoPath, "yarn.lock")) ? "yarn install" : "npm install";
            try {
              execSync(`cd "${repoPath}" && ${installCmd}`, { stdio: "pipe", timeout: 120000 });
              installed.push(cfgRepo.name);
            } catch {}
          }
        }
        wsBroadcast({ type: 'switch_progress', phase: 'step', stepId: `deps-${cfgRepo.name}`, status: 'done' });

        if (cfgRepo.port && cfgRepo.dev) {
          const safePort = sanitizePort(cfgRepo.port);
          if (!validateDevCommand(cfgRepo.dev)) {
            console.warn(`[switch] Blocked unsafe dev command for ${cfgRepo.name}: ${cfgRepo.dev}`);
          } else {
            // Monorepos always restart (services were stopped before checkout)
            const needsRestart = isMonorepo ? true
              : !switched.includes(cfgRepo.name) ? false
              : changedFilesInRepo.length === 0 ? false
              : cfgRepo.type === "frontend" && changedFilesInRepo.every(f => f.startsWith("src/")) ? false
              : true;

            if (needsRestart) {
              wsBroadcast({ type: 'switch_progress', phase: 'step', stepId: `restart-${cfgRepo.name}`, status: 'active' });
              // For non-monorepos, kill the single port (monorepo ports already killed above)
              if (!isMonorepo) {
                try { execSync(`kill $(lsof -ti:${safePort} -sTCP:LISTEN) 2>/dev/null`, { stdio: "pipe" }); } catch {}
              }
              // Clear Next.js cache for monorepos — stale chunks cause 500s after branch switch
              if (isMonorepo && existsSync(join(repoPath, "apps/web/.next"))) {
                try { execSync(`rm -rf "${join(repoPath, "apps/web/.next")}"`, { stdio: "pipe" }); } catch {}
                console.log(`[switch] Cleared Next.js cache for ${cfgRepo.name}`);
              }
              const logFile = `/tmp/${cfgRepo.name}.log`;
              try { writeFileSync(logFile, ""); } catch {}
              const child = spawn("bash", ["-c", `cd "${repoPath}" && ${cfgRepo.dev} >> ${logFile} 2>&1`], { detached: true, stdio: "ignore" });
              child.unref();
              child.on("error", (err) => {
                console.error(`[spawn] ${cfgRepo.name} failed:`, err.message);
                wsBroadcast({ type: "system", text: `Failed to start ${cfgRepo.name}: ${err.message}` });
              });
              restarted.push(cfgRepo.name);
            } else {
              console.log(`[switch] ${cfgRepo.name}: no restart needed (${changedFilesInRepo.length} files changed, HMR or unchanged)`);
            }
            wsBroadcast({ type: 'switch_progress', phase: 'step', stepId: `restart-${cfgRepo.name}`, status: 'done' });
          }
        }
      } catch (err) {
        console.error(`[switch] Failed for ${cfgRepo.name}:`, err.message);
      }
    }

    if (process.env.CODESPACES === "true") {
      const publicPorts = getConfig().repos.filter(r => r.port && r.type === "frontend").map(r => r.port);
      getConfig().repos.filter(r => r.port).forEach(r => publicPorts.push(r.port));
      const uniquePorts = [...new Set(publicPorts)];
      if (uniquePorts.length > 0) {
        setTimeout(() => {
          const portsArg = uniquePorts.map(p => `${p}:public`).join(" ");
          try { execSync(`gh codespace ports visibility ${portsArg} 2>/dev/null`, { stdio: "pipe", timeout: 10000 }); } catch {}
        }, 5000);
      }
    }

    try {
      writeFileSync(join(workspaceDir, ".active-branch"), branch);
    } catch {}

    wsBroadcast({ type: 'switch_progress', phase: 'step', stepId: 'services-ready', status: 'active' });
    const maxWait = 30000, pollInterval = 1000;
    const startTime = Date.now();
    while (Date.now() - startTime < maxWait) {
      await new Promise(r => setTimeout(r, pollInterval));
      const results = await Promise.all(
        configuredServices.map(async (svc) => {
          try {
            const controller = new AbortController();
            const timeout = setTimeout(() => controller.abort(), 2000);
            const resp = await fetch(svc.url, { signal: controller.signal });
            clearTimeout(timeout);
            return { name: svc.name, ok: resp.ok };
          } catch { return { name: svc.name, ok: false }; }
        })
      );
      const pending = results.filter(r => !r.ok).map(r => r.name);
      if (pending.length === 0) break;
      wsBroadcast({ type: 'switch_progress', phase: 'step', stepId: 'services-ready', status: 'active', label: `Waiting for ${pending.join(', ')}` });
    }
    wsBroadcast({ type: 'switch_progress', phase: 'step', stepId: 'services-ready', status: 'done' });
    wsBroadcast({ type: 'switch_progress', phase: 'complete', branch });

    res.json({ ok: true, branch, switched, installed, restarted });
  });

  router.post("/create-branch", (req, res) => {
    const { name } = req.body;
    if (!name) return res.status(400).json({ error: "Missing name" });

    const slug = name.toLowerCase().replace(/[^a-z0-9\s-]/g, "").trim().replace(/[\s-]+/g, "-").slice(0, 50).replace(/-+$/, "");
    const branchName = `mvp/${slug || "feature-" + Date.now().toString(36)}`;
    try { sanitizeBranchName(branchName); } catch (e) { return res.status(400).json({ error: e.message }); }

    const repos = discoverRepos();
    const defBranch = detectDefaultBranch(repos);
    const configRepos = getConfig().repos;
    const created = [];

    // Stop monorepo services before checkout to avoid working tree conflicts
    for (const cfgRepo of configRepos) {
      if (cfgRepo.type === "monorepo" && cfgRepo.ports && cfgRepo.dev) {
        console.log(`[create-branch] Stopping ${cfgRepo.name} services (monorepo)`);
        for (const p of cfgRepo.ports) {
          try { execSync(`kill $(lsof -ti:${sanitizePort(p)} -sTCP:LISTEN) 2>/dev/null`, { stdio: "pipe" }); } catch {}
        }
        execSync("sleep 2", { stdio: "pipe" });
      }
    }

    for (const repo of repos) {
      try {
        try { execSync(`git -C "${repo.path}" checkout "${defBranch}"`, { stdio: "pipe" }); } catch {}
        try { execSync(`git -C "${repo.path}" pull origin "${defBranch}" 2>/dev/null`, { stdio: "pipe", timeout: 10000 }); } catch {}
        execSync(`git -C "${repo.path}" checkout -b "${branchName}"`, { stdio: "pipe" });
        created.push(repo.name);
      } catch (err) {
        try {
          execSync(`git -C "${repo.path}" checkout "${branchName}"`, { stdio: "pipe" });
          created.push(repo.name);
        } catch { console.error(`[create-branch] ${repo.name}:`, err.message); }
      }
    }

    // Restart monorepo services after branch creation
    for (const cfgRepo of configRepos) {
      if (cfgRepo.type === "monorepo" && cfgRepo.ports && cfgRepo.dev && validateDevCommand(cfgRepo.dev)) {
        const repoPath = join(getWorkspaceDir(), cfgRepo.name);
        if (existsSync(join(repoPath, "apps/web/.next"))) {
          try { execSync(`rm -rf "${join(repoPath, "apps/web/.next")}"`, { stdio: "pipe" }); } catch {}
        }
        const logFile = `/tmp/${cfgRepo.name}.log`;
        try { writeFileSync(logFile, ""); } catch {}
        spawn("bash", ["-c", `cd "${repoPath}" && ${cfgRepo.dev} >> ${logFile} 2>&1`], { detached: true, stdio: "ignore" }).unref();
        console.log(`[create-branch] Restarted ${cfgRepo.name}`);
      }
    }

    try { writeFileSync(join(getWorkspaceDir(), ".active-branch"), branchName); } catch {}

    res.json({ ok: true, branch: branchName, repos: created });
  });

  return router;
}
