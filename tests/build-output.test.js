import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, statSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

let outDir;
let clientDir;

beforeAll(() => {
  outDir = mkdtempSync(join(tmpdir(), "ks-build-"));
  execFileSync("node", ["build/build.mjs"], {
    cwd: root,
    env: { ...process.env, KS_OUT_DIR: outDir },
    stdio: "pipe",
  });
  clientDir = join(outDir, "client");
}, 120000);

afterAll(() => {
  if (outDir) rmSync(outDir, { recursive: true, force: true });
});

const EXPECTED_CLIENT = [
  "catalog-exterior.js",
  "catalog-interior.js",
  "catalog-materials.js",
  "catalog-styles.js",
  "engine.js",
  "styles.css",
  "vendor-three.js",
];

describe("build output", () => {
  it("dist/client contains exactly the expected file set", () => {
    const actual = readdirSync(clientDir).sort();
    expect(actual).toEqual([...EXPECTED_CLIENT].sort());
  });

  it("every client file is non-empty", () => {
    for (const name of EXPECTED_CLIENT) {
      expect(statSync(join(clientDir, name)).size).toBeGreaterThan(0);
    }
  });

  it("engine.js does not contain the string 'localStorage'", () => {
    const engine = readFileSync(join(clientDir, "engine.js"), "utf8");
    expect(engine.includes("localStorage")).toBe(false);
  });

  it("vendor-three.js is the only bundle carrying Three.js; the other five are under 50 KB", () => {
    const vendorSize = statSync(join(clientDir, "vendor-three.js")).size;
    expect(vendorSize).toBeGreaterThan(50 * 1024);

    const others = [
      "engine.js",
      "catalog-materials.js",
      "catalog-styles.js",
      "catalog-exterior.js",
      "catalog-interior.js",
    ];
    for (const name of others) {
      expect(statSync(join(clientDir, name)).size).toBeLessThan(50 * 1024);
    }
  });
});
