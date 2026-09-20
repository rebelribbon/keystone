// Sky dome (SPEC §8.1, §8.2).
//
// A shader dome rather than a cube map: it recolours per frame from one sun
// elevation with no texture loads, which is what lets the time-of-day scrub in
// `?dev=sun` run smoothly and what keeps §2's "nothing to host" promise.
import { getTHREE } from "./three.js";
import { computeSunPosition, skyPalette } from "./sun.js";

export { computeSunPosition, skyPalette };

/** Radius of the dome, in metres. Sits well outside the ground ring. */
export const SKY_RADIUS = 1200;
export const STAR_COUNT = 900;

/**
 * How much to lift the sky before ACES compresses it (§8.1).
 *
 * Measured, not guessed: ACES maps a mid-blue of ~0.45 linear down to ~0.30,
 * which reads as overcast slate at midday. 1.75 puts the rendered sky back at
 * the colour the palette names.
 */
export const ACES_GAIN = 1.75;

const VERTEX_SHADER = `
  varying vec3 vWorld;
  void main() {
    vWorld = normalize((modelMatrix * vec4(position, 1.0)).xyz - cameraPosition);
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

// Gradient + sun disc + horizon haze, per §8.1. The haze term is what keeps
// the join between the dome and the ground ring from reading as a hard seam.
const FRAGMENT_SHADER = `
  uniform vec3 uZenith;
  uniform vec3 uHorizon;
  uniform vec3 uSunTint;
  uniform vec3 uSunDirection;
  uniform float uExposureGain;
  varying vec3 vWorld;

  void main() {
    vec3 dir = normalize(vWorld);
    float up = clamp(dir.y * 0.5 + 0.5, 0.0, 1.0);
    float gradient = pow(clamp(dir.y, 0.0, 1.0), 0.45);
    vec3 color = mix(uHorizon, uZenith, gradient);

    // Horizon haze: brighten the band either side of y = 0.
    float haze = exp(-abs(dir.y) * 9.0);
    color = mix(color, uHorizon, haze * 0.55);

    // Sun disc plus glow, tinted by the palette so a low sun reddens.
    float cosAngle = dot(dir, normalize(uSunDirection));
    float disc = smoothstep(0.9995, 0.99985, cosAngle);
    float glow = pow(max(cosAngle, 0.0), 220.0) * 0.6 + pow(max(cosAngle, 0.0), 12.0) * 0.12;
    color += uSunTint * (disc * 2.5 + glow);

    // Below the horizon the dome darkens toward the ground rather than
    // showing the mirrored gradient.
    color *= mix(0.45, 1.0, up);

    // ACES tone mapping (§8.1) is applied to everything the renderer draws,
    // and it compresses midtones hard — the palette's colours are chosen as
    // the sky should *look*, so they are pre-scaled here to survive it.
    // Without this a clear afternoon sky comes out slate grey.
    color *= uExposureGain;

    gl_FragColor = vec4(color, 1.0);
  }
`;

/**
 * Build the sky dome and its stars.
 * @returns {{group: !Object, apply: function(!Object): !Object, dispose: function(): void}}
 */
export function buildSky() {
  const THREE = getTHREE();

  const geometry = new THREE.SphereGeometry(SKY_RADIUS, 32, 16);
  const material = new THREE.ShaderMaterial({
    vertexShader: VERTEX_SHADER,
    fragmentShader: FRAGMENT_SHADER,
    uniforms: {
      uZenith: { value: new THREE.Color(0x3d78c8) },
      uHorizon: { value: new THREE.Color(0xbcd7ea) },
      uSunTint: { value: new THREE.Color(0xffffff) },
      uSunDirection: { value: new THREE.Vector3(0, 1, 0) },
      uExposureGain: { value: ACES_GAIN },
    },
    side: THREE.BackSide,
    depthWrite: false,
    fog: false,
  });
  const dome = new THREE.Mesh(geometry, material);
  dome.name = "ks-sky";
  // The dome must not be culled when the camera sits inside it.
  dome.frustumCulled = false;

  // §8.1 night: stars as points. Northern hemisphere only — they are scattered
  // over the upper half so none appear underground.
  const starPositions = new Float32Array(STAR_COUNT * 3);
  for (let i = 0; i < STAR_COUNT; i += 1) {
    const theta = Math.random() * Math.PI * 2;
    const y = Math.random() * 0.95 + 0.05;
    const r = Math.sqrt(1 - y * y);
    starPositions[i * 3] = Math.cos(theta) * r * SKY_RADIUS * 0.95;
    starPositions[i * 3 + 1] = y * SKY_RADIUS * 0.95;
    starPositions[i * 3 + 2] = Math.sin(theta) * r * SKY_RADIUS * 0.95;
  }
  const starGeometry = new THREE.BufferGeometry();
  starGeometry.setAttribute("position", new THREE.BufferAttribute(starPositions, 3));
  const starMaterial = new THREE.PointsMaterial({
    color: 0xffffff,
    size: 2.2,
    sizeAttenuation: false,
    transparent: true,
    opacity: 0,
    depthWrite: false,
    fog: false,
  });
  const stars = new THREE.Points(starGeometry, starMaterial);
  stars.name = "ks-stars";
  stars.frustumCulled = false;

  const group = new THREE.Group();
  group.name = "ks-sky-group";
  group.add(dome, stars);

  return {
    group,
    dome,
    stars,
    /**
     * Recolour from a §6 environment. Returns the sun position and palette so
     * the renderer can drive lights, shadows and exposure from the same values
     * rather than recomputing them.
     * @param {{timeOfDay: number, latitude: number, season: string}} environment
     * @param {number} orientationDeg
     */
    apply(environment, orientationDeg = 0) {
      const sun = computeSunPosition({ ...environment, orientationDeg });
      const palette = skyPalette(sun.elevationDeg);

      material.uniforms.uZenith.value.set(palette.zenith);
      material.uniforms.uHorizon.value.set(palette.horizon);
      material.uniforms.uSunTint.value.set(palette.sunTint);
      material.uniforms.uSunDirection.value.set(sun.direction.x, sun.direction.y, sun.direction.z);
      starMaterial.opacity = palette.starOpacity;
      stars.visible = palette.starOpacity > 0.01;

      return { sun, palette };
    },
    dispose() {
      geometry.dispose();
      material.dispose();
      starGeometry.dispose();
      starMaterial.dispose();
      group.clear();
    },
  };
}
