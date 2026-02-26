import { describe, it, expect, vi, afterEach } from "vitest";
import { z } from "zod";
import { parseEnv } from "./parse-env.js";

describe("parseEnv", () => {
  const originalEnv = { ...process.env };

  afterEach(() => {
    process.env = originalEnv;
  });

  it("parses env vars matching the schema", () => {
    process.env.TEST_PORT = "8080";
    const schema = z.object({ TEST_PORT: z.coerce.number() });
    const env = parseEnv(schema);
    expect(env.TEST_PORT).toBe(8080);
  });

  it("applies defaults from the schema", () => {
    delete process.env.TEST_MISSING;
    const schema = z.object({ TEST_MISSING: z.string().default("fallback") });
    const env = parseEnv(schema);
    expect(env.TEST_MISSING).toBe("fallback");
  });

  it("throws on invalid env", () => {
    delete process.env.TEST_REQUIRED;
    const schema = z.object({ TEST_REQUIRED: z.string() });
    expect(() => parseEnv(schema)).toThrow();
  });
});
