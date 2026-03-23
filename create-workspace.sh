#!/bin/bash
# Create a new workspace directory with devcontainer config
#
# Usage:
#   bash create-workspace.sh <workspace-name> <workspace-dir> <repo1-url[:port]> <repo2-url[:port]> ...
#
# Example:
#   bash create-workspace.sh mock-workspace /tmp/mock-workspace \
#     https://github.com/GhrayebAli/mock-ops-frontend:3000:frontend \
#     https://github.com/GhrayebAli/mock-api-gateway:1337:backend \
#     https://github.com/GhrayebAli/mock-core-service:2339:backend
#
# Repo format: <git-url>:<port>:<type>
#   - port: the port the service runs on
#   - type: "frontend" or "backend" (default: backend)

set -e

if [ $# -lt 3 ]; then
  echo "Usage: $0 <workspace-name> <workspace-dir> <repo-url:port:type> [repo-url:port:type ...]"
  echo ""
  echo "Example:"
  echo "  $0 my-workspace ./my-workspace https://github.com/org/frontend:3000:frontend https://github.com/org/api:1337:backend"
  exit 1
fi

WORKSPACE_NAME="$1"
WORKSPACE_DIR="$2"
shift 2

# Parse repos
REPOS=()
FORWARD_PORTS="4000"
PORTS_JSON=""
CLONE_CMDS=""
INSTALL_CMDS=""
START_CMDS=""
WORKSPACE_JSON_REPOS=""

for repo_spec in "$@"; do
  IFS=':' read -r scheme host path port type <<< "$(echo "$repo_spec" | sed 's|https://|https:|; s|http://|http:|')"
  git_url="${scheme}://${host}/${path}"
  repo_name=$(basename "$path" .git)
  port=${port:-0}
  type=${type:-backend}

  REPOS+=("$repo_name")

  if [ "$port" -gt 0 ]; then
    FORWARD_PORTS="$FORWARD_PORTS, $port"
  fi

  # Detect dev command and health path based on type
  if [ "$type" = "frontend" ]; then
    dev_cmd="npm run dev"
    health_path="/"
  else
    dev_cmd="npm start"
    health_path="/health"
  fi

  # Port attributes JSON
  if [ "$port" -gt 0 ]; then
    PORTS_JSON="$PORTS_JSON    \"$port\": { \"label\": \"$repo_name\", \"onAutoForward\": \"silent\", \"visibility\": \"public\" },
"
  fi

  # Clone command
  CLONE_CMDS="$CLONE_CMDS[ -d \"$repo_name/.git\" ] || (rm -rf $repo_name && git clone $git_url --depth 1 && echo \"Cloned $repo_name\")
"

  # Install command
  INSTALL_CMDS="${INSTALL_CMDS}echo \"Installing $repo_name dependencies...\"
cd \"\$WORKSPACE_DIR/$repo_name\" && npm install

"

  # Start command
  if [ "$port" -gt 0 ]; then
    START_CMDS="${START_CMDS}(cd \"\$WORKSPACE_DIR/$repo_name\" && $dev_cmd >> /tmp/$repo_name.log 2>&1) &
"
  fi

  # workspace.json repo entry
  WORKSPACE_JSON_REPOS="$WORKSPACE_JSON_REPOS    { \"name\": \"$repo_name\", \"type\": \"$type\", \"port\": $port, \"dev\": \"$dev_cmd\", \"healthPath\": \"$health_path\" },
"
done

# Add vibe-ui port
PORTS_JSON="    \"4000\": { \"label\": \"vibe-ui\", \"onAutoForward\": \"silent\", \"visibility\": \"public\" },
$PORTS_JSON"

echo "Creating workspace: $WORKSPACE_NAME at $WORKSPACE_DIR"
echo "Repos: ${REPOS[*]}"

mkdir -p "$WORKSPACE_DIR/.devcontainer/extensions/workspace-layout"

# ── workspace.json ──
# Trim trailing comma from repos
WORKSPACE_JSON_REPOS=$(echo "$WORKSPACE_JSON_REPOS" | sed '$ s/,$//')

cat > "$WORKSPACE_DIR/workspace.json" << WEOF
{
  "name": "$WORKSPACE_NAME",
  "repos": [
$WORKSPACE_JSON_REPOS
  ],
  "previewPath": "/"
}
WEOF

# ── devcontainer.json ──
# Trim trailing comma from ports
PORTS_JSON=$(echo "$PORTS_JSON" | sed '$ s/,$//')

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

  "postCreateCommand": "bash .devcontainer/setup.sh",
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
    }
  },

  "hostRequirements": {
    "cpus": 4,
    "memory": "16gb"
  },

  "containerEnv": {
    "WORKSPACE_DIR": "/workspaces/$(basename "$WORKSPACE_DIR")"
  }
}
DEOF

# ── setup.sh ──
cat > "$WORKSPACE_DIR/.devcontainer/setup.sh" << 'SEOF'
#!/bin/bash
set -e

WORKSPACE_DIR="${WORKSPACE_DIR:-/workspaces/WORKSPACE_NAME_PLACEHOLDER}"
cd "$WORKSPACE_DIR"

echo "=== Workspace Setup ==="

# Clone repos
echo "Cloning repos..."
CLONE_PLACEHOLDER

# Clone vibe-ui
[ -f "vibe-ui/server-washmen.js" ] || (rm -rf vibe-ui && git clone https://github.com/GhrayebAli/vibe-ui.git vibe-ui)

# Install dependencies
INSTALL_PLACEHOLDER

# vibe-ui
echo "Installing vibe-ui dependencies..."
cd "$WORKSPACE_DIR/vibe-ui" && npm install

# Write vibe-ui .env
if [ -n "$ANTHROPIC_API_KEY" ]; then
  echo "ANTHROPIC_API_KEY=$ANTHROPIC_API_KEY" > "$WORKSPACE_DIR/vibe-ui/.env"
  echo "API key written to vibe-ui/.env"
fi

echo "=== Setup complete ==="
SEOF

# Fill in placeholders
WORKSPACE_BASENAME=$(basename "$WORKSPACE_DIR")
sed -i'' -e "s|WORKSPACE_NAME_PLACEHOLDER|$WORKSPACE_BASENAME|g" "$WORKSPACE_DIR/.devcontainer/setup.sh"

# Replace clone placeholder
CLONE_ESCAPED=$(echo "$CLONE_CMDS" | sed 's/[&/\]/\\&/g; s/$/\\/' | sed '$ s/\\$//')
# Use python for reliable multiline replacement
python3 -c "
import sys
with open('$WORKSPACE_DIR/.devcontainer/setup.sh', 'r') as f:
    content = f.read()
content = content.replace('CLONE_PLACEHOLDER', '''$CLONE_CMDS''')
content = content.replace('INSTALL_PLACEHOLDER', '''$INSTALL_CMDS''')
with open('$WORKSPACE_DIR/.devcontainer/setup.sh', 'w') as f:
    f.write(content)
"

# ── start.sh ──
ALL_PORTS="$FORWARD_PORTS"

cat > "$WORKSPACE_DIR/.devcontainer/start.sh" << STEOF
#!/bin/bash
WORKSPACE_DIR="\${WORKSPACE_DIR:-/workspaces/$WORKSPACE_BASENAME}"

echo "=== Starting services ==="

# Clear old logs
for f in /tmp/*.log; do > "\$f" 2>/dev/null; done

# Kill any leftover processes on our ports
for port in $FORWARD_PORTS; do
  kill \$(lsof -ti:\$port) 2>/dev/null
done
sleep 1

# Start services
$START_CMDS
# Start vibe-ui
(cd "\$WORKSPACE_DIR/vibe-ui" && ANTHROPIC_API_KEY=\$(cat .env 2>/dev/null | grep ANTHROPIC | cut -d= -f2) node server-washmen.js >> /tmp/vibe.log 2>&1) &

echo "=== All services starting in background ==="
STEOF

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

# Find frontend port for preview
FRONTEND_PORT=""
for repo_spec in "$@"; do
  IFS=':' read -r scheme host path port type <<< "$(echo "$repo_spec" | sed 's|https://|https:|; s|http://|http:|')"
  if [ "$type" = "frontend" ] && [ "$port" -gt 0 ]; then
    FRONTEND_PORT=$port
    break
  fi
done
FRONTEND_PORT=${FRONTEND_PORT:-3000}

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
cat > "$WORKSPACE_DIR/start-codespace.sh" << CSEOF
#!/bin/bash
CODESPACE=\$(gh codespace list --json name,state -q '.[] | select(.state == "Available") | .name' | head -1)

if [ -z "\$CODESPACE" ]; then
  echo "No running Codespace found. Starting..."
  CODESPACE=\$(gh codespace list --json name -q '.[0].name')
  gh codespace ssh -c "\$CODESPACE" -- "echo started"
fi

echo "Codespace: \$CODESPACE"
gh codespace ports visibility -c "\$CODESPACE" $(echo $FORWARD_PORTS | tr ', ' '\n' | grep -v '^$' | sed 's/$/:public/' | tr '\n' ' ')
echo "Ports set to public"

gh codespace ssh -c "\$CODESPACE" -- 'curl -s http://localhost:4000/api/health > /dev/null 2>&1 || bash /workspaces/$WORKSPACE_BASENAME/.devcontainer/start.sh'
echo "Services running"

echo ""
echo "vibe-ui: https://\${CODESPACE}-4000.app.github.dev"
$(for r in "${REPOS[@]}"; do echo "echo \"$r: https://\${CODESPACE}-\$(grep -o '[0-9]*' <<< '')\""; done)
echo "VS Code: https://\${CODESPACE}.github.dev"
CSEOF

# ── .gitignore ──
{
  for r in "${REPOS[@]}"; do echo "$r/"; done
  echo "vibe-ui/"
  echo "node_modules/"
  echo ".env"
  echo "*.log"
} > "$WORKSPACE_DIR/.gitignore"

# ── Initialize git ──
cd "$WORKSPACE_DIR"
git init
git add -A
git commit -m "Initial workspace setup: $(IFS=', '; echo "${REPOS[*]}")"

echo ""
echo "=== Workspace created at $WORKSPACE_DIR ==="
echo ""
echo "Next steps:"
echo "  1. cd $WORKSPACE_DIR"
echo "  2. gh repo create <org>/$WORKSPACE_BASENAME --public --source=. --push"
echo "  3. gh codespace create -R <org>/$WORKSPACE_BASENAME -b main --machine standardLinux32gb"
