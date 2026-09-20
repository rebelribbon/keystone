import { describe, it, expect, vi } from "vitest";
import {
  createStore,
  TRANSACT,
  CATEGORIES,
  categoryForPath,
  idsForPath,
  normalizePath,
  setPath,
} from "../src/client/core/store.js";
import { createBuildDocument } from "../src/client/core/document.js";

/** A store plus the transaction opener, which only commands.js normally holds. */
function harness(doc = createBuildDocument({ lotSize: [20, 15], now: "2026-01-01T00:00:00Z" })) {
  const store = createStore(doc);
  return { store, doc, transact: store[TRANSACT] };
}

describe("path helpers", () => {
  it("normalizes dotted and array paths, numbering indices", () => {
    expect(normalizePath("levels.0.walls.w_1")).toEqual(["levels", 0, "walls", "w_1"]);
    expect(normalizePath(["levels", 0, "walls", "w_1"])).toEqual(["levels", 0, "walls", "w_1"]);
    expect(normalizePath("meta.name")).toEqual(["meta", "name"]);
  });

  it("rejects an empty or malformed path", () => {
    for (const bad of ["", [], ["a", ""], null, ["a", null]]) {
      expect(() => normalizePath(bad), JSON.stringify(bad)).toThrow(/usable path/);
    }
  });

  it("setPath shares every untouched subtree", () => {
    const root = { a: { x: 1 }, b: { y: 2 } };
    const next = setPath(root, ["a", "x"], 9);
    expect(next.a.x).toBe(9);
    expect(next.b).toBe(root.b);
    expect(root.a.x).toBe(1);
  });
});

describe("dirty categories (§4.1)", () => {
  // The whole point of deriving rather than declaring: these stay right when
  // someone copies a setIn line into a different command.
  const cases = [
    ["meta.name", "meta"],
    ["camera.yaw", "camera"],
    ["lot.environment.timeOfDay", "environment"],
    ["lot.terrain.heights", "terrain"],
    ["lot.terrain.paint.splat", "terrain"],
    ["lot.size", "terrain"],
    ["levels.0.wallHeight", "levels"],
    ["levels.0.foundation.height", "levels"],
    ["levels.0.nodes.n_a", "nodes"],
    ["levels.0.walls.w_1", "walls"],
    ["levels.0.walls.w_1.sideLeft.tint", "walls"],
    ["levels.0.rooms.r_1.name", "rooms"],
    ["levels.0.floorTiles.3,4", "floorTiles"],
    ["levels.0.openings.op_1.t", "openings"],
    ["levels.0.trim.frieze", "levels"],
    ["roofs.rf_1.pitchDeg", "roofs"],
    ["objects.o_1.rotY", "objects"],
    ["paths.p_1", "objects"],
    ["pools.pl_1", "objects"],
    ["schema", "meta"],
  ];

  for (const [path, expected] of cases) {
    it(`${path} → ${expected}`, () => {
      expect(categoryForPath(normalizePath(path))).toBe(expected);
    });
  }

  it("a nested wall write is walls, not levels", () => {
    // Named separately because it is the case that makes the rule worth having:
    // rebuilding a whole level for one wall edit is the §4.2 performance bug.
    expect(categoryForPath(normalizePath("levels.0.walls.w_1"))).toBe("walls");
  });

  it("only ever emits names from the fixed list", () => {
    for (const [path] of cases) {
      expect(CATEGORIES).toContain(categoryForPath(normalizePath(path)));
    }
  });

  it("throws on a path with no category rather than silently dropping it", () => {
    expect(() => categoryForPath(normalizePath("gadgets.g_1"))).toThrow(/no dirty category/);
  });

  it("collects entity ids, including floor-tile keys", () => {
    expect(idsForPath(normalizePath("levels.0.walls.w_1.sideLeft.tint"))).toEqual(["w_1"]);
    expect(idsForPath(normalizePath("levels.0.floorTiles.3,4"))).toEqual(["3,4"]);
    expect(idsForPath(normalizePath("levels.0.floorTiles.-2,-7"))).toEqual(["-2,-7"]);
    expect(idsForPath(normalizePath("meta.name"))).toEqual([]);
    expect(idsForPath(normalizePath("roofs.rf_1"))).toEqual(["rf_1"]);
  });
});

describe("§0.3 is enforced, not requested", () => {
  it("a write outside a command throws", () => {
    const { store } = harness();
    expect(() => store.setIn("meta.name", "nope")).toThrow(/outside a command/);
    expect(() => store.updateIn("meta.name", () => "nope")).toThrow(/outside a command/);
  });

  it("the same write inside a transaction succeeds", () => {
    const { store, transact } = harness();
    transact(() => store.setIn("meta.name", "yes"));
    expect(store.get("meta.name")).toBe("yes");
  });

  it("the transaction opener is a symbol, not a reachable property", () => {
    const { store } = harness();
    expect(Object.keys(store)).not.toContain("transact");
    expect(JSON.stringify(Object.keys(store))).not.toMatch(/transact/i);
    expect(typeof store[TRANSACT]).toBe("function");
  });

  it("reports whether a command is running", () => {
    const { store, transact } = harness();
    expect(store.inCommand).toBe(false);
    transact(() => expect(store.inCommand).toBe(true));
    expect(store.inCommand).toBe(false);
  });
});

describe("immutability and structural sharing", () => {
  it("does not mutate the previous document", () => {
    const { store, transact } = harness();
    const before = store.getDocument();
    const beforeJson = JSON.stringify(before);

    transact(() => store.setIn("levels.0.wallHeight", 4));

    expect(JSON.stringify(before)).toBe(beforeJson);
    expect(before.levels[0].wallHeight).toBe(3.05);
    expect(store.get("levels.0.wallHeight")).toBe(4);
    expect(store.getDocument()).not.toBe(before);
  });

  it("keeps unaffected subtrees reference-identical", () => {
    const { store, transact } = harness();
    const before = store.getDocument();

    transact(() => store.setIn("levels.0.wallHeight", 4));
    const after = store.getDocument();

    // The spine is rebuilt...
    expect(after.levels).not.toBe(before.levels);
    expect(after.levels[0]).not.toBe(before.levels[0]);
    // ...and everything off it is shared, which is what lets scene sync rebuild
    // only what changed by comparing references (§4.1).
    expect(after.lot).toBe(before.lot);
    expect(after.meta).toBe(before.meta);
    expect(after.camera).toBe(before.camera);
    expect(after.levels[0].walls).toBe(before.levels[0].walls);
    expect(after.levels[0].trim).toBe(before.levels[0].trim);
  });

  it("hands out a frozen document", () => {
    const { store } = harness();
    const doc = store.getDocument();
    expect(Object.isFrozen(doc)).toBe(true);
    expect(Object.isFrozen(doc.levels[0].trim)).toBe(true);
    expect(() => {
      doc.meta.name = "mutated";
    }).toThrow();
  });

  it("updateIn reads the current value and writes the result", () => {
    const { store, transact } = harness();
    transact(() => store.updateIn("levels.0.wallHeight", (h) => h + 1));
    expect(store.get("levels.0.wallHeight")).toBeCloseTo(4.05);
  });

  it("creates missing intermediate objects", () => {
    const { store, transact } = harness();
    transact(() => store.setIn("levels.0.walls.w_new.kind", "full"));
    expect(store.get("levels.0.walls.w_new")).toEqual({ kind: "full" });
  });
});

describe("change events", () => {
  it("emits once per transaction, not once per setIn", () => {
    const { store, transact } = harness();
    const listener = vi.fn();
    store.on("change", listener);

    transact(() => {
      store.setIn("levels.0.wallHeight", 4);
      store.setIn("levels.0.foundation.height", 1);
      store.setIn("meta.name", "three writes");
    });

    expect(listener).toHaveBeenCalledTimes(1);
    const { dirtyCategories } = listener.mock.calls[0][0];
    expect([...dirtyCategories].sort()).toEqual(["levels", "meta"]);
  });

  it("collapses a nested transaction into the outer one", () => {
    const { store, transact } = harness();
    const listener = vi.fn();
    store.on("change", listener);

    transact(() => {
      store.setIn("meta.name", "outer");
      transact(() => store.setIn("camera.yaw", 1));
    });

    expect(listener).toHaveBeenCalledTimes(1);
    expect([...listener.mock.calls[0][0].dirtyCategories].sort()).toEqual(["camera", "meta"]);
  });

  it("carries the touched entity ids", () => {
    const { store, transact } = harness();
    const listener = vi.fn();
    store.on("change", listener);

    transact(() => {
      store.setIn("levels.0.walls.w_1", { kind: "full" });
      store.setIn("levels.0.walls.w_2", { kind: "half" });
    });

    expect([...listener.mock.calls[0][0].dirtyIds].sort()).toEqual(["w_1", "w_2"]);
  });

  it("emits nothing when a transaction writes nothing", () => {
    const { store, transact } = harness();
    const listener = vi.fn();
    store.on("change", listener);
    transact(() => {});
    expect(listener).not.toHaveBeenCalled();
  });

  it("emits nothing for a transaction that threw", () => {
    // The caller is about to restore the document; telling listeners about
    // changes that end up never having happened is worse than silence.
    const { store, transact } = harness();
    const listener = vi.fn();
    store.on("change", listener);

    expect(() =>
      transact(() => {
        store.setIn("meta.name", "half done");
        throw new Error("boom");
      })
    ).toThrow("boom");

    expect(listener).not.toHaveBeenCalled();
  });

  it("recovers cleanly after a thrown transaction", () => {
    const { store, transact } = harness();
    const listener = vi.fn();
    store.on("change", listener);
    expect(() => transact(() => { throw new Error("boom"); })).toThrow();
    transact(() => store.setIn("meta.name", "after"));
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it("one listener throwing does not stop the others", () => {
    const { store, transact } = harness();
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    const second = vi.fn();
    store.on("change", () => { throw new Error("bad listener"); });
    store.on("change", second);

    transact(() => store.setIn("meta.name", "x"));

    expect(second).toHaveBeenCalledTimes(1);
    errors.mockRestore();
  });

  it("off and the returned unsubscribe both work", () => {
    const { store, transact } = harness();
    const a = vi.fn();
    const b = vi.fn();
    const unsubscribe = store.on("change", a);
    store.on("change", b);

    unsubscribe();
    store.off("change", b);
    transact(() => store.setIn("meta.name", "x"));

    expect(a).not.toHaveBeenCalled();
    expect(b).not.toHaveBeenCalled();
  });

  it("rejects an unknown store event name", () => {
    const { store } = harness();
    expect(() => store.on("changed", () => {})).toThrow(/unknown event/);
  });

  it("mirrors onto an event bus as store:change", () => {
    const emit = vi.fn();
    const store = createStore(createBuildDocument(), { events: { emit } });
    store[TRANSACT](() => store.setIn("meta.name", "x"));
    expect(emit).toHaveBeenCalledWith("store:change", expect.objectContaining({ dirtyCategories: expect.any(Set) }));
  });
});

describe("replaceDocument", () => {
  it("swaps the document and reports everything dirty", () => {
    const { store } = harness();
    const listener = vi.fn();
    store.on("change", listener);
    const next = createBuildDocument({ name: "Other" });

    store.replaceDocument(next);

    expect(store.get("meta.name")).toBe("Other");
    expect([...listener.mock.calls[0][0].dirtyCategories].sort()).toEqual([...CATEGORIES].sort());
  });

  it("can restore silently", () => {
    const { store } = harness();
    const listener = vi.fn();
    store.on("change", listener);
    store.replaceDocument(createBuildDocument(), { silent: true });
    expect(listener).not.toHaveBeenCalled();
  });
});

describe("deleteIn (§7 Delete* commands, and the undo of every Add*)", () => {
  it("removes a key rather than leaving it undefined", () => {
    const { store, transact } = harness();
    transact(() => store.setIn("levels.0.walls.w_1", { kind: "full" }));
    transact(() => store.deleteIn("levels.0.walls.w_1"));

    expect(store.get("levels.0.walls")).toEqual({});
    expect(Object.keys(store.get("levels.0.walls"))).toEqual([]);
    expect("w_1" in store.get("levels.0.walls")).toBe(false);
  });

  it("setIn refuses undefined and points at deleteIn", () => {
    // Without this, an Add command's undo writes undefined, the key stays in
    // memory but disappears through JSON, and the document a builder iterates
    // stops matching the one saved to Drive.
    const { store, transact } = harness();
    expect(() => transact(() => store.setIn("levels.0.walls.w_1", undefined))).toThrow(/Use deleteIn/);
  });

  it("keeps a JSON round trip honest, which writing undefined would not", () => {
    const { store, transact } = harness();
    transact(() => store.setIn("levels.0.walls.w_1", { kind: "full" }));
    transact(() => store.deleteIn("levels.0.walls.w_1"));
    const doc = store.getDocument();
    expect(JSON.parse(JSON.stringify(doc))).toEqual(doc);
  });

  it("is a no-op on a key that is not there", () => {
    const { store, transact } = harness();
    const before = store.getDocument();
    transact(() => store.deleteIn("levels.0.walls.w_missing"));
    expect(store.getDocument()).toBe(before);
  });

  it("shares untouched subtrees like setIn does", () => {
    const { store, transact } = harness();
    transact(() => store.setIn("levels.0.walls.w_1", { kind: "full" }));
    const before = store.getDocument();
    transact(() => store.deleteIn("levels.0.walls.w_1"));
    const after = store.getDocument();
    expect(after.lot).toBe(before.lot);
    expect(after.meta).toBe(before.meta);
    expect(before.levels[0].walls.w_1).toEqual({ kind: "full" });
  });

  it("refuses to delete an array index", () => {
    // §6 arrays are data (a polygon, a lot size), not maps. Removing an index
    // renumbers everything after it, silently.
    const { store, transact } = harness();
    expect(() => transact(() => store.deleteIn("levels.0"))).toThrow(/array is data, not a map/);
  });

  it("is refused outside a command like every other write", () => {
    const { store } = harness();
    expect(() => store.deleteIn("levels.0.walls.w_1")).toThrow(/outside a command/);
  });

  it("marks the same dirty category a write to that path would", () => {
    const { store, transact } = harness();
    const listener = vi.fn();
    transact(() => store.setIn("levels.0.walls.w_1", { kind: "full" }));
    store.on("change", listener);
    transact(() => store.deleteIn("levels.0.walls.w_1"));
    expect([...listener.mock.calls[0][0].dirtyCategories]).toEqual(["walls"]);
    expect([...listener.mock.calls[0][0].dirtyIds]).toEqual(["w_1"]);
  });

  it("updateIn deletes when the updater returns undefined", () => {
    const { store, transact } = harness();
    transact(() => store.setIn("levels.0.walls.w_1", { kind: "full" }));
    transact(() => store.updateIn("levels.0.walls.w_1", () => undefined));
    expect(store.get("levels.0.walls")).toEqual({});
  });

  it("null is a value, not an absence", () => {
    // §6 uses null for "unset but present": an inherited wall height, an
    // untinted material. Conflating it with deletion would lose that.
    const { store, transact } = harness();
    transact(() => store.setIn("levels.0.walls.w_1", { height: null }));
    expect(store.get("levels.0.walls.w_1.height")).toBe(null);
    expect("height" in store.get("levels.0.walls.w_1")).toBe(true);
  });
});
