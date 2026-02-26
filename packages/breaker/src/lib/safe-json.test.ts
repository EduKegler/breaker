import { describe, it, expect } from "vitest";
import { z } from "zod";
import { safeJsonParse } from "./safe-json.js";

describe("safeJsonParse", () => {
  // ---- Basic JSON parsing ----
  it("parses valid JSON", () => {
    const result = safeJsonParse<{ a: number }>(JSON.stringify({ a: 1 }));
    expect(result).toEqual({ a: 1 });
  });

  it("parses valid JSON array", () => {
    const result = safeJsonParse<number[]>(JSON.stringify([1, 2, 3]));
    expect(result).toEqual([1, 2, 3]);
  });

  it("throws on invalid JSON without repair", () => {
    expect(() => safeJsonParse("{ bad json")).toThrow();
  });

  // ---- Repair of malformed JSON ----
  it("repairs trailing commas", () => {
    const result = safeJsonParse<{ a: number; b: number }>(
      '{ "a": 1, "b": 2, }',
      { repair: true },
    );
    expect(result).toEqual({ a: 1, b: 2 });
  });

  it("repairs single-line comments", () => {
    const result = safeJsonParse<{ x: number }>(
      '{ "x": 42 // this is a comment\n}',
      { repair: true },
    );
    expect(result).toEqual({ x: 42 });
  });

  it("repairs unquoted keys", () => {
    const result = safeJsonParse<{ foo: string }>(
      '{ foo: "bar" }',
      { repair: true },
    );
    expect(result).toEqual({ foo: "bar" });
  });

  it("repairs single-quoted strings", () => {
    const result = safeJsonParse<{ key: string }>(
      "{ 'key': 'value' }",
      { repair: true },
    );
    expect(result).toEqual({ key: "value" });
  });

  // ---- Zod validation success ----
  it("validates with Zod schema on success", () => {
    const schema = z.object({ name: z.string(), age: z.number() });
    const result = safeJsonParse(
      JSON.stringify({ name: "test", age: 30 }),
      { schema },
    );
    expect(result).toEqual({ name: "test", age: 30 });
  });

  it("validates with Zod schema stripping extra fields", () => {
    const schema = z.object({ name: z.string() }).strict();
    expect(() =>
      safeJsonParse(JSON.stringify({ name: "test", extra: true }), { schema }),
    ).toThrow();
  });

  // ---- Zod validation failure ----
  it("throws ZodError when schema validation fails", () => {
    const schema = z.object({ name: z.string(), age: z.number() });
    expect(() =>
      safeJsonParse(JSON.stringify({ name: 123 }), { schema }),
    ).toThrow();
  });

  it("provides useful error info on schema failure", () => {
    const schema = z.object({ count: z.number().min(1) });
    try {
      safeJsonParse(JSON.stringify({ count: 0 }), { schema });
      expect.unreachable("should have thrown");
    } catch (err) {
      expect((err as Error).message).toBeTruthy();
    }
  });

  // ---- Combined repair + validation ----
  it("repairs and validates together", () => {
    const schema = z.object({
      paramOverrides: z.record(z.string(), z.number()),
    });
    // Malformed JSON with trailing comma + unquoted key
    const raw = '{ "paramOverrides": { dcSlow: 55, } }';
    const result = safeJsonParse(raw, { repair: true, schema });
    expect(result).toEqual({ paramOverrides: { dcSlow: 55 } });
  });

  it("repairs but fails validation when schema does not match", () => {
    const schema = z.object({
      paramOverrides: z.record(z.string(), z.number()),
    });
    // Valid after repair but wrong structure
    const raw = '{ "wrongField": 123, }';
    expect(() => safeJsonParse(raw, { repair: true, schema })).toThrow();
  });

  // ---- Edge cases ----
  it("handles empty object", () => {
    const result = safeJsonParse<Record<string, never>>("{}");
    expect(result).toEqual({});
  });

  it("repair flag false does not repair", () => {
    expect(() => safeJsonParse("{ bad: json }", { repair: false })).toThrow();
  });
});
