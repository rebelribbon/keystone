import { describe, it, expect } from "vitest";
import {
  SCHEMA_VERSION,
  ID_PREFIXES,
  newId,
  createBuildDocument,
  serialize,
  deserialize,
  base64ToBytes,
  TERRAIN_RESOLUTION,
  DEFAULT_TERRAIN_LAYERS,
} from "../src/client/core/document.js";

describe("newId", () => {
  it("carries the §6 type prefix", () => {
    for (const prefix of Object.values(ID_PREFIXES)) {
      expect(newId(prefix).startsWith(prefix)).toBe(true);
    }
  });

  it("rejects anything that is not a type prefix", () => {
    for (const bad of ["", "b", "build_", "B_", "1_", null]) {
      expect(() => newId(bad), String(bad)).toThrow(/type prefix/);
    }
  });

  it("does not collide across 20,000 ids", () => {
    // IDs must survive a save, a load, and a future merge, so a counter is not
    // an option and the only lever is entropy. 20k is a generous large build.
    const seen = new Set();
    for (let i = 0; i < 20000; i += 1) seen.add(newId("w_"));
    expect(seen.size).toBe(20000);
  });
});

describe("createBuildDocument", () => {
  const doc = createBuildDocument({
    name: "Hill Country Build 1",
    lotSize: [40, 30],
    primaryStyle: "style.spanish.texas_hill_country",
    owner: "someone@gmail.com",
    units: "imperial",
    now: "2026-09-16T15:00:00Z",
  });

  it("matches §6's top-level shape exactly", () => {
    expect(Object.keys(doc).sort()).toEqual(
      ["camera", "levels", "lot", "meta", "objects", "paths", "pools", "roofs", "schema"].sort()
    );
    expect(doc.schema).toBe(SCHEMA_VERSION);
  });

  it("fills meta per §6, with a b_ id", () => {
    expect(Object.keys(doc.meta).sort()).toEqual(
      ["created", "id", "name", "owner", "packs", "primaryStyle", "regionCostMultiplier", "units", "updated"].sort()
    );
    expect(doc.meta.id).toMatch(/^b_[A-Za-z0-9]{8}$/);
    expect(doc.meta.name).toBe("Hill Country Build 1");
    expect(doc.meta.owner).toBe("someone@gmail.com");
    expect(doc.meta.created).toBe("2026-09-16T15:00:00Z");
    expect(doc.meta.updated).toBe("2026-09-16T15:00:00Z");
    expect(doc.meta.primaryStyle).toBe("style.spanish.texas_hill_country");
    expect(doc.meta.units).toBe("imperial");
    expect(doc.meta.regionCostMultiplier).toBe(1.0);
    expect(doc.meta.packs).toEqual({});
  });

  it("fills lot and environment per §6", () => {
    expect(Object.keys(doc.lot).sort()).toEqual(["environment", "orientationDeg", "size", "terrain"]);
    expect(doc.lot.size).toEqual([40, 30]);
    expect(doc.lot.orientationDeg).toBe(0);
    expect(doc.lot.environment).toEqual({
      timeOfDay: 16.5,
      latitude: 30,
      season: "summer",
      skyPreset: "clear",
    });
  });

  it("writes a flat heightmap of (sizeX*res+1)*(sizeZ*res+1) samples", () => {
    expect(doc.lot.terrain.resolution).toBe(TERRAIN_RESOLUTION);
    const bytes = base64ToBytes(doc.lot.terrain.heights);
    const heights = new Float32Array(bytes.buffer, bytes.byteOffset, bytes.byteLength / 4);
    expect(heights.length).toBe((40 * 2 + 1) * (30 * 2 + 1));
    expect(Array.from(heights).every((h) => h === 0)).toBe(true);
  });

  it("writes a 4-layer splat with layer 0 at full weight, 4 px per tile", () => {
    expect(doc.lot.terrain.paint.layers).toEqual([...DEFAULT_TERRAIN_LAYERS]);
    expect(doc.lot.terrain.paint.layers).toHaveLength(4);
    const splat = base64ToBytes(doc.lot.terrain.paint.splat);
    // 4 px per tile: a res x res block of RGBA per tile.
    expect(splat.length).toBe(40 * 2 * 30 * 2 * 4);
    expect(Array.from(splat.slice(0, 8))).toEqual([255, 0, 0, 0, 255, 0, 0, 0]);
  });

  it("creates exactly one level, lv_0, with every §6 field present", () => {
    expect(doc.levels).toHaveLength(1);
    const level = doc.levels[0];
    expect(level.id).toBe("lv_0");
    expect(level.index).toBe(0);
    expect(level.wallHeight).toBe(3.05);
    expect(Object.keys(level).sort()).toEqual(
      [
        "fences", "floorTiles", "foundation", "id", "index", "nodes", "openings",
        "platforms", "rooms", "stairs", "trim", "walls", "wallHeight",
      ].sort()
    );
    // Empty, not absent: a migration two phases from now has to tell the
    // difference between "no walls" and "walls were never a field".
    for (const key of ["nodes", "walls", "rooms", "floorTiles", "platforms", "openings", "fences", "stairs"]) {
      expect(level[key], key).toEqual({});
    }
    expect(level.trim).toEqual({ spandrel: null, frieze: null, foundationTrim: null });
    expect(Object.keys(level.foundation).sort()).toEqual(["height", "materialId", "type"]);
  });

  it("leaves roofs, objects, paths and pools empty and present", () => {
    expect(doc.roofs).toEqual({});
    expect(doc.objects).toEqual({});
    expect(doc.paths).toEqual({});
    expect(doc.pools).toEqual({});
  });

  it("centres the default camera on the lot, with §6's fields", () => {
    expect(Object.keys(doc.camera).sort()).toEqual(
      ["distance", "levelIndex", "pitch", "target", "wallMode", "yaw"].sort()
    );
    expect(doc.camera.target).toEqual([20, 0, 15]);
    expect(doc.camera.wallMode).toBe("cutaway");
  });

  it("rejects a lot size that is not two positive numbers", () => {
    for (const bad of [[0, 10], [-1, 10], [10], ["a", 3], []]) {
      expect(() => createBuildDocument({ lotSize: bad }), JSON.stringify(bad)).toThrow(/lotSize/);
    }
  });

  it("mints a distinct build id per document", () => {
    expect(createBuildDocument().meta.id).not.toBe(createBuildDocument().meta.id);
  });
});

describe("serialize / deserialize", () => {
  function populated() {
    const doc = createBuildDocument({ lotSize: [20, 15], now: "2026-01-01T00:00:00Z" });
    doc.levels[0].nodes = { n_a: [2, 2], n_b: [14, 2] };
    doc.levels[0].walls = {
      w_1: {
        a: "n_a", b: "n_b", height: null, kind: "full",
        sideLeft: { materialId: "mat.stucco.hand_troweled", tint: "#EFE6D8" },
        sideRight: { materialId: "mat.plaster.smooth", tint: null },
        openings: ["op_1"],
      },
    };
    doc.levels[0].openings = {
      op_1: { itemId: "ext.window.casement_iron_tall", variant: "black", wallId: "w_1", t: 0.35, sill: 0.6, flip: false },
    };
    doc.roofs = { rf_1: { type: "hip", levelId: "lv_0", pitchDeg: 22.6 } };
    doc.objects = { o_1: { itemId: "ext.tree.live_oak_mature", pos: [30, 0, 22], rotY: 0, scale: 1 } };
    return doc;
  }

  it("round-trips a populated document deep-equal", () => {
    const doc = populated();
    expect(deserialize(serialize(doc))).toEqual(doc);
  });

  it("is byte-stable: the same document twice produces identical strings", () => {
    const doc = populated();
    expect(serialize(doc)).toBe(serialize(doc));
    expect(serialize(deserialize(serialize(doc)))).toBe(serialize(doc));
  });

  it("is insensitive to key insertion order", () => {
    // Two documents with the same content must produce the same bytes, or a
    // save that changed nothing still writes a new Drive file and digests stop
    // answering "did this build actually change".
    const a = { schema: 1, meta: { name: "x", id: "b_1" }, camera: { yaw: 1, pitch: 2 } };
    const b = { camera: { pitch: 2, yaw: 1 }, meta: { id: "b_1", name: "x" }, schema: 1 };
    expect(serialize(a)).toBe(serialize(b));
  });

  it("keeps array order, which is data and not a map", () => {
    const doc = { schema: 1, polygon: [[2, 2], [14, 2], [14, 10]] };
    expect(JSON.parse(serialize(doc)).polygon).toEqual([[2, 2], [14, 2], [14, 10]]);
  });

  it("rejects JSON that is not an object", () => {
    expect(() => deserialize("[1,2]")).toThrow(/JSON object/);
    expect(() => deserialize('"x"')).toThrow(/JSON object/);
  });
});
