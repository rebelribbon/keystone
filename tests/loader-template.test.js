import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const TEMPLATE = readFileSync(join(root, "src/server/Index.html"), "utf8");

// SPEC §3.1 load order.
const EXPECTED_ORDER = [
  "dist/client/styles.css",
  "dist/client/vendor-three.js",
  "dist/client/engine.js",
  "dist/client/catalog-materials.js",
  "dist/client/catalog-styles.js",
  "dist/client/catalog-exterior.js",
  "dist/client/catalog-interior.js",
];

// Scriptlets such as `<?= base ?>` contain a ">", which would truncate a
// naive tag match, so they are replaced before the tags are extracted.
const TEMPLATE_NO_SCRIPTLETS = TEMPLATE.replace(/<\?!?=?[\s\S]*?\?>/g, "BASE");

/** Every <script> tag that loads an external file. */
function externalScriptTags() {
  return [...TEMPLATE_NO_SCRIPTLETS.matchAll(/<script\b[^>]*\bsrc=[^>]*?>/g)].map((m) => m[0]);
}

describe("Index.html loader template", () => {
  it("references the seven client files in §3.1 order", () => {
    const found = [...TEMPLATE.matchAll(/dist\/client\/[A-Za-z0-9._-]+/g)].map((m) => m[0]);
    expect(found).toEqual(EXPECTED_ORDER);
  });

  it("points every client reference at the injected {base}", () => {
    for (const file of EXPECTED_ORDER) {
      expect(TEMPLATE).toContain(`<?= base ?>/${file}`);
    }
  });

  it("gives every external script tag a defer attribute", () => {
    const tags = externalScriptTags();
    expect(tags.length).toBe(6);
    for (const tag of tags) {
      expect(tag, `missing defer: ${tag}`).toMatch(/\bdefer\b/);
    }
  });

  it("wires each bundle to the loading screen with onload and onerror", () => {
    for (const tag of externalScriptTags()) {
      expect(tag).toMatch(/\bonload=/);
      expect(tag).toMatch(/\bonerror=/);
    }
  });

  it("boots after the deferred scripts rather than inline", () => {
    expect(TEMPLATE).toContain('document.addEventListener("DOMContentLoaded"'.replace(/"/g, "'"));
    expect(TEMPLATE).toContain("KSL.boot()");
  });

  it("loads the Manrope font at the three weights", () => {
    expect(TEMPLATE).toMatch(/fonts\.googleapis\.com\/css2\?family=Manrope:wght@400;600;700/);
  });

  it("contains no localStorage", () => {
    expect(TEMPLATE.includes("localStorage")).toBe(false);
  });

  it("injects the boot payload as one pre-escaped JSON blob, not concatenated values", () => {
    expect(TEMPLATE).toContain("window.KS_BOOT = <?!= bootJson ?>;");
    // No raw scriptlet output of user- or settings-derived values anywhere else.
    const rawPrints = [...TEMPLATE.matchAll(/<\?!=\s*([A-Za-z0-9_.[\]()'" ]+?)\s*\?>/g)].map((m) => m[1].trim());
    for (const printed of rawPrints) {
      expect(
        ["bootJson", "inlineStyles"].includes(printed) ||
          printed.startsWith("inlineBundles[") ||
          printed.startsWith("toSafeJson_("),
        `unescaped scriptlet output: ${printed}`
      ).toBe(true);
    }
  });

  it("only reaches the inline fallback behind loader_mode", () => {
    expect(TEMPLATE).toContain("<? if (loaderMode === 'inline') { ?>");
  });

  it("keeps the dev gates panel behind the owner-only devGates flag", () => {
    expect(TEMPLATE).toContain("<? if (devGates) { ?>");
  });

  it("has syntactically valid inline JavaScript", () => {
    const stripped = TEMPLATE.replace(/<\?!?=?[\s\S]*?\?>/g, "0");
    const blocks = [...stripped.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
    expect(blocks.length).toBeGreaterThan(0);
    for (const [i, block] of blocks.entries()) {
      if (!block.trim()) continue;
      expect(() => new vm.Script(block, { filename: `inline-${i}` }), `block ${i}`).not.toThrow();
    }
  });
});
