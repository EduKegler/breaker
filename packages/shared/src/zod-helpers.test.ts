import { describe, it, expect } from "vitest";
import { z } from "zod";
import { formatZodErrors } from "./zod-helpers.js";

describe("formatZodErrors", () => {
  it("formats a single field error", () => {
    const schema = z.object({ name: z.string() });
    const result = schema.safeParse({ name: 42 });

    expect(result.success).toBe(false);
    if (!result.success) {
      const errors = formatZodErrors(result.error);
      expect(errors).toHaveLength(1);
      expect(errors[0]).toBe("name: Expected string, received number");
    }
  });

  it("formats multiple field errors", () => {
    const schema = z.object({ name: z.string(), age: z.number() });
    const result = schema.safeParse({ name: 42, age: "old" });

    expect(result.success).toBe(false);
    if (!result.success) {
      const errors = formatZodErrors(result.error);
      expect(errors).toHaveLength(2);
      expect(errors[0]).toContain("name:");
      expect(errors[1]).toContain("age:");
    }
  });

  it("formats nested path errors", () => {
    const schema = z.object({ user: z.object({ email: z.string().email() }) });
    const result = schema.safeParse({ user: { email: "not-an-email" } });

    expect(result.success).toBe(false);
    if (!result.success) {
      const errors = formatZodErrors(result.error);
      expect(errors).toHaveLength(1);
      expect(errors[0]).toMatch(/^user\.email:/);
    }
  });
});
