// Engine entry point (SPEC §3.1). Installs window.KS, wires the Phase 1 core,
// and defines KS.boot.
import { installNamespace } from "./core/namespace.js";
import { mountBootCube } from "./dev/boot-cube.js";
import * as document_ from "./core/document.js";
import { createStore } from "./core/store.js";
import { createEventBus } from "./core/events.js";
import { createCommandBus } from "./core/commands.js";
import * as buildCommands from "./core/build-commands.js";
import * as migrations from "./persistence/migrations.js";
import * as codec from "./persistence/codec.js";
import * as chunker from "./persistence/chunker.js";
import { callServer } from "./persistence/transport.js";
import { saveBuild } from "./persistence/save.js";
import { loadBuild } from "./persistence/load.js";
import { summarize } from "./persistence/stats.js";

const KS = installNamespace();

// Core (§4.1). The store opens over an empty document from §6 rather than over
// nothing, so `KS.store` and `KS.commands` are usable the moment the bundle
// loads and no later ticket has to special-case a null document. Opening a
// saved build replaces it through `store.replaceDocument`; `KS.boot` does not
// create one.
KS.events = createEventBus();
KS.document = document_;
KS.store = createStore(document_.createBuildDocument(), { events: KS.events });
KS.commands = createCommandBus({ store: KS.store, events: KS.events });
KS.buildCommands = buildCommands;
KS.migrations = migrations;

// Persistence transport (SPEC §6.4, §14.2). Not yet wired to the store — that
// arrives with the builds screen.
KS.persistence = { codec, chunker, callServer, saveBuild, loadBuild, summarize };

/**
 * Boot the app: log the launch parameters once and mount the Phase 0 cube.
 * @param {{ tag?: string, channel?: string, user?: string }} [opts]
 */
KS.boot = function boot({ tag, channel, user } = {}) {
  console.log("[KS] boot", { tag, channel, user });
  const root = document.getElementById("ks-root");
  if (!root) {
    throw new Error("KS.boot: #ks-root element not found");
  }
  mountBootCube(root);
};
