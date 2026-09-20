// Three.js access (SPEC §3.1).
//
// The engine bundle marks `three` external and reads it from `window.THREE`,
// which vendor-three.js installs. Reading it through a function rather than at
// module scope keeps import order irrelevant and lets tests supply a stub.

/** @returns {!Object} the THREE namespace */
export function getTHREE() {
  const THREE = typeof window === "undefined" ? undefined : window.THREE;
  if (!THREE) {
    throw new Error(
      "Keystone: window.THREE is missing. vendor-three.js must load before engine.js (§3.1 load order)."
    );
  }
  return THREE;
}
