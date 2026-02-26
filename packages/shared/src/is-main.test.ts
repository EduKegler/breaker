import { describe, it, expect, vi, afterEach } from "vitest";
import { isMainModule } from "./is-main.js";

describe("isMainModule", () => {
  const originalArgv = process.argv;

  afterEach(() => {
    process.argv = originalArgv;
  });

  it("returns true when import.meta.url matches file:// + argv[1]", () => {
    process.argv = ["node", "/app/dist/server.js"];
    expect(isMainModule("file:///app/dist/server.js")).toBe(true);
  });

  it("returns false when import.meta.url does not match argv[1]", () => {
    process.argv = ["node", "/app/dist/server.js"];
    expect(isMainModule("file:///app/dist/other.js")).toBe(false);
  });

  it("returns false when argv[1] is undefined", () => {
    process.argv = ["node"];
    expect(isMainModule("file:///app/dist/server.js")).toBe(false);
  });
});
