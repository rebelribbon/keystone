// Engine entry point (SPEC §3.1). Installs window.KS and defines KS.boot.
// No store, commands, events, or persistence in this ticket — those arrive
// in Phase 1.
import { installNamespace } from "./core/namespace.js";
import { mountBootCube } from "./dev/boot-cube.js";

const KS = installNamespace();

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
