import { describe, expect, it } from "vitest";
import { homepageAutoplayerEnabled, isEligibleHomepageAutoplayUrl, pingPongOrder, settledRange, usableRange } from "./homepageAutoplay";

describe("homepage autoplay eligibility", () => {
  it("defaults off and accepts only explicit enabled values", () => {
    expect(homepageAutoplayerEnabled(undefined)).toBe(false);
    expect(homepageAutoplayerEnabled("0")).toBe(false);
    expect(homepageAutoplayerEnabled("1")).toBe(true);
    expect(homepageAutoplayerEnabled("TRUE")).toBe(true);
  });

  it("accepts the clean homepage and cache busting only", () => {
    expect(isEligibleHomepageAutoplayUrl("https://pixilation.org/")).toBe(true);
    expect(isEligibleHomepageAutoplayUrl("https://pixilation.org/?v=123")).toBe(true);
    expect(isEligibleHomepageAutoplayUrl("https://pixilation.org/?year=2002")).toBe(false);
    expect(isEligibleHomepageAutoplayUrl("https://pixilation.org/?photo=x")).toBe(false);
    expect(isEligibleHomepageAutoplayUrl("https://pixilation.org/?debug=1")).toBe(false);
    expect(isEligibleHomepageAutoplayUrl("https://pixilation.org/other")).toBe(false);
    expect(isEligibleHomepageAutoplayUrl("https://pixilation.org/", true)).toBe(false);
  });
});

describe("homepage autoplay buffers", () => {
  it("builds endpoint-deduplicated ping-pong orders", () => {
    expect(pingPongOrder([0, 1, 2, 3, 4])).toEqual([0, 1, 2, 3, 4, 3, 2, 1, 0]);
    expect(pingPongOrder([5, 6, 7, 8, 9, 10, 11, 12, 13, 14])).toEqual([
      5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 13, 12, 11, 10, 9, 8, 7, 6, 5
    ]);
    expect(pingPongOrder([0, 1])).toEqual([0, 1, 0]);
    expect(pingPongOrder([0])).toEqual([0]);
  });

  it("settles failed ranges without including failed frames", () => {
    const statuses = new Map<number, "ready" | "failed">([[0, "ready"], [1, "failed"], [2, "ready"]]);
    expect(settledRange(statuses, 0, 3)).toBe(true);
    expect(settledRange(statuses, 0, 4)).toBe(false);
    expect(usableRange(statuses, 0, 3)).toEqual([0, 2]);
  });

  it("keeps failed first-five and next-ten buffers ordered and fully settleable", () => {
    const statuses = new Map<number, "ready" | "failed">();
    for (let index = 0; index < 15; index += 1) statuses.set(index, index === 2 || index === 8 ? "failed" : "ready");
    expect(settledRange(statuses, 0, 5)).toBe(true);
    expect(settledRange(statuses, 5, 15)).toBe(true);
    expect(usableRange(statuses, 0, 5)).toEqual([0, 1, 3, 4]);
    expect(usableRange(statuses, 5, 15)).toEqual([5, 6, 7, 9, 10, 11, 12, 13, 14]);
  });
});
