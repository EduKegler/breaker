---
name: deploy
description: Build, test, and deploy the monorepo. Use when the user says "deploy", "push to VPS", "publish", "manda pra VPS", "publica", "sobe pra producao", or wants to deploy.
argument-hint: "[--skip-tests] [--filter=package]"
disable-model-invocation: true
allowed-tools: "Bash, Read"
---

# Deploy B.R.E.A.K.E.R. Monorepo

Build, test, and deploy the monorepo packages.

## Steps

### 1. Build all packages

```bash
cd /Users/edu/Projects/trading && pnpm build
```

If build fails, show the errors and STOP. Do not deploy broken code.

### 2. Run tests (unless --skip-tests argument)

If `$ARGUMENTS` contains `--skip-tests`, skip this step.

```bash
cd /Users/edu/Projects/trading && pnpm test
```

If tests fail, show the failures and STOP.

### 3. Deploy the exchange daemon

The exchange daemon runs locally. Restart it:

```bash
cd /Users/edu/Projects/trading && pnpm --filter @breaker/exchange start
```

If `$ARGUMENTS` contains `--filter=`, only build/test/deploy the specified package.

### 4. Health check

Wait 5 seconds, then verify the daemon is running:

```bash
curl -sf http://localhost:3200/health
```

### 5. Report result

- If health check returns 200: confirm deploy succeeded, show mode and uptime
- If health check fails: check if process is running with `lsof -i :3200` and suggest debugging
