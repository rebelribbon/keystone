// Typed event bus (SPEC §4.1).
//
// The names are a closed set. Emitting or subscribing to a name that is not on
// it throws, because the failure it replaces is silent: a typo'd event name
// does nothing at all, forever, and the bug surfaces months later as "the panel
// never updates" with no error anywhere.

/** §4.1 event names, plus the store's change signal. */
export const EVENT_NAMES = Object.freeze([
  "tool:changed",
  "level:changed",
  "view:changed",
  "selection:changed",
  "build:saved",
  "store:change",
]);

/**
 * @param {{names?: !Array<string>, strict?: boolean}} [options]
 *   `strict` throws on an unknown name; false warns instead.
 */
export function createEventBus(options = {}) {
  const { names = EVENT_NAMES, strict = true } = options;

  const known = new Set(names);
  const listeners = new Map();
  let isStrict = strict !== false;

  /** @returns {boolean} whether the caller should proceed */
  function checkName(operation, name) {
    if (known.has(name)) return true;
    const message = `events.${operation}: unknown event "${name}". Known: ${[...known].join(", ")}`;
    if (isStrict) throw new Error(message);
    console.warn(message);
    return false;
  }

  function bucket(name) {
    let set = listeners.get(name);
    if (!set) {
      set = new Set();
      listeners.set(name, set);
    }
    return set;
  }

  /**
   * @param {string} name
   * @param {Function} listener
   * @returns {function(): void} unsubscribe
   */
  function on(name, listener) {
    if (!checkName("on", name)) return () => {};
    if (typeof listener !== "function") throw new Error(`events.on("${name}"): listener must be a function`);
    bucket(name).add(listener);
    return () => off(name, listener);
  }

  function off(name, listener) {
    if (!checkName("off", name)) return;
    const set = listeners.get(name);
    if (set) set.delete(listener);
  }

  /** Subscribe for exactly one emission. */
  function once(name, listener) {
    if (!checkName("once", name)) return () => {};
    if (typeof listener !== "function") throw new Error(`events.once("${name}"): listener must be a function`);
    const wrapped = (payload) => {
      off(name, wrapped);
      listener(payload);
    };
    bucket(name).add(wrapped);
    return () => off(name, wrapped);
  }

  /**
   * Emit to every listener.
   *
   * A listener that throws is logged and the rest still run: one broken panel
   * must not stop the scene from rebuilding. The snapshot means a listener that
   * unsubscribes during emission does not disturb the iteration.
   * @returns {number} how many listeners ran
   */
  function emit(name, payload) {
    if (!checkName("emit", name)) return 0;
    const set = listeners.get(name);
    if (!set || !set.size) return 0;
    let ran = 0;
    for (const listener of Array.from(set)) {
      ran += 1;
      try {
        listener(payload);
      } catch (err) {
        console.error(`events: listener for "${name}" threw:`, err);
      }
    }
    return ran;
  }

  /** Listener count, for tests and the dev panel. */
  function listenerCount(name) {
    const set = listeners.get(name);
    return set ? set.size : 0;
  }

  /**
   * Turn the unknown-name throw into a warning.
   *
   * §4.1 asks for throw-in-dev and warn-in-prod. The bundle has no dev/prod
   * split today, so nothing calls this and unknown names throw everywhere —
   * which is the stricter half. Guessing at a prod signal and getting it wrong
   * would disable the check in exactly the build where a silent no-op costs the
   * most, so the switch exists and stays off until there is a real signal.
   */
  function setStrict(next) {
    isStrict = next !== false;
  }

  function removeAll(name) {
    if (name === undefined) listeners.clear();
    else if (checkName("removeAll", name)) listeners.delete(name);
  }

  return { on, off, once, emit, listenerCount, setStrict, removeAll, names: [...known] };
}
