import { describe, it, expect, vi, beforeEach } from "vitest";
import { checkPineSyntax } from "./pine-syntax.js";

const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

beforeEach(() => {
  mockFetch.mockReset();
});

describe("checkPineSyntax", () => {
  it("returns success for valid code", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({ success: true }),
    });

    const result = await checkPineSyntax('//@version=6\nindicator("test")');

    expect(result).toEqual({ success: true });
    expect(mockFetch).toHaveBeenCalledOnce();

    const [url, opts] = mockFetch.mock.calls[0];
    expect(url).toContain("pine-facade.tradingview.com");
    expect(opts.method).toBe("POST");
    expect(opts.body).toBeInstanceOf(FormData);
  });

  it("returns errors for invalid code", async () => {
    const errorResponse = {
      success: false,
      error: "Syntax error",
      errors: [{ line: 1, message: "unexpected token" }],
    };
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve(errorResponse),
    });

    const result = await checkPineSyntax("invalid code");

    expect(result.success).toBe(false);
    expect(result.errors).toHaveLength(1);
  });

  it("throws on HTTP error", async () => {
    mockFetch.mockResolvedValueOnce({ ok: false, status: 500 });

    await expect(checkPineSyntax("code")).rejects.toThrow("HTTP 500");
  });
});
