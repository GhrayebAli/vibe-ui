// Repos Panel — browse, organize, and manage git repositories
import { $ } from "../core/dom.js";
import { on } from "../core/events.js";
import {
  fetchRepos,
  addRepo,
  updateRepo,
  deleteRepo,
  createRepoGroup,
  updateRepoGroup,
  deleteRepoGroup,
  browseFolders,
  execCommand,
} from "../core/api.js";
import { escapeHtml } from "../core/utils.js";
import { registerCommand } from "../ui/commands.js";
import { openRightPanel } from "../ui/right-panel.js";

let reposData = { groups: [], repos: [] };
let searchQuery = "";
let searchDebounce = null;

// Expand/collapse state persisted per group
const EXPAND_KEY = "shawkat-repos-expanded";
function getExpandedSet() {
  try {
    return new Set(JSON.parse(localStorage.getItem(EXPAND_KEY) || "[]"));
  } catch {
    return new Set();
  }
}
function saveExpandedSet(s) {
  localStorage.setItem(EXPAND_KEY, JSON.stringify([...s]));
}
function isGroupExpanded(id) {
  return getExpandedSet().has(id);
}
function toggleGroupExpanded(id) {
  const s = getExpandedSet();
  if (s.has(id)) s.delete(id);
  else s.add(id);
  saveExpandedSet(s);
}

// SVG icons
const CHEVRON_SVG = `<svg class="repos-chevron" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="9 18 15 12 9 6"/></svg>`;
const FOLDER_SVG = `<svg class="repos-icon folder" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/></svg>`;
const REPO_SVG = `<svg class="repos-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M15 22v-4a4.8 4.8 0 0 0-1-3.5c3 0 6-2 6-5.5.08-1.25-.27-2.48-1-3.5.28-1.15.28-2.35 0-3.5 0 0-1 0-3 1.5-2.64-.5-5.36-.5-8 0C6 2 5 2 5 2c-.3 1.15-.3 2.35 0 3.5A5.403 5.403 0 0 0 4 9c0 3.5 3 5.5 6 5.5-.39.49-.68 1.05-.85 1.65-.17.6-.22 1.23-.15 1.85v4"/><path d="M9 18c-4.51 2-5-2-7-2"/></svg>`;

// ── Data helpers ─────────────────────────────────────────

function getChildGroups(parentId) {
  return reposData.groups.filter((g) => g.parentId === parentId);
}

function getGroupRepos(groupId) {
  return reposData.repos.filter((r) => r.groupId === groupId);
}

function countReposInGroup(groupId) {
  let count = getGroupRepos(groupId).length;
  for (const child of getChildGroups(groupId)) {
    count += countReposInGroup(child.id);
  }
  return count;
}

function collectPathsInGroup(groupId) {
  const paths = getGroupRepos(groupId).map((r) => r.path);
  for (const child of getChildGroups(groupId)) {
    paths.push(...collectPathsInGroup(child.id));
  }
  return paths;
}

function matchesSearch(text) {
  if (!searchQuery) return true;
  return text.toLowerCase().includes(searchQuery.toLowerCase());
}

function groupMatchesSearch(groupId) {
  const group = reposData.groups.find((g) => g.id === groupId);
  if (group && matchesSearch(group.name)) return true;
  // Check if any repo in this group matches
  if (getGroupRepos(groupId).some((r) => matchesSearch(r.name) || matchesSearch(r.path))) return true;
  // Check child groups recursively
  return getChildGroups(groupId).some((g) => groupMatchesSearch(g.id));
}

// ── Loading ──────────────────────────────────────────────

async function loadRepos() {
  try {
    reposData = await fetchRepos();
  } catch {
    reposData = { groups: [], repos: [] };
  }
  renderTree();
}

// ── Rendering ────────────────────────────────────────────

function renderTree() {
  $.reposTree.innerHTML = "";

  const topGroups = getChildGroups(null);
  const ungroupedRepos = getGroupRepos(null);

  // Check if anything exists
  const hasContent = topGroups.length > 0 || ungroupedRepos.length > 0;

  if (!hasContent) {
    $.reposTree.innerHTML = `<div class="repos-empty">No repositories yet. Click + to add one.</div>`;
    return;
  }

  // Render top-level groups
  for (const group of topGroups) {
    if (searchQuery && !groupMatchesSearch(group.id)) continue;
    renderGroup(group, $.reposTree, 0);
  }

  // Render ungrouped repos
  for (const repo of ungroupedRepos) {
    if (searchQuery && !matchesSearch(repo.name) && !matchesSearch(repo.path)) continue;
    $.reposTree.appendChild(createRepoItem(repo, 0));
  }

  // If search active and nothing matched
  if (searchQuery && $.reposTree.children.length === 0) {
    $.reposTree.innerHTML = `<div class="repos-empty">No matches</div>`;
  }
}

function renderGroup(group, container, depth) {
  const expanded = isGroupExpanded(group.id);
  const count = countReposInGroup(group.id);

  const groupEl = document.createElement("div");
  groupEl.className = "repos-group-item";
  groupEl.style.paddingLeft = `${8 + depth * 16}px`;
  groupEl.dataset.groupId = group.id;

  groupEl.innerHTML = `
    ${CHEVRON_SVG}
    ${FOLDER_SVG}
    <span class="repos-group-name">${escapeHtml(group.name)}</span>
    <span class="repos-group-badge">${count}</span>
  `;

  const chevron = groupEl.querySelector(".repos-chevron");
  if (expanded) chevron.classList.add("expanded");

  // Click to expand/collapse
  groupEl.addEventListener("click", (e) => {
    if (e.target.closest(".repos-inline-input")) return;
    toggleGroupExpanded(group.id);
    chevron.classList.toggle("expanded");
    childrenEl.classList.toggle("expanded");
  });

  // Context menu
  groupEl.addEventListener("contextmenu", (e) => showGroupContextMenu(e, group));

  container.appendChild(groupEl);

  // Children container
  const childrenEl = document.createElement("div");
  childrenEl.className = "repos-group-children" + (expanded ? " expanded" : "");

  // Render child groups
  for (const child of getChildGroups(group.id)) {
    if (searchQuery && !groupMatchesSearch(child.id)) continue;
    renderGroup(child, childrenEl, depth + 1);
  }

  // Render repos in this group
  for (const repo of getGroupRepos(group.id)) {
    if (searchQuery && !matchesSearch(repo.name) && !matchesSearch(repo.path)) continue;
    childrenEl.appendChild(createRepoItem(repo, depth + 1));
  }

  container.appendChild(childrenEl);
}

function createRepoItem(repo, depth) {
  const item = document.createElement("div");
  item.className = "repos-repo-item";
  item.style.paddingLeft = `${8 + depth * 16}px`;
  item.dataset.repoId = repo.id;

  const subline = repo.path
    ? escapeHtml(repo.path.replace(/^\/Users\/[^/]+/, "~"))
    : repo.url
      ? escapeHtml(repo.url)
      : '<em>no path</em>';

  item.innerHTML = `
    ${REPO_SVG}
    <div class="repos-repo-info">
      <span class="repos-repo-name">${escapeHtml(repo.name)}</span>
      <span class="repos-repo-path">${subline}</span>
    </div>
  `;

  item.addEventListener("contextmenu", (e) => showRepoContextMenu(e, repo));
  if (repo.path) {
    item.addEventListener("dblclick", () => openInVSCode(repo.path));
  } else if (repo.url) {
    item.addEventListener("dblclick", () => window.open(repo.url, "_blank"));
  }

  return item;
}

// ── Context Menus ────────────────────────────────────────

let ctxMenu = null;

function hideContextMenu() {
  if (ctxMenu) {
    ctxMenu.remove();
    ctxMenu = null;
  }
}

function showRepoContextMenu(e, repo) {
  e.preventDefault();
  e.stopPropagation();
  hideContextMenu();

  ctxMenu = document.createElement("div");
  ctxMenu.className = "repos-ctx-menu";

  const items = [];

  // Open in Browser (only if URL is set)
  if (repo.url) {
    items.push({ label: "Open in Browser", action: () => window.open(repo.url, "_blank") });
  }

  // Path-dependent actions
  if (repo.path) {
    items.push({ label: "Open in VS Code", action: () => openInVSCode(repo.path) });
    items.push({ label: "Copy Path", action: () => navigator.clipboard.writeText(repo.path) });
  }

  // Set / Edit GitHub URL
  items.push({
    label: repo.url ? "Edit GitHub URL" : "Set GitHub URL",
    action: async () => {
      const url = prompt("GitHub URL:", repo.url || "");
      if (url === null) return;
      try {
        await updateRepo(repo.id, { url: url.trim() || null });
        await loadRepos();
      } catch (err) {
        console.error("Failed to set URL:", err);
      }
    },
  });

  for (const { label, action } of items) {
    const btn = document.createElement("button");
    btn.textContent = label;
    btn.addEventListener("click", () => {
      hideContextMenu();
      action();
    });
    ctxMenu.appendChild(btn);
  }

  // "Move to Group" submenu
  if (reposData.groups.length > 0 || repo.groupId) {
    const moveItem = document.createElement("div");
    moveItem.className = "repos-ctx-submenu-wrapper";

    const moveBtn = document.createElement("button");
    moveBtn.className = "repos-ctx-has-submenu";
    moveBtn.innerHTML = `Move to Group <span class="repos-ctx-arrow">&rsaquo;</span>`;
    moveItem.appendChild(moveBtn);

    const submenu = document.createElement("div");
    submenu.className = "repos-ctx-submenu";

    // "Ungrouped" option (move to root)
    if (repo.groupId) {
      const ungroupBtn = document.createElement("button");
      ungroupBtn.textContent = "Ungrouped";
      ungroupBtn.addEventListener("click", async () => {
        hideContextMenu();
        await updateRepo(repo.id, { groupId: null });
        await loadRepos();
      });
      submenu.appendChild(ungroupBtn);
    }

    // List all groups
    for (const group of reposData.groups) {
      if (group.id === repo.groupId) continue; // skip current group
      const groupBtn = document.createElement("button");
      groupBtn.textContent = group.name;
      groupBtn.addEventListener("click", async () => {
        hideContextMenu();
        await updateRepo(repo.id, { groupId: group.id });
        await loadRepos();
      });
      submenu.appendChild(groupBtn);
    }

    moveItem.appendChild(submenu);
    ctxMenu.appendChild(moveItem);
  }

  // Remove button last
  const removeBtn = document.createElement("button");
  removeBtn.textContent = "Remove";
  removeBtn.addEventListener("click", () => {
    hideContextMenu();
    removeRepo(repo);
  });
  ctxMenu.appendChild(removeBtn);

  positionMenu(ctxMenu, e.clientX, e.clientY);
}

function showGroupContextMenu(e, group) {
  e.preventDefault();
  e.stopPropagation();
  hideContextMenu();

  ctxMenu = document.createElement("div");
  ctxMenu.className = "repos-ctx-menu";

  const items = [
    { label: "Add Repo Here (Browse)", action: () => startAddRepo(group.id) },
    { label: "Add Repo Here (Manual)", action: () => startAddRepoManual(group.id) },
    { label: "Open All in VS Code", action: () => openAllInGroup(group.id) },
    { label: "Rename", action: () => startGroupRename(group) },
    { label: "Delete Group", action: () => removeGroup(group) },
  ];

  for (const { label, action } of items) {
    const btn = document.createElement("button");
    btn.textContent = label;
    btn.addEventListener("click", () => {
      hideContextMenu();
      action();
    });
    ctxMenu.appendChild(btn);
  }

  positionMenu(ctxMenu, e.clientX, e.clientY);
}

function positionMenu(menu, x, y) {
  menu.style.left = x + "px";
  menu.style.top = y + "px";
  document.body.appendChild(menu);

  const rect = menu.getBoundingClientRect();
  if (rect.right > window.innerWidth) menu.style.left = (x - rect.width) + "px";
  if (rect.bottom > window.innerHeight) menu.style.top = (y - rect.height) + "px";
}

// ── Actions ──────────────────────────────────────────────

function openInVSCode(path) {
  execCommand("code .", path);
}

function openAllInGroup(groupId) {
  const paths = collectPathsInGroup(groupId);
  for (const p of paths) {
    execCommand("code .", p);
  }
}

async function removeRepo(repo) {
  try {
    await deleteRepo(repo.id);
    await loadRepos();
  } catch (err) {
    console.error("Failed to remove repo:", err);
  }
}

async function removeGroup(group) {
  try {
    await deleteRepoGroup(group.id);
    await loadRepos();
  } catch (err) {
    console.error("Failed to remove group:", err);
  }
}

// ── Inline Editing ───────────────────────────────────────

function startGroupRename(group) {
  const el = $.reposTree.querySelector(`[data-group-id="${group.id}"] .repos-group-name`);
  if (!el) return;

  const input = document.createElement("input");
  input.type = "text";
  input.className = "repos-inline-input";
  input.value = group.name;

  el.replaceWith(input);
  input.focus();
  input.select();

  async function commit() {
    const newName = input.value.trim();
    if (newName && newName !== group.name) {
      try {
        await updateRepoGroup(group.id, { name: newName });
      } catch (err) {
        console.error("Rename failed:", err);
      }
    }
    await loadRepos();
  }

  input.addEventListener("blur", commit);
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") { e.preventDefault(); input.blur(); }
    if (e.key === "Escape") { input.value = group.name; input.blur(); }
  });
}

function startAddGroup() {
  // Insert inline input at tree top
  const existing = $.reposTree.querySelector(".repos-new-group-row");
  if (existing) { existing.querySelector("input").focus(); return; }

  const row = document.createElement("div");
  row.className = "repos-group-item repos-new-group-row";
  row.style.paddingLeft = "8px";

  row.innerHTML = `
    ${FOLDER_SVG}
    <input type="text" class="repos-inline-input" placeholder="Group name...">
  `;

  $.reposTree.prepend(row);
  const input = row.querySelector("input");
  input.focus();

  async function commit() {
    const name = input.value.trim();
    if (name) {
      try {
        await createRepoGroup(name, null);
      } catch (err) {
        console.error("Create group failed:", err);
      }
    }
    await loadRepos();
  }

  input.addEventListener("blur", commit);
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") { e.preventDefault(); input.blur(); }
    if (e.key === "Escape") { input.value = ""; input.blur(); }
  });
}

// ── Add Repo (reuse folder browser modal) ────────────────

function startAddRepo(targetGroupId = null) {
  // Reuse the add-project modal pattern with folder browser
  const modal = document.getElementById("add-project-modal");
  const breadcrumb = document.getElementById("folder-breadcrumb");
  const folderList = document.getElementById("folder-list");
  const nameInput = document.getElementById("add-project-name");
  const confirmBtn = document.getElementById("add-project-confirm");
  const closeBtn = document.getElementById("add-project-close");

  if (!modal) return;

  let currentDir = null;

  // Clone confirm button to strip existing project listeners
  const origBtn = confirmBtn;
  const clonedBtn = confirmBtn.cloneNode(true);
  clonedBtn.textContent = "Add Repo";
  origBtn.replaceWith(clonedBtn);

  modal.classList.remove("hidden");
  nameInput.value = "";

  async function browse(dir) {
    try {
      const data = await browseFolders(dir || undefined);
      currentDir = data.current;

      // Build breadcrumb
      const parts = currentDir.split("/").filter(Boolean);
      breadcrumb.innerHTML = "";
      let accum = "";
      const root = document.createElement("span");
      root.className = "breadcrumb-item";
      root.textContent = "/";
      root.addEventListener("click", () => browse("/"));
      breadcrumb.appendChild(root);
      for (const part of parts) {
        accum += "/" + part;
        const crumb = document.createElement("span");
        crumb.className = "breadcrumb-item";
        crumb.textContent = part;
        const target = accum;
        crumb.addEventListener("click", () => browse(target));
        breadcrumb.appendChild(crumb);
      }

      // Auto-fill name from last directory segment
      nameInput.value = parts[parts.length - 1] || "";

      // Render directory listing
      folderList.innerHTML = "";

      if (data.parent) {
        const upItem = document.createElement("div");
        upItem.className = "folder-item";
        upItem.textContent = "..";
        upItem.addEventListener("click", () => browse(data.parent));
        folderList.appendChild(upItem);
      }

      for (const d of data.dirs) {
        const item = document.createElement("div");
        item.className = "folder-item";
        item.textContent = d.name;
        item.addEventListener("click", () => browse(d.path));
        folderList.appendChild(item);
      }
    } catch (err) {
      folderList.innerHTML = `<div class="repos-empty">Error: ${escapeHtml(err.message)}</div>`;
    }
  }

  browse(null);

  function cleanup() {
    modal.classList.add("hidden");
    // Restore original button with its project listeners
    clonedBtn.replaceWith(origBtn);
    closeBtn.removeEventListener("click", onClose);
  }

  async function onConfirm() {
    const name = nameInput.value.trim();
    if (!name || !currentDir) return;
    try {
      await addRepo(name, currentDir, targetGroupId);
      cleanup();
      await loadRepos();
    } catch (err) {
      alert("Failed to add repo: " + err.message);
    }
  }

  function onClose() {
    cleanup();
  }

  clonedBtn.addEventListener("click", onConfirm);
  closeBtn.addEventListener("click", onClose);
}

// ── Add Repo Manually (no local folder needed) ───────────

function startAddRepoManual(targetGroupId = null) {
  // Remove any existing manual form
  const existing = $.reposTree.querySelector(".repos-manual-form");
  if (existing) { existing.querySelector("input").focus(); return; }

  const form = document.createElement("div");
  form.className = "repos-manual-form";
  form.innerHTML = `
    <input type="text" class="repos-inline-input" placeholder="Repo name *" data-field="name">
    <input type="text" class="repos-inline-input" placeholder="GitHub URL (optional)" data-field="url">
    <div class="repos-manual-actions">
      <button class="repos-manual-cancel">Cancel</button>
      <button class="repos-manual-save">Add</button>
    </div>
  `;

  $.reposTree.prepend(form);
  const nameInput = form.querySelector('[data-field="name"]');
  const urlInput = form.querySelector('[data-field="url"]');
  nameInput.focus();

  function removeForm() {
    form.remove();
  }

  async function save() {
    const name = nameInput.value.trim();
    if (!name) { nameInput.focus(); return; }
    const url = urlInput.value.trim() || null;
    try {
      await addRepo(name, null, targetGroupId, url);
      removeForm();
      await loadRepos();
    } catch (err) {
      alert("Failed to add repo: " + err.message);
    }
  }

  form.querySelector(".repos-manual-cancel").addEventListener("click", removeForm);
  form.querySelector(".repos-manual-save").addEventListener("click", save);

  // Enter on last field saves, Escape cancels
  form.addEventListener("keydown", (e) => {
    if (e.key === "Enter") { e.preventDefault(); save(); }
    if (e.key === "Escape") { removeForm(); }
  });
}

// ── Add Repo Menu (choose browse vs manual) ──────────────

function showAddRepoMenu(targetGroupId = null) {
  hideContextMenu();

  ctxMenu = document.createElement("div");
  ctxMenu.className = "repos-ctx-menu";

  const browseBtn = document.createElement("button");
  browseBtn.textContent = "Browse Folder";
  browseBtn.addEventListener("click", () => {
    hideContextMenu();
    startAddRepo(targetGroupId);
  });

  const manualBtn = document.createElement("button");
  manualBtn.textContent = "Add Manually";
  manualBtn.addEventListener("click", () => {
    hideContextMenu();
    startAddRepoManual(targetGroupId);
  });

  ctxMenu.appendChild(browseBtn);
  ctxMenu.appendChild(manualBtn);

  // Position near the + button
  const btn = $.reposAddRepoBtn;
  const rect = btn.getBoundingClientRect();
  positionMenu(ctxMenu, rect.left, rect.bottom + 4);
}

// ── Init ─────────────────────────────────────────────────

function initReposPanel() {
  // Toolbar buttons
  $.reposRefreshBtn.addEventListener("click", async () => {
    $.reposRefreshBtn.classList.add("spinning");
    try {
      await loadRepos();
    } finally {
      $.reposRefreshBtn.classList.remove("spinning");
    }
  });

  $.reposAddGroupBtn.addEventListener("click", () => startAddGroup());
  $.reposAddRepoBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    showAddRepoMenu();
  });

  // Search with debounce
  $.reposSearch.addEventListener("input", (e) => {
    clearTimeout(searchDebounce);
    const q = e.target.value.trim();
    searchDebounce = setTimeout(() => {
      searchQuery = q;
      renderTree();
    }, 200);
  });

  // Load on tab open
  on("rightPanel:opened", (tab) => {
    if (tab === "repos") loadRepos();
  });
  on("rightPanel:tabChanged", (tab) => {
    if (tab === "repos") loadRepos();
  });

  // Context menu dismiss
  document.addEventListener("click", (e) => {
    if (ctxMenu && !ctxMenu.contains(e.target)) hideContextMenu();
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") hideContextMenu();
  });
}

// Register slash command
registerCommand("repos", {
  category: "app",
  description: "Open repos panel",
  execute() {
    openRightPanel("repos");
  },
});

initReposPanel();
