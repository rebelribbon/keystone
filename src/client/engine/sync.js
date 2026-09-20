// Scene sync (SPEC §4.1, §4.2).
//
// The store says what changed; this decides what to rebuild. The registry is
// the whole point: walls, roofs and objects arrive in later tickets by
// registering a builder, and this file never changes again.

/**
 * @typedef {function({document: !Object, dirtyIds: !Set<string>, dirtyCategories: !Set<string>}): void} Builder
 */

/**
 * @param {{store: !Object, requestRender: function(): void}} options
 */
export function createSceneSync(options) {
  const { store, requestRender } = options;

  /** @type {!Map<string, Builder>} */
  const builders = new Map();
  let unsubscribe = null;
  let rebuildCount = 0;

  /**
   * Register the builder for a dirty category (§4.1).
   *
   * **The builder owns disposal.** A builder that replaces a mesh disposes the
   * one it replaced — nothing else knows what it allocated, and a leak here is
   * a GPU leak that survives every later edit.
   * @param {string} category
   * @param {Builder} fn
   */
  function registerBuilder(category, fn) {
    if (typeof fn !== "function") {
      throw new Error(`sync.registerBuilder("${category}"): builder must be a function`);
    }
    if (builders.has(category)) {
      throw new Error(
        `sync.registerBuilder("${category}"): already registered. Two builders for one ` +
          "category would each dispose what the other just built."
      );
    }
    builders.set(category, fn);
    return () => builders.delete(category);
  }

  /**
   * Run the builders a change names.
   *
   * A category with no builder is a silent no-op, and deliberately so: that is
   * exactly what lets a `walls` change exist before the walls ticket does.
   * @param {{dirtyIds: !Set<string>, dirtyCategories: !Set<string>}} change
   */
  function apply(change) {
    const document = store.getDocument();
    const dirtyIds = change.dirtyIds || new Set();
    const dirtyCategories = change.dirtyCategories || new Set();

    for (const category of dirtyCategories) {
      const builder = builders.get(category);
      if (!builder) continue;
      builder({ document, dirtyIds, dirtyCategories, category });
      rebuildCount += 1;
    }

    // One frame per change, whether or not anything rebuilt. This is the only
    // place in the codebase that renders on a store change; keeping it to one
    // call site is what keeps render-on-demand auditable (§4.2).
    requestRender();
  }

  function start() {
    if (unsubscribe) return unsubscribe;
    unsubscribe = store.on("change", apply);
    return unsubscribe;
  }

  function stop() {
    if (unsubscribe) unsubscribe();
    unsubscribe = null;
  }

  return {
    registerBuilder,
    apply,
    start,
    stop,
    /** Builders actually invoked, for tests. */
    get rebuildCount() {
      return rebuildCount;
    },
    get categories() {
      return [...builders.keys()];
    },
    dispose() {
      stop();
      builders.clear();
    },
  };
}
