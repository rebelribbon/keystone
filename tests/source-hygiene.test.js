import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
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

describe("main.js wiring (ticket 007 §7)", () => {
  const main = readFileSync(join(root, "src/client/main.js"), "utf8");

  it("exposes the four core modules on KS", () => {
    for (const key of ["KS.store", "KS.commands", "KS.events", "KS.document"]) {
      expect(main, key).toContain(key + " =");
    }
  });

  it("still mounts the Phase 0 cube and creates no document in boot", () => {
    expect(main).toContain("mountBootCube(root)");
    const boot = main.slice(main.indexOf("KS.boot = function boot"));
    expect(boot).not.toMatch(/createBuildDocument/);
  });
});
