// Render on demand and the adaptive pixel ratio (SPEC §4.2).
//
// Both live here, apart from the renderer, because both are pure scheduling
// logic and both are the kind of thing that is easy to get subtly wrong and
// impossible to notice: a loop that never stops looks identical to one that
// does, until a laptop battery runs out.
//
// Ticket 001 deferred render-on-demand to "the real engine in Phase 1". This
// is it.

/**
 * A frame scheduler that renders only when asked.
 *
 * Repeated `requestRender()` calls inside one frame coalesce into a single
 * render — a command that writes a dozen paths draws once, not a dozen times.
 *
 * @param {{requestFrame: function(Function): number,
 *          cancelFrame: function(number): void,
 *          render: function(number): void,
 *          now?: function(): number}} deps
 */
export function createRenderScheduler(deps) {
  const { requestFrame, cancelFrame, render, now = () => 0 } = deps;

  let handle = 0;
  let renderCount = 0;
  let requestCount = 0;
  let disposed = false;
  let lastFrameMs = 0;
  const frameListeners = new Set();

  function frame() {
    handle = 0;
    if (disposed) return;
    const started = now();
    render(started);
    renderCount += 1;
    lastFrameMs = now() - started;
    for (const listener of Array.from(frameListeners)) listener(lastFrameMs, now());
  }

  /** Schedule one frame. Safe to call as often as you like. */
  function requestRender() {
    if (disposed) return false;
    requestCount += 1;
    if (handle) return false;
    handle = requestFrame(frame);
    return true;
  }

  function dispose() {
    disposed = true;
    if (handle) cancelFrame(handle);
    handle = 0;
    frameListeners.clear();
  }

  return {
    requestRender,
    dispose,
    /** Notified with (frameMs, nowMs) after every frame. */
    onFrame(listener) {
      frameListeners.add(listener);
      return () => frameListeners.delete(listener);
    },
    /** Frames actually drawn. The render-on-demand acceptance check reads this. */
    get renderCount() {
      return renderCount;
    },
    /** Calls to requestRender, including the coalesced ones. */
    get requestCount() {
      return requestCount;
    },
    get pending() {
      return handle !== 0;
    },
    get lastFrameMs() {
      return lastFrameMs;
    },
  };
}

/** Pixel ratios the governor will step down through, highest first (§4.2). */
export const PIXEL_RATIO_STEPS = Object.freeze([2, 1.5, 1.25, 1]);

/** §4.2: over 20 ms a frame, held for 2 s. */
export const SLOW_FRAME_MS = 20;
export const SLOW_FRAME_WINDOW_MS = 2000;

/**
 * Lower the pixel ratio when frames stay slow.
 *
 * One-way by design (§4.2). Raising it back on a brief recovery produces a
 * picture that flickers between resolutions on a machine that is genuinely at
 * its limit, which reads as a bug rather than as adaptation. A preset change
 * resets it, and that is the only way back up.
 *
 * @param {{cap: number, current?: number, onChange?: function(number): void}} options
 */
export function createPixelRatioGovernor(options) {
  const { cap, current = cap, onChange = () => {} } = options;

  let ratio = Math.min(current, cap);
  let slowSince = null;

  /**
   * Feed one frame's duration.
   * @param {number} frameMs
   * @param {number} nowMs
   * @returns {boolean} whether the ratio was lowered
   */
  function sample(frameMs, nowMs) {
    if (frameMs <= SLOW_FRAME_MS) {
      // Any fast frame resets the window: §4.2 says *continuous*, and a
      // rolling average would let a single stutter every second drag the
      // resolution down over a long session.
      slowSince = null;
      return false;
    }
    if (slowSince === null) {
      slowSince = nowMs;
      return false;
    }
    if (nowMs - slowSince < SLOW_FRAME_WINDOW_MS) return false;

    const next = nextStepDown(ratio);
    slowSince = null;
    if (next === null) return false;
    ratio = next;
    onChange(ratio);
    return true;
  }

  /** Back to the cap. Called on a preset change, and nowhere else. */
  function reset(nextCap = cap) {
    slowSince = null;
    ratio = Math.min(nextCap, nextCap);
    onChange(ratio);
    return ratio;
  }

  return {
    sample,
    reset,
    get ratio() {
      return ratio;
    },
    get watching() {
      return slowSince !== null;
    },
  };
}

/**
 * Pure. The next step below `ratio`, or null when already at the floor.
 * @param {number} ratio
 * @returns {?number}
 */
export function nextStepDown(ratio) {
  for (const step of PIXEL_RATIO_STEPS) {
    if (step < ratio - 1e-6) return step;
  }
  return null;
}
