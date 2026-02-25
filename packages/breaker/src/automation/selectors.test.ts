import { describe, it, expect, vi } from "vitest";
import {
  SELECTORS,
  LOCALE_VARIANTS,
  locateWithVariants,
  waitForToastVariants,
  getPresetVariants,
  CUSTOM_DATE_RANGE,
} from "./selectors.js";

function createMockPage(overrides: any = {}) {
  const mockWaitFor = vi.fn().mockRejectedValue(new Error("timeout"));
  const mockLocator = {
    waitFor: vi.fn().mockResolvedValue(undefined),
  };
  return {
    getByRole: vi.fn().mockReturnValue({
      first: vi.fn().mockReturnValue({
        waitFor: overrides.roleWaitFor ?? mockWaitFor,
      }),
    }),
    locator: vi.fn().mockReturnValue({
      waitFor:
        overrides.labelWaitFor ??
        vi.fn().mockRejectedValue(new Error("timeout")),
    }),
    waitForFunction:
      overrides.waitForFunction ?? vi.fn().mockResolvedValue(undefined),
  };
}

describe("SELECTORS", () => {
  it("has all required keys", () => {
    const keys = Object.keys(SELECTORS);
    expect(keys.length).toBeGreaterThanOrEqual(17);
    expect(keys).toContain("addScriptToChart");
    expect(keys).toContain("monacoEditor");
    expect(keys).toContain("backtestPanel");
    expect(keys).toContain("backtestTab");
    expect(keys).toContain("compilationErrorWidget");
    expect(keys).toContain("strategyTitle");
    expect(keys).toContain("downloadXlsx");
    expect(keys).toContain("saveButton");
    expect(keys).toContain("renameDialog");
    expect(keys).toContain("confirmDialog");
  });

  it("all values are non-empty strings", () => {
    const allValid = Object.values(SELECTORS).every(
      (v) => typeof v === "string" && v.length > 0,
    );
    expect(allValid).toBe(true);
  });
});

describe("LOCALE_VARIANTS", () => {
  it("has at least 2 variants per key", () => {
    const allHaveEnough = Object.values(LOCALE_VARIANTS).every(
      (arr) => arr.length >= 2,
    );
    expect(allHaveEnough).toBe(true);
  });
});

describe("getPresetVariants", () => {
  it("returns variants for last7", () => {
    const variants = getPresetVariants("last7");
    expect(variants).toEqual(LOCALE_VARIANTS.last7days);
  });

  it("returns variants for last30", () => {
    expect(getPresetVariants("last30")).toEqual(LOCALE_VARIANTS.last30days);
  });

  it("returns variants for last90", () => {
    expect(getPresetVariants("last90")).toEqual(LOCALE_VARIANTS.last90days);
  });

  it("returns variants for last365", () => {
    expect(getPresetVariants("last365")).toEqual(LOCALE_VARIANTS.last365days);
  });

  it("returns variants for all", () => {
    expect(getPresetVariants("all")).toEqual(LOCALE_VARIANTS.allData);
  });

  it("throws for unknown preset", () => {
    expect(() => getPresetVariants("last60")).toThrow(/Unknown date range preset/);
  });
});

describe("CUSTOM_DATE_RANGE", () => {
  it("has all required selector keys", () => {
    expect(CUSTOM_DATE_RANGE).toHaveProperty("modalContainer");
    expect(CUSTOM_DATE_RANGE).toHaveProperty("dateInput");
    expect(CUSTOM_DATE_RANGE).toHaveProperty("startDateContainer");
    expect(CUSTOM_DATE_RANGE).toHaveProperty("submitButton");
    expect(CUSTOM_DATE_RANGE).toHaveProperty("cancelButton");
  });

  it("modalContainer uses data-name attribute", () => {
    expect(CUSTOM_DATE_RANGE.modalContainer).toContain("data-name");
    expect(CUSTOM_DATE_RANGE.modalContainer).toContain("custom-date-range-dialog");
  });
});

describe("locateWithVariants", () => {
  it("returns first matching variant", async () => {
    let callCount = 0;
    const roleWaitFor = vi.fn().mockImplementation(() => {
      callCount++;
      // Succeed on the 2nd call (2nd variant, getByRole attempt)
      if (callCount === 2) return Promise.resolve(undefined);
      return Promise.reject(new Error("timeout"));
    });

    const page = createMockPage({ roleWaitFor });
    const result = await locateWithVariants(
      page as any,
      "button",
      ["Variant A", "Variant B", "Variant C"],
    );

    // getByRole was called at least twice (failed on A, succeeded on B)
    expect(page.getByRole).toHaveBeenCalledWith("button", {
      name: "Variant B",
    });
    expect(result).toBeDefined();
  });

  it("falls back to aria-label when getByRole fails", async () => {
    const labelWaitFor = vi.fn().mockResolvedValue(undefined);
    const page = createMockPage({ labelWaitFor });
    // getByRole always fails (default), labelWaitFor succeeds

    const result = await locateWithVariants(
      page as any,
      "button",
      ["Variant A"],
    );

    // Should have tried getByRole first, then fallen back to locator
    expect(page.getByRole).toHaveBeenCalled();
    expect(page.locator).toHaveBeenCalledWith('[aria-label="Variant A"]');
    expect(result).toBeDefined();
  });

  it("throws when no variant matches", async () => {
    const page = createMockPage();
    // Both getByRole and locator fail by default

    await expect(
      locateWithVariants(page as any, "button", ["No match"]),
    ).rejects.toThrow(/None of the locale variants found/);
  });

  it("respects timeout option", async () => {
    const roleWaitFor = vi.fn().mockRejectedValue(new Error("timeout"));
    const labelWaitFor = vi.fn().mockRejectedValue(new Error("timeout"));
    const page = createMockPage({ roleWaitFor, labelWaitFor });

    await expect(
      locateWithVariants(page as any, "button", ["A", "B"], { timeout: 4000 }),
    ).rejects.toThrow();

    // Verify perVariantTimeout was computed from the custom timeout
    // With timeout=4000, variants=2 => perVariantTimeout = floor(4000 / (2*2)) = 1000
    // But min is 2000, so perVariantTimeout = 2000
    for (const call of roleWaitFor.mock.calls) {
      const arg = call[0] as { timeout?: number };
      expect(arg.timeout).toBeLessThanOrEqual(4000);
    }
  });
});

describe("waitForToastVariants", () => {
  it("resolves when text found", async () => {
    const waitForFunction = vi.fn().mockResolvedValue(undefined);
    const page = createMockPage({ waitForFunction });

    await expect(
      waitForToastVariants(page as any, ["Toast text"]),
    ).resolves.toBeUndefined();

    expect(waitForFunction).toHaveBeenCalledWith(
      expect.any(Function),
      ["Toast text"],
      { timeout: 30_000, polling: 500 },
    );
  });

  it("rejects on timeout", async () => {
    const waitForFunction = vi
      .fn()
      .mockRejectedValue(new Error("Timeout 30000ms exceeded"));
    const page = createMockPage({ waitForFunction });

    await expect(
      waitForToastVariants(page as any, ["Missing toast"], { timeout: 5000 }),
    ).rejects.toThrow(/Timeout/);

    expect(waitForFunction).toHaveBeenCalledWith(
      expect.any(Function),
      ["Missing toast"],
      { timeout: 5000, polling: 500 },
    );
  });
});
