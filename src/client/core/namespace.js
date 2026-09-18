// Installs the global KS namespace exactly once (SPEC §3, §10.2).
//
// window.KS carries `version` (baked in at build time via an esbuild define),
// `registry`, and `boot`. The window.KS binding is made non-writable and
// non-configurable, and a second install throws, so a double-load of
// engine.js fails loudly instead of silently winning.
import { createRegistry } from "../registry/registry.js";

// Replaced at build time by esbuild `define` with the package.json version.
// The typeof guard keeps this importable outside the bundle (e.g. in tests).
const VERSION = typeof __KS_VERSION__ !== "undefined" ? __KS_VERSION__ : "0.0.0";

/**
 * Install window.KS. Throws if it is already present.
 * @returns {{ version: string, registry: ReturnType<typeof createRegistry>, boot: Function|null }}
 */
export function installNamespace() {
  if (typeof window === "undefined") {
    throw new Error("KS requires a browser environment");
  }
  if (Object.prototype.hasOwnProperty.call(window, "KS")) {
    throw new Error("KS is already installed; engine.js was loaded twice");
  }

  const KS = {
    version: VERSION,
    registry: createRegistry(),
    boot: null,
  };

  Object.defineProperty(window, "KS", {
    value: KS,
    writable: false,
    configurable: false,
    enumerable: true,
  });

  return KS;
}
