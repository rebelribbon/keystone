// Engine entry point (SPEC §3.1). Installs window.KS, exposes the persistence
// transport, and defines KS.boot. No store, commands, or events yet — those
// arrive in Phase 1.
import { installNamespace } from "./core/namespace.js";
import { mountBootCube } from "./dev/boot-cube.js";
import * as codec from "./persistence/codec.js";
import * as chunker from "./persistence/chunker.js";
import { callServer } from "./persistence/transport.js";
import { saveBuild } from "./persistence/save.js";
import { loadBuild } from "./persistence/load.js";

const KS = installNamespace();

// Persistence transport (SPEC §6.4, §14.2). The Store that will feed it arrives
// in Phase 1; for now the gate 3 harness is the only caller.
KS.persistence = { codec, chunker, callServer, saveBuild, loadBuild };

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
