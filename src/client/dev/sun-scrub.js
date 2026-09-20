// `?dev=sun` (ticket 008 §2).
//
// Scrubs time of day 0→24 through the real `SetEnvironment` command, so the
// sky, the sun, the shadows and the exposure are all exercised end to end
// before any UI exists to drive them. It is a dev route, not a UI: the top bar
// slider in §13.2 replaces it.
import { SetEnvironment } from "../core/build-commands.js";
import { computeSunPosition } from "../engine/sun.js";

/** Seconds of wall clock for one full 24-hour sweep. */
export const SCRUB_SECONDS = 24;

/**
 * @param {{store: !Object, commands: !Object, scene: !Object, host: !HTMLElement,
 *          window?: !Object, autoplay?: boolean}} options
 */
export function runSunScrub(options) {
  const { store, commands, scene, host, window: win = window, autoplay = true } = options;

  const readout = host.ownerDocument.createElement("div");
  readout.id = "ks-sun-scrub";
  readout.setAttribute("style", [
    "position:fixed", "left:16px", "bottom:16px", "z-index:50",
    "font:14px/1.4 system-ui,-apple-system,'Segoe UI',Roboto,sans-serif",
    "background:rgba(39,48,58,0.82)", "color:#fff", "padding:10px 14px",
    "border-radius:8px", "font-variant-numeric:tabular-nums",
  ].join(";"));
  host.appendChild(readout);

  let playing = autoplay;
  let raf = 0;
  let last = null;

  /** Set the clock through the command bus, exactly as the UI slider will. */
  function setTimeOfDay(hour) {
    const wrapped = ((hour % 24) + 24) % 24;
    commands.run(SetEnvironment({ timeOfDay: Math.round(wrapped * 100) / 100 }));
    paint();
  }

  function paint() {
    const environment = store.get("lot.environment");
    const position = computeSunPosition({
      ...environment,
      orientationDeg: store.get("lot.orientationDeg"),
    });
    const hour = Math.floor(environment.timeOfDay);
    const minute = Math.round((environment.timeOfDay - hour) * 60);
    readout.textContent =
      `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}` +
      `  ·  elevation ${position.elevationDeg.toFixed(1)}°` +
      `  ·  azimuth ${position.azimuthDeg.toFixed(0)}°` +
      `  ·  ${playing ? "playing" : "paused"} (space)`;
  }

  function frame(now) {
    if (!playing) return;
    if (last === null) last = now;
    const dt = (now - last) / 1000;
    last = now;
    setTimeOfDay(store.get("lot.environment.timeOfDay") + (24 / SCRUB_SECONDS) * dt);
    raf = win.requestAnimationFrame(frame);
  }

  function toggle() {
    playing = !playing;
    last = null;
    paint();
    if (playing) raf = win.requestAnimationFrame(frame);
    else win.cancelAnimationFrame(raf);
  }

  function onKey(event) {
    // Space is a camera key (§12), but the camera only claims it in free mode
    // and this route exists to be driven by hand.
    if (event.code === "Space") {
      event.preventDefault();
      toggle();
    }
  }
  win.addEventListener("keydown", onKey);

  // Follow the store rather than only our own writes: the environment can be
  // changed from the console or a later UI, and a readout that silently lags
  // the scene is worse than no readout — it was showing 00:10 while the sky
  // was at 21:00.
  const unsubscribe = store.on("change", (change) => {
    if (change.dirtyCategories.has("environment")) paint();
  });

  setTimeOfDay(0);
  if (playing) raf = win.requestAnimationFrame(frame);

  return {
    setTimeOfDay,
    toggle,
    get playing() {
      return playing;
    },
    dispose() {
      win.cancelAnimationFrame(raf);
      unsubscribe();
      win.removeEventListener("keydown", onKey);
      readout.remove();
      if (scene) scene.view.requestRender();
    },
  };
}
