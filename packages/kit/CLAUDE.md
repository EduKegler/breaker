# CLAUDE Instructions — kit

## Project overview
Shared utilities consumed by all other packages in the monorepo.

## Exports
- `isMainModule(url)` — guards executable modules from running when imported in tests
- `parseEnv(schema)` — Zod-validated `process.env` loader (`<T extends z.ZodTypeAny>`)
- `formatZodErrors(error)` — human-readable Zod error formatting

## Known pitfalls
- `parseEnv` reads `process.env` at call time — tests may need env vars set before importing modules that call it
- `isMainModule` checks both `file://` and `file:///` prefixes for cross-platform compat
- `zod` is a direct dependency (not peer) — each consumer also declares its own zod dep
