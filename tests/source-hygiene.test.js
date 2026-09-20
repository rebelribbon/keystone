import { describe, it, expect } from "vitest";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function walk(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) out.push(...walk(path));
    else out.push(path);
  }
  return out;
}

const SOURCES = walk(join(root, "src")).filter((p) => /\.(js|gs|html|css|json)$/.test(p));

describe("src/ hygiene (§0.5, §0.6, §14.3)", () => {
  it("ships no TODO, FIXME, or XXX — cuts go in docs/DEFERRED.md", () => {
    const offenders = SOURCES.filter((path) => /\b(TODO|FIXME|XXX)\b/.test(readFileSync(path, "utf8")));
    expect(offenders.map((p) => p.replace(root + "/", ""))).toEqual([]);
  });

  it("uses no localStorage or sessionStorage for build data (§14.3)", () => {
    const offenders = SOURCES.filter((path) => /\b(localStorage|sessionStorage)\b/.test(readFileSync(path, "utf8")));
    expect(offenders.map((p) => p.replace(root + "/", ""))).toEqual([]);
  });

  it("carries no EA/Maxis/Sims reference (§0.5)", () => {
    const banned = /\b(maxis|the\s+sims|simcity|electronic\s+arts)\b/i;
    const offenders = SOURCES.filter((path) => banned.test(readFileSync(path, "utf8")));
    expect(offenders.map((p) => p.replace(root + "/", ""))).toEqual([]);
  });

  it("carries no obvious secret (§0: the repo is public)", () => {
    // Deployment ids, script ids and folder ids live in the Settings sheet.
    const banned = [
      /AIza[0-9A-Za-z_-]{35}/,          // Google API key
      /ya29\.[0-9A-Za-z_-]+/,           // OAuth access token
      /-----BEGIN [A-Z ]*PRIVATE KEY/,  // any private key
      /ghp_[0-9A-Za-z]{36}/,            // GitHub PAT
    ];
    for (const path of SOURCES) {
      const text = readFileSync(path, "utf8");
      for (const pattern of banned) {
        expect(pattern.test(text), `${path.replace(root + "/", "")} matches ${pattern}`).toBe(false);
      }
    }
  });
});

describe("main.js wiring (tickets 007 §7, 008 §8)", () => {
  const main = readFileSync(join(root, "src/client/main.js"), "utf8");

  it("exposes the core modules on KS", () => {
    for (const key of ["KS.store", "KS.commands", "KS.events", "KS.document"]) {
      expect(main, key).toContain(key + " =");
    }
  });

  it("boots the lot scene, not the Phase 0 cube (008 §8)", () => {
    // Ticket 001 said the Phase 1 scene ticket would delete the cube, and 008
    // is it. Asserting the absence here is what stops it drifting back.
    expect(main).not.toMatch(/boot-?cube|mountBootCube/i);
    expect(main).toContain("createLotScene");
  });

  it("creates the in-memory build inside boot (008 §8)", () => {
    const boot = main.slice(main.indexOf("KS.boot = function boot"));
    expect(boot).toMatch(/createBuildDocument/);
    expect(boot).toContain("createLotScene");
  });

  it("makes no server call from boot", () => {
    // 008 §8: "No server calls, no persistence."
    const boot = main.slice(main.indexOf("KS.boot = function boot"));
    expect(boot).not.toMatch(/callServer|saveBuild|loadBuild|google\.script/);
  });
});

describe("src/client/dev/boot-cube.js is gone (008 §8)", () => {
  it("is not on disk and nothing references it", () => {
    expect(existsSync(join(root, "src/client/dev/boot-cube.js"))).toBe(false);
    const offenders = SOURCES.filter((path) => /boot-?cube/i.test(readFileSync(path, "utf8")));
    expect(offenders.map((p) => p.replace(root + "/", ""))).toEqual([]);
  });
});
