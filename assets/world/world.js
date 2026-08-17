// world.js — thin, fast renderer for the Python-authored map (world.json).
//
// The layout is precomputed in world_gen.py, so the client does no placement
// work: it paints a background instantly, then STREAMS the map — only objects
// near the camera are instantiated (GTA/Quake-style), so a 1200-object city
// stays cheap. Real 3D models for identified assets; camera-facing sprites for
// the diffusion gap-fill. Renders on a 49% duty cycle to spare the GPU.

import * as THREE from 'three';
import { Garden } from './garden.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { RGBELoader } from 'three/addons/loaders/RGBELoader.js';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';

const $ = (s) => document.querySelector(s);
const params = new URLSearchParams(location.search);
// The web experience CONTINUES the Roblox teaser: the same world (Moleculia —
// MOLGANG's Chemical Engineering Simulator), grounded on the real terrain of
// whichever steel plant the player picked on the steelworks map (steelworks/
// -> ?site=<id> or localStorage 'molgang.site' -> the SAME OSM data renders
// here as real rivers/water next to the Slakkenspoor zone: one connected
// place, not a separate space setting).
// ?world=./world.json falls back to the old city for comparison.
const WORLDFILE = params.get('world') || './moleculia.json';
let MOLECULIA = true;   // set from meta.space after the map loads

// ---------- renderer + instant background ----------
const renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
renderer.setPixelRatio(Math.min(devicePixelRatio, 1.5));
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.toneMapping = THREE.ACESFilmicToneMapping;   // filmic response -> realistic highlights
renderer.toneMappingExposure = 1.05;
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;     // soft grounded shadows
$('#stage').appendChild(renderer.domElement);

const scene = new THREE.Scene();
// Image-based lighting: a neutral studio environment gives every PBR material
// real reflections + soft ambient, the single biggest step up in realism.
const pmrem = new THREE.PMREMGenerator(renderer);
scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
// Sky gradient as an instant background (a canvas texture — no assets to wait on).
(function sky() {
  const c = document.createElement('canvas'); c.width = 8; c.height = 256;
  const g = c.getContext('2d');
  const grd = g.createLinearGradient(0, 0, 0, 256);
  grd.addColorStop(0, '#9ec8ea'); grd.addColorStop(0.55, '#b9d6ee'); grd.addColorStop(1, '#dfe9ee');
  g.fillStyle = grd; g.fillRect(0, 0, 8, 256);
  const tex = new THREE.CanvasTexture(c); tex.colorSpace = THREE.SRGBColorSpace;
  scene.background = tex;
})();
scene.fog = new THREE.Fog(0xc4dae8, 55, 200);

const camera = new THREE.PerspectiveCamera(72, 1, 0.1, 400);
scene.add(new THREE.HemisphereLight(0xdfeeff, 0x384049, 0.45));   // env map carries most ambient now
const sun = new THREE.DirectionalLight(0xfff2e0, 2.6);
sun.position.set(60, 130, 40);
sun.castShadow = true;
sun.shadow.mapSize.set(2048, 2048);
sun.shadow.camera.near = 1; sun.shadow.camera.far = 300;
sun.shadow.camera.left = -48; sun.shadow.camera.right = 48;
sun.shadow.camera.top = 48; sun.shadow.camera.bottom = -48;
sun.shadow.bias = -0.0004; sun.shadow.normalBias = 0.02;
scene.add(sun); scene.add(sun.target);

// Post-processing: subtle bloom so emissive rims, quantum glow, element tiles and
// stars actually glow — a big perceptual polish in a dark space scene.
const composer = new EffectComposer(renderer);
composer.addPass(new RenderPass(scene, camera));
const bloom = new UnrealBloomPass(new THREE.Vector2(innerWidth / 2, innerHeight / 2), 0.5, 0.5, 0.85);   // half-res: ~4x cheaper, visually identical
composer.addPass(bloom);
composer.addPass(new OutputPass());

// Ground shows immediately too.
let WORLD = 240, roadAts = null, ROAD = 14;
let worldLoaded = false;         // world bounds only clamp once the real size is known
const groundMat = new THREE.MeshStandardMaterial({ color: 0x3b4a3b, roughness: 1 });
const ground = new THREE.Mesh(new THREE.PlaneGeometry(WORLD, WORLD), groundMat);
ground.rotation.x = -Math.PI / 2; ground.receiveShadow = true; scene.add(ground);

// ---------- Moleculia: grounded on the real steel-plant terrain ----------
// Used to be a starfield void beneath floating platforms; now the zones sit
// on ordinary daylight ground, and the site the player picked on the
// steelworks map is rendered as real rivers/water next to Slakkenspoor —
// the map and the walkable world show the same place. Called from init()
// when meta.space is set (kept as the JSON key; it now means "Moleculia
// layout", not "outer space").
function setGrounded(site) {
  // Real HDRI lighting (CC0 Poly Haven "industrial workshop foundry"): warm,
  // directional industrial reflections on every PBR surface — replaces the
  // neutral RoomEnvironment once loaded (which stays as the instant fallback).
  new RGBELoader().load('./env/industrial_workshop_foundry_1k.hdr', (t) => {
    t.mapping = THREE.EquirectangularReflectionMapping;
    scene.environment = pmrem.fromEquirectangular(t).texture;
    t.dispose();
  }, undefined, () => { /* keep RoomEnvironment */ });
  // Daylight sky + fog already painted at module load (see sky() above) —
  // just extend the fog draw distance to match Moleculia's larger world so
  // the far zones don't fade out early.
  scene.fog = new THREE.Fog(0xc4dae8, 60, 320);
  // groundMat keeps its default daylight grass/earth tone (no more void).
  if (site) buildRealTerrain(site);
}

// Real rivers/water/coastline from the steelworks OSM dataset (see
// molgang-knitweb tools/build_steel_sites.py), scaled down and placed just
// north of Slakkenspoor so the plant visibly sits on its real river.
const TERRAIN_AT = { x: -140, z: 150, scale: 0.026 };
function terrainRibbon(pts, width, mat, y) {
  if (pts.length < 2) return null;
  const pos = [], idx = [], hw = width / 2;
  for (let i = 0; i < pts.length; i++) {
    const p = pts[i], q = pts[Math.min(i + 1, pts.length - 1)], r = pts[Math.max(i - 1, 0)];
    let dx = q[0] - r[0], dz = q[1] - r[1];
    const len = Math.hypot(dx, dz) || 1; dx /= len; dz /= len;
    pos.push(p[0] - dz * hw, y, p[1] + dx * hw, p[0] + dz * hw, y, p[1] - dx * hw);
    if (i) { const a = (i - 1) * 2; idx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2); }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setIndex(idx); g.computeVertexNormals();
  return new THREE.Mesh(g, mat);
}
function terrainPoly(pts, mat, y) {
  if (pts.length < 3) return null;
  const shape = new THREE.Shape(pts.map((p) => new THREE.Vector2(p[0], -p[1])));
  const g = new THREE.ShapeGeometry(shape); g.rotateX(-Math.PI / 2);
  const m = new THREE.Mesh(g, mat); m.position.y = y; return m;
}
function buildRealTerrain(site) {
  const { x: ox, z: oz, scale } = TERRAIN_AT;
  const tf = (p) => [p[0] * scale + ox, p[1] * scale + oz];
  const waterMat = new THREE.MeshStandardMaterial({ color: 0x1a567a, roughness: .25, metalness: .1 });
  const riverMat = new THREE.MeshStandardMaterial({ color: 0x2d7aa8, roughness: .3 });
  const group = new THREE.Group();
  for (const poly of site.water || []) {
    const m = terrainPoly(poly.map(tf), waterMat, 0.12); if (m) group.add(m);
  }
  for (const seg of site.coast || []) {
    const m = terrainRibbon(seg.map(tf), 24, waterMat, 0.15); if (m) group.add(m);
  }
  for (const rv of site.rivers || []) {
    const w = rv.kind === 'river' ? 11 : 6;
    const m = terrainRibbon(rv.pts.map(tf), w, riverMat, 0.18); if (m) group.add(m);
  }
  scene.add(group);
  // A small waterside sign names the real place — the connective tissue
  // between the steelworks map and this ground.
  if (site.name) {
    const cv = document.createElement('canvas'); cv.width = 512; cv.height = 96;
    const g = cv.getContext('2d');
    g.fillStyle = '#10151dcc'; g.fillRect(0, 0, 512, 96);
    g.fillStyle = '#eaf2f5'; g.font = '30px sans-serif'; g.textAlign = 'center'; g.textBaseline = 'middle';
    g.fillText(`🏞 ${site.name}${site.river_names && site.river_names[0] ? ' · ' + site.river_names[0] : ''}`, 256, 48);
    const sign = new THREE.Mesh(new THREE.PlaneGeometry(9, 1.7),
      new THREE.MeshBasicMaterial({ map: new THREE.CanvasTexture(cv), transparent: true }));
    sign.position.set(ox, 3.2, oz + 60); sign.rotation.y = Math.PI;
    sign.userData.def = { sign: true, name: site.name,
      info: (site.river_names && site.river_names[0]) ? ('rivier: ' + site.river_names[0]) : 'plek in Moleculia' };
    extraInteractables.push(sign);
    scene.add(sign);
  }
}

// Each zone is a raised disc platform (a low cylinder) with a glowing rim so
// it reads as a distinct district on the grounded terrain.
// A procedural industrial deck texture (radial, so it suits the circular
// platforms): dark metal with concentric panel seams, radial segments, a
// hazard-stripe border and grunge. Shared across platforms.
let _deckTex = null;
function deckTexture() {
  if (_deckTex) return _deckTex;
  const S = 1024, c = document.createElement('canvas'); c.width = c.height = S;
  const g = c.getContext('2d'); const cx = S / 2, cy = S / 2, R = S / 2;
  g.fillStyle = '#232b37'; g.fillRect(0, 0, S, S);
  for (let i = 0; i < 26000; i++) {                 // grunge
    const a = Math.random() * 7, r = Math.random() * R, x = cx + Math.cos(a) * r, y = cy + Math.sin(a) * r;
    g.fillStyle = `rgba(${Math.random() < 0.5 ? '10,14,20' : '60,70,86'},${Math.random() * 0.14})`;
    g.fillRect(x, y, 2, 2);
  }
  g.strokeStyle = 'rgba(10,14,20,0.7)'; g.lineWidth = 3;    // concentric panel seams
  for (let k = 1; k <= 8; k++) { g.beginPath(); g.arc(cx, cy, R * k / 9, 0, 7); g.stroke(); }
  g.lineWidth = 2;                                          // radial segments
  for (let a = 0; a < 16; a++) { g.beginPath(); g.moveTo(cx, cy); g.lineTo(cx + Math.cos(a * Math.PI / 8) * R, cy + Math.sin(a * Math.PI / 8) * R); g.stroke(); }
  for (let a = 0; a < 360; a += 12) {                       // hazard-stripe border
    g.save(); g.translate(cx, cy); g.rotate(a * Math.PI / 180);
    g.fillStyle = (a / 12) % 2 ? '#c9a227' : '#1a1d24';
    g.fillRect(R * 0.9, -R * 0.11, R * 0.1 * 1.1, R * 0.11 * 2); g.restore();
  }
  const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = 4;
  _deckTex = t; return t;
}
// Scanned PBR plate maps (CC0 ambientCG MetalPlates006) tiled under the
// procedural deck markings — per-texture UV transforms (r152+) let the colour
// stay full-circle while normal/roughness/metalness tile 6x for real relief.
let _pbrDeck = null;
function pbrDeckMaps() {
  if (_pbrDeck) return _pbrDeck;
  const mk = (file, srgb) => {
    const t = texLoader.load(`./env/${file}`);
    t.wrapS = t.wrapT = THREE.RepeatWrapping; t.repeat.set(6, 6); t.anisotropy = 4;
    if (srgb) t.colorSpace = THREE.SRGBColorSpace;
    return t;
  };
  _pbrDeck = { normalMap: mk('deck_normal.jpg'), roughnessMap: mk('deck_rough.jpg'),
               metalnessMap: mk('deck_metal.jpg'), normalScale: new THREE.Vector2(0.9, 0.9) };
  return _pbrDeck;
}

const platformMeshes = [];       // hidden in AR so the real floor takes over
function buildPlatform(o) {
  const rad = o.s;
  const disc = new THREE.Mesh(
    new THREE.CylinderGeometry(rad, rad * 0.92, 2.4, 64),
    new THREE.MeshStandardMaterial({ color: 0x28313f, roughness: 0.55, metalness: 0.65 }));
  disc.position.set(o.x, -1.2, o.z); disc.receiveShadow = true; disc.castShadow = true; scene.add(disc);
  const deck = new THREE.Mesh(
    new THREE.CircleGeometry(rad * 0.985, 64),
    Object.assign(new THREE.MeshStandardMaterial({ map: deckTexture(), roughness: 0.9, metalness: 0.6 }),
      pbrDeckMaps()));   // real scanned plate relief under the procedural markings
  deck.rotation.x = -Math.PI / 2; deck.position.set(o.x, 0.06, o.z); deck.receiveShadow = true; scene.add(deck);
  const rim = new THREE.Mesh(
    new THREE.TorusGeometry(rad, 0.35, 12, 96),
    new THREE.MeshStandardMaterial({ color: 0x2a3550, emissive: 0x3f8bff, emissiveIntensity: 1.6, roughness: 0.3, metalness: 0.4 }));
  rim.rotation.x = Math.PI / 2; rim.position.set(o.x, 0.05, o.z); scene.add(rim);
  platformMeshes.push(disc, deck, rim);
}

// Factory atmosphere: warm work lighting + rising vapour so the Slakkenspoor
// reads as a live, lit plant rather than models on a dark disc.
const steam = [];
let _steamTex = null;
function steamTexture() {
  if (_steamTex) return _steamTex;
  const c = document.createElement('canvas'); c.width = c.height = 128;
  const g = c.getContext('2d'); const rg = g.createRadialGradient(64, 64, 2, 64, 64, 62);
  rg.addColorStop(0, 'rgba(230,238,250,0.9)'); rg.addColorStop(0.5, 'rgba(210,222,240,0.4)'); rg.addColorStop(1, 'rgba(210,222,240,0)');
  g.fillStyle = rg; g.fillRect(0, 0, 128, 128);
  const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; _steamTex = t; return t;
}
function buildFactoryAtmosphere(cx, cz) {
  for (const [dx, dz] of [[-24, 0], [0, 6], [22, -6]]) {           // warm work lamps (cheap, no shadows)
    const pl = new THREE.PointLight(0xffcf96, 60, 70, 2); pl.position.set(cx + dx, 12, cz + dz); scene.add(pl);
  }
  const tex = steamTexture();
  for (let i = 0; i < 30; i++) {
    const sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, transparent: true, opacity: 0, depthWrite: false }));
    sp.userData = { bx: cx - 42 + Math.random() * 84, bz: cz - 9 + Math.random() * 18, t: Math.random() };
    scene.add(sp); steam.push(sp);
  }
}
function updateSteam(dt) {
  for (const sp of steam) {
    const u = sp.userData; u.t += dt * 0.12; if (u.t > 1) u.t -= 1;
    const s = 5 + u.t * 9;
    sp.position.set(u.bx, (u.lift || 0) + 2 + u.t * 13, u.bz); sp.scale.set(s, s, 1);
    sp.material.opacity = Math.sin(u.t * Math.PI) * 0.2;
  }
}

// A floating name label above each zone (canvas sprite), so the player can see
// the six zones of Moleculia at a glance.
function buildZoneLabel(z) {
  const c = document.createElement('canvas'); c.width = 512; c.height = 128;
  const g = c.getContext('2d');
  g.fillStyle = 'rgba(8,12,22,0.72)'; roundRect(g, 8, 30, 496, 68, 16); g.fill();
  g.strokeStyle = '#6fe0ff'; g.lineWidth = 2; roundRect(g, 8, 30, 496, 68, 16); g.stroke();
  g.fillStyle = '#dff0ff'; g.font = 'bold 40px system-ui'; g.textAlign = 'center';
  g.fillText(z.name, 256, 78);
  const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace;
  const sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: t, transparent: true, depthTest: false }));
  sp.position.set(z.x, 22, z.z); sp.scale.set(28, 7, 1); scene.add(sp);
}
function roundRect(g, x, y, w, h, r) {
  g.beginPath(); g.moveTo(x + r, y);
  g.arcTo(x + w, y, x + w, y + h, r); g.arcTo(x + w, y + h, x, y + h, r);
  g.arcTo(x, y + h, x, y, r); g.arcTo(x, y, x + w, y, r); g.closePath();
}

function resize() {
  const w = innerWidth, h = innerHeight;
  renderer.setSize(w, h, false);
  composer.setSize(w, h); bloom.setSize(w / 2, h / 2);   // keep bloom half-res
  camera.aspect = w / h; camera.updateProjectionMatrix();
}
addEventListener('resize', resize); resize();

// ---------- player controller: W forward, S back, A/D strafe, mouse look ----------
const player = { pos: new THREE.Vector3(0, 1.8, 30), yaw: Math.PI, pitch: -0.02, speed: 30 };
const CAMS = {
  street: { pos: [0, 1.8, 46], yaw: Math.PI, pitch: -0.02 },
  overview: { pos: [60, 150, 90], yaw: -2.485, pitch: -0.74 },       // aerial of the whole archipelago
  factory: { pos: [-90, 62, 44], yaw: -2.09, pitch: -0.64 },          // the Slakkenspoor processing line
  biome: { pos: [0, 26, -95], yaw: Math.PI, pitch: -0.8 },            // the periodic table (element collection)
  pt: { pos: [16.6, 1.8, -128], yaw: Math.PI, pitch: 0.02 },          // standing in the table (by Oxygen)
  tank: { pos: [-110, 4.0, 17], yaw: -2.42, pitch: 0.04 },            // close-up: the HD leaching reactor
  plaza: { pos: [6, 1.8, 10], yaw: -0.6, pitch: 0.0 },
  plaza2: { pos: [6, 1.8, 30], yaw: Math.PI, pitch: -0.03 },  // looks toward plaza (for MP demo)
};
const preset = CAMS[params.get('cam')];
if (preset) { player.pos.set(...preset.pos); player.yaw = preset.yaw; player.pitch = preset.pitch; }
// ?tp=x,z[,yaw] — spawn at an exact spot (deep-links + headless e2e verification)
const tp = (params.get('tp') || '').split(',').map(Number);
if (tp.length >= 2 && tp.slice(0, 2).every(Number.isFinite)) {
  player.pos.x = tp[0]; player.pos.z = tp[1];
  if (Number.isFinite(tp[2])) player.yaw = tp[2];
}
const keys = {};
// Analog input from Quest Touch controllers / gamepads (fed by pollGamepads):
// mx/mz = left-stick move, lx/ly = right-stick look, sprint = stick click.
const pad = { mx: 0, mz: 0, lx: 0, ly: 0, sprint: false };
addEventListener('keydown', (e) => { keys[e.code] = true; });
addEventListener('keyup', (e) => { keys[e.code] = false; });
const canvas = renderer.domElement;
canvas.addEventListener('click', () => canvas.requestPointerLock && canvas.requestPointerLock());
// Intro overlay: "the Roblox teaser continues on the web" — dismiss to enter.
const introBtn = document.getElementById('intro-btn');
if (introBtn) introBtn.addEventListener('click', () => {
  const el = document.getElementById('intro'); if (el) el.style.display = 'none';
  if (canvas.requestPointerLock) canvas.requestPointerLock();
});
// Deep-links (a cam preset) or ?nointro skip the entry screen.
if (params.get('cam') || params.get('nointro')) {
  const el = document.getElementById('intro'); if (el) el.style.display = 'none';
}
addEventListener('mousemove', (e) => {
  if (document.pointerLockElement === canvas) {
    player.yaw -= e.movementX * 0.0022;
    player.pitch = Math.max(-1.3, Math.min(1.0, player.pitch - e.movementY * 0.0022));
  }
});
function step(dt) {
  const fwd = new THREE.Vector3(Math.sin(player.yaw), 0, Math.cos(player.yaw)); // look dir (horizontal)
  const right = new THREE.Vector3(-fwd.z, 0, fwd.x);
  const mv = new THREE.Vector3();
  const sp = player.speed * ((keys['ShiftLeft'] || pad.sprint) ? 2.2 : 1);
  if (keys['KeyW'] || keys['ArrowUp']) mv.add(fwd);      // W = forward
  if (keys['KeyS'] || keys['ArrowDown']) mv.sub(fwd);    // S = backward
  if (keys['KeyD'] || keys['ArrowRight']) mv.add(right);
  if (keys['KeyA'] || keys['ArrowLeft']) mv.sub(right);
  if (pad.mx || pad.mz) {                                 // gamepad left stick (analog)
    mv.add(fwd.clone().multiplyScalar(-pad.mz)).add(right.clone().multiplyScalar(pad.mx));
  }
  if (pad.lx || pad.ly) {                                 // gamepad right stick = look
    player.yaw -= pad.lx * dt * 2.6;
    player.pitch = Math.max(-1.3, Math.min(1.0, player.pitch - pad.ly * dt * 2.0));
  }
  if (mv.lengthSq() > 0) {
    mv.normalize();
    player.pos.add(mv.clone().multiplyScalar(sp * dt));
    player.vel = mv.multiplyScalar(sp);          // units/s — feeds predictive prefetch
  } else if (player.vel) player.vel.multiplyScalar(0.9);
  if (worldLoaded) {             // pre-load WORLD is the legacy default (240) and
    const half = WORLD / 2 - 2;  // would wrongly clip deep-link spawns in Moleculia
    player.pos.x = Math.max(-half, Math.min(half, player.pos.x));
    player.pos.z = Math.max(-half, Math.min(half, player.pos.z));
  }
  // collision: duw de speler uit massieve structuren (flat-mode; XR heeft eigen clamp)
  { const rp = xrCollide(player.pos.x, player.pos.z, player.pos.x, player.pos.z);
    player.pos.x = rp.x; player.pos.z = rp.z; }
  camera.position.copy(player.pos);
  const d = new THREE.Vector3(Math.sin(player.yaw) * Math.cos(player.pitch),
    Math.sin(player.pitch), Math.cos(player.yaw) * Math.cos(player.pitch));
  camera.lookAt(player.pos.clone().add(d));
}

// ---------- P2P/IPFS asset layer ----------
// If ipfs.json (a { models: CID, impostors: CID } map, same pattern as
// molgang-web/lab3d) is present, assets load from the IPFS gateway (P2P) with
// a local HTTP fallback; otherwise straight from the repo. Keeps the client
// bandwidth-thin and lets the world be served peer-to-peer.
let ASSET_BASE = { model: '../models/', imp: './impostors/' };
async function initAssetLayer() {
  try {
    const cfg = await (await fetch('./ipfs.json', { cache: 'no-cache' })).json();
    const gw = cfg.gateway || 'http://127.0.0.1:8080/ipfs/';
    if (cfg.models) ASSET_BASE.model = `${gw}${cfg.models}/`;
    if (cfg.impostors) ASSET_BASE.imp = `${gw}${cfg.impostors}/`;
    console.log('[world] P2P/IPFS asset layer active', ASSET_BASE);
  } catch (e) { /* no ipfs.json -> local */ }
}

// ---------- streaming: instantiate only what's near the camera ----------
const gltfLoader = new GLTFLoader();
const texLoader = new THREE.TextureLoader();

// Impostors are drawn as INSTANCED billboards: one InstancedMesh per type holds
// every instance of that type, so ~1000 impostors cost ~26 draw calls instead
// of ~1000 sprites. A tiny onBeforeCompile makes each instance face the camera
// (billboard) while keeping per-instance position + scale from world_gen.
function buildInstancedImpostors(impObjs) {
  const byType = {};
  for (const o of impObjs) (byType[o.ref] = byType[o.ref] || []).push(o);
  const geo = new THREE.PlaneGeometry(1, 1);
  geo.translate(0, 0.5, 0); // pivot at the base so it stands on the ground
  const shadowGeo = new THREE.PlaneGeometry(1, 1); shadowGeo.rotateX(-Math.PI / 2);
  const shadowMesh = new THREE.InstancedMesh(shadowGeo, shadowMaterial(), impObjs.length);
  let si = 0;
  const dummy = new THREE.Object3D();
  for (const [type, arr] of Object.entries(byType)) {
    const mat = new THREE.MeshBasicMaterial({ map: impostorTex(type), transparent: true, alphaTest: 0.4 });
    billboardify(mat);
    const inst = new THREE.InstancedMesh(geo, mat, arr.length);
    inst.frustumCulled = false;
    for (let i = 0; i < arr.length; i++) {
      const o = arr[i];
      dummy.position.set(o.x, 0, o.z); dummy.scale.set(o.s, o.s, o.s); dummy.rotation.set(0, 0, 0);
      dummy.updateMatrix(); inst.setMatrixAt(i, dummy.matrix);
      dummy.position.set(o.x, 0.04, o.z); dummy.scale.set(o.s * 0.8, o.s * 0.8, 1); dummy.rotation.set(0, 0, 0);
      dummy.updateMatrix(); shadowMesh.setMatrixAt(si++, dummy.matrix);
    }
    inst.instanceMatrix.needsUpdate = true;
    scene.add(inst);
  }
  shadowMesh.count = si; shadowMesh.instanceMatrix.needsUpdate = true;
  shadowMesh.frustumCulled = false; scene.add(shadowMesh);
}
// Make an InstancedMesh material billboard toward the camera (keep instance
// translation + uniform scale, but orient the quad in view space).
function billboardify(mat) {
  mat.onBeforeCompile = (sh) => {
    sh.vertexShader = sh.vertexShader.replace(
      '#include <begin_vertex>',
      `vec3 iPos = vec3(instanceMatrix[3]);
       float iScale = length(vec3(instanceMatrix[0]));
       vec3 transformed = iPos
         + (position.x * iScale) * vec3(modelViewMatrix[0][0], modelViewMatrix[1][0], modelViewMatrix[2][0])
         + (position.y * iScale) * vec3(modelViewMatrix[0][1], modelViewMatrix[1][1], modelViewMatrix[2][1]);`);
  };
}
const _texCache = new Map();
function impostorTex(type) {
  if (!_texCache.has(type)) {
    const t = texLoader.load(`${ASSET_BASE.imp}${type}.png`);
    t.colorSpace = THREE.SRGBColorSpace; _texCache.set(type, t);
  }
  return _texCache.get(type);
}
const glbProto = new Map();      // file -> loaded scene (prototype)
const glbLoads = new Map();      // file -> shared in-flight load promise
let objects = [];                // all placements from world.json
let assetIdx = [];               // indices of GLB-asset placements (streamed)
let impPlacements = [];          // impostor placements (instanced; kept for AR)
let impCount = 0;
const live = new Map();          // asset placement index -> Object3D (streamed)
const STREAM_IN = 95, STREAM_OUT = 120, MAX_LIVE = 260;

// Soft round ground shadow so impostors read as grounded, not floating cutouts.
let shadowMat = null;
function shadowMaterial() {
  if (!shadowMat) {
    const c = document.createElement('canvas'); c.width = c.height = 64;
    const g = c.getContext('2d');
    const rad = g.createRadialGradient(32, 32, 4, 32, 32, 30);
    rad.addColorStop(0, 'rgba(0,0,0,0.42)'); rad.addColorStop(1, 'rgba(0,0,0,0)');
    g.fillStyle = rad; g.fillRect(0, 0, 64, 64);
    const t = new THREE.CanvasTexture(c);
    shadowMat = new THREE.MeshBasicMaterial({ map: t, transparent: true, depthWrite: false });
  }
  return shadowMat;
}
function loadPrototype(ref) {
  const cached = glbProto.get(ref);
  if (cached) return Promise.resolve(cached);
  let load = glbLoads.get(ref);
  if (!load) {
    load = gltfLoader.loadAsync(`${ASSET_BASE.model}${ref}`)
      .then((g) => {
        const scene = g.scene;
        glbProto.set(ref, scene);
        return scene;
      })
      .finally(() => glbLoads.delete(ref));
    glbLoads.set(ref, load);
  }
  return load;
}
async function spawnAsset(o) {
  const proto = await loadPrototype(o.ref);
  const obj = proto.clone(true);
  obj.traverse((n) => { if (n.isMesh) { n.castShadow = true; n.receiveShadow = true; if (n.material) n.material.envMapIntensity = 1.1; } });
  const box = new THREE.Box3().setFromObject(obj);
  const size = box.getSize(new THREE.Vector3());
  const s = o.s / Math.max(size.x, size.z, 0.01);
  obj.scale.setScalar(s);
  const b2 = new THREE.Box3().setFromObject(obj);
  obj.position.set(o.x, -b2.min.y, o.z);
  obj.rotation.y = o.r;
  obj.userData.def = o;                 // for click/trigger inspection
  return obj;
}

// ---------- click/trigger inspection: what is this thing? ----------
// Trigger (VR) or left-click while pointer-locked (desktop) rays into the
// streamed props and shows name + what it does. PROP_INFO keys are the GLB
// refs from moleculia.json; interactive props also state their option.
const PROP_INFO = {
  'cooling_tower_hd.glb': ['Koeltoren', 'koelt proceswater voor de plant; de pluim is waterdamp'],
  'control_console_hd.glb': ['Operator-console', 'optie: bedien de plant via het reactorpaneel (kom dichterbij)'],
  'safety_station_hd.glb': ['Veiligheidsdouche', 'optie: PPE-check — nooddouche & oogspoeling (+MolCoins)'],
  'sample_station_hd.glb': ['XRF-monsterstation', 'optie: röntgen-assay van het leach-batch; één station is de portal naar het viscositeitslab'],
  'info_kiosk_hd.glb': ['Informatiekiosk', 'optie: wegwijzer door Moleculia'],
  'ank_counter_hd.glb': ['ANK Kredietunie', 'optie: saldo & handel in MolCoins'],
  'pipe_rack_hd.glb': ['Leidingbrug', 'draagt proces- en stoomleidingen tussen de units'],
  'gas_cylinder_rack_hd.glb': ['Gasflessenrek', 'EN 1089-3 schouderkleuren: weet wat er in de fles zit'],
  'storage_silo_hd.glb': ['Opslagsilo', 'bulkopslag voor geplette slak en toeslagstoffen'],
  'distillation_column_hd.glb': ['Destillatiekolom', 'scheidt vloeistoffen op kookpunt'],
  'torpedo_ladle_hd.glb': ['Torpedowagen', 'vervoert 300 t vloeibaar ruwijzer van hoogoven naar staalfabriek'],
  'slag_pot_hd.glb': ['Slakkenpot', 'vangt vloeibare slak — na koelen en malen wordt dit ons staalslak-slib (zie het viscositeitslab!)'],
  'gantry_crane_hd.glb': ['Portaalkraan', 'tilt slakkenpotten en schroot over spoor en kade'],
  'weighbridge_hd.glb': ['Weegbrug', 'optie: weeg de slakkenpot-transporten de poort in en uit'],
};
const extraInteractables = [];   // losse aanwijsbare props (bordjes e.d.)
const _inspectCaster = new THREE.Raycaster();
function inspectFrom(origin, dir) {
  _inspectCaster.set(origin, dir.normalize());
  _inspectCaster.far = 60;
  const pool = [];
  for (const obj of live.values()) pool.push(obj);
  if (gardenGroup) pool.push(gardenGroup);
  for (const e of extraInteractables) pool.push(e);
  const hits = _inspectCaster.intersectObjects(pool, true);
  for (const h of hits) {
    let n = h.object;
    while (n && !n.userData.def) n = n.parent;
    if (!n) continue;
    const def = n.userData.def;
    if (def.garden) return gardenActivate(def.garden);
    if (def.sign) return `🪧 ${def.name} — ${def.info}`;
    const info = PROP_INFO[def.ref];
    const name = info ? info[0]
      : def.ref.replace(/\.glb$/, '').replace(/_/g, ' ');
    return info ? `🔍 ${name} — ${info[1]}` : `🔍 ${name}`;
  }
  return null;
}
addEventListener('mousedown', (e) => {
  if (e.button !== 0 || !document.pointerLockElement) return;
  camera.getWorldPosition(_camPos);
  const dir = new THREE.Vector3();
  camera.getWorldDirection(dir);
  const msg = inspectFrom(_camPos.clone(), dir);
  if (msg) worldToast(msg);
});
window.__inspect = (ox, oy, oz, dx, dy, dz) =>       // e2e/debug hook
  inspectFrom(new THREE.Vector3(ox, oy, oz), new THREE.Vector3(dx, dy, dz));

// ---------- AR "glasses" overlay: label objects in view ----------
// Real objects are named from the identified asset; diffusion objects from the
// YOLOv9 class that re-recognised them (ar_labels.json). Photo-trained YOLO
// can't read the stylised live canvas, so labels come from known identities +
// YOLO's per-impostor recognition — real-time and correct for both kinds.
const arCanvas = document.getElementById('ar');
const arCtx = arCanvas.getContext('2d');
let arOn = params.get('ar') === '1';
let arLabels = {};
const humanize = (ref) => ref.replace(/\.glb$/, '').replace(/_/g, ' ');
function labelFor(o) {
  if (o.t === 'player') return { text: `${o.ref} · player`, kind: 'player' };
  if (o.t === 'asset') return { text: humanize(o.ref), kind: 'id' };
  const y = arLabels[o.ref];
  if (y && y.yolo && y.conf >= 0.5) {
    const tag = o.t === 'agent' ? 'YOLO·live' : 'YOLO';
    return { text: `${y.yolo} · ${tag} ${(y.conf * 100) | 0}%`, kind: 'yolo' };
  }
  return { text: `${o.ref.replace(/_/g, ' ')} · diffusion`, kind: 'gen' };
}
const arToggle = document.getElementById('ar-toggle');
function setAR(on) {
  arOn = on; arCanvas.style.display = on ? 'block' : 'none';
  arToggle.classList.toggle('on', on);
}
arToggle.addEventListener('click', () => setAR(!arOn));
addEventListener('keydown', (e) => { if (e.code === 'KeyR') setAR(!arOn); });

// ---------- LeCun JEPA world model, running in the browser ----------
// The tiny MLP trained by world_model.py (enc -> latent predictor -> decoder)
// predicts each vehicle's next heading; we roll it forward with physics to
// draw a 2 s predicted trajectory in the AR view — the world model's future,
// visualised. Curves at intersections (it learned "turn right there") where a
// straight-line guess would be wrong.
let WM = null;
fetch('./world_model.json', { cache: 'no-cache' }).then(r => r.json()).then(m => { WM = m; }).catch(() => {});
const gelu = (x) => 0.5 * x * (1 + Math.tanh(0.7978845608 * (x + 0.044715 * x * x * x)));
function layer(Wm, b, x) {
  const out = new Array(Wm.length);
  for (let o = 0; o < Wm.length; o++) { let s = b[o]; const row = Wm[o]; for (let i = 0; i < x.length; i++) s += row[i] * x[i]; out[o] = s; }
  return out;
}
const mlp = (m, x) => layer(m.w1, m.b1, layer(m.w0, m.b0, x).map(gelu));
const wmForward = (x) => mlp(WM.dec, mlp(WM.pred, mlp(WM.enc, x)));   // -> [cos, sin] next heading
function wmFeat(st) {
  const W2 = WM.meta.W, ra = WM.meta.roadAts;
  const dmin = Math.min(Math.min(...ra.map(r => Math.abs(st.x - r))), Math.min(...ra.map(r => Math.abs(st.z - r))));
  return [st.x / W2, st.z / W2, Math.cos(st.h), Math.sin(st.h), st.spd / 16, Math.tanh(dmin / 6)];
}
// Roll the world model H steps from an agent's K-window; returns predicted (x,z) path.
function wmPredictPath(win, H) {
  const dt = WM.meta.dt, path = [];
  let w = win.slice(), cur = w[w.length - 1];
  for (let s = 0; s < H; s++) {
    const feat = [];
    for (const st of w) feat.push(...wmFeat(st));
    const [c, si] = wmForward(feat);
    const nh = Math.atan2(si, c);
    const nx = cur.x + Math.cos(nh) * cur.spd * dt, nz = cur.z + Math.sin(nh) * cur.spd * dt;
    cur = { x: nx, z: nz, h: nh, spd: cur.spd };
    w = w.slice(1); w.push(cur); path.push([nx, nz]);
  }
  return path;
}

const _v = new THREE.Vector3();
function drawAR() {
  const w = innerWidth, h = innerHeight;
  if (arCanvas.width !== w) { arCanvas.width = w; arCanvas.height = h; }
  arCtx.clearRect(0, 0, w, h);
  // reticle + frame (the "glasses" feel)
  arCtx.strokeStyle = 'rgba(111,252,218,0.5)'; arCtx.lineWidth = 1;
  arCtx.strokeRect(10, 10, w - 20, h - 20);
  arCtx.beginPath(); arCtx.arc(w / 2, h / 2, 5, 0, 7); arCtx.stroke();

  const items = [];
  const consider = (o) => {
    const dx = o.x - player.pos.x, dz = o.z - player.pos.z;
    const dist = Math.hypot(dx, dz);
    if (dist > 70) return;
    _v.set(o.x, o.s * 0.6, o.z).project(camera);
    if (_v.z > 1) return;                          // behind camera
    const sx = (_v.x * 0.5 + 0.5) * w, sy = (-_v.y * 0.5 + 0.5) * h;
    if (sx < 0 || sx > w || sy < 0 || sy > h) return;
    items.push({ o, sx, sy, dist });
  };
  for (const [i, obj] of live) if (obj !== 'pending') consider(objects[i]);   // streamed models
  for (const o of impPlacements) consider(o);                                 // instanced impostors
  for (const m of agentMeshes.values())                                       // live moving traffic/peds
    consider({ x: m.sprite.position.x, z: m.sprite.position.z, s: agentSize[m.kind] || 3.2, t: 'agent', ref: m.kind });
  for (const [id, m] of playerMeshes)                                          // other players
    consider({ x: m.sprite.position.x, z: m.sprite.position.z, s: 3.4, t: 'player', ref: id });
  items.sort((a, b) => a.dist - b.dist);
  const COL = { id: '#6fe0ff', yolo: '#7fffb0', gen: '#ffcf7f', player: '#ff7fe0' };
  for (const it of items.slice(0, 46)) {
    const { o, sx, sy, dist } = it;
    const lab = labelFor(o);
    const col = COL[lab.kind];
    const bs = Math.max(14, 900 / (dist + 6));    // box scales with distance
    arCtx.strokeStyle = col; arCtx.lineWidth = 1.5;
    const bx = sx - bs / 2, by = sy - bs, L = bs * 0.32;
    // corner brackets
    arCtx.beginPath();
    arCtx.moveTo(bx, by + L); arCtx.lineTo(bx, by); arCtx.lineTo(bx + L, by);
    arCtx.moveTo(bx + bs - L, by); arCtx.lineTo(bx + bs, by); arCtx.lineTo(bx + bs, by + L);
    arCtx.moveTo(bx, by + bs - L); arCtx.lineTo(bx, by + bs); arCtx.lineTo(bx + L, by + bs);
    arCtx.moveTo(bx + bs - L, by + bs); arCtx.lineTo(bx + bs, by + bs); arCtx.lineTo(bx + bs, by + bs - L);
    arCtx.stroke();
    if (dist < 55) {
      arCtx.font = '12px system-ui'; const tw = arCtx.measureText(lab.text).width;
      arCtx.fillStyle = 'rgba(6,12,16,0.8)'; arCtx.fillRect(bx, by - 16, tw + 12, 15);
      arCtx.fillStyle = col; arCtx.fillText(lab.text, bx + 6, by - 4);
      arCtx.fillStyle = col; arCtx.fillRect(bx, by - 16, 3, 15);
    }
  }
  // JEPA world-model predicted trajectories for nearby vehicles.
  let predicted = 0;
  if (WM) {
    const VEH = new Set(['car', 'delivery_truck', 'van', 'city_bus', 'motorcycle']);
    for (const m of agentMeshes.values()) {
      if (!VEH.has(m.kind) || m.hist.length < 2) continue;
      const dx = m.sprite.position.x - player.pos.x, dz = m.sprite.position.z - player.pos.z;
      if (Math.hypot(dx, dz) > 60) continue;
      const win = m.hist.slice(); while (win.length < WM.meta.K) win.unshift(win[0]);
      const path = wmPredictPath(win.slice(-WM.meta.K), 10);   // ~2 s ahead
      arCtx.beginPath();
      let started = false;
      _v.set(m.sprite.position.x, 0.5, m.sprite.position.z).project(camera);
      if (_v.z <= 1) { arCtx.moveTo((_v.x * 0.5 + 0.5) * w, (-_v.y * 0.5 + 0.5) * h); started = true; }
      for (const [px, pz] of path) {
        _v.set(px, 0.5, pz).project(camera);
        if (_v.z > 1) { started = false; continue; }
        const sx = (_v.x * 0.5 + 0.5) * w, sy = (-_v.y * 0.5 + 0.5) * h;
        if (started) arCtx.lineTo(sx, sy); else { arCtx.moveTo(sx, sy); started = true; }
      }
      arCtx.strokeStyle = 'rgba(120,230,255,0.75)'; arCtx.lineWidth = 2; arCtx.stroke();
      const end = path[path.length - 1];
      _v.set(end[0], 0.5, end[1]).project(camera);
      if (_v.z <= 1) { arCtx.fillStyle = 'rgba(120,230,255,0.9)'; arCtx.beginPath(); arCtx.arc((_v.x * 0.5 + 0.5) * w, (-_v.y * 0.5 + 0.5) * h, 3, 0, 7); arCtx.fill(); }
      predicted++;
    }
  }
  arCtx.fillStyle = 'rgba(111,252,218,0.85)'; arCtx.font = 'bold 13px system-ui';
  arCtx.fillText(`AR VISION · ${items.length} tagged · ${predicted} JEPA-predicted paths · cyan=model green=YOLO amber=diffusion`, 22, h - 22);
}

// ---------- dynamic layer: moving agents from the Python sim (EVE-style) ----------
// The Python sim owns traffic + pedestrian positions; we poll a tiny JSON state
// a few times a second and interpolate between updates. Degrades silently to a
// static world if the sim server isn't running.
const SIM_BASE = params.get('sim') || 'http://127.0.0.1:8077';
const SIM_URL = SIM_BASE + '/state';
const agentMeshes = new Map();   // id -> { sprite, from, to, t }
let simOk = false, simPollMs = 150;

// ---------- client-side reactor: the same chemistry, no server needed ----------
// Ports process_sim.py so the process loop (operate -> V2O5 -> sell) works on a
// static host where the Python sim isn't running (the normal case for a published
// site). Activates whenever the sim is unreachable.
const CR = {
  temperature: 70, pressure: 180, flowRate: 4, pH: 2.5, reactorVolume: 50,
  particleSize: 'ground', deironized: false, roasted: false,
  conversion: 0, v2o5_kg: 0, batches: 0, manual: false, _tempTarget: 70, _t: 0,
};
let crClientActive = false;                       // true once we know there's no server
const LEACH_MULT = { chunk: 7, crushed: 3, ground: 1, powder: 0.3 };
const PRECIP = { Fe: [3.0, 4.5], Al: [4.0, 5.5], V: [1.8, 3.0] };
const clampf = (x, a, b) => Math.max(a, Math.min(b, x));
const arrheniusM = (tc, ea = 50) => Math.exp(-(ea * 1000) / 8.314 * (1 / (tc + 273.15) - 1 / 298.15));
const pressureM = (kPa) => clampf(kPa / 101.325, 0.3, 4);
const residenceM = (flow, vol) => (flow <= 0 ? 1 : clampf((1 - Math.exp(-((vol / flow) / 30))) / 0.632, 0.1, 1.5));
function precipF(metal, pH) { const w = PRECIP[metal]; if (!w) return 0; if (pH <= w[0]) return 0; if (pH >= w[1]) return 1; return (pH - w[0]) / (w[1] - w[0]); }
const crRate = () => arrheniusM(CR.temperature) * pressureM(CR.pressure) * residenceM(CR.flowRate, CR.reactorVolume);
const crRecovery = () => CR.conversion * precipF('V', CR.pH) * (CR.deironized ? 1 : (1 - precipF('Fe', CR.pH))) * (1 - precipF('Al', CR.pH));
function crTick(dt) {
  CR._t += dt;
  if (CR.manual) CR.temperature += (CR._tempTarget - CR.temperature) * Math.min(1, dt * 0.6);
  else CR.temperature = 70 + 18 * Math.sin(CR._t * 0.15);
  let k = 0.05 / (LEACH_MULT[CR.particleSize] || 1); if (CR.roasted) k *= 1.25;
  CR.conversion = clampf(CR.conversion + k * crRate() * (1 - CR.conversion) * dt, 0, 1);
  if (CR.conversion >= 0.995) { CR.v2o5_kg += 100 * 0.015 * crRecovery(); CR.batches++; CR.conversion = 0; }
}
const crStateObj = () => ({
  temperature: Math.round(CR.temperature * 10) / 10, pressure: Math.round(CR.pressure * 10) / 10,
  flowRate: CR.flowRate, pH: CR.pH, conversion: Math.round(CR.conversion * 1000) / 1000,
  rate: Math.round(crRate() * 100) / 100, yield: Math.round(crRecovery() * 1000) / 1000,
  particleSize: CR.particleSize, leachSpeed: Math.round(100 / (LEACH_MULT[CR.particleSize] || 1)) / 100,
  deironized: CR.deironized, roasted: CR.roasted, v2o5: Math.round(CR.v2o5_kg * 100) / 100,
  batches: CR.batches, manual: CR.manual,
});
function crSet(d) {
  CR.manual = true;
  const R = { temperature: [25, 95], pressure: [100, 300], flowRate: [1, 10], pH: [1, 6] };
  for (const k in R) if (k in d) { const v = clampf(+d[k], R[k][0], R[k][1]); if (k === 'temperature') CR._tempTarget = v; else CR[k] = v; }
  if (d.particleSize in LEACH_MULT) CR.particleSize = d.particleSize;
  for (const f of ['deironized', 'roasted']) if (f in d) CR[f] = !!d[f];
}
const crSell = () => { const kg = CR.v2o5_kg; CR.v2o5_kg = 0; return { kg: Math.round(kg * 100) / 100, coins: Math.round(kg * 500) }; };
// Push control changes to the client reactor (works offline) AND the server (if any).
function pushControls(d) {
  crSet(d);
  fetch(SIM_BASE + '/reactor/set', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(d) }).catch(() => {});
}
// Render one reactor state object (server- or client-sourced) into the HUD/panel.
function applyReactorState(rx) {
  if (rx) lastRx = rx;                 // kept for the XRF sample-station readout
  const rel = document.getElementById('reactor');
  if (rx && rel) rel.innerHTML = `⚗️ leach reactor · ${(rx.conversion * 100) | 0}% converted `
    + `<span style="opacity:.7">· ${rx.temperature}°C · ${rx.pressure}kPa · pH ${rx.pH} · rate ${rx.rate}× (Arrhenius)`
    + `${rx.manual ? '' : ' · idling'}</span>`;
  if (!rx || rx.yield == null) return;
  const yv = document.getElementById('y-val'); if (yv) yv.textContent = `${(rx.yield * 100) | 0}%`;
  const yp = document.getElementById('y-parts'); if (yp) yp.textContent = `= ${(rx.conversion * 100) | 0}% leached × selective pH-precip`;
  if (rx.particleSize) reflectParticleSize(rx.particleSize, rx.leachSpeed);
  reflectPrep(rx);
  if (rx.v2o5 != null) {
    const pv = document.getElementById('p-val'); if (pv) pv.textContent = `${rx.v2o5.toFixed(2)} kg`;
    const pb = document.getElementById('p-batches'); if (pb) pb.textContent = rx.batches ? `· ${rx.batches} batch${rx.batches === 1 ? '' : 'es'}` : '';
    if (lastBatches >= 0 && rx.batches > lastBatches && pv) { pv.classList.add('flash'); setTimeout(() => pv.classList.remove('flash'), 500); }
    lastBatches = rx.batches;
  }
  if (!controlsSynced && MOLECULIA) {
    controlsSynced = true;
    const fmt = { temperature: (v) => `${v | 0}°C`, pressure: (v) => `${v | 0} kPa`, flowRate: (v) => (+v).toFixed(1), pH: (v) => (+v).toFixed(1) };
    for (const key of ['temperature', 'pressure', 'flowRate', 'pH']) {
      const el = document.getElementById('c-' + key), lab = document.getElementById('v-' + key);
      if (el && rx[key] != null) { el.value = rx[key]; if (lab) lab.textContent = fmt[key](rx[key]); }
    }
  }
}
let controlsSynced = false;   // sync the slider panel to the reactor once, on first poll
let lastBatches = -1;          // detect batch completion to flash the product tally

// Multiplayer presence: a per-tab id; we POST our position and render others.
const MY_ID = 'p' + Math.random().toString(36).slice(2, 8);
const playerMeshes = new Map();  // id -> { sprite, from, to, t }
function playerMarker(id) {
  const c = document.createElement('canvas'); c.width = 128; c.height = 160;
  const g = c.getContext('2d');
  g.fillStyle = '#6ffcda'; g.beginPath();
  g.moveTo(64, 8); g.lineTo(96, 60); g.lineTo(72, 60); g.lineTo(72, 150); g.lineTo(56, 150);
  g.lineTo(56, 60); g.lineTo(32, 60); g.closePath(); g.fill();
  g.fillStyle = '#0b1a16'; g.font = 'bold 20px system-ui'; g.textAlign = 'center';
  g.fillText(id, 64, 130);
  const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace;
  const sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: t, transparent: true }));
  sp.center.set(0.5, 0); sp.scale.set(3, 3.7, 1);
  return sp;
}
const agentSize = { car: 3.4, delivery_truck: 4.6, van: 4.2, city_bus: 6.2, motorcycle: 2.8,
                    pedestrian: 3.4, woman_pedestrian: 3.4, worker: 3.4 };
function agentSpriteMat(kind) {
  const key = 'agent:' + kind;
  if (!_texCache.has(key)) {
    _texCache.set(key, new THREE.SpriteMaterial({ map: impostorTex(kind), transparent: true, alphaTest: 0.4 }));
  }
  return _texCache.get(key);
}
async function pollSim() {
  try {
    // Publish our position (shared-world presence), then read the world state.
    fetch(SIM_BASE + '/join', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: MY_ID, x: player.pos.x, z: player.pos.z, yaw: player.yaw }),
    }).catch(() => {});
    const st = await (await fetch(SIM_URL + '?id=' + MY_ID, { cache: 'no-cache' })).json();
    simOk = true;
    // Other players' avatars.
    const pseen = new Set();
    for (const p of (st.players || [])) {
      pseen.add(p.id);
      let pm = playerMeshes.get(p.id);
      if (!pm) { const sp = playerMarker(p.id); scene.add(sp); pm = { sprite: sp, from: { x: p.x, z: p.z }, to: { x: p.x, z: p.z }, t: 0 }; playerMeshes.set(p.id, pm); }
      else { pm.from = { x: pm.sprite.position.x, z: pm.sprite.position.z }; pm.to = { x: p.x, z: p.z }; pm.t = 0; }
    }
    for (const [id, pm] of playerMeshes) if (!pseen.has(id)) { scene.remove(pm.sprite); playerMeshes.delete(id); }
    const pel = document.getElementById('mp');
    if (pel) pel.textContent = `🌐 shared world · you + ${(st.players || []).length} other player(s) online`;
    const seen = new Set();
    for (const a of (MOLECULIA ? [] : st.agents)) {   // city traffic doesn't belong in the space factory
      seen.add(a.id);
      let m = agentMeshes.get(a.id);
      if (!m) {
        const sp = new THREE.Sprite(agentSpriteMat(a.k));
        sp.center.set(0.5, 0);
        const s = agentSize[a.k] || 3.2; sp.scale.set(s, s, 1);
        scene.add(sp);
        m = { sprite: sp, kind: a.k, from: { x: a.x, z: a.z }, to: { x: a.x, z: a.z }, t: 0, hist: [] };
        agentMeshes.set(a.id, m);
      } else {
        const fx = m.sprite.position.x, fz = m.sprite.position.z;
        const dx = a.x - fx, dz = a.z - fz, d = Math.hypot(dx, dz);
        if (d > 0.05 && d < 30) {   // ignore wrap jumps
          const h = Math.atan2(dz, dx), spd = d / (simPollMs / 1000);
          m.hist.push({ x: a.x, z: a.z, h, spd });
          if (m.hist.length > 4) m.hist.shift();
        }
        m.from = { x: fx, z: fz };
        m.to = { x: a.x, z: a.z }; m.t = 0;
      }
    }
    for (const [id, m] of agentMeshes) if (!seen.has(id)) { scene.remove(m.sprite); agentMeshes.delete(id); }
    const el = document.getElementById('sim');
    if (el) el.textContent = MOLECULIA
      ? `🐍 Python process sim live (Arrhenius/Henry/pH kinetics)`
      : `🐍 Python sim: ${st.n} live agents driving/walking`;
    applyReactorState(st.reactor);
  } catch (e) {
    simOk = false;                          // no server -> the client reactor drives the process
    const el = document.getElementById('sim');
    if (el) el.textContent = MOLECULIA ? '⚗️ process chemistry running in-browser (no server needed)'
                                       : '🐍 Python sim offline (static world) — run sim_server.py';
  }
  setTimeout(pollSim, simOk ? simPollMs : 3000);   // back off when there's no server
}
function updateAgents(dt) {
  if (!simOk) return;
  const lerp = (map) => {
    for (const m of map.values()) {
      m.t = Math.min(1, m.t + dt / (simPollMs / 1000));
      m.sprite.position.set(m.from.x + (m.to.x - m.from.x) * m.t, 0, m.from.z + (m.to.z - m.from.z) * m.t);
    }
  };
  lerp(agentMeshes); lerp(playerMeshes);
}

let streamTick = 0;
function stream() {
  const px = player.pos.x, pz = player.pos.z;
  // Cull out-of-range live objects.
  for (const [i, obj] of live) {
    const o = objects[i];
    const dx = o.x - px, dz = o.z - pz;
    if (dx * dx + dz * dz > STREAM_OUT * STREAM_OUT) {
      scene.remove(obj); live.delete(i);
    }
  }
  // Stream in near GLB assets only (impostors are instanced upfront — cheap).
  if (live.size < MAX_LIVE) {
    for (const i of assetIdx) {
      if (live.has(i)) continue;
      const o = objects[i];
      const dx = o.x - px, dz = o.z - pz;
      if (dx * dx + dz * dz > STREAM_IN * STREAM_IN) continue;
      live.set(i, 'pending');
        spawnAsset(o).then((obj) => {
        if (obj && live.get(i) === 'pending') { scene.add(obj); live.set(i, obj); }
        else if (!obj) live.delete(i);
      }).catch(() => live.delete(i));
      if (live.size >= MAX_LIVE) break;
    }
  }
  // C&C-style predictive map pre-fill: project the player 4 s along their
  // velocity and warm the GLB prototypes there, so the next sector's models are
  // already parsed when you arrive (no pop-in hitch).
  if (player.vel && player.vel.lengthSq() > 4) {
    const fx = px + player.vel.x * 4, fz = pz + player.vel.z * 4;
    for (const i of assetIdx) {
      const o = objects[i];
      if (glbProto.has(o.ref) || glbLoads.has(o.ref)) continue;
      const dx = o.x - fx, dz = o.z - fz;
      if (dx * dx + dz * dz > STREAM_IN * STREAM_IN) continue;
      // Warm the same shared promise used by visible placements; this avoids
      // duplicate network/parse work when the player reaches the next sector.
      loadPrototype(o.ref).catch(() => {});
    }
  }
  // Doom-style sector culling for the cheap sprite layers: element tiles and
  // steam only draw when their sector is near the player.
  if (elementSprites.size) {
    for (const rec of elementSprites.values()) {
      const dx = rec.o.x - px, dz = rec.o.z - pz;
      rec.sprite.visible = dx * dx + dz * dz < 150 * 150;
    }
  }
  for (const sp of steam) {
    const u = sp.userData, dx = u.bx - px, dz = u.bz - pz;
    sp.visible = dx * dx + dz * dz < 170 * 170;
  }
  $('#live').textContent = `streaming ${[...live.values()].filter((v) => v !== 'pending').length} models + ${impCount} instanced impostors`;
}

// ---------- WebXR: Quest 3 headset detection + AR passthrough toggle ----------
// Quickly detect a VR/AR headset (WebXR), let the player enter immersive mode
// (immersive-ar = Quest passthrough), and toggle AR on/off with a controller
// button — AR on shows the real room through the world, AR off is full VR.
renderer.xr.enabled = true;
let xrMode = null;                     // 'immersive-ar' | 'immersive-vr' | null
let xrAR = true;                       // passthrough visible when in AR
const skyBg = scene.background;
const xrBtn = document.getElementById('xr-btn');
const xrStat = document.getElementById('xr');

async function detectXR() {
  if (!('xr' in navigator)) { if (xrStat) xrStat.textContent = '🕶️ no WebXR in this browser'; return; }
  const ar = await navigator.xr.isSessionSupported('immersive-ar').catch(() => false);
  const vr = await navigator.xr.isSessionSupported('immersive-vr').catch(() => false);
  xrMode = ar ? 'immersive-ar' : vr ? 'immersive-vr' : null;
  if (!xrMode) { if (xrStat) xrStat.textContent = '🕶️ no VR/AR headset detected'; return; }
  if (xrStat) xrStat.textContent = `🕶️ ${ar ? 'AR/VR' : 'VR'} headset detected — Quest-ready`;
  if (xrBtn) { xrBtn.style.display = 'block'; xrBtn.textContent = ar ? '🥽 Enter AR' : '🥽 Enter VR'; }
}
// XR settings (persisted; the ⚙ options menu edits these live)
const XRS_KEY = 'molgang.xr';
const xrSettings = { hideFloorAR: true, floorOffset: 0, speed: 6 };
try { Object.assign(xrSettings, JSON.parse(localStorage.getItem(XRS_KEY) || '{}')); } catch (e) { /* fresh */ }
function saveXrSettings() { try { localStorage.setItem(XRS_KEY, JSON.stringify(xrSettings)); } catch (e) { /* quota */ } }
function setFloorHidden(h) { for (const m of platformMeshes) m.visible = !h; }

// In-headset toast: DOM overlays are invisible inside an immersive session, so
// interaction feedback renders as a canvas sprite floating in front of the eyes.
let xrToastSpr = null, xrToastUntil = 0;
function xrToastShow(msg) {
  const c = document.createElement('canvas'); c.width = 1024; c.height = 112;
  const g = c.getContext('2d');
  g.fillStyle = 'rgba(10,14,20,0.85)'; roundRect(g, 4, 4, 1016, 104, 26); g.fill();
  g.strokeStyle = '#2c704a'; g.lineWidth = 3; roundRect(g, 4, 4, 1016, 104, 26); g.stroke();
  g.fillStyle = '#eef4fb'; g.font = '38px system-ui'; g.textAlign = 'center'; g.textBaseline = 'middle';
  g.fillText(msg.length > 58 ? msg.slice(0, 57) + '…' : msg, 512, 58);
  const tex = new THREE.CanvasTexture(c); tex.colorSpace = THREE.SRGBColorSpace;
  if (!xrToastSpr) {
    xrToastSpr = new THREE.Sprite(new THREE.SpriteMaterial({ transparent: true, depthTest: false }));
    xrToastSpr.scale.set(1.5, 0.165, 1); xrToastSpr.renderOrder = 999; scene.add(xrToastSpr);
  }
  if (xrToastSpr.material.map) xrToastSpr.material.map.dispose();
  xrToastSpr.material.map = tex; xrToastSpr.material.needsUpdate = true;
  xrToastSpr.visible = true; xrToastUntil = performance.now() + 3800;
}
const _xrFwd = new THREE.Vector3(), _camPos = new THREE.Vector3();
function tickXrToast(now) {
  if (!xrToastSpr || !xrToastSpr.visible) return;
  if (now > xrToastUntil) { xrToastSpr.visible = false; return; }
  camera.getWorldPosition(_camPos); camera.getWorldDirection(_xrFwd);
  xrToastSpr.position.set(_camPos.x + _xrFwd.x * 1.5, _camPos.y - 0.18 + _xrFwd.y * 1.5,
    _camPos.z + _xrFwd.z * 1.5);
}


/* ============================================================
   VR-interactie: controller-laser, wereld-menu en collision.
   (Toegevoegd voor betere gameplay op Meta Quest — trigger = menu.)
   ============================================================ */
let xrMenu = {};                                   // { group, rows, actions }
const XR_PASSABLE = new Set([                       // grote props die je toch mag passeren
  'info_kiosk_hd.glb', 'billboard_hd.glb', 'signpost_hd.glb',
]);

function xrMenuClose() {
  if (xrMenu.group) {
    scene.remove(xrMenu.group);
    xrMenu.group.traverse((o) => { if (o.geometry) o.geometry.dispose(); if (o.material) { if (o.material.map) o.material.map.dispose(); o.material.dispose(); } });
  }
  xrMenu = {};
}

function xrMenuBuild(title, rows, point) {
  xrMenuClose();
  const W = 600, RH = 82, H = 74 + rows.length * RH;
  const cv = document.createElement('canvas'); cv.width = W; cv.height = H;
  const g = cv.getContext('2d');
  g.fillStyle = 'rgba(12,16,24,0.95)'; roundRect(g, 4, 4, W - 8, H - 8, 20); g.fill();
  g.strokeStyle = '#3fb6a8'; g.lineWidth = 4; roundRect(g, 4, 4, W - 8, H - 8, 20); g.stroke();
  g.textAlign = 'left'; g.textBaseline = 'middle';
  g.fillStyle = '#9fffd9'; g.font = 'bold 34px system-ui';
  g.fillText(String(title).slice(0, 28), 28, 40);
  g.font = '30px system-ui';
  rows.forEach((r, idx) => {
    const y = 74 + idx * RH;
    g.fillStyle = 'rgba(63,182,168,0.12)'; roundRect(g, 16, y + 8, W - 32, RH - 16, 14); g.fill();
    g.fillStyle = '#eef4fb'; g.fillText(String(r.l).slice(0, 32), 36, y + RH / 2 + 3);
  });
  const tex = new THREE.CanvasTexture(cv); tex.colorSpace = THREE.SRGBColorSpace;
  const pw = 0.95, aspect = H / W, ph = pw * aspect;
  const grp = new THREE.Group();
  const panel = new THREE.Mesh(new THREE.PlaneGeometry(pw, ph),
    new THREE.MeshBasicMaterial({ map: tex, transparent: true, depthTest: false }));
  panel.renderOrder = 1000; grp.add(panel);
  const rowMeshes = [];
  rows.forEach((r, idx) => {
    const yc = 74 + idx * RH + RH / 2;
    const rm = new THREE.Mesh(new THREE.PlaneGeometry(pw * 0.94, (RH - 16) / H * ph),
      new THREE.MeshBasicMaterial({ transparent: true, opacity: 0, depthTest: false }));
    rm.position.set(0, (0.5 - yc / H) * ph, 0.002);
    rm.userData.rowIndex = idx; grp.add(rm); rowMeshes.push(rm);
  });
  camera.getWorldPosition(_camPos);
  const toP = _camPos.clone().sub(point); toP.y = 0;
  if (toP.lengthSq() < 1e-4) toP.set(0, 0, 1);
  toP.normalize();
  grp.position.copy(point).add(toP.multiplyScalar(0.4));
  grp.position.y = Math.max(point.y, 1.3);
  grp.lookAt(_camPos);
  scene.add(grp);
  xrMenu = { group: grp, rows: rowMeshes, actions: rows.map((r) => r.a) };
}

function xrMenuInvoke(i) { const a = xrMenu.actions && xrMenu.actions[i]; if (a) a(); }

function xrGardenApply(i, tool) {
  try { gardenActivate('tool:' + tool); const r = gardenActivate('plot:' + i);
    if (typeof r === 'string') xrToastShow(r); } catch (e) { /* garden not ready */ }
  xrMenuClose();
}

function xrCropMenu(i, point) {
  const list = (typeof crops !== 'undefined' && crops) ? crops.slice(0, 6) : [];
  const rows = list.map((c) => ({ l: '\U0001F331 ' + c.name, a: () => xrGardenApply(i, c.id) }));
  rows.push({ l: '← terug', a: () => xrOpenMenuFor({ garden: 'plot:' + i }, point) });
  xrMenuBuild('Kies gewas — vak ' + (i + 1), rows, point);
}

function xrOpenMenuFor(def, point) {
  if (def.garden) {
    const [kind, val] = def.garden.split(':');
    if (kind === 'plot') {
      const i = +val;
      xrMenuBuild('Plantvak ' + (i + 1), [
        { l: '\U0001F331 Zaaien…', a: () => xrCropMenu(i, point) },
        { l: '\U0001F4A7 Water geven', a: () => xrGardenApply(i, 'water') },
        { l: '\U0001F9EA Bemesten', a: () => xrGardenApply(i, 'fertilize') },
        { l: '\U0001F33E Oogsten', a: () => xrGardenApply(i, 'harvest') },
      ], point);
    } else {
      let r; try { r = gardenActivate(def.garden); } catch (e) { r = null; }
      if (typeof r === 'string') xrToastShow(r);
      xrMenuClose();
    }
    return;
  }
  if (def.sign) {
    xrMenuBuild('\U0001FAA7 ' + (def.name || 'Bord'),
      [{ l: def.info || 'plek in Moleculia', a: xrMenuClose }, { l: 'Sluiten', a: xrMenuClose }], point);
    return;
  }
  const info = def.ref ? PROP_INFO[def.ref] : null;
  const name = info ? info[0] : (def.ref ? def.ref.replace(/\.glb$/, '').replace(/_/g, ' ') : 'Object');
  xrMenuBuild('\U0001F50D ' + name,
    [{ l: info ? info[1] : 'geen extra info', a: xrMenuClose }, { l: 'Sluiten', a: xrMenuClose }], point);
}

function xrOnSelect(origin, dir) {
  try {
    _inspectCaster.set(origin, dir.clone().normalize()); _inspectCaster.far = 60;
    if (xrMenu.group) {                              // eerst: klik op een menu-rij
      const mh = _inspectCaster.intersectObjects(xrMenu.rows, true)[0];
      if (mh) { let n = mh.object; while (n && n.userData.rowIndex === undefined) n = n.parent;
        if (n) { xrMenuInvoke(n.userData.rowIndex); return; } }
    }
    const pool = [];
    for (const o of live.values()) pool.push(o);
    if (gardenGroup) pool.push(gardenGroup);
    for (const e of extraInteractables) pool.push(e);
    const hits = _inspectCaster.intersectObjects(pool, true);
    for (const h of hits) { let n = h.object; while (n && !n.userData.def) n = n.parent;
      if (!n) continue; return xrOpenMenuFor(n.userData.def, h.point); }
    xrMenuClose();                                    // niets geraakt -> menu weg
  } catch (e) { /* best-effort */ }
}

// Stick-locomotie botst tegen grote massieve props (Nexus-hub, torens, silo's).
function xrCollide(nx, nz, px, pz) {
  if (window.__molgangNoCollide) return { x: nx, z: nz };
  const PR = 0.35; let x = nx, z = nz;
  for (let pass = 0; pass < 2; pass++) {
    for (const g of live.values()) {
      const d = g.userData && g.userData.def;
      // structuren (s>=3) blokkeren; kleine props/pedestals (s<3) blijven beloopbaar
      if (!d || !(d.s >= 3) || (d.ref && XR_PASSABLE.has(d.ref))) continue;
      const rr = d.s * 0.32 + PR; let dx = x - d.x, dz = z - d.z, dist = Math.hypot(dx, dz);
      if (dist < rr) { if (dist < 1e-4) { dx = 1; dz = 0; dist = 1; } const k = rr / dist; x = d.x + dx * k; z = d.z + dz * k; }
    }
  }
  return { x, z };
}

async function enterXR() {
  if (!xrMode) return;
  const opts = xrMode === 'immersive-ar'
    ? { optionalFeatures: ['local-floor', 'bounded-floor', 'hand-tracking'] }
    : { optionalFeatures: ['local-floor'] };
  const session = await navigator.xr.requestSession(xrMode, opts);
  renderer.xr.setReferenceSpaceType('local-floor');
  await renderer.xr.setSession(session);
  xrAR = (xrMode === 'immersive-ar');
  scene.background = xrAR ? null : skyBg;      // AR on = passthrough shows through
  // In AR the virtual platform floor hides by default so the REAL floor takes
  // over (it used to float too high and run on forever); ⚙ can re-show it.
  setFloorHidden(xrAR && xrSettings.hideFloorAR);
  const toggleAR = () => {
    xrAR = !xrAR; scene.background = xrAR ? null : skyBg;
    setFloorHidden(xrAR && xrSettings.hideFloorAR);
    xrToastShow(xrAR ? 'AR passthrough ON' : 'Full VR — A toggles AR');
  };
  for (const src of session.inputSources) if (src.gamepad) src._prev = [];
  // The reference-space offset is the walkable position: the thumbstick and
  // zone-teleport move it, physical walking moves the camera inside it, and
  // the loop syncs player.pos to the camera's WORLD position every frame — so
  // streaming, interactions, element collection and the sun all follow the
  // headset (they used to stay parked at the spawn point: barely any objects).
  const xrOff = { x: 0, z: 0, yaw: 0, base: null };
  xrActiveSession = session;
  session.__controllers = [];
  for (let ci = 0; ci < 2; ci++) {
    const ctl = renderer.xr.getController(ci);
    const lg = new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(0, 0, 0), new THREE.Vector3(0, 0, -1)]);
    const laser = new THREE.Line(lg, new THREE.LineBasicMaterial({ color: 0x3f6f7f, transparent: true, opacity: 0.5, depthTest: false }));
    laser.name = 'laser'; laser.renderOrder = 998; ctl.add(laser);
    scene.add(ctl); session.__controllers.push(ctl);
  }
  session.__marker = new THREE.Mesh(new THREE.SphereGeometry(0.03, 14, 12),
    new THREE.MeshBasicMaterial({ color: 0x9fffd9, transparent: true, opacity: 0.9, depthTest: false }));
  session.__marker.renderOrder = 999; session.__marker.visible = false; scene.add(session.__marker);
  session.__frame = (dt, now) => {
    try {
      if (xrMenu.group) { camera.getWorldPosition(_camPos); xrMenu.group.lookAt(_camPos); }
      for (const ctl of (session.__controllers || [])) {
        const laser = ctl.getObjectByName('laser'); if (!laser) continue;
        const o = new THREE.Vector3().setFromMatrixPosition(ctl.matrixWorld);
        const dir = new THREE.Vector3(0, 0, -1).transformDirection(ctl.matrixWorld);
        _inspectCaster.set(o, dir); _inspectCaster.far = 60;
        const pool = [];
        for (const g of live.values()) pool.push(g);
        if (gardenGroup) pool.push(gardenGroup);
        for (const e of extraInteractables) pool.push(e);
        if (xrMenu.group) pool.push(xrMenu.group);
        const h = _inspectCaster.intersectObjects(pool, true)[0];
        let act = false, d = 5;
        if (h) { d = Math.min(h.distance, 5); let n = h.object;
          while (n && n.userData.def === undefined && n.userData.rowIndex === undefined) n = n.parent;
          act = !!n; if (act && (!session.__best || h.distance < session.__best.dist)) session.__best = { p: h.point.clone(), dist: h.distance }; }
        laser.scale.z = d;
        laser.material.color.setHex(act ? 0x9fffd9 : 0x3f6f7f);
        laser.material.opacity = act ? 0.95 : 0.5;
      }
      if (session.__marker) {
        if (session.__best) { session.__marker.visible = true; session.__marker.position.copy(session.__best.p);
          session.__marker.scale.setScalar(0.7 + 0.25 * Math.sin(now * 0.008)); }
        else session.__marker.visible = false;
        session.__best = null;
      }
    } catch (e) { /* frame best-effort */ }
  };
  session.__recenter = () => { xrOff.x = 0; xrOff.z = 0; xrOff.yaw = 0; session.__syncSpace(); xrToastShow('🧭 world recentered'); };
  session.__syncSpace = () => {
    xrOff.base = xrOff.base || renderer.xr.getReferenceSpace();
    if (!xrOff.base || !window.XRRigidTransform) return;
    // Offset transform T with cam_world = R(yaw)·phys + offset, so snap-turn
    // rotates the world around the player instead of around the play origin.
    const m = new THREE.Matrix4().makeRotationY(-xrOff.yaw).multiply(
      new THREE.Matrix4().makeTranslation(-xrOff.x, -xrSettings.floorOffset, -xrOff.z));
    const p = new THREE.Vector3(), q = new THREE.Quaternion(), sc = new THREE.Vector3();
    m.decompose(p, q, sc);
    renderer.xr.setReferenceSpace(xrOff.base.getOffsetReferenceSpace(
      new XRRigidTransform({ x: p.x, y: p.y, z: p.z },
        { x: q.x, y: q.y, z: q.z, w: q.w })));
  };
  // Snap-turn (right stick flick): rotate the offset about the player's
  // current world position so the view pivots in place, comfort-style.
  const snapTurn = (dir) => {
    const d = -dir * Math.PI / 4;                 // push right = turn right
    camera.getWorldPosition(_camPos);
    const vx = xrOff.x - _camPos.x, vz = xrOff.z - _camPos.z;
    const c = Math.cos(d), s = Math.sin(d);
    xrOff.x = _camPos.x + (c * vx + s * vz);
    xrOff.z = _camPos.z + (-s * vx + c * vz);
    xrOff.yaw += d;
    session.__syncSpace();
  };
  // B/Y teleports through the zones (the "reposition" ask): the next zone's
  // centre lands ~6 m in front of where you physically stand.
  let zoneCycle = 0;
  const teleportNextZone = () => {
    const zones = (window.__molgangZones || []);
    if (!zones.length) return;
    const z = zones[zoneCycle++ % zones.length];
    camera.getWorldPosition(_camPos); camera.getWorldDirection(_xrFwd);
    _xrFwd.y = 0; _xrFwd.normalize();
    const tx = z.x - _xrFwd.x * (z.r ? Math.min(z.r * 0.55, 14) : 6);
    const tz = z.z - _xrFwd.z * (z.r ? Math.min(z.r * 0.55, 14) : 6);
    xrOff.x += tx - _camPos.x; xrOff.z += tz - _camPos.z;
    session.__syncSpace();
    xrToastShow(`→ ${z.name}`);
  };
  session.__pollButtons = (dt) => {
    for (const src of session.inputSources) {
      const gp = src.gamepad; if (!gp) continue;
      src._prev = src._prev || [];
      gp.buttons.forEach((b, i) => {
        if (b.pressed && !src._prev[i]) {
          if (i === 4) toggleAR();               // A / X — AR passthrough
          if (i === 5) teleportNextZone();       // B / Y — reposition to next zone
        }
        src._prev[i] = b.pressed;
      });
      const ax = Math.abs(gp.axes[2] || 0) > 0.16 ? gp.axes[2] : 0;   // xr-standard thumbstick
      const ay = Math.abs(gp.axes[3] || 0) > 0.16 ? gp.axes[3] : 0;
      if (src.handedness === 'right') {
        // Right stick X = snap-turn (armed flick, no drift); Y reserved.
        if (Math.abs(gp.axes[2] || 0) < 0.35) src._snapArmed = true;
        else if (src._snapArmed && Math.abs(gp.axes[2]) > 0.6) {
          src._snapArmed = false;
          snapTurn(Math.sign(gp.axes[2]));
        }
      } else if ((ax || ay) && dt) {
        // Left (or unknown-hand) stick = full locomotion: forward, back
        // and strafe, relative to where you look.
        camera.getWorldDirection(_xrFwd); _xrFwd.y = 0; _xrFwd.normalize();
        const right = { x: -_xrFwd.z, z: _xrFwd.x };
        const sp = (xrSettings.speed || 6) * dt;
        const ddx = (_xrFwd.x * -ay + right.x * ax) * sp;
        const ddz = (_xrFwd.z * -ay + right.z * ax) * sp;
        camera.getWorldPosition(_camPos);
        const rp = xrCollide(_camPos.x + ddx, _camPos.z + ddz, _camPos.x, _camPos.z);
        xrOff.x += rp.x - _camPos.x; xrOff.z += rp.z - _camPos.z;
        session.__syncSpace();
      }
    }
  };
  // Trigger = inspect: ray from the controller, show info/options for the
  // prop you point at (PROP_INFO below; interactive props state their use).
  session.addEventListener('select', (ev) => {
    try {
      const src = ev.inputSource;
      try { const ha = src && src.gamepad && src.gamepad.hapticActuators && src.gamepad.hapticActuators[0];
        if (ha && ha.pulse) ha.pulse(0.5, 45); } catch (e2) { /* geen haptics */ }
      const frame = ev.frame;
      const ref = renderer.xr.getReferenceSpace();
      const pose = frame && src.targetRaySpace
        ? frame.getPose(src.targetRaySpace, ref) : null;
      if (!pose) return;
      const o = pose.transform.position, d = pose.transform.orientation;
      const dir = new THREE.Vector3(0, 0, -1)
        .applyQuaternion(new THREE.Quaternion(d.x, d.y, d.z, d.w));
      xrOnSelect(new THREE.Vector3(o.x, o.y, o.z), dir);
    } catch { /* inspection is best-effort */ }
  });
  session.__syncSpace();                          // apply the saved floor offset
  xrToastShow('🥽 L-stick = lopen (alle richtingen) · R-stick = draaien · trigger = menu/kies · A = AR · B = zone');
  session.addEventListener('end', () => {
    scene.background = skyBg; setFloorHidden(false); xrActiveSession = null;
    if (xrBtn) xrBtn.disabled = false;
  });
}
let xrActiveSession = null;
if (xrBtn) xrBtn.addEventListener('click', () => { xrBtn.disabled = true; enterXR().catch((e) => { xrBtn.disabled = false; if (xrStat) xrStat.textContent = '🕶️ XR start failed: ' + e.message; }); });
detectXR();

// ---------- Quest Touch / gamepad in the flat browser + 🎬 cinema mode ----------
// The Meta Quest Browser exposes the Touch controllers through the Gamepad API
// but maps nothing to the page, so the game was unplayable on a Quest 3S without
// a paired mouse. Two modes, switched automatically:
//  · world mode — left stick walks (analog), right stick looks, stick-click
//    sprints; plays exactly like WASD + pointer lock.
//  · cursor mode — whenever a DOM panel is open (intro/fertlab/farm/factory/
//    chemsim): the sticks drive a virtual cursor and the trigger clicks, i.e.
//    the controller behaves as a mouse. B/squeeze closes the panel (Escape).
// Cinema: fullscreen is what makes the Quest Browser expand the page onto its
// big curved theater screen; on desktop it is a plain fullscreen toggle.
const OVERLAY_IDS = ['intro', 'fertlab', 'farm', 'factory', 'chemsim', 'options'];
const overlayOpen = () => OVERLAY_IDS.some((id) => {
  const el = document.getElementById(id);
  return el && getComputedStyle(el).display !== 'none';
});
let gpCursor = null, gpX = innerWidth / 2, gpY = innerHeight / 2, gpSeen = 0;
const gpPrev = {};                       // per-pad button state for edge detection
function gpEnsureCursor() {
  if (gpCursor) return gpCursor;
  gpCursor = document.createElement('div');
  gpCursor.style.cssText = 'position:fixed;left:0;top:0;width:20px;height:20px;'
    + 'margin:-10px 0 0 -10px;border:2px solid #6ffcda;border-radius:50%;'
    + 'background:rgba(111,252,218,.22);box-shadow:0 0 10px rgba(111,252,218,.6);'
    + 'pointer-events:none;z-index:99;transition:opacity .3s;opacity:0';
  document.body.appendChild(gpCursor);
  return gpCursor;
}
function gpClick() {
  const el = document.elementFromPoint(gpX, gpY);
  if (!el) return;
  const init = { bubbles: true, cancelable: true, clientX: gpX, clientY: gpY, view: window, button: 0 };
  el.dispatchEvent(new PointerEvent('pointerdown', init));
  el.dispatchEvent(new MouseEvent('mousedown', init));
  el.dispatchEvent(new PointerEvent('pointerup', init));
  el.dispatchEvent(new MouseEvent('mouseup', init));
  el.dispatchEvent(new MouseEvent('click', init));
}
const gpDead = (v) => (Math.abs(v) > 0.16 ? v : 0);
function pollGamepads(dt, now) {
  pad.mx = pad.mz = pad.lx = pad.ly = 0;
  if (renderer.xr.isPresenting || !navigator.getGamepads) return;
  const inPanel = overlayOpen();
  let active = false;
  for (const gp of navigator.getGamepads()) {
    if (!gp || !gp.connected) continue;
    const ax0 = gpDead(gp.axes[0] || 0), ay0 = gpDead(gp.axes[1] || 0);
    const ax1 = gpDead(gp.axes[2] || 0), ay1 = gpDead(gp.axes[3] || 0);
    if (ax0 || ay0 || ax1 || ay1) active = true;
    if (inPanel) {                       // cursor mode: either stick moves the cursor
      gpX = Math.max(0, Math.min(innerWidth, gpX + (ax0 + ax1) * 1000 * dt));
      gpY = Math.max(0, Math.min(innerHeight, gpY + (ay0 + ay1) * 1000 * dt));
    } else {                             // world mode: move + look
      pad.mx += ax0; pad.mz += ay0; pad.lx += ax1; pad.ly += ay1;
    }
    const prev = gpPrev[gp.index] || (gpPrev[gp.index] = {});
    gp.buttons.forEach((b, i) => {
      const was = prev[i] || false; prev[i] = b.pressed;
      if (b.pressed === was) return;
      active = true;
      if (i === 0 && b.pressed && inPanel) gpClick();               // trigger/A = click
      if (i === 0 && b.pressed && !inPanel) gpX = innerWidth / 2, gpY = innerHeight / 2;
      if (i === 1 && b.pressed) {                                   // squeeze/B = close panel
        for (const id of OVERLAY_IDS) {
          const el = document.getElementById(id);
          if (el && id !== 'intro' && getComputedStyle(el).display !== 'none') el.style.display = 'none';
        }
      }
      if ((i === 10 || i === 11) && !inPanel) pad.sprint = b.pressed; // stick click = sprint
    });
  }
  if (active && inPanel) {
    gpSeen = now;
    gpEnsureCursor().style.opacity = '1';
    gpCursor.style.left = gpX + 'px'; gpCursor.style.top = gpY + 'px';
    const el = document.elementFromPoint(gpX, gpY);
    if (el) el.dispatchEvent(new PointerEvent('pointermove',
      { bubbles: true, clientX: gpX, clientY: gpY, pointerType: 'mouse' }));
  } else if (gpCursor && (!inPanel || now - gpSeen > 4000)) {
    gpCursor.style.opacity = '0';
  }
}

// 🎬 cinema-mode button (bottom of the right-hand button stack)
const cinemaBtn = document.getElementById('cinema-btn');
if (cinemaBtn) {
  cinemaBtn.addEventListener('click', () => {
    if (document.fullscreenElement) document.exitFullscreen();
    else document.documentElement.requestFullscreen({ navigationUI: 'hide' }).catch(() => {});
  });
  document.addEventListener('fullscreenchange', () => {
    cinemaBtn.textContent = document.fullscreenElement ? '🎬 Exit cinema' : '🎬 Cinema';
  });
}

// ---------- Slakkenspoor process controls (player = plant operator) ----------
// The player drives the real chemistry: the sliders POST setpoints to the Python
// sim, which owns the reactor (server authority). Yield = how much vanadium is
// recovered (leached x precipitated at the chosen pH) — a real, teachable optimum.
function initControls() {
  const panel = document.getElementById('controls');
  if (!panel) return;
  panel.style.display = 'block';
  const fmt = { temperature: (v) => `${v | 0}°C`, pressure: (v) => `${v | 0} kPa`,
                flowRate: (v) => (+v).toFixed(1), pH: (v) => (+v).toFixed(1) };
  let timer = null, pending = {};
  const flush = () => { timer = null; pushControls(pending); pending = {}; };
  for (const key of ['temperature', 'pressure', 'flowRate', 'pH']) {
    const el = document.getElementById('c-' + key), lab = document.getElementById('v-' + key);
    if (!el) continue;
    el.addEventListener('input', () => {
      lab.textContent = fmt[key](el.value);
      pending[key] = parseFloat(el.value);
      if (!timer) timer = setTimeout(flush, 120);
    });
  }
  // Feed particle size from the crushing chain — sets the leach speed.
  for (const b of document.querySelectorAll('#grind button')) {
    b.addEventListener('click', () => pushControls({ particleSize: b.dataset.size }));
  }
  // Pre-leach stations: magnetic separation + roasting (toggles).
  for (const b of document.querySelectorAll('#prep button')) {
    b.addEventListener('click', () => pushControls({ [b.dataset.flag]: !b.classList.contains('on') }));
  }
}
function reflectPrep(rx) {
  for (const b of document.querySelectorAll('#prep button')) b.classList.toggle('on', !!rx[b.dataset.flag]);
}
function reflectParticleSize(size, leachSpeed) {
  for (const b of document.querySelectorAll('#grind button')) b.classList.toggle('on', b.dataset.size === size);
  const ls = document.getElementById('v-leach');
  if (ls && leachSpeed != null) ls.textContent = `${leachSpeed}×`;
}

// ---------- Periodic Table Biome: collect all 118 elements ----------
// Elements are laid out as a real periodic table (from the game's Elements data).
// Walk up to a tile to collect it; progress persists in localStorage. This is the
// game's second core loop (mine/collect the 118 elements) continued on the web.
let elements = [];
const elementSprites = new Map();       // num -> { sprite, o }
const COLLECT_KEY = 'molgang.collected';
let collected = new Set();
try { collected = new Set(JSON.parse(localStorage.getItem(COLLECT_KEY) || '[]')); } catch (e) { /* fresh */ }

function elementTexture(o, isCollected) {
  const c = document.createElement('canvas'); c.width = c.height = 128;
  const g = c.getContext('2d');
  const [r, gr, b] = o.rgb || [180, 190, 210];
  g.fillStyle = `rgb(${r},${gr},${b})`; roundRect(g, 6, 6, 116, 116, 14); g.fill();
  g.strokeStyle = isCollected ? '#7fffb0' : 'rgba(255,255,255,0.55)';
  g.lineWidth = isCollected ? 7 : 3; roundRect(g, 6, 6, 116, 116, 14); g.stroke();
  const lum = 0.299 * r + 0.587 * gr + 0.114 * b;    // dark text on light tiles
  g.fillStyle = lum > 150 ? '#101216' : '#f4f8ff'; g.textAlign = 'center';
  g.font = '20px system-ui'; g.fillText(String(o.num), 64, 34);
  g.font = 'bold 52px system-ui'; g.fillText(o.ref, 64, 88);
  if (isCollected) { g.fillStyle = '#7fffb0'; g.font = 'bold 32px system-ui'; g.fillText('✓', 102, 42); }
  const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace;
  return t;
}
function buildElements() {
  for (const o of elements) {
    const sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: elementTexture(o, collected.has(o.num)), transparent: true }));
    sp.position.set(o.x, 1.8, o.z); sp.scale.set(2.1, 2.1, 1);
    scene.add(sp);
    elementSprites.set(o.num, { sprite: sp, o });
  }
  updateElementHUD();
}
function updateElementHUD() {
  const el = document.getElementById('elements');
  if (el) el.textContent = `🧪 elements collected: ${collected.size} / 118`;
}
let _popTimer = null;
function showElementPopup(o) {
  if (renderer.xr.isPresenting) xrToastShow(`🧪 ${o.ref} · ${o.name} collected!`);
  const pop = document.getElementById('elpop'); if (!pop) return;
  const [r, g, b] = o.rgb || [180, 190, 210];
  const sym = document.getElementById('ep-sym');
  sym.textContent = o.ref; sym.style.color = `rgb(${r},${g},${b})`;
  document.getElementById('ep-nm').textContent = `${o.num} · ${o.name}`;
  document.getElementById('ep-ft').textContent = o.fact || '';
  document.getElementById('ep-ct').textContent = `collected ${collected.size} / 118`;
  pop.style.display = 'block';
  clearTimeout(_popTimer); _popTimer = setTimeout(() => { pop.style.display = 'none'; }, 3200);
}
function checkCollect() {
  if (!elements.length) return;
  const px = player.pos.x, pz = player.pos.z;
  for (const [num, rec] of elementSprites) {
    if (collected.has(num)) continue;
    const dx = rec.o.x - px, dz = rec.o.z - pz;
    if (dx * dx + dz * dz < 6.25) {                  // within 2.5 m
      collected.add(num);
      try { localStorage.setItem(COLLECT_KEY, JSON.stringify([...collected])); } catch (e) { /* quota */ }
      rec.sprite.material.map.dispose();
      rec.sprite.material.map = elementTexture(rec.o, true);
      rec.sprite.material.needsUpdate = true;
      showElementPopup(rec.o);
      updateElementHUD();
    }
  }
}

// ---------- Fertilizer Lab: synthesize fertilizers from collected elements ----------
// The game's fertilizer track (real NPK + atom recipes) links the two loops:
// collect the elements, then synthesize a fertilizer once you have its atoms.
let fertilizers = [];
const symToNum = new Map();
const FERT_KEY = 'molgang.fertilizers';
let fertInv = {};
try { fertInv = JSON.parse(localStorage.getItem(FERT_KEY) || '{}'); } catch (e) { /* fresh */ }

const fertMade = () => Object.values(fertInv).reduce((a, b) => a + b, 0);
const haveElement = (sym) => { const n = symToNum.get(sym); return n != null && collected.has(n); };
const canSynthesize = (f) => Object.keys(f.atoms).every(haveElement);

function refreshFertRow(row, f) {
  for (const sp of row.querySelectorAll('.atoms span')) sp.classList.toggle('have', haveElement(sp.dataset.sym));
  const ok = canSynthesize(f), btn = row.querySelector('.mk');
  btn.disabled = !ok; btn.textContent = ok ? 'Synthesize' : 'Need elements';
  row.querySelector('.cnt').textContent = fertInv[f.id] ? `×${fertInv[f.id]}` : '';
}
function buildFertilizerLab() {
  for (const o of elements) symToNum.set(o.ref, o.num);
  const list = document.getElementById('fert-list');
  if (!list) return;
  list.innerHTML = '';
  for (const f of fertilizers) {
    const row = document.createElement('div'); row.className = 'fert';
    const [r, g, b] = f.rgb;
    row.innerHTML =
      `<div class="sw" style="background:rgb(${r},${g},${b})"></div>` +
      `<div class="info"><div class="nm">${f.name}</div><div class="fo">${f.formula}</div>` +
      `<div class="atoms">${Object.entries(f.atoms).map(([s, n]) => `<span data-sym="${s}">${s}${n > 1 ? '×' + n : ''}</span>`).join('')}</div></div>` +
      `<div class="npk">NPK<b>${f.npk.join('-')}</b></div>` +
      `<button class="mk" type="button">Synthesize</button><div class="cnt"></div>`;
    row.querySelector('.mk').addEventListener('click', () => {
      if (!canSynthesize(f)) return;
      fertInv[f.id] = (fertInv[f.id] || 0) + 1;
      try { localStorage.setItem(FERT_KEY, JSON.stringify(fertInv)); } catch (e) { /* quota */ }
      refreshFertRow(row, f); document.getElementById('fl-made').textContent = fertMade();
    });
    list.appendChild(row); refreshFertRow(row, f);
  }
  document.getElementById('fl-made').textContent = fertMade();
}
function openFertLab() {
  const rows = document.querySelectorAll('#fert-list .fert');   // collected set may have grown
  fertilizers.forEach((f, i) => { if (rows[i]) refreshFertRow(rows[i], f); });
  document.getElementById('fertlab').style.display = 'flex';
  if (document.exitPointerLock) document.exitPointerLock();
}
(function wireFertLab() {
  const btn = document.getElementById('fert-btn'), close = document.getElementById('fl-close');
  if (btn) btn.addEventListener('click', openFertLab);
  if (close) close.addEventListener('click', () => { document.getElementById('fertlab').style.display = 'none'; });
  addEventListener('keydown', (e) => { if (e.code === 'KeyF') openFertLab(); });
})();

// ---------- Farm: apply fertilizers to crops under Liebig's Law ----------
// Yield is capped by the scarcest nutrient relative to the crop's ideal N-P-K —
// so over-applying one nutrient can't make up for a missing one. Closes the loop:
// process -> fertilizer -> crop.
let crops = [];
const fertById = new Map();
let currentCrop = null;
let plot = { N: 0, P: 0, K: 0 };
const HARVEST_KEY = 'molgang.harvests';
let harvests = {};
try { harvests = JSON.parse(localStorage.getItem(HARVEST_KEY) || '{}'); } catch (e) { /* fresh */ }

function liebig() {
  if (!currentCrop) return { yield: 0, limit: -1 };
  const id = currentCrop.idealNPK;
  const ratios = [plot.N / id[0], plot.P / id[1], plot.K / id[2]];
  let limit = 0;
  for (let i = 1; i < 3; i++) if (ratios[i] < ratios[limit]) limit = i;
  return { yield: Math.max(0, Math.min(1, ratios[limit])), limit, ratios };
}
function renderPlot() {
  if (!currentCrop) return;
  const id = currentCrop.idealNPK, L = liebig();
  document.getElementById('pl-crop').textContent = currentCrop.name;
  document.getElementById('pl-ideal').textContent = id.join('-');
  const names = ['N', 'P', 'K'], applied = [plot.N, plot.P, plot.K];
  document.getElementById('npk-bars').innerHTML = names.map((n, i) => {
    const ratio = applied[i] / id[i], pct = Math.min(1, ratio) * 100;
    const col = ratio >= 1 ? '#7fe0a0' : '#e0b57f';
    return `<div class="bar ${i === L.limit ? 'limit' : ''}"><span class="lbl">${n} ${applied[i]}/${id[i]}</span>`
      + `<span class="track"><span class="fill" style="width:${pct}%;background:${col}"></span></span>`
      + `<span class="num">${(ratio * 100) | 0}%</span></div>`;
  }).join('');
  document.getElementById('pl-yield').textContent = `${(L.yield * 100) | 0}%`;
  document.getElementById('pl-limit').textContent = L.yield < 1 && L.limit >= 0 ? `· limited by ${names[L.limit]}` : (L.yield >= 1 ? '· fully fed!' : '');
  document.getElementById('pl-harvest').disabled = L.yield <= 0;
}
function renderApplyList() {
  const list = document.getElementById('apply-list'); if (!list) return;
  const avail = fertilizers.filter((f) => (fertInv[f.id] || 0) > 0);
  list.innerHTML = avail.length ? '' : '<div class="fl-sub">No fertilizers yet — synthesize some in the Fertilizer Lab (🌱).</div>';
  for (const f of avail) {
    const row = document.createElement('div'); row.className = 'appl';
    row.innerHTML = `<div class="info"><div class="nm">${f.name}</div><div class="np">NPK ${f.npk.join('-')}</div></div>`
      + `<div class="cnt">×${fertInv[f.id]}</div><button type="button">Apply</button>`;
    row.querySelector('button').addEventListener('click', () => {
      if ((fertInv[f.id] || 0) <= 0 || !currentCrop) return;
      fertInv[f.id]--; try { localStorage.setItem(FERT_KEY, JSON.stringify(fertInv)); } catch (e) { /* quota */ }
      plot.N += f.npk[0]; plot.P += f.npk[1]; plot.K += f.npk[2];
      renderPlot(); renderApplyList();
    });
    list.appendChild(row);
  }
}
function selectCrop(c) {
  currentCrop = c; plot = { N: 0, P: 0, K: 0 };
  for (const b of document.querySelectorAll('#crop-row button')) b.classList.toggle('on', b.dataset.id === c.id);
  renderPlot();
}
function buildFarm() {
  for (const f of fertilizers) fertById.set(f.id, f);
  const row = document.getElementById('crop-row'); if (!row) return;
  row.innerHTML = '';
  for (const c of crops) {
    const b = document.createElement('button'); b.type = 'button'; b.dataset.id = c.id;
    b.innerHTML = `<b>${c.name}</b>NPK ${c.idealNPK.join('-')} · ${c.growthDays}d`;
    b.addEventListener('click', () => selectCrop(c));
    row.appendChild(b);
  }
  document.getElementById('pl-harvest').addEventListener('click', () => {
    const L = liebig(); if (L.yield <= 0 || !currentCrop) return;
    harvests[currentCrop.id] = (harvests[currentCrop.id] || 0) + 1;
    try { localStorage.setItem(HARVEST_KEY, JSON.stringify(harvests)); } catch (e) { /* quota */ }
    const y = (L.yield * 100) | 0;
    const revenue = Math.round(currentCrop.growthDays * 100 * L.yield);   // longer crops pay more
    earn(revenue);
    plot = { N: 0, P: 0, K: 0 }; renderPlot(); renderApplyList();
    const pl = document.getElementById('pl-limit'); if (pl) pl.textContent = `· harvested ${currentCrop.name} at ${y}% → +${revenue} 💰`;
  });
  if (crops.length) selectCrop(crops[0]);
}
function openFarm() {
  renderApplyList(); renderPlot();
  document.getElementById('farm').style.display = 'flex';
  if (document.exitPointerLock) document.exitPointerLock();
}
(function wireFarm() {
  const btn = document.getElementById('farm-btn'), close = document.getElementById('fm-close');
  if (btn) btn.addEventListener('click', openFarm);
  if (close) close.addEventListener('click', () => { document.getElementById('farm').style.display = 'none'; });
})();

// ---------- MolCoin economy: the loop that ties the five systems together ----------
// V2O5 sales (process) + harvests (farm) earn MolCoins; factory equipment costs
// them. One shared balance turns five systems into one game.
const MC_KEY = 'molgang.molcoins';
let molcoins = 20000;                            // starter capital (enough for a first machine)
try { const v = JSON.parse(localStorage.getItem(MC_KEY)); if (Number.isFinite(v)) molcoins = v; } catch (e) { /* fresh */ }
function saveMc() { try { localStorage.setItem(MC_KEY, JSON.stringify(molcoins)); } catch (e) { /* quota */ } }
function updateMcHUD(flash) {
  const el = document.getElementById('mc-val'); if (el) el.textContent = molcoins.toLocaleString();
  if (flash) { const m = document.getElementById('molcoins'); if (m) { m.classList.add('flash'); setTimeout(() => m.classList.remove('flash'), 500); } }
}
function earn(n) { molcoins += n; saveMc(); updateMcHUD(true); }
function spend(n) { if (molcoins < n) return false; molcoins -= n; saveMc(); updateMcHUD(false); return true; }
function flashCantAfford() {
  const m = document.getElementById('molcoins'); if (!m) return;
  m.style.borderColor = '#ff7a6f'; setTimeout(() => { m.style.borderColor = '#b58a2c'; }, 450);
}
let hasSold = false;
try { hasSold = JSON.parse(localStorage.getItem('molgang.sold') || 'false'); } catch (e) { /* fresh */ }
(function wireSell() {
  const b = document.getElementById('sell-btn');
  const bank = (d) => { if (d && d.coins > 0) { earn(d.coins); hasSold = true; try { localStorage.setItem('molgang.sold', 'true'); } catch (e) { /* quota */ } } };
  if (b) b.addEventListener('click', () => {
    if (simOk) fetch(SIM_BASE + '/reactor/sell', { method: 'POST' }).then((r) => r.json()).then(bank).catch(() => bank(crSell()));
    else bank(crSell());                          // no server -> sell from the client reactor
  });
})();

// Onboarding: surface the connected loop and tick each step off live, read from
// the systems' own state — no new bookkeeping, just legibility for new players.
function updateGoals() {
  const el = document.getElementById('goals'); if (!el || el.style.display === 'none') return;
  const done = {
    collect: collected.size >= 1,
    fertilize: Object.values(fertInv).reduce((a, b) => a + b, 0) >= 1,
    harvest: Object.values(harvests).reduce((a, b) => a + b, 0) >= 1,
    sell: hasSold,
    build: factoryGrid.some(Boolean),
  };
  let n = 0;
  for (const item of el.querySelectorAll('.g-item')) {
    const ok = done[item.dataset.goal]; if (ok) n++;
    item.classList.toggle('done', ok);
    item.querySelector('.tick').textContent = ok ? '✓' : '○';
  }
  el.querySelector('#g-count').textContent = `${n}/5`;
  el.classList.toggle('all-done', n === 5);
  if (n === 5) el.querySelector('.g-head').firstChild.textContent = '🎉 Full loop complete ';
}

// ---------- Factory Builder: place equipment, chase adjacency bonuses ----------
// The game's factory pillar: rent a floor, place equipment, and lay the
// processing chain so partners sit next to each other for adjacency bonuses.
let equipment = [];
const eqById = new Map();
let floorConfig = { maxEquipment: 30, basePowerKW: 100, baseRent: 2000 };
const FGW = 16, FGH = 10;                       // playable UI grid (scaled from 40x25)
let factoryGrid = new Array(FGW * FGH).fill(null);
let selEquip = null;
const FACTORY_KEY = 'molgang.factory';
try { const s = JSON.parse(localStorage.getItem(FACTORY_KEY) || '[]'); for (const c of s) factoryGrid[c.i] = c.id; } catch (e) { /* fresh */ }

function saveFactory() {
  const s = []; factoryGrid.forEach((id, i) => { if (id) s.push({ i, id }); });
  try { localStorage.setItem(FACTORY_KEY, JSON.stringify(s)); } catch (e) { /* quota */ }
}
function cellBonus(i) {                          // active adjacency multiplier for cell i
  const id = factoryGrid[i]; if (!id) return 1;
  const e = eqById.get(id); if (!e || !e.adjacency) return 1;
  const col = i % FGW, nbs = [];
  if (col > 0) nbs.push(i - 1); if (col < FGW - 1) nbs.push(i + 1);
  if (i - FGW >= 0) nbs.push(i - FGW); if (i + FGW < FGW * FGH) nbs.push(i + FGW);
  let mult = 1;
  for (const n of nbs) { const nid = factoryGrid[n]; if (nid && e.adjacency[nid]) mult *= e.adjacency[nid]; }
  return mult;
}
function renderFactory() {
  const placed = [];
  factoryGrid.forEach((id, i) => { if (id) placed.push(i); });
  let cost = 0, power = 0, effSum = 0, bonuses = 0;
  for (const i of placed) {
    const e = eqById.get(factoryGrid[i]); cost += e.cost; power += e.powerKW;
    const m = cellBonus(i); effSum += m; if (m > 1) bonuses++;
  }
  const eff = placed.length ? (effSum / placed.length) : 1;
  const over = power > floorConfig.basePowerKW;
  document.getElementById('fc-stats').innerHTML =
    `<div>Equipment <b>${placed.length}/${floorConfig.maxEquipment}</b></div>`
    + `<div>Build cost <b>${cost.toLocaleString()}</b> MolCoins</div>`
    + `<div class="${over ? 'over' : ''}">Power <b>${power} kW</b> (${floorConfig.basePowerKW} incl.)</div>`
    + `<div>Adjacency links <b>${bonuses}</b></div>`
    + `<div class="eff">Factory efficiency <b>${(eff * 100) | 0}%</b></div>`;
  const grid = document.getElementById('eq-grid');
  [...grid.children].forEach((cell, i) => {
    const id = factoryGrid[i];
    cell.className = 'cell' + (id ? ' on' : '') + (id && cellBonus(i) > 1 ? ' bonus' : '');
    cell.style.background = id ? `rgb(${eqById.get(id).rgb.join(',')})` : '#161c28';
    cell.title = id ? eqById.get(id).name : '';
  });
}
function buildFactory() {
  for (const e of equipment) eqById.set(e.id, e);
  const pal = document.getElementById('eq-palette');
  const cats = [...new Set(equipment.map((e) => e.category))];
  pal.innerHTML = '';
  for (const cat of cats) {
    const h = document.createElement('div'); h.className = 'cat'; h.textContent = cat; pal.appendChild(h);
    for (const e of equipment.filter((x) => x.category === cat)) {
      const row = document.createElement('div'); row.className = 'eq'; row.dataset.id = e.id;
      row.innerHTML = `<span class="sw" style="background:rgb(${e.rgb.join(',')})"></span>`
        + `<span class="nm">${e.name}</span><span class="co">${(e.cost / 1000) | 0}k</span>`;
      row.addEventListener('click', () => {
        selEquip = e.id;
        for (const r of pal.querySelectorAll('.eq')) r.classList.toggle('sel', r.dataset.id === e.id);
      });
      pal.appendChild(row);
    }
  }
  const grid = document.getElementById('eq-grid');
  grid.style.gridTemplateColumns = `repeat(${FGW}, 1fr)`;
  grid.innerHTML = '';
  for (let i = 0; i < FGW * FGH; i++) {
    const cell = document.createElement('div'); cell.className = 'cell';
    cell.addEventListener('click', () => {
      if (factoryGrid[i]) {                                   // remove -> refund
        earn(eqById.get(factoryGrid[i]).cost); factoryGrid[i] = null;
      } else if (selEquip) {                                  // place -> buy
        const placed = factoryGrid.filter(Boolean).length;
        if (placed >= floorConfig.maxEquipment) return;
        if (!spend(eqById.get(selEquip).cost)) { flashCantAfford(); return; }
        factoryGrid[i] = selEquip;
      }
      saveFactory(); renderFactory();
    });
    grid.appendChild(cell);
  }
  renderFactory();
}
function openFactory() {
  document.getElementById('factory').style.display = 'flex';
  if (document.exitPointerLock) document.exitPointerLock();
}
(function wireFactory() {
  const b = document.getElementById('build-btn'), c = document.getElementById('fc-close');
  if (b) b.addEventListener('click', openFactory);
  if (c) c.addEventListener('click', () => { document.getElementById('factory').style.display = 'none'; });
})();

// ---------- proximity interactions on the HD plant props ----------
// Objects carrying an `interact` tag in moleculia.json come alive when the
// player walks up to them (same 2.5–3.5 m feel as element collection):
//  · safety  — safety shower / eyewash: one PPE check per visit, small reward
//  · assay   — XRF sample bench: reads the LIVE reactor state as an assay
//  · console — operator console: points the player at the reactor panel
let lastRx = null;
let interactables = [];
const safetyChecked = new Set();       // one reward per station per session
let lastInteractAt = 0;
let _toastEl = null, _toastTimer = null;
function worldToast(msg) {
  if (!_toastEl) {
    _toastEl = document.createElement('div');
    _toastEl.style.cssText = 'position:fixed;left:50%;top:64px;transform:translateX(-50%);'
      + 'z-index:30;background:rgba(14,18,26,.92);color:#eef4fb;border:1px solid #2c704a;'
      + 'border-radius:10px;padding:10px 16px;font:13px system-ui;max-width:70vw;'
      + 'box-shadow:0 6px 24px rgba(0,0,0,.5);transition:opacity .3s;pointer-events:none';
    document.body.appendChild(_toastEl);
  }
  _toastEl.textContent = msg; _toastEl.style.opacity = '1';
  clearTimeout(_toastTimer);
  _toastTimer = setTimeout(() => { _toastEl.style.opacity = '0'; }, 3600);
  if (renderer.xr.isPresenting) xrToastShow(msg);   // DOM is invisible in-headset
}
function checkInteract(now) {
  if (!interactables.length || now - lastInteractAt < 4000) return;
  const px = player.pos.x, pz = player.pos.z;
  for (const o of interactables) {
    const dx = o.x - px, dz = o.z - pz;
    if (dx * dx + dz * dz > 12.25) continue;             // within 3.5 m
    lastInteractAt = now;
    if (o.interact === 'safety') {
      const key = `${o.x},${o.z}`;
      if (!safetyChecked.has(key)) {
        safetyChecked.add(key); earn(25);
        worldToast('🚿 Safety shower & eyewash checked — PPE bonus +25 MolCoins');
      } else worldToast('🚿 Safety station — shower and eyewash operational');
    } else if (o.interact === 'assay') {
      worldToast(lastRx
        ? `🔬 XRF assay: ${(lastRx.conversion * 100) | 0}% leached · pH ${lastRx.pH} · `
          + `${lastRx.temperature}°C · V-recovery ${((lastRx.yield || 0) * 100) | 0}%`
        : '🔬 XRF assay: no leach batch running yet — start the reactor first');
    } else if (o.interact === 'console') {
      worldToast('🎛 Operator console — drive the plant with the reactor panel (left): '
        + 'grind, de-iron, roast, then set T/P/flow/pH');
    } else if (o.interact === 'directory') {
      worldToast('🗺 Moleculia — ⛏ Slakkenspoor: run the plant · 🧪 Periodic Biome: '
        + 'collect 118 elements · ⚛️ Quantum Lab: ChemSim · 🔬 Quantum Computer Lab: '
        + 'refine Si-28 · 🌱 Lab & Farm: fertilize & harvest · 🏦 ANK: your MolCoins · '
        + '🀄 Theehuis: Kantonese mahjong bij het café');
    } else if (o.interact === 'bank') {
      worldToast(`🏦 ANK Kredietunie — balance ${molcoins.toLocaleString('en-US')} MolCoins. `
        + 'Earn: sell V₂O₅ from the plant, harvest crops, pass PPE checks');
    } else if (o.interact === 'viscosity') {
      if (dx * dx + dz * dz < 2.25) {                    // within 1.5 m: enter
        worldToast('🌀 Naar het viscositeitslab…');
        setTimeout(() => { location.href = '../viscosity/'; }, 600);
      } else {
        worldToast('🌀 Viscositeitslab — roer staalslak-slib (1–100%), voel de '
          + 'rheologie en zie het kW-verbruik. Stap dichterbij om binnen te gaan');
        lastInteractAt = now - 3000;   // re-arm fast so stepping in triggers
      }
    } else if (o.interact === 'quantumcomputer') {
      if (dx * dx + dz * dz < 2.25) {                    // within 1.5 m: enter
        worldToast('⚛️ Naar het Kwantumcomputer-lab…');
        setTimeout(() => { location.href = '../quantumlab/'; }, 600);
      } else {
        worldToast('⚛️ Kwantumcomputer-lab — zuiver afgevloeid silicium tot ²⁸Si, '
          + 'bouw je eerste kwantumcomputer en speel de quantum-gate levels (WebXR AR). '
          + 'Stap dichterbij om binnen te gaan');
        lastInteractAt = now - 3000;   // re-arm fast so stepping in triggers
      }
    } else if (o.interact === 'mahjong') {
      if (dx * dx + dz * dz < 2.25) {                    // within 1.5 m: enter
        worldToast('🀄 Naar het theehuis…');
        setTimeout(() => { location.href = '../mahjong/'; }, 600);
      } else {
        worldToast('🀄 Theehuis — rustplek: speel 3D Kantonese mahjong (144 stenen, '
          + 'bloemen & faan-telling) tegen Ming, Yuki en Carlos. '
          + 'Stap dichterbij om aan te schuiven');
        lastInteractAt = now - 3000;   // re-arm fast so stepping in triggers
      }
    } else if (o.interact === 'weigh') {
      const gross = 18.4, tare = 6.2;
      worldToast(`⚖ Weegbrug — slakkenpot gewogen: ${gross.toFixed(1)} t bruto − `
        + `${tare.toFixed(1)} t tarra = ${(gross - tare).toFixed(1)} t slak `
        + 'voor het Slakkenspoor');
    } else if (o.interact === 'slagpot') {
      worldToast('🫕 Slakkenpot — 1550 °C vloeibare slak. Na koelen, breken en '
        + 'malen (5 µm) wordt dit het staalslak-slib van het viscositeitslab');
    }
    return;
  }
}

// ---------- ⚙ options menu: AR calibration, comfort, tutorial restart ----------
// DOM panel (2D/cinema; set things up before entering the headset). The floor
// offset and recenter apply LIVE to a running XR session via xrActiveSession.
function initOptions() {
  const panel = document.getElementById('options'); if (!panel) return;
  const btn = document.getElementById('opt-btn');
  const hf = document.getElementById('o-hidefloor');
  const fo = document.getElementById('o-floor'), fov = document.getElementById('o-floor-v');
  const sp = document.getElementById('o-speed'), spv = document.getElementById('o-speed-v');
  hf.checked = xrSettings.hideFloorAR;
  fo.value = xrSettings.floorOffset; fov.textContent = (+xrSettings.floorOffset).toFixed(2) + ' m';
  sp.value = xrSettings.speed; spv.textContent = xrSettings.speed + ' m/s';
  if (btn) btn.addEventListener('click', () => { panel.style.display = 'flex'; });
  document.getElementById('opt-close').addEventListener('click', () => { panel.style.display = 'none'; });
  hf.addEventListener('change', () => {
    xrSettings.hideFloorAR = hf.checked; saveXrSettings();
    if (renderer.xr.isPresenting) setFloorHidden(xrAR && xrSettings.hideFloorAR);
  });
  fo.addEventListener('input', () => {
    xrSettings.floorOffset = +fo.value; fov.textContent = (+fo.value).toFixed(2) + ' m';
    saveXrSettings();
    if (xrActiveSession && xrActiveSession.__syncSpace) xrActiveSession.__syncSpace();
  });
  sp.addEventListener('input', () => {
    xrSettings.speed = +sp.value; spv.textContent = sp.value + ' m/s'; saveXrSettings();
  });
  document.getElementById('o-recenter').addEventListener('click', () => {
    if (xrActiveSession && xrActiveSession.__recenter) xrActiveSession.__recenter();
    else worldToast('🧭 Recenter works inside the headset (enter AR/VR first)');
  });
  document.getElementById('o-tutorial').addEventListener('click', () => {
    panel.style.display = 'none'; tutorStart(true);
  });
}

// ---------- 🎓 tutorial — the web mirror of the Roblox onboarding ----------
// Same shape as game/src/ReplicatedStorage/Modules/Tutorial.lua: titled steps
// with a reward, and steps that watch REAL game state auto-complete (collect an
// element, synthesize a fertilizer) instead of trusting a "Next" click.
const TUTOR_KEY = 'molgang.tutorial';
const TUTOR_STEPS = [
  { title: 'Welcome to Moleculia!', reward: 50,
    desc: 'The Roblox teaser continues here: a chemical-engineering world grounded on your real steel plant. This tour pays MolCoins per step.' },
  { title: 'Collect your first element', reward: 100, goto: [0, -104, 0],
    desc: 'Walk onto a glowing tile in the Periodic Table Biome to collect it. 118 to find!',
    done: () => collected.size >= 1 },
  { title: 'Run the Slakkenspoor plant', reward: 100, goto: [-118, 12, 2.2],
    desc: 'The 12-station line refines steel slag. Use the reactor panel (left): grind fine, de-iron, roast, and set pH ≈ 2.9 for peak vanadium recovery.' },
  { title: 'Bank your V₂O₅', reward: 50, goto: [-118, 12, 2.2],
    desc: 'A finished batch banks V₂O₅ — press Sell to turn it into MolCoins (500 per kg).' },
  { title: 'Synthesize a fertilizer', reward: 100, goto: [0, -104, 0],
    desc: 'Open the 🌱 Fertilizer Lab (F): collected elements become real NPK fertilizers for the Farm.',
    done: () => fertMade() >= 1 },
  { title: 'Explore Moleculia', reward: 100,
    desc: 'Six zones ring the plant, standing on the real river you saw on the steelworks map — the signpost & kiosk at Nexus Hub point the way. In the headset, B/Y teleports zone to zone. Have fun!' },
];
let tutorState = { step: 0, done: false, paid: 0 };
try { Object.assign(tutorState, JSON.parse(localStorage.getItem(TUTOR_KEY) || '{}')); } catch (e) { /* fresh */ }
const saveTutor = () => { try { localStorage.setItem(TUTOR_KEY, JSON.stringify(tutorState)); } catch (e) { /* quota */ } };
function tutorRender() {
  const el = document.getElementById('tutor'); if (!el) return;
  if (tutorState.done || tutorState.step >= TUTOR_STEPS.length) { el.style.display = 'none'; return; }
  const s = TUTOR_STEPS[tutorState.step];
  el.style.display = 'block';
  document.getElementById('t-step').textContent = `Step ${tutorState.step + 1} / ${TUTOR_STEPS.length}`;
  document.getElementById('t-title').textContent = s.title;
  document.getElementById('t-desc').textContent = s.desc;
  document.getElementById('t-reward').textContent = s.reward ? `Reward: +${s.reward} MolCoins` : '';
  document.getElementById('t-go').style.display = s.goto ? 'inline-block' : 'none';
  document.getElementById('t-next').textContent = s.done ? 'Waiting… (auto)' : (tutorState.step === TUTOR_STEPS.length - 1 ? 'Finish 🎉' : 'Next →');
}
function tutorAdvance() {
  const s = TUTOR_STEPS[tutorState.step];
  if (s && s.reward && tutorState.paid <= tutorState.step) {
    earn(s.reward); tutorState.paid = tutorState.step + 1;
    worldToast(`🎓 ${s.title} — +${s.reward} MolCoins`);
  }
  tutorState.step += 1;
  if (tutorState.step >= TUTOR_STEPS.length) tutorState.done = true;
  saveTutor(); tutorRender();
}
function tutorTick() {
  if (tutorState.done) return;
  const s = TUTOR_STEPS[tutorState.step];
  if (s && s.done && s.done()) tutorAdvance();     // state-watching steps auto-complete
}
function tutorStart(force) {
  if (force) { tutorState = { step: 0, done: false, paid: tutorState.paid }; saveTutor(); }
  tutorRender();
}
function initTutorial() {
  const el = document.getElementById('tutor'); if (!el) return;
  document.getElementById('t-next').addEventListener('click', () => {
    const s = TUTOR_STEPS[tutorState.step];
    if (s && s.done && !s.done()) { worldToast('🎓 This step completes by itself — go do it!'); return; }
    tutorAdvance();
  });
  document.getElementById('t-skip').addEventListener('click', () => {
    tutorState.done = true; saveTutor(); tutorRender();
  });
  document.getElementById('t-go').addEventListener('click', () => {
    const s = TUTOR_STEPS[tutorState.step];
    if (!s || !s.goto) return;
    player.pos.x = s.goto[0]; player.pos.z = s.goto[1];
    if (s.goto[2] != null) player.yaw = s.goto[2];
  });
  tutorRender();                                   // resumes where you left off
}

// ---------- ChemSim: the paid in-game chemical simulator ----------
// The chemistry-set console in the Quantum Lab. For MolCoins the player runs
// the process model FORWARD: predicted rate, batch time and V2O5/hour for any
// hypothetical settings (250), or a full pH sweep that plots the selectivity
// optimum (400) — pay for foresight instead of wasting slow real batches.
let chemsimPos = null;
const CS_RUN = 250, CS_SWEEP = 400;
function csParams() {
  return { temperature: +document.getElementById('cs-temperature').value,
    pressure: +document.getElementById('cs-pressure').value,
    flowRate: +document.getElementById('cs-flowRate').value,
    pH: +document.getElementById('cs-pH').value,
    size: document.getElementById('cs-size').value,
    deiron: document.getElementById('cs-deiron').checked,
    roast: document.getElementById('cs-roast').checked };
}
function csPredict(p) {
  const rate = arrheniusM(p.temperature) * pressureM(p.pressure) * residenceM(p.flowRate, 50);
  let k = 0.05 / (LEACH_MULT[p.size] || 1); if (p.roast) k *= 1.25;
  const batchMin = 5.3 / (k * rate);                     // ln(200): time to 99.5% conversion
  const rec = precipF('V', p.pH) * (p.deiron ? 1 : 1 - precipF('Fe', p.pH)) * (1 - precipF('Al', p.pH));
  const kgBatch = 1.5 * rec, kgHr = batchMin > 0 ? kgBatch * 60 / batchMin : 0;
  return { rate, batchMin, rec, kgBatch, kgHr, coinsHr: kgHr * 500 };
}
function csNearConsole() {
  if (params.get('chemsim')) return true;                // sandbox bypass
  if (!chemsimPos) return false;
  const dx = chemsimPos.x - player.pos.x, dz = chemsimPos.z - player.pos.z;
  return dx * dx + dz * dz < 22 * 22;
}
function openChemSim() {
  const near = csNearConsole();
  document.getElementById('cs-far').style.display = near ? 'none' : 'block';
  document.getElementById('cs-body').style.display = near ? 'block' : 'none';
  document.getElementById('chemsim').style.display = 'flex';
  if (document.exitPointerLock) document.exitPointerLock();
}
(function wireChemSim() {
  const btn = document.getElementById('chemsim-btn'), close = document.getElementById('cs-close');
  if (btn) btn.addEventListener('click', openChemSim);
  if (close) close.addEventListener('click', () => { document.getElementById('chemsim').style.display = 'none'; });
  const fmt = { temperature: (v) => `${v | 0}°C`, pressure: (v) => `${v | 0} kPa`,
                flowRate: (v) => (+v).toFixed(1), pH: (v) => (+v).toFixed(1) };
  for (const key of Object.keys(fmt)) {
    const el = document.getElementById('cs-' + key), lab = document.getElementById('csv-' + key);
    if (el) el.addEventListener('input', () => { lab.textContent = fmt[key](el.value); });
  }
  const out = () => document.getElementById('cs-result');
  document.getElementById('cs-run').addEventListener('click', () => {
    if (!spend(CS_RUN)) { flashCantAfford(); out().textContent = 'Not enough MolCoins.'; return; }
    const p = csParams(), r = csPredict(p);
    document.getElementById('cs-curve').style.display = 'none';
    out().innerHTML = `Reaction rate <b>${r.rate.toFixed(2)}×</b> · batch to 99.5% in <b>${r.batchMin.toFixed(1)} min</b><br>`
      + `Selective V recovery <b>${(r.rec * 100) | 0}%</b> → <b>${r.kgBatch.toFixed(2)} kg</b> V₂O₅/batch · `
      + `<b>${r.kgHr.toFixed(1)} kg/h</b> ≈ <b>${r.coinsHr | 0} 💰/h</b>`;
  });
  document.getElementById('cs-sweep').addEventListener('click', () => {
    if (!spend(CS_SWEEP)) { flashCantAfford(); out().textContent = 'Not enough MolCoins.'; return; }
    const p = csParams();
    const cv = document.getElementById('cs-curve'), g = cv.getContext('2d');
    cv.style.display = 'block'; g.clearRect(0, 0, cv.width, cv.height);
    let best = { pH: 0, rec: -1 };
    g.beginPath();
    for (let pH = 1; pH <= 6.001; pH += 0.05) {
      const rec = precipF('V', pH) * (p.deiron ? 1 : 1 - precipF('Fe', pH)) * (1 - precipF('Al', pH));
      if (rec > best.rec) best = { pH, rec };
      const x = 20 + (pH - 1) / 5 * (cv.width - 35), y = cv.height - 18 - rec * (cv.height - 34);
      pH === 1 ? g.moveTo(x, y) : g.lineTo(x, y);
    }
    g.strokeStyle = '#d0a0ff'; g.lineWidth = 2; g.stroke();
    const bx = 20 + (best.pH - 1) / 5 * (cv.width - 35), by = cv.height - 18 - best.rec * (cv.height - 34);
    g.fillStyle = '#6ffcda'; g.beginPath(); g.arc(bx, by, 4, 0, 7); g.fill();
    g.fillStyle = '#9fb0c6'; g.font = '10px system-ui';
    g.fillText('pH 1', 16, cv.height - 5); g.fillText('pH 6', cv.width - 30, cv.height - 5);
    g.fillStyle = '#6ffcda'; g.fillText(`optimum pH ${best.pH.toFixed(1)} → ${(best.rec * 100) | 0}%`, bx - 50, by - 8);
    out().innerHTML = `pH sweep${p.deiron ? ' (de-ironed feed)' : ''}: selectivity optimum at <b>pH ${best.pH.toFixed(1)}</b> `
      + `(${(best.rec * 100) | 0}% V recovery)${p.deiron ? '' : ' — above pH 3 iron co-precipitates and ruins the product'}`;
  });
})();

// ---------- render loop (49% budget outside XR; every frame in XR) ----------
const BUDGET = 0.49;
let refresh = 1000 / 60, lastTick = performance.now(), lastRender = 0, lastStream = 0;

// Perf instrumentation (?bench=1): time every improvement. Reports CPU render
// ms (avg/p95/max), draw calls, triangles and the adaptive pixel ratio into a
// <pre id="bench"> that headless --dump-dom can read.
const BENCH = params.get('bench') === '1';
if (BENCH) renderer.info.autoReset = false;   // accumulate across composer passes
const benchSamples = [];
let benchDone = false, benchT0 = performance.now();
function benchReport() {
  const s = [...benchSamples].sort((a, b) => a - b);
  const avg = s.reduce((a, b) => a + b, 0) / s.length;
  const out = { renderMsAvg: +avg.toFixed(2), p95: +s[(s.length * 0.95) | 0].toFixed(2),
    max: +s[s.length - 1].toFixed(2), calls: renderer.info.render.calls,
    tris: renderer.info.render.triangles, pixelRatio: renderer.getPixelRatio(),
    live: live.size, protosWarm: [...glbProto.values()].filter((v) => v !== 'loading').length };
  const pre = document.createElement('pre'); pre.id = 'bench';
  pre.textContent = JSON.stringify(out); document.body.appendChild(pre);
  console.log('[bench]', pre.textContent);
}
// Adaptive resolution (classic console technique): track an EMA of render cost
// and step the pixel ratio down/up so frame time stays inside the budget.
let perfEma = 14, perfN = 0;
function adaptiveRes(renderMs) {
  perfEma = perfEma * 0.95 + renderMs * 0.05;
  if (++perfN % 90 !== 0) return;
  const pr = renderer.getPixelRatio();
  if (perfEma > 24 && pr > 0.75) { renderer.setPixelRatio(pr - 0.25); resize(); }
  else if (perfEma < 10 && pr < Math.min(devicePixelRatio, 1.5)) { renderer.setPixelRatio(pr + 0.25); resize(); }
}
function loop(now) {
  now = now || performance.now();
  const dt = Math.min(0.05, (now - lastTick) / 1000); lastTick = now;
  pollGamepads(dt, now);
  step(dt);
  updateAgents(dt);
  if (steam.length) updateSteam(dt);
  if (!simOk && MOLECULIA) crClientActive = true;   // no server reached -> run chemistry in-browser
  if (crClientActive && !simOk) crTick(dt);
  if (now - lastStream > 180) {
    lastStream = now; stream(); checkCollect(); checkInteract(now); tutorTick(); updateGoals();
    gardenTick(now);
    if (crClientActive && !simOk) applyReactorState(crStateObj());
  }
  // Keep the sun (and its shadow frustum) centred on the player for crisp shadows.
  sun.position.set(player.pos.x + 50, 120, player.pos.z + 35);
  sun.target.position.set(player.pos.x, 0, player.pos.z);
  const xr = renderer.xr.isPresenting;
  if (xr) {
    const s = renderer.xr.getSession(); if (s && s.__pollButtons) s.__pollButtons(dt);
    if (s && s.__frame) s.__frame(dt, now);
    // player.pos follows the headset's WORLD position (stick + physical walk),
    // so streaming/interactions/collection/sun track the viewer in XR.
    camera.getWorldPosition(_camPos);
    player.pos.x = _camPos.x; player.pos.z = _camPos.z;
    tickXrToast(now);
    renderer.render(scene, camera);                    // headset drives cadence (no post-fx in XR)
  } else if (now - lastRender >= refresh / BUDGET) {
    lastRender = now;
    if (BENCH) renderer.info.reset();
    const t0 = performance.now();
    composer.render();                                          // bloom + tone-mapped
    const rMs = performance.now() - t0;
    adaptiveRes(rMs);
    if (BENCH && !benchDone && now - benchT0 > 1500) {
      benchSamples.push(rMs);
      if (benchSamples.length >= 90 || now - benchT0 > 9000) { benchDone = true; benchReport(); }
    }
    if (arOn) drawAR();
  }
}
renderer.setAnimationLoop(loop);      // works for both desktop RAF and WebXR

// ---------- load the map, then let streaming populate it ----------
(async function init() {
  await initAssetLayer();
  try { arLabels = (await (await fetch('./ar_labels.json', { cache: 'no-cache' })).json()).labels || {}; } catch (e) { /* optional */ }
  setAR(arOn);
  const w = await (await fetch(WORLDFILE, { cache: 'no-cache' })).json();
  WORLD = w.meta.world; roadAts = w.meta.roadAts || null; ROAD = w.meta.road || 14;
  worldLoaded = true;
  MOLECULIA = !!w.meta.space;
  objects = w.objects;
  assetIdx = objects.map((o, i) => (o.t === 'asset' ? i : -1)).filter((i) => i >= 0);
  impPlacements = objects.filter((o) => o.t === 'imp');
  impCount = impPlacements.length;
  if (impCount) buildInstancedImpostors(impPlacements);   // diffusion gap-fill (old city only)
  pollSim();                                              // reactor + multiplayer (EVE-style)

  if (MOLECULIA) {
    // Which real steel plant did the player pick on the steelworks map?
    // ?site=<id> (deep link) wins, else whatever they last chose there,
    // else Tata Steel IJmuiden — the map and this world share one dataset.
    let siteId = params.get('site');
    if (!siteId) {
      try { siteId = (JSON.parse(localStorage.getItem('molgang.site') || 'null') || {}).id; }
      catch (e) { /* fresh */ }
    }
    let site = null;
    try {
      site = await (await fetch(`../steelworks/data/sites/${siteId || 'c0'}.json`,
        { cache: 'no-cache' })).json();
    } catch (e) { /* grounded look still works without the terrain overlay */ }
    setGrounded(site);
    for (const o of objects) if (o.t === 'platform') buildPlatform(o);
    for (const z of (w.meta.zones || [])) {
      buildZoneLabel(z);
      if (/Slakkenspoor/.test(z.name)) buildFactoryAtmosphere(z.x, z.z);
    }
    const line = (w.meta.processLine || []);
    elements = objects.filter((o) => o.t === 'element');
    buildElements();
    fertilizers = w.meta.fertilizers || [];
    buildFertilizerLab();
    crops = w.meta.crops || [];
    buildFarm();
    initGarden();
    equipment = w.meta.equipment || [];
    floorConfig = w.meta.floorConfig || floorConfig;
    buildFactory();
    { const fb = document.getElementById('fert-btn'); if (fb) fb.style.display = 'block'; }
    { const mb = document.getElementById('farm-btn'); if (mb) mb.style.display = 'block'; }
    { const bb = document.getElementById('build-btn'); if (bb) bb.style.display = 'block'; }
    { const mc = document.getElementById('molcoins'); if (mc) mc.style.display = 'block'; updateMcHUD(false); }
    chemsimPos = objects.find((o) => o.console === 'chemsim') || null;
    interactables = objects.filter((o) => o.interact);
    // steam-flagged props (the cooling tower) get their own vapour plume
    for (const o of objects.filter((x) => x.steam)) {
      const tex = steamTexture();
      for (let i = 0; i < 10; i++) {
        const sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, transparent: true, opacity: 0, depthWrite: false }));
        sp.userData = { bx: o.x - 2 + Math.random() * 4, bz: o.z - 2 + Math.random() * 4,
          t: Math.random(), lift: 9 };            // plume rises from the tower rim
        scene.add(sp); steam.push(sp);
      }
    }
    { const cb = document.getElementById('chemsim-btn'); if (cb) cb.style.display = 'block'; }
    if (params.get('chemsim')) setTimeout(openChemSim, 400);
    { const g = document.getElementById('goals'); if (g) g.style.display = 'block'; updateGoals(); }
    if (params.get('collectall')) {          // sandbox: skip the grind (demo/verify)
      for (const o of elements) collected.add(o.num);
      for (const [, rec] of elementSprites) { rec.sprite.material.map.dispose(); rec.sprite.material.map = elementTexture(rec.o, true); rec.sprite.material.needsUpdate = true; }
      updateElementHUD();
    }
    if (params.get('lab')) setTimeout(openFertLab, 400);
    if (params.get('stockfert') || params.get('farmdemo')) {
      for (const f of fertilizers) fertInv[f.id] = 6;
    }
    if (params.get('farmdemo')) {              // Liebig demo: N+P fed, K forgotten -> 0% yield
      selectCrop(crops.find((c) => c.id === 'wheat') || crops[0]);
      for (const id of ['urea', 'urea', 'dap']) { const f = fertById.get(id); if (f) { plot.N += f.npk[0]; plot.P += f.npk[1]; plot.K += f.npk[2]; fertInv[id]--; } }
      renderPlot();
    }
    if (params.get('farm')) setTimeout(openFarm, 400);
    if (params.get('factorydemo')) {           // lay the chain adjacent -> bonuses light up
      const chain = ['jaw_crusher', 'vibrating_screen', 'cone_crusher', 'ball_mill', 'magnetic_separator', 'leaching_tank', 'filtration_press'];
      chain.forEach((id, k) => { if (eqById.has(id)) factoryGrid[4 * FGW + 4 + k] = id; });
      saveFactory(); renderFactory();
    }
    if (params.get('build')) setTimeout(openFactory, 400);
    initControls();
    initOptions();
    initTutorial();
    $('#status').innerHTML = `<b>Moleculia</b> · ${(w.meta.zones || []).length} zones` +
      (site ? ` · grounded at ${site.name}` : '') + ` · the web continuation of the Roblox teaser`;
    $('#resolve').innerHTML = `<div style="color:#7fe0a0;margin-bottom:3px">⚗️ Slakkenspoor — BOF slag processing line</div>`
      + line.map((s, i) => `<div><span class="a">${String(i + 1).padStart(2, '0')}</span> ${s}</div>`).join('');
    window.__molgangZones = w.meta.zones || [];      // XR zone-teleport targets
    window.__molgangWorld = { world: 'moleculia', zones: (w.meta.zones || []).length,
      stations: line.length, assets: assetIdx.length, interactables: interactables.length,
      groundedSite: site ? site.name : null, groundColor: groundMat.color.getHexString() };
    window.__molgangDebug = () => ({ px: player.pos.x, pz: player.pos.z,
      near: interactables.map((o) => Math.hypot(o.x - player.pos.x, o.z - player.pos.z) | 0) });
  } else {
    // legacy city (roads + diffusion) — kept behind ?world=./world.json
    const roadMat = new THREE.MeshStandardMaterial({ color: 0x2b2e33, roughness: 0.9 });
    const lineMat = new THREE.MeshStandardMaterial({ color: 0xd9c56a, emissive: 0x2e2a16 });
    for (const at of (roadAts || [])) {
      for (const horiz of [true, false]) {
        const road = new THREE.Mesh(horiz ? new THREE.PlaneGeometry(WORLD, ROAD) : new THREE.PlaneGeometry(ROAD, WORLD), roadMat);
        road.rotation.x = -Math.PI / 2; road.position.set(horiz ? 0 : at, 0.02, horiz ? at : 0); scene.add(road);
        const ln = new THREE.Mesh(horiz ? new THREE.PlaneGeometry(WORLD, 0.5) : new THREE.PlaneGeometry(0.5, WORLD), lineMat);
        ln.rotation.x = -Math.PI / 2; ln.position.set(horiz ? 0 : at, 0.03, horiz ? at : 0); scene.add(ln);
      }
    }
    $('#status').textContent = `Identified → models: ${w.meta.assets} · Unidentified → diffusion: ${w.meta.impostors}`;
    if (w.resolve) $('#resolve').innerHTML = Object.entries(w.resolve)
      .map(([r, k]) => `<div><span class="${k === 'asset' ? 'a' : 'i'}">${k === 'asset' ? '▣ model' : '◈ diffusion'}</span> ${r}</div>`).join('');
    window.__molgangWorld = { total: objects.length, assets: w.meta.assets, impostors: w.meta.impostors };
  }
  stream(); // first populate
})();

// ---------- 🏡 every player's own garden (Liebig NPK growth) ----------
// A personal 6-plot bed near spawn — the walkable, VR-reachable front end
// for the SAME element -> Fertilizer Lab -> Farm economy above (crops[],
// fertInv, fertById, earn()). No second crop/fertiliser list: the garden's
// crop pedestals are literally `crops` (Wheat/Tomato/Rice/Grape Vine/
// Phytoremediation Plant) and its fertiliser tool spends real synthesized
// fertInv stock. Pure chemistry lives in garden.js; here we render it and
// wire the pedestals into the same click/trigger inspection ray as
// everything else.
const GARDEN_AT = { x: 14, z: 24 };
const cropOf = (id) => crops.find((c) => c.id === id);
let garden = null;      // built once `crops` is loaded (see init(), below)
let gardenGroup = null, gardenTool = null;
const gardenPlots3D = [], gardenPedestals = {};
let gardenBoardCtx = null, gardenBoardTex = null;
let gardenLastVis = 0, gardenLastSave = 0, gardenLastBoard = 0;

function gardenLabel(text, w = 256, h = 96, size = 34) {
  const cv = document.createElement('canvas');
  cv.width = w; cv.height = h;
  const g = cv.getContext('2d');
  g.fillStyle = '#10151d'; g.fillRect(0, 0, w, h);
  g.strokeStyle = '#2f4356'; g.lineWidth = 4; g.strokeRect(2, 2, w - 4, h - 4);
  g.fillStyle = '#eaf2f5'; g.font = `${size}px sans-serif`;
  g.textAlign = 'center'; g.textBaseline = 'middle';
  g.fillText(text, w / 2, h / 2);
  const tex = new THREE.CanvasTexture(cv);
  return new THREE.MeshBasicMaterial({ map: tex });
}

function buildGarden() {
  gardenGroup = new THREE.Group();
  const wood = new THREE.MeshStandardMaterial({ color: 0x6b4a2f, roughness: .8 });
  const soil = new THREE.MeshStandardMaterial({ color: 0x2e2118, roughness: 1 });
  const frame = new THREE.Mesh(new THREE.BoxGeometry(5.0, 0.5, 3.6), wood);
  frame.position.y = 0.25; gardenGroup.add(frame);
  for (let i = 0; i < 6; i++) {
    const px = (i % 3 - 1) * 1.55, pz = (i < 3 ? -0.85 : 0.85);
    const bed = new THREE.Mesh(new THREE.BoxGeometry(1.4, 0.12, 1.5), soil);
    bed.position.set(px, 0.53, pz);
    bed.userData.def = { garden: `plot:${i}` };
    gardenGroup.add(bed);
    const plantG = new THREE.Group();
    plantG.position.set(px, 0.58, pz);
    gardenGroup.add(plantG);
    gardenPlots3D.push({ bed, plantG, sig: '' });
  }
  const cropIcon = { wheat: '🌾', tomato: '🍅', rice: '🌾', grape: '🍇',
                    phytoremediation: '🌿' };
  const tools = [
    ...crops.map((c) => [c.id, `${cropIcon[c.id] || '🌱'} ${c.name}`]),
    ['water', '💧 Water'], ['fertilize', '🧪 Bemesten'], ['harvest', '✂️ Oogst'],
  ];
  tools.forEach(([key, label], i) => {
    const px = -0.55 * (tools.length - 1) + i * 1.1;
    const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.06, 0.08, 1.0, 8),
      new THREE.MeshStandardMaterial({ color: 0x39424e }));
    pole.position.set(px, 0.5, 2.6);
    const sign = new THREE.Mesh(new THREE.PlaneGeometry(0.9, 0.34),
      gardenLabel(label, 256, 96, label.length > 16 ? 20 : label.length > 9 ? 26 : 34));
    sign.position.set(px, 1.15, 2.6);
    sign.rotation.y = Math.PI;
    sign.userData.def = { garden: `tool:${key}` };
    pole.userData.def = { garden: `tool:${key}` };
    gardenGroup.add(pole, sign);
    gardenPedestals[key] = sign;
  });
  const boardCv = document.createElement('canvas');
  boardCv.width = 512; boardCv.height = 340;
  gardenBoardCtx = boardCv.getContext('2d');
  gardenBoardTex = new THREE.CanvasTexture(boardCv);
  const board = new THREE.Mesh(new THREE.PlaneGeometry(2.6, 1.7),
    new THREE.MeshBasicMaterial({ map: gardenBoardTex }));
  board.position.set(0, 1.9, -2.4);
  gardenGroup.add(board);
  const title = new THREE.Mesh(new THREE.PlaneGeometry(2.2, 0.4),
    gardenLabel('🏡 Mijn tuintje', 512, 96, 44));
  title.position.set(0, 3.0, -2.42);
  gardenGroup.add(title);
  gardenGroup.position.set(GARDEN_AT.x, 0, GARDEN_AT.z);
  scene.add(gardenGroup);
  gardenDrawBoard();
}

const GARDEN_SYMPTOM_COLORS = {
  ok: 0x3f9b45, geel: 0xd9c34a, paars: 0x7a4a8a, bladrand: 0x8a6a3a, ph: 0x6a7a4a,
};
const GARDEN_FRUIT = { wheat: 0xd9c34a, tomato: 0xc23b2e, rice: 0xe8dfc0,
  grape: 0x5a3a7a, phytoremediation: 0x4a8a5a };
function gardenPlantVisual(i) {
  const p = garden.plots[i], v = gardenPlots3D[i];
  const crop = cropOf(p.crop);
  const sym = garden.symptoms(p, crop);
  const sig = p.crop ? `${p.crop}:${(p.growth * 20) | 0}:${sym.join()}` : 'leeg';
  if (sig === v.sig) return;
  v.sig = sig;
  v.plantG.clear();
  if (!p.crop || !crop) return;
  const leafCol = sym.includes('geel') ? GARDEN_SYMPTOM_COLORS.geel
    : sym.includes('paars') ? GARDEN_SYMPTOM_COLORS.paars
    : sym.includes('bladrand') ? GARDEN_SYMPTOM_COLORS.bladrand
    : GARDEN_SYMPTOM_COLORS.ok;
  const h = 0.15 + p.growth * (crop.id === 'grape' ? 1.3 : 0.9);
  const stem = new THREE.Mesh(new THREE.CylinderGeometry(0.02, 0.03, h, 6),
    new THREE.MeshStandardMaterial({ color: 0x3a6b30, roughness: .8 }));
  stem.position.y = h / 2;
  if (sym.includes('slap')) stem.rotation.z = 0.5;      // wilting
  v.plantG.add(stem);
  const leafMat = new THREE.MeshStandardMaterial({
    color: leafCol, roughness: .7, side: THREE.DoubleSide });
  for (let k = 0; k < 4; k++) {
    const leaf = new THREE.Mesh(new THREE.PlaneGeometry(0.28, 0.14), leafMat);
    leaf.position.set(Math.cos(k * 1.6) * 0.14, h * (0.35 + k * 0.15),
                      Math.sin(k * 1.6) * 0.14);
    leaf.rotation.set(-0.5, k * 1.6, 0);
    if (sym.includes('slap')) leaf.rotation.x = -1.2;
    v.plantG.add(leaf);
  }
  if (p.growth > 0.7) {
    const fruitCol = GARDEN_FRUIT[crop.id] || 0xd9c34a;
    const n = crop.id === 'grape' ? 5 : crop.id === 'phytoremediation' ? 1 : 3;
    for (let k = 0; k < n; k++) {
      const fr = new THREE.Mesh(new THREE.SphereGeometry(
        crop.id === 'phytoremediation' ? 0.16 : 0.06, 10, 8),
        new THREE.MeshStandardMaterial({ color: fruitCol, roughness: .5 }));
      fr.position.set(Math.cos(k * 2.1) * 0.1, h - k * 0.06,
                      Math.sin(k * 2.1) * 0.1);
      v.plantG.add(fr);
    }
  }
}

function gardenDrawBoard() {
  if (!gardenBoardCtx) return;
  const g = gardenBoardCtx;
  g.fillStyle = '#10151d'; g.fillRect(0, 0, 512, 340);
  g.font = '17px monospace'; g.textAlign = 'left'; g.textBaseline = 'alphabetic';
  garden.plots.forEach((p, i) => {
    const crop = cropOf(p.crop);
    const x = 14 + (i % 2) * 256, y = 26 + Math.floor(i / 2) * 106;
    g.fillStyle = '#89a0b0';
    g.fillText(`${i + 1}. ${crop ? crop.name : 'leeg'} (pH ${p.soil.ph.toFixed(1)})`, x, y);
    if (crop) {
      const lim = garden.limiting(p, crop);
      g.fillStyle = '#eaf2f5';
      g.fillText(`groei ${(p.growth * 100) | 0}%  ` +
        (p.growth >= 0.95 ? 'RIJP ✂️' : `min: ${lim.name}`), x, y + 20);
    }
    const bars = [['N', p.soil.N / 300, '#5aa5e0'], ['P', p.soil.P / 200, '#b07ae0'],
                  ['K', p.soil.K / 300, '#e0a05a'], ['w', p.soil.water / 40, '#7ec8f7']];
    bars.forEach(([lbl, frac, col], b) => {
      g.fillStyle = '#243342'; g.fillRect(x + b * 58, y + 32, 50, 12);
      g.fillStyle = col;
      g.fillRect(x + b * 58, y + 32, 50 * Math.min(1, Math.max(0, frac)), 12);
      g.fillStyle = '#89a0b0'; g.fillText(lbl, x + b * 58 + 20, y + 60);
    });
  });
  g.fillStyle = '#f4b41a'; g.font = '16px monospace';
  const toolLabel = gardenTool ? (cropOf(gardenTool) ? cropOf(gardenTool).name : gardenTool) : null;
  g.fillText(toolLabel ? `gereedschap: ${toolLabel}` : 'kies gereedschap op een bordje →', 14, 330);
  gardenBoardTex.needsUpdate = true;
}

function gardenActivate(tag) {
  const [kind, val] = tag.split(':');
  if (kind === 'tool') {
    gardenTool = val;
    for (const [k, sign] of Object.entries(gardenPedestals)) {
      sign.material.color.setHex(k === val ? 0x9fffd9 : 0xffffff);
    }
    gardenDrawBoard();
    const crop = cropOf(val);
    if (crop) {
      return `🧰 ${crop.name} gekozen (NPK ${crop.idealNPK.join('-')}, pH `
        + `${crop.idealPH[0]}–${crop.idealPH[1]}) — klik nu op een plantvak.`;
    }
    const hints = { water: 'tegen verwelken', fertilize: 'gebruikt je in de '
      + 'Fertilizer Lab (F) gesynthetiseerde meststof', harvest: 'alleen rijp (95%+)' };
    return `🧰 ${val} gekozen — ${hints[val] || ''}. Klik nu op een plantvak.`;
  }
  const i = +val;
  if (!gardenTool) return '🏡 Kies eerst gereedschap op een bordje';
  let r;
  if (cropOf(gardenTool)) {
    r = garden.sow(i, gardenTool);
  } else if (gardenTool === 'water') {
    r = garden.waterPlot(i);
  } else if (gardenTool === 'harvest') {
    r = garden.harvest(i, cropOf);
    if (r.ok) earn(r.pay);
  } else if (gardenTool === 'fertilize') {
    // Spend real synthesized stock — the SAME fertInv the Fertilizer Lab
    // fills from collected elements. No made-up fertiliser purchase.
    const owned = fertilizers.filter((f) => (fertInv[f.id] || 0) > 0)
      .sort((a, b) => (fertInv[b.id] || 0) - (fertInv[a.id] || 0));
    if (!owned.length) {
      r = { ok: false, msg: 'Geen meststof — synthetiseer eerst in de '
        + 'Fertilizer Lab (F, gebruikt verzamelde elementen)' };
    } else {
      const f = owned[0];
      fertInv[f.id]--;
      try { localStorage.setItem(FERT_KEY, JSON.stringify(fertInv)); } catch (e) { /* quota */ }
      r = garden.fertilise(i, f);
    }
  }
  gardenPlantVisual(i);
  gardenDrawBoard();
  garden.save(localStorage);
  return (r.ok ? '✅ ' : '⚠️ ') + r.msg;
}

function gardenTick(now) {
  if (!gardenGroup) return;
  garden.step(0.18, cropOf);               // called from the 180 ms throttle
  if (now - gardenLastVis > 500) {
    gardenLastVis = now;
    for (let i = 0; i < garden.plots.length; i++) gardenPlantVisual(i);
  }
  if (now - gardenLastBoard > 1000) { gardenLastBoard = now; gardenDrawBoard(); }
  if (now - gardenLastSave > 5000) { gardenLastSave = now; garden.save(localStorage); }
}
// Built from init() once `crops` (real Wheat/Tomato/Rice/Grape Vine/
// Phytoremediation Plant, ported from the Lua game data) is loaded.
function initGarden() {
  garden = Garden.load(localStorage, cropOf);
  buildGarden();
  window.__garden = {
    garden, crops, fertilizers,
    get fertInv() { return fertInv; },
    activate: gardenActivate,
    fastForward(seconds) {
      for (let t = 0; t < seconds; t += 5) garden.step(5, cropOf);
      for (let i = 0; i < garden.plots.length; i++) gardenPlantVisual(i);
      gardenDrawBoard();
      return garden.plots.map((p) => ({ crop: p.crop, growth: p.growth,
        health: p.health, symptoms: garden.symptoms(p, cropOf(p.crop)) }));
    },
  };
}
