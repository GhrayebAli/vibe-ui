import { Router } from "express";
import { execSync } from "child_process";
import { readFileSync, existsSync } from "fs";
import { join } from "path";
import { getTotalCost, getSessionByBranch, getBranchCosts, getMessageCount } from "../../db.js";
import { getWorkspaceDir, getConfig, getServicesConfig, getFrontendRepo, getRepoNames, getClientConfig } from "../workspace-config.js";
import { sanitizeBranchName } from "../sanitize.js";

export default function({ presence, discoverRepos, detectDefaultBranch, configuredServices }) {
  const router = Router();

  router.get("/workspace-config", (_req, res) => res.json(getClientConfig()));

  router.get("/health", (_req, res) => res.json({ status: "ok", service: "vibe-ui", port: 4000 }));

  router.get("/service-health", async (_req, res) => {
    const services = configuredServices;
    const results = await Promise.all(
      services.map(async (svc) => {
        try {
          const controller = new AbortController();
          const timeout = setTimeout(() => controller.abort(), 3000);
          const resp = await fetch(svc.url, { signal: controller.signal });
          clearTimeout(timeout);
          return { name: svc.name, status: "healthy", port: svc.port };
        } catch {
          return { name: svc.name, status: "unhealthy", port: svc.port };
        }
      })
    );
    res.json({ services: results });
  });

  router.get("/cost", (_req, res) => {
    const totalCost = getTotalCost();
    const dailyBudget = 60;
    res.json({ totalCost, dailyBudget, remaining: Math.max(0, dailyBudget - totalCost), budgetExceeded: totalCost >= dailyBudget });
  });

  router.get("/workspace", (_req, res) => {
    try {
      const cfg = getConfig();
      const repos = (cfg && cfg.repos && cfg.repos.length > 0) ? cfg.repos : discoverRepos();
      const defaultBranch = detectDefaultBranch(repos);
      const workspaceDir = getWorkspaceDir();

      let activeBranch = null;
      try {
        activeBranch = readFileSync(join(workspaceDir, ".active-branch"), "utf-8").trim();
      } catch (e) { console.warn("[workspace] .active-branch read failed:", e.message); }
      if (!activeBranch && repos.length > 0) {
        try {
          activeBranch = execSync(`git -C "${repos[0].path}" rev-parse --abbrev-ref HEAD`, { stdio: "pipe" }).toString().trim();
        } catch (e) { console.warn("[workspace] git HEAD detection failed:", e.message); }
      }

      const branches = [];
      const seenBranches = new Set();
      const branchCostMap = {};
      try {
        for (const row of getBranchCosts()) {
          branchCostMap[row.branch] = row.total_cost;
        }
      } catch {}

      if (repos.length > 0) {
        const repoPath = repos[0].path;
        try { execSync(`git -C "${repoPath}" fetch origin --prune 2>/dev/null`, { stdio: "pipe", timeout: 10000 }); } catch (e) { console.warn("[workspace] git fetch prune failed:", e.message); }

        const mergedBranches = new Set();
        try {
          const merged = execSync(
            `git -C "${repoPath}" branch --merged ${sanitizeBranchName(defaultBranch)} --list "mvp/*" --format="%(refname:short)"`,
            { stdio: "pipe" }
          ).toString().trim();
          for (const b of merged.split("\n").filter(Boolean)) mergedBranches.add(b);
        } catch (e) { console.warn("[workspace] merged branch check failed:", e.message); }
        try {
          const vv = execSync(
            `git -C "${repoPath}" branch -vv --list "mvp/*"`,
            { stdio: "pipe" }
          ).toString().trim();
          for (const line of vv.split("\n").filter(Boolean)) {
            if (/: gone\]/.test(line)) {
              const name = line.trim().replace(/^\*\s*/, "").split(/\s+/)[0];
              if (name) mergedBranches.add(name);
            }
          }
        } catch (e) { console.warn("[workspace] gone branch check failed:", e.message); }

        try {
          const branchList = execSync(
            `git -C "${repoPath}" branch --list "mvp/*" --format="%(refname:short)|%(committerdate:unix)"`,
            { stdio: "pipe" }
          ).toString().trim();
          for (const line of branchList.split("\n").filter(Boolean)) {
            const [name, ts] = line.split("|");
            if (mergedBranches.has(name)) continue;
            seenBranches.add(name);
            const session = getSessionByBranch(name);
            const msgCount = session ? getMessageCount(session.id) : 0;
            let commitCount = 0, lastCommitMsg = '', filesChanged = 0;
            let latestCommitTs = 0;
            for (const repo of repos) {
              try {
                const c = parseInt(execSync(
                  `git -C "${repo.path}" rev-list --count ${sanitizeBranchName(defaultBranch)}..${sanitizeBranchName(name)}`,
                  { stdio: "pipe" }
                ).toString().trim()) || 0;
                commitCount += c;
                if (c > 0) {
                  const files = execSync(
                    `git -C "${repo.path}" diff --name-only ${sanitizeBranchName(defaultBranch)}..${sanitizeBranchName(name)}`,
                    { stdio: "pipe" }
                  ).toString().trim().split("\n").filter(Boolean).length;
                  filesChanged += files;
                  const ts = parseInt(execSync(
                    `git -C "${repo.path}" log -1 --format=%ct ${sanitizeBranchName(name)}`,
                    { stdio: "pipe" }
                  ).toString().trim()) || 0;
                  if (ts > latestCommitTs) {
                    latestCommitTs = ts;
                    lastCommitMsg = execSync(
                      `git -C "${repo.path}" log -1 --pretty=%s ${sanitizeBranchName(name)}`,
                      { stdio: "pipe" }
                    ).toString().trim().slice(0, 100);
                  }
                }
              } catch {}
            }
            branches.push({
              name,
              local: true,
              lastActivity: ts ? new Date(parseInt(ts) * 1000).toISOString() : null,
              session: session ? { id: session.id, messageCount: msgCount, lastUsedAt: session.last_used_at, title: session.title || session.project_name || null, codespace: session.codespace_id || null } : null,
              commitCount,
              lastCommitMsg,
              filesChanged,
              cost: branchCostMap[name] || 0,
            });
          }
        } catch (e) { console.warn("[workspace] local branch listing failed:", e.message); }

        try {
          const remoteBranches = execSync(
            `git -C "${repoPath}" branch -r --list "origin/mvp/*" --format="%(refname:short)|%(committerdate:unix)"`,
            { stdio: "pipe" }
          ).toString().trim();
          for (const line of remoteBranches.split("\n").filter(Boolean)) {
            const [ref, ts] = line.split("|");
            const name = ref.replace("origin/", "");
            if (seenBranches.has(name) || mergedBranches.has(name)) continue;
            seenBranches.add(name);
            branches.push({
              name,
              local: false,
              lastActivity: ts ? new Date(parseInt(ts) * 1000).toISOString() : null,
              session: null,
            });
          }
        } catch (e) { console.warn("[workspace] remote branch listing failed:", e.message); }
      }

      branches.sort((a, b) => {
        const aTime = a.session?.lastUsedAt || (a.lastActivity ? new Date(a.lastActivity).getTime() / 1000 : 0);
        const bTime = b.session?.lastUsedAt || (b.lastActivity ? new Date(b.lastActivity).getTime() / 1000 : 0);
        return bTime - aTime;
      });

      const totalCost = getTotalCost();
      res.json({
        defaultBranch,
        activeBranch,
        repos,
        branches,
        budget: { spent: totalCost, limit: 60, remaining: Math.max(0, 60 - totalCost) },
      });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  router.get("/branch", (_req, res) => {
    try {
      const workspaceDir = getWorkspaceDir();
      const frontendRepo = getFrontendRepo();
      const branch = execSync(`git -C "${workspaceDir}/${frontendRepo.name}" rev-parse --abbrev-ref HEAD`, { stdio: "pipe" }).toString().trim();
      res.json({ branch });
    } catch {
      res.json({ branch: "unknown" });
    }
  });

  router.get("/presence", (_req, res) => res.json(presence.getPresence()));

  return router;
}
