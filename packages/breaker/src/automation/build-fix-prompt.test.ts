import { describe, it, expect, vi, beforeEach } from "vitest";
import fs from "node:fs";
import { generateFixPrompt } from "./build-fix-prompt.js";
import type { ErrorData } from "./build-fix-prompt.js";

const REPO_ROOT = "/tmp/test-repo";

describe("generateFixPrompt", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.spyOn(fs, "existsSync").mockReturnValue(true);
  });

  it("generates prompt with a single error", () => {
    const errorData: ErrorData = {
      strategyFile: "assets/BTC/breakout/squeeze.pine",
      errors: [{ message: "Undeclared identifier 'x'" }],
    };

    const result = generateFixPrompt(errorData, REPO_ROOT);

    expect(result).toContain("Error 1");
    expect(result).toContain("Undeclared identifier 'x'");
  });

  it("generates prompt with multiple errors", () => {
    const errorData: ErrorData = {
      strategyFile: "assets/BTC/breakout/squeeze.pine",
      errors: [
        { message: "Error one" },
        { message: "Error two" },
        { message: "Error three" },
      ],
    };

    const result = generateFixPrompt(errorData, REPO_ROOT);

    expect(result).toContain("Error 1");
    expect(result).toContain("Error 2");
    expect(result).toContain("Error 3");
    expect(result).toContain("3 compilation error(s)");
  });

  it("includes line and column when available", () => {
    const errorData: ErrorData = {
      strategyFile: "assets/BTC/breakout/squeeze.pine",
      errors: [{ message: "Syntax error", line: 42, column: 5 }],
    };

    const result = generateFixPrompt(errorData, REPO_ROOT);

    expect(result).toContain("Line: 42, Column: 5");
  });

  it("includes snippet when available", () => {
    const errorData: ErrorData = {
      strategyFile: "assets/BTC/breakout/squeeze.pine",
      errors: [
        {
          message: "Unexpected token",
          snippet: "x = input.int(14",
        },
      ],
    };

    const result = generateFixPrompt(errorData, REPO_ROOT);

    expect(result).toContain("```pine");
    expect(result).toContain("x = input.int(14");
  });

  it("handles empty errors array", () => {
    const errorData: ErrorData = {
      strategyFile: "assets/BTC/breakout/squeeze.pine",
      errors: [],
    };

    const result = generateFixPrompt(errorData, REPO_ROOT);

    expect(result).toContain("No error details available");
  });

  it("handles null errors (falls back to empty array)", () => {
    const errorData: ErrorData = {
      strategyFile: "assets/BTC/breakout/squeeze.pine",
      errors: null,
    };

    const result = generateFixPrompt(errorData, REPO_ROOT);

    expect(result).toContain("No error details available");
  });

  it("throws on path traversal", () => {
    const errorData: ErrorData = {
      strategyFile: "sub/../../../../etc/passwd",
      errors: [],
    };

    expect(() => generateFixPrompt(errorData, REPO_ROOT)).toThrow(
      "Path traversal blocked",
    );
  });

  it("throws when strategyFile is empty", () => {
    const errorData: ErrorData = {
      strategyFile: "",
      errors: [],
    };

    expect(() => generateFixPrompt(errorData, REPO_ROOT)).toThrow(
      "errorData missing valid 'strategyFile' field",
    );
  });

  it("shows timestamp when available", () => {
    const errorData: ErrorData = {
      strategyFile: "assets/BTC/breakout/squeeze.pine",
      timestamp: "2026-02-22T10:30:00Z",
      errors: [{ message: "Some error" }],
    };

    const result = generateFixPrompt(errorData, REPO_ROOT);

    expect(result).toContain("2026-02-22T10:30:00Z");
  });

  it("includes line without column", () => {
    const errorData: ErrorData = {
      strategyFile: "assets/BTC/breakout/squeeze.pine",
      errors: [{ message: "Syntax error", line: 42 }],
    };

    const result = generateFixPrompt(errorData, REPO_ROOT);

    expect(result).toContain("Line: 42");
    expect(result).not.toContain("Column:");
  });

  it("throws when Pine file does not exist", () => {
    vi.spyOn(fs, "existsSync").mockReturnValue(false);

    const errorData: ErrorData = {
      strategyFile: "assets/BTC/breakout/squeeze.pine",
      errors: [],
    };

    expect(() => generateFixPrompt(errorData, REPO_ROOT)).toThrow(
      "Pine file not found",
    );
  });

  it("shows 'unknown' when timestamp is undefined", () => {
    const errorData: ErrorData = {
      strategyFile: "assets/BTC/breakout/squeeze.pine",
      errors: [{ message: "Some error" }],
    };

    const result = generateFixPrompt(errorData, REPO_ROOT);

    expect(result).toContain("unknown");
  });
});
