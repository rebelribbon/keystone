// Schema migrations (SPEC §6.4).
//
// Empty at SCHEMA_VERSION 1, and that is the point: the runner exists before
// the first migration does, so the first real schema change is a data change
// against tested infrastructure rather than both at once under pressure.
import { SCHEMA_VERSION } from "../core/document.js";

/**
 * @typedef {{from: number, to: number, migrate: function(!Object): !Object}} Migration
 */

/**
 * Ordered migrations. Each takes a document at `from` and returns one at `to`.
 * Append only, never edit a shipped one: a build saved two years ago has to
 * go through exactly the steps it missed.
 * @type {!Array<Migration>}
 */
export const MIGRATIONS = [];

/**
 * Bring a document up to SCHEMA_VERSION.
 *
 * A document from a *newer* client is refused rather than guessed at. Opening
 * it would silently drop whatever fields this build does not know about, and
 * the next save would write that loss back to Drive — data lost quietly, which
 * is worse than a build that will not open.
 * `target` exists so the loop can be tested against a stand-in chain while the
 * real list is still empty. Production always uses the default; passing
 * anything else is a test affordance, not a feature.
 * @param {!Object} doc
 * @param {number} [target] the schema to migrate up to
 * @returns {!Object}
 */
export function runMigrations(doc, target = SCHEMA_VERSION) {
  if (doc === null || typeof doc !== "object") {
    throw new Error("runMigrations: expected a Build document");
  }

  const schema = doc.schema;
  if (!Number.isInteger(schema) || schema < 1) {
    throw new Error(`runMigrations: document has no usable "schema" (got ${JSON.stringify(schema)})`);
  }
  if (schema > target) {
    throw new Error(
      `This build was saved by a newer version of Keystone (schema ${schema}, ` +
        `this client understands ${target}). Refusing to open it rather than ` +
        "dropping the parts this version does not know about. Reload to get the newest client."
    );
  }

  let current = doc;
  let version = schema;
  while (version < target) {
    const step = MIGRATIONS.find((m) => m.from === version);
    if (!step) {
      throw new Error(
        `runMigrations: no migration from schema ${version} to ${version + 1}. ` +
          "Every schema bump ships one (§0.2)."
      );
    }
    current = step.migrate(current);
    if (current === null || typeof current !== "object") {
      throw new Error(`runMigrations: the ${step.from}→${step.to} migration returned no document`);
    }
    version = step.to;
    current = { ...current, schema: version };
  }
  return current;
}
