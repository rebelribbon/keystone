// Build and free cameras (SPEC §12.1).
//
// The maths is in camera-math.js; this file is input handling and the bridge to
// Three. The one rule that matters for §4.2: the spring asks for a frame while
// it is moving and stops the moment it is at rest. Nothing else here schedules.
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
  MIN_DISTANCE,
  MAX_DISTANCE,
} from "./camera-math.js";

/** Metres per second for keyboard panning, scaled by zoom. */
const KEY_PAN_RATE = 0.9;
/** Radians per second for Q/E. */
const KEY_ROTATE_RATE = 1.6;
/** Zoom multiplier per second for Z/X. */
const KEY_ZOOM_RATE = 1.5;
/** Free-camera fly speed, metres per second (§12.1). */
const FLY_SPEED = 12;

/**
 * Create the camera controller.
 *
 * @param {{camera: !Object, domElement: !HTMLElement, store: !Object,
 *          requestRender: function(): void, window?: !Object,
 *          document?: !Object}} options
 */
export function createCameraController(options) {
  const {
    camera,
    domElement,
    store,
    requestRender,
    window: win = window,
    document: doc = document,
  } = options;

  const saved = store.getDocument().camera;
  const lotSize = store.getDocument().lot.size;

  // Desired values move instantly with input; current values chase them.
  const desired = {
    target: clampTarget(saved.target.slice(), lotSize),
    yaw: saved.yaw,
    pitch: clampPitch(saved.pitch),
    distance: clampDistance(saved.distance),
  };
  const current = {
    target: desired.target.slice(),
    yaw: desired.yaw,
    pitch: desired.pitch,
    distance: desired.distance,
  };
  const velocity = { target: [0, 0, 0], yaw: 0, pitch: 0, distance: 0 };

  let mode = "build";
  let lastTime = null;
  let settled = true;

  // Free camera (§12.1) keeps its own position and look angles.
  const free = { position: [0, 0, 0], yaw: 0, pitch: 0 };

  const keysDown = new Set();
  const pointers = new Map();
  let dragButton = -1;
  let lastPointer = { x: 0, y: 0 };

  function lotBounds() {
    return store.getDocument().lot.size;
  }

  /** Nudge the spring awake and make sure a frame is coming. */
  function wake() {
    settled = false;
    requestRender();
  }

  /* ---------------------------------------------------------------------
   * Input
   * ------------------------------------------------------------------ */

  function onPointerDown(event) {
    domElement.setPointerCapture?.(event.pointerId);
    pointers.set(event.pointerId, event);
    // §12.1: right-drag orbits, middle-drag pans. Left is left alone — it
    // belongs to the tools.
    if (dragButton === -1 && (event.button === 2 || event.button === 1)) {
      dragButton = event.button;
      lastPointer = { x: event.clientX, y: event.clientY };
      event.preventDefault();
    }
  }

  function onPointerMove(event) {
    if (dragButton === -1) return;
    const dx = event.clientX - lastPointer.x;
    const dy = event.clientY - lastPointer.y;
    lastPointer = { x: event.clientX, y: event.clientY };
    if (!dx && !dy) return;

    if (mode === "free") {
      free.yaw = wrapAngle(free.yaw - dx * 0.005);
      free.pitch = Math.max(-1.5, Math.min(1.5, free.pitch - dy * 0.005));
      wake();
      return;
    }

    if (dragButton === 2) {
      desired.yaw = wrapAngle(desired.yaw - dx * 0.006);
      desired.pitch = clampPitch(desired.pitch + dy * 0.005);
    } else {
      const height = domElement.clientHeight || 1;
      const [ox, oz] = panOffset(dx, dy, desired.yaw, desired.distance, height);
      desired.target = clampTarget(
        [desired.target[0] + ox, desired.target[1], desired.target[2] + oz],
        lotBounds()
      );
    }
    wake();
  }

  function onPointerUp(event) {
    pointers.delete(event.pointerId);
    if (event.button === dragButton || pointers.size === 0) dragButton = -1;
    domElement.releasePointerCapture?.(event.pointerId);
  }

  function onWheel(event) {
    event.preventDefault();
    if (mode === "free") return;

    // §12.1: zoom toward the cursor. Shift the target a fraction of the way
    // toward where the pointer is aiming, proportional to how much closer the
    // zoom brings us, so the point under the cursor stays roughly put.
    const before = desired.distance;
    desired.distance = zoomDistance(desired.distance, event.deltaY);
    const shrink = 1 - desired.distance / before;
    if (Math.abs(shrink) > 1e-4) {
      const rect = domElement.getBoundingClientRect ? domElement.getBoundingClientRect() : { left: 0, top: 0, width: 1, height: 1 };
      const nx = ((event.clientX - rect.left) / (rect.width || 1)) * 2 - 1;
      const ny = ((event.clientY - rect.top) / (rect.height || 1)) * 2 - 1;
      const reach = before * Math.tan((camera.fov * Math.PI) / 360);
      const [ox, oz] = panOffset(-nx * reach, -ny * reach, desired.yaw, 1, 1);
      desired.target = clampTarget(
        [desired.target[0] + ox * shrink, desired.target[1], desired.target[2] + oz * shrink],
        lotBounds()
      );
    }
    wake();
  }

  function onContextMenu(event) {
    // Right-drag is the orbit gesture, so the browser menu has to stay away.
    event.preventDefault();
  }

  function onKeyDown(event) {
    if (isTextEntry(doc.activeElement)) return;
    if (event.code === "Tab") {
      // §12.1: Tab toggles free camera.
      event.preventDefault();
      toggleMode();
      return;
    }
    if (!keysDown.has(event.code)) {
      keysDown.add(event.code);
      wake();
    }
  }

  function onKeyUp(event) {
    keysDown.delete(event.code);
  }

  function onBlur() {
    // Without this a key held while the tab loses focus stays down forever and
    // the camera drifts on its own when the user comes back.
    keysDown.clear();
  }

  /* ---------------------------------------------------------------------
   * Per-frame
   * ------------------------------------------------------------------ */

  function applyKeys(dt) {
    if (!keysDown.size) return false;
    if (isTextEntry(doc.activeElement)) return false;
    let moved = false;

    if (mode === "free") {
      const forward = [Math.sin(free.yaw) * Math.cos(free.pitch), Math.sin(free.pitch), Math.cos(free.yaw) * Math.cos(free.pitch)];
      const right = [Math.cos(free.yaw), 0, -Math.sin(free.yaw)];
      const step = FLY_SPEED * dt;
      const move = (vec, sign) => {
        free.position[0] += vec[0] * step * sign;
        free.position[1] += vec[1] * step * sign;
        free.position[2] += vec[2] * step * sign;
        moved = true;
      };
      if (keysDown.has("KeyW")) move(forward, -1);
      if (keysDown.has("KeyS")) move(forward, 1);
      if (keysDown.has("KeyA")) move(right, -1);
      if (keysDown.has("KeyD")) move(right, 1);
      if (keysDown.has("Space")) move([0, 1, 0], 1);
      if (keysDown.has("KeyC")) move([0, 1, 0], -1);
      return moved;
    }

    // §12.1 build camera: WASD and arrows pan, Q/E rotate, Z/X zoom.
    const pan = KEY_PAN_RATE * desired.distance * dt;
    let dx = 0;
    let dz = 0;
    if (keysDown.has("KeyW") || keysDown.has("ArrowUp")) dz -= 1;
    if (keysDown.has("KeyS") || keysDown.has("ArrowDown")) dz += 1;
    if (keysDown.has("KeyA") || keysDown.has("ArrowLeft")) dx -= 1;
    if (keysDown.has("KeyD") || keysDown.has("ArrowRight")) dx += 1;
    if (dx || dz) {
      const cos = Math.cos(desired.yaw);
      const sin = Math.sin(desired.yaw);
      desired.target = clampTarget(
        [
          desired.target[0] + (dx * cos + dz * sin) * pan,
          desired.target[1],
          desired.target[2] + (-dx * sin + dz * cos) * pan,
        ],
        lotBounds()
      );
      moved = true;
    }
    if (keysDown.has("KeyQ")) {
      desired.yaw = wrapAngle(desired.yaw + KEY_ROTATE_RATE * dt);
      moved = true;
    }
    if (keysDown.has("KeyE")) {
      desired.yaw = wrapAngle(desired.yaw - KEY_ROTATE_RATE * dt);
      moved = true;
    }
    if (keysDown.has("KeyZ")) {
      desired.distance = clampDistance(desired.distance / (1 + KEY_ZOOM_RATE * dt));
      moved = true;
    }
    if (keysDown.has("KeyX")) {
      desired.distance = clampDistance(desired.distance * (1 + KEY_ZOOM_RATE * dt));
      moved = true;
    }
    return moved;
  }

  function stepSpring(dt) {
    let moving = false;

    for (let axis = 0; axis < 3; axis += 1) {
      const step = springStep(current.target[axis], desired.target[axis], velocity.target[axis], dt);
      current.target[axis] = step.value;
      velocity.target[axis] = step.velocity;
      if (!atRest(current.target[axis], desired.target[axis], velocity.target[axis])) moving = true;
    }

    // Yaw springs along the short way round, then is re-wrapped.
    const yawDelta = wrapAngle(desired.yaw - current.yaw);
    const yawStep = springStep(0, yawDelta, velocity.yaw, dt);
    current.yaw = wrapAngle(current.yaw + yawStep.value);
    velocity.yaw = yawStep.velocity;
    if (!atRest(yawStep.value, yawDelta, velocity.yaw)) moving = true;

    const pitchStep = springStep(current.pitch, desired.pitch, velocity.pitch, dt);
    current.pitch = pitchStep.value;
    velocity.pitch = pitchStep.velocity;
    if (!atRest(current.pitch, desired.pitch, velocity.pitch)) moving = true;

    const distanceStep = springStep(current.distance, desired.distance, velocity.distance, dt);
    current.distance = distanceStep.value;
    velocity.distance = distanceStep.velocity;
    if (!atRest(current.distance, desired.distance, velocity.distance)) moving = true;

    if (!moving) {
      // Snap to the target so a fraction of a millimetre does not sit around
      // forever, and zero the velocities so the next wake starts clean.
      current.target = desired.target.slice();
      current.yaw = desired.yaw;
      current.pitch = desired.pitch;
      current.distance = desired.distance;
      velocity.target = [0, 0, 0];
      velocity.yaw = 0;
      velocity.pitch = 0;
      velocity.distance = 0;
    }
    return moving;
  }

  function writeCamera() {
    if (mode === "free") {
      camera.position.set(free.position[0], free.position[1], free.position[2]);
      const cosPitch = Math.cos(free.pitch);
      camera.lookAt(
        free.position[0] - Math.sin(free.yaw) * cosPitch,
        free.position[1] + Math.sin(free.pitch),
        free.position[2] - Math.cos(free.yaw) * cosPitch
      );
      return;
    }
    const [x, y, z] = orbitPosition(current.target, current.yaw, current.pitch, current.distance);
    camera.position.set(x, y, z);
    camera.lookAt(current.target[0], current.target[1], current.target[2]);
  }

  /**
   * Advance the camera one frame. Called from the renderer's before-render
   * hook, and it is the only thing that decides whether another frame is owed.
   * @param {number} nowMs
   */
  function update(nowMs) {
    const dt = lastTime === null ? 1 / 60 : Math.min((nowMs - lastTime) / 1000, 0.1);
    lastTime = nowMs;

    const keyMoved = applyKeys(dt);
    const springMoving = mode === "free" ? false : stepSpring(dt);
    writeCamera();

    const busy = keyMoved || springMoving;
    settled = !busy;
    // This is the whole of render-on-demand for the camera: ask for another
    // frame only while something is actually still moving.
    if (busy) requestRender();
    return busy;
  }

  function toggleMode() {
    if (mode === "build") {
      const [x, y, z] = orbitPosition(current.target, current.yaw, current.pitch, current.distance);
      free.position = [x, y, z];
      free.yaw = wrapAngle(current.yaw + Math.PI);
      free.pitch = -current.pitch;
      mode = "free";
    } else {
      mode = "build";
    }
    wake();
    return mode;
  }

  /** Write the camera back into the §6 document shape, for saving. */
  function toDocument() {
    return {
      target: desired.target.slice(),
      distance: desired.distance,
      yaw: desired.yaw,
      pitch: desired.pitch,
    };
  }

  /** Adopt a §6 `camera` block, e.g. after loading a build. */
  function fromDocument(block) {
    desired.target = clampTarget((block.target || [0, 0, 0]).slice(), lotBounds());
    desired.yaw = Number(block.yaw) || 0;
    desired.pitch = clampPitch(block.pitch);
    desired.distance = clampDistance(block.distance);
    wake();
  }

  const listeners = [
    [domElement, "pointerdown", onPointerDown],
    [domElement, "pointermove", onPointerMove],
    [domElement, "pointerup", onPointerUp],
    [domElement, "pointercancel", onPointerUp],
    [domElement, "wheel", onWheel, { passive: false }],
    [domElement, "contextmenu", onContextMenu],
    [win, "keydown", onKeyDown],
    [win, "keyup", onKeyUp],
    [win, "blur", onBlur],
  ];
  for (const [target, type, handler, opts] of listeners) target.addEventListener(type, handler, opts);

  return {
    update,
    toggleMode,
    toDocument,
    fromDocument,
    get mode() {
      return mode;
    },
    get settled() {
      return settled;
    },
    /** Live values, for the grid's distance and pitch response. */
    get state() {
      return { ...current, target: current.target.slice() };
    },
    get desired() {
      return { ...desired, target: desired.target.slice() };
    },
    limits: { MIN_DISTANCE, MAX_DISTANCE },
    dispose() {
      for (const [target, type, handler] of listeners) target.removeEventListener(type, handler);
      keysDown.clear();
      pointers.clear();
    },
  };
}
