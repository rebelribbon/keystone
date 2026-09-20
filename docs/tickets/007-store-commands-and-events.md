# 007 — Store, commands, and events
Phase: 1 · Tag: normal · Spec sections: §0.3, §4.1, §6, §6.4, §7, §16, §18

## Goal

Build the three modules every later ticket hooks into: the Store that holds the Build document, the command bus that is the only way state ever changes, and the event bus. Nothing renders, nothing is drawn, nothing is saved to Drive. The deployed page still boots the Phase 0 cube.

This is the ticket that makes SPEC §0.3 — "every state mutation goes through a Command" — enforceable rather than aspirational. Get the contracts right here and the rest of Phase 1 is plumbing; get them wrong and every tool written afterward inherits the mistake.

All of it is pure logic, so unlike everything in Phase 0 it is fully testable in the cloud session. There is no gate and no deploy step.

## Requirements

### 1. `src/client/core/document.js`

- `SCHEMA_VERSION = 1`.
- `createBuildDocument({ name, lotSize, primaryStyle, owner, units })` returns a complete, valid, empty Build document matching §6 exactly: `meta`, `lot` (with one flat terrain heightmap at resolution 2 and a 4-layer splat), one level `lv_0`, empty `roofs` / `objects` / `paths` / `pools`, and a default `camera`. Field names, nesting, and types are locked by §6 and must match it character for character.
- `newId(prefix)` mints short random IDs with the §6 type prefixes (`b_`, `lv_`, `n_`, `w_`, `r_`, `rf_`, `op_`, `o_`). Collision-resistant within a document; do not use a global counter, because IDs must survive load and merge.
- `serialize(doc)` → JSON string, `deserialize(str)` → document. Byte-stable key ordering, so two identical documents produce identical strings and a save that changes nothing produces no diff.

### 2. `src/client/core/store.js`

- `createStore(doc)` holding the document.
- Reads: `get(path)` with a dotted or array path, `getDocument()` returning a frozen view.
- Writes: `setIn(path, value)` and `updateIn(path, fn)`, immutable-style — the previous document object must not be mutated, and unaffected subtrees must be reference-identical to their previous versions. A test asserts both.
- **Writes are only callable from within a command's `do` or `undo`.** The store tracks whether a command is currently executing and throws on any mutation outside one. This is how §0.3 stops being a convention. Tools, panels, and content code must physically be unable to write.
- `change` events carry `{ dirtyIds: Set<string>, dirtyCategories: Set<string> }`. Categories are drawn from a fixed list: `walls`, `nodes`, `rooms`, `floorTiles`, `openings`, `roofs`, `objects`, `terrain`, `levels`, `meta`, `camera`, `environment`. Derive the category from the mutated path rather than asking the caller to declare it; a caller-declared category drifts from reality the first time someone forgets.
- Batch changes within a command into one `change` emission at the end, not one per `setIn`.

### 3. `src/client/core/commands.js`

Implement the §7 surface exactly:

```js
KS.commands.run(cmd)
KS.commands.group(label, fn)
KS.commands.undo() / redo()
```

- `Command` is `{ type, label, do(store), undo(store), merge?(next) }`.
- `run` executes, pushes to the undo stack, and clears the redo stack.
- `group(label, fn)` makes every command run inside `fn` one undo step with that label. Groups nest; the outermost label wins.
- `merge(next)` returning `true` folds the next command into the current top of the stack instead of pushing — for continuous strokes. Merging is only attempted against the immediately previous command, only when no other command has run in between, and never across a group boundary.
- Undo stack capped at 500 entries in memory, oldest dropped. Redo unlimited until cleared.
- `history()` returns the label list for the UI history panel (§13.2), newest first.
- A command whose `do` throws must leave the store exactly as it was and must not be pushed to the stack. Wrap execution so a partial mutation cannot survive.

### 4. `src/client/core/events.js`

Typed event bus with `on`, `off`, `once`, `emit`. The event names in §4.1: `tool:changed`, `level:changed`, `view:changed`, `selection:changed`, `build:saved`, plus `store:change`. Emitting an unregistered event name throws in dev and warns in prod, so typos surface instead of silently doing nothing. A throwing listener must not prevent the other listeners from running.

### 5. Two real commands

Not placeholders — two of the §7 required list that need no geometry:

- `SetLevelProps` — undoable, captures the previous values in `do` and restores them in `undo`.
- `SetEnvironment` — §7 marks it "not undoable, but recorded", so it runs and appears in history but is skipped by `undo`. Implementing it now forces the stack to handle a non-undoable entry from the start rather than having that case bolted on later.

### 6. `src/client/persistence/migrations.js`

- Exports an ordered array of `{ from, to, migrate(doc) }`. Empty at `SCHEMA_VERSION = 1`.
- `runMigrations(doc)` applies them in order, throws a clear error on a document whose `schema` is **newer** than `SCHEMA_VERSION` (a build saved by a future client), and passes a current-schema document through untouched.

Writing the runner now, with no migrations in it, means the first real migration is a data change rather than an infrastructure change written under pressure.

### 7. Wiring

`main.js` exposes `KS.store`, `KS.commands`, `KS.events`, and `KS.document` on the namespace. `KS.boot` still mounts the Phase 0 cube and does not create a document. Nothing in this ticket touches the server, the loader, or the deployed behavior.

## Out of scope

- Every other command in the §7 list. They arrive with the tools that need them.
- Scene sync, picking, geometry, camera, sky, graphics presets.
- Wiring the store to `save.js` / `load.js`, autosave, recovery copies, the builds screen.
- The UI history panel. `history()` exists; nothing renders it.
- Terrain sculpting or painting. The document carries a flat heightmap; nothing edits it.

## Acceptance

- [ ] `npm test` and `npm run build` pass. No change to the deployed page's behavior.
- [ ] **Undo symmetry (§18):** for both commands, and for a generated sequence of at least 50 randomized runs, `do` then `undo` returns a document deep-equal to the original. This is the single most important test in the ticket.
- [ ] Redo after undo restores the exact post-`do` document, deep-equal.
- [ ] `run` after `undo` clears the redo stack.
- [ ] A mutation attempted outside a command throws.
- [ ] `setIn` leaves the previous document unmutated, and an unaffected subtree is reference-identical across the write.
- [ ] Dirty categories are derived correctly for at least eight distinct paths, including a nested `levels[0].walls.w_1` write producing `walls` and not `levels`.
- [ ] One `change` event per command, not one per `setIn`, verified by listener call count.
- [ ] `group` collapses N commands into one undo step with the group's label; nested groups collapse to the outermost.
- [ ] A mergeable test command merges only against the immediately previous command, not across an intervening command and not across a group boundary.
- [ ] The 500-entry cap drops oldest entries and leaves undo working at the boundary.
- [ ] A command whose `do` throws leaves the store deep-equal to its prior state and is absent from `history()`.
- [ ] `SetEnvironment` appears in history and is skipped by `undo`, and the undo passes through it to the previous undoable command.
- [ ] A throwing event listener does not stop the remaining listeners; an unknown event name throws in dev.
- [ ] `serialize` → `deserialize` round-trips a populated document deep-equal, and serializing the same document twice produces identical strings.
- [ ] `createBuildDocument` output validates against §6: every field present, correct types, correct nesting, correct ID prefixes.
- [ ] `runMigrations` passes a v1 document through untouched and throws on `schema: 2`.
- [ ] No `TODO` in `src/`, no `localStorage`, no secrets.

## Handoff (Builder fills in)
