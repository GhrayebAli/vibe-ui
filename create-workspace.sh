#!/bin/bash
# Create a new vibe-coding workspace — one command to generate everything
#
# Usage:
#   bash create-workspace.sh \
#     --name "My Workspace" \
#     --dir ./my-workspace \
#     --github-org MyOrg \
#     --repo https://github.com/MyOrg/frontend:3000:frontend:npm \
#     --repo https://github.com/MyOrg/api:1337:backend:npm \
#     --env frontend:.env:"KEY=value\nKEY2=value2"
#
# Repo format: <git-url>:<port>:<type>:<packageManager>
#   - port: the port the service runs on
#   - type: "frontend" or "backend"
#   - packageManager: "npm" or "yarn" (default: npm)
#
# After running, follow the printed instructions to push and create the codespace.

set -e

# ── Parse arguments ──
WORKSPACE_NAME=""
WORKSPACE_DIR=""
GITHUB_ORG=""
REPOS=()
ENV_FILES=()
GIT_ORGS=()

while [[ $# -gt 0 ]]; do
  case $1 in
    --name) WORKSPACE_NAME="$2"; shift 2;;
    --dir) WORKSPACE_DIR="$2"; shift 2;;
    --github-org) GIT_ORGS+=("$2"); shift 2;;
    --repo) REPOS+=("$2"); shift 2;;
    --env) ENV_FILES+=("$2"); shift 2;;
    *) echo "Unknown option: $1"; exit 1;;
  esac
done

if [ -z "$WORKSPACE_NAME" ] || [ -z "$WORKSPACE_DIR" ] || [ ${#REPOS[@]} -eq 0 ]; then
  echo "Usage: bash create-workspace.sh --name \"My Workspace\" --dir ./my-workspace --repo <url>:<port>:<type>:<pm> [--repo ...] [--github-org Org] [--env repo:.env:\"content\"]"
  exit 1
fi

WORKSPACE_BASENAME=$(basename "$WORKSPACE_DIR")
echo "Creating workspace: $WORKSPACE_NAME"
echo "Directory: $WORKSPACE_DIR"

mkdir -p "$WORKSPACE_DIR/.devcontainer/extensions/workspace-layout"

# ── Build workspace.json ──
REPOS_JSON="["
FORWARD_PORTS="4000"
PORTS_JSON=""
FRONTEND_PORT=""

for repo_spec in "${REPOS[@]}"; do
  IFS=':' read -r url port type pm <<< "$(echo "$repo_spec" | sed 's|https://|https:|' | sed 's|http://|http:|' | sed 's|https:|https://|; s|http:|http://|' | awk -F: '{url=$1":"$2":"$3; port=$4; type=$5; pm=$6; print url"|"port"|"type"|"pm}')"
  # Re-parse properly
  url=$(echo "$repo_spec" | sed 's|\(https\?://[^:]*\).*|\1|')
  rest=$(echo "$repo_spec" | sed "s|${url}:*||")
  IFS=':' read -r port type pm <<< "$rest"

  repo_name=$(basename "$url" .git)
  port=${port:-0}
  type=${type:-backend}
  pm=${pm:-npm}

  if [ "$type" = "frontend" ] && [ -z "$FRONTEND_PORT" ]; then
    FRONTEND_PORT=$port
    dev_cmd=$([ "$pm" = "yarn" ] && echo "yarn start" || echo "npm run dev")
    health_path="/"
  else
    dev_cmd=$([ "$pm" = "yarn" ] && echo "yarn start" || echo "npm start")
    health_path="/health"
  fi

  # Auto-detect org from URL
  org=$(echo "$url" | sed 's|.*/\([^/]*\)/[^/]*$|\1|')
  if [[ ! " ${GIT_ORGS[*]} " =~ " ${org} " ]]; then
    GIT_ORGS+=("$org")
  fi

  REPOS_JSON="$REPOS_JSON
    {
      \"name\": \"$repo_name\",
      \"url\": \"$url\",
      \"type\": \"$type\",
      \"port\": $port,
      \"dev\": \"$dev_cmd\",
      \"packageManager\": \"$pm\",
      \"healthPath\": \"$health_path\"
    },"

  [ "$port" -gt 0 ] && FORWARD_PORTS="$FORWARD_PORTS, $port"

  if [ "$port" -gt 0 ]; then
    PORTS_JSON="$PORTS_JSON    \"$port\": { \"label\": \"$repo_name\", \"onAutoForward\": \"silent\", \"visibility\": \"public\" },
"
  fi
done

# Close repos array, remove trailing comma
REPOS_JSON=$(echo "$REPOS_JSON" | sed '$ s/,$//')
REPOS_JSON="$REPOS_JSON
  ]"

# Build gitOrgs JSON
GIT_ORGS_JSON=$(printf '%s\n' "${GIT_ORGS[@]}" | jq -R . | jq -s .)

FRONTEND_PORT=${FRONTEND_PORT:-3000}

# Add vibe-ui port
PORTS_JSON="    \"4000\": { \"label\": \"vibe-ui\", \"onAutoForward\": \"silent\", \"visibility\": \"public\" },
$PORTS_JSON"
PORTS_JSON=$(echo "$PORTS_JSON" | sed '$ s/,$//')

# ── Write workspace.json ──
cat > "$WORKSPACE_DIR/workspace.json" << WEOF
{
  "name": "$WORKSPACE_NAME",
  "repos": $REPOS_JSON,
  "gitOrgs": $GIT_ORGS_JSON,
  "previewPath": "/"
}
WEOF

# ── Write devcontainer.json ──
cat > "$WORKSPACE_DIR/.devcontainer/devcontainer.json" << DEOF
{
  "name": "$WORKSPACE_NAME",
  "image": "mcr.microsoft.com/devcontainers/javascript-node:20",

  "features": {
    "ghcr.io/devcontainers/features/github-cli:1": {},
    "ghcr.io/devcontainers/features/sshd:1": { "version": "latest" }
  },

  "forwardPorts": [$FORWARD_PORTS],
  "portsAttributes": {
$PORTS_JSON
  },

  "postCreateCommand": "which jq || sudo apt-get update && sudo apt-get install -y jq && bash .devcontainer/setup.sh",
  "postStartCommand": "nohup bash .devcontainer/start.sh > /tmp/services.log 2>&1 &",

  "customizations": {
    "vscode": {
      "extensions": [
        "dbaeumer.vscode-eslint",
        "esbenp.prettier-vscode",
        ".devcontainer/extensions/workspace-layout"
      ],
      "settings": {
        "workbench.startupEditor": "none",
        "workbench.activityBar.visible": false,
        "editor.minimap.enabled": false
      }
    }
  },

  "secrets": {
    "ANTHROPIC_API_KEY": {
      "description": "Anthropic API key for Claude Agent SDK"
    },
    "WASHMEN_GITHUB_TOKEN": {
      "description": "GitHub PAT with repo scope for cloning and pushing"
    }
  },

  "hostRequirements": {
    "cpus": 4,
    "memory": "16gb"
  },

  "containerEnv": {
    "WORKSPACE_DIR": "/workspaces/$WORKSPACE_BASENAME"
  }
}
DEOF

# ── Copy generic setup.sh and start.sh ──
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# Check if we're running from the vibe-ui repo (has the generic scripts)
if [ -f "$SCRIPT_DIR/../.devcontainer/setup.sh" ]; then
  # Running from within a workspace that has the scripts
  TEMPLATE_DIR="$SCRIPT_DIR/../.devcontainer"
elif [ -f "$(dirname "$SCRIPT_DIR")/.devcontainer/setup.sh" ]; then
  TEMPLATE_DIR="$(dirname "$SCRIPT_DIR")/.devcontainer"
fi

if [ -n "$TEMPLATE_DIR" ]; then
  cp "$TEMPLATE_DIR/setup.sh" "$WORKSPACE_DIR/.devcontainer/setup.sh"
  cp "$TEMPLATE_DIR/start.sh" "$WORKSPACE_DIR/.devcontainer/start.sh"
  echo "Copied generic setup.sh and start.sh"
else
  # Download from GitHub
  echo "Downloading generic scripts from GitHub..."
  curl -sL "https://raw.githubusercontent.com/GhrayebAli/washmen-ops-workspace/main/.devcontainer/setup.sh" > "$WORKSPACE_DIR/.devcontainer/setup.sh"
  curl -sL "https://raw.githubusercontent.com/GhrayebAli/washmen-ops-workspace/main/.devcontainer/start.sh" > "$WORKSPACE_DIR/.devcontainer/start.sh"
fi

chmod +x "$WORKSPACE_DIR/.devcontainer/setup.sh" "$WORKSPACE_DIR/.devcontainer/start.sh"

# ── VS Code extension ──
cat > "$WORKSPACE_DIR/.devcontainer/extensions/workspace-layout/package.json" << 'EEOF'
{
  "name": "workspace-layout",
  "displayName": "Workspace Layout",
  "version": "0.1.0",
  "engines": { "vscode": "^1.80.0" },
  "activationEvents": ["onStartupFinished"],
  "main": "./extension.js",
  "contributes": {}
}
EEOF

cat > "$WORKSPACE_DIR/.devcontainer/extensions/workspace-layout/extension.js" << EXEOF
const vscode = require('vscode');

function activate(context) {
  setTimeout(async () => {
    try {
      await vscode.commands.executeCommand(
        'simpleBrowser.api.open',
        vscode.Uri.parse('http://localhost:4000'),
        { viewColumn: vscode.ViewColumn.One, preserveFocus: true }
      );
      await vscode.commands.executeCommand(
        'simpleBrowser.api.open',
        vscode.Uri.parse('http://localhost:$FRONTEND_PORT'),
        { viewColumn: vscode.ViewColumn.Two, preserveFocus: true }
      );
      await vscode.commands.executeCommand('workbench.action.closeSidebar');
    } catch (err) {
      console.log('Workspace layout: waiting for services...', err.message);
      setTimeout(() => activate(context), 10000);
    }
  }, 8000);
}

function deactivate() {}
module.exports = { activate, deactivate };
EXEOF

# ── start-codespace.sh ──
# Detect GitHub org/user from first repo URL
FIRST_ORG=$(echo "${REPOS[0]}" | sed 's|https\?://github.com/\([^/]*\)/.*|\1|')

cat > "$WORKSPACE_DIR/start-codespace.sh" << CSEOF
#!/bin/bash
# Entry point — run this locally to start/resume the workspace

REPO="$FIRST_ORG/$WORKSPACE_BASENAME"
CODESPACE=\$(gh codespace list --json name,state,repository -q ".[] | select(.repository == \"\$REPO\" and .state == \"Available\") | .name" | head -1)

if [ -z "\$CODESPACE" ]; then
  echo "No running Codespace found for \$REPO. Starting..."
  CODESPACE=\$(gh codespace list --json name,repository -q ".[] | select(.repository == \"\$REPO\") | .name" | head -1)
  if [ -z "\$CODESPACE" ]; then
    echo "No Codespace found. Create one first: gh codespace create -R \$REPO -b main"
    exit 1
  fi
  gh codespace ssh -c "\$CODESPACE" -- "echo started"
fi

echo "Codespace: \$CODESPACE"

gh codespace ssh -c "\$CODESPACE" -- 'curl -s http://localhost:4000/api/health > /dev/null 2>&1 || bash /workspaces/$WORKSPACE_BASENAME/.devcontainer/start.sh'
echo "Services starting..."

echo "Waiting for services..."
for i in \$(seq 1 15); do
  PORTS=\$(gh codespace ports -c "\$CODESPACE" --json sourcePort -q '.[].sourcePort' 2>/dev/null)
  if echo "\$PORTS" | grep -q "4000"; then break; fi
  sleep 2
done

gh codespace ports visibility -c "\$CODESPACE" 4000:public 3000:public 2>/dev/null
echo "Ports set to public"

URL="https://\${CODESPACE}-4000.app.github.dev"
echo ""
echo "Opening: \$URL"
open "\$URL" 2>/dev/null || xdg-open "\$URL" 2>/dev/null || echo "Open manually: \$URL"
CSEOF

chmod +x "$WORKSPACE_DIR/start-codespace.sh"

# ── CLAUDE.md ──
REPO_LIST=""
for repo_spec in "${REPOS[@]}"; do
  url=$(echo "$repo_spec" | sed 's|\(https\?://[^:]*\).*|\1|')
  rest=$(echo "$repo_spec" | sed "s|${url}:*||")
  IFS=':' read -r port type pm <<< "$rest"
  repo_name=$(basename "$url" .git)
  REPO_LIST="$REPO_LIST- **$repo_name** (port $port): $type\n"
done

cat > "$WORKSPACE_DIR/CLAUDE.md" << CLEOF
# $WORKSPACE_NAME — AI Agent Context

## Overview
You are an AI coding agent operating inside a Codespace with the following repos:
$(echo -e "$REPO_LIST")

## What You Can Do
- Add new pages, components, and views
- Fix bugs and improve UI/UX
- Add new API endpoints and routes
- Make additive modifications to existing code

## What You Cannot Do
- Modify auth, middleware, or policies
- Touch deployment or infrastructure configuration
- Hardcode credentials or environment-specific values
- Push directly to master/main

## Git Rules
- All work on mvp/<feature-name> branches
- Commit with descriptive messages
- Never push to master/main
CLEOF

# ── .gitignore ──
{
  for repo_spec in "${REPOS[@]}"; do
    url=$(echo "$repo_spec" | sed 's|\(https\?://[^:]*\).*|\1|')
    echo "$(basename "$url" .git)/"
  done
  echo "vibe-ui/"
  echo "node_modules/"
  echo ".env"
  echo "*.log"
  echo ".active-branch"
  echo ".setup-done"
  echo ".DS_Store"
} > "$WORKSPACE_DIR/.gitignore"

# ── Initialize git ──
cd "$WORKSPACE_DIR"
git init
git add -A
git commit -m "Initial workspace: $WORKSPACE_NAME"

echo ""
echo "=========================================="
echo " Workspace created: $WORKSPACE_DIR"
echo "=========================================="
echo ""
echo "Next steps:"
echo ""
echo "  1. Create the GitHub repo and push:"
echo "     cd $WORKSPACE_DIR"
echo "     gh repo create $FIRST_ORG/$WORKSPACE_BASENAME --public --source=. --push"
echo ""
echo "  2. Grant codespace secrets access:"
echo "     REPO_ID=\$(gh api repos/$FIRST_ORG/$WORKSPACE_BASENAME --jq '.id')"
echo "     gh api -X PUT /user/codespaces/secrets/ANTHROPIC_API_KEY/repositories/\$REPO_ID"
echo "     gh api -X PUT /user/codespaces/secrets/WASHMEN_GITHUB_TOKEN/repositories/\$REPO_ID"
echo ""
echo "  3. Create and start the codespace:"
echo "     gh codespace create -R $FIRST_ORG/$WORKSPACE_BASENAME -b main --machine standardLinux32gb"
echo "     bash start-codespace.sh"
echo ""
