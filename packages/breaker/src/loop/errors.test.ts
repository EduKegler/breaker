import { describe, it, expect } from "vitest";
import { classifyError, backoffDelay } from "./errors.js";

describe("classifyError", () => {
  it("detects compile errors", () => {
    expect(classifyError("Script tem 3 erro(s) de compilacao")).toBe("compile_error");
    expect(classifyError("compilation error on line 42")).toBe("compile_error");
    expect(classifyError("syntax error")).toBe("compile_error");
  });

  it("detects timeouts", () => {
    expect(classifyError("Timeout 60000ms exceeded")).toBe("timeout");
    expect(classifyError("waitFor selector timed out")).toBe("timeout");
  });

  it("detects network errors", () => {
    expect(classifyError("net::ERR_CONNECTION_REFUSED")).toBe("network");
    expect(classifyError("ECONNREFUSED 127.0.0.1:3000")).toBe("network");
    expect(classifyError("fetch failed")).toBe("network");
  });

  it("detects stale xlsx", () => {
    expect(classifyError("stale xlsx detected")).toBe("stale_xlsx");
    expect(classifyError("token nao confirmado")).toBe("stale_xlsx");
    expect(classifyError("token not confirmed")).toBe("stale_xlsx");
  });

  it("detects transient UI errors", () => {
    expect(classifyError("Target closed")).toBe("transient_ui");
    expect(classifyError("browser has been disconnected")).toBe("transient_ui");
    expect(classifyError("Protocol error: Connection closed")).toBe("transient_ui");
  });

  it("returns unknown for unrecognized errors", () => {
    expect(classifyError("some random error")).toBe("unknown");
    expect(classifyError("")).toBe("unknown");
  });
});

describe("backoffDelay", () => {
  it("returns base delay for attempt 1", () => {
    expect(backoffDelay(1, 5000)).toBe(5000);
  });

  it("doubles delay for each attempt", () => {
    expect(backoffDelay(2, 5000)).toBe(10000);
    expect(backoffDelay(3, 5000)).toBe(20000);
  });

  it("caps at maxMs", () => {
    expect(backoffDelay(10, 5000, 60000)).toBe(60000);
  });

  it("uses defaults", () => {
    expect(backoffDelay(1)).toBe(5000);
  });
});
