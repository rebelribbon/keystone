import { describe, it, expect, vi } from "vitest";
import { createEventBus, EVENT_NAMES } from "../src/client/core/events.js";

describe("event names (§4.1)", () => {
  it("carries the §4.1 names plus the store signal", () => {
    expect([...EVENT_NAMES].sort()).toEqual([
      "build:saved",
      "level:changed",
      "selection:changed",
      "store:change",
      "tool:changed",
      "view:changed",
    ]);
  });

  it("throws on an unknown name, on every entry point", () => {
    // The failure this replaces is silent: a typo'd name does nothing at all,
    // forever, and surfaces months later as "the panel never updates".
    const bus = createEventBus();
    expect(() => bus.emit("tool:change", {})).toThrow(/unknown event "tool:change"/);
    expect(() => bus.on("tool:change", () => {})).toThrow(/unknown event/);
    expect(() => bus.once("tool:change", () => {})).toThrow(/unknown event/);
    expect(() => bus.off("tool:change", () => {})).toThrow(/unknown event/);
  });

  it("names the known set in the error, so the fix is in the message", () => {
    const bus = createEventBus();
    expect(() => bus.emit("nope")).toThrow(/tool:changed/);
  });

  it("warns instead of throwing when strict is off", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const bus = createEventBus({ strict: false });
    expect(bus.emit("nope", {})).toBe(0);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('unknown event "nope"'));
    warn.mockRestore();
  });

  it("setStrict flips it at runtime", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const bus = createEventBus();
    expect(() => bus.emit("nope")).toThrow();
    bus.setStrict(false);
    expect(() => bus.emit("nope")).not.toThrow();
    bus.setStrict(true);
    expect(() => bus.emit("nope")).toThrow();
    warn.mockRestore();
  });
});

describe("on / off / once / emit", () => {
  it("delivers a payload to every listener", () => {
    const bus = createEventBus();
    const a = vi.fn();
    const b = vi.fn();
    bus.on("tool:changed", a);
    bus.on("tool:changed", b);

    expect(bus.emit("tool:changed", { tool: "wall" })).toBe(2);
    expect(a).toHaveBeenCalledWith({ tool: "wall" });
    expect(b).toHaveBeenCalledWith({ tool: "wall" });
  });

  it("off removes a listener, and so does the handle on returns", () => {
    const bus = createEventBus();
    const a = vi.fn();
    const b = vi.fn();
    const unsubscribe = bus.on("level:changed", a);
    bus.on("level:changed", b);

    unsubscribe();
    bus.off("level:changed", b);
    bus.emit("level:changed", {});

    expect(a).not.toHaveBeenCalled();
    expect(b).not.toHaveBeenCalled();
    expect(bus.listenerCount("level:changed")).toBe(0);
  });

  it("once fires exactly once", () => {
    const bus = createEventBus();
    const listener = vi.fn();
    bus.once("build:saved", listener);

    bus.emit("build:saved", { id: 1 });
    bus.emit("build:saved", { id: 2 });

    expect(listener).toHaveBeenCalledTimes(1);
    expect(listener).toHaveBeenCalledWith({ id: 1 });
    expect(bus.listenerCount("build:saved")).toBe(0);
  });

  it("once can be cancelled before it fires", () => {
    const bus = createEventBus();
    const listener = vi.fn();
    bus.once("build:saved", listener)();
    bus.emit("build:saved", {});
    expect(listener).not.toHaveBeenCalled();
  });

  it("a listener that throws does not stop the others", () => {
    // One broken panel must not stop the scene rebuilding.
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    const bus = createEventBus();
    const before = vi.fn();
    const after = vi.fn();

    bus.on("view:changed", before);
    bus.on("view:changed", () => { throw new Error("bad listener"); });
    bus.on("view:changed", after);

    expect(bus.emit("view:changed", {})).toBe(3);
    expect(before).toHaveBeenCalledTimes(1);
    expect(after).toHaveBeenCalledTimes(1);
    expect(errors).toHaveBeenCalled();
    errors.mockRestore();
  });

  it("a listener unsubscribing during emission does not disturb the rest", () => {
    const bus = createEventBus();
    const second = vi.fn();
    const first = () => bus.off("selection:changed", second);
    bus.on("selection:changed", first);
    bus.on("selection:changed", second);

    bus.emit("selection:changed", {});

    // The snapshot means the already-scheduled listener still runs this round...
    expect(second).toHaveBeenCalledTimes(1);
    // ...and is gone for the next.
    bus.emit("selection:changed", {});
    expect(second).toHaveBeenCalledTimes(1);
  });

  it("emitting with no listeners is a no-op", () => {
    const bus = createEventBus();
    expect(bus.emit("tool:changed", {})).toBe(0);
  });

  it("the same listener added twice runs once", () => {
    const bus = createEventBus();
    const listener = vi.fn();
    bus.on("tool:changed", listener);
    bus.on("tool:changed", listener);
    bus.emit("tool:changed", {});
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it("rejects a non-function listener", () => {
    const bus = createEventBus();
    expect(() => bus.on("tool:changed", "nope")).toThrow(/must be a function/);
    expect(() => bus.once("tool:changed", null)).toThrow(/must be a function/);
  });

  it("removeAll clears one name or all of them", () => {
    const bus = createEventBus();
    bus.on("tool:changed", () => {});
    bus.on("view:changed", () => {});

    bus.removeAll("tool:changed");
    expect(bus.listenerCount("tool:changed")).toBe(0);
    expect(bus.listenerCount("view:changed")).toBe(1);

    bus.removeAll();
    expect(bus.listenerCount("view:changed")).toBe(0);
  });

  it("takes a custom name set", () => {
    const bus = createEventBus({ names: ["a:b"] });
    expect(bus.names).toEqual(["a:b"]);
    expect(() => bus.emit("tool:changed")).toThrow(/unknown event/);
  });
});
