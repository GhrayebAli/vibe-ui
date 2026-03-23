# Environment Variables & Secrets — Specification

## Problem
Projects have many env vars and secrets. Current approach hardcodes them in `setup.sh`, which doesn't scale and leaks non-secret config into scripts.

## Approach
- **Config** (non-secret: URLs, flags, regions) → committed as `.env.example` in each repo
- **Secrets** (API keys, tokens, passwords) → pulled from AWS Secrets Manager at codespace startup
- **workspace.json** declares which AWS secrets each repo needs
- **setup.sh** copies `.env.example` → `.env`, then injects AWS secrets

## workspace.json Schema

```json
{
  "name": "Washmen Ops Workspace",
  "repos": [
    {
      "name": "ops-frontend",
      "port": 3000,
      "envFile": ".env",
      "awsSecrets": {
        "dev/ops-frontend": ["REACT_APP_SENTRY_KEY", "REACT_APP_COGNITO_CLIENT_ID"]
      }
    },
    {
      "name": "api-gateway",
      "port": 1337,
      "envFile": ".env",
      "awsSecrets": {
        "dev/api-gateway": ["DB_HOST", "DB_PASSWORD", "JWT_SECRET"]
      }
    }
  ],
  "aws": {
    "region": "eu-west-1",
    "secretPrefix": "dev/"
  }
}
```

## Setup Flow
1. `setup.sh` authenticates with AWS (via Codespace secrets `AWS_ACCESS_KEY_ID` + `AWS_SECRET_ACCESS_KEY`)
2. Copies `.env.example` → `.env` for each repo
3. Reads `workspace.json`, pulls each declared AWS secret via `aws secretsmanager get-secret-value`
4. Injects secret values into the corresponding `.env` files
5. vibe-ui validates on startup — surfaces missing vars in the UI

## Codespace Secrets Required (only 3, regardless of project size)
- `AWS_ACCESS_KEY_ID`
- `AWS_SECRET_ACCESS_KEY`
- `ANTHROPIC_API_KEY` (for vibe-ui)

## Notes
- AWS Secrets Manager is a public API — no VPN needed
- VPN is only needed for private VPC resources (databases, internal services)
- Each repo maintains its own `.env.example` with all non-secret config filled in
- Adding a new project = add `.env.example` to the repo + declare `awsSecrets` in `workspace.json`
