// Build-camera math (SPEC §12.1). Pure — no Three.js, no DOM.
//
// Split out from camera.js so the clamps and the spring can be tested directly.
// The spring in particular has to be tested: a critically damped spring that
// never quite arrives is an infinite render loop wearing a disguise, and that
// failure is invisible except as a warm laptop.

/** §12.1 limits. Radians and metres. */
export const MIN_PITCH = 10 * (Math.PI / 180);
export const MAX_PITCH = 85 * (Math.PI / 180);
export const MIN_DISTANCE = 3;
export const MAX_DISTANCE = 150;

/** §12.1: "Target stays within lot bounds + 10 m." */
export const TARGET_MARGIN = 10;

/** §12.1 smoothing, ~120 ms to settle. */
export const SPRING_MS = 120;

/**
 * Below this the spring is declared at rest and stops asking for frames.
 *
 * The position epsilon is a millimetre, far below a pixel at any usable zoom.
 * The velocity epsilon is that same distance *per 60 Hz frame*, not per second:
 * once the next frame would move less than the position epsilon, continuing to
 * draw is spending frames on motion nobody can see. A per-second threshold
 * looks equally reasonable and quietly costs about 0.7 s of extra rendering
 * after every camera nudge — which is precisely the kind of cost
 * render-on-demand exists to remove.
 */
export const REST_EPSILON = 1e-3;
export const REST_VELOCITY_EPSILON = REST_EPSILON * 60;

/** Pure. */
export function clamp(value, min, max) {
  return value < min ? min : value > max ? max : value;
}

/** Pure. §12.1 pitch clamp, 10°–85°. */
export function clampPitch(pitch) {
  return clamp(Number(pitch) || 0, MIN_PITCH, MAX_PITCH);
}

/** Pure. §12.1 zoom clamp, 3–150 m. */
export function clampDistance(distance) {
  return clamp(Number(distance) || 0, MIN_DISTANCE, MAX_DISTANCE);
}

/**
 * Pure. §12.1 target clamp: inside the lot plus a 10 m margin.
 * Y is pinned to the ground plane — the build camera orbits a ground target.
 * @param {!Array<number>} target [x, y, z]
 * @param {!Array<number>} lotSize [sizeX, sizeZ] in tiles, 1 tile = 1 m (§5)
 * @returns {!Array<number>}
 */
export function clampTarget(target, lotSize) {
  const [sizeX, sizeZ] = lotSize || [0, 0];
  const [x = 0, y = 0, z = 0] = target || [];
  return [
    clamp(x, -TARGET_MARGIN, sizeX + TARGET_MARGIN),
    clamp(y, -TARGET_MARGIN, TARGET_MARGIN),
    clamp(z, -TARGET_MARGIN, sizeZ + TARGET_MARGIN),
  ];
}

/**
 * Pure. Wrap yaw into (−π, π] so the spring takes the short way round instead
 * of unwinding several turns after the user spins the view.
 */
export function wrapAngle(angle) {
  let a = Number(angle);
  while (a > Math.PI) a -= Math.PI * 2;
  while (a <= -Math.PI) a += Math.PI * 2;
  return a;
}

/**
 * Pure. One critically damped spring step.
 *
 * Closed form rather than Euler integration: at 20 ms frames an explicit
 * integrator with a 120 ms spring is close enough to its stability limit to
 * ring, and the ringing would show up as a camera that shivers at low frame
 * rates on exactly the machines least able to hide it.
 *
 * @param {number} current
 * @param {number} target
 * @param {number} velocity
 * @param {number} dt seconds
 * @param {number} [settleMs] time to effectively reach the target
 * @returns {{value: number, velocity: number}}
 */
export function springStep(current, target, velocity, dt, settleMs = SPRING_MS) {
  if (!(dt > 0)) return { value: current, velocity };
  // ω such that the response is ~99% complete after `settleMs`.
  const omega = 5 / (settleMs / 1000);
  const delta = current - target;
  const exp = Math.exp(-omega * dt);

  // x(t) = (A + B t)·e^(−ωt) with A = delta, B = v + ω·delta, which is the
  // exact solution of the critically damped equation rather than a step of a
  // numerical integrator. Differentiating it gives the velocity below; dropping
  // its −ω·v·t term leaves a spring that overshoots by about 10%, which reads
  // as a camera that snaps past where you let go.
  const b = velocity + omega * delta;
  const nextValue = target + (delta + b * dt) * exp;
  const nextVelocity = (velocity * (1 - omega * dt) - omega * omega * delta * dt) * exp;
  return { value: nextValue, velocity: nextVelocity };
}

/**
 * Pure. Has the spring arrived?
 *
 * Both conditions matter: a value within epsilon while still moving fast is
 * mid-overshoot, not at rest, and stopping there leaves a visible jump.
 */
export function atRest(current, target, velocity, epsilon = REST_EPSILON) {
  return Math.abs(current - target) <= epsilon && Math.abs(velocity) <= REST_VELOCITY_EPSILON;
}

/**
 * Pure. Orbit position for a target, yaw, pitch and distance (§5 axes: +X east,
 * +Z south, Y up). Yaw 0 puts the camera due south of the target, looking north.
 * @returns {!Array<number>} [x, y, z]
 */
export function orbitPosition(target, yaw, pitch, distance) {
  const [tx, ty, tz] = target;
  const horizontal = Math.cos(pitch) * distance;
  return [
    tx + Math.sin(yaw) * horizontal,
    ty + Math.sin(pitch) * distance,
    tz + Math.cos(yaw) * horizontal,
  ];
}

/**
 * Pure. Pan offset for a screen-space drag, in world units.
 *
 * Panning follows the camera's yaw so dragging right always moves the view
 * right, whatever direction the camera faces. Scaled by distance so the lot
 * moves the same number of pixels per pixel dragged at every zoom.
 * @returns {!Array<number>} [dx, dz]
 */
export function panOffset(dxPixels, dyPixels, yaw, distance, viewportHeight) {
  const scale = (2 * distance) / Math.max(viewportHeight, 1);
  const right = [Math.cos(yaw), -Math.sin(yaw)];
  const forward = [Math.sin(yaw), Math.cos(yaw)];
  return [
    -dxPixels * scale * right[0] + dyPixels * scale * forward[0],
    -dxPixels * scale * right[1] + dyPixels * scale * forward[1],
  ];
}

/**
 * Pure. Multiplicative zoom from a wheel delta, so one notch covers the same
 * proportion of the range near and far.
 */
export function zoomDistance(distance, wheelDelta) {
  return clampDistance(distance * Math.exp(wheelDelta * 0.0015));
}

/** Keys §12 reserves for the camera and forbids tools from binding. */
export const CAMERA_KEYS = Object.freeze([
  "KeyW", "KeyA", "KeyS", "KeyD",
  "KeyQ", "KeyE", "KeyZ", "KeyX", "KeyC",
  "Space",
  "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight",
]);

/**
 * Pure. Should camera input be ignored because the user is typing?
 * §12.1: "Camera keys are ignored while a text input has focus."
 * @param {?Object} element document.activeElement
 */
export function isTextEntry(element) {
  if (!element) return false;
  const tag = String(element.tagName || "").toUpperCase();
  if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return true;
  return element.isContentEditable === true;
}
