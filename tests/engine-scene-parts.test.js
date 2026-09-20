import { describe, it, expect, vi } from "vitest";
import { terrainVertexData, decodeHeights, GROUND_RING_SIZE } from "../src/client/geometry/terrain.js";
import { gridLinePositions, gridOpacityForPitch, MIN_GRID_OPACITY, MAX_GRID_OPACITY } from "../src/client/engine/grid.js";
import { PRESETS, getPreset, applyPreset, DEFAULT_PRESET } from "../src/client/engine/presets.js";
import { shadowFrustumForLot, SHADOW_PADDING } from "../src/client/engine/renderer.js";
import { createSceneSync } from "../src/client/engine/sync.js";
import { createStore, TRANSACT } from "../src/client/core/store.js";
import { createBuildDocument, bytesToBase64 } from "../src/client/core/document.js";

/** §5's lot sizes. */
const LOT_SIZES = [[20, 15], [30, 30], [40, 30], [64, 64]];

describe("terrain mesh (§5, §6)", () => {
  it("has (sizeX·res + 1) × (sizeZ·res + 1) vertices for every §5 lot size", () => {
    for (const [sizeX, sizeZ] of LOT_SIZES) {
      const data = terrainVertexData({ sizeX, sizeZ, resolution: 2, heights: null });
      expect(data.vertexCount, `${sizeX}x${sizeZ}`).toBe((sizeX * 2 + 1) * (sizeZ * 2 + 1));
      expect(data.positions.length).toBe(data.vertexCount * 3);
      expect(data.indices.length).toBe(sizeX * 2 * sizeZ * 2 * 6);
    }
  });

  it("reproduces the source heightmap vertex for vertex", () => {
    const sizeX = 4;
    const sizeZ = 3;
    const count = (sizeX * 2 + 1) * (sizeZ * 2 + 1);
    const heights = new Float32Array(count);
    for (let i = 0; i < count; i += 1) heights[i] = Math.sin(i) * 2;

    const data = terrainVertexData({ sizeX, sizeZ, resolution: 2, heights });
    for (let i = 0; i < count; i += 1) {
      expect(data.positions[i * 3 + 1], `vertex ${i}`).toBeCloseTo(heights[i], 5);
    }
  });

  it("places the lot per §5: origin at the southwest corner, 1 tile = 1 m", () => {
    const data = terrainVertexData({ sizeX: 40, sizeZ: 30, resolution: 2, heights: null });
    const xs = [];
    const zs = [];
    for (let i = 0; i < data.vertexCount; i += 1) {
      xs.push(data.positions[i * 3]);
      zs.push(data.positions[i * 3 + 2]);
    }
    expect(Math.min(...xs)).toBe(0);
    expect(Math.min(...zs)).toBe(0);
    expect(Math.max(...xs)).toBe(40);
    expect(Math.max(...zs)).toBe(30);
  });

  it("round-trips a real document's heightmap", () => {
    const doc = createBuildDocument({ lotSize: [20, 15] });
    const heights = decodeHeights(doc.lot.terrain.heights);
    expect(heights.length).toBe((20 * 2 + 1) * (15 * 2 + 1));
    expect(Array.from(heights).every((h) => h === 0)).toBe(true);
  });

  it("decodes a non-zero heightmap", () => {
    const source = new Float32Array([0, 1.5, -2.25, 7]);
    expect(Array.from(decodeHeights(bytesToBase64(source)))).toEqual([0, 1.5, -2.25, 7]);
  });

  it("refuses a heightmap that is too small for the lot", () => {
    // A document whose lot size and heightmap disagree is corrupt; building a
    // mesh full of undefined heights would render as a lot with holes in it.
    expect(() =>
      terrainVertexData({ sizeX: 40, sizeZ: 30, resolution: 2, heights: new Float32Array(10) })
    ).toThrow(/heightmap has 10 samples/);
  });

  it("winds triangles so the surface faces up", () => {
    const data = terrainVertexData({ sizeX: 1, sizeZ: 1, resolution: 1, heights: null });
    const [a, b, c] = [0, 1, 2].map((i) => data.indices[i]);
    const p = (i) => [data.positions[i * 3], data.positions[i * 3 + 1], data.positions[i * 3 + 2]];
    const [ax, , az] = p(a);
    const [bx, , bz] = p(b);
    const [cx, , cz] = p(c);
    // Cross product's Y component, positive when counter-clockwise from above.
    const cross = (bx - ax) * (cz - az) - (bz - az) * (cx - ax);
    expect(cross).toBeLessThan(0);
  });

  it("puts the ground ring well past the biggest lot (§8.1)", () => {
    expect(GROUND_RING_SIZE).toBeGreaterThan(64 * 4);
  });
});

describe("the build grid (§5)", () => {
  it("draws one line per tile boundary in each direction", () => {
    const positions = gridLinePositions(4, 3, 1);
    // 5 lines along X, 4 along Z; 2 points each, 3 floats per point.
    expect(positions.length).toBe((5 + 4) * 6);
  });

  it("offsets the half-tile set between the full lines", () => {
    const half = gridLinePositions(2, 2, 1, 0.5);
    const xs = new Set();
    for (let i = 0; i < half.length; i += 3) xs.add(half[i]);
    expect([...xs].sort((a, b) => a - b)).toEqual([0, 0.5, 1.5, 2]);
  });

  it("spans exactly the lot", () => {
    const positions = gridLinePositions(40, 30, 1);
    let maxX = 0;
    let maxZ = 0;
    for (let i = 0; i < positions.length; i += 3) {
      maxX = Math.max(maxX, positions[i]);
      maxZ = Math.max(maxZ, positions[i + 2]);
    }
    expect(maxX).toBe(40);
    expect(maxZ).toBe(30);
  });

  it("dims at a low pitch instead of disappearing", () => {
    const low = gridOpacityForPitch(10 * (Math.PI / 180));
    const high = gridOpacityForPitch(85 * (Math.PI / 180));
    expect(low).toBeLessThan(high);
    expect(low).toBeGreaterThanOrEqual(MIN_GRID_OPACITY);
    expect(high).toBeLessThanOrEqual(MAX_GRID_OPACITY);
    // Still visible: the ground plane needs the depth cue most when flattest.
    expect(low).toBeGreaterThan(0);
  });
});

describe("graphics presets (§8.3)", () => {
  it("matches the §8.3 table exactly", () => {
    expect(PRESETS.low).toMatchObject({ shadows: false, shadowMapSize: 0, pixelRatioCap: 1, textureSize: 512 });
    expect(PRESETS.medium).toMatchObject({ shadows: true, shadowMapSize: 1024, pixelRatioCap: 1.5, textureSize: 1024 });
    expect(PRESETS.high).toMatchObject({ shadows: true, shadowMapSize: 2048, pixelRatioCap: 2, textureSize: 1024, heroTextureSize: 2048 });
  });

  it("records that High wants SSAO without shipping a stub pass", () => {
    // SSAO is Phase 6. A no-op pass would look implemented in a profile and
    // hide that nothing is happening.
    expect(PRESETS.high.post).toEqual({ wants: "ssao", enabled: false });
    expect(PRESETS.low.post).toEqual({ wants: null, enabled: false });
    expect(PRESETS.medium.post.enabled).toBe(false);
  });

  it("falls back to the default for an unknown id rather than throwing", () => {
    expect(getPreset("ultra").id).toBe(DEFAULT_PRESET);
    expect(getPreset(undefined).id).toBe(DEFAULT_PRESET);
    expect(getPreset("HIGH").id).toBe("high");
  });

  /** A renderer and light with just the surface applyPreset touches. */
  function fakeGpu() {
    const disposed = [];
    return {
      disposed,
      renderer: {
        shadowMap: { enabled: true, needsUpdate: false },
        pixelRatio: 0,
        setPixelRatio(value) {
          this.pixelRatio = value;
        },
      },
      sun: {
        castShadow: true,
        shadow: {
          map: { dispose: () => disposed.push("shadowMap") },
          mapSize: { x: 0, y: 0, set(w, h) { this.x = w; this.y = h; } },
          camera: { updateProjectionMatrix: () => {} },
          needsUpdate: false,
        },
      },
    };
  }

  it("applies shadows, shadow map size and the pixel ratio cap", () => {
    const gpu = fakeGpu();
    applyPreset(gpu.renderer, gpu.sun, PRESETS.medium, { devicePixelRatio: 3 });
    expect(gpu.renderer.shadowMap.enabled).toBe(true);
    expect(gpu.sun.shadow.mapSize.x).toBe(1024);
    expect(gpu.renderer.pixelRatio).toBe(1.5);
  });

  it("does not exceed the device's own pixel ratio", () => {
    const gpu = fakeGpu();
    applyPreset(gpu.renderer, gpu.sun, PRESETS.high, { devicePixelRatio: 1 });
    expect(gpu.renderer.pixelRatio).toBe(1);
  });

  it("disposes the old shadow map when switching preset", () => {
    // Three keeps the depth target on the light, so High → Low without this
    // leaks a 2048² texture for the rest of the session.
    const gpu = fakeGpu();
    applyPreset(gpu.renderer, gpu.sun, PRESETS.low, { devicePixelRatio: 2 });
    expect(gpu.disposed).toEqual(["shadowMap"]);
    expect(gpu.sun.shadow.map).toBe(null);
    expect(gpu.renderer.shadowMap.enabled).toBe(false);
    expect(gpu.sun.castShadow).toBe(false);
  });
});

describe("shadow frustum (§4.2)", () => {
  it("covers the lot plus padding, centred on it", () => {
    const frustum = shadowFrustumForLot([40, 30]);
    expect(frustum.right).toBe(20 + SHADOW_PADDING);
    expect(frustum.left).toBe(-(20 + SHADOW_PADDING));
    expect(frustum.center).toEqual([20, 0, 15]);
    // The diagonal has to fit, or corners fall out of the shadow map.
    expect(frustum.radius).toBeGreaterThan(Math.hypot(40, 30) / 2);
  });

  it("grows with the lot", () => {
    const small = shadowFrustumForLot([20, 15]);
    const large = shadowFrustumForLot([64, 64]);
    expect(large.right).toBeGreaterThan(small.right);
    expect(large.far).toBeGreaterThan(small.far);
  });
});

describe("scene sync (§4.1)", () => {
  function harness() {
    const store = createStore(createBuildDocument({ lotSize: [20, 15] }));
    const requestRender = vi.fn();
    const sync = createSceneSync({ store, requestRender });
    sync.start();
    return { store, sync, requestRender, transact: store[TRANSACT] };
  }

  it("dispatches only to the dirty categories", () => {
    const { sync, transact, store } = harness();
    const terrain = vi.fn();
    const camera = vi.fn();
    sync.registerBuilder("terrain", terrain);
    sync.registerBuilder("camera", camera);

    transact(() => store.setIn("lot.terrain.resolution", 4));

    expect(terrain).toHaveBeenCalledTimes(1);
    expect(camera).not.toHaveBeenCalled();
    expect(terrain.mock.calls[0][0].document).toBe(store.getDocument());
  });

  it("is a silent no-op for a category with no builder, and still renders once", () => {
    // This is what lets a walls change exist before the walls ticket does.
    const { sync, transact, store, requestRender } = harness();
    sync.registerBuilder("terrain", vi.fn());

    expect(() => transact(() => store.setIn("levels.0.walls.w_1", { kind: "full" }))).not.toThrow();

    expect(requestRender).toHaveBeenCalledTimes(1);
    expect(sync.rebuildCount).toBe(0);
  });

  it("renders exactly once per change, however many categories are dirty", () => {
    const { sync, transact, store, requestRender } = harness();
    sync.registerBuilder("terrain", vi.fn());
    sync.registerBuilder("camera", vi.fn());

    transact(() => {
      store.setIn("lot.terrain.resolution", 4);
      store.setIn("camera.yaw", 1);
    });

    expect(requestRender).toHaveBeenCalledTimes(1);
    expect(sync.rebuildCount).toBe(2);
  });

  it("refuses a second builder for one category", () => {
    // Two builders for one category would each dispose what the other built.
    const { sync } = harness();
    sync.registerBuilder("terrain", vi.fn());
    expect(() => sync.registerBuilder("terrain", vi.fn())).toThrow(/already registered/);
  });

  it("refuses a builder that is not a function", () => {
    const { sync } = harness();
    expect(() => sync.registerBuilder("terrain", null)).toThrow(/must be a function/);
  });

  it("stops listening after stop and dispose", () => {
    const { sync, transact, store, requestRender } = harness();
    sync.registerBuilder("terrain", vi.fn());
    sync.stop();
    transact(() => store.setIn("lot.terrain.resolution", 4));
    expect(requestRender).not.toHaveBeenCalled();

    sync.dispose();
    expect(sync.categories).toEqual([]);
  });

  it("hands the builder the dirty ids", () => {
    const { sync, transact, store } = harness();
    const walls = vi.fn();
    sync.registerBuilder("walls", walls);
    transact(() => store.setIn("levels.0.walls.w_7", { kind: "full" }));
    expect([...walls.mock.calls[0][0].dirtyIds]).toEqual(["w_7"]);
  });
});
