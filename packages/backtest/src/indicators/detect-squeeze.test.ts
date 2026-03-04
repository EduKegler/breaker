import { describe, it, expect } from "vitest";
import { detectSqueeze } from "./detect-squeeze.js";
import type { BollingerBandsResult } from "./bollinger-bands.js";
import type { KeltnerResult } from "./keltner.js";

function makeBB(upper: number[], mid: number[], lower: number[]): BollingerBandsResult {
  return { upper, mid, lower };
}

function makeKC(upper: number[], mid: number[], lower: number[]): KeltnerResult {
  return { upper, mid, lower };
}

describe("detectSqueeze", () => {
  it("returns empty arrays for empty input", () => {
    const bb = makeBB([], [], []);
    const kc = makeKC([], [], []);
    const result = detectSqueeze(bb, kc);
    expect(result.squeezeOn).toEqual([]);
    expect(result.squeezeActive).toEqual([]);
    expect(result.bbWidth).toEqual([]);
  });

  it("squeezeOn is true when BB inside KC", () => {
    // BB(90,100,110) inside KC(80,100,120)
    const bb = makeBB([110], [100], [90]);
    const kc = makeKC([120], [100], [80]);
    const result = detectSqueeze(bb, kc, 1);
    expect(result.squeezeOn[0]).toBe(true);
  });

  it("squeezeOn is false when BB outside KC", () => {
    // BB(70,100,130) outside KC(80,100,120)
    const bb = makeBB([130], [100], [70]);
    const kc = makeKC([120], [100], [80]);
    const result = detectSqueeze(bb, kc, 1);
    expect(result.squeezeOn[0]).toBe(false);
  });

  it("squeezeActive requires minBars of decreasing width", () => {
    // 6 bars all with BB inside KC, width decreasing from bar 0
    const bbUpper = [115, 114, 113, 112, 111, 110];
    const bbLower = [85, 86, 87, 88, 89, 90];
    const bbMid = [100, 100, 100, 100, 100, 100];
    const kcUpper = [130, 130, 130, 130, 130, 130];
    const kcLower = [70, 70, 70, 70, 70, 70];
    const kcMid = [100, 100, 100, 100, 100, 100];

    const bb = makeBB(bbUpper, bbMid, bbLower);
    const kc = makeKC(kcUpper, kcMid, kcLower);
    const result = detectSqueeze(bb, kc, 4);

    // squeezeOn should be true for all bars
    expect(result.squeezeOn.every(Boolean)).toBe(true);

    // squeezeActive: need 4 bars of decreasing width
    // bar0: width=30, count=0 (no previous) → false
    // bar1: width=28, count=1 → false
    // bar2: width=26, count=2 → false
    // bar3: width=24, count=3 → false
    // bar4: width=22, count=4 → true!
    // bar5: width=20, count=5 → true
    expect(result.squeezeActive[0]).toBe(false);
    expect(result.squeezeActive[1]).toBe(false);
    expect(result.squeezeActive[2]).toBe(false);
    expect(result.squeezeActive[3]).toBe(false);
    expect(result.squeezeActive[4]).toBe(true);
    expect(result.squeezeActive[5]).toBe(true);
  });

  it("squeezeActive is false when width increasing even with squeezeOn", () => {
    // BB inside KC but width increasing
    const bbUpper = [110, 112, 114, 116, 118];
    const bbLower = [90, 88, 86, 84, 82];
    const bbMid = [100, 100, 100, 100, 100];
    const kcUpper = [130, 130, 130, 130, 130];
    const kcLower = [70, 70, 70, 70, 70];
    const kcMid = [100, 100, 100, 100, 100];

    const bb = makeBB(bbUpper, bbMid, bbLower);
    const kc = makeKC(kcUpper, kcMid, kcLower);
    const result = detectSqueeze(bb, kc, 4);

    expect(result.squeezeOn.every(Boolean)).toBe(true);
    expect(result.squeezeActive.every((v) => v === false)).toBe(true);
  });

  it("resets decreasing count when squeeze breaks", () => {
    // Bars 0-3: squeeze on, width decreasing → squeezeActive at bar 4
    // Bar 4: squeeze OFF (BB outside KC) → reset
    // Bars 5-8: squeeze on, width decreasing → squeezeActive at bar 9
    const bbUpper = [115, 114, 113, 112, 150, 115, 114, 113, 112, 111];
    const bbLower = [85, 86, 87, 88, 50, 85, 86, 87, 88, 89];
    const bbMid = [100, 100, 100, 100, 100, 100, 100, 100, 100, 100];
    const kcUpper = [130, 130, 130, 130, 130, 130, 130, 130, 130, 130];
    const kcLower = [70, 70, 70, 70, 70, 70, 70, 70, 70, 70];
    const kcMid = [100, 100, 100, 100, 100, 100, 100, 100, 100, 100];

    const bb = makeBB(bbUpper, bbMid, bbLower);
    const kc = makeKC(kcUpper, kcMid, kcLower);
    const result = detectSqueeze(bb, kc, 4);

    // Bar 4: BB outside KC → squeezeOn false, reset
    expect(result.squeezeOn[4]).toBe(false);
    expect(result.squeezeActive[4]).toBe(false);

    // After reset, bars 5-8 start counting from 0 again
    expect(result.squeezeActive[8]).toBe(false); // only 3 decreasing (6→7→8)
    expect(result.squeezeActive[9]).toBe(true);  // 4 decreasing (6→7→8→9)
  });

  it("NaN in warmup does not cause error", () => {
    const bb = makeBB([NaN, NaN, 110], [NaN, NaN, 100], [NaN, NaN, 90]);
    const kc = makeKC([NaN, NaN, 120], [NaN, NaN, 100], [NaN, NaN, 80]);
    const result = detectSqueeze(bb, kc, 1);

    expect(result.squeezeOn[0]).toBe(false);
    expect(result.squeezeOn[1]).toBe(false);
    expect(result.squeezeOn[2]).toBe(true);
    expect(result.squeezeActive).toHaveLength(3);
  });

  it("bbWidth equals upper - lower", () => {
    const bb = makeBB([120, 115, 112], [100, 100, 100], [80, 85, 88]);
    const kc = makeKC([130, 130, 130], [100, 100, 100], [70, 70, 70]);
    const result = detectSqueeze(bb, kc);

    expect(result.bbWidth[0]).toBeCloseTo(40, 8);
    expect(result.bbWidth[1]).toBeCloseTo(30, 8);
    expect(result.bbWidth[2]).toBeCloseTo(24, 8);
  });
});
