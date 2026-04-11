/**
 * IoTzy — Smart Room Dashboard Logic
 * Combining 3D Simulation, MQTT, Sensor Data, CRUD Management,
 * Source/Reference Table, and Performance Optimizations.
 *
 * @fileoverview Main application logic for IoTzy thesis dashboard.
 * @version 2.0.0
 */

// ============================================================
// §1 — CONFIG & GLOBALS
// ============================================================

/** @const {string} MQTT WebSocket broker URL */
const MQTT_URL = 'wss://broker.emqx.io:8084/mqtt';

/** @const {number} Room dimensions (width, height, depth) */
const RW = 10, RH = 5.6, RD = 8;

/** Three.js core objects */
let scene, camera, renderer, raycaster, clock;

/** @type {Array<Object>} All IoT devices in the scene */
let devices = [];

/** @type {Array<THREE.Mesh>} Room wall meshes */
let roomWalls = [];

/** Pointer / raycaster helpers */
const ptr = new THREE.Vector2();
const dragPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
const dragPt = new THREE.Vector3();

/** Orbit camera state */
const orbit = { target: new THREE.Vector3(0, 1.6, 0), yaw: 0.8, pitch: 0.38, radius: 13, yawV: 0, pitchV: 0, zoomV: 0 };

/** Input / drag state */
const inp = { mode: null, devId: null, ptrId: null, sx: 0, sy: 0, moved: false, offset: new THREE.Vector3(), dragWireDirty: false };

/** @type {mqtt.MqttClient|null} MQTT client instance */
let mqttClient = null;

/** @type {boolean} Whether we're in simulated (offline) mode */
let simulatedMode = false;

/** @type {boolean} Whether Three.js has been initialized */
let threeInitialized = false;

/** Wire color map per device type */
const WIRE_COLORS = { led: 0x00c8ff, fan: 0x0af, cam: 0xf59e0b, esp: 0xa855f7, door: 0x10b981, dht: 0xffffff };
const wireGroup = new THREE.Group();

/** Shadow map dirty flag — only update when devices move */
let shadowMapDirty = true;

/** Throttle for rebuildWires — max once per 100ms */
let _wireThrottleTimer = null;
let _wireThrottlePending = false;

// ============================================================
// §2 — REALISTIC SENSOR SIMULATION
// ============================================================

/**
 * Sensor simulation state with realistic drift, noise, and spikes.
 * Replaces simple sin/cos with Ornstein-Uhlenbeck-like process.
 */
const sensorSim = {
  temp: { value: 25.0, target: 26.0, drift: 0.02, noise: 0.15, spikeChance: 0.02, min: 18, max: 38 },
  humid: { value: 58.0, target: 60.0, drift: 0.015, noise: 0.3, spikeChance: 0.015, min: 30, max: 85 },
  personCount: 0,
  fanSpeed: 50,
  fanAutoMode: true,
  lastUpdate: Date.now()
};

/**
 * Advance a single sensor value with realistic drift + noise + occasional spikes.
 * @param {Object} s - Sensor state object with value, target, drift, noise, spikeChance, min, max
 * @returns {number} Updated sensor value
 */
function advanceSensor(s) {
  // Slowly drift target
  if (Math.random() < 0.05) {
    s.target += (Math.random() - 0.5) * 2;
    s.target = clamp(s.target, s.min, s.max);
  }
  // Mean-revert toward target with noise
  const pull = (s.target - s.value) * s.drift;
  const noise = (Math.random() - 0.5) * s.noise;
  s.value += pull + noise;
  // Occasional spike
  if (Math.random() < s.spikeChance) {
    s.value += (Math.random() - 0.5) * 4;
  }
  s.value = clamp(s.value, s.min, s.max);
  return s.value;
}

/**
 * Compute person count based on camera device state.
 * If any cam is ON, detect 1-3 people randomly (changes occasionally).
 * If all cams OFF, person count = 0.
 * @returns {number}
 */
function computePersonCount() {
  const anyCamOn = devices.some(d => d.type === 'cam' && d.state);
  if (!anyCamOn) return 0;
  // Change person count occasionally (every ~5 ticks on average)
  if (Math.random() < 0.2) {
    sensorSim.personCount = Math.floor(Math.random() * 3) + 1;
  }
  return sensorSim.personCount || 1;
}

/**
 * Auto-adjust fan speed based on temperature when in auto mode.
 * Hotter = faster. Maps temp 20-35°C to fan 20-100%.
 * @param {number} temp - Current temperature
 * @returns {number} Fan speed percentage
 */
function computeAutoFanSpeed(temp) {
  if (!sensorSim.fanAutoMode) return sensorSim.fanSpeed;
  const mapped = ((temp - 20) / 15) * 80 + 20;
  sensorSim.fanSpeed = Math.round(clamp(mapped, 15, 100));
  return sensorSim.fanSpeed;
}

/**
 * Flash a stat card and its value element to indicate a change.
 * @param {string} cardId - The stat-card element id
 * @param {string} valId - The stat-val element id
 */
function flashStat(cardId, valId) {
  const card = document.getElementById(cardId);
  const val = document.getElementById(valId);
  if (card) { card.classList.remove('pulse'); void card.offsetWidth; card.classList.add('pulse'); }
  if (val) { val.classList.remove('flash'); void val.offsetWidth; val.classList.add('flash'); }
}

/**
 * Format current time as HH:MM:SS for "last updated" display.
 * @returns {string}
 */
function nowTimeStr() {
  return new Date().toLocaleTimeString('id-ID', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

/**
 * Main sensor update tick — called every 1 second.
 * Updates sensor values, hero cards, timestamps, and flashes.
 */
function updateSensorVisuals() {
  const temp = advanceSensor(sensorSim.temp);
  const humid = advanceSensor(sensorSim.humid);
  const persons = computePersonCount();
  const fanSpd = computeAutoFanSpeed(temp);
  const ts = nowTimeStr();

  // Update hero stat values
  const hTemp = document.getElementById('heroTemp');
  const hHumid = document.getElementById('heroHumid');
  const hPerson = document.getElementById('heroPerson');
  const hFan = document.getElementById('heroFan');

  if (hTemp) { hTemp.textContent = temp.toFixed(1); flashStat('statCardTemp', 'heroTemp'); }
  if (hHumid) { hHumid.textContent = humid.toFixed(1); flashStat('statCardHumid', 'heroHumid'); }
  if (hPerson) {
    const prev = parseInt(hPerson.textContent) || 0;
    hPerson.textContent = persons;
    if (prev !== persons) flashStat('statCardPerson', 'heroPerson');
  }
  if (hFan) { hFan.textContent = fanSpd + '%'; flashStat('statCardFan', 'heroFan'); }

  // Update timestamps
  const ids = ['heroTempTime', 'heroHumidTime', 'heroPersonTime', 'heroFanTime'];
  ids.forEach(id => { const el = document.getElementById(id); if (el) el.textContent = 'Updated ' + ts; });

  // Auto-adjust fan devices in scene when in auto mode
  if (sensorSim.fanAutoMode) {
    devices.filter(d => d.type === 'fan' && d.state).forEach(d => {
      d.level = fanSpd;
      applyDeviceVisuals(d);
    });
  }

  sensorSim.lastUpdate = Date.now();
}

// ============================================================
// §3 — THREE.JS CORE INITIALIZATION (Lazy)
// ============================================================

/**
 * Initialize Three.js scene, camera, renderer, lighting, room geometry,
 * default devices, and start the animation loop.
 * Called lazily when the simulation section is near the viewport.
 */
function init3D() {
  if (threeInitialized) return;
  threeInitialized = true;

  const container = document.getElementById('three-canvas');
  if (!container) return;

  clock = new THREE.Clock();
  renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.1));
  renderer.setSize(container.clientWidth, container.clientHeight);
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  renderer.shadowMap.autoUpdate = false; // Manual shadow updates only
  renderer.setClearColor(0x060c14, 1);
  container.appendChild(renderer.domElement);

  scene = new THREE.Scene();
  scene.fog = new THREE.FogExp2(0x080c10, 0.012);
  scene.add(wireGroup);

  camera = new THREE.PerspectiveCamera(48, container.clientWidth / container.clientHeight, 0.1, 250);
  raycaster = new THREE.Raycaster();

  // Lighting
  scene.add(new THREE.HemisphereLight(0xb0c8e0, 0x202830, 0.52));
  const sun = new THREE.DirectionalLight(0xd8e8f8, 0.7);
  sun.position.set(4, 9, 5); sun.castShadow = true;
  sun.shadow.mapSize.set(1024, 1024);
  scene.add(sun);

  // Floor & Grid
  const floor = new THREE.Mesh(new THREE.PlaneGeometry(RW, RD), mat(0x1a2026, 0.96, 0.01));
  floor.rotation.x = -Math.PI / 2; floor.receiveShadow = true;
  scene.add(floor);
  scene.add(new THREE.GridHelper(10, 20, 0x00c8ff, 0x051a24));

  // Walls
  makeWall(RW, RH, 0, RH / 2, -RD / 2, 0, 'back');
  makeWall(RD, RH, -RW / 2, RH / 2, 0, Math.PI / 2, 'left');
  makeWall(RD, RH, RW / 2, RH / 2, 0, -Math.PI / 2, 'right');

  // Furniture (Static Decorations)
  box(3.8, 0.04, 1.1, 0x4a3c2c, -0.3, 0.78, 2.6);
  box(3.8, 0.72, 0.18, 0x3c3020, -0.3, 0.43, 3.18);
  box(2.54, 1.48, 0.065, 0x1a2030, 0, 1.7, -3.93);
  const tvGlow = new THREE.Mesh(new THREE.BoxGeometry(2.36, 1.3, 0.04), new THREE.MeshStandardMaterial({ color: 0x1a2f4a, emissive: 0x00c8ff, emissiveIntensity: 0.2 }));
  tvGlow.position.set(0, 1.7, -3.91); scene.add(tvGlow);

  // Event Listeners — left drag = orbit (changed from middle button)
  container.addEventListener('pointerdown', onPointerDown);
  window.addEventListener('pointermove', onPointerMove);
  window.addEventListener('pointerup', onPointerUp);
  container.addEventListener('wheel', e => {
    orbit.radius = clamp(orbit.radius + e.deltaY * 0.01, 5, 30);
    e.preventDefault();
  }, { passive: false });

  // Resize handler
  window.addEventListener('resize', onWindowResize);

  // Start Simulation with Default Devices
  createDevice('led', 0, 0);
  createDevice('fan', -3, -3);
  createDevice('cam', 3, -3.5);
  createDevice('esp', 4, 0.5);
  createDevice('dht', -2, 2);
  createDevice('door', -RW / 2 + 0.075, 1.2);

  // Initial shadow render
  shadowMapDirty = true;

  animate();
}

/**
 * Handle window resize — update camera aspect and renderer size.
 */
function onWindowResize() {
  if (!renderer || !camera) return;
  const container = document.getElementById('three-canvas');
  if (!container) return;
  const w = container.clientWidth;
  const h = container.clientHeight;
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
  renderer.setSize(w, h);
}

// ============================================================
// §4 — THREE.JS HELPERS
// ============================================================

/**
 * Create a standard material.
 * @param {number} col - Hex color
 * @param {number} [rough=0.78] - Roughness
 * @param {number} [metal=0.08] - Metalness
 * @returns {THREE.MeshStandardMaterial}
 */
function mat(col, rough = 0.78, metal = 0.08) {
  return new THREE.MeshStandardMaterial({ color: col, roughness: rough, metalness: metal });
}

/**
 * Clamp a value between lo and hi.
 * @param {number} v
 * @param {number} lo
 * @param {number} hi
 * @returns {number}
 */
function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }

/**
 * Create a wall with optional door holes.
 * @param {number} w - Width
 * @param {number} h - Height
 * @param {number} x - X position
 * @param {number} y - Y position
 * @param {number} z - Z position
 * @param {number} ry - Y rotation
 * @param {string} name - Wall identifier
 * @returns {THREE.Mesh}
 */
function makeWall(w, h, x, y, z, ry, name) {
  const shape = new THREE.Shape();
  shape.moveTo(-w / 2, -h / 2); shape.lineTo(w / 2, -h / 2); shape.lineTo(w / 2, h / 2); shape.lineTo(-w / 2, h / 2); shape.lineTo(-w / 2, -h / 2);
  const m = new THREE.Mesh(new THREE.ShapeGeometry(shape), new THREE.MeshStandardMaterial({ color: 0x161e26, side: THREE.DoubleSide }));
  m.position.set(x, y, z); m.rotation.y = ry; m.receiveShadow = true;
  m.userData = { wallName: name, w, h };
  scene.add(m); roomWalls.push(m); return m;
}

/**
 * Refresh wall geometry to cut door holes.
 */
function refreshWallHoles() {
  roomWalls.forEach(wall => {
    const w = wall.userData.w, h = wall.userData.h;
    const shape = new THREE.Shape();
    shape.moveTo(-w / 2, -h / 2); shape.lineTo(w / 2, -h / 2); shape.lineTo(w / 2, h / 2); shape.lineTo(-w / 2, h / 2); shape.lineTo(-w / 2, -h / 2);
    devices.filter(d => d.type === 'door').forEach(door => {
      const dp = door.group.position;
      let localX = null;
      const wallName = wall.userData.wallName;
      if (wallName === 'left' && Math.abs(dp.x - (-RW / 2)) < 0.3) localX = -dp.z;
      else if (wallName === 'right' && Math.abs(dp.x - (RW / 2)) < 0.3) localX = dp.z;
      else if (wallName === 'back' && Math.abs(dp.z - (-RD / 2)) < 0.3) localX = dp.x;
      if (localX !== null) {
        const hole = new THREE.Path();
        const hw = 0.55, hh = 2.42;
        hole.moveTo(localX - hw, -h / 2); hole.lineTo(localX - hw, -h / 2 + hh); hole.lineTo(localX + hw, -h / 2 + hh); hole.lineTo(localX + hw, -h / 2); hole.lineTo(localX - hw, -h / 2);
        shape.holes.push(hole);
      }
    });
    wall.geometry.dispose(); wall.geometry = new THREE.ShapeGeometry(shape);
  });
}

/**
 * Create a simple box mesh and add to scene.
 * @param {number} w - Width
 * @param {number} h - Height
 * @param {number} d - Depth
 * @param {number} col - Color
 * @param {number} x - X position
 * @param {number} y - Y position
 * @param {number} z - Z position
 * @param {number} [ry=0] - Y rotation
 * @returns {THREE.Mesh}
 */
function box(w, h, d, col, x, y, z, ry = 0) {
  const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat(col));
  m.position.set(x, y, z); m.rotation.y = ry; m.castShadow = m.receiveShadow = true;
  scene.add(m); return m;
}

// ============================================================
// §5 — WIRING SYSTEM (Throttled)
// ============================================================

/**
 * Rebuild all wires from devices to ESP32.
 * Throttled to max once per 100ms for performance.
 */
function rebuildWires() {
  if (_wireThrottleTimer) {
    _wireThrottlePending = true;
    return;
  }
  _doRebuildWires();
  _wireThrottleTimer = setTimeout(() => {
    _wireThrottleTimer = null;
    if (_wireThrottlePending) {
      _wireThrottlePending = false;
      _doRebuildWires();
    }
  }, 100);
}

/** @private Actual wire rebuild logic */
function _doRebuildWires() {
  while (wireGroup.children.length) {
    const l = wireGroup.children.pop(); l.geometry.dispose(); l.material.dispose();
  }
  const esp = devices.find(d => d.type === 'esp');
  if (!esp) return;
  const ep = esp.group.position;
  const topY = RH - 0.08;
  const rightX = RW / 2 - 0.03;

  devices.forEach(dev => {
    if (dev.type === 'esp') return;
    const dp = dev.group.position;
    const col = WIRE_COLORS[dev.type] || 0x888888;
    const pts = [
      new THREE.Vector3(dp.x, dp.y + 0.1, dp.z),
      new THREE.Vector3(dp.x, topY, dp.z),
      new THREE.Vector3(rightX, topY, dp.z),
      new THREE.Vector3(rightX, ep.y + 0.2, ep.z),
      new THREE.Vector3(ep.x, ep.y + 0.2, ep.z)
    ];
    const geo = new THREE.BufferGeometry().setFromPoints(pts);
    const line = new THREE.Line(geo, new THREE.LineBasicMaterial({ color: col, transparent: true, opacity: dev.state ? 0.8 : 0.2 }));
    wireGroup.add(line);
  });
}

// ============================================================
// §6 — DEVICE BUILDING (High Quality 3D Models)
// ============================================================

/** @param {THREE.Group} g @param {Object} refs */
function buildLED(g, refs) {
  const housing = new THREE.Mesh(new THREE.CylinderGeometry(0.048, 0.05, 0.04, 20), mat(0x606870, 0.4, 0.2));
  housing.position.y = -0.02; g.add(housing);
  const dome = new THREE.Mesh(new THREE.SphereGeometry(0.036, 22, 14, 0, Math.PI * 2, 0, Math.PI / 2), new THREE.MeshStandardMaterial({ color: 0xe8f4ff, emissive: 0x88ccff, emissiveIntensity: 0, transparent: true, opacity: 0.94 }));
  dome.rotation.x = Math.PI; dome.position.y = -0.14; g.add(dome);
  const glow = new THREE.PointLight(0x8edfff, 0, 4.5, 1.6); glow.position.y = -0.16; g.add(glow);
  const spot = new THREE.SpotLight(0x9ae8ff, 0, 9, Math.PI / 7, 0.55, 1.4);
  spot.position.y = -0.2; spot.target.position.set(0, -5, 0); g.add(spot); g.add(spot.target);
  refs.dome = dome; refs.glow = glow; refs.spot = spot;
}

/** @param {THREE.Group} g @param {Object} refs */
function buildFan(g, refs) {
  const frame = new THREE.Mesh(new THREE.BoxGeometry(0.44, 0.44, 0.12), mat(0x1e2530, 0.58, 0.18)); g.add(frame);
  const inner = new THREE.Mesh(new THREE.BoxGeometry(0.38, 0.38, 0.06), mat(0x131820, 0.7, 0.08)); inner.position.z = 0.04; g.add(inner);
  const blades = new THREE.Group(); blades.position.z = 0.045;
  for (let b = 0; b < 7; b++) {
    const shape = new THREE.Shape(); shape.moveTo(0.008, 0.044); shape.bezierCurveTo(0.045, 0.048, 0.125, 0.082, 0.158, 0.142); shape.bezierCurveTo(0.125, 0.138, 0.062, 0.1, 0.022, 0.058); shape.lineTo(0.008, 0.044);
    const blade = new THREE.Mesh(new THREE.ShapeGeometry(shape, 6), mat(0x2a3848, 0.52, 0.14)); blade.rotation.z = (b / 7) * Math.PI * 2; blades.add(blade);
  }
  blades.userData.spinRate = 0; blades.userData.targetRate = 0; g.add(blades);
  const hub = new THREE.Mesh(new THREE.CylinderGeometry(0.042, 0.045, 0.05, 20), mat(0x303d4d, 0.5, 0.18)); hub.rotation.x = Math.PI / 2; blades.add(hub);
  refs.blades = blades;
}

/** @param {THREE.Group} g @param {Object} refs */
function buildCam(g, refs) {
  const body = new THREE.Mesh(new THREE.CylinderGeometry(0.055, 0.065, 0.24, 28), mat(0xd0d8e2, 0.38, 0.16)); body.rotation.x = Math.PI / 2; g.add(body);
  const nose = new THREE.Mesh(new THREE.CylinderGeometry(0.022, 0.055, 0.05, 24), mat(0x252e3a, 0.3, 0.2)); nose.rotation.x = Math.PI / 2; nose.position.z = 0.145; g.add(nose);
  const recLed = new THREE.Mesh(new THREE.SphereGeometry(0.007, 8, 8), new THREE.MeshStandardMaterial({ emissive: 0xff2244, emissiveIntensity: 0.5, color: 0x300010 })); recLed.position.set(0.03, 0.024, 0.12); g.add(recLed); refs.recLed = recLed;
  const lensRing = new THREE.Mesh(new THREE.TorusGeometry(0.028, 0.003, 8, 22), new THREE.MeshStandardMaterial({ color: 0x203040, emissive: 0x00c8ff, emissiveIntensity: 0 })); lensRing.position.z = 0.174; g.add(lensRing); refs.lensRing = lensRing;
}

/** @param {THREE.Group} g @param {Object} refs */
function buildESP(g, refs) {
  const pcb = new THREE.Mesh(new THREE.BoxGeometry(0.62, 0.022, 0.28), mat(0x1e5536, 0.66, 0.05)); g.add(pcb);
  const module = new THREE.Mesh(new THREE.BoxGeometry(0.23, 0.042, 0.19), mat(0xb8c8d8, 0.25, 0.58)); module.position.set(-0.14, 0.032, 0); g.add(module);
  const ledStatus = new THREE.Mesh(new THREE.BoxGeometry(0.012, 0.007, 0.012), new THREE.MeshStandardMaterial({ color: 0xff2244 * 0.08, emissive: 0xff2244, emissiveIntensity: 0 })); ledStatus.position.set(0.145, 0.017, 0.092); g.add(ledStatus); refs.ledStatus = ledStatus;
  const wifiGlow = new THREE.PointLight(0x00c8ff, 0, 1.5, 2); wifiGlow.position.set(-0.12, 0.1, 0); g.add(wifiGlow); refs.wifiGlow = wifiGlow;
}

/** @param {THREE.Group} g @param {Object} refs */
function buildDHT(g, refs) {
  const body = new THREE.Mesh(new THREE.BoxGeometry(0.15, 0.22, 0.08), mat(0xf0f0f0, 0.4, 0.1)); g.add(body);
  for (let i = 0; i < 5; i++) {
    const line = new THREE.Mesh(new THREE.BoxGeometry(0.12, 0.005, 0.082), mat(0x333333, 0.8, 0));
    line.position.y = -0.08 + (i * 0.04); g.add(line);
  }
  const label = new THREE.Mesh(new THREE.BoxGeometry(0.1, 0.04, 0.082), mat(0x0066cc, 0.5, 0.1));
  label.position.y = 0.08; g.add(label);
  const statusLed = new THREE.Mesh(new THREE.SphereGeometry(0.008, 8, 8), new THREE.MeshStandardMaterial({ color: 0x00ff00, emissive: 0x00ff00, emissiveIntensity: 0.5 }));
  statusLed.position.set(0.04, 0.08, 0.042); g.add(statusLed); refs.statusLed = statusLed;
}

/** @param {THREE.Group} g @param {Object} refs */
function buildDoor(g, refs) {
  const frameW = 1.2, frameH = 2.4, frameD = 0.15;
  const leafW = frameW - 0.12, leafH = frameH - 0.08, leafD = 0.06;

  box(0.08, frameH, frameD, 0x222a35, -frameW / 2 + 0.04, frameH / 2, 0, 0).parent = g;
  box(0.08, frameH, frameD, 0x222a35, frameW / 2 - 0.04, frameH / 2, 0, 0).parent = g;
  box(frameW, 0.08, frameD, 0x222a35, 0, frameH - 0.04, 0, 0).parent = g;

  const pivot = new THREE.Group(); pivot.position.set(-frameW / 2 + 0.08, 0, 0); g.add(pivot);
  const leaf = new THREE.Mesh(new THREE.BoxGeometry(leafW, leafH, leafD), mat(0x323d4d, 0.6, 0.1)); leaf.position.set(leafW / 2, leafH / 2, 0); leaf.castShadow = true; pivot.add(leaf);

  function addHandle(z) {
    const hg = new THREE.Group(); hg.position.set(leafW - 0.12, leafH * 0.45, z); pivot.add(hg);
    const bar = new THREE.Mesh(new THREE.CylinderGeometry(0.015, 0.015, 0.22, 12), mat(0xd0d8e0, 0.1, 0.9)); bar.rotation.x = Math.PI / 2; bar.position.z = z > 0 ? 0.08 : -0.08; hg.add(bar);
    const panel = new THREE.Mesh(new THREE.BoxGeometry(0.12, 0.32, 0.03), mat(0x121820, 0.3, 0.3)); panel.position.z = z > 0 ? 0.015 : -0.015; hg.add(panel);
  }
  addHandle(leafD / 2); addHandle(-leafD / 2);

  const led = new THREE.Mesh(new THREE.SphereGeometry(0.012, 8, 8), new THREE.MeshStandardMaterial({ color: 0xff0000, emissive: 0xff0000, emissiveIntensity: 1.5 })); led.position.set(leafW - 0.12, leafH * 0.45 + 0.18, leafD / 2 + 0.03); pivot.add(led);
  refs.pivot = pivot; refs.lockLed = led;
}

// ============================================================
// §7 — DEVICE MANAGEMENT (CRUD)
// ============================================================

/**
 * Create a new IoT device and add it to the 3D scene.
 * @param {string} type - Device type (led, fan, cam, esp, dht, door)
 * @param {number} x - X position
 * @param {number} z - Z position
 * @returns {Object} The created device object
 */
function createDevice(type, x, z) {
  const id = type + '-' + Math.random().toString(36).slice(2, 6);
  const group = new THREE.Group();
  const refs = {};
  let baseY = 1.2, ry = 0, rx = 0, rz = 0;

  if (type === 'led') { buildLED(group, refs); baseY = RH; }
  else if (type === 'fan') { buildFan(group, refs); baseY = 1.18; }
  else if (type === 'cam') { buildCam(group, refs); baseY = 4.2; ry = 0.3; }
  else if (type === 'dht') { buildDHT(group, refs); baseY = 1.8; }
  else if (type === 'door') { buildDoor(group, refs); baseY = 0; ry = Math.PI / 2; }
  else { buildESP(group, refs); baseY = 1.45; x = RW / 2 - 0.06; rz = -Math.PI / 2; }

  group.position.set(x, baseY, z);
  group.rotation.set(rx, ry, rz);
  group.userData.deviceId = id;
  group.userData.baseY = baseY;
  group.traverse(o => { if (o.isMesh) o.userData.deviceId = id; });
  scene.add(group);

  const dev = { id, type, group, state: false, level: 75, meshRefs: refs, topicBase: `iotzy/${type}` };
  devices.push(dev);
  if (type === 'door') refreshWallHoles();
  rebuildWires();
  renderDeviceList();
  shadowMapDirty = true;
  return dev;
}

/**
 * Toggle a device on/off.
 * @param {string} id - Device id
 * @param {boolean} [val] - Explicit state, or toggle if omitted
 */
function toggleDev(id, val) {
  const dev = devices.find(d => d.id === id); if (!dev) return;
  dev.state = typeof val === 'boolean' ? val : !dev.state;
  applyDeviceVisuals(dev);
  rebuildWires();
  renderDeviceList();
  updateStats();
}

/**
 * Apply visual state (lights, spin, etc.) to a device based on its state/level.
 * @param {Object} dev - Device object
 */
function applyDeviceVisuals(dev) {
  const on = dev.state, lv = dev.level / 100;
  if (dev.type === 'led') {
    dev.meshRefs.dome.material.emissiveIntensity = on ? 0.6 + lv * 3.4 : 0;
    dev.meshRefs.glow.intensity = on ? 0.4 + lv * 1.8 : 0;
    dev.meshRefs.spot.intensity = on ? 0.6 + lv * 2.4 : 0;
  } else if (dev.type === 'fan') {
    dev.meshRefs.blades.userData.targetRate = on ? 8 + lv * 40 : 0;
  } else if (dev.type === 'cam') {
    dev.meshRefs.recLed.material.emissiveIntensity = on ? 1.8 : 0.4;
    dev.meshRefs.recLed.material.color.set(on ? 0x00ff44 : 0xff2244);
    dev.meshRefs.lensRing.material.emissiveIntensity = on ? 1.5 : 0;
  } else if (dev.type === 'door') {
    dev.meshRefs.lockLed.material.color.set(on ? 0x00ff00 : 0xff0000);
    dev.meshRefs.lockLed.material.emissive.set(on ? 0x00ff00 : 0xff0000);
  } else if (dev.type === 'dht') {
    dev.meshRefs.statusLed.material.emissiveIntensity = on ? 1.5 : 0.2;
  } else if (dev.type === 'esp') {
    dev.meshRefs.ledStatus.material.emissiveIntensity = on ? 1.0 : 0;
    dev.meshRefs.wifiGlow.intensity = on ? 0.5 : 0;
  }
}

/**
 * Set device level (brightness, speed, etc.).
 * @param {string} id - Device id
 * @param {number|string} val - Level 0-100
 */
function setLevel(id, val) {
  const dev = devices.find(d => d.id === id); if (!dev) return;
  dev.level = parseInt(val);
  applyDeviceVisuals(dev);
  renderDeviceList();
}

/**
 * Remove a device from the scene and device list.
 * @param {string} id - Device id
 */
function removeDev(id) {
  const idx = devices.findIndex(d => d.id === id);
  if (idx !== -1) {
    const dev = devices[idx];
    scene.remove(dev.group);
    devices.splice(idx, 1);
    if (dev.type === 'door') refreshWallHoles();
    rebuildWires();
    renderDeviceList();
    updateStats();
    shadowMapDirty = true;
  }
}

// ============================================================
// §8 — UI RENDERING
// ============================================================

/**
 * Render the device list sidebar in the 3D simulation panel.
 */
function renderDeviceList() {
  const list = document.getElementById('deviceList');
  if (!list) return;
  const labels = { led: 'LED 5mm', fan: 'Fan DC 5V 4010', cam: 'Cam Mini Indoor', esp: 'ESP32 DevKit V1', door: 'Smart Door', dht: 'Sensor DHT22' };
  const refs = { led: 'Ref: T-1 3/4 5mm LED', fan: 'Ref: 40×40×10mm DC5V', cam: 'Ref: Bullet mini cam', esp: 'Ref: DevKit V1 38-pin', door: 'Ref: IoTzy Smart Door', dht: 'Ref: DHT22/AM2302' };

  list.innerHTML = devices.map(d => `
    <div class="dev-card" data-id="${d.id}" onclick="selectDevice('${d.id}')">
      <div class="dev-top">
        <div class="dev-info">
          <div class="dev-name">${labels[d.type] || d.type}</div>
          <div class="dev-id">${d.id}</div>
          <div class="dev-ref">${refs[d.type] || ''}</div>
          <div class="dev-badge ${d.state ? 'on' : 'off'}">${d.state ? 'ON' : 'OFF'}</div>
        </div>
        <label class="sw" onclick="event.stopPropagation()">
          <input type="checkbox" onchange="toggleDev('${d.id}', this.checked)" ${d.state ? 'checked' : ''}>
          <span class="sw-track"></span>
        </label>
      </div>
      <div class="dev-ctrl" onclick="event.stopPropagation()">
        <input type="range" min="0" max="100" value="${d.level}" class="dev-range" oninput="setLevel('${d.id}', this.value)">
        <span class="dev-pct">${d.level}%</span>
        <button class="dev-del" onclick="removeDev('${d.id}')">✕</button>
      </div>
    </div>
  `).join('');
}

/**
 * Select a device and show its properties in the right sidebar.
 * @param {string} id - Device id
 */
function selectDevice(id) {
  const dev = devices.find(d => d.id === id); if (!dev) return;
  document.getElementById('selDevName').textContent = labelOf(dev.type);
  document.getElementById('pStatus').textContent = dev.state ? 'ACTIVE' : 'INACTIVE';
  document.getElementById('pLevel').textContent = dev.level + '%';
  document.getElementById('pTopic').textContent = dev.topicBase + '/control';
  document.getElementById('pTime').textContent = new Date().toLocaleTimeString();

  // Focus camera on selected device
  orbit.target.copy(dev.group.position);
}

/**
 * Get human-readable label for a device type.
 * @param {string} t - Device type key
 * @returns {string}
 */
function labelOf(t) {
  return { led: 'LED 5mm', fan: 'Fan DC 5V 4010', cam: 'Cam Mini Indoor', esp: 'ESP32 DevKit V1', door: 'Smart Door', dht: 'Sensor DHT22' }[t] || t;
}

/**
 * Update device count stats and hero fan speed display.
 */
function updateStats() {
  const tot = devices.length, act = devices.filter(d => d.state).length;
  const devEl = document.getElementById('stat-dev');
  const actEl = document.getElementById('stat-act');
  if (devEl) devEl.innerHTML = `<div class="dot ${tot ? 'on' : ''}"></div>${tot} Dev`;
  if (actEl) actEl.innerHTML = `<div class="dot ${act ? 'on' : ''}"></div>${act} On`;
}

// ============================================================
// §9 — INPUT HANDLING (Left-drag = Orbit, Right-click = Drag device)
// ============================================================

/**
 * Handle pointer down on the 3D canvas.
 * Left click on device = select (click on door = toggle).
 * Left click on empty = start orbit.
 * Right click on device = start drag.
 * @param {PointerEvent} e
 */
function onPointerDown(e) {
  const rect = renderer.domElement.getBoundingClientRect();
  ptr.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
  ptr.y = -((e.clientY - rect.top) / rect.height) * 2 + 1;

  raycaster.setFromCamera(ptr, camera);
  const hits = raycaster.intersectObjects(devices.map(d => d.group), true);

  if (e.button === 0) {
    // Left click
    if (hits.length) {
      let n = hits[0].object;
      while (n && !n.userData.deviceId) n = n.parent;
      if (n) {
        const dev = devices.find(d => d.id === n.userData.deviceId);
        selectDevice(dev.id);
        if (dev.type === 'door') { toggleDev(dev.id); return; }
        // Start orbit even when clicking a device (select only, no drag on left)
        inp.mode = 'orbit'; inp.sx = e.clientX; inp.sy = e.clientY;
        return;
      }
    }
    // Left click on empty space = orbit
    inp.mode = 'orbit'; inp.sx = e.clientX; inp.sy = e.clientY;
  } else if (e.button === 2) {
    // Right click = drag device
    e.preventDefault();
    if (hits.length) {
      let n = hits[0].object;
      while (n && !n.userData.deviceId) n = n.parent;
      if (n) {
        const dev = devices.find(d => d.id === n.userData.deviceId);
        if (dev.type === 'door') return;
        inp.mode = 'drag'; inp.devId = dev.id;
        if (raycaster.ray.intersectPlane(dragPlane, dragPt)) inp.offset.copy(dev.group.position).sub(dragPt);
        return;
      }
    }
  } else if (e.button === 1) {
    // Middle click = also orbit (legacy)
    inp.mode = 'orbit'; inp.sx = e.clientX; inp.sy = e.clientY;
    e.preventDefault();
  }
}

/**
 * Handle pointer move for orbit/drag.
 * @param {PointerEvent} e
 */
function onPointerMove(e) {
  if (!inp.mode) return;
  if (inp.mode === 'orbit') {
    orbit.yaw -= (e.clientX - inp.sx) * 0.005;
    orbit.pitch = clamp(orbit.pitch + (e.clientY - inp.sy) * 0.005, 0.1, 1.4);
    inp.sx = e.clientX; inp.sy = e.clientY;
  } else if (inp.mode === 'drag') {
    const rect = renderer.domElement.getBoundingClientRect();
    ptr.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
    ptr.y = -((e.clientY - rect.top) / rect.height) * 2 + 1;
    raycaster.setFromCamera(ptr, camera);
    if (raycaster.ray.intersectPlane(dragPlane, dragPt)) {
      const dev = devices.find(d => d.id === inp.devId);
      if (!dev) return;
      const tx = clamp(dragPt.x + inp.offset.x, -RW / 2 + 0.5, RW / 2 - 0.5);
      const tz = clamp(dragPt.z + inp.offset.z, -RD / 2 + 0.5, RD / 2 - 0.5);
      if (dev.type === 'esp') {
        dev.group.position.x = RW / 2 - 0.06;
        dev.group.position.z = tz;
      } else {
        dev.group.position.x = tx;
        dev.group.position.z = tz;
      }
      rebuildWires();
      shadowMapDirty = true;
    }
  }
}

/**
 * Handle pointer up — reset input mode.
 */
function onPointerUp() { inp.mode = null; }

// ============================================================
// §10 — ANIMATION LOOP (Optimized)
// ============================================================

let blinkT = 0;
let _animFrameId = null;

/**
 * Main animation loop. Uses requestAnimationFrame properly.
 * Shadow map only updates when shadowMapDirty is true.
 */
function animate() {
  _animFrameId = requestAnimationFrame(animate);
  const dt = Math.min(clock.getDelta(), 0.05);
  blinkT += dt;

  devices.forEach(dev => {
    if (dev.type === 'fan' && dev.meshRefs.blades) {
      const bl = dev.meshRefs.blades;
      bl.userData.spinRate += (bl.userData.targetRate - bl.userData.spinRate) * 0.1;
      bl.rotation.z += bl.userData.spinRate * dt;
    }
    if (dev.type === 'door' && dev.meshRefs.pivot) {
      const target = dev.state ? Math.PI / 1.6 : 0;
      dev.meshRefs.pivot.rotation.y += (target - dev.meshRefs.pivot.rotation.y) * 0.1;
    }
    if (dev.type === 'esp' && dev.state && dev.meshRefs.ledStatus) {
      dev.meshRefs.ledStatus.material.emissiveIntensity = (Math.sin(blinkT * 8) > 0) ? 1.0 : 0;
    }
  });

  // Update camera orbit
  const cp = Math.cos(orbit.pitch);
  camera.position.set(
    orbit.target.x + orbit.radius * cp * Math.sin(orbit.yaw),
    orbit.target.y + orbit.radius * Math.sin(orbit.pitch),
    orbit.target.z + orbit.radius * cp * Math.cos(orbit.yaw)
  );
  camera.lookAt(orbit.target);

  // Only update shadow map when dirty
  if (shadowMapDirty) {
    renderer.shadowMap.needsUpdate = true;
    shadowMapDirty = false;
  }

  renderer.render(scene, camera);
}

// ============================================================
// §11 — LOG BIMBINGAN CRUD (Source field removed)
// ============================================================

const defaultLogs = [
  {
    id: 1,
    date: '2026-02-26',
    adv: 'Pak Hanif',
    tanya: 'Kira kira dari project ini lebih bagus dibuat miniatur ruangan kecil atau alat portable yang bisa dipakai di ruangan asli?, Gimana kalau kamera di ganti sensor dht saja untuk otomatis kipasnya',
    materi: 'Pakai apa saja bisa tergantung kamunya yang penting berfungsi dan bekerja lah alatnya, pakai kamera sudah bagus jadi bisa deteksi jumlah orang',
    tangkap: 'Berarti miniatur saja, yang penting saya coba saja dlu sesuai project saya dengan alat yang ada saja dlu dan bekerja juga berfungsi',
    progress: 'Uji coba komponen seperti ESP, DHT, dan servo sebagai pengganti kipas',
    result: 'Komponen dasar sudah berhasil berjalan dan terhubung'
  },
  {
    id: 2,
    date: '2026-03-04',
    adv: 'Pak Fara',
    tanya: 'Dari judul saya ini gimana menurut bapak?, Kalau bikin miniatur gin berarti uji cobanya pakai orang orangan mainan?',
    materi: 'Pikirkan cara mendeteksi orangnya, metode apa yang dipakai untuk mendeteksi orang, gimana margin errornya jika orang berdampingan di dalam kamera, dan cari latar belakang dari rata-rata penggunaan listrik manusia.',
    tangkap: 'Saya mencoba deteksi orang di web menggunakan TensorFlow.js dengan model COCO-SSD karena lebih ringan untuk browser, namun akurasinya mungkin tidak setinggi YOLO sehingga margin error bisa lebih besar. Misalnya saat orang berdempetan di kamera, bounding box bisa overlap dan terhitung satu. Solusinya bisa mengganti model ke YOLO atau mengubah posisi kamera agar deteksi lebih jelas.',
    progress: 'Disini saya lakukan uji coba untuk deteksi orangnya dan konek ke program untuk alat saya seperti lampu menyala saat gelap, servo berputar saat suhu rendah',
    result: 'Sistem deteksi orang, kontrol alat, seperti lampu dan sensor serta monitoring suhu dengan sensor dht pada web sudah bekerja'
  },
  {
    id: 3,
    date: '2026-03-12',
    adv: 'Pak Hanif',
    tanya: 'Gimana jika buat web terlalu bergantung dengan AI, dan progress saya saat ini gimana, serta kemaren saya di beritahu pak fara untuk cari tahu metode pengenalan orangnya',
    materi: 'Tidak apa apa asal masih mengerti dasarnya, dipahami seperti ada text hijau di tiap baris kodenya, serta lebih baik jika ada konsumsi listrik yang terpakai',
    tangkap: 'Ya saya cukup mengerti dengan isi web saya yang saya gunakan PHP native dan menggunakan TensorFlow.js sebagai deteksi orangnya dan untuk konsumsi listrik saya meriset seperti menggunakan sensor ina219',
    progress: 'Ya saya mematangkan pemahaman ke web yang saya buat serta mencari opsi untuk memantau konsumsi listriknya',
    result: 'Saat ini opsi konsumsi listriknya masih saya terapkan pada website dengan optional jika menggunakan sensor ina 219'
  }
];
let logs = JSON.parse(localStorage.getItem('iotzy_logs')) || defaultLogs;

/**
 * Render log table rows with expandable long-text cells.
 */
function renderLogs() {
  const tb = document.getElementById('logBody'); if (!tb) return;

  tb.innerHTML = logs.map((l, i) => `
    <tr>
      <td style="color:var(--muted);font-family:var(--mono);font-size:.8rem">${i + 1}</td>
      <td style="font-family:var(--mono);font-size:.82rem;white-space:nowrap">${l.date}</td>
      <td style="font-weight:600;white-space:nowrap">${l.adv}</td>
      <td style="font-size:.8rem"><div class="cell-truncated" onclick="this.classList.toggle('expanded')">${l.tanya || '—'}</div></td>
      <td style="font-size:.8rem"><div class="cell-truncated" onclick="this.classList.toggle('expanded')">${l.materi || '—'}</div></td>
      <td style="font-size:.8rem"><div class="cell-truncated" onclick="this.classList.toggle('expanded')">${l.tangkap || '—'}</div></td>
      <td style="font-size:.8rem"><div class="cell-truncated" onclick="this.classList.toggle('expanded')">${l.progress || '—'}</div></td>
      <td style="font-size:.8rem"><div class="cell-truncated" onclick="this.classList.toggle('expanded')">${l.result || '—'}</div></td>
      <td class="actions">
        <button class="btn-icon" onclick="editLog(${l.id})"><i class="fas fa-edit"></i></button>
        <button class="btn-icon btn-del" onclick="deleteLog(${l.id})"><i class="fas fa-trash"></i></button>
      </td>
    </tr>
  `).join('');
}

window.openLogModal = (edit = false) => {
  document.getElementById('logModal').classList.add('open');
  document.getElementById('modalTitle').textContent = edit ? 'Edit Log' : 'Tambah Log';
  if (!edit) {
    document.getElementById('logId').value = '';
    document.getElementById('logDate').value = new Date().toISOString().split('T')[0];
    document.getElementById('logAdv').value = '';
    document.getElementById('logTanya').value = '';
    document.getElementById('logMateri').value = '';
    document.getElementById('logTangkap').value = '';
    document.getElementById('logProgress').value = '';
    document.getElementById('logResult').value = '';
  }
};
window.closeLogModal = () => { document.getElementById('logModal').classList.remove('open'); };

window.saveLog = (e) => {
  e.preventDefault();
  const id = document.getElementById('logId').value;
  const data = {
    id: id ? parseInt(id) : Date.now(),
    date: document.getElementById('logDate').value,
    adv: document.getElementById('logAdv').value,
    tanya: document.getElementById('logTanya').value,
    materi: document.getElementById('logMateri').value,
    tangkap: document.getElementById('logTangkap').value,
    progress: document.getElementById('logProgress').value,
    result: document.getElementById('logResult').value
  };
  if (id) { const i = logs.findIndex(l => l.id == id); logs[i] = data; } else { logs.push(data); }
  localStorage.setItem('iotzy_logs', JSON.stringify(logs)); renderLogs(); closeLogModal();
};

window.editLog = (id) => {
  const l = logs.find(x => x.id == id); if (!l) return;
  document.getElementById('logId').value = l.id;
  document.getElementById('logDate').value = l.date;
  document.getElementById('logAdv').value = l.adv;
  document.getElementById('logTanya').value = l.tanya || '';
  document.getElementById('logMateri').value = l.materi || '';
  document.getElementById('logTangkap').value = l.tangkap || '';
  document.getElementById('logProgress').value = l.progress || '';
  document.getElementById('logResult').value = l.result || '';
  window.openLogModal(true);
};

window.deleteLog = (id) => {
  if (!confirm('Hapus log ini?')) return;
  logs = logs.filter(l => l.id != id); localStorage.setItem('iotzy_logs', JSON.stringify(logs)); renderLogs();
};

// ============================================================
// §12 — SOURCE / REFERENCE TABLE CRUD (NEW)
// ============================================================

const defaultSources = [
  {
    id: 1,
    title: 'IoT-Based Smart Room Monitoring and Control System Using ESP32',
    link: 'https://ieeexplore.ieee.org/document/9358201',
    type: 'Jurnal',
    summary: 'Implementasi sistem monitoring ruangan pintar berbasis ESP32 dengan sensor DHT22 dan kontrol aktuator melalui protokol MQTT.'
  },
  {
    id: 2,
    title: 'PID Controller Design for Temperature Regulation in Smart Buildings',
    link: 'https://doi.org/10.1016/j.enbuild.2021.110987',
    type: 'Jurnal',
    summary: 'Desain kontroler PID untuk regulasi suhu otomatis pada bangunan pintar, termasuk tuning parameter dan analisis respons sistem.'
  },
  {
    id: 3,
    title: 'Real-Time Object Detection in the Browser with TensorFlow.js and COCO-SSD',
    link: 'https://www.tensorflow.org/js/models',
    type: 'Web',
    summary: 'Dokumentasi resmi TensorFlow.js untuk deteksi objek real-time di browser menggunakan model COCO-SSD, termasuk person detection.'
  },
  {
    id: 4,
    title: 'Perancangan Sistem Smart Room Berbasis IoT untuk Efisiensi Energi',
    link: 'Skripsi - Universitas Telkom 2024',
    type: 'PDF',
    summary: 'Referensi skripsi tentang perancangan smart room dengan fokus efisiensi energi menggunakan sensor PIR, DHT, dan relay module.'
  }
];
let sources = JSON.parse(localStorage.getItem('iotzy_sources')) || defaultSources;

/**
 * Render the source/reference table.
 */
function renderSources() {
  const tb = document.getElementById('sourceBody'); if (!tb) return;
  const typeClass = { PDF: 'pdf', Web: 'web', Jurnal: 'jurnal', Catatan: 'catatan' };

  tb.innerHTML = sources.map((s, i) => {
    const isLink = s.link && s.link.startsWith('http');
    const linkHtml = isLink
      ? `<a href="${s.link}" target="_blank" rel="noopener">${s.link.length > 45 ? s.link.substring(0, 45) + '...' : s.link}</a>`
      : `<span>${s.link || '—'}</span>`;
    return `
    <tr>
      <td style="color:var(--muted);font-family:var(--mono);font-size:.8rem">${i + 1}</td>
      <td style="font-weight:600">${s.title}</td>
      <td>${linkHtml}</td>
      <td><span class="source-type-badge ${typeClass[s.type] || 'web'}">${s.type}</span></td>
      <td style="font-size:.78rem"><div class="cell-truncated" onclick="this.classList.toggle('expanded')">${s.summary || '—'}</div></td>
      <td class="actions">
        <button class="btn-icon" onclick="editSource(${s.id})"><i class="fas fa-edit"></i></button>
        <button class="btn-icon btn-del" onclick="deleteSource(${s.id})"><i class="fas fa-trash"></i></button>
      </td>
    </tr>`;
  }).join('');
}

window.openSourceModal = (edit = false) => {
  document.getElementById('sourceModal').classList.add('open');
  document.getElementById('sourceModalTitle').textContent = edit ? 'Edit Referensi' : 'Tambah Referensi';
  if (!edit) {
    document.getElementById('srcId').value = '';
    document.getElementById('srcTitle').value = '';
    document.getElementById('srcLink').value = '';
    document.getElementById('srcType').value = 'Web';
    document.getElementById('srcSummary').value = '';
  }
};
window.closeSourceModal = () => { document.getElementById('sourceModal').classList.remove('open'); };

window.saveSource = (e) => {
  e.preventDefault();
  const id = document.getElementById('srcId').value;
  const data = {
    id: id ? parseInt(id) : Date.now(),
    title: document.getElementById('srcTitle').value,
    link: document.getElementById('srcLink').value,
    type: document.getElementById('srcType').value,
    summary: document.getElementById('srcSummary').value
  };
  if (id) { const i = sources.findIndex(s => s.id == id); sources[i] = data; } else { sources.push(data); }
  localStorage.setItem('iotzy_sources', JSON.stringify(sources)); renderSources(); closeSourceModal();
};

window.editSource = (id) => {
  const s = sources.find(x => x.id == id); if (!s) return;
  document.getElementById('srcId').value = s.id;
  document.getElementById('srcTitle').value = s.title;
  document.getElementById('srcLink').value = s.link;
  document.getElementById('srcType').value = s.type;
  document.getElementById('srcSummary').value = s.summary || '';
  window.openSourceModal(true);
};

window.deleteSource = (id) => {
  if (!confirm('Hapus referensi ini?')) return;
  sources = sources.filter(s => s.id != id);
  localStorage.setItem('iotzy_sources', JSON.stringify(sources));
  renderSources();
};

// ============================================================
// §13 — MQTT CONNECTION (Reconnect + Fallback to Simulated)
// ============================================================

/** @const {number} Max MQTT reconnect attempts before fallback */
const MQTT_MAX_RETRIES = 3;

/** @const {number} Loading overlay auto-dismiss timeout (ms) */
const LOADING_TIMEOUT_MS = 3000;

let _mqttRetries = 0;

/**
 * Connect to MQTT broker with reconnect logic.
 * After MQTT_MAX_RETRIES failures, falls back to simulated mode.
 * Loading overlay auto-dismisses after LOADING_TIMEOUT_MS.
 */
function connectMQTT() {
  const overlay = document.getElementById('loadingOverlay');
  const status = document.getElementById('loadingStatus');
  const countdown = document.getElementById('loadingCountdown');

  // Auto-dismiss loading overlay after timeout
  const loadingTimer = setTimeout(() => {
    if (overlay && overlay.style.display !== 'none') {
      enterSimulatedMode();
      if (overlay) overlay.style.display = 'none';
    }
  }, LOADING_TIMEOUT_MS);

  // Countdown display
  let remaining = Math.ceil(LOADING_TIMEOUT_MS / 1000);
  const countdownInterval = setInterval(() => {
    remaining--;
    if (countdown) countdown.textContent = `Auto-fallback dalam ${remaining}s...`;
    if (remaining <= 0) clearInterval(countdownInterval);
  }, 1000);

  try {
    mqttClient = mqtt.connect(MQTT_URL, {
      clientId: 'iotzy_' + Math.random().toString(16).slice(2, 10),
      connectTimeout: 2500,
      reconnectPeriod: 1000
    });

    mqttClient.on('connect', () => {
      console.log('MQTT Connected');
      clearTimeout(loadingTimer);
      clearInterval(countdownInterval);
      _mqttRetries = 0;
      simulatedMode = false;
      if (overlay) overlay.style.display = 'none';
      updateMqttPill('connected', 'MQTT Connected');
    });

    mqttClient.on('error', (err) => {
      console.warn('MQTT Error:', err.message);
      _mqttRetries++;
      if (_mqttRetries >= MQTT_MAX_RETRIES) {
        mqttClient.end(true);
        clearTimeout(loadingTimer);
        clearInterval(countdownInterval);
        enterSimulatedMode();
        if (overlay) overlay.style.display = 'none';
      }
    });

    mqttClient.on('offline', () => {
      _mqttRetries++;
      if (_mqttRetries >= MQTT_MAX_RETRIES) {
        mqttClient.end(true);
        clearTimeout(loadingTimer);
        clearInterval(countdownInterval);
        enterSimulatedMode();
        if (overlay) overlay.style.display = 'none';
      }
    });

    mqttClient.on('reconnect', () => {
      console.log(`MQTT reconnect attempt ${_mqttRetries + 1}/${MQTT_MAX_RETRIES}`);
    });
  } catch (e) {
    console.error('MQTT init failed:', e);
    clearTimeout(loadingTimer);
    clearInterval(countdownInterval);
    enterSimulatedMode();
    if (overlay) overlay.style.display = 'none';
  }
}

/**
 * Enter simulated mode — show badge, update pill.
 */
function enterSimulatedMode() {
  simulatedMode = true;
  updateMqttPill('simulated', 'Simulated Mode');
  console.log('Switched to Simulated Mode');
}

/**
 * Update the MQTT status pill in the navbar.
 * @param {string} state - 'connected', 'error', 'simulated', or ''
 * @param {string} label - Display text
 */
function updateMqttPill(state, label) {
  const pill = document.getElementById('mqttPill');
  if (!pill) return;
  pill.className = 'mqtt-pill ' + state;
  const lbl = document.getElementById('mqttLabel');
  if (lbl) {
    lbl.textContent = label;
    // Add simulated badge
    if (state === 'simulated') {
      const existing = pill.querySelector('.sim-mode-badge');
      if (!existing) {
        const badge = document.createElement('span');
        badge.className = 'sim-mode-badge';
        badge.textContent = 'SIM';
        pill.appendChild(badge);
      }
    }
  }
}

// ============================================================
// §14 — LAZY THREE.JS INIT (IntersectionObserver)
// ============================================================

/**
 * Set up IntersectionObserver to lazy-init Three.js when the
 * simulation section is near the viewport.
 */
function setupLazyThreeInit() {
  const simSection = document.getElementById('simulation');
  if (!simSection) { init3D(); return; }

  if ('IntersectionObserver' in window) {
    const observer = new IntersectionObserver((entries) => {
      entries.forEach(entry => {
        if (entry.isIntersecting) {
          init3D();
          observer.disconnect();
        }
      });
    }, { rootMargin: '200px' }); // Start loading 200px before visible
    observer.observe(simSection);
  } else {
    // Fallback for old browsers
    init3D();
  }
}

// ============================================================
// §15 — NAVIGATION HIGHLIGHTING (Debounced)
// ============================================================

let _scrollDebounceTimer = null;

/**
 * Debounced scroll handler for nav link highlighting.
 */
function onScrollDebounced() {
  if (_scrollDebounceTimer) return;
  _scrollDebounceTimer = setTimeout(() => {
    _scrollDebounceTimer = null;
    let current = '';
    document.querySelectorAll('section[id]').forEach(s => {
      if (window.scrollY >= s.offsetTop - 100) current = s.id;
    });
    const navLinks = document.querySelectorAll('.nav-links a');
    navLinks.forEach(a => {
      a.classList.remove('active');
      if (a.getAttribute('href') === '#' + current) a.classList.add('active');
    });
  }, 100);
}

// ============================================================
// §16 — INIT ON LOAD
// ============================================================

document.addEventListener('DOMContentLoaded', () => {
  renderLogs();
  renderSources();
  updateStats();

  // Lazy init Three.js
  setupLazyThreeInit();

  // Connect MQTT (non-blocking)
  connectMQTT();

  // Sensor updates every 1 second
  setInterval(updateSensorVisuals, 1000);

  // Add Device Buttons
  document.querySelectorAll('.add-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      if (!threeInitialized) { init3D(); }
      const type = btn.dataset.type;
      const x = (Math.random() - 0.5) * 6;
      const z = (Math.random() - 0.5) * 4;
      createDevice(type, x, z);
    });
  });

  // Debounced scroll for nav highlighting
  window.addEventListener('scroll', onScrollDebounced, { passive: true });

  // Prevent context menu on 3D canvas (for right-click drag)
  const canvas = document.getElementById('three-canvas');
  if (canvas) {
    canvas.addEventListener('contextmenu', e => e.preventDefault());
  }
});

/**
 * Toggle simulation (legacy button handler).
 */
window.toggleSimulation = () => {
  const label = document.getElementById('simLabel');
  const icon = document.getElementById('simIcon');
  if (!label || !icon) return;
  if (label.textContent === 'Mulai Simulasi') {
    label.textContent = 'Stop Simulasi';
    icon.className = 'fas fa-stop-circle';
  } else {
    label.textContent = 'Mulai Simulasi';
    icon.className = 'fas fa-play-circle';
  }
};
