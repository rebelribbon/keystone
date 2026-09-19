import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const HEX64 = /^[0-9a-f]{64}$/;

function runBuild(env) {
  const outDir = mkdtempSync(join(tmpdir(), "ks-manifest-"));
  execFileSync("node", ["build/build.mjs"], {
    cwd: root,
    env: { ...process.env, KS_TAG: undefined, ...env, KS_OUT_DIR: outDir },
    stdio: "pipe",
  });
  const manifest = JSON.parse(readFileSync(join(outDir, "manifest.json"), "utf8"));
  return { outDir, manifest };
}

let defaultBuild;
let taggedBuild;

beforeAll(() => {
  // Ensure KS_TAG is unset for the default-tag build.
  const env = { ...process.env };
  delete env.KS_TAG;
  const outDir = mkdtempSync(join(tmpdir(), "ks-manifest-"));
  execFileSync("node", ["build/build.mjs"], {
    cwd: root,
    env: { ...env, KS_OUT_DIR: outDir },
    stdio: "pipe",
  });
  defaultBuild = { outDir, manifest: JSON.parse(readFileSync(join(outDir, "manifest.json"), "utf8")) };

  taggedBuild = runBuild({ KS_TAG: "build-42" });
}, 120000);

afterAll(() => {
  if (defaultBuild) rmSync(defaultBuild.outDir, { recursive: true, force: true });
  if (taggedBuild) rmSync(taggedBuild.outDir, { recursive: true, force: true });
});

describe("manifest.json", () => {
  it("has the expected shape", () => {
    const m = defaultBuild.manifest;
    expect(typeof m.tag).toBe("string");
    expect(typeof m.commit).toBe("string");
    expect(typeof m.builtAt).toBe("string");
    expect(m.schemaVersion).toBe(1);
    expect(Array.isArray(m.files)).toBe(true);
    expect(m.files.length).toBeGreaterThan(0);
    expect(Array.isArray(m.server)).toBe(true);
    // builtAt is a valid ISO timestamp.
    expect(new Date(m.builtAt).toISOString()).toBe(m.builtAt);
  });

  it("defaults the tag to 'dev' when KS_TAG is unset", () => {
    expect(defaultBuild.manifest.tag).toBe("dev");
  });

  it("honors KS_TAG", () => {
    expect(taggedBuild.manifest.tag).toBe("build-42");
  });

  it("gives every file a byte length and a 64-char hex sha256, sorted by path", () => {
    const files = defaultBuild.manifest.files;
    for (const f of files) {
      expect(typeof f.path).toBe("string");
      expect(f.path.startsWith("dist/")).toBe(true);
      expect(Number.isInteger(f.bytes)).toBe(true);
      expect(f.bytes).toBeGreaterThan(0);
      expect(HEX64.test(f.sha256)).toBe(true);
    }
    const paths = files.map((f) => f.path);
    expect(paths).toEqual([...paths].sort());
  });

  // The updater (ticket 004) reads `server`, then verifies each listed file
  // against this same `files` array before it writes anything. If the two ever
  // disagree, every update run aborts on a digest mismatch.
  it("lists every src/server file under `server`, each with a matching digest", () => {
    const { manifest, outDir } = defaultBuild;
    const onDisk = readdirSync(join(root, "src/server")).sort();
    expect(manifest.server).toEqual(onDisk.map((name) => `dist/server/${name}`));
    expect(manifest.server).toContain("dist/server/Updater.gs");

    const digests = new Map(manifest.files.map((f) => [f.path, f.sha256]));
    for (const path of manifest.server) {
      const bytes = readFileSync(join(outDir, path.replace(/^dist\//, "")));
      expect(digests.get(path), path).toBe(createHash("sha256").update(bytes).digest("hex"));
    }
  });

  // Every server file the release carries must be one the updater can classify,
  // or a run aborts with UPDATER_UNKNOWN_FILE.
  it("carries only extensions the updater maps to an Apps Script file type", () => {
    for (const path of defaultBuild.manifest.server) {
      expect(path).toMatch(/\.(gs|html|json)$/);
    }
  });
});
