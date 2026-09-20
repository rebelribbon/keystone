import { describe, it, expect } from "vitest";
import {
  clampPitch,
  clampDistance,
  clampTarget,
  wrapAngle,
  springStep,
  atRest,
  orbitPosition,
  panOffset,
  zoomDistance,
  isTextEntry,
  CAMERA_KEYS,
  MIN_PITCH,
  MAX_PITCH,
  MIN_DISTANCE,
  MAX_DISTANCE,
  TARGET_MARGIN,
  SPRING_MS,
} from "../src/client/engine/camera-math.js";

const DEG = Math.PI / 180;

describe("camera clamps (§12.1)", () => {
  it("holds pitch between 10° and 85°", () => {
    expect(clampPitch(-5 * DEG)).toBeCloseTo(MIN_PITCH, 10);
    expect(clampPitch(0)).toBeCloseTo(10 * DEG, 10);
    expect(clampPitch(90 * DEG)).toBeCloseTo(MAX_PITCH, 10);
    expect(clampPitch(200)).toBeCloseTo(85 * DEG, 10);
    expect(clampPitch(45 * DEG)).toBeCloseTo(45 * DEG, 10);
  });

  it("holds zoom between 3 m and 150 m", () => {
    expect(clampDistance(0)).toBe(MIN_DISTANCE);
    expect(clampDistance(-20)).toBe(MIN_DISTANCE);
    expect(clampDistance(1000)).toBe(MAX_DISTANCE);
    expect(clampDistance(38)).toBe(38);
  });

  it("holds the target inside the lot plus 10 m", () => {
    const lot = [40, 30];
    expect(clampTarget([-999, 0, -999], lot)).toEqual([-TARGET_MARGIN, 0, -TARGET_MARGIN]);
    expect(clampTarget([999, 0, 999], lot)).toEqual([40 + TARGET_MARGIN, 0, 30 + TARGET_MARGIN]);
    expect(clampTarget([20, 0, 15], lot)).toEqual([20, 0, 15]);
  });

  it("keeps the build target on the ground plane", () => {
    // §12.1: the build camera orbits a *ground* target. Letting Y drift turns
    // panning into an unintended flight.
    expect(clampTarget([5, 500, 5], [40, 30])[1]).toBe(TARGET_MARGIN);
    expect(clampTarget([5, -500, 5], [40, 30])[1]).toBe(-TARGET_MARGIN);
  });

  it("clamps zoom applied through the wheel, in both directions", () => {
    expect(zoomDistance(150, 5000)).toBe(MAX_DISTANCE);
    expect(zoomDistance(3, -5000)).toBe(MIN_DISTANCE);
    expect(zoomDistance(40, -100)).toBeLessThan(40);
    expect(zoomDistance(40, 100)).toBeGreaterThan(40);
  });

  it("zooms by the same proportion near and far", () => {
    const near = zoomDistance(10, -100) / 10;
    const far = zoomDistance(100, -100) / 100;
    expect(near).toBeCloseTo(far, 10);
  });
});

describe("the camera spring (§12.1)", () => {
  it("reaches rest and stops, for travel from 1 m to 100 m", () => {
    // The acceptance item this covers is really about §4.2: a spring that never
    // quite arrives keeps asking for frames forever.
    for (const distance of [1, 10, 100]) {
      let value = 0;
      let velocity = 0;
      let frames = 0;
      while (!atRest(value, distance, velocity) && frames < 600) {
        const step = springStep(value, distance, velocity, 1 / 60);
        value = step.value;
        velocity = step.velocity;
        frames += 1;
      }
      expect(atRest(value, distance, velocity), `travel ${distance} m`).toBe(true);
      expect(frames, `travel ${distance} m settled in ${frames} frames`).toBeLessThan(60);
      expect(Math.abs(value - distance)).toBeLessThan(1e-3);
    }
  });

  it("covers most of the distance within the ~120 ms the spec asks for", () => {
    let value = 0;
    let velocity = 0;
    const frames = Math.round((SPRING_MS / 1000) * 60);
    for (let i = 0; i < frames; i += 1) {
      const step = springStep(value, 1, velocity, 1 / 60);
      value = step.value;
      velocity = step.velocity;
    }
    expect(value).toBeGreaterThan(0.9);
  });

  it("does not overshoot — it is critically damped, not bouncy", () => {
    let value = 0;
    let velocity = 0;
    let peak = 0;
    for (let i = 0; i < 200; i += 1) {
      const step = springStep(value, 1, velocity, 1 / 60);
      value = step.value;
      velocity = step.velocity;
      peak = Math.max(peak, value);
    }
    expect(peak).toBeLessThanOrEqual(1.0001);
  });

  it("is stable at a bad frame rate", () => {
    // 100 ms frames against a 120 ms spring is where an explicit integrator
    // would ring or diverge.
    let value = 0;
    let velocity = 0;
    for (let i = 0; i < 100; i += 1) {
      const step = springStep(value, 1, velocity, 0.1);
      value = step.value;
      velocity = step.velocity;
      expect(Number.isFinite(value)).toBe(true);
      expect(value).toBeLessThanOrEqual(1.0001);
    }
    expect(value).toBeCloseTo(1, 6);
  });

  it("does nothing for a zero or negative timestep", () => {
    expect(springStep(1, 5, 0, 0)).toEqual({ value: 1, velocity: 0 });
    expect(springStep(1, 5, 0, -1)).toEqual({ value: 1, velocity: 0 });
  });

  it("atRest needs both closeness and stillness", () => {
    // Close but fast is mid-flight, not at rest; stopping there leaves a jump.
    expect(atRest(1, 1, 0)).toBe(true);
    expect(atRest(1, 1, 5)).toBe(false);
    expect(atRest(1, 9, 0)).toBe(false);
  });
});

describe("orbit and pan geometry (§5 axes)", () => {
  it("puts yaw 0 due south of the target, looking north", () => {
    const [x, y, z] = orbitPosition([10, 0, 10], 0, 45 * DEG, 10);
    expect(x).toBeCloseTo(10, 10);
    expect(y).toBeGreaterThan(0);
    expect(z).toBeGreaterThan(10);
  });

  it("keeps the orbit radius at the requested distance", () => {
    for (const yaw of [0, 1, 2, -2]) {
      for (const pitch of [MIN_PITCH, 45 * DEG, MAX_PITCH]) {
        const [x, y, z] = orbitPosition([5, 0, 7], yaw, pitch, 25);
        expect(Math.hypot(x - 5, y, z - 7)).toBeCloseTo(25, 8);
      }
    }
  });

  it("wraps yaw so the spring takes the short way round", () => {
    expect(wrapAngle(Math.PI * 3)).toBeCloseTo(Math.PI, 10);
    expect(wrapAngle(-Math.PI * 3)).toBeCloseTo(Math.PI, 10);
    expect(wrapAngle(0.5)).toBeCloseTo(0.5, 10);
  });

  it("pans in screen space whatever way the camera faces", () => {
    const dragRight = panOffset(10, 0, 0, 40, 600);
    const rotated = panOffset(10, 0, Math.PI / 2, 40, 600);
    // Same drag, different yaw: the world offset rotates with the camera, so
    // the lot always slides the way the mouse went.
    expect(Math.hypot(...dragRight)).toBeCloseTo(Math.hypot(...rotated), 8);
    expect(dragRight).not.toEqual(rotated);
  });

  it("pans further per pixel when zoomed out", () => {
    const near = Math.hypot(...panOffset(10, 0, 0, 10, 600));
    const far = Math.hypot(...panOffset(10, 0, 0, 100, 600));
    expect(far).toBeGreaterThan(near * 9);
  });
});

describe("reserved keys and text focus (§12, §12.1)", () => {
  it("reserves exactly the §12 camera keys", () => {
    for (const code of ["KeyW", "KeyA", "KeyS", "KeyD", "KeyQ", "KeyE", "KeyZ", "KeyX", "KeyC", "Space"]) {
      expect(CAMERA_KEYS, code).toContain(code);
    }
  });

  it("treats inputs, textareas, selects and contenteditable as text entry", () => {
    expect(isTextEntry({ tagName: "INPUT" })).toBe(true);
    expect(isTextEntry({ tagName: "textarea" })).toBe(true);
    expect(isTextEntry({ tagName: "SELECT" })).toBe(true);
    expect(isTextEntry({ tagName: "DIV", isContentEditable: true })).toBe(true);
  });

  it("treats the canvas and the body as fair game", () => {
    expect(isTextEntry({ tagName: "CANVAS" })).toBe(false);
    expect(isTextEntry({ tagName: "BODY", isContentEditable: false })).toBe(false);
    expect(isTextEntry(null)).toBe(false);
  });
});
