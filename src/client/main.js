// Engine entry point (SPEC §3.1). Installs window.KS, wires the Phase 1 core
// and the scene, and defines KS.boot.
import { installNamespace } from "./core/namespace.js";
import * as document_ from "./core/document.js";
import { createStore } from "./core/store.js";
import { createEventBus } from "./core/events.js";
import { createCommandBus } from "./core/commands.js";
import * as buildCommands from "./core/build-commands.js";
import * as migrations from "./persistence/migrations.js";
import { createLotScene } from "./engine/scene.js";
import * as sun from "./engine/sun.js";
import * as presets from "./engine/presets.js";
import { runSunScrub } from "./dev/sun-scrub.js";
import * as codec from "./persistence/codec.js";
import * as chunker from "./persistence/chunker.js";
import { callServer } from "./persistence/transport.js";
import { saveBuild } from "./persistence/save.js";
import { loadBuild } from "./persistence/load.js";
import { summarize } from "./persistence/stats.js";

const KS = installNamespace();

// Core (§4.1). The store opens over an empty document from §6 rather than over
// nothing, so `KS.store` and `KS.commands` are usable the moment the bundle
// loads; `KS.boot` replaces it with the build being opened.
KS.events = createEventBus();
KS.document = document_;
KS.store = createStore(document_.createBuildDocument(), { events: KS.events });
KS.commands = createCommandBus({ store: KS.store, events: KS.events });
KS.buildCommands = buildCommands;
KS.migrations = migrations;

// Engine (§4.1, §8).
KS.sun = sun;
KS.presets = presets;
KS.scene = null;

// Persistence transport (SPEC §6.4, §14.2). Not yet wired to the store — that
// arrives with the builds screen.
KS.persistence = { codec, chunker, callServer, saveBuild, loadBuild, summarize };

/**
 * Boot the app: create an in-memory build and show its lot.
 *
 * No server call and no persistence: the document lives only in this tab until
 * the save/load ticket lands.
 * @param {{ tag?: string, channel?: string, user?: string, dev?: string,
 *           preset?: string }} [opts]
 */
KS.boot = function boot({ tag, channel, user, dev, preset } = {}) {
  console.log("[KS] boot", { tag, channel, user, dev });

  const root = document.getElementById("ks-root");
  if (!root) {
    throw new Error("KS.boot: #ks-root element not found");
  }

  KS.store.replaceDocument(document_.createBuildDocument({ owner: user || "" }));
  KS.commands.clear();

  KS.scene = createLotScene({ host: root, store: KS.store, events: KS.events, presetId: preset });

  // §8.2's time-of-day scrub, standing in for the top bar that arrives later.
  if (dev === "sun") {
    runSunScrub({ store: KS.store, commands: KS.commands, scene: KS.scene, host: root });
  }

  return KS.scene;
};
