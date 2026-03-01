# CLAUDE Instructions — kit

## Project overview
Shared utilities consumed by all other packages in the monorepo.

## Exports
- `isMainModule(url)` — guards executable modules from running when imported in tests
- `parseEnv(schema)` — Zod-validated `process.env` loader (`<T extends z.ZodTypeAny>`)
- `formatZodErrors(error)` — human-readable Zod error formatting
- `finiteOr(value, fallback)` — returns fallback if value is NaN/Infinity
- `finiteOrThrow(value, label)` — throws if value is NaN/Infinity
- `assertPositive(value, label)` — throws if value is not a positive finite number
- `isSanePrice(value)` — safety-net range check for prices (0 < v < 10M)
- `isSaneSize(value)` — safety-net range check for sizes (0 ≤ v < 1M)
- `isSaneEquity(value)` — safety-net range check for equity (-1M < v < 100M)
- `truncateSize(size, szDecimals)` — floor-truncate to exchange-allowed decimals
- `truncatePrice(price)` — truncate to 5 significant figures (SDK requirement)
- `backoffDelay(attempt, baseMs?, maxMs?)` — exponential backoff delay calculator

## Known pitfalls
- `parseEnv` reads `process.env` at call time — tests may need env vars set before importing modules that call it
- `isMainModule` checks both `file://` and `file:///` prefixes for cross-platform compat
- `zod` is a direct dependency (not peer) — each consumer also declares its own zod dep
