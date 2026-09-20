import { describe, it, expect, vi } from "vitest";
import { createStore } from "../src/client/core/store.js";
import { createCommandBus } from "../src/client/core/commands.js";
import { createBuildDocument, serialize } from "../src/client/core/document.js";
import { SetLevelProps, SetEnvironment } from "../src/client/core/build-commands.js";

function harness({ limit } = {}) {
  const doc = createBuildDocument({ lotSize: [20, 15], now: "2026-01-01T00:00:00Z" });
  const store = createStore(doc);
  const commands = createCommandBus({ store, limit });
  return { store, commands, doc };
}

/**
 * A minimal undoable command over one path, for testing the bus itself.
 *
 * It restores from the shallowest path segment that did not exist before the
 * write, because `setIn` creates intermediate objects on the way down: writing
 * `rooms.r_1.name` into an empty `rooms` creates `r_1` too, and an undo that
 * only removes `name` leaves an empty room behind. Every real `Add*` command
 * has the same obligation.
 */
function SetValue(path, value, { type = "SetValue", label = `Set ${path}`, mergeable = false } = {}) {
  let previous;
  let createdAt = null;

  const cmd = {
    type,
    label,
    do(store) {
      const segments = String(path).split(".");
      createdAt = null;
      for (let i = 1; i <= segments.length; i += 1) {
        const prefix = segments.slice(0, i).join(".");
        if (store.get(prefix) === undefined) {
          createdAt = prefix;
          break;
        }
      }
      previous = store.get(path);
      store.setIn(path, value);
    },
    undo(store) {
      // Restoring "there was nothing here" is a delete, not a write of
      // undefined — that is the difference the store now enforces.
      if (createdAt) store.deleteIn(createdAt);
      else store.setIn(path, previous);
    },
  };
  if (mergeable) cmd.merge = (next) => next.type === type;
  return cmd;
}

/** Deterministic RNG so a failing randomized run reproduces exactly. */
function rng(seed) {
  let state = seed >>> 0;
  return () => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    state >>>= 0;
    return state / 0x100000000;
  };
}

describe("undo symmetry (§18)", () => {
  it("SetLevelProps: do then undo returns the original document", () => {
    const { store, commands } = harness();
    const before = store.getDocument();

    commands.run(SetLevelProps(0, { wallHeight: 4.2, index: 0 }));
    expect(store.get("levels.0.wallHeight")).toBe(4.2);

    commands.undo();
    expect(store.getDocument()).toEqual(before);
  });

  it("SetEnvironment is asymmetric on purpose: recorded, never undone", () => {
    // §7 marks it "not undoable, but recorded", so do-then-undo deliberately
    // does NOT return the original. Asserting that keeps the exception explicit
    // instead of looking like a symmetry bug later.
    const { store, commands } = harness();
    const before = store.getDocument();

    commands.run(SetEnvironment({ timeOfDay: 9 }));
    commands.undo();

    expect(store.get("lot.environment.timeOfDay")).toBe(9);
    expect(store.getDocument()).not.toEqual(before);
  });

  it("survives 200 randomized runs and unwinds to the original, byte for byte", () => {
    const { store, commands } = harness({ limit: 1000 });
    const original = store.getDocument();
    const originalJson = serialize(original);
    const random = rng(0xC0FFEE);

    const paths = [
      "levels.0.wallHeight",
      "levels.0.foundation.height",
      "levels.0.foundation.type",
      "levels.0.walls.w_1",
      "levels.0.nodes.n_a",
      "levels.0.rooms.r_1.name",
      "levels.0.floorTiles.2,3",
      "roofs.rf_1.pitchDeg",
      "objects.o_1.rotY",
      "camera.yaw",
      "meta.name",
      "lot.terrain.resolution",
    ];

    const snapshots = [original];
    const ran = [];
    for (let i = 0; i < 200; i += 1) {
      const path = paths[Math.floor(random() * paths.length)];
      const value = random() < 0.2 ? null : Math.round(random() * 1000) / 10;
      // null is a real §6 value (an unset tint, an inherited wall height); it is
      // not the same as the key being absent, which is what deleteIn covers.
      const cmd = i % 7 === 0
        ? SetLevelProps(0, { wallHeight: 2 + random() * 3 })
        : SetValue(path, value, { type: `T${i % 5}` });
      commands.run(cmd);
      ran.push(cmd);
      snapshots.push(store.getDocument());
    }

    // Unwind one step at a time, checking every intermediate state, so a
    // failure names the command that broke rather than just the end result.
    for (let i = ran.length - 1; i >= 0; i -= 1) {
      expect(commands.undo()).toBe(true);
      expect(store.getDocument(), `after undoing #${i} (${ran[i].type})`).toEqual(snapshots[i]);
    }
    expect(serialize(store.getDocument())).toBe(originalJson);
    expect(commands.undo()).toBe(false);
  });
});

describe("redo", () => {
  it("restores the exact post-do document", () => {
    const { store, commands } = harness();
    commands.run(SetLevelProps(0, { wallHeight: 4.2 }));
    const afterDo = store.getDocument();

    commands.undo();
    commands.redo();

    expect(store.getDocument()).toEqual(afterDo);
  });

  it("replays a whole randomized sequence forwards again", () => {
    const { store, commands } = harness();
    const random = rng(7);
    for (let i = 0; i < 25; i += 1) {
      commands.run(SetValue("camera.yaw", random(), { type: `R${i}` }));
    }
    const top = store.getDocument();

    for (let i = 0; i < 25; i += 1) commands.undo();
    for (let i = 0; i < 25; i += 1) commands.redo();

    expect(store.getDocument()).toEqual(top);
  });

  it("run after undo clears the redo stack", () => {
    const { store, commands } = harness();
    commands.run(SetValue("meta.name", "a", { type: "A" }));
    commands.run(SetValue("meta.name", "b", { type: "B" }));
    commands.undo();
    expect(commands.canRedo()).toBe(true);

    commands.run(SetValue("meta.name", "c", { type: "C" }));

    expect(commands.canRedo()).toBe(false);
    expect(commands.redo()).toBe(false);
    expect(store.get("meta.name")).toBe("c");
  });
});

describe("validation", () => {
  it("rejects a non-command", () => {
    const { commands } = harness();
    for (const bad of [null, {}, { do: 1 }, "cmd"]) {
      expect(() => commands.run(bad), JSON.stringify(bad)).toThrow(/expected a Command/);
    }
  });

  it("requires a label for the history panel", () => {
    const { commands } = harness();
    expect(() => commands.run({ type: "X", do() {}, undo() {} })).toThrow(/needs a label/);
  });

  it("requires undo(), or undoable: false as a deliberate opt-out", () => {
    const { commands } = harness();
    expect(() => commands.run({ type: "X", label: "X", do() {} })).toThrow(/undoable: false/);
    expect(() => commands.run({ type: "X", label: "X", undoable: false, do() {} })).not.toThrow();
  });
});

describe("a command whose do throws", () => {
  it("leaves the store exactly as it was and is absent from history", () => {
    const { store, commands } = harness();
    commands.run(SetValue("meta.name", "good", { type: "Good", label: "Good" }));
    const before = store.getDocument();

    const bad = {
      type: "Bad",
      label: "Bad",
      do(s) {
        s.setIn("meta.name", "partial");
        s.setIn("camera.yaw", 99);
        throw new Error("half way through");
      },
      undo() {},
    };

    expect(() => commands.run(bad)).toThrow("half way through");
    expect(store.getDocument()).toEqual(before);
    expect(store.get("meta.name")).toBe("good");
    expect(commands.history().map((h) => h.type)).toEqual(["Good"]);
  });

  it("does not emit a change event for the failed attempt", () => {
    const { store, commands } = harness();
    const listener = vi.fn();
    store.on("change", listener);
    expect(() =>
      commands.run({ type: "Bad", label: "Bad", do(s) { s.setIn("meta.name", "x"); throw new Error("no"); }, undo() {} })
    ).toThrow();
    expect(listener).not.toHaveBeenCalled();
  });

  it("leaves undo working on what came before", () => {
    const { store, commands } = harness();
    const original = store.getDocument();
    commands.run(SetValue("meta.name", "good", { type: "Good" }));
    expect(() =>
      commands.run({ type: "Bad", label: "Bad", do() { throw new Error("no"); }, undo() {} })
    ).toThrow();

    commands.undo();
    expect(store.getDocument()).toEqual(original);
  });
});

describe("groups (§7)", () => {
  it("collapses N commands into one undo step with the group's label", () => {
    const { store, commands } = harness();
    const original = store.getDocument();

    commands.group("Painted 4 walls", () => {
      for (let i = 1; i <= 4; i += 1) {
        commands.run(SetValue(`levels.0.walls.w_${i}`, { kind: "full" }, { type: "Paint" }));
      }
    });

    expect(commands.history()).toEqual([{ label: "Painted 4 walls", type: "Group", undoable: true }]);
    expect(commands.undo()).toBe(true);
    expect(store.getDocument()).toEqual(original);
  });

  it("nested groups collapse to the outermost label", () => {
    const { store, commands } = harness();
    const original = store.getDocument();

    commands.group("Outer", () => {
      commands.run(SetValue("meta.name", "a", { type: "A" }));
      commands.group("Inner", () => {
        commands.run(SetValue("camera.yaw", 1, { type: "B" }));
        commands.group("Innermost", () => {
          commands.run(SetValue("camera.pitch", 2, { type: "C" }));
        });
      });
    });

    expect(commands.history()).toEqual([{ label: "Outer", type: "Group", undoable: true }]);
    commands.undo();
    expect(store.getDocument()).toEqual(original);
  });

  it("redo replays a group in forward order", () => {
    const { store, commands } = harness();
    commands.group("Two steps", () => {
      commands.run(SetValue("meta.name", "first", { type: "A" }));
      commands.run(SetValue("meta.name", "second", { type: "B" }));
    });
    const afterGroup = store.getDocument();

    commands.undo();
    commands.redo();

    expect(store.getDocument()).toEqual(afterGroup);
    expect(store.get("meta.name")).toBe("second");
  });

  it("an empty group records nothing", () => {
    const { commands } = harness();
    commands.group("Nothing happened", () => {});
    expect(commands.history()).toEqual([]);
  });

  it("a group whose body throws rolls back what it already did", () => {
    const { store, commands } = harness();
    const original = store.getDocument();

    expect(() =>
      commands.group("Half a group", () => {
        commands.run(SetValue("meta.name", "one", { type: "A" }));
        commands.run(SetValue("camera.yaw", 5, { type: "B" }));
        throw new Error("tool aborted");
      })
    ).toThrow("tool aborted");

    expect(store.getDocument()).toEqual(original);
    expect(commands.history()).toEqual([]);
  });

  it("passes the body's return value through", () => {
    const { commands } = harness();
    expect(commands.group("G", () => 42)).toBe(42);
  });

  it("rejects a missing label or body", () => {
    const { commands } = harness();
    expect(() => commands.group("", () => {})).toThrow(/needs a label/);
    expect(() => commands.group("G", null)).toThrow(/needs a function/);
  });
});

describe("merging (§7)", () => {
  it("folds into the immediately previous command without pushing", () => {
    const { store, commands } = harness();
    const original = store.getDocument();

    commands.run(SetValue("lot.terrain.heights", "a", { type: "TerrainSculpt", mergeable: true }));
    commands.run(SetValue("lot.terrain.heights", "b", { type: "TerrainSculpt", mergeable: true }));
    commands.run(SetValue("lot.terrain.heights", "c", { type: "TerrainSculpt", mergeable: true }));

    expect(commands.history()).toHaveLength(1);
    expect(store.get("lot.terrain.heights")).toBe("c");

    // One undo unwinds the whole stroke, back to before the first stroke command.
    commands.undo();
    expect(store.getDocument()).toEqual(original);
  });

  it("does not merge across an intervening command", () => {
    const { commands } = harness();
    commands.run(SetValue("lot.terrain.heights", "a", { type: "Stroke", mergeable: true }));
    commands.run(SetValue("meta.name", "interruption", { type: "Other" }));
    commands.run(SetValue("lot.terrain.heights", "b", { type: "Stroke", mergeable: true }));

    expect(commands.history().map((h) => h.type)).toEqual(["Stroke", "Other", "Stroke"]);
  });

  it("does not merge across a group boundary", () => {
    const { commands } = harness();
    commands.run(SetValue("lot.terrain.heights", "a", { type: "Stroke", mergeable: true }));
    commands.group("G", () => {
      commands.run(SetValue("camera.yaw", 1, { type: "Other" }));
    });
    commands.run(SetValue("lot.terrain.heights", "b", { type: "Stroke", mergeable: true }));

    expect(commands.history().map((h) => h.type)).toEqual(["Stroke", "Group", "Stroke"]);
  });

  it("does not merge after an undo", () => {
    const { commands } = harness();
    commands.run(SetValue("lot.terrain.heights", "a", { type: "Stroke", mergeable: true }));
    commands.run(SetValue("lot.terrain.heights", "b", { type: "Stroke", mergeable: true }));
    expect(commands.history()).toHaveLength(1);

    commands.undo();
    commands.run(SetValue("lot.terrain.heights", "c", { type: "Stroke", mergeable: true }));

    expect(commands.history()).toHaveLength(1);
    expect(commands.canRedo()).toBe(false);
  });

  it("does not merge inside a group", () => {
    const { commands } = harness();
    commands.group("Stroke group", () => {
      commands.run(SetValue("lot.terrain.heights", "a", { type: "Stroke", mergeable: true }));
      commands.run(SetValue("lot.terrain.heights", "b", { type: "Stroke", mergeable: true }));
    });
    // Both are inside one undo step anyway; merging there would only confuse
    // the group's rollback order.
    expect(commands.history()).toEqual([{ label: "Stroke group", type: "Group", undoable: true }]);
  });

  it("respects a merge that declines", () => {
    const { commands } = harness();
    commands.run(SetValue("camera.yaw", 1, { type: "A", mergeable: true }));
    commands.run(SetValue("camera.yaw", 2, { type: "B", mergeable: true }));
    // A's merge only accepts type A, so B pushes.
    expect(commands.history().map((h) => h.type)).toEqual(["B", "A"]);
  });

  it("clears redo even when it merges", () => {
    const { commands } = harness();
    commands.run(SetValue("camera.yaw", 1, { type: "S", mergeable: true }));
    commands.run(SetValue("camera.yaw", 2, { type: "X" }));
    commands.undo();
    expect(commands.canRedo()).toBe(true);
    commands.run(SetValue("camera.yaw", 3, { type: "S", mergeable: true }));
    expect(commands.canRedo()).toBe(false);
  });
});

describe("the 500-entry cap (§4.1)", () => {
  it("drops the oldest entries and keeps undo working at the boundary", () => {
    const { store, commands } = harness({ limit: 10 });
    const snapshots = [store.getDocument()];
    for (let i = 0; i < 15; i += 1) {
      commands.run(SetValue("camera.yaw", i, { type: `T${i}` }));
      snapshots.push(store.getDocument());
    }

    expect(commands.history()).toHaveLength(10);
    expect(commands.history()[0].type).toBe("T14");
    expect(commands.history()[9].type).toBe("T5");

    // All ten survivors undo cleanly, back to the state after T4.
    for (let i = 0; i < 10; i += 1) expect(commands.undo()).toBe(true);
    expect(store.getDocument()).toEqual(snapshots[5]);

    // And the eleventh does nothing rather than throwing.
    expect(commands.undo()).toBe(false);
  });

  it("defaults to 500", () => {
    const { commands } = harness();
    expect(commands.limit).toBe(500);
  });
});

describe("non-undoable entries (§7 SetEnvironment)", () => {
  it("appears in history, is skipped by undo, and undo reaches past it", () => {
    const { store, commands } = harness();
    const original = store.getDocument();

    commands.run(SetLevelProps(0, { wallHeight: 4 }));
    commands.run(SetEnvironment({ timeOfDay: 9 }));

    expect(commands.history().map((h) => h.type)).toEqual(["SetEnvironment", "SetLevelProps"]);
    expect(commands.history()[0].undoable).toBe(false);

    // One undo press: passes through the environment entry and undoes the
    // level change, because the user expects something to happen.
    expect(commands.undo()).toBe(true);
    expect(store.get("levels.0.wallHeight")).toBe(original.levels[0].wallHeight);
    expect(store.get("lot.environment.timeOfDay")).toBe(9);
  });

  it("canUndo is false when only non-undoable entries remain", () => {
    const { commands } = harness();
    commands.run(SetEnvironment({ timeOfDay: 9 }));
    commands.run(SetEnvironment({ skyPreset: "overcast" }));
    expect(commands.history()).toHaveLength(2);
    expect(commands.canUndo()).toBe(false);
    expect(commands.undo()).toBe(false);
  });

  it("redo replays it", () => {
    const { store, commands } = harness();
    commands.run(SetLevelProps(0, { wallHeight: 4 }));
    commands.run(SetEnvironment({ timeOfDay: 9 }));
    commands.undo();
    commands.redo();
    expect(store.get("levels.0.wallHeight")).toBe(4);
  });
});

describe("history and clear", () => {
  it("lists labels newest first", () => {
    const { commands } = harness();
    commands.run(SetValue("meta.name", "a", { type: "A", label: "Did A" }));
    commands.run(SetValue("meta.name", "b", { type: "B", label: "Did B" }));
    expect(commands.history().map((h) => h.label)).toEqual(["Did B", "Did A"]);
  });

  it("clear empties both stacks", () => {
    const { commands } = harness();
    commands.run(SetValue("meta.name", "a", { type: "A" }));
    commands.undo();
    commands.clear();
    expect(commands.history()).toEqual([]);
    expect(commands.canUndo()).toBe(false);
    expect(commands.canRedo()).toBe(false);
  });
});

describe("the bus needs a real store", () => {
  it("refuses anything without the transaction symbol", () => {
    expect(() => createCommandBus({ store: { setIn() {} } })).toThrow(/needs a store from createStore/);
  });
});

describe("the two shipped commands", () => {
  it("SetLevelProps captures previous values on every run, so redo is correct", () => {
    const { store, commands } = harness();
    const cmd = SetLevelProps(0, { wallHeight: 5 });
    commands.run(cmd);
    commands.undo();
    // Change the level by another route, then redo the original command.
    commands.run(SetValue("levels.0.wallHeight", 2.5, { type: "Other" }));
    commands.run(cmd);
    expect(store.get("levels.0.wallHeight")).toBe(5);
    commands.undo();
    expect(store.get("levels.0.wallHeight")).toBe(2.5);
  });

  it("SetLevelProps labels one and many properties differently", () => {
    expect(SetLevelProps(0, { wallHeight: 3 }).label).toBe("Changed level wallHeight");
    expect(SetLevelProps(0, { wallHeight: 3, index: 0 }).label).toBe("Changed 2 level properties");
  });

  it("SetLevelProps refuses an index that has no level", () => {
    const { commands } = harness();
    expect(() => commands.run(SetLevelProps(4, { wallHeight: 3 }))).toThrow(/no level at index 4/);
  });

  it("both refuse an empty property set", () => {
    expect(() => SetLevelProps(0, {})).toThrow(/no properties/);
    expect(() => SetEnvironment({})).toThrow(/no properties/);
  });

  it("SetEnvironment writes every key in the patch", () => {
    const { store, commands } = harness();
    commands.run(SetEnvironment({ timeOfDay: 6.25, skyPreset: "overcast" }));
    expect(store.get("lot.environment.timeOfDay")).toBe(6.25);
    expect(store.get("lot.environment.skyPreset")).toBe("overcast");
    expect(store.get("lot.environment.season")).toBe("summer");
  });
});
