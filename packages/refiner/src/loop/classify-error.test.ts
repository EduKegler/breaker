import { describe, it, expect } from "vitest";
import { classifyError } from "./classify-error.js";

describe("classifyError", () => {
  it("detects compile errors", () => {
    expect(classifyError("compilation error on line 42")).toBe("compile_error");
    expect(classifyError("syntax error")).toBe("compile_error");
    expect(classifyError("typecheck failed")).toBe("compile_error");
    expect(classifyError("tsc exited with code 1")).toBe("compile_error");
  });

  it("detects timeouts", () => {
    expect(classifyError("Timeout 60000ms exceeded")).toBe("timeout");
    expect(classifyError("timed out waiting")).toBe("timeout");
    expect(classifyError("ETIMEDOUT")).toBe("timeout");
  });

  it("detects network errors", () => {
    expect(classifyError("net::ERR_CONNECTION_REFUSED")).toBe("network");
    expect(classifyError("ECONNREFUSED 127.0.0.1:3000")).toBe("network");
    expect(classifyError("fetch failed")).toBe("network");
  });

  it("detects transient errors", () => {
    expect(classifyError("ENOENT: no such file")).toBe("transient");
    expect(classifyError("spawn ENOENT")).toBe("transient");
  });

  it("returns unknown for unrecognized errors", () => {
    expect(classifyError("some random error")).toBe("unknown");
    expect(classifyError("")).toBe("unknown");
  });
});
