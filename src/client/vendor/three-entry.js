// Vendor entry: bundles Three.js and exposes it as the single global THREE.
// This is the only bundle that contains Three.js; every other bundle reads
// window.THREE at runtime so Three ships exactly once (SPEC §3).
import * as THREE from "three";

window.THREE = THREE;
