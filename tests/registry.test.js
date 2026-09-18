import { describe, it, expect } from "vitest";
import { createRegistry } from "../src/client/registry/registry.js";

describe("registry.registerPack", () => {
  it("stores a pack and retrieves it by id", () => {
    const reg = createRegistry();
    const pack = { id: "core.materials", version: "1.0.0" };
    const returned = reg.registerPack(pack);
    expect(returned).toBe(pack);
    expect(reg.packs["core.materials"]).toBe(pack);
  });

  it("throws on a duplicate id", () => {
    const reg = createRegistry();
    reg.registerPack({ id: "core.styles" });
    expect(() => reg.registerPack({ id: "core.styles" })).toThrow(/duplicate/i);
  });

  it("rejects a missing id", () => {
    const reg = createRegistry();
    expect(() => reg.registerPack({ version: "1.0.0" })).toThrow(/id/i);
    expect(() => reg.registerPack({ id: "" })).toThrow(/id/i);
  });

  it("rejects a non-object pack", () => {
    const reg = createRegistry();
    expect(() => reg.registerPack(null)).toThrow();
    expect(() => reg.registerPack(undefined)).toThrow();
    expect(() => reg.registerPack("nope")).toThrow();
    expect(() => reg.registerPack(42)).toThrow();
    expect(() => reg.registerPack([])).toThrow();
  });

  it("keeps separate registries independent", () => {
    const a = createRegistry();
    const b = createRegistry();
    a.registerPack({ id: "core.exterior" });
    expect(b.packs["core.exterior"]).toBeUndefined();
  });
});
