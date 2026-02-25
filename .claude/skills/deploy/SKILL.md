---
name: deploy
description: Deploy the application to VPS. Use when the user says "deploy", "push to VPS", "publish", "deploy to production", "manda pra VPS", "publica", "sobe pra producao", or wants to deploy to tv.kegler.dev.
argument-hint: "[--skip-tests]"
disable-model-invocation: true
allowed-tools: "Bash, Read"
---

# Deploy to VPS

Deploy the B.R.E.A.K.E.R. server to tv.kegler.dev via deploy.sh.

## Steps

### 1. Build TypeScript

```bash
cd /Users/edu/Projects/pine && pnpm run build
```

If build fails, show the errors and STOP. Do not deploy broken code.

### 2. Run tests (unless --skip-tests argument)

If `$ARGUMENTS` contains `--skip-tests`, skip this step.

```bash
cd /Users/edu/Projects/pine && pnpm test
```

If tests fail, show the failures and STOP. Do not deploy with failing tests.

### 3. Deploy to VPS

```bash
cd /Users/edu/Projects/pine && ./deploy.sh
```

### 4. Health check

Wait 10 seconds, then verify:

```bash
curl -sf https://tv.kegler.dev/health
```

### 5. Report result

- If health check returns 200: confirm deploy succeeded
- If health check fails: show docker logs from VPS and suggest debugging
