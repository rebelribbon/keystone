// Concrete commands (SPEC §7).
//
// Two of §7's required list, chosen because they need no geometry: one ordinary
// undoable command, and the one entry §7 marks "not undoable, but recorded".
// The rest arrive with the tools that need them.
//
// The pattern every later command follows: `do` captures what it is about to
// overwrite, `undo` puts exactly that back. Capturing in `do` rather than at
// construction is what makes redo correct — the command may run again against a
// document that has moved on.

/**
 * Change a level's properties (§7 `SetLevelProps`).
 * @param {number} levelIndex
 * @param {!Object<string,*>} props partial level fields, e.g. { wallHeight: 3.2 }
 * @returns {!Object} a Command
 */
export function SetLevelProps(levelIndex, props) {
  const keys = Object.keys(props || {});
  if (!keys.length) throw new Error("SetLevelProps: no properties given");

  let previous = null;

  return {
    type: "SetLevelProps",
    label: keys.length === 1 ? `Changed level ${keys[0]}` : `Changed ${keys.length} level properties`,

    do(store) {
      const level = store.get(["levels", levelIndex]);
      if (!level) throw new Error(`SetLevelProps: no level at index ${levelIndex}`);

      // Captured on every run, so a redo after other edits restores against the
      // document as it is now rather than as it was when the command was built.
      previous = {};
      for (const key of keys) previous[key] = level[key];

      for (const key of keys) store.setIn(["levels", levelIndex, key], props[key]);
    },

    undo(store) {
      if (!previous) throw new Error("SetLevelProps: undo before do");
      for (const key of keys) store.setIn(["levels", levelIndex, key], previous[key]);
    },
  };
}

/**
 * Change the lot environment (§7 `SetEnvironment`, "not undoable, but
 * recorded").
 *
 * Time of day and sky are view settings rather than build content: undoing a
 * wall should not also wind the sun back, and the history panel should still
 * show that it happened. `undoable: false` is what makes that explicit rather
 * than looking like a missing `undo`.
 * @param {!Object<string,*>} patch partial §6 `lot.environment`
 * @returns {!Object} a Command
 */
export function SetEnvironment(patch) {
  const keys = Object.keys(patch || {});
  if (!keys.length) throw new Error("SetEnvironment: no properties given");

  return {
    type: "SetEnvironment",
    label: keys.length === 1 ? `Set ${keys[0]}` : "Changed environment",
    undoable: false,

    do(store) {
      for (const key of keys) store.setIn(["lot", "environment", key], patch[key]);
    },
  };
}
