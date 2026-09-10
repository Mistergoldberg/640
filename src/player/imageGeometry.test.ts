import { describe, expect, it } from "vitest";
import { calculateImageGeometry, playerFitClearance } from "./imageGeometry";

describe("calculateImageGeometry", () => {
  it("swaps the effective dimensions for quarter-turn rotations", () => {
    const geometry = calculateImageGeometry({
      sourceWidth: 640,
      sourceHeight: 480,
      viewportWidth: 1200,
      viewportHeight: 900,
      controlClearance: 0,
      mode: "fit",
      rotation: 90
    });

    expect(geometry.effectiveWidth).toBe(480);
    expect(geometry.effectiveHeight).toBe(640);
  });

  it("expands desktop images to full viewport height", () => {
    const geometry = calculateImageGeometry({
      sourceWidth: 640,
      sourceHeight: 480,
      viewportWidth: 1200,
      viewportHeight: 900,
      controlClearance: 0,
      mode: "expanded",
      rotation: 0
    });

    expect(geometry.renderedHeight).toBe(900);
  });

  it("expands mobile portrait images to full viewport width", () => {
    const geometry = calculateImageGeometry({
      sourceWidth: 640,
      sourceHeight: 480,
      viewportWidth: 390,
      viewportHeight: 844,
      controlClearance: 0,
      mode: "expanded",
      rotation: 0
    });

    expect(geometry.renderedWidth).toBe(390);
  });

  it("expands mobile landscape images to full viewport height", () => {
    const geometry = calculateImageGeometry({
      sourceWidth: 640,
      sourceHeight: 480,
      viewportWidth: 844,
      viewportHeight: 390,
      controlClearance: 0,
      mode: "expanded",
      rotation: 0
    });

    expect(geometry.renderedHeight).toBe(390);
  });

  it("keeps fit mode inside the player control clearance", () => {
    const clearance = playerFitClearance(390, 844);
    expect(clearance).toEqual({ vertical: 134, horizontal: 24 });
    const geometry = calculateImageGeometry({
      sourceWidth: 640,
      sourceHeight: 480,
      viewportWidth: 390 - clearance.horizontal,
      viewportHeight: 844,
      controlClearance: clearance.vertical,
      mode: "fit",
      rotation: 0
    });

    expect(geometry.renderedWidth).toBeLessThanOrEqual(366);
    expect(geometry.renderedHeight).toBeLessThanOrEqual(710);
  });

  it("contains fit and expanded images within a landscape media stage", () => {
    const fit = calculateImageGeometry({
      sourceWidth: 640,
      sourceHeight: 480,
      viewportWidth: 776,
      viewportHeight: 390,
      controlClearance: 0,
      mode: "fit",
      rotation: 0
    });
    const expandedPortrait = calculateImageGeometry({
      sourceWidth: 360,
      sourceHeight: 480,
      viewportWidth: 599,
      viewportHeight: 320,
      controlClearance: 0,
      mode: "expanded",
      rotation: 0
    });

    expect(fit.renderedWidth).toBe(520);
    expect(fit.renderedHeight).toBe(390);
    expect(fit.overflowX).toBe(0);
    expect(fit.overflowY).toBe(0);
    expect(expandedPortrait.renderedWidth).toBe(240);
    expect(expandedPortrait.renderedHeight).toBe(320);
    expect(expandedPortrait.overflowX).toBe(0);
    expect(expandedPortrait.overflowY).toBe(0);
  });
});
