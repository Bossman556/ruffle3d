import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { GTAOPass } from 'three/examples/jsm/postprocessing/GTAOPass.js';
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js';
import { LineSegments2 } from 'three/examples/jsm/lines/LineSegments2.js';
import { LineSegmentsGeometry } from 'three/examples/jsm/lines/LineSegmentsGeometry.js';
import { LineMaterial } from 'three/examples/jsm/lines/LineMaterial.js';
import { DecalGeometry } from 'three/examples/jsm/geometries/DecalGeometry.js';
import { toWorld, STD_PLANES } from './geom2d.js';
import { sampleGeom } from './sketch/model.js';
import { computeRegions } from './sketch/regions.js';
import { encodeWebM, canEncodeWebM } from './webm.js';

// Theme-dependent colours (mutated by Viewport.setTheme; read at draw time by the sketcher too).
export const COLORS = {
  select: 0x4f8cff, hover: 0x8fb6ff, edge: 0x14171c, sketch: 0x5aa2ff, profile: 0xf2a23a, cap: 0xe0564a,
  skFull: 0xe8ecf0, skFree: 0x5aa2ff, skFixed: 0xc084fc, skConstr: 0xf2994a, skPrev: 0x6ea0ff, skSnap: 0x3ecf8e, skDim: 0xaab2be,
};
const THEMES = {
  dark: {
    select: 0x4f8cff, hover: 0x8fb6ff, edge: 0x101216, sketch: 0x5aa2ff, skFull: 0xe8ecf0, skFree: 0x5aa2ff, skFixed: 0xc084fc,
    skConstr: 0xf2994a, skPrev: 0x6ea0ff, skSnap: 0x3ecf8e, skDim: 0xaab2be,
    grid: 0x3a414c, gridMajor: 0x525b68, cubeFace: '#2a3039', cubeText: '#d5dbe3', cubeEdge: 0x56606d, cubeBorder: '#3d4551',
  },
  light: {
    select: 0x2f6bff, hover: 0x6f9bff, edge: 0x1a1f26, sketch: 0x2f6bff, skFull: 0x161b22, skFree: 0x1e6fd9, skFixed: 0x9c27b0,
    skConstr: 0xe07b1f, skPrev: 0x2f6bff, skSnap: 0x16a34a, skDim: 0x3a4652,
    grid: 0xc3cad3, gridMajor: 0xa3adb9, cubeFace: '#f5f7fa', cubeText: '#3b4652', cubeEdge: 0x9aa5b1, cubeBorder: '#c9d1da',
  },
};

const tmpV = new THREE.Vector3();

// Converts replicad edge polylines (one polyline per edge) into LineSegments geometry + segment→edge map.
function edgeGeometry(lines, edgeGroups) {
  let segs = 0;
  for (const g of edgeGroups) segs += Math.max(0, g.count - 1);
  const pos = new Float32Array(segs * 6);
  const segEdge = new Int32Array(segs);
  let k = 0;
  edgeGroups.forEach((g, gi) => {
    for (let i = g.start; i < g.start + g.count - 1; i++) {
      pos.set(lines.subarray(i * 3, i * 3 + 6), k * 6);
      segEdge[k++] = gi;
    }
  });
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geo.userData.segEdge = segEdge;
  geo.userData.edgeGroups = edgeGroups;
  return geo;
}

export function buildBodyGeometry(mesh) {
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(mesh.vertices, 3));
  geo.setAttribute('normal', new THREE.BufferAttribute(mesh.normals, 3));
  geo.setIndex(new THREE.BufferAttribute(mesh.triangles, 1));
  geo.userData.faceGroups = mesh.faceGroups;
  geo.computeBoundingSphere();
  geo.computeBoundingBox();
  const edges = edgeGeometry(mesh.lines, mesh.edgeGroups);
  edges.computeBoundingSphere();
  return { geo, edges, bbox: mesh.bbox };
}

// Index of the B-rep face (face group) closest to a stored pick point, or -1 if none lies within ~1 mm.
export function faceAtPoint(geo, p) {
  const idx = geo.index.array, pos = geo.attributes.position.array, groups = geo.userData.faceGroups;
  const P = new THREE.Vector3(...p), tri = new THREE.Triangle(), q = new THREE.Vector3();
  let best = -1, bd = Infinity;
  groups.forEach((g, gi) => {
    for (let i = g.start; i < g.start + g.count; i += 3) {
      tri.a.fromArray(pos, idx[i] * 3); tri.b.fromArray(pos, idx[i + 1] * 3); tri.c.fromArray(pos, idx[i + 2] * 3);
      tri.closestPointToPoint(P, q);
      const d = q.distanceToSquared(P);
      if (d < bd) { bd = d; best = gi; }
    }
  });
  return bd < 1 ? best : -1;
}

function faceGroupOf(geo, triIndex) {
  const groups = geo.userData.faceGroups;
  const idx = triIndex * 3;
  let lo = 0, hi = groups.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1, g = groups[mid];
    if (idx < g.start) hi = mid - 1;
    else if (idx >= g.start + g.count) lo = mid + 1;
    else return mid;
  }
  return -1;
}

function isPlanarGroup(geo, gi) {
  const g = geo.userData.faceGroups[gi];
  const idx = geo.index.array, nrm = geo.attributes.normal.array;
  const n0 = new THREE.Vector3(nrm[idx[g.start] * 3], nrm[idx[g.start] * 3 + 1], nrm[idx[g.start] * 3 + 2]);
  for (let i = g.start; i < g.start + g.count; i += 3) {
    const v = idx[i] * 3;
    if (Math.abs(nrm[v] * n0.x + nrm[v + 1] * n0.y + nrm[v + 2] * n0.z) < 0.9999) return null;
  }
  return n0.normalize();
}

function makeLabelTexture(text, th) {
  const c = document.createElement('canvas');
  c.width = c.height = 256;
  const g = c.getContext('2d');
  g.fillStyle = th.cubeFace; g.fillRect(0, 0, 256, 256);
  g.strokeStyle = th.cubeBorder; g.lineWidth = 10; g.strokeRect(5, 5, 246, 246);
  g.fillStyle = th.cubeText; g.font = "650 40px 'Inter Variable', Inter, 'Segoe UI', Arial"; g.textAlign = 'center'; g.textBaseline = 'middle';
  g.fillText(text, 128, 132);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

export class Viewport {
  constructor(container, prefs = {}) {
    this.el = container;
    this.prefs = { shadows: true, ao: false, edges: true, viewcube: true, nav: 'ruffle', fov: 40, ...prefs };
    this.themeName = document.documentElement.dataset.theme || 'dark';
    Object.assign(COLORS, THEMES[this.themeName]);
    this.listeners = {};
    this.bodies = new Map(); // id -> { mesh, back, edges, data }
    this.pickBodies = null; // optional alternative set for picking (base state while editing)
    this.displayMode = 'shadedEdges';
    this.section = { enabled: false, axis: 'Z', offset: 0, flip: false };
    this.clipPlane = new THREE.Plane(new THREE.Vector3(0, 0, -1), 0);
    this.labels = [];

    const r = (this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, preserveDrawingBuffer: true }));
    r.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    r.localClippingEnabled = true;
    r.toneMapping = THREE.ACESFilmicToneMapping;
    r.toneMappingExposure = 1.05;
    r.autoClear = false;
    r.shadowMap.enabled = true;
    r.shadowMap.type = THREE.PCFSoftShadowMap;
    container.appendChild(r.domElement);

    this.scene = new THREE.Scene();
    this.pmrem = new THREE.PMREMGenerator(r);
    this.envs = {};
    this.setEnvironment('studio');

    THREE.Object3D.DEFAULT_UP.set(0, 0, 1);
    this.persp = new THREE.PerspectiveCamera(this.prefs.fov, 1, 0.5, 20000);
    this.ortho = new THREE.OrthographicCamera(-1, 1, 1, -1, -20000, 20000);
    this.persp.up.set(0, 0, 1);
    this.ortho.up.set(0, 0, 1);
    this.camera = this.persp;
    this.persp.position.set(160, -220, 150);

    const c = (this.controls = new OrbitControls(this.camera, r.domElement));
    this.setNavPreset(this.prefs.nav);
    c.enableDamping = false;
    c.zoomToCursor = true;
    c.screenSpacePanning = true;
    c.rotateSpeed = 0.8;
    c.addEventListener('change', () => this.requestRender());

    this.hemi = new THREE.HemisphereLight(0xffffff, 0x8899aa, 0.45);
    this.scene.add(this.hemi);
    const key = new THREE.DirectionalLight(0xffffff, 1.0);
    this.camLight = key;
    this.scene.add(key, key.target);
    // fixed overhead "sun" that casts soft contact shadows onto an invisible ground
    const sun = (this.sun = new THREE.DirectionalLight(0xffffff, 0.75));
    sun.castShadow = true;
    sun.shadow.mapSize.set(2048, 2048);
    sun.shadow.bias = -0.0004;
    sun.shadow.normalBias = 0.6;
    sun.shadow.radius = 6;
    sun.shadow.blurSamples = 16;
    this.scene.add(sun, sun.target);
    this.ground = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), new THREE.ShadowMaterial({ opacity: 0.32, transparent: true, depthWrite: false }));
    this.ground.receiveShadow = true;
    this.ground.renderOrder = -3;
    this.ground.raycast = () => {};
    this.scene.add(this.ground);

    this.world = new THREE.Group();
    this.bodyGroup = new THREE.Group();
    this.sketchGroup = new THREE.Group();
    this.overlay = new THREE.Group();
    this.sketchLayer = new THREE.Group(); // owned by the sketcher
    this.canvasGroup = new THREE.Group(); // reference images
    this.scene.add(this.world, this.canvasGroup, this.bodyGroup, this.sketchGroup, this.overlay, this.sketchLayer);
    this._buildGrid();
    this._buildOriginPlanes();
    this._buildViewCube();
    // post-processing (ambient occlusion) - used in the Render workspace or when enabled in preferences
    this.composer = new EffectComposer(r);
    this.renderPass = new RenderPass(this.scene, this.camera);
    this.aoPass = new GTAOPass(this.scene, this.camera, 512, 512);
    this.aoPass.output = GTAOPass.OUTPUT.Default;
    this.aoPass.blendIntensity = 0.85;
    this.composer.addPass(this.renderPass);
    this.composer.addPass(this.aoPass);
    this.composer.addPass(new OutputPass());
    this.renderMode = false;

    this.raycaster = new THREE.Raycaster();
    this.pointer = new THREE.Vector2();
    this._labelRoot = document.createElement('div');
    this._labelRoot.className = 'vp-labels';
    container.appendChild(this._labelRoot);

    this._bindEvents();
    new ResizeObserver(() => this.resize()).observe(container);
    this.resize();
  }

  on(evt, fn) { (this.listeners[evt] ||= []).push(fn); }
  emit(evt, ...a) { (this.listeners[evt] || []).forEach((f) => f(...a)); }

  // ---------- scene furniture ----------
  _buildGrid() {
    const g = new THREE.Group();
    const mat = new THREE.ShaderMaterial({
      transparent: true, depthWrite: false, side: THREE.DoubleSide,
      uniforms: { uMinor: { value: 10 }, uColor: { value: new THREE.Color(COLORS.grid) }, uMajor: { value: new THREE.Color(COLORS.gridMajor) }, uCenter: { value: new THREE.Vector3() }, uFade: { value: 600 } },
      vertexShader: `varying vec3 vP; void main(){ vec4 w = modelMatrix * vec4(position, 1.0); vP = w.xyz; gl_Position = projectionMatrix * viewMatrix * w; }`,
      fragmentShader: `
        uniform float uMinor; uniform vec3 uColor; uniform vec3 uMajor; uniform vec3 uCenter; uniform float uFade; varying vec3 vP;
        float line(vec2 p, float s){ vec2 q = p / s; vec2 g = abs(fract(q - 0.5) - 0.5) / fwidth(q); return 1.0 - min(min(g.x, g.y), 1.0); }
        void main(){
          float minor = line(vP.xy, uMinor);
          float major = line(vP.xy, uMinor * 10.0);
          float fade = 1.0 - smoothstep(uFade * 0.35, uFade, length(vP.xy - uCenter.xy));
          float a = max(minor * 0.35, major * 0.75) * fade;
          if (a < 0.01) discard;
          gl_FragColor = vec4(mix(uColor, uMajor, major), a);
        }`,
    });
    const plane = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), mat);
    plane.scale.set(200000, 200000, 1);
    plane.renderOrder = -2;
    plane.raycast = () => {};
    this.gridMat = mat;
    g.add(plane);
    const axis = (dir, color) => {
      const geo = new THREE.BufferGeometry().setFromPoints([dir.clone().multiplyScalar(-100000), dir.clone().multiplyScalar(100000)]);
      const l = new THREE.Line(geo, new THREE.LineBasicMaterial({ color, transparent: true, opacity: 0.75, depthWrite: false }));
      l.renderOrder = -1;
      l.raycast = () => {};
      return l;
    };
    g.add(axis(new THREE.Vector3(1, 0, 0), 0xe5484d), axis(new THREE.Vector3(0, 1, 0), 0x30a46c));
    const z = new THREE.Line(new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(), new THREE.Vector3(0, 0, 60)]), new THREE.LineBasicMaterial({ color: 0x3e7bfa }));
    z.raycast = () => {};
    g.add(z);
    this.grid = g;
    this.world.add(g);
  }

  _buildOriginPlanes() {
    this.originPlanes = new THREE.Group();
    const mk = (name, plane, color) => {
      const s = 60;
      const geo = new THREE.PlaneGeometry(s, s);
      geo.translate(s / 2, s / 2, 0);
      const m = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.12, side: THREE.DoubleSide, depthWrite: false }));
      const x = new THREE.Vector3(...plane.xDir), n = new THREE.Vector3(...plane.normal);
      const y = new THREE.Vector3().crossVectors(n, x);
      m.matrixAutoUpdate = false;
      m.matrix.makeBasis(x, y, n);
      const border = new THREE.LineSegments(new THREE.EdgesGeometry(geo), new THREE.LineBasicMaterial({ color, transparent: true, opacity: 0.6 }));
      m.add(border);
      m.userData = { kind: 'plane', planeName: name, plane, baseOpacity: 0.12 };
      this.originPlanes.add(m);
    };
    mk('XY', STD_PLANES.XY, 0x2f6fd6);
    mk('XZ', STD_PLANES.XZ, 0x3aa14b);
    mk('YZ', STD_PLANES.YZ, 0xd23b3b);
    this.originPlanes.visible = false;
    this.world.add(this.originPlanes);
  }

  _buildViewCube() {
    const s = (this.cubeScene = new THREE.Scene());
    this.cubeCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.1, 10);
    this.cubeCam.up.set(0, 0, 1);
    // BoxGeometry face order: +x, -x, +y, -y, +z, -z
    const labels = ['RIGHT', 'LEFT', 'BACK', 'FRONT', 'TOP', 'BOTTOM'];
    const mats = labels.map((l) => new THREE.MeshBasicMaterial({ map: makeLabelTexture(l, THEMES[this.themeName]) }));
    this.cubeLabels = labels;
    this.cubeMats = mats;
    const cube = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), mats);
    // set label UVs from each face's "right" and "up" directions as seen from outside (Z up)
    const uv = cube.geometry.attributes.uv, pos = cube.geometry.attributes.position;
    const axes = [
      [[0, 1, 0], [0, 0, 1]], [[0, -1, 0], [0, 0, 1]], [[-1, 0, 0], [0, 0, 1]],
      [[1, 0, 0], [0, 0, 1]], [[1, 0, 0], [0, 1, 0]], [[1, 0, 0], [0, -1, 0]],
    ];
    for (let f = 0; f < 6; f++) {
      const [rt, up] = axes[f];
      for (let i = f * 4; i < f * 4 + 4; i++) {
        const p = [pos.getX(i), pos.getY(i), pos.getZ(i)];
        uv.setXY(i, p[0] * rt[0] + p[1] * rt[1] + p[2] * rt[2] + 0.5, p[0] * up[0] + p[1] * up[1] + p[2] * up[2] + 0.5);
      }
    }
    uv.needsUpdate = true;
    const edges = new THREE.LineSegments(new THREE.EdgesGeometry(cube.geometry), new THREE.LineBasicMaterial({ color: COLORS.cubeEdge }));
    this.cubeEdges = edges;
    cube.add(edges);
    this.cube = cube;
    s.add(cube);
    const ax = (d, c) => {
      const o = new THREE.Vector3(-0.62, -0.62, -0.62);
      const l = new THREE.Line(new THREE.BufferGeometry().setFromPoints([o, o.clone().add(d.multiplyScalar(0.9))]), new THREE.LineBasicMaterial({ color: c }));
      s.add(l);
    };
    ax(new THREE.Vector3(1, 0, 0), 0xe5484d); ax(new THREE.Vector3(0, 1, 0), 0x30a46c); ax(new THREE.Vector3(0, 0, 1), 0x3e7bfa);
    this.cubeHover = new THREE.Mesh(new THREE.BoxGeometry(0.42, 0.42, 0.42), new THREE.MeshBasicMaterial({ color: COLORS.hover, transparent: true, opacity: 0.55, depthTest: false }));
    this.cubeHover.visible = false;
    s.add(this.cubeHover);
    this.cubeSize = 104;
  }

  // ---------- render ----------
  resize() {
    const w = this.el.clientWidth, h = this.el.clientHeight;
    if (!w || !h) return;
    this.renderer.setSize(w, h);
    const pr = this.renderer.getPixelRatio();
    this.composer.setPixelRatio(pr);
    this.composer.setSize(w, h);
    this.lineRes = new THREE.Vector2(w * pr, h * pr);
    this.persp.aspect = w / h;
    this.persp.updateProjectionMatrix();
    this._updateOrthoFrustum();
    this.requestRender();
  }

  _updateOrthoFrustum() {
    const w = this.el.clientWidth, h = this.el.clientHeight;
    const fh = this.orthoHeight || 200;
    this.ortho.left = (-fh * w) / h / 2; this.ortho.right = (fh * w) / h / 2;
    this.ortho.top = fh / 2; this.ortho.bottom = -fh / 2;
    this.ortho.updateProjectionMatrix();
  }

  requestRender() {
    if (this._raf) return;
    this._raf = requestAnimationFrame(() => { this._raf = null; this.render(); });
  }

  render() {
    const r = this.renderer, cam = this.camera;
    // headlight follows the camera so shading is always readable
    this.camLight.position.copy(cam.position).add(tmpV.set(0, 0, 1).applyQuaternion(cam.quaternion).multiplyScalar(50));
    this.camLight.target.position.copy(this.controls.target);
    this.camLight.target.updateMatrixWorld();
    const w = this.el.clientWidth, h = this.el.clientHeight;
    // grid spacing adapts to zoom level; fade radius follows the view
    const dist = cam.isOrthographicCamera ? (this.ortho.top - this.ortho.bottom) / this.ortho.zoom : cam.position.distanceTo(this.controls.target);
    const step = Math.pow(10, Math.floor(Math.log10(Math.max(dist, 1) / 8)));
    this.gridMat.uniforms.uMinor.value = step;
    this.gridMat.uniforms.uCenter.value.copy(this.controls.target);
    this.gridMat.uniforms.uFade.value = Math.max(dist * 2.2, 50);
    r.setViewport(0, 0, w, h);
    r.setScissorTest(false);
    r.clear();
    const usePost = this.renderMode || this.prefs.ao;
    if (usePost) {
      this.renderPass.camera = cam;
      this.aoPass.camera = cam;
      this.overlay.visible = false;
      this.composer.render();
      // overlays (highlights) go on top without ambient occlusion
      this.overlay.visible = true;
      const vis = this.scene.children.map((o) => o.visible);
      this.scene.children.forEach((o) => { if (o !== this.overlay && o !== this.sketchLayer) o.visible = false; });
      const bg = this.scene.background;
      this.scene.background = null;
      r.toneMapping = THREE.NoToneMapping;
      r.render(this.scene, cam);
      r.toneMapping = THREE.ACESFilmicToneMapping;
      this.scene.background = bg;
      this.scene.children.forEach((o, i) => (o.visible = vis[i]));
    } else {
      r.render(this.scene, cam);
    }
    if (this._noCube || !this.prefs.viewcube) { this._updateLabels(); this.emit('render'); return; }
    // view cube
    const cs = this.cubeSize;
    const dir = tmpV.copy(cam.position).sub(this.controls.target).normalize();
    this.cubeCam.position.copy(dir).multiplyScalar(3);
    this.cubeCam.up.copy(cam.up).applyQuaternion(new THREE.Quaternion());
    this.cubeCam.quaternion.copy(cam.quaternion);
    this.cubeCam.updateMatrixWorld();
    r.clearDepth();
    r.setScissorTest(true);
    r.setScissor(w - cs - 10, h - cs - 10, cs, cs);
    r.setViewport(w - cs - 10, h - cs - 10, cs, cs);
    r.render(this.cubeScene, this.cubeCam);
    r.setScissorTest(false);
    this._updateLabels();
    this.emit('render');
  }

  // ---------- labels (HTML overlays anchored to 3D points) ----------
  addLabel(pos, html, cls = '') {
    const el = document.createElement('div');
    el.className = `vp-label ${cls}`;
    el.innerHTML = html;
    this._labelRoot.appendChild(el);
    const l = { pos: new THREE.Vector3(...pos), el };
    this.labels.push(l);
    this.requestRender();
    return l;
  }
  removeLabel(l) { l.el.remove(); this.labels = this.labels.filter((x) => x !== l); }
  _updateLabels() {
    const w = this.el.clientWidth, h = this.el.clientHeight;
    for (const l of this.labels) {
      const p = tmpV.copy(l.pos).project(this.camera);
      l.el.style.display = p.z > 1 ? 'none' : '';
      l.el.style.transform = `translate(${((p.x + 1) / 2) * w}px, ${((1 - p.y) / 2) * h}px)`;
    }
  }
  worldToScreen(v) {
    const p = tmpV.copy(v).project(this.camera);
    return [((p.x + 1) / 2) * this.el.clientWidth, ((1 - p.y) / 2) * this.el.clientHeight];
  }
  worldPerPixel(at = this.controls.target) {
    const h = this.el.clientHeight;
    if (this.camera.isOrthographicCamera) return (this.ortho.top - this.ortho.bottom) / this.ortho.zoom / h;
    const d = this.camera.position.distanceTo(at);
    return (2 * d * Math.tan((this.persp.fov * Math.PI) / 360)) / h;
  }

  // ---------- bodies ----------
  // PBR surface for a look: { metalness, roughness, opacity, clearcoat, clearcoatRoughness, sheen }.
  _surface(color, a = {}) {
    const wire = this.displayMode === 'wire' || this.displayMode === 'xray';
    const opacity = a.opacity ?? 1;
    const m = new THREE.MeshPhysicalMaterial({
      color, metalness: a.metalness ?? 0.15, roughness: a.roughness ?? 0.45,
      clearcoat: a.clearcoat || 0, clearcoatRoughness: a.clearcoatRoughness ?? 0.1,
      sheen: a.sheen || 0, sheenRoughness: 0.6, sheenColor: new THREE.Color(color).lerp(new THREE.Color(0xffffff), 0.5),
      polygonOffset: true, polygonOffsetFactor: 1, polygonOffsetUnits: 1, clippingPlanes: this.section.enabled ? [this.clipPlane] : [],
      side: THREE.FrontSide,
    });
    m.userData.baseOpacity = opacity;
    this._applyWire(m, wire);
    return m;
  }
  _applyWire(m, wire) {
    const op = m.userData.baseOpacity ?? 1;
    m.transparent = wire || op < 1;
    m.opacity = this.displayMode === 'wire' ? 0.06 : this.displayMode === 'xray' ? Math.min(op, 0.28) : op;
    m.depthWrite = !wire && op >= 1;
    m.needsUpdate = true;
  }
  _materials(color, appearance = {}) {
    const clip = this.section.enabled ? [this.clipPlane] : [];
    const front = this._surface(color, appearance);
    const back = new THREE.MeshBasicMaterial({ color: COLORS.cap, side: THREE.BackSide, clippingPlanes: clip, polygonOffset: true, polygonOffsetFactor: 1, polygonOffsetUnits: 1 });
    const edge = new THREE.LineBasicMaterial({ color: COLORS.edge, clippingPlanes: clip, transparent: true, opacity: 0.85 });
    return { front, back, edge, faces: [] };
  }
  _surfaces(b) { return [b.mats.front, ...b.mats.faces]; }

  // Shader used by the Zebra and Draft analysis display modes.
  _analysisMaterial() {
    if (this.analysisMat) return this.analysisMat;
    this.analysisMat = new THREE.ShaderMaterial({
      clipping: true,
      uniforms: { uMode: { value: 0 }, uDensity: { value: 9 }, uDir: { value: new THREE.Vector3(0, 0, 1) }, uAngle: { value: 1 }, uFloor: { value: 0 } },
      vertexShader: `
        varying vec3 vWN; varying vec3 vWP;
        #include <clipping_planes_pars_vertex>
        void main() {
          vec4 wp = modelMatrix * vec4(position, 1.0);
          vWP = wp.xyz; vWN = normalize(mat3(modelMatrix) * normal);
          vec4 mvPosition = viewMatrix * wp;
          gl_Position = projectionMatrix * mvPosition;
          #include <clipping_planes_vertex>
        }`,
      fragmentShader: `
        uniform int uMode; uniform float uDensity; uniform vec3 uDir; uniform float uAngle; uniform float uFloor;
        varying vec3 vWN; varying vec3 vWP;
        #include <clipping_planes_pars_fragment>
        void main() {
          #include <clipping_planes_fragment>
          vec3 N = normalize(vWN);
          vec3 V = normalize(vWP - cameraPosition);
          if (!gl_FrontFacing) N = -N;
          float lit = 0.62 + 0.38 * abs(dot(N, V));
          if (uMode == 0) {
            vec3 R = reflect(V, N);
            float t = (R.z + 0.35 * R.x) * uDensity;
            float w = max(fwidth(t), 1e-4) * 1.2;
            float k = smoothstep(0.5 - w, 0.5 + w, abs(fract(t) - 0.5) * 2.0);
            gl_FragColor = vec4(mix(vec3(0.05), vec3(0.96), k) * (0.85 + 0.15 * lit), 1.0);
          } else if (uMode == 2) {
            // isophotes: lines of constant angle between the normal and a fixed light direction
            // light slightly off the chosen axis so faces aligned with it do not sit exactly on a line
            vec3 Ld = normalize(normalize(uDir) + vec3(0.21, -0.27, 0.13));
            float t = acos(clamp(dot(N, Ld), -1.0, 1.0)) / 3.14159265 * uDensity + 0.25;
            float w = max(fwidth(t), 1e-4) * 1.1;
            float l = 1.0 - smoothstep(0.0, w * 2.0, abs(fract(t) - 0.5));
            vec3 base = vec3(0.86, 0.88, 0.91) * (0.55 + 0.45 * max(dot(N, -V), 0.0));
            gl_FragColor = vec4(mix(base, vec3(0.1, 0.26, 0.78), l), 1.0);
          } else if (uMode == 3) {
            // 3D-print overhangs: angle of downward-facing surfaces from vertical; the face on the bed is fine
            vec3 up = normalize(uDir);
            float a = degrees(asin(clamp(-dot(N, up), -1.0, 1.0)));
            float h = dot(vWP, up) - uFloor;
            vec3 c = vec3(0.80, 0.83, 0.87);
            if (a > 0.5 && h < 0.05) c = vec3(0.35, 0.58, 0.95);
            else if (a > uAngle) c = vec3(0.9, 0.27, 0.3);
            else if (a > uAngle - 10.0) c = vec3(0.97, 0.75, 0.18);
            gl_FragColor = vec4(c * lit, 1.0);
          } else {
            float ang = degrees(asin(clamp(dot(N, normalize(uDir)), -1.0, 1.0)));
            vec3 c = ang >= uAngle ? vec3(0.22, 0.75, 0.42) : (ang <= -uAngle ? vec3(0.9, 0.27, 0.3) : vec3(0.97, 0.75, 0.18));
            gl_FragColor = vec4(c * lit, 1.0);
          }
        }`,
    });
    return this.analysisMat;
  }

  // Vertex-coloured material for curvature maps (grey variant for bodies without data yet).
  _curvMaterial(grey = false) {
    const k = grey ? 'curvGrey' : 'curvMat';
    if (!this[k]) {
      this[k] = grey ? new THREE.MeshStandardMaterial({ color: 0x9aa1aa, roughness: 0.7, metalness: 0 })
        : new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.62, metalness: 0, envMapIntensity: 0.55, side: THREE.DoubleSide });
    }
    this[k].clippingPlanes = this.section.enabled ? [this.clipPlane] : [];
    return this[k];
  }
  // Writes a per-vertex colour attribute from a curvature field [K, H, ...].
  _curvColors(b, field) {
    const geo = b.mesh.geometry, nv = geo.attributes.position.count;
    if (field.length !== nv * 2) return false;
    const a = this.analysis, range = a.range || 0.05;
    const col = new Float32Array(nv * 3), c = new THREE.Color();
    for (let i = 0; i < nv; i++) {
      const K = field[i * 2], H = field[i * 2 + 1];
      let t;
      if (a.which === 'gauss') t = (Math.sign(K) * Math.sqrt(Math.abs(K))) / range;
      else if (a.which === 'max') t = ((Math.abs(H) + Math.sqrt(Math.max(0, H * H - K))) / range) * 2 - 1;
      else t = H / range;
      t = Math.max(-1, Math.min(1, t));
      c.setHSL(((1 - t) / 2) * 0.68, 0.85, 0.5, THREE.SRGBColorSpace);
      col[i * 3] = c.r; col[i * 3 + 1] = c.g; col[i * 3 + 2] = c.b;
    }
    geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
    return true;
  }

  // Display analysis: null | { mode: 'zebra'|'draft', density, dir:[x,y,z], angle }
  //   | { mode: 'curv', fields: { bodyId: Float32Array }, which: 'mean'|'gauss'|'max', range }.
  setAnalysis(a) {
    this.analysis = a;
    if (a) {
      const m = this._analysisMaterial();
      m.uniforms.uMode.value = a.mode === 'draft' ? 1 : a.mode === 'iso' ? 2 : a.mode === 'overhang' ? 3 : 0;
      if (a.floor != null) m.uniforms.uFloor.value = a.floor;
      if (a.mode === 'curv') this._curvMaterial();
      if (a.density) m.uniforms.uDensity.value = a.density;
      if (a.dir) m.uniforms.uDir.value.set(...a.dir);
      if (a.angle != null) m.uniforms.uAngle.value = a.angle;
      m.clippingPlanes = this.section.enabled ? [this.clipPlane] : [];
    }
    for (const b of this.bodies.values()) this._applySurface(b);
    this.requestRender();
  }
  _applySurface(b) {
    const a = this.analysis;
    if (a?.mode === 'curv') {
      const field = a.fields?.[b.data.id];
      if (field && this._curvColors(b, field)) b.mesh.material = this._curvMaterial();
      else b.mesh.material = this._curvMaterial(true);
    } else b.mesh.material = a ? this._analysisMaterial() : b.surf;
    b.edges.visible = this.displayMode !== 'shaded' && this.prefs.edges !== false && !this.renderMode;
  }

  // Simulation results: colours one body by a per-vertex scalar field and can show it deformed.
  //   f = null | { bodyId, values: Float32Array, min, max, invert, disp: Float32Array | null, scale }
  setField(f) {
    this.field = f;
    for (const b of this.bodies.values()) this._applyField(b);
    this.requestRender();
  }
  _applyField(b) {
    const all = this.field, base = b.data.geo.geo;
    // one body ({ bodyId, values, mesh, disp }) or several ({ bodies: { id: { values, mesh } }, min, max, invert })
    const f = !all ? null : all.bodies ? (all.bodies[b.data.id] ? { ...all, ...all.bodies[b.data.id], bodyId: b.data.id } : null) : all;
    const count = f?.mesh ? f.mesh.positions.length / 3 : base.attributes.position.count;
    if (!f || f.bodyId !== b.data.id || f.values.length !== count) {
      if (b.fieldGeo) {
        b.mesh.geometry = base; b.back.geometry = base;
        b.fieldGeo.dispose(); b.fieldGeo = null;
        b.mesh.material = b.surf;
        b.edges.visible = this.displayMode !== 'shaded' && this.prefs.edges !== false && !this.renderMode;
      }
      return;
    }
    if (b.fieldGeo && b.fieldGeo.userData.src !== (f.mesh || base)) { b.fieldGeo.dispose(); b.fieldGeo = null; }
    if (!b.fieldGeo) {
      if (f.mesh) {
        // refined display mesh from the solver, with the CAD face groups so picking still works
        const g = new THREE.BufferGeometry();
        g.setAttribute('position', new THREE.BufferAttribute(f.mesh.positions.slice(), 3));
        g.setAttribute('normal', new THREE.BufferAttribute(f.mesh.normals, 3));
        g.setIndex(new THREE.BufferAttribute(f.mesh.index, 1));
        g.userData = { ...base.userData, faceGroups: f.mesh.faceGroups };
        b.fieldGeo = g;
      } else b.fieldGeo = base.clone();
      b.fieldGeo.userData.src = f.mesh || base;
    }
    const g = b.fieldGeo;
    const nv = g.attributes.position.count, col = new Float32Array(nv * 3), c = new THREE.Color();
    const span = f.max - f.min || 1;
    for (let i = 0; i < nv; i++) {
      let t = Math.max(0, Math.min(1, (f.values[i] - f.min) / span));
      if (f.invert) t = 1 - t;
      c.setHSL((1 - t) * 0.66, 0.9, 0.5, THREE.SRGBColorSpace);
      col[i * 3] = c.r; col[i * 3 + 1] = c.g; col[i * 3 + 2] = c.b;
    }
    g.setAttribute('color', new THREE.BufferAttribute(col, 3));
    const src = f.mesh ? f.mesh.positions : base.attributes.position.array, dst = g.attributes.position.array, k = f.disp ? f.scale || 0 : 0;
    for (let i = 0; i < src.length; i++) dst[i] = src[i] + (k ? f.disp[i] * k : 0);
    g.attributes.position.needsUpdate = true;
    g.computeBoundingBox(); g.computeBoundingSphere();
    b.mesh.geometry = g; b.back.geometry = g;
    b.mesh.material = this._curvMaterial();
    b.edges.visible = false;
  }

  // Moves the field body to a new deformation scale without recolouring (mode-shape animation).
  setFieldScale(k) {
    const f = this.field;
    if (!f) return;
    f.scale = k;
    const b = this.bodies.get(f.bodyId), g = b?.fieldGeo;
    if (!g || !f.disp) return;
    const src = f.mesh ? f.mesh.positions : b.data.geo.geo.attributes.position.array, dst = g.attributes.position.array;
    for (let i = 0; i < src.length; i++) dst[i] = src[i] + f.disp[i] * k;
    g.attributes.position.needsUpdate = true;
    g.computeBoundingSphere();
    this.requestRender();
  }

  // Generative design result: a mesh drawn over a ghosted copy of the original body.
  //   g = null | { bodyId, positions, index }
  setGenerative(g) {
    if (this.genMesh) { this.overlay.remove(this.genMesh); this.genMesh.geometry.dispose(); this.genMesh.material.dispose(); this.genMesh = null; }
    const prev = this.generative;
    this.generative = g;
    if (prev) { const b = this.bodies.get(prev.bodyId); if (b) this._ghost(b, false); }
    if (g) {
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.BufferAttribute(g.positions, 3));
      geo.setIndex(new THREE.BufferAttribute(g.index, 1));
      geo.computeVertexNormals();
      const mat = new THREE.MeshStandardMaterial({ color: 0xb9c6d8, metalness: 0.35, roughness: 0.38, side: THREE.DoubleSide, envMapIntensity: 0.9 });
      this.genMesh = new THREE.Mesh(geo, mat);
      this.genMesh.raycast = () => {};
      this.overlay.add(this.genMesh);
      const b = this.bodies.get(g.bodyId);
      if (b) this._ghost(b, true);
    }
    this.requestRender();
  }
  _ghost(b, on) {
    if (on) {
      this._ghostMat ||= new THREE.MeshBasicMaterial({ color: 0x8a96a8, transparent: true, opacity: 0.1, depthWrite: false, side: THREE.DoubleSide });
      b.mesh.material = this._ghostMat;
      b.edges.visible = true;
    } else b.mesh.material = b.surf;
  }

  // Interface accent → selection / hover colours in the viewport.
  setAccent(hex) {
    this._accent = hex;
    if (!hex) return;
    const c = new THREE.Color(hex);
    COLORS.select = c.getHex();
    COLORS.hover = c.clone().lerp(new THREE.Color(0xffffff), 0.4).getHex();
    this.cubeHover?.material.color.set(COLORS.hover);
    this.refreshHighlights();
    this.requestRender();
  }

  setBodies(list) {
    for (const b of this.bodies.values()) {
      this.bodyGroup.remove(b.group);
      for (const m of this._surfaces(b)) m.dispose();
      b.mats.back.dispose(); b.mats.edge.dispose();
    }
    this.bodies.clear();
    for (const d of list) {
      const mats = this._materials(new THREE.Color(d.color), d.appearance);
      const geo = d.geo.geo;
      geo.clearGroups();
      let surf = mats.front;
      if (d.faces?.length) {
        // per-face appearance overrides: one material per painted face, applied through geometry groups
        const fmap = new Map();
        for (const f of d.faces) {
          if (fmap.has(f.faceIndex)) continue;
          mats.faces.push(this._surface(new THREE.Color(f.color), f.appearance));
          fmap.set(f.faceIndex, mats.faces.length);
        }
        const fg = geo.userData.faceGroups;
        let start = 0, cur = -1, count = 0;
        fg.forEach((g, gi) => {
          const mi = fmap.get(gi) || 0;
          if (mi !== cur || g.start !== start + count) {
            if (count) geo.addGroup(start, count, cur);
            start = g.start; count = 0; cur = mi;
          }
          count += g.count;
        });
        if (count) geo.addGroup(start, count, cur);
        surf = [mats.front, ...mats.faces];
      }
      if (d.surface) for (const m of [mats.front, ...mats.faces]) m.side = THREE.DoubleSide;
      const group = new THREE.Group();
      const mesh = new THREE.Mesh(geo, surf);
      mesh.castShadow = true;
      mesh.userData = { kind: 'body', bodyId: d.id };
      const back = new THREE.Mesh(d.geo.geo, mats.back);
      back.visible = this.section.enabled && !d.surface;
      back.raycast = () => {};
      const edges = new THREE.LineSegments(d.geo.edges, mats.edge);
      edges.userData = { kind: 'edges', bodyId: d.id };
      edges.visible = this.displayMode !== 'shaded' && !this.renderMode;
      group.add(mesh, back, edges);
      group.visible = d.visible !== false;
      this.bodyGroup.add(group);
      const rec = { group, mesh, back, edges, mats, surf, data: d };
      this.bodies.set(d.id, rec);
      if (this.analysis) this._applySurface(rec);
      if (this.field) this._applyField(rec);
      if (this.generative?.bodyId === d.id) this._ghost(rec, true);
      const off = this.explode?.get(d.id);
      if (off) group.position.set(...off);
    }
    this.updateShadowBounds();
    this.refreshHighlights();
    this.requestRender();
  }

  // Fits the shadow camera and ground plane to the visible model.
  updateShadowBounds() {
    const box = new THREE.Box3();
    for (const b of this.bodies.values()) if (b.group.visible) box.union(b.mesh.geometry.boundingBox);
    const on = this.prefs.shadows && !box.isEmpty() && !this.section.enabled;
    this.sun.castShadow = on;
    this.ground.visible = on;
    if (!on) return;
    const c = box.getCenter(new THREE.Vector3()), size = box.getSize(new THREE.Vector3());
    const r = Math.max(size.x, size.y, size.z) * 0.9 + 10;
    this.sun.position.set(c.x + r * 0.9, c.y - r * 1.1, c.z + r * 2.2);
    this.sun.target.position.copy(c);
    this.sun.target.updateMatrixWorld();
    const sc = this.sun.shadow.camera;
    sc.left = -r * 1.6; sc.right = r * 1.6; sc.top = r * 1.6; sc.bottom = -r * 1.6; sc.near = 0.1; sc.far = r * 6;
    sc.updateProjectionMatrix();
    this.ground.position.set(c.x, c.y, box.min.z - 0.02);
    this.ground.scale.set(r * 8, r * 8, 1);
  }

  setPickBodies(list) {
    // invisible copies of a base state used for picking edges/faces while a feature is previewed
    if (this.pickGroup) { this.scene.remove(this.pickGroup); this.pickGroup = null; }
    this.pickBodies = null;
    if (!list) return this.requestRender();
    this.pickGroup = new THREE.Group();
    this.pickBodies = new Map();
    for (const d of list) {
      if (d.visible === false) continue;
      const mesh = new THREE.Mesh(d.geo.geo, new THREE.MeshBasicMaterial({ visible: false }));
      mesh.userData = { kind: 'body', bodyId: d.id };
      const edges = new THREE.LineSegments(d.geo.edges, new THREE.LineBasicMaterial({ color: 0x5c6873, transparent: true, opacity: 0.55 }));
      edges.userData = { kind: 'edges', bodyId: d.id };
      edges.renderOrder = 5;
      this.pickGroup.add(mesh, edges);
      this.pickBodies.set(d.id, { mesh, edges, data: d });
    }
    this.scene.add(this.pickGroup);
    this.requestRender();
  }

  setDisplayMode(mode) {
    this.displayMode = mode;
    for (const b of this.bodies.values()) {
      for (const m of this._surfaces(b)) this._applyWire(m, mode === 'wire' || mode === 'xray');
      b.edges.visible = mode !== 'shaded' && this.prefs.edges !== false && !this.renderMode;
    }
    this.requestRender();
  }

  setSection(sec) {
    Object.assign(this.section, sec);
    this.updateShadowBounds();
    const n = { X: [1, 0, 0], Y: [0, 1, 0], Z: [0, 0, 1] }[this.section.axis];
    const s = this.section.flip ? 1 : -1;
    this.clipPlane.normal.set(n[0] * s, n[1] * s, n[2] * s);
    this.clipPlane.constant = -s * this.section.offset;
    for (const b of this.bodies.values()) {
      for (const m of [...this._surfaces(b), b.mats.back, b.mats.edge, ...[this.analysisMat, this.curvMat, this.curvGrey].filter(Boolean)]) {
        m.clippingPlanes = this.section.enabled ? [this.clipPlane] : [];
        m.needsUpdate = true;
      }
      b.back.visible = this.section.enabled && !b.data.surface;
    }
    this.requestRender();
  }

  // ---------- sketches (display of finished sketches) ----------
  setSketches(list) {
    this.sketchGroup.clear();
    for (const sk of list) {
      if (sk.visible === false) continue;
      const g = new THREE.Group();
      g.userData = { sketchId: sk.id };
      const lineMat = new THREE.LineBasicMaterial({ color: COLORS.sketch });
      const dashMat = new THREE.LineDashedMaterial({ color: 0x8a96a3, dashSize: 2, gapSize: 1.5 });
      for (const geo of sk.geom || []) {
        const pts = sampleGeom(geo, 72);
        if (pts.length < 2) continue;
        const v = pts.map((p) => new THREE.Vector3(...toWorld(sk.plane, p)));
        const l = new THREE.Line(new THREE.BufferGeometry().setFromPoints(v), geo.construction ? dashMat : lineMat);
        if (geo.construction) { l.computeLineDistances(); l.raycast = () => {}; }
        l.userData = { kind: 'curve', sketchId: sk.id };
        g.add(l);
      }
      buildProfileMeshes(sk).forEach((prof, i) => {
        prof.userData = { kind: 'profile', sketchId: sk.id, region: i };
        g.add(prof);
      });
      this.sketchGroup.add(g);
    }
    this.refreshHighlights();
    this.requestRender();
  }

  // 3D CV curves (free-form NURBS) as pickable lines.
  setCurves(list) {
    if (!this.curveGroup) { this.curveGroup = new THREE.Group(); this.scene.add(this.curveGroup); }
    this.curveGroup.clear();
    for (const c of list) {
      if (c.visible === false || !c.pts?.length) continue;
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.Float32BufferAttribute(c.pts, 3));
      const l = new THREE.Line(geo, new THREE.LineBasicMaterial({ color: 0xe46ee8 }));
      l.userData = { kind: 'curve', sketchId: c.id };
      this.curveGroup.add(l);
    }
    this.refreshHighlights();
    this.requestRender();
  }

  // Construction planes as translucent, pickable squares.
  // Reference images on the origin planes: [{ id, data, aspect, plane, width, x, y, offset, angle, opacity, flip }].
  setCanvases(list) {
    this._canvas ||= new Map();
    const keep = new Set();
    for (const c of list) {
      keep.add(c.id);
      let rec = this._canvas.get(c.id);
      if (!rec || rec.data !== c.data) {
        if (rec) { this.canvasGroup.remove(rec.mesh); rec.mesh.material.map?.dispose(); rec.mesh.material.dispose(); }
        const tex = new THREE.TextureLoader().load(c.data, () => this.requestRender());
        tex.colorSpace = THREE.SRGBColorSpace;
        tex.anisotropy = 8;
        const mat = new THREE.MeshBasicMaterial({ map: tex, transparent: true, side: THREE.DoubleSide, depthWrite: false, toneMapped: false });
        const mesh = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), mat);
        mesh.renderOrder = -1;
        mesh.raycast = () => {};
        this.canvasGroup.add(mesh);
        rec = { mesh, data: c.data };
        this._canvas.set(c.id, rec);
      }
      const m = rec.mesh;
      m.material.opacity = c.opacity ?? 0.6;
      m.scale.set((c.flip ? -1 : 1) * c.width, c.width * c.aspect, 1);
      // orient the unit plane (XY, normal +Z) onto the chosen origin plane
      const P = { XY: [[1, 0, 0], [0, 1, 0], [0, 0, 1]], XZ: [[1, 0, 0], [0, 0, 1], [0, -1, 0]], YZ: [[0, 1, 0], [0, 0, 1], [1, 0, 0]] }[c.plane] || [[1, 0, 0], [0, 1, 0], [0, 0, 1]];
      const [ax, ay, an] = P.map((v) => new THREE.Vector3(...v));
      const basis = new THREE.Matrix4().makeBasis(ax, ay, an);
      const q = new THREE.Quaternion().setFromRotationMatrix(basis).multiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 0, 1), ((c.angle || 0) * Math.PI) / 180));
      m.quaternion.copy(q);
      m.position.copy(ax.clone().multiplyScalar(c.x || 0).add(ay.clone().multiplyScalar(c.y || 0)).add(an.clone().multiplyScalar(c.offset || 0)));
    }
    for (const [id, rec] of this._canvas) if (!keep.has(id)) { this.canvasGroup.remove(rec.mesh); rec.mesh.material.map?.dispose(); rec.mesh.material.dispose(); this._canvas.delete(id); }
    this.requestRender();
  }

  // Version compare overlay: added material (green) and removed material (red) over ghosted bodies.
  //   list = null | [{ id, added: { mesh }, removed: { mesh } }], show = { added, removed }
  setCompare(list, show = { added: true, removed: true }) {
    if (this.cmpGroup) { this.overlay.remove(this.cmpGroup); this.cmpGroup.traverse((o) => { o.geometry?.dispose(); o.material?.dispose?.(); }); this.cmpGroup = null; }
    for (const b of this.bodies.values()) if (b.cmpGhost) { b.mesh.material = b.surf; b.cmpGhost = false; }
    if (!list) return this.requestRender();
    const g = new THREE.Group();
    const add = (m, color) => {
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.BufferAttribute(m.vertices, 3));
      geo.setAttribute('normal', new THREE.BufferAttribute(m.normals, 3));
      geo.setIndex(new THREE.BufferAttribute(m.triangles, 1));
      const mesh = new THREE.Mesh(geo, new THREE.MeshStandardMaterial({ color, roughness: 0.5, metalness: 0, transparent: true, opacity: 0.85, polygonOffset: true, polygonOffsetFactor: -1, side: THREE.DoubleSide }));
      mesh.raycast = () => {};
      g.add(mesh);
    };
    for (const r of list) {
      if (r.added && show.added) add(r.added.mesh, 0x3ecf8e);
      if (r.removed && show.removed) add(r.removed.mesh, 0xf0525b);
    }
    this._ghostMat ||= new THREE.MeshBasicMaterial({ color: 0x8a96a8, transparent: true, opacity: 0.1, depthWrite: false, side: THREE.DoubleSide });
    for (const b of this.bodies.values()) { b.mesh.material = this._ghostMat; b.cmpGhost = true; b.edges.visible = true; }
    this.cmpGroup = g;
    this.overlay.add(g);
    this.requestRender();
  }

  // Exploded view: per-body display offsets (Map id → [x, y, z]) or null. Decals move with their bodies.
  setExplode(map) {
    this.explode = map;
    for (const [id, b] of this.bodies) { const o = map?.get(id) || [0, 0, 0]; b.group.position.set(...o); }
    for (const [id, rec] of this._decals || []) { const o = (rec.body && map?.get(rec.body)) || [0, 0, 0]; rec.mesh.position.set(...o); void id; }
    this.requestRender();
  }

  // CAM preview: stock outline, feed moves (solid) and rapids (dashed). t = null | { stock, ops: [{ id, moves, sel }] }
  setToolpaths(t) {
    if (this.camGroup) { this.overlay.remove(this.camGroup); this.camGroup.traverse((o) => { o.geometry?.dispose(); o.material?.dispose?.(); }); this.camGroup = null; }
    if (!t) { this.setToolPosition(null); return this.requestRender(); }
    const g = new THREE.Group();
    const { lo, hi } = t.stock;
    const box = new THREE.BoxGeometry(hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2]);
    const stock = new THREE.LineSegments(new THREE.EdgesGeometry(box), new THREE.LineBasicMaterial({ color: 0xf5a524, transparent: true, opacity: 0.8 }));
    box.dispose();
    stock.position.set((lo[0] + hi[0]) / 2, (lo[1] + hi[1]) / 2, (lo[2] + hi[2]) / 2);
    const fill = new THREE.Mesh(new THREE.BoxGeometry(hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2]), new THREE.MeshBasicMaterial({ color: 0xf5a524, transparent: true, opacity: 0.05, depthWrite: false }));
    fill.position.copy(stock.position);
    fill.raycast = () => {};
    g.add(stock, fill);
    for (const op of t.ops) {
      const feed = [], rapid = [];
      for (let i = 1; i < op.moves.length; i++) (op.moves[i].r ? rapid : feed).push(...op.moves[i - 1].p, ...op.moves[i].p);
      if (feed.length) {
        const geo = new THREE.BufferGeometry();
        geo.setAttribute('position', new THREE.Float32BufferAttribute(feed, 3));
        g.add(new THREE.LineSegments(geo, new THREE.LineBasicMaterial({ color: op.sel ? 0x4f8cff : 0x2dd4bf, transparent: true, opacity: op.sel ? 1 : 0.85 })));
      }
      if (rapid.length) {
        const geo = new THREE.BufferGeometry();
        geo.setAttribute('position', new THREE.Float32BufferAttribute(rapid, 3));
        const ln = new THREE.LineSegments(geo, new THREE.LineDashedMaterial({ color: 0xf0525b, dashSize: 1.5, gapSize: 1.2, transparent: true, opacity: 0.55 }));
        ln.computeLineDistances();
        g.add(ln);
      }
    }
    g.traverse((o) => { o.raycast = () => {}; });
    this.camGroup = g;
    this.overlay.add(g);
    this.requestRender();
  }
  // Animated tool for the CAM simulation (tip at p, diameter d).
  setToolPosition(p, d = 6) {
    if (!p) { if (this.toolMesh) { this.overlay.remove(this.toolMesh); this.toolMesh.geometry.dispose(); this.toolMesh.material.dispose(); this.toolMesh = null; } return this.requestRender(); }
    if (!this.toolMesh || this.toolMesh.userData.d !== d) {
      if (this.toolMesh) { this.overlay.remove(this.toolMesh); this.toolMesh.geometry.dispose(); this.toolMesh.material.dispose(); }
      const geo = new THREE.CylinderGeometry(d / 2, d / 2, d * 5, 24);
      geo.rotateX(Math.PI / 2);
      geo.translate(0, 0, d * 2.5);
      this.toolMesh = new THREE.Mesh(geo, new THREE.MeshStandardMaterial({ color: 0xd8dde4, metalness: 0.9, roughness: 0.25 }));
      this.toolMesh.userData.d = d;
      this.toolMesh.raycast = () => {};
      this.overlay.add(this.toolMesh);
    }
    this.toolMesh.position.set(...p);
    this.requestRender();
  }

  // Decals projected onto body meshes: [{ id, data, aspect, body, p, n, width, angle, opacity }].
  setDecals(list) {
    this._decals ||= new Map();
    this._decalGroup ||= (() => { const g = new THREE.Group(); this.scene.add(g); return g; })();
    const keep = new Set();
    for (const d of list) {
      const b = d.body && this.bodies.get(d.body);
      if (!b || !d.p || !d.n || !b.group.visible) continue;
      keep.add(d.id);
      let rec = this._decals.get(d.id);
      if (!rec || rec.data !== d.data) {
        if (rec) { this._decalGroup.remove(rec.mesh); rec.mesh.geometry.dispose(); rec.mesh.material.map?.dispose(); rec.mesh.material.dispose(); }
        const tex = new THREE.TextureLoader().load(d.data, () => this.requestRender());
        tex.colorSpace = THREE.SRGBColorSpace;
        tex.anisotropy = 8;
        const mat = new THREE.MeshStandardMaterial({ map: tex, transparent: true, depthTest: true, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -4, roughness: 0.45, metalness: 0 });
        const mesh = new THREE.Mesh(new THREE.BufferGeometry(), mat);
        mesh.raycast = () => {};
        mesh.renderOrder = 2;
        this._decalGroup.add(mesh);
        rec = { mesh, data: d.data, key: '', body: d.body };
        this._decals.set(d.id, rec);
      }
      rec.mesh.material.opacity = d.opacity ?? 1;
      rec.body = d.body;
      const eo = this.explode?.get(d.body);
      rec.mesh.position.set(...(eo || [0, 0, 0]));
      const geo = b.mesh.geometry;
      const key = JSON.stringify([d.body, d.p, d.n, d.width, d.angle, d.aspect, geo.uuid]);
      if (rec.key !== key) {
        rec.key = key;
        const pos = new THREE.Vector3(...d.p), n = new THREE.Vector3(...d.n).normalize();
        const helper = new THREE.Object3D();
        helper.position.copy(pos);
        // keep the image upright: its up direction is world Z projected onto the face (Y for flat faces)
        helper.up.set(...(Math.abs(n.z) > 0.95 ? [0, 1, 0] : [0, 0, 1]));
        helper.lookAt(pos.clone().add(n));
        helper.rotateZ(((d.angle || 0) * Math.PI) / 180);
        const size = new THREE.Vector3(d.width, d.width * d.aspect, Math.max(d.width, d.width * d.aspect) * 0.6);
        b.mesh.updateMatrixWorld(true);
        rec.mesh.geometry.dispose();
        rec.mesh.geometry = new DecalGeometry(b.mesh, pos, helper.rotation, size);
      }
    }
    for (const [id, rec] of this._decals) if (!keep.has(id)) { this._decalGroup.remove(rec.mesh); rec.mesh.geometry.dispose(); rec.mesh.material.map?.dispose(); rec.mesh.material.dispose(); this._decals.delete(id); }
    this.requestRender();
  }

  setPlanes(list) {
    if (!this.planeGroup) { this.planeGroup = new THREE.Group(); this.scene.add(this.planeGroup); }
    this.planeGroup.clear();
    const box = this.sceneBox();
    const c = box.isEmpty() ? new THREE.Vector3() : box.getCenter(new THREE.Vector3());
    for (const pl of list) {
      if (pl.visible === false) continue;
      const s = 80;
      const geo = new THREE.PlaneGeometry(s, s);
      const m = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ color: 0xf2a23a, transparent: true, opacity: 0.14, side: THREE.DoubleSide, depthWrite: false }));
      const x = new THREE.Vector3(...pl.plane.xDir), n = new THREE.Vector3(...pl.plane.normal);
      const y = new THREE.Vector3().crossVectors(n, x);
      // centre the square near the model, on the plane
      const o = new THREE.Vector3(...pl.plane.origin);
      const d = c.clone().sub(o);
      const center = o.clone().add(x.clone().multiplyScalar(d.dot(x))).add(y.clone().multiplyScalar(d.dot(y)));
      m.matrixAutoUpdate = false;
      m.matrix.makeBasis(x, y, n).setPosition(center);
      m.add(new THREE.LineSegments(new THREE.EdgesGeometry(geo), new THREE.LineBasicMaterial({ color: 0xd9822b })));
      m.userData = { kind: 'plane', planeId: pl.id, plane: pl.plane, baseOpacity: 0.14 };
      m.renderOrder = 2;
      this.planeGroup.add(m);
    }
    this.requestRender();
  }

  // Visual motion of a jointed body (rotation about / sliding along an axis).
  animateBody(bodyId, origin, axis, type, onStop) {
    this.stopAnimation();
    const b = this.bodies.get(bodyId);
    if (!b) return;
    const o = new THREE.Vector3(...origin), k = new THREE.Vector3(...axis).normalize();
    const g = b.group;
    g.matrixAutoUpdate = false;
    const t0 = performance.now();
    const range = b.mesh.geometry.boundingSphere?.radius || 20;
    const step = () => {
      const t = (performance.now() - t0) / 1000;
      const m = new THREE.Matrix4();
      if (type === 'slider') m.makeTranslation(k.clone().multiplyScalar(Math.sin(t * 1.5) * range));
      else {
        const r = new THREE.Matrix4().makeRotationAxis(k, t * 1.2);
        m.makeTranslation(o.x, o.y, o.z).multiply(r).multiply(new THREE.Matrix4().makeTranslation(-o.x, -o.y, -o.z));
      }
      g.matrix.copy(m);
      g.matrixWorldNeedsUpdate = true;
      this.render();
      this._anim = requestAnimationFrame(step);
    };
    this._animStop = () => { g.matrix.identity(); g.matrixAutoUpdate = true; g.matrixWorldNeedsUpdate = true; onStop?.(); };
    step();
  }

  stopAnimation() {
    if (this._anim) cancelAnimationFrame(this._anim);
    this._anim = null;
    const stop = this._animStop;
    this._animStop = null;
    stop?.();
    this.requestRender();
  }

  // ---------- picking ----------
  _setRay(ev) {
    const r = this.renderer.domElement.getBoundingClientRect();
    this.pointer.set(((ev.clientX - r.left) / r.width) * 2 - 1, -((ev.clientY - r.top) / r.height) * 2 + 1);
    this.raycaster.setFromCamera(this.pointer, this.camera);
    return this.raycaster.ray;
  }

  /** filter: Set of kinds: body, face, edge, point, profile, plane */
  pick(ev, filter) {
    if (!filter || !filter.size) return null;
    const ray = this._setRay(ev);
    const src = this.pickBodies || this.bodies;
    const meshes = [...src.values()].filter((b) => (b.group ? b.group.visible : true)).map((b) => b.mesh);
    const wpp = this.worldPerPixel();
    let hits = this.raycaster.intersectObjects(meshes, false);
    if (this.section.enabled) hits = hits.filter((h) => this.clipPlane.distanceToPoint(h.point) >= -1e-6);
    const meshHit = hits[0];
    if (filter.has('plane') && this.planeGroup?.children.length) {
      const h = this.raycaster.intersectObjects(this.planeGroup.children, false)[0];
      if (h && (!meshHit || h.distance < meshHit.distance)) return { kind: 'plane', planeId: h.object.userData.planeId, plane: h.object.userData.plane, point: h.point.toArray() };
    }

    if (filter.has('edge')) {
      this.raycaster.params.Line.threshold = wpp * 6;
      const edgeObjs = [...src.values()].filter((b) => (b.group ? b.group.visible : true)).map((b) => b.edges);
      let best = null;
      for (const h of this.raycaster.intersectObjects(edgeObjs, false)) {
        const p = h.pointOnLine || h.point;
        if (meshHit && h.distance > meshHit.distance + wpp * 4) continue;
        const d = ray.distanceToPoint(p);
        if (!best || d < best.d) best = { d, h, p };
      }
      if (best) {
        const geo = best.h.object.geometry;
        const seg = Math.floor(best.h.index / 2);
        return { kind: 'edge', bodyId: best.h.object.userData.bodyId, edgeIndex: geo.userData.segEdge[seg], point: best.p.toArray() };
      }
    }
    if (meshHit && (filter.has('face') || filter.has('point') || filter.has('body') || filter.has('plane'))) {
      const geo = meshHit.object.geometry;
      const gi = faceGroupOf(geo, meshHit.faceIndex);
      const n = meshHit.face.normal.clone().normalize();
      const res = { kind: 'face', bodyId: meshHit.object.userData.bodyId, faceIndex: gi, point: meshHit.point.toArray(), normal: n.toArray() };
      if (filter.has('plane')) {
        const pn = isPlanarGroup(geo, gi);
        if (pn) return { ...res, kind: 'plane', normal: pn.toArray(), planar: true };
      } else {
        if (filter.has('face') || filter.has('point')) return res;
        return { ...res, kind: 'body' };
      }
    }
    if (filter.has('curve')) {
      this.raycaster.params.Line.threshold = wpp * 6;
      const lines = [];
      for (const grp of [this.sketchGroup, this.curveGroup].filter(Boolean)) grp.traverse((o) => o.userData.kind === 'curve' && lines.push(o));
      let best = null;
      // when only curves are wanted, bodies do not hide them (pick through, like X-ray selection)
      const occlude = filter.has('face') || filter.has('body') || filter.has('edge');
      for (const h of this.raycaster.intersectObjects(lines, false)) {
        if (occlude && meshHit && h.distance > meshHit.distance + wpp * 4) continue;
        const d = ray.distanceToPoint(h.pointOnLine || h.point);
        if (!best || d < best.d) best = { d, h };
      }
      if (best) return { kind: 'curve', sketchId: best.h.object.userData.sketchId, point: (best.h.pointOnLine || best.h.point).toArray() };
    }
    if (filter.has('profile')) {
      const profs = [];
      this.sketchGroup.traverse((o) => o.userData.kind === 'profile' && profs.push(o));
      const h = this.raycaster.intersectObjects(profs, false)[0];
      if (h && (!meshHit || h.distance <= meshHit.distance + wpp * 2)) return { kind: 'profile', sketchId: h.object.userData.sketchId, region: h.object.userData.region, point: h.point.toArray() };
    }
    if (filter.has('plane')) {
      const objs = [...(this.originPlanes.visible ? this.originPlanes.children : []), ...(this.planeGroup?.children || [])];
      const h = this.raycaster.intersectObjects(objs, false)[0];
      if (h && (!meshHit || h.distance <= meshHit.distance + wpp * 2)) {
        const u = h.object.userData;
        return { kind: 'plane', planeName: u.planeName, planeId: u.planeId, plane: u.plane, point: h.point.toArray() };
      }
    }
    if (filter.has('ground')) {
      const pt = ray.intersectPlane(new THREE.Plane(new THREE.Vector3(0, 0, 1), 0), new THREE.Vector3());
      if (pt) return { kind: 'ground', point: pt.toArray() };
    }
    return null;
  }

  // ---------- highlights ----------
  setHighlights({ selected = [], hover = null } = {}) {
    this._hl = { selected, hover };
    this.refreshHighlights();
  }

  refreshHighlights() {
    this.overlay.clear();
    for (const p of [...this.originPlanes.children, ...(this.planeGroup?.children || [])]) p.material.opacity = p.userData.baseOpacity;
    const { selected = [], hover = null } = this._hl || {};
    const items = [...selected.map((s) => [s, COLORS.select]), ...(hover ? [[hover, COLORS.hover]] : [])];
    const src = this.pickBodies || this.bodies;
    for (const [s, color] of items) {
      const b = src.get(s.bodyId) || this.bodies.get(s.bodyId);
      if (s.kind === 'plane' && (s.planeName || s.planeId)) {
        const pl = s.planeName ? this.originPlanes.children.find((c) => c.userData.planeName === s.planeName) : this.planeGroup?.children.find((c) => c.userData.planeId === s.planeId);
        if (pl) pl.material.opacity = 0.38;
        continue;
      }
      if (s.kind === 'curve') {
        const segs = [];
        [this.sketchGroup, this.curveGroup].filter(Boolean).forEach((grp) => grp.traverse((o) => {
          if (o.userData.kind !== 'curve' || o.userData.sketchId !== s.sketchId) return;
          const pa = o.geometry.attributes.position.array;
          for (let i = 0; i + 5 < pa.length; i += 3) segs.push(pa[i], pa[i + 1], pa[i + 2], pa[i + 3], pa[i + 4], pa[i + 5]);
        }));
        if (segs.length) this.overlay.add(this._fatLine(segs, color, 4));
        continue;
      }
      if (s.kind === 'profile') {
        this.sketchGroup.traverse((o) => {
          if (o.userData.kind === 'profile' && o.userData.sketchId === s.sketchId && (s.region == null || s.region === o.userData.region)) {
            const m = new THREE.Mesh(o.geometry, new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.45, side: THREE.DoubleSide, depthTest: false }));
            m.renderOrder = 6;
            this.overlay.add(m);
          }
        });
        continue;
      }
      if (!b) continue;
      const geo = b.mesh.geometry;
      if (s.kind === 'body') {
        const m = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.35, depthTest: true, polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -1, clippingPlanes: this.section.enabled ? [this.clipPlane] : [] }));
        this.overlay.add(m);
      } else if ((s.kind === 'face' || s.kind === 'plane' || s.kind === 'point') && s.faceIndex >= 0 && s.faceIndex != null) {
        const g = geo.userData.faceGroups[s.faceIndex];
        if (!g) continue;
        const sub = new THREE.BufferGeometry();
        sub.setAttribute('position', geo.attributes.position);
        sub.setIndex(new THREE.BufferAttribute(geo.index.array.slice(g.start, g.start + g.count), 1));
        const m = new THREE.Mesh(sub, new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.55, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2, side: THREE.DoubleSide }));
        this.overlay.add(m);
        if (s.kind === 'point' && s.point) this.overlay.add(this._dot(s.point, color));
      } else if (s.kind === 'edge') {
        const eg = b.edges.geometry;
        const pos = eg.attributes.position.array, map = eg.userData.segEdge;
        const pts = [];
        for (let k = 0; k < map.length; k++) if (map[k] === s.edgeIndex) pts.push(...pos.subarray(k * 6, k * 6 + 6));
        const lg = new THREE.BufferGeometry();
        lg.setAttribute('position', new THREE.BufferAttribute(new Float32Array(pts), 3));
        const l = new THREE.LineSegments(lg, new THREE.LineBasicMaterial({ color, depthTest: false, linewidth: 2 }));
        l.renderOrder = 10;
        this.overlay.add(l);
        // thicken with a tube-like second pass for visibility
        if (pts.length >= 6) this.overlay.add(this._fatLine(pts, color));
      }
    }
    this.requestRender();
  }

  _dot(p, color) {
    const r = this.worldPerPixel(new THREE.Vector3(...p)) * 5;
    const m = new THREE.Mesh(new THREE.SphereGeometry(r, 12, 8), new THREE.MeshBasicMaterial({ color, depthTest: false }));
    m.position.set(...p);
    m.renderOrder = 11;
    return m;
  }

  _fatLine(flat, color, width = 3) {
    const geo = new LineSegmentsGeometry().setPositions(flat);
    const mat = new LineMaterial({ color, linewidth: width, depthTest: false, transparent: true });
    mat.resolution.copy(this.lineRes || new THREE.Vector2(1, 1));
    const l = new LineSegments2(geo, mat);
    l.renderOrder = 11;
    l.raycast = () => {};
    return l;
  }

  // ---------- camera ----------
  sceneBox() {
    const box = new THREE.Box3();
    for (const b of this.bodies.values()) if (b.group.visible) box.union(b.mesh.geometry.boundingBox);
    this.sketchGroup.traverse((o) => { if (o.isLine || o.isMesh) box.expandByObject(o); });
    return box;
  }

  fitAll(animate = true) {
    const box = this.sceneBox();
    if (box.isEmpty()) box.set(new THREE.Vector3(-50, -50, 0), new THREE.Vector3(50, 50, 40));
    const sphere = box.getBoundingSphere(new THREE.Sphere());
    const dir = this.camera.position.clone().sub(this.controls.target).normalize();
    this.flyTo(sphere.center, dir, sphere.radius, animate);
  }

  setView(dir, animate = true) {
    const box = this.sceneBox();
    const sphere = box.isEmpty() ? new THREE.Sphere(new THREE.Vector3(0, 0, 20), 60) : box.getBoundingSphere(new THREE.Sphere());
    const d = new THREE.Vector3(...dir).normalize();
    if (Math.abs(d.z) > 0.9999) d.set(0, -1e-4 * Math.sign(d.z || 1), Math.sign(d.z)).normalize(); // avoid gimbal with Z-up
    this.flyTo(sphere.center, d, sphere.radius, animate);
  }

  flyTo(center, dir, radius, animate = true) {
    radius = Math.max(radius, 5);
    // fit the limiting field of view: vertical, or horizontal in tall narrow viewports
    const aspect = Math.max(0.2, this.el.clientWidth / Math.max(1, this.el.clientHeight));
    const vHalf = (this.persp.fov * Math.PI) / 360, hHalf = Math.atan(Math.tan(vHalf) * aspect);
    const dist = (radius / Math.sin(Math.min(vHalf, hHalf))) * 1.1;
    const toPos = center.clone().add(dir.clone().multiplyScalar(dist));
    const fromPos = this.camera.position.clone(), fromT = this.controls.target.clone();
    const fromH = this.orthoHeight, toH = (radius * 2.4) / Math.min(1, aspect);
    const fromZoom = this.ortho.zoom;
    const t0 = performance.now(), dur = animate ? 380 : 0;
    // interpolate direction on the sphere for nicer arcs
    const fromDir = fromPos.clone().sub(fromT), fromLen = fromDir.length();
    fromDir.normalize();
    const token = (this._flyToken = (this._flyToken || 0) + 1);
    const step = () => {
      if (token !== this._flyToken) return; // superseded by a newer camera move
      const k = dur ? Math.min(1, (performance.now() - t0) / dur) : 1;
      const e = k < 0.5 ? 2 * k * k : 1 - Math.pow(-2 * k + 2, 2) / 2;
      const t = fromT.clone().lerp(center, e);
      const dd = fromDir.clone().lerp(dir, e);
      if (dd.lengthSq() < 1e-6) dd.copy(dir);
      dd.normalize();
      const len = fromLen + (dist - fromLen) * e;
      this.camera.position.copy(t).add(dd.multiplyScalar(len));
      this.controls.target.copy(t);
      if (this.camera.isOrthographicCamera) {
        this.orthoHeight = (fromH || toH) + (toH - (fromH || toH)) * e;
        this.ortho.zoom = fromZoom + (1 - fromZoom) * e;
        this._updateOrthoFrustum();
      }
      this.camera.lookAt(t);
      this.controls.update();
      this.requestRender();
      if (k < 1) requestAnimationFrame(step);
    };
    step();
    this.orthoHeight = this.orthoHeight || toH;
  }

  setProjection(ortho) {
    if (ortho === this.camera.isOrthographicCamera) return;
    const from = this.camera, to = ortho ? this.ortho : this.persp;
    const dist = from.position.distanceTo(this.controls.target);
    if (ortho) {
      this.orthoHeight = 2 * dist * Math.tan((this.persp.fov * Math.PI) / 360);
      this.ortho.zoom = 1;
      this._updateOrthoFrustum();
      to.position.copy(from.position);
    } else {
      const h = this.orthoHeight / this.ortho.zoom;
      const nd = h / (2 * Math.tan((this.persp.fov * Math.PI) / 360));
      const dir = from.position.clone().sub(this.controls.target).normalize();
      to.position.copy(this.controls.target).add(dir.multiplyScalar(nd));
    }
    to.quaternion.copy(from.quaternion);
    to.up.copy(from.up);
    this.camera = to;
    this.controls.object = to;
    this.controls.update();
    this.requestRender();
  }

  // ---------- appearance & workspace APIs ----------
  setTheme(name) {
    this.themeName = name;
    Object.assign(COLORS, THEMES[name]);
    if (this._accent) { const c = new THREE.Color(this._accent); COLORS.select = c.getHex(); COLORS.hover = c.clone().lerp(new THREE.Color(0xffffff), 0.4).getHex(); }
    this.setGridTone(this.gridTone);
    this.cubeMats.forEach((m, i) => { m.map.dispose(); m.map = makeLabelTexture(this.cubeLabels[i], THEMES[name]); m.needsUpdate = true; });
    this.cubeEdges.material.color.set(COLORS.cubeEdge);
    for (const b of this.bodies.values()) b.mats.edge.color.set(COLORS.edge);
    this.cubeHover.material.color.set(COLORS.hover);
    this.refreshHighlights();
    this.requestRender();
  }

  // Grid tone for the viewport backdrop: 'auto' follows the theme, or 'light' | 'dark' | 'blue'.
  setGridTone(tone = 'auto') {
    this.gridTone = tone;
    const t = tone === 'auto' ? THEMES[this.themeName] : tone === 'blue' ? { grid: 0x3d64a0, gridMajor: 0x6f95cf } : THEMES[tone];
    this.gridMat.uniforms.uColor.value.set(t.grid);
    this.gridMat.uniforms.uMajor.value.set(t.gridMajor);
    this.requestRender();
  }

  setPrefs(p) {
    Object.assign(this.prefs, p);
    if (p.nav) this.setNavPreset(p.nav);
    if (p.fov) { this.persp.fov = p.fov; this.persp.updateProjectionMatrix(); }
    if ('edges' in p) this.setDisplayMode(this.displayMode);
    this.updateShadowBounds();
    this.requestRender();
  }

  // Mouse mapping presets. OrbitControls swaps rotate/pan when Shift/Ctrl is held.
  setNavPreset(name) {
    const M = THREE.MOUSE;
    const presets = {
      ruffle: { LEFT: null, MIDDLE: M.PAN, RIGHT: M.ROTATE }, // right orbit, middle pan
      fusion: { LEFT: null, MIDDLE: M.PAN, RIGHT: null }, // Shift+middle orbit
      solidworks: { LEFT: null, MIDDLE: M.ROTATE, RIGHT: null }, // middle orbit, Ctrl+middle pan
      onshape: { LEFT: null, MIDDLE: M.PAN, RIGHT: M.ROTATE },
    };
    this.controls.mouseButtons = presets[name] || presets.ruffle;
    this.navPreset = name;
  }

  setRenderMode(on) {
    this.renderMode = on;
    for (const b of this.bodies.values()) b.edges.visible = !on && this.displayMode !== 'shaded' && this.prefs.edges !== false;
    this.grid.visible = !on || !!this.renderGrid;
    this.updateShadowBounds();
    if (!on) { this.setTurntable(false); this.scene.background = null; this.renderer.setClearAlpha(0); }
    this.requestRender();
  }

  // Environment lighting presets, generated procedurally (no downloads needed).
  setEnvironment(name) {
    if (!this.envs[name]) {
      let scn;
      if (name === 'studio') scn = new RoomEnvironment();
      else {
        scn = new THREE.Scene();
        const top = { soft: 0xf4f6fa, warm: 0xfff1de, cool: 0xe3efff, dark: 0x3a3f47 }[name] || 0xffffff;
        const bottom = { soft: 0x8f98a5, warm: 0x8a6d55, cool: 0x56708f, dark: 0x0c0d10 }[name] || 0x666666;
        const geo = new THREE.SphereGeometry(10, 32, 16);
        const col = [];
        const pos = geo.attributes.position;
        const a = new THREE.Color(top), b = new THREE.Color(bottom), c = new THREE.Color();
        for (let i = 0; i < pos.count; i++) { c.copy(b).lerp(a, (pos.getY(i) / 10 + 1) / 2); col.push(c.r, c.g, c.b); }
        geo.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
        scn.add(new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ vertexColors: true, side: THREE.BackSide })));
        // soft-box lights for reflections
        const lm = new THREE.MeshBasicMaterial({ color: 0xffffff });
        lm.color.multiplyScalar(name === 'dark' ? 6 : 3);
        for (const [x, y, z, w, h] of [[0, 9, 0, 8, 8], [-8, 3, 5, 3, 6], [8, 4, -4, 3, 5]]) {
          const q = new THREE.Mesh(new THREE.PlaneGeometry(w, h), lm);
          q.position.set(x, y, z);
          q.lookAt(0, 0, 0);
          scn.add(q);
        }
      }
      this.envs[name] = this.pmrem.fromScene(scn, 0.04).texture;
    }
    this.envName = name;
    this.scene.environment = this.envs[name];
    if (this.bgMode === 'env') this.scene.background = this.envs[name];
    this.requestRender();
  }

  setBackground(mode, color = '#ffffff') {
    this.bgMode = mode;
    this.scene.background = mode === 'env' ? this.envs[this.envName] : mode === 'solid' ? new THREE.Color(color) : null;
    this.scene.backgroundBlurriness = 0.35;
    this.requestRender();
  }

  setExposure(v) { this.renderer.toneMappingExposure = v; this.requestRender(); }

  setTurntable(on) {
    if (this._tt) cancelAnimationFrame(this._tt);
    this._tt = null;
    if (!on) return;
    let last = performance.now();
    const step = (t) => {
      const dt = (t - last) / 1000;
      last = t;
      const tg = this.controls.target, cam = this.camera;
      const off = cam.position.clone().sub(tg).applyAxisAngle(new THREE.Vector3(0, 0, 1), dt * 0.35);
      cam.position.copy(tg).add(off);
      cam.lookAt(tg);
      this.controls.update();
      this.render();
      this._tt = requestAnimationFrame(step);
    };
    this._tt = requestAnimationFrame(step);
  }

  // Records one full orbit around the model as a frame-exact WebM video (WebCodecs, VP9 or VP8).
  async recordTurntable({ seconds = 6, fps = 30, width = 1920, height = 1080, onProgress } = {}) {
    if (!canEncodeWebM()) throw new Error('Video export needs a browser with WebCodecs: Chrome, Edge, Safari 16.4+ or Firefox 130+');
    width -= width % 2; height -= height % 2; // encoders need even sizes
    const r = this.renderer, pr = r.getPixelRatio();
    const tg = this.controls.target, cam = this.camera;
    const orbit0 = cam.position.clone().sub(tg), start = orbit0.clone();
    const hl = this.overlay.visible;
    this.setTurntable(false);
    this.overlay.visible = false;
    this._noCube = true;
    r.setPixelRatio(1); this.composer.setPixelRatio(1);
    r.setSize(width, height, false); this.composer.setSize(width, height);
    this.persp.aspect = width / height; this.persp.updateProjectionMatrix();
    // keep the whole model in frame for the video's aspect ratio
    const fitR = this.sceneBox().getBoundingSphere(new THREE.Sphere()).radius;
    if (cam === this.persp && fitR > 0) {
      const half = (this.persp.fov * Math.PI) / 360, hHalf = Math.atan(Math.tan(half) * Math.min(1, width / height));
      const need = (fitR * 1.15) / Math.sin(Math.min(half, hHalf));
      if (start.length() < need) start.setLength(need);
    }
    const frames = Math.max(2, Math.round(seconds * fps));
    try {
      return await encodeWebM(r.domElement, {
        frames, fps, width, height, bitrate: Math.round(width * height * fps * 0.12), onProgress,
        drawFrame: (i) => {
          cam.position.copy(tg).add(start.clone().applyAxisAngle(new THREE.Vector3(0, 0, 1), (i / frames) * Math.PI * 2));
          cam.lookAt(tg);
          this.controls.update();
          this.render();
        },
      });
    } finally {
      this._noCube = false;
      this.overlay.visible = hl;
      cam.position.copy(tg).add(orbit0);
      this.controls.update();
      r.setPixelRatio(pr); this.composer.setPixelRatio(pr);
      this.resize();
      this.requestRender();
    }
  }

  // High-resolution still image of the current view (no ViewCube, optional transparent background).
  capture({ scale = 2, transparent = false, width, height } = {}) {
    const r = this.renderer;
    const w = this.el.clientWidth, h = this.el.clientHeight;
    const pr = r.getPixelRatio();
    const bg = this.scene.background;
    if (transparent) this.scene.background = null;
    const hl = this.overlay.visible;
    this.overlay.visible = false;
    r.setPixelRatio(scale);
    this.composer.setPixelRatio(scale);
    if (width && height) { r.setSize(width / scale, height / scale, false); this.composer.setSize(width / scale, height / scale); }
    else { r.setSize(w, h, false); this.composer.setSize(w, h); }
    this._noCube = true;
    this.render();
    const url = r.domElement.toDataURL('image/png');
    this._noCube = false;
    this.overlay.visible = hl;
    this.scene.background = bg;
    r.setPixelRatio(pr);
    this.composer.setPixelRatio(pr);
    this.resize();
    this.render();
    return url;
  }

  // Small JPEG thumbnail of the model for the project dashboard.
  thumbnail(w = 360, h = 225) {
    // frame the whole model from a standard isometric view, then restore the user's camera
    const cam = this.camera, pos = cam.position.clone(), tgt = this.controls.target.clone(), q = cam.quaternion.clone();
    const oh = this.orthoHeight, oz = this.ortho.zoom;
    const box = this.sceneBox();
    if (!box.isEmpty()) {
      const sph = box.getBoundingSphere(new THREE.Sphere());
      const dir = new THREE.Vector3(1, -1.2, 0.9).normalize();
      const dist = (sph.radius / Math.sin((this.persp.fov * Math.PI) / 360)) * 1.05;
      cam.position.copy(sph.center).add(dir.multiplyScalar(dist));
      cam.lookAt(sph.center);
      this.controls.target.copy(sph.center);
    }
    const hl = this.overlay.visible;
    this.overlay.visible = false;
    this._noCube = true;
    this.render();
    this._noCube = false;
    this.overlay.visible = hl;
    const src = this.renderer.domElement;
    const c = document.createElement('canvas');
    c.width = w; c.height = h;
    const g = c.getContext('2d');
    const top = getComputedStyle(document.documentElement).getPropertyValue('--vp-top').trim() || '#2b3038';
    const bot = getComputedStyle(document.documentElement).getPropertyValue('--vp-bottom').trim() || '#16191d';
    const grad = g.createLinearGradient(0, 0, 0, h);
    grad.addColorStop(0, top); grad.addColorStop(1, bot);
    g.fillStyle = grad; g.fillRect(0, 0, w, h);
    const sw = src.width, sh = src.height;
    const k = Math.max(w / sw, h / sh);
    g.drawImage(src, (w - sw * k) / 2, (h - sh * k) / 2, sw * k, sh * k);
    cam.position.copy(pos); cam.quaternion.copy(q); this.controls.target.copy(tgt);
    this.orthoHeight = oh; this.ortho.zoom = oz;
    this.controls.update();
    this.render();
    return c.toDataURL('image/jpeg', 0.82);
  }

  // ---------- events ----------
  _cubeHit(ev) {
    const r = this.renderer.domElement.getBoundingClientRect();
    const cs = this.cubeSize, x = ev.clientX - r.left, y = ev.clientY - r.top;
    const x0 = r.width - cs - 10, y0 = 10;
    if (x < x0 || x > x0 + cs || y < y0 || y > y0 + cs) return null;
    const p = new THREE.Vector2(((x - x0) / cs) * 2 - 1, -((y - y0) / cs) * 2 + 1);
    const rc = new THREE.Raycaster();
    rc.setFromCamera(p, this.cubeCam);
    const h = rc.intersectObject(this.cube, false)[0];
    if (!h) return { miss: true };
    const d = h.point.toArray().map((c) => (Math.abs(c) > 0.3 ? Math.sign(c) : 0));
    return { dir: d };
  }

  _bindEvents() {
    const dom = this.renderer.domElement;
    let down = null;
    dom.addEventListener('contextmenu', (e) => e.preventDefault());
    dom.addEventListener('pointerdown', (e) => {
      down = { x: e.clientX, y: e.clientY, button: e.button, t: performance.now() };
      const ch = this._cubeHit(e);
      if (ch) { this.controls.enabled = false; down.cube = ch; }
      else if (e.button === 0) this.emit('down', e);
    }, true);
    window.addEventListener('pointerup', (e) => {
      if (!down) return;
      const moved = Math.hypot(e.clientX - down.x, e.clientY - down.y) > 4;
      if (down.cube) {
        this.controls.enabled = true;
        if (!moved && down.cube.dir) this.setView(down.cube.dir);
      } else if (!moved && e.target === dom) {
        if (down.button === 0) this.emit('click', e);
        if (down.button === 2) this.emit('rclick', e);
      }
      if (down.button === 0 && !down.cube) this.emit('up', e, moved);
      down = null;
    });
    dom.addEventListener('pointermove', (e) => {
      const ch = this._cubeHit(e);
      if (ch && ch.dir) {
        this.cubeHover.visible = true;
        this.cubeHover.scale.set(ch.dir[0] ? 0.3 : 2.45, ch.dir[1] ? 0.3 : 2.45, ch.dir[2] ? 0.3 : 2.45);
        this.cubeHover.position.set(ch.dir[0] * 0.5, ch.dir[1] * 0.5, ch.dir[2] * 0.5);
        dom.style.cursor = 'pointer';
        this.requestRender();
        return;
      }
      if (this.cubeHover.visible) { this.cubeHover.visible = false; dom.style.cursor = ''; this.requestRender(); }
      if (!down) this.emit('hover', e);
      else if (down.button === 0 && !down.cube) this.emit('ldrag', e, Math.hypot(e.clientX - down.x, e.clientY - down.y));
      else this.emit('drag', e);
    });
    dom.addEventListener('dblclick', (e) => this.emit('dblclick', e));
    dom.addEventListener('pointerleave', () => this.emit('leave'));
  }
}

// Shaded fills for sketch regions (one mesh per region, holes cut out), used for profile picking.
export function buildProfileMeshes(sk) {
  const regions = sk.regions || computeRegions(sk.geom || []);
  const x = new THREE.Vector3(...sk.plane.xDir), n = new THREE.Vector3(...sk.plane.normal);
  const y = new THREE.Vector3().crossVectors(n, x);
  const basis = new THREE.Matrix4().makeBasis(x, y, n).setPosition(...sk.plane.origin);
  return regions.map((r) => {
    const shape = new THREE.Shape(r.poly.map(([u, v]) => new THREE.Vector2(u, v)));
    for (const h of r.holes) shape.holes.push(new THREE.Path(h.poly.map(([u, v]) => new THREE.Vector2(u, v))));
    const geo = new THREE.ShapeGeometry(shape);
    geo.applyMatrix4(basis);
    const m = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ color: COLORS.profile, transparent: true, opacity: 0.18, side: THREE.DoubleSide, depthWrite: false }));
    m.renderOrder = 1;
    return m;
  });
}
