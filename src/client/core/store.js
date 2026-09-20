// The Store: the single source of truth for the Build document (SPEC §4.1, §6).
//
// Two properties this file exists to guarantee:
//
// 1. **Immutability.** A write never mutates the previous document. Untouched
//    subtrees keep their identity across a write, which is what lets scene sync
//    (§4.1) rebuild only what changed by comparing references.
// 2. **§0.3 is enforced, not requested.** "Every state mutation goes through a
//    Command" is a rule no amount of code review keeps. Here a write outside a
//    command throws, and the only way to open a write window is a symbol that
//    commands.js holds. A tool reaching for KS.store cannot find it.

/**
 * The key commands.js uses to open a write window.
 *
 * A symbol, and not exported onto the KS namespace, so `KS.store` is read-only
 * in practice for every tool, panel, and content pack. Importing store.js
 * directly to get at it is possible inside the bundle — this stops the accident,
 * not a determined author, which is the honest scope of the guarantee.
 */
export const TRANSACT = Symbol("ks.store.transact");

/** §4.1 dirty categories. Nothing outside this list is ever emitted. */
export const CATEGORIES = Object.freeze([
  "walls",
  "nodes",
  "rooms",
  "floorTiles",
  "openings",
  "roofs",
  "objects",
  "terrain",
  "levels",
  "meta",
  "camera",
  "environment",
]);

/**
 * §6 path segments that are not themselves categories, mapped to the category
 * a change under them belongs to. Derived from the path rather than declared by
 * the caller: a declared category is right the day it is written and wrong the
 * first time someone copies the line.
 *
 * `paths`, `pools`, `fences` and `stairs` are placed objects and rebuild with
 * `objects`. `platforms` and `trim` are level furniture and rebuild with the
 * level. `lot` sizing changes the ground, so it rides with `terrain`.
 */
const CATEGORY_ALIASES = Object.freeze({
  schema: "meta",
  lot: "terrain",
  paths: "objects",
  pools: "objects",
  fences: "objects",
  stairs: "objects",
  platforms: "levels",
  trim: "levels",
  foundation: "levels",
});

const CATEGORY_SET = new Set(CATEGORIES);
const ID_SEGMENT = /^(b|lv|n|w|r|rf|op|o)_[A-Za-z0-9]+$/;

/**
 * Pure. Normalize a dotted string or array path into an array of segments.
 * Numeric-looking segments become numbers so array indexing works.
 * @param {string|Array<string|number>} path
 * @returns {!Array<string|number>}
 */
export function normalizePath(path) {
  const parts = Array.isArray(path) ? path.slice() : String(path == null ? "" : path).split(".");
  if (!parts.length || parts.some((p) => p === "" || p == null)) {
    throw new Error(`store: "${String(path)}" is not a usable path`);
  }
  return parts.map((part) => {
    if (typeof part === "number") return part;
    return /^\d+$/.test(part) ? Number(part) : part;
  });
}

/**
 * Pure. Which §4.1 category a write to this path dirties.
 *
 * The *last* matching segment wins, so `levels.0.walls.w_1` is a `walls` change
 * and not a `levels` one — the level did not change, a wall inside it did, and
 * rebuilding the whole level for a wall edit is the performance bug §4.2 exists
 * to avoid.
 * @param {!Array<string|number>} segments
 * @returns {string}
 */
export function categoryForPath(segments) {
  let category = null;
  for (const segment of segments) {
    if (typeof segment !== "string") continue;
    if (CATEGORY_SET.has(segment)) category = segment;
    else if (CATEGORY_ALIASES[segment]) category = CATEGORY_ALIASES[segment];
  }
  if (!category) {
    throw new Error(
      `store: no dirty category for path "${segments.join(".")}". ` +
        "The document shape is locked by §6, so an unmapped root is a typo or a " +
        "schema change — add it to CATEGORIES or CATEGORY_ALIASES deliberately."
    );
  }
  return category;
}

/**
 * Pure. Entity IDs touched by a path: every §6-prefixed segment, plus a
 * floor-tile key, which is a `<x>,<z>` string rather than a minted ID.
 * @param {!Array<string|number>} segments
 * @returns {!Array<string>}
 */
export function idsForPath(segments) {
  const ids = [];
  for (let i = 0; i < segments.length; i += 1) {
    const segment = segments[i];
    if (typeof segment !== "string") continue;
    if (ID_SEGMENT.test(segment)) ids.push(segment);
    else if (segments[i - 1] === "floorTiles" && /^-?\d+,-?\d+$/.test(segment)) ids.push(segment);
  }
  return ids;
}

/**
 * Freeze a subtree, stopping at anything already frozen.
 *
 * Because writes share structure, everything below the rewritten spine is
 * already frozen from an earlier pass, so this costs about as much as the change
 * rather than as much as the document.
 */
function deepFreeze(value) {
  if (value === null || typeof value !== "object" || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const key of Object.keys(value)) deepFreeze(value[key]);
  return value;
}

/** A shallow copy that keeps arrays as arrays. */
function shallowCopy(value) {
  return Array.isArray(value) ? value.slice() : { ...value };
}

/**
 * Pure. Return a copy of `root` with `segments` set to `value`, sharing every
 * untouched subtree with the original.
 * @param {*} root
 * @param {!Array<string|number>} segments
 * @param {*} value
 * @returns {*}
 */
export function setPath(root, segments, value) {
  if (!segments.length) return value;
  const [head, ...rest] = segments;
  const base = root === null || typeof root !== "object" ? (typeof head === "number" ? [] : {}) : root;
  const copy = shallowCopy(base);
  copy[head] = rest.length ? setPath(base[head], rest, value) : value;
  return copy;
}

/**
 * Pure. Return a copy of `root` with `segments` removed, sharing every
 * untouched subtree. Returns `root` unchanged when the key is not there.
 * @param {*} root
 * @param {!Array<string|number>} segments
 * @returns {*}
 */
export function deletePath(root, segments) {
  if (!segments.length) return undefined;
  if (root === null || typeof root !== "object") return root;
  const [head, ...rest] = segments;

  if (rest.length) {
    const child = root[head];
    if (child === null || typeof child !== "object") return root;
    const nextChild = deletePath(child, rest);
    if (nextChild === child) return root;
    const copy = shallowCopy(root);
    copy[head] = nextChild;
    return copy;
  }

  if (Array.isArray(root)) {
    throw new Error(
      `store.deleteIn: refusing to delete index ${head} from an array. In §6 an ` +
        "array is data, not a map, and removing an index silently renumbers " +
        "everything after it. Write the filtered array with setIn instead."
    );
  }
  if (!Object.prototype.hasOwnProperty.call(root, head)) return root;
  const copy = { ...root };
  delete copy[head];
  return copy;
}

/**
 * Pure. Read a path, or undefined if any step is missing.
 * @param {*} root
 * @param {!Array<string|number>} segments
 * @returns {*}
 */
export function getPath(root, segments) {
  let node = root;
  for (const segment of segments) {
    if (node === null || typeof node !== "object") return undefined;
    node = node[segment];
  }
  return node;
}

/**
 * Create a Store over a Build document.
 * @param {!Object} doc
 * @param {{events?: {emit: Function}}} [options] an event bus to mirror
 *   `change` onto as `store:change` (§4.1)
 */
export function createStore(doc, options = {}) {
  const { events = null } = options;

  let document = deepFreeze(doc);
  let depth = 0;
  let dirtyIds = null;
  let dirtyCategories = null;
  const listeners = new Set();

  function requireCommand(operation) {
    if (depth === 0) {
      throw new Error(
        `store.${operation}: state changed outside a command. SPEC §0.3 — every ` +
          "mutation goes through a Command, so run this through KS.commands.run()."
      );
    }
  }

  function record(segments) {
    dirtyCategories.add(categoryForPath(segments));
    for (const id of idsForPath(segments)) dirtyIds.add(id);
  }

  /** @param {string|Array<string|number>} path */
  function get(path) {
    return getPath(document, normalizePath(path));
  }

  function getDocument() {
    return document;
  }

  function setIn(path, value) {
    requireCommand("setIn");
    if (value === undefined) {
      // Storing undefined would leave the key present in memory and absent
      // after a JSON round trip, so the document a builder iterates and the
      // document that reaches Drive would disagree. Removal is its own verb.
      throw new Error(
        `store.setIn("${normalizePath(path).join(".")}"): value is undefined. ` +
          "Use deleteIn() to remove a key — an undefined value survives in memory " +
          "but vanishes through JSON, so the two would not match."
      );
    }
    const segments = normalizePath(path);
    document = deepFreeze(setPath(document, segments, value));
    record(segments);
    return document;
  }

  /**
   * Remove a key (§7 `DeleteWalls`, `DeleteRoof`, and the undo of every
   * `Add*`).
   *
   * A no-op when the key is already absent, which is what makes an `Add`
   * command's undo safe to run after the entity was removed another way.
   * @param {string|Array<string|number>} path
   */
  function deleteIn(path) {
    requireCommand("deleteIn");
    const segments = normalizePath(path);
    const next = deletePath(document, segments);
    if (next === document) return document;
    document = deepFreeze(next);
    record(segments);
    return document;
  }

  function updateIn(path, fn) {
    requireCommand("updateIn");
    const segments = normalizePath(path);
    const next = fn(getPath(document, segments));
    return next === undefined ? deleteIn(segments) : setIn(segments, next);
  }

  function on(event, listener) {
    if (event !== "change") throw new Error(`store.on: unknown event "${event}"`);
    listeners.add(listener);
    return () => listeners.delete(listener);
  }

  function off(event, listener) {
    if (event !== "change") throw new Error(`store.off: unknown event "${event}"`);
    listeners.delete(listener);
  }

  /**
   * Open a write window, run `fn`, and emit one `change` at the end.
   *
   * One emission per transaction, not per `setIn`: a command that moves a room
   * writes a dozen paths, and a listener that rebuilds geometry twelve times for
   * one user action is the same performance bug §4.2 warns about.
   *
   * Nested transactions (a command run inside a group) collapse into the
   * outermost one. `fn`'s return value is passed through; a throw propagates
   * after the window closes, and the caller decides what to restore.
   */
  function transact(fn) {
    if (depth === 0) {
      dirtyIds = new Set();
      dirtyCategories = new Set();
    }
    depth += 1;
    let result;
    try {
      result = fn();
    } catch (err) {
      depth -= 1;
      // Nothing is emitted for a transaction that threw: the caller is about to
      // restore the document, so listeners would be told about changes that end
      // up never having happened.
      if (depth === 0) {
        dirtyIds = null;
        dirtyCategories = null;
      }
      throw err;
    }
    depth -= 1;
    if (depth === 0) {
      const payload = { dirtyIds, dirtyCategories };
      dirtyIds = null;
      dirtyCategories = null;
      if (payload.dirtyCategories.size) emitChange(payload);
    }
    return result;
  }

  function emitChange(payload) {
    for (const listener of Array.from(listeners)) {
      try {
        listener(payload);
      } catch (err) {
        console.error("store change listener threw:", err);
      }
    }
    if (events) events.emit("store:change", payload);
  }

  /**
   * Replace the whole document, outside the command system.
   *
   * For the loader only: opening a saved build is not an undoable edit, it is a
   * new session over a different document. It clears nothing by itself — the
   * caller resets the command stacks.
   *
   * `silent` skips the change event, for the one case where the document is
   * being put back exactly as listeners already believe it to be: a command
   * whose `do` threw part-way.
   */
  function replaceDocument(next, { silent = false } = {}) {
    document = deepFreeze(next);
    if (!silent) {
      emitChange({ dirtyIds: new Set(), dirtyCategories: new Set(CATEGORIES) });
    }
    return document;
  }

  const store = {
    get,
    getDocument,
    setIn,
    deleteIn,
    updateIn,
    on,
    off,
    replaceDocument,
    /** True while a command is executing. Read-only; for assertions and tests. */
    get inCommand() {
      return depth > 0;
    },
  };

  // Non-enumerable so it does not show up in a console dump of the store.
  Object.defineProperty(store, TRANSACT, { value: transact, enumerable: false });
  return store;
}
