// Sun position (SPEC §8.2).
//
// Pure math, in its own module and importing nothing. §8.2 calls for a
// solstice/equinox approximation, and the ticket requires this be separable
// from anything touching Three.js — so the sky, the shadow camera, the lights
// and the exposure all read from here, and the tests call it directly with no
// WebGL context anywhere.

const DEG = Math.PI / 180;

/** Earth's axial tilt. The whole approximation rests on this one number. */
export const AXIAL_TILT_DEG = 23.44;

/**
 * Solar declination per §8.2's season approximation.
 * Spring and autumn are equinoxes, so both are zero.
 */
export const SEASON_DECLINATION_DEG = Object.freeze({
  spring: 0,
  summer: AXIAL_TILT_DEG,
  autumn: 0,
  fall: 0,
  winter: -AXIAL_TILT_DEG,
});

/** Pure. Wrap degrees into [0, 360). */
export function normalizeDegrees(value) {
  const wrapped = Number(value) % 360;
  return wrapped < 0 ? wrapped + 360 : wrapped;
}

/**
 * Pure. Where the sun is, for a lot.
 *
 * Returns lot-space angles: `azimuth` is measured from the lot's north edge,
 * clockwise through east, so that a lot rotated by `orientationDeg` sees the
 * sun swing the opposite way — rotating the building is the same as rotating
 * the sky around it.
 *
 * @param {{timeOfDay?: number, latitude?: number, season?: string,
 *          orientationDeg?: number}} environment §6 `lot.environment` plus
 *          §6 `lot.orientationDeg`
 * @returns {{elevationDeg: number, azimuthDeg: number, declinationDeg: number,
 *            hourAngleDeg: number, direction: {x: number, y: number, z: number},
 *            aboveHorizon: boolean}}
 */
export function computeSunPosition(environment = {}) {
  const {
    timeOfDay = 12,
    latitude = 30,
    season = "summer",
    orientationDeg = 0,
  } = environment;

  const key = String(season).toLowerCase();
  const declinationDeg = SEASON_DECLINATION_DEG[key] === undefined ? 0 : SEASON_DECLINATION_DEG[key];

  // Local solar time: noon is overhead, each hour is 15° of rotation.
  const hourAngleDeg = (Number(timeOfDay) - 12) * 15;

  const lat = Number(latitude) * DEG;
  const dec = declinationDeg * DEG;
  const hour = hourAngleDeg * DEG;

  const sinElevation = Math.sin(dec) * Math.sin(lat) + Math.cos(dec) * Math.cos(lat) * Math.cos(hour);
  const elevation = Math.asin(Math.max(-1, Math.min(1, sinElevation)));

  // Azimuth measured from due south, positive toward west — the standard solar
  // form — then turned into a compass bearing from north.
  const azimuthFromSouth = Math.atan2(
    Math.sin(hour),
    Math.cos(hour) * Math.sin(lat) - Math.tan(dec) * Math.cos(lat)
  );
  const compassDeg = normalizeDegrees(azimuthFromSouth / DEG + 180);

  // The lot's own frame. Rotating the lot east by `orientationDeg` puts the sun
  // that many degrees further west in lot coordinates.
  const azimuthDeg = normalizeDegrees(compassDeg - Number(orientationDeg));

  // §5 axes: +X east, +Z south, north = −Z, Y up.
  const azimuth = azimuthDeg * DEG;
  const cosElevation = Math.cos(elevation);

  return {
    elevationDeg: elevation / DEG,
    azimuthDeg,
    declinationDeg,
    hourAngleDeg,
    direction: {
      x: cosElevation * Math.sin(azimuth),
      y: Math.sin(elevation),
      z: -cosElevation * Math.cos(azimuth),
    },
    aboveHorizon: elevation > 0,
  };
}

/** Pure. Clamp to a range. */
function clamp(value, min, max) {
  return value < min ? min : value > max ? max : value;
}

/** Pure. Linear interpolation. */
function mix(a, b, t) {
  return a + (b - a) * t;
}

/** Pure. Blend two `#rrggbb` strings. */
function mixHex(from, to, t) {
  const parse = (hex) => {
    const n = parseInt(String(hex).replace("#", ""), 16);
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  };
  const [ar, ag, ab] = parse(from);
  const [br, bg, bb] = parse(to);
  const channel = (a, b) => Math.round(clamp(mix(a, b, t), 0, 255));
  const out = (channel(ar, br) << 16) | (channel(ag, bg) << 8) | channel(ab, bb);
  return "#" + out.toString(16).padStart(6, "0");
}

/** Sky keyframes by sun elevation, darkest first (§8.1: night is deep blue). */
const SKY_STOPS = [
  { elevationDeg: -18, zenith: "#040814", horizon: "#0a1026", sunTint: "#0a1026", exposure: 0.55 },
  { elevationDeg: -6, zenith: "#0b1735", horizon: "#33304f", sunTint: "#6b4a6a", exposure: 0.7 },
  { elevationDeg: 0, zenith: "#2b4a7a", horizon: "#c98a5e", sunTint: "#ff9d5c", exposure: 0.85 },
  { elevationDeg: 12, zenith: "#4f86c6", horizon: "#d8c39c", sunTint: "#ffd9a0", exposure: 1.0 },
  { elevationDeg: 45, zenith: "#3d78c8", horizon: "#bcd7ea", sunTint: "#fff4e0", exposure: 1.0 },
  { elevationDeg: 90, zenith: "#2f6bc4", horizon: "#c6dcee", sunTint: "#ffffff", exposure: 1.0 },
];

/**
 * Pure. Sky colours, light intensities and tone-mapping exposure for a sun
 * elevation. §8.1 wants exposure to track time of day; deriving it here rather
 * than in the renderer keeps every visual consequence of the sun in one
 * testable place.
 * @param {number} elevationDeg
 * @returns {{zenith: string, horizon: string, sunTint: string, exposure: number,
 *            sunIntensity: number, hemiIntensity: number, ambientIntensity: number,
 *            starOpacity: number, fog: string}}
 */
export function skyPalette(elevationDeg) {
  const e = Number(elevationDeg);
  let lower = SKY_STOPS[0];
  let upper = SKY_STOPS[SKY_STOPS.length - 1];
  for (let i = 0; i < SKY_STOPS.length - 1; i += 1) {
    if (e >= SKY_STOPS[i].elevationDeg && e <= SKY_STOPS[i + 1].elevationDeg) {
      lower = SKY_STOPS[i];
      upper = SKY_STOPS[i + 1];
      break;
    }
  }
  if (e < SKY_STOPS[0].elevationDeg) lower = upper = SKY_STOPS[0];
  if (e > SKY_STOPS[SKY_STOPS.length - 1].elevationDeg) lower = upper = SKY_STOPS[SKY_STOPS.length - 1];

  const span = upper.elevationDeg - lower.elevationDeg;
  const t = span === 0 ? 0 : clamp((e - lower.elevationDeg) / span, 0, 1);

  // Daylight ramps in over the first few degrees so dawn is not a hard switch.
  const day = clamp((e + 6) / 12, 0, 1);

  return {
    zenith: mixHex(lower.zenith, upper.zenith, t),
    horizon: mixHex(lower.horizon, upper.horizon, t),
    sunTint: mixHex(lower.sunTint, upper.sunTint, t),
    fog: mixHex(lower.horizon, upper.horizon, t),
    exposure: mix(lower.exposure, upper.exposure, t),
    sunIntensity: mix(0, 3.0, day),
    hemiIntensity: mix(0.35, 1.0, day),
    // §8.1: "subtle AmbientLight at night for readability". The number is set
    // by that second word — at 0.25 the lot rendered black under ACES and the
    // 0.55 night exposure, which is atmospheric and useless. 0.9 keeps the
    // grid and the lot edge legible while still reading as night.
    ambientIntensity: mix(0.9, 0.02, day),
    starOpacity: 1 - clamp((e + 12) / 12, 0, 1),
  };
}
