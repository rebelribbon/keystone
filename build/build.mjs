// Single build entry point (SPEC §3). Runs identically in a Claude Code cloud
// session and in GitHub Actions. Bundles the client + content entry points with
// esbuild, copies styles.css and src/server verbatim, and writes a manifest.
//
// Output tree (locked names, §3):
//   dist/client/vendor-three.js       (Three.js, bundled once)
//   dist/client/engine.js             (window.KS)
//   dist/client/catalog-materials.js
//   dist/client/catalog-styles.js
//   dist/client/catalog-exterior.js
//   dist/client/catalog-interior.js
//   dist/client/styles.css            (verbatim copy)
//   dist/server/**                    (verbatim copy of src/server, if present)
//   dist/manifest.json
//
// Env: KS_TAG (manifest tag, default "dev"), GITHUB_SHA (commit),
//      KS_OUT_DIR (output root, defaults to <repo>/dist; used by tests to
//      build into a temp dir without touching the repo).
import { build } from "esbuild";
import { createHash } from "node:crypto";
import { execSync } from "node:child_process";
import {
  rmSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  copyFileSync,
  existsSync,
  readdirSync,
  statSync,
} from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const root = resolve(scriptDir, "..");
const outRoot = process.env.KS_OUT_DIR ? resolve(process.env.KS_OUT_DIR) : join(root, "dist");
const outClient = join(outRoot, "client");
const outServer = join(outRoot, "server");

/** Print a readable message and exit non-zero. */
function fail(message, err) {
  console.error(`[build] ${message}`);
  if (err) console.error(err && err.stack ? err.stack : err);
  process.exit(1);
}

/** Recursively list every file under a directory as absolute paths. */
function walk(dir) {
  /** @type {string[]} */
  const out = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...walk(p));
    else out.push(p);
  }
  return out;
}

/** Manifest path key: always the logical "dist/..." path, regardless of outRoot. */
function distPath(absPath) {
  return "dist/" + relative(outRoot, absPath).split(sep).join("/");
}

async function main() {
  const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  const version = pkg.version || "0.0.0";

  // Reproducible: wipe the output tree before every run.
  rmSync(outRoot, { recursive: true, force: true });
  mkdirSync(outClient, { recursive: true });

  const common = {
    bundle: true,
    format: "iife",
    target: "es2022",
    minify: true,
    sourcemap: false,
    legalComments: "none",
    logLevel: "silent",
  };

  // Vendor bundle: Three.js bundled in and exposed as window.THREE.
  await build({
    ...common,
    entryPoints: [join(root, "src/client/vendor/three-entry.js")],
    outfile: join(outClient, "vendor-three.js"),
  });

  // Engine + content bundles: Three.js is external (read from window.THREE),
  // so it ships exactly once. Version is baked in via define.
  const define = { __KS_VERSION__: JSON.stringify(version) };
  const entryMap = [
    ["src/client/main.js", "engine.js"],
    ["src/content/materials/index.js", "catalog-materials.js"],
    ["src/content/styles/index.js", "catalog-styles.js"],
    ["src/content/exterior/index.js", "catalog-exterior.js"],
    ["src/content/interior/index.js", "catalog-interior.js"],
  ];
  for (const [entry, out] of entryMap) {
    await build({
      ...common,
      entryPoints: [join(root, entry)],
      outfile: join(outClient, out),
      external: ["three"],
      define,
    });
  }

  // styles.css: verbatim, not bundled, not minified.
  copyFileSync(join(root, "src/client/ui/styles.css"), join(outClient, "styles.css"));

  // src/server/**: verbatim, preserving relative paths. May not exist yet (002).
  const serverSrc = join(root, "src/server");
  /** @type {string[]} */
  const serverFiles = [];
  if (existsSync(serverSrc) && statSync(serverSrc).isDirectory()) {
    for (const abs of walk(serverSrc)) {
      const rel = relative(serverSrc, abs);
      const target = join(outServer, rel);
      mkdirSync(dirname(target), { recursive: true });
      copyFileSync(abs, target);
      serverFiles.push("dist/server/" + rel.split(sep).join("/"));
    }
  }
  serverFiles.sort((a, b) => a.localeCompare(b));

  // Manifest: every file written under dist/, sorted, with size + sha256.
  const files = walk(outRoot)
    .map((abs) => {
      const buf = readFileSync(abs);
      return {
        path: distPath(abs),
        bytes: buf.length,
        sha256: createHash("sha256").update(buf).digest("hex"),
      };
    })
    .sort((a, b) => a.path.localeCompare(b.path));

  let commit = process.env.GITHUB_SHA;
  if (!commit) {
    try {
      commit = execSync("git rev-parse HEAD", { cwd: root }).toString().trim();
    } catch {
      commit = "unknown";
    }
  }

  const manifest = {
    tag: process.env.KS_TAG || "dev",
    commit: commit || "unknown",
    builtAt: new Date().toISOString(),
    schemaVersion: 1,
    files,
    server: serverFiles,
  };

  writeFileSync(join(outRoot, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n");
  console.log(`[build] wrote ${files.length} files to ${outRoot} (tag=${manifest.tag})`);
}

main().catch((err) => fail("build failed", err));
