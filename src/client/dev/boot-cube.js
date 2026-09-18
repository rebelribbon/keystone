// Phase 0 gate scene (SPEC §8.1, gate 1). This is a real deliverable, not a
// placeholder: it proves the loader, renderer, lights, and shadows work end to
// end. It lives in src/client/dev/ and is removed by the Phase 1 ticket that
// introduces the real scene. Reads window.THREE (bundled once by vendor-three).

/**
 * Build and mount the lit, shadowed, spinning cube into a host element and
 * start a continuous render loop. Render-on-demand arrives with the real
 * engine in Phase 1 (see docs/DEFERRED.md).
 * @param {HTMLElement} host
 * @returns {{ dispose: () => void }}
 */
export function mountBootCube(host) {
  const THREE = window.THREE;
  if (!THREE) {
    throw new Error("boot-cube: window.THREE is not loaded (load vendor-three.js first)");
  }

  const width = host.clientWidth || window.innerWidth;
  const height = host.clientHeight || window.innerHeight;

  const renderer = new THREE.WebGLRenderer({
    antialias: true,
    preserveDrawingBuffer: false,
  });
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.0;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  renderer.setSize(width, height);
  host.appendChild(renderer.domElement);

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0xaecbd6);

  // Y up, meters (SPEC §5).
  const camera = new THREE.PerspectiveCamera(50, width / height, 0.1, 200);
  camera.position.set(5, 4, 7);
  camera.lookAt(0, 1, 0);

  const sun = new THREE.DirectionalLight(0xffffff, 3.0);
  sun.position.set(6, 10, 4);
  sun.castShadow = true;
  sun.shadow.mapSize.set(2048, 2048);
  sun.shadow.camera.near = 0.5;
  sun.shadow.camera.far = 50;
  sun.shadow.camera.left = -20;
  sun.shadow.camera.right = 20;
  sun.shadow.camera.top = 20;
  sun.shadow.camera.bottom = -20;
  scene.add(sun);

  const sky = new THREE.HemisphereLight(0xbcd7ff, 0x6b6250, 1.0);
  scene.add(sky);

  // Ground plane, 40 x 40 m, receives shadows.
  const ground = new THREE.Mesh(
    new THREE.PlaneGeometry(40, 40),
    new THREE.MeshStandardMaterial({ color: 0x6f7f63, roughness: 1.0, metalness: 0.0 })
  );
  ground.rotation.x = -Math.PI / 2;
  ground.receiveShadow = true;
  scene.add(ground);

  // Cube, 2 m, casts shadows, rotates on Y.
  const cube = new THREE.Mesh(
    new THREE.BoxGeometry(2, 2, 2),
    new THREE.MeshStandardMaterial({ color: 0x0f7c8c, roughness: 0.55, metalness: 0.1 })
  );
  cube.position.set(0, 1, 0);
  cube.castShadow = true;
  cube.receiveShadow = true;
  scene.add(cube);

  function onResize() {
    const w = host.clientWidth || window.innerWidth;
    const h = host.clientHeight || window.innerHeight;
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
    renderer.setSize(w, h);
  }
  window.addEventListener("resize", onResize);

  let raf = 0;
  let last = performance.now();
  function frame(now) {
    const dt = (now - last) / 1000;
    last = now;
    cube.rotation.y += dt * 0.6;
    renderer.render(scene, camera);
    raf = requestAnimationFrame(frame);
  }
  raf = requestAnimationFrame(frame);

  return {
    dispose() {
      cancelAnimationFrame(raf);
      window.removeEventListener("resize", onResize);
      renderer.dispose();
      if (renderer.domElement.parentNode === host) {
        host.removeChild(renderer.domElement);
      }
    },
  };
}
