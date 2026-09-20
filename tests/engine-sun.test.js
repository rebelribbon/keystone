import { describe, it, expect } from "vitest";
import {
  computeSunPosition,
  skyPalette,
  normalizeDegrees,
  AXIAL_TILT_DEG,
  SEASON_DECLINATION_DEG,
} from "../src/client/engine/sun.js";

/** Lat 30 is §6's default and Texas Hill Country's rough latitude. */
const LAT = 30;
const at = (timeOfDay, extra = {}) =>
  computeSunPosition({ timeOfDay, latitude: LAT, season: "spring", ...extra });

describe("computeSunPosition (§8.2)", () => {
  it("puts the equinox noon sun at 90° minus the latitude, due south", () => {
    const noon = at(12);
    expect(noon.elevationDeg).toBeCloseTo(90 - LAT, 6);
    expect(noon.azimuthDeg).toBeCloseTo(180, 6);
    expect(noon.aboveHorizon).toBe(true);
  });

  it("puts equinox sunrise and sunset on the horizon", () => {
    expect(at(6).elevationDeg).toBeCloseTo(0, 6);
    expect(at(18).elevationDeg).toBeCloseTo(0, 6);
    // Sunrise in the east, sunset in the west.
    expect(at(6).azimuthDeg).toBeCloseTo(90, 4);
    expect(at(18).azimuthDeg).toBeCloseTo(270, 4);
  });

  it("puts midnight well below the horizon", () => {
    const midnight = at(0);
    expect(midnight.elevationDeg).toBeLessThan(0);
    expect(midnight.elevationDeg).toBeCloseTo(-(90 - LAT), 6);
    expect(midnight.aboveHorizon).toBe(false);
    expect(at(24).elevationDeg).toBeCloseTo(midnight.elevationDeg, 10);
  });

  it("rotating the lot 90° moves the sun's azimuth by 90°", () => {
    const straight = at(12);
    const rotated = at(12, { orientationDeg: 90 });
    expect(normalizeDegrees(straight.azimuthDeg - rotated.azimuthDeg)).toBeCloseTo(90, 6);
    // Elevation is a property of the sky, not the building, so it must not move.
    expect(rotated.elevationDeg).toBeCloseTo(straight.elevationDeg, 10);
  });

  it("separates the solstices in the right direction", () => {
    const summer = at(12, { season: "summer" }).elevationDeg;
    const equinox = at(12, { season: "spring" }).elevationDeg;
    const winter = at(12, { season: "winter" }).elevationDeg;

    expect(summer).toBeGreaterThan(equinox);
    expect(equinox).toBeGreaterThan(winter);
    expect(summer).toBeCloseTo(90 - LAT + AXIAL_TILT_DEG, 6);
    expect(winter).toBeCloseTo(90 - LAT - AXIAL_TILT_DEG, 6);
    // Both equinoxes are the same sky.
    expect(at(12, { season: "autumn" }).elevationDeg).toBeCloseTo(equinox, 10);
  });

  it("keeps the direction vector on §5's axes and on the unit sphere", () => {
    for (const hour of [0, 4, 6, 9, 12, 15, 18, 21]) {
      const { direction, elevationDeg, azimuthDeg } = at(hour);
      const length = Math.hypot(direction.x, direction.y, direction.z);
      expect(length, `hour ${hour}`).toBeCloseTo(1, 10);
      // +Y is up, so y tracks elevation.
      expect(Math.sign(direction.y)).toBe(Math.sign(elevationDeg) || 0);
      // Due south (azimuth 180) is +Z; due east (90) is +X.
      if (Math.abs(azimuthDeg - 180) < 1e-6) expect(direction.z).toBeGreaterThan(0);
      if (Math.abs(azimuthDeg - 90) < 1e-4) expect(direction.x).toBeGreaterThan(0);
    }
  });

  it("falls back to an equinox for an unknown season rather than throwing", () => {
    expect(at(12, { season: "monsoon" }).declinationDeg).toBe(0);
    expect(SEASON_DECLINATION_DEG.fall).toBe(0);
  });

  it("works in the southern hemisphere", () => {
    const north = computeSunPosition({ timeOfDay: 12, latitude: -30, season: "spring" });
    expect(north.elevationDeg).toBeCloseTo(60, 6);
    // Below the equator the noon sun is in the north, not the south.
    expect(north.azimuthDeg).toBeCloseTo(0, 6);
  });

  it("defaults to a usable sky when handed nothing", () => {
    const fallback = computeSunPosition();
    expect(Number.isFinite(fallback.elevationDeg)).toBe(true);
    expect(fallback.aboveHorizon).toBe(true);
  });
});

describe("skyPalette (§8.1)", () => {
  it("darkens, dims and brings out stars as the sun sets", () => {
    const noon = skyPalette(60);
    const dusk = skyPalette(0);
    const night = skyPalette(-30);

    expect(noon.sunIntensity).toBeGreaterThan(dusk.sunIntensity);
    expect(dusk.sunIntensity).toBeGreaterThan(night.sunIntensity);
    expect(night.sunIntensity).toBe(0);

    expect(night.starOpacity).toBe(1);
    expect(noon.starOpacity).toBe(0);

    // §8.1's "subtle ambient at night for readability" — the one light that
    // goes up rather than down after dark.
    expect(night.ambientIntensity).toBeGreaterThan(noon.ambientIntensity);
  });

  it("tracks exposure with time of day (§8.1)", () => {
    expect(skyPalette(60).exposure).toBeCloseTo(1.0, 6);
    expect(skyPalette(-18).exposure).toBeLessThan(1.0);
    expect(skyPalette(0).exposure).toBeLessThan(skyPalette(45).exposure);
  });

  it("returns well-formed colours at every elevation, including past the ends", () => {
    for (const elevation of [-90, -30, -18, -6, 0, 12, 45, 90, 120]) {
      const palette = skyPalette(elevation);
      for (const key of ["zenith", "horizon", "sunTint", "fog"]) {
        expect(palette[key], `${key} at ${elevation}`).toMatch(/^#[0-9a-f]{6}$/);
      }
      expect(palette.exposure).toBeGreaterThan(0);
      expect(palette.starOpacity).toBeGreaterThanOrEqual(0);
      expect(palette.starOpacity).toBeLessThanOrEqual(1);
    }
  });

  it("is continuous across a keyframe boundary", () => {
    // A visible step in the sky as the sun crosses a stop would read as a bug.
    const below = skyPalette(11.99);
    const above = skyPalette(12.01);
    expect(Math.abs(below.exposure - above.exposure)).toBeLessThan(0.01);
    expect(Math.abs(below.sunIntensity - above.sunIntensity)).toBeLessThan(0.02);
  });
});
