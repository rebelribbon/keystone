// The command bus (SPEC §7, §4.1).
//
// Every state change in Keystone is a Command, and this is the only thing that
// can open the Store's write window. §7's surface is `run`, `group`, `undo`,
// `redo`; the rest here is what those four need to be safe.
import { TRANSACT } from "./store.js";

/**
 * @typedef {{
 *   type: string,
 *   label: string,
 *   do: function(!Object): void,
 *   undo?: function(!Object): void,
 *   undoable?: boolean,
 *   merge?: function(!Object): boolean
 * }} Command
 */

/** §4.1: unlimited within a session, capped in memory. */
export const UNDO_LIMIT = 500;

function isCommand(value) {
  return value !== null && typeof value === "object" && typeof value.do === "function";
}

/**
 * Create the command bus over a store.
 * @param {{store: !Object, events?: {emit: Function}, limit?: number}} options
 */
export function createCommandBus(options) {
  const { store, events = null, limit = UNDO_LIMIT } = options;
  if (!store || typeof store[TRANSACT] !== "function") {
    throw new Error("createCommandBus: needs a store from createStore()");
  }
  const transact = store[TRANSACT];

  /** Undo stack of entries: { kind: "command"|"group", ... }. */
  const undoStack = [];
  const redoStack = [];

  /** Group frames, innermost last. Empty when not grouping. */
  const groups = [];

  /**
   * The entry the next `merge` may fold into, or null.
   *
   * Cleared by anything that breaks the "immediately previous command" rule: a
   * different command running, a group opening or closing, an undo, a redo, a
   * document replacement. Without this, a terrain stroke would merge into a
   * command the user ran five actions ago and undo would jump.
   */
  let mergeTarget = null;

  function validate(cmd) {
    if (!isCommand(cmd)) {
      throw new Error("commands.run: expected a Command with a do(store) function");
    }
    if (typeof cmd.label !== "string" || !cmd.label) {
      throw new Error(`commands.run: command "${cmd.type}" needs a label for the history panel (§13.2)`);
    }
    const undoable = cmd.undoable !== false;
    if (undoable && typeof cmd.undo !== "function") {
      throw new Error(
        `commands.run: "${cmd.type}" has no undo(). If that is deliberate, set ` +
          "undoable: false so it is a decision and not an omission (§7, SetEnvironment)."
      );
    }
    return undoable;
  }

  /**
   * Execute a command body, restoring the document if it throws.
   *
   * The document is immutable, so the snapshot is one reference and the restore
   * is one assignment: a half-applied command cannot survive, which is what §7
   * needs for "must leave the store exactly as it was".
   */
  function attempt(fn) {
    const before = store.getDocument();
    try {
      transact(fn);
    } catch (err) {
      if (store.getDocument() !== before) store.replaceDocument(before, { silent: true });
      throw err;
    }
  }

  function pushUndo(entry) {
    undoStack.push(entry);
    while (undoStack.length > limit) undoStack.shift();
  }

  /**
   * Run a command (§7). Executes, records it, and clears the redo stack.
   * @param {Command} cmd
   * @returns {Command}
   */
  function run(cmd) {
    const undoable = validate(cmd);

    // Merge into the immediately previous command when it says so. Only a bare
    // command entry at the top qualifies — never across a group boundary, and
    // never after an undo, because mergeTarget is cleared by both.
    if (
      mergeTarget &&
      groups.length === 0 &&
      undoStack.length &&
      undoStack[undoStack.length - 1] === mergeTarget &&
      mergeTarget.kind === "command" &&
      typeof mergeTarget.command.merge === "function" &&
      mergeTarget.command.merge(cmd) === true
    ) {
      attempt(() => cmd.do(store));
      redoStack.length = 0;
      return cmd;
    }

    attempt(() => cmd.do(store));
    redoStack.length = 0;

    const entry = { kind: "command", command: cmd, undoable };
    if (groups.length) {
      groups[groups.length - 1].entries.push(entry);
      mergeTarget = null;
    } else {
      pushUndo(entry);
      mergeTarget = entry;
    }
    return cmd;
  }

  /**
   * Run `fn`; every command inside becomes one undo step labelled `label` (§7).
   * Nested groups collapse into the outermost — the user pressed one button, so
   * they get one undo.
   * @param {string} label
   * @param {function(): *} fn
   */
  function group(label, fn) {
    if (typeof label !== "string" || !label) throw new Error("commands.group: needs a label");
    if (typeof fn !== "function") throw new Error("commands.group: needs a function");

    mergeTarget = null;
    const frame = { label, entries: [] };
    groups.push(frame);

    let result;
    try {
      result = fn();
    } catch (err) {
      groups.pop();
      // Undo whatever the group managed before it failed, newest first, so a
      // half-built group is not left on screen or on the stack.
      for (let i = frame.entries.length - 1; i >= 0; i -= 1) {
        const entry = frame.entries[i];
        if (entry.undoable) transact(() => entry.command.undo(store));
      }
      throw err;
    }
    groups.pop();

    if (!frame.entries.length) return result;

    const entry = { kind: "group", label, entries: frame.entries };
    if (groups.length) groups[groups.length - 1].entries.push(...frame.entries);
    else pushUndo(entry);
    mergeTarget = null;
    return result;
  }

  /** Reverse one entry, newest command first within a group. */
  function undoEntry(entry) {
    if (entry.kind === "group") {
      transact(() => {
        for (let i = entry.entries.length - 1; i >= 0; i -= 1) {
          const child = entry.entries[i];
          if (child.undoable) child.command.undo(store);
        }
      });
      return true;
    }
    if (!entry.undoable) return false;
    transact(() => entry.command.undo(store));
    return true;
  }

  function redoEntry(entry) {
    if (entry.kind === "group") {
      transact(() => {
        for (const child of entry.entries) child.command.do(store);
      });
      return;
    }
    transact(() => entry.command.do(store));
  }

  /**
   * Undo one step (§7).
   *
   * A non-undoable entry (§7's `SetEnvironment`) is popped and passed over, and
   * the undo continues to the previous undoable step — the user pressed undo and
   * expects something to change, not for the key to do nothing because the last
   * recorded action happened to be a time-of-day tweak.
   * @returns {boolean} whether anything was undone
   */
  function undo() {
    mergeTarget = null;
    while (undoStack.length) {
      const entry = undoStack.pop();
      redoStack.push(entry);
      if (undoEntry(entry)) return true;
    }
    return false;
  }

  /** Redo one step (§7). @returns {boolean} */
  function redo() {
    mergeTarget = null;
    while (redoStack.length) {
      const entry = redoStack.pop();
      undoStack.push(entry);
      redoEntry(entry);
      if (entry.kind === "group" || entry.undoable) return true;
    }
    return false;
  }

  /**
   * Labels for the history panel (§13.2), newest first.
   * @returns {!Array<{label: string, type: string, undoable: boolean}>}
   */
  function history() {
    return undoStack
      .slice()
      .reverse()
      .map((entry) =>
        entry.kind === "group"
          ? { label: entry.label, type: "Group", undoable: true }
          : { label: entry.command.label, type: entry.command.type, undoable: entry.undoable }
      );
  }

  function canUndo() {
    return undoStack.some((entry) => entry.kind === "group" || entry.undoable);
  }

  function canRedo() {
    return redoStack.length > 0;
  }

  /** Drop both stacks — for opening a different build. */
  function clear() {
    undoStack.length = 0;
    redoStack.length = 0;
    groups.length = 0;
    mergeTarget = null;
  }

  return { run, group, undo, redo, history, canUndo, canRedo, clear, limit };
}
