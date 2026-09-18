// Catalog registry (SPEC §10.2).
//
// Scope for ticket 001: store packs by id, reject non-objects and packs
// missing an id, and throw on a duplicate id. Full validation (semver,
// `requires`, item schema, dev-vs-prod duplicate behavior) is a later
// ticket and is deferred in docs/DEFERRED.md.

/**
 * @typedef {Object} Pack
 * @property {string} id
 */

/**
 * Create a registry instance with its own pack table.
 * @returns {{ packs: Record<string, Pack>, registerPack: (pack: Pack) => Pack }}
 */
export function createRegistry() {
  /** @type {Record<string, Pack>} */
  const packs = {};

  /**
   * Register a catalog pack under its id.
   * @param {Pack} pack
   * @returns {Pack} the stored pack
   */
  function registerPack(pack) {
    if (pack === null || typeof pack !== "object" || Array.isArray(pack)) {
      throw new Error("registerPack: pack must be an object");
    }
    if (typeof pack.id !== "string" || pack.id.length === 0) {
      throw new Error("registerPack: pack.id is required and must be a non-empty string");
    }
    if (Object.prototype.hasOwnProperty.call(packs, pack.id)) {
      throw new Error(`registerPack: duplicate pack id "${pack.id}"`);
    }
    packs[pack.id] = pack;
    return pack;
  }

  return { packs, registerPack };
}
