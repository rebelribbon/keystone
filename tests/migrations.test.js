import { describe, it, expect } from "vitest";
import { MIGRATIONS, runMigrations } from "../src/client/persistence/migrations.js";
import { SCHEMA_VERSION, createBuildDocument } from "../src/client/core/document.js";

describe("runMigrations (§6.4)", () => {
  it("has no migrations at schema 1, which is the point", () => {
    expect(SCHEMA_VERSION).toBe(1);
    expect(MIGRATIONS).toEqual([]);
  });

  it("passes a current-schema document through untouched", () => {
    const doc = createBuildDocument({ now: "2026-01-01T00:00:00Z" });
    expect(runMigrations(doc)).toBe(doc);
  });

  it("refuses a document from a newer client rather than guessing", () => {
    // Opening it would silently drop the fields this build does not know
    // about, and the next save would write that loss back to Drive.
    const doc = { ...createBuildDocument(), schema: 2 };
    expect(() => runMigrations(doc)).toThrow(/newer version of Keystone/);
    expect(() => runMigrations(doc)).toThrow(/schema 2/);
  });

  it("rejects a document with no usable schema", () => {
    for (const schema of [undefined, null, 0, -1, "1", 1.5]) {
      expect(() => runMigrations({ schema }), String(schema)).toThrow(/no usable "schema"/);
    }
  });

  it("rejects a non-document", () => {
    for (const bad of [null, undefined, "{}", 7]) {
      expect(() => runMigrations(bad), String(bad)).toThrow(/expected a Build document/);
    }
  });

  it("runs a chain in order and stamps the schema at each step", () => {
    // A stand-in chain, because the real list is empty until the first schema
    // bump. The runner itself is the real one, reached through its `target`
    // parameter — a test that re-implemented the loop would pass while the
    // shipped loop was broken.
    const seen = [];
    const chain = [
      { from: 1, to: 2, migrate: (d) => { seen.push(1); return { ...d, addedInV2: true }; } },
      { from: 2, to: 3, migrate: (d) => { seen.push(2); return { ...d, addedInV3: true }; } },
    ];
    MIGRATIONS.push(...chain);
    try {
      const result = runMigrations({ schema: 1, meta: {} }, 3);
      expect(seen).toEqual([1, 2]);
      expect(result).toMatchObject({ schema: 3, addedInV2: true, addedInV3: true });
    } finally {
      MIGRATIONS.length = 0;
    }
  });

  it("names the gap when a step is missing", () => {
    MIGRATIONS.push({ from: 2, to: 3, migrate: (d) => d });
    try {
      expect(() => runMigrations({ schema: 1 }, 3)).toThrow(/no migration from schema 1 to 2/);
    } finally {
      MIGRATIONS.length = 0;
    }
  });

  it("rejects a migration that returns nothing", () => {
    MIGRATIONS.push({ from: 1, to: 2, migrate: () => undefined });
    try {
      expect(() => runMigrations({ schema: 1 }, 2)).toThrow(/returned no document/);
    } finally {
      MIGRATIONS.length = 0;
    }
  });
});
