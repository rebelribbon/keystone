import { describe, it, expect, vi } from "vitest";
import {
  createRenderScheduler,
  createPixelRatioGovernor,
  nextStepDown,
  PIXEL_RATIO_STEPS,
  SLOW_FRAME_MS,
  SLOW_FRAME_WINDOW_MS,
} from "../src/client/engine/scheduler.js";

/** A hand-cranked animation frame queue, so frames happen when tests say so. */
function fakeFrames() {
  let nextHandle = 1;
  const queue = new Map();
  let clock = 0;
  return {
    requestFrame(fn) {
      const handle = nextHandle++;
      queue.set(handle, fn);
      return handle;
    },
    cancelFrame(handle) {
      queue.delete(handle);
    },
    now: () => clock,
    advance(ms) {
      clock += ms;
    },
    /** Run every frame currently queued. */
    flush() {
      const pending = [...queue.entries()];
      queue.clear();
      for (const [, fn] of pending) fn();
      return pending.length;
    },
    get pending() {
      return queue.size;
    },
  };
}

describe("render on demand (§4.2)", () => {
  it("renders nothing until asked", () => {
    const frames = fakeFrames();
    const render = vi.fn();
    const scheduler = createRenderScheduler({ ...frames, render });

    frames.flush();
    expect(render).not.toHaveBeenCalled();
    expect(scheduler.renderCount).toBe(0);
  });

  it("coalesces repeated requests within one frame into a single render", () => {
    // This is the §4.2 rule in one assertion: a command writing a dozen paths
    // draws once.
    const frames = fakeFrames();
    const render = vi.fn();
    const scheduler = createRenderScheduler({ ...frames, render });

    expect(scheduler.requestRender()).toBe(true);
    expect(scheduler.requestRender()).toBe(false);
    expect(scheduler.requestRender()).toBe(false);
    expect(frames.pending).toBe(1);

    frames.flush();
    expect(render).toHaveBeenCalledTimes(1);
    expect(scheduler.renderCount).toBe(1);
    expect(scheduler.requestCount).toBe(3);
  });

  it("schedules again after the frame runs", () => {
    const frames = fakeFrames();
    const scheduler = createRenderScheduler({ ...frames, render: () => {} });

    scheduler.requestRender();
    frames.flush();
    expect(scheduler.pending).toBe(false);

    scheduler.requestRender();
    expect(scheduler.pending).toBe(true);
    frames.flush();
    expect(scheduler.renderCount).toBe(2);
  });

  it("stops scheduling once nothing asks — no hidden loop", () => {
    const frames = fakeFrames();
    const scheduler = createRenderScheduler({ ...frames, render: () => {} });

    scheduler.requestRender();
    frames.flush();

    // Ten more animation frames with nobody asking.
    for (let i = 0; i < 10; i += 1) {
      frames.advance(16);
      expect(frames.flush()).toBe(0);
    }
    expect(scheduler.renderCount).toBe(1);
  });

  it("reports the frame duration to listeners", () => {
    const frames = fakeFrames();
    const seen = [];
    const scheduler = createRenderScheduler({
      ...frames,
      render: () => frames.advance(9),
    });
    scheduler.onFrame((frameMs) => seen.push(frameMs));

    scheduler.requestRender();
    frames.flush();
    expect(seen).toEqual([9]);
    expect(scheduler.lastFrameMs).toBe(9);
  });

  it("renders nothing after dispose", () => {
    const frames = fakeFrames();
    const render = vi.fn();
    const scheduler = createRenderScheduler({ ...frames, render });

    scheduler.requestRender();
    scheduler.dispose();
    frames.flush();

    expect(render).not.toHaveBeenCalled();
    expect(scheduler.requestRender()).toBe(false);
  });
});

describe("adaptive pixel ratio (§4.2)", () => {
  it("does not lower at 15 ms", () => {
    const onChange = vi.fn();
    const governor = createPixelRatioGovernor({ cap: 2, onChange });
    for (let t = 0; t < 6000; t += 15) governor.sample(15, t);
    expect(onChange).not.toHaveBeenCalled();
    expect(governor.ratio).toBe(2);
  });

  it("lowers one step after 25 ms frames held for 2 s", () => {
    const onChange = vi.fn();
    const governor = createPixelRatioGovernor({ cap: 2, onChange });

    let t = 0;
    for (; t < SLOW_FRAME_WINDOW_MS; t += 25) {
      expect(governor.sample(25, t), `at ${t}ms`).toBe(false);
    }
    expect(governor.watching).toBe(true);
    expect(governor.sample(25, t)).toBe(true);

    expect(governor.ratio).toBe(1.5);
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenCalledWith(1.5);
  });

  it("needs the slow window to be continuous", () => {
    // §4.2 says 2 continuous seconds. One fast frame resets the clock, or a
    // single stutter a second would grind the resolution down over a long
    // session on a machine that is coping fine.
    const governor = createPixelRatioGovernor({ cap: 2 });
    let t = 0;
    for (let i = 0; i < 200; i += 1) {
      governor.sample(25, t);
      t += 25;
      governor.sample(10, t);
      t += 10;
    }
    expect(governor.ratio).toBe(2);
  });

  it("steps down through the ladder and stops at the floor", () => {
    const governor = createPixelRatioGovernor({ cap: 2 });
    let t = 0;
    const holdSlow = () => {
      for (let i = 0; i <= SLOW_FRAME_WINDOW_MS + 100; i += 25) {
        governor.sample(30, t);
        t += 25;
      }
    };
    const seen = [governor.ratio];
    for (let i = 0; i < 6; i += 1) {
      holdSlow();
      seen.push(governor.ratio);
    }
    expect(seen[0]).toBe(2);
    expect(governor.ratio).toBe(1);
    expect(nextStepDown(1)).toBe(null);
  });

  it("never raises itself back on its own (§4.2)", () => {
    const governor = createPixelRatioGovernor({ cap: 2 });
    let t = 0;
    for (let i = 0; i <= SLOW_FRAME_WINDOW_MS + 100; i += 25) {
      governor.sample(30, t);
      t += 25;
    }
    expect(governor.ratio).toBe(1.5);

    for (let i = 0; i < 1000; i += 1) {
      governor.sample(4, t);
      t += 4;
    }
    expect(governor.ratio).toBe(1.5);
  });

  it("a preset change is the only way back up", () => {
    const onChange = vi.fn();
    const governor = createPixelRatioGovernor({ cap: 2, onChange });
    let t = 0;
    for (let i = 0; i <= SLOW_FRAME_WINDOW_MS + 100; i += 25) {
      governor.sample(30, t);
      t += 25;
    }
    expect(governor.ratio).toBe(1.5);

    governor.reset(2);
    expect(governor.ratio).toBe(2);
    expect(onChange).toHaveBeenLastCalledWith(2);
  });

  it("starts no higher than the preset's cap", () => {
    const governor = createPixelRatioGovernor({ cap: 1, current: 3 });
    expect(governor.ratio).toBe(1);
  });

  it("nextStepDown walks the documented ladder", () => {
    expect(PIXEL_RATIO_STEPS).toEqual([2, 1.5, 1.25, 1]);
    expect(nextStepDown(2)).toBe(1.5);
    expect(nextStepDown(1.5)).toBe(1.25);
    expect(nextStepDown(1.25)).toBe(1);
    expect(nextStepDown(3)).toBe(2);
    expect(SLOW_FRAME_MS).toBe(20);
  });
});
