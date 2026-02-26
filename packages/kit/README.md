# @breaker/kit

> **K** in the B.R.E.A.K.E.R. acrostic

Shared utilities used across all monorepo packages. Small by design — only functions that are genuinely cross-cutting.

## Exports

### `isMainModule(importMetaUrl)`

ES module guard. Checks whether the module is being executed directly (not imported). Required pattern on every entrypoint in the monorepo.

```typescript
import { isMainModule } from "@breaker/kit";

if (isMainModule(import.meta.url)) {
  // only runs when executed directly: node dist/my-script.js
  main();
}
```

### `parseEnv(schema)`

Type-safe environment variable parser using Zod. Preserves output types with defaults.

```typescript
import { z } from "zod";
import { parseEnv } from "@breaker/kit";

const env = parseEnv(
  z.object({
    PORT: z.coerce.number().default(3100),
    API_KEY: z.string(),
  })
);
// env.PORT is number, env.API_KEY is string — fully typed
```

### `formatZodErrors(error)`

Formats Zod validation errors into a readable string array.

```typescript
import { formatZodErrors } from "@breaker/kit";

const result = schema.safeParse(data);
if (!result.success) {
  const messages = formatZodErrors(result.error);
  // ["port: Expected number, received string", "apiKey: Required"]
}
```

## Structure

```
src/
├── index.ts          — Public re-exports
├── is-main.ts        — isMainModule
├── parse-env.ts      — parseEnv
└── zod-helpers.ts    — formatZodErrors
```

## Commands

```bash
pnpm build      # Compile TypeScript
pnpm test       # Run tests
pnpm typecheck  # Type-check without emitting
```
