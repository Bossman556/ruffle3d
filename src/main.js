import '@fontsource-variable/inter';
import './style.css';
import * as THREE from 'three';
import { GLTFExporter } from 'three/examples/jsm/exporters/GLTFExporter.js';
import { OBJExporter } from 'three/examples/jsm/exporters/OBJExporter.js';
import { Kernel } from './kernel/client.js';
import { Viewport, buildBodyGeometry, faceAtPoint } from './viewport.js';
import { Sketcher } from './sketcher.js';
import { FEATURES, defaultsFor } from './features.js';
import { evaluate, evaluateLen, evalParams, isValidName, UNITS_TABLE } from './expr.js';
import { STD_PLANES, planeFromPointNormal, yDirOf } from './geom2d.js';
import { emptySketch, migrateSketch } from './sketch/model.js';
import { computeRegions, inRegion } from './sketch/regions.js';
import { DrawingWorkspace } from './drawing.js';
import { icon } from './icons.js';
import { MATERIALS, DEFAULT_MATERIAL, MATERIAL_CATS, FINISHES, APPEARANCES, PALETTE, ACCENTS, CATEGORY_COLORS, bodyLook, makeLook, lookBall } from './materials.js';
import { TEMPLATES, demoDocument, blankDocument } from './demo.js';
import { store, newProjectId, loadPrefs, savePrefs, resolvedTheme } from './store.js';
import { Home } from './home.js';
import { CVEditor } from './cvedit.js';
import { build3MF } from './export3mf.js';
import { parseDXF, dxfPrimitives, primitivesToSketch, writeDXF } from './dxf.js';
import { sampleGeom } from './sketch/model.js';
import { Simulation } from './simulate.js';
import { CanvasManager, canvasList } from './canvas.js';
import { DecalManager, decalList } from './decals.js';
import { CamWorkspace } from './cam.js';
import { requestPersistence, writeToFolder } from './backup.js';
import { faceSigFromMesh, edgeSigFromSegments } from './picksig.js';
import { AssemblyTools } from './assembly.js';

const $ = (s, r = document) => r.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const fmt = (x, d = 2) => (Number.isFinite(x) ? (+x.toFixed(d)).toLocaleString(undefined, { maximumFractionDigits: d }) : '–');
const LEGACY_KEY = 'ruffle3d.autosave.v1';
const LAST_KEY = 'ruffle3d.lastProject';
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

let fidSeq = 0;
const newFid = (type) => `${type.slice(0, 3)}${Date.now().toString(36).slice(-5)}${(fidSeq++).toString(36)}`;

// Upgrades older documents (v1 sketch entities → constraint-based sketches).
function migrateDoc(doc) {
  doc.units ||= 'mm';
  doc.configs ||= [];
  for (const f of doc.features || []) {
    if (f.type === 'sketch' && !f.p.points) {
      const m = migrateSketch(f.p);
      f.p = { plane: f.p.plane, planeRef: f.p.planeRef, points: m.points, curves: m.curves, constraints: m.constraints, dims: m.dims };
    }
  }
  return doc;
}

const toLocal = (plane, P) => {
  const d = [P[0] - plane.origin[0], P[1] - plane.origin[1], P[2] - plane.origin[2]];
  const y = yDirOf(plane);
  return [d[0] * plane.xDir[0] + d[1] * plane.xDir[1] + d[2] * plane.xDir[2], d[0] * y[0] + d[1] * y[1] + d[2] * y[2]];
};

const timeAgo = (t) => {
  const s = (Date.now() - t) / 1000;
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
  return new Date(t).toLocaleDateString();
};

// ---------------------------------------------------------------- command registry
const EXTRA = {
  sketch: { label: 'Sketch', icon: 'sketch', desc: 'Create a sketch on a plane or face', key: 'K' },
  params: { label: 'Parameters', icon: 'params', desc: 'User parameters that drive the design' },
  appearance: { label: 'Appearance', icon: 'appearance', desc: 'Colours, finishes and materials for bodies and faces', key: 'A' },
  material: { label: 'Physical Material', icon: 'props', desc: 'Material that drives mass properties' },
  zebra: { label: 'Zebra', icon: 'zebra', desc: 'Reflection stripes to check surface continuity' },
  draftan: { label: 'Draft Analysis', icon: 'draftan', desc: 'Colour faces by draft angle for moulding' },
  cvcurve: { label: 'CV Curve', icon: 'cvcurve', desc: 'Free-form 3D NURBS curve: click to place control vertices', key: 'V' },
  editcv: { label: 'Edit CVs', icon: 'editcv', desc: 'Drag the control vertices of a CV curve or CV surface' },
  rebuildcv: { label: 'Rebuild as CV', icon: 'rebuildcv', desc: 'Turn any face into an editable CV surface' },
  isophote: { label: 'Isophotes', icon: 'isophote', desc: 'Highlight lines of constant light angle to judge surface flow' },
  importdxf: { label: 'Import DXF', icon: 'dxfin', desc: 'Bring a 2D DXF drawing into a new sketch' },
  exportdxf: { label: 'Export DXF', icon: 'dxfout', desc: 'Export a flat face or a sketch as DXF for laser cutting or CNC' },
  decal: { label: 'Decal', icon: 'decal', desc: 'Put a logo, label or graphic on a face for renders' },
  canvas: { label: 'Canvas', icon: 'canvas', desc: 'Reference image on a plane: photos, sketches or blueprints to model over' },
  configs: { label: 'Configurations', icon: 'configs', desc: 'Design variants: named sets of parameter values' },
  flatpattern: { label: 'Flat Pattern', icon: 'flatpattern', desc: 'Unfold a sheet metal part: bend table, size and DXF for cutting' },
  thickness: { label: 'Wall Thickness', icon: 'thickness', desc: 'Colour the model by wall thickness and find walls thinner than a minimum' },
  printcheck: { label: '3D Print Check', icon: 'printcheck', desc: 'Overhangs, build-volume fit, watertightness and filament estimate' },
  bom: { label: 'Bill of Materials', icon: 'bom', desc: 'Mass, volume and material of every body, exportable as CSV' },
  curvmap: { label: 'Curvature Map', icon: 'curvmap', desc: 'Colour surfaces by mean, Gaussian or maximum curvature' },
  comb: { label: 'Curvature Comb', icon: 'comb', desc: 'Curvature combs on edges to judge curve fairness' },
  measure: { label: 'Measure', icon: 'measure', desc: 'Distances, angles, lengths, areas', key: 'I' },
  section: { label: 'Section', icon: 'section', desc: 'Section analysis through the model' },
  props: { label: 'Properties', icon: 'props', desc: 'Mass, volume and bounding box' },
  import: { label: 'Import', icon: 'import', desc: 'Import STEP or STL geometry' },
  'plane:offset': { label: 'Offset Plane', icon: 'plane2', desc: 'Construction plane at a distance' },
  'plane:angle': { label: 'Plane at Angle', icon: 'planeAngle', desc: 'Construction plane rotated about an axis' },
  'plane:mid': { label: 'Midplane', icon: 'planeMid', desc: 'Construction plane between two parallel planes' },
  interference: { label: 'Interference', icon: 'interference', desc: 'Find overlapping bodies' },
  component: { label: 'Component', icon: 'component', desc: 'Place another project in this design as a part of an assembly' },
  mate: { label: 'Mate', icon: 'mate', desc: 'Fit components together: mate, flush, concentric, distance, angle' },
  assembly: { label: 'Assembly', icon: 'component', desc: 'Components, mates and degrees of freedom' },
  animate: { label: 'Animate', icon: 'animate', desc: 'Animate joint motion' },
  explode: { label: 'Explode', icon: 'explode', desc: 'Exploded view: spread the bodies apart for renders and videos' },
  drawing: { label: 'Drawing', icon: 'drawing', desc: 'Create a 2D engineering drawing' },
};
const DESC = {
  extrude: 'Push a sketch profile into a solid', revolve: 'Spin a profile around an axis', sweep: 'Move a profile along a path',
  loft: 'Blend between two profiles', hole: 'Simple, counterbored or countersunk holes', presspull: 'Push or pull planar faces',
  fillet: 'Round edges', chamfer: 'Bevel edges', shell: 'Hollow a body', combine: 'Join, cut or intersect bodies',
  draft: 'Taper faces for moulding', split: 'Split a body with a plane', move: 'Move, rotate or copy bodies', scale: 'Scale bodies',
  remove: 'Remove bodies', joint: 'Position parts with motion', mirror: 'Mirror bodies across a plane',
  rpattern: 'Rectangular pattern of bodies', cpattern: 'Circular pattern of bodies', box: 'Box primitive', cylinder: 'Cylinder primitive',
  sphere: 'Sphere primitive', torus: 'Torus primitive', cone: 'Cone primitive',
  surfextrude: 'Sweep curves straight into a surface', surfrevolve: 'Spin curves around an axis into a surface',
  surfloft: 'Skin a surface through section curves', surfsweep: 'Sweep a profile curve along a rail',
  patch: 'Fill a closed boundary with a smooth NURBS patch', surfoffset: 'Offset faces into a new surface',
  thicken: 'Give a surface thickness to make a solid', stitch: 'Sew surfaces together; closed sets become solids',
  cvsurface: 'NURBS surface with directly editable control vertices', surffillet: 'Rolling-ball blend between two surfaces, trimmed and sewn',
  surftrim: 'Cut a surface with a curve projected onto it',
  thread: 'Modelled ISO metric thread on a shaft or in a hole', coil: 'Helical coil spring',
  text: 'Raised or engraved text on a plane or a flat face',
  sheetbase: 'Flat sheet metal plate from a sketch profile, with thickness, bend radius and K-factor', flange: 'Bend a flange up or down from a straight edge of a sheet metal plate',
};
const cmdInfo = (c) => ({ ...(FEATURES[c] || {}), desc: DESC[c], ...(EXTRA[c] || {}) });
const SHORT = { sheetbase: 'Base', flatpattern: 'Flat', printcheck: 'Print', importdxf: 'DXF', exportdxf: 'DXF out', configs: 'Configs', cvcurve: 'CV Curve', editcv: 'Edit CVs', cvsurface: 'CV Surface', rebuildcv: 'Rebuild', surffillet: 'Fillet', surftrim: 'Trim', appearance: 'Paint', draftan: 'Draft', surfextrude: 'Extrude', surfrevolve: 'Revolve', surfloft: 'Skin', surfsweep: 'Rail', patch: 'Patch', surfoffset: 'Offset', curvmap: 'Curvature', comb: 'Comb', presspull: 'Press Pull', rpattern: 'Pattern', cpattern: 'Circular', 'plane:offset': 'Plane', interference: 'Interfere', cylinder: 'Cylinder' };
const DESIGN_GROUPS = [
  { name: 'Create', color: 'create', items: ['sketch', 'extrude', 'revolve', 'sweep', 'loft', 'hole'], more: ['text', 'thread', 'coil', '-', 'box', 'cylinder', 'sphere', 'torus', 'cone', '-', 'rpattern', 'cpattern', 'mirror'] },
  { name: 'Modify', color: 'modify', items: ['presspull', 'fillet', 'chamfer', 'shell', 'combine', 'appearance'], more: ['draft', 'split', 'move', 'scale', 'remove', '-', 'material', 'params'] },
  { name: 'Sheet Metal', color: 'sheet', items: ['sheetbase', 'flange', 'flatpattern'], more: [] },
  { name: 'Assemble', color: 'assemble', items: ['component', 'mate', 'joint', 'explode'], more: ['assembly', 'animate'] },
  { name: 'Construct', color: 'construct', items: ['plane:offset'], more: ['plane:angle', 'plane:mid'] },
  { name: 'Inspect', color: 'inspect', items: ['measure', 'section', 'interference', 'zebra'], more: ['draftan', 'isophote', 'curvmap', 'printcheck', 'thickness', '-', 'bom', 'props'] },
  { name: 'Insert', color: 'insert', items: ['import', 'importdxf', 'canvas'], more: ['decal', 'exportdxf', '-', 'configs'] },
];
const SURFACE_GROUPS = [
  { name: 'Curves', color: 'curve', items: ['sketch', 'cvcurve', 'editcv'], more: ['plane:offset', 'plane:angle'] },
  { name: 'Create', color: 'surface', items: ['cvsurface', 'surfextrude', 'surfrevolve', 'surfsweep', 'surfloft', 'patch'], more: ['surfoffset', 'rebuildcv'] },
  { name: 'Modify', color: 'modify', items: ['surftrim', 'surffillet', 'thicken', 'stitch'], more: ['split', 'move', 'scale', 'remove', '-', 'appearance'] },
  { name: 'Evaluate', color: 'inspect', items: ['curvmap', 'comb', 'zebra', 'isophote'], more: ['draftan', 'measure', 'section'] },
];
const ALL_CMDS = ['sketch', 'extrude', 'revolve', 'sweep', 'loft', 'hole', 'box', 'cylinder', 'sphere', 'torus', 'cone', 'rpattern', 'cpattern', 'mirror',
  'presspull', 'fillet', 'chamfer', 'shell', 'draft', 'combine', 'split', 'move', 'scale', 'remove', 'joint', 'animate', 'interference',
  'plane:offset', 'plane:angle', 'plane:mid', 'measure', 'section', 'zebra', 'draftan', 'curvmap', 'comb',
  'surfextrude', 'surfrevolve', 'surfloft', 'surfsweep', 'patch', 'surfoffset', 'thicken', 'stitch',
  'cvcurve', 'editcv', 'cvsurface', 'rebuildcv', 'surffillet', 'surftrim', 'thread', 'coil', 'isophote', 'bom', 'importdxf', 'exportdxf', 'configs', 'canvas', 'decal', 'explode', 'thickness', 'text', 'sheetbase', 'flange', 'flatpattern', 'printcheck', 'props', 'params', 'appearance', 'material', 'import', 'drawing'];
const ENVS = [['studio', 'Studio', 'linear-gradient(160deg,#cfd6df,#6e7784)'], ['soft', 'Soft', 'linear-gradient(160deg,#f4f6fa,#8f98a5)'], ['warm', 'Warm', 'linear-gradient(160deg,#fff1de,#8a6d55)'], ['cool', 'Cool', 'linear-gradient(160deg,#e3efff,#56708f)'], ['dark', 'Night', 'linear-gradient(160deg,#3a3f47,#0c0d10)']];

const PRINT_UP = { Z: [0, 0, 1], Y: [0, 1, 0], X: [1, 0, 0], '-Z': [0, 0, -1] };
const PRINTERS = {
  180: { name: 'Compact · 180 × 180 × 180 mm', size: [180, 180, 180] },
  220: { name: 'Standard · 220 × 220 × 250 mm', size: [220, 220, 250] },
  256: { name: 'Large · 256 × 256 × 256 mm', size: [256, 256, 256] },
  350: { name: 'Extra large · 350 × 350 × 350 mm', size: [350, 350, 350] },
};
const PRINT_MATERIALS = { pla: { name: 'PLA · 1.24 g/cm³', density: 1.24 }, petg: { name: 'PETG · 1.27 g/cm³', density: 1.27 }, abs: { name: 'ABS · 1.04 g/cm³', density: 1.04 }, tpu: { name: 'TPU · 1.21 g/cm³', density: 1.21 } };

// ============================================================================
class App {
  constructor() {
    this.prefs = loadPrefs();
    try { this.designTab = localStorage.getItem('ruffle3d.designTab') || 'solid'; } catch { this.designTab = 'solid'; }
    this.applyTheme(false);
    this.kernel = new Kernel();
    this.vp = new Viewport($('#viewport'), this.prefs);
    this.applyTheme(false);
    this.sketcher = new Sketcher(this.vp, {
      toolbar: $('#toolbar'), inspector: $('#right'), hud: $('#hud'), vars: () => this.vars, units: () => this.units,
      toast: (m) => this.toast(m, 'info'), pickEdge: (ev) => this.pickEdgePolyline(ev),
      onExit: () => { this.renderToolbar(); this.renderRight(); },
    });
    this.cvEdit = new CVEditor(this);
    this.sim = new Simulation(this);
    requestPersistence();
    this.canvases = new CanvasManager(this);
    this.decals = new DecalManager(this);
    this.camws = new CamWorkspace(this);
    this.asm = new AssemblyTools(this);
    this.interGroup = new THREE.Group();
    this.measureGroup = new THREE.Group();
    this.vp.scene.add(this.interGroup, this.measureGroup);
    this.undoStack = [];
    this.redoStack = [];
    this.geoCache = new Map();
    this.buildSeq = 0;
    this.selection = [];
    this.cmd = null;
    this.mode = null;
    this.ws = 'design';
    this.leftTab = 'model';
    this.result = { bodies: [], sketches: [], errors: {}, planes: [], joints: [], curves: [], cvgrids: [] };
    this.doc = migrateDoc(blankDocument());
    this.propsCache = new Map();
    this.drawing = new DrawingWorkspace(this);
    this.home = new Home(this);
    this.booting = true;

    this.buildAppbar();
    this.buildNav();
    this.buildStatusbar();
    this.bindTips();
    this.bindGlobal();
    this.bindViewport();
    this.renderToolbar();
    this.refreshAll();
    this.renderRight();
    this.startup();
  }

  async startup() {
    // migrate the single autosave from earlier versions into the project store
    try {
      const legacy = localStorage.getItem(LEGACY_KEY);
      if (legacy && !(await store.listProjects()).length) {
        const doc = migrateDoc(JSON.parse(legacy));
        await store.saveProject({ id: newProjectId(), name: doc.name, doc });
      }
      localStorage.removeItem(LEGACY_KEY);
    } catch { /* storage unavailable */ }
    let last = null;
    try { last = localStorage.getItem(LAST_KEY); } catch { /* ignore */ }
    const p = last ? await store.getProject(last).catch(() => null) : null;
    if (p) await this.openProject(p.id);
    else this.home.open();
  }

  // ---------------------------------------------------------------- units & params
  get units() { return UNITS_TABLE[this.doc.units] || UNITS_TABLE.mm; }
  get vars() { return evalParams(this.effectiveParams(), this.units.scale).vars; }
  activeConfig() { return (this.doc.configs || []).find((c) => c.id === this.doc.activeConfig) || null; }
  effectiveParams(config = this.activeConfig()) {
    if (!config) return this.doc.params;
    return this.doc.params.map((p) => (config.values?.[p.name] != null && config.values[p.name] !== '' ? { ...p, expr: config.values[p.name] } : p));
  }
  len(mm, d = 3) { return `${fmt(mm / this.units.scale, d)} ${this.units.label}`; }
  area(mm2) { return `${fmt(mm2 / this.units.scale ** 2, 2)} ${this.units.label}²`; }
  vol(mm3) { return this.doc.units === 'mm' ? `${fmt(mm3 / 1000, 3)} cm³` : `${fmt(mm3 / this.units.scale ** 3, 3)} ${this.units.label}³`; }

  resolve(features, depth = 0) {
    const vars = this.vars, sc = this.units.scale;
    return features.map((f) => {
      if (f.type === 'component') return this.resolveComponent(f, depth);
      const def = FEATURES[f.type];
      const p = { ...f.p };
      let resolveError = null;
      for (const fld of def.fields) {
        if (fld.type === 'number' || fld.type === 'int') {
          const src = p[fld.key] ?? fld.default ?? 0;
          try { p[fld.key] = fld.unit === 'mm' ? evaluateLen(src, vars, sc) : evaluate(src, vars); } catch (e) { resolveError = `${fld.label}: ${e.message}`; p[fld.key] = 0; }
        }
      }
      if (f.type === 'sketch') {
        p.dims = (p.dims || []).map((d) => {
          try { return { ...d, value: d.type === 'angle' ? evaluate(d.expr, vars) : evaluateLen(d.expr, vars, sc) }; } catch (e) { resolveError = `Dimension "${d.expr}": ${e.message}`; return { ...d, value: NaN }; }
        });
      }
      const out = { id: f.id, type: f.type, p, suppressed: !!f.suppressed };
      if (resolveError) out.resolveError = resolveError;
      return out;
    });
  }

  // a component carries a copy of its source project: resolve that project's own parameters and units
  resolveComponent(f, depth) {
    const def = FEATURES.component, sc = this.units.scale, vars = this.vars;
    const p = { name: f.name, grounded: !!f.p.grounded, features: [] };
    let resolveError = null;
    for (const fld of def.fields) if (fld.type === 'number') { try { p[fld.key] = fld.unit === 'mm' ? evaluateLen(f.p[fld.key] ?? '0', vars, sc) : evaluate(f.p[fld.key] ?? '0', vars); } catch (e) { resolveError = `${fld.label}: ${e.message}`; p[fld.key] = 0; } }
    const sub = f.p.doc;
    if (!sub) resolveError = 'The component has no stored part';
    else if (depth > 4) resolveError = 'Components are nested too deeply';
    else {
      const keep = this.doc;
      try { this.doc = migrateDoc(structuredClone(sub)); p.features = this.resolve(this.doc.features.slice(0, this.doc.marker ?? this.doc.features.length), depth + 1); } finally { this.doc = keep; }
    }
    const out = { id: f.id, type: f.type, p, suppressed: !!f.suppressed };
    if (resolveError) out.resolveError = resolveError;
    return out;
  }

  // ---------------------------------------------------------------- history
  snapshot() {
    this.undoStack.push(JSON.stringify(this.doc));
    if (this.undoStack.length > 100) this.undoStack.shift();
    this.redoStack = [];
  }
  undo() {
    if (this.cmd || this.sketcher.active) return;
    const s = this.undoStack.pop();
    if (!s) return this.toast('Nothing to undo');
    this.redoStack.push(JSON.stringify(this.doc));
    this.doc = JSON.parse(s);
    this.changed();
  }
  redo() {
    if (this.cmd || this.sketcher.active) return;
    const s = this.redoStack.pop();
    if (!s) return this.toast('Nothing to redo');
    this.undoStack.push(JSON.stringify(this.doc));
    this.doc = JSON.parse(s);
    this.changed();
  }
  changed() {
    this.refreshAll();
    this.scheduleSave();
    return this.rebuild();
  }

  // ---------------------------------------------------------------- projects
  async openProject(id) {
    const p = await store.getProject(id);
    if (!p) return this.toast('Project not found', 'warn');
    this.projectId = id;
    try { localStorage.setItem(LAST_KEY, id); } catch { /* ignore */ }
    this.home.close();
    this.loadDoc(p.doc, { fresh: true });
  }

  async createProject(doc) {
    const id = newProjectId();
    doc = migrateDoc(structuredClone(doc));
    await store.saveProject({ id, name: doc.name, doc });
    await this.openProject(id);
  }

  scheduleSave(immediate = false) {
    if (!this.projectId || !this.prefs.autosave) { this.saveState('local'); return; }
    clearTimeout(this._saveT);
    this.saveState('saving');
    this._saveT = setTimeout(() => this.saveNow(), immediate ? 0 : 900);
  }

  async saveNow() {
    if (!this.projectId) return;
    let thumb;
    try { thumb = this.result.bodies.length ? this.vp.thumbnail() : undefined; } catch { /* ignore */ }
    const prev = await store.getProject(this.projectId);
    await store.saveProject({ id: this.projectId, name: this.doc.name, doc: this.doc, thumb: thumb || prev?.thumb });
    writeToFolder(this.projectId, this.doc);
    this.saveState('saved');
  }

  saveState(s) {
    const el = $('#savestate');
    if (!el) return;
    el.className = `savestate ${s}`;
    el.innerHTML = s === 'saving' ? `${icon('spinner')}Saving…` : s === 'saved' ? `${icon('saved')}Saved` : `${icon('cloud')}Not saved`;
  }

  // ---------------------------------------------------------------- version compare
  async startCompare(v) {
    if (!v) return;
    if (this.ws !== 'design') this.setWorkspace('design');
    this.exitMode();
    this.mode = 'compare';
    this.cmp = { label: v.label, time: v.time, busy: true, show: { added: true, removed: true } };
    this.banner(`Comparing with “${esc(v.label)}”: green was added since then, red was removed`, () => this.exitMode());
    this.renderRight();
    // resolve the version's features with its own parameters and units
    const cur = this.doc;
    let feats;
    try { this.doc = migrateDoc(structuredClone(v.doc)); feats = this.resolve(this.doc.features.slice(0, this.doc.marker)); } finally { this.doc = cur; }
    try {
      const { result } = await this.kernel.compare(feats);
      if (this.mode !== 'compare' || !this.cmp) return;
      this.cmp.result = result;
      this.cmp.busy = false;
      this.vp.setCompare(result, this.cmp.show);
    } catch (e) { this.toast(`Could not compare: ${e.message}`, 'warn'); return this.exitMode(); }
    this.renderRight();
  }

  renderComparePanel() {
    const el = $('#right'), c = this.cmp || {}, r = c.result || [];
    const vol = (v) => this.vol(v);
    const name = (id) => this.bodyMeta(id).name;
    const totalOld = r.reduce((s, x) => s + x.volOld, 0), totalNew = r.reduce((s, x) => s + x.volNew, 0);
    el.innerHTML = `<div class="panel-head">${icon('compare')}<h3>Compare versions<small>Now vs “${esc(c.label)}”</small></h3><button class="iconbtn" data-x>${icon('close')}</button></div>
      <div class="panel-body"><div class="insp"><div class="insp-sec">
        ${c.busy ? `<div class="savestate saving">${icon('spinner')}Rebuilding the saved version…</div>` : `
        <div class="field check"><label><span class="swatch" style="background:#3ecf8e"></span> Added since then</label><label class="switch"><input type="checkbox" data-a ${c.show.added ? 'checked' : ''}><span></span></label></div>
        <div class="field check"><label><span class="swatch" style="background:#f0525b"></span> Removed since then</label><label class="switch"><input type="checkbox" data-r ${c.show.removed ? 'checked' : ''}><span></span></label></div>
        <dl class="kv" style="margin-top:10px"><dt>Total volume then</dt><dd>${vol(totalOld)}</dd><dt>Total volume now</dt><dd>${vol(totalNew)}</dd><dt>Change</dt><dd class="${totalNew >= totalOld ? 'ok' : 'warn'}">${totalOld ? `${totalNew >= totalOld ? '+' : ''}${fmt(((totalNew - totalOld) / totalOld) * 100, 1)}%` : '–'}</dd></dl>`}
      </div>
      ${r.length ? `<div class="insp-sec"><h4>Bodies</h4>${r.map((x) => `<div class="cmp-row"><b>${esc(name(x.id))}</b><small>${x.status === 'new' ? 'New body' : x.status === 'deleted' ? 'Deleted' : !x.added && !x.removed ? 'Unchanged' : `${x.added ? `+${vol(x.added.volume)}` : ''}${x.added && x.removed ? ' · ' : ''}${x.removed ? `−${vol(x.removed.volume)}` : ''}`}</small></div>`).join('')}</div>` : ''}
      <div class="insp-sec"><div class="help">Restore the version from the Versions tab if you want it back. Comparing doesn't change anything.</div></div>
      </div></div>
      <div class="panel-foot"><span class="spacer"></span><button class="btn primary" data-x>Done</button></div>`;
    el.querySelectorAll('[data-x]').forEach((b) => (b.onclick = () => this.exitMode()));
    el.querySelector('[data-a]')?.addEventListener('change', (e) => { c.show.added = e.target.checked; this.vp.setCompare(c.result, c.show); });
    el.querySelector('[data-r]')?.addEventListener('change', (e) => { c.show.removed = e.target.checked; this.vp.setCompare(c.result, c.show); });
  }

  // ---------------------------------------------------------------- wall thickness
  startThickness() {
    const bodies = this.result.bodies.filter((b) => !b.surface && this.bodyMeta(b.id).visible !== false);
    if (!bodies.length) return this.toast('There are no visible solid bodies to check', 'warn');
    this.mode = 'thickness';
    this.thick = { min: this.doc.minWall ?? 1.5, busy: true, p: 0, res: null };
    this.banner('Wall thickness: red walls are thinner than the minimum', () => this.exitMode());
    this.renderRight();
    const msg = { bodies: bodies.map((b) => {
      const geo = this.vp.bodies.get(b.id).data.geo.geo;
      geo.computeBoundingBox();
      const diag = geo.boundingBox.min.distanceTo(geo.boundingBox.max);
      return { id: b.id, positions: geo.attributes.position.array.slice(), normals: geo.attributes.normal.array.slice(), index: geo.index.array.slice(), faceGroups: geo.userData.faceGroups, target: diag / 120 };
    }) };
    const w = (this.thick.worker = new Worker(new URL('./thickness.worker.js', import.meta.url), { type: 'module' }));
    w.onmessage = ({ data }) => {
      const t = this.thick;
      if (!t || this.mode !== 'thickness') return;
      if (data.type === 'progress') { t.p = data.p; const el = $('#sim-progress'); if (el) el.querySelector('i').style.width = `${Math.round(t.p * 100)}%`; return; }
      w.terminate();
      t.busy = false;
      if (data.type === 'error') { this.toast(data.error, 'warn'); return this.exitMode(); }
      t.res = data.bodies;
      this.showThickness();
    };
    w.postMessage(msg, msg.bodies.flatMap((b) => [b.positions.buffer, b.normals.buffer, b.index.buffer]));
  }

  showThickness() {
    const t = this.thick;
    if (!t?.res) return;
    // statistics over triangles: thinnest wall and the area under the minimum
    let thinnest = Infinity, area = 0, thinArea = 0;
    const fin = [];
    for (const b of t.res) {
      const P = b.mesh.positions, I = b.mesh.index, V = b.values;
      for (let k = 0; k < V.length; k++) if (Number.isFinite(V[k])) { thinnest = Math.min(thinnest, V[k]); fin.push(V[k]); }
      for (let q = 0; q < I.length; q += 3) {
        const [a, c, d] = [I[q] * 3, I[q + 1] * 3, I[q + 2] * 3];
        const ux = P[c] - P[a], uy = P[c + 1] - P[a + 1], uz = P[c + 2] - P[a + 2], vx = P[d] - P[a], vy = P[d + 1] - P[a + 1], vz = P[d + 2] - P[a + 2];
        const A = Math.hypot(uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx) / 2;
        const th = Math.min(V[I[q]], V[I[q + 1]], V[I[q + 2]]);
        area += A;
        if (th < t.min) thinArea += A;
      }
    }
    fin.sort((x, y) => x - y);
    t.stats = { thinnest, thinShare: area ? thinArea / area : 0, typical: fin[Math.floor(fin.length * 0.5)] || 0 };
    const max = Math.max(t.min * 2, Math.min(fin[Math.floor(fin.length * 0.9)] || t.min * 4, t.min * 4));
    t.max = max;
    const bodies = {};
    for (const b of t.res) bodies[b.id] = { values: Float32Array.from(b.values, (v) => (Number.isFinite(v) ? v : max)), mesh: b.mesh };
    this.vp.setField({ bodies, min: t.min, max, invert: true }); // anything under the minimum is solid red
    this.renderRight();
  }

  renderThicknessPanel() {
    const el = $('#right'), t = this.thick || {}, u = this.units, s = t.stats;
    el.innerHTML = `<div class="panel-head">${icon('thickness')}<h3>Wall thickness<small>Moulding and 3D-printing check</small></h3><button class="iconbtn" data-x>${icon('close')}</button></div>
      <div class="panel-body"><div class="insp"><div class="insp-sec">
        <div class="field"><label>Minimum wall</label><div class="num"><input data-min type="number" step="0.1" min="0.1" value="${+((t.min ?? 1.5) / u.scale).toFixed(3)}"><span class="unit">${u.label}</span></div></div>
        <div class="help">Typical minimums: injection-moulded plastic 1–1.5 mm, FDM printing 0.8–1.2 mm, die-cast aluminium 1.5–2 mm, CNC-machined aluminium 0.8 mm.</div>
        ${t.busy ? `<div class="sim-progress" id="sim-progress"><i style="width:${Math.round((t.p || 0) * 100)}%"></i><span>Measuring walls…</span></div>` : ''}
        ${s ? `<div class="sim-bar inv" style="margin-top:12px"></div><div class="curv-labels"><span>≤ ${fmt(t.min / u.scale, 2)} ${u.label}</span><span>${fmt((t.min + t.max) / 2 / u.scale, 2)}</span><span>≥ ${fmt(t.max / u.scale, 2)}</span></div>
        <dl class="kv" style="margin-top:12px"><dt>Thinnest wall</dt><dd class="${s.thinnest < t.min ? 'bad' : 'ok'}">${fmt(s.thinnest / u.scale, 2)} ${u.label}</dd><dt>Typical wall</dt><dd>${fmt(s.typical / u.scale, 2)} ${u.label}</dd><dt>Area under the minimum</dt><dd class="${s.thinShare > 0 ? 'warn' : 'ok'}">${fmt(s.thinShare * 100, 1)}%</dd></dl>
        <div class="help">Thickness is measured straight into the material from each point of the surface, to the opposite side. Red areas are thinner than the minimum; blue areas are thick. Thick sections can sink or warp when moulded, so look at both ends of the scale.</div>` : ''}
      </div></div></div>
      <div class="panel-foot"><span class="spacer"></span><button class="btn primary" data-x>Done</button></div>`;
    el.querySelectorAll('[data-x]').forEach((b) => (b.onclick = () => this.exitMode()));
    el.querySelector('[data-min]').onchange = (e) => { const v = +e.target.value * u.scale; if (v > 0 && this.thick) { this.thick.min = v; this.doc.minWall = v; this.scheduleSave(); this.showThickness(); } };
  }

  // ---------------------------------------------------------------- exploded view
  get explode() { return (this.doc.explode ||= { amount: 0.5, mode: 'radial', render: false }); }

  // Display offsets that move each visible body away from the assembly centre (or along an axis),
  // in proportion to how far its centre already is from it.
  explodeOffsets() {
    const e = this.explode, items = [];
    for (const [id, b] of this.vp.bodies) {
      if (!b.group.visible) continue;
      const bb = b.data.geo.geo.boundingBox;
      if (!bb) continue;
      items.push([id, bb.getCenter(new THREE.Vector3()), bb]);
    }
    const map = new Map();
    if (items.length < 2 || !(e.amount > 0)) return map;
    const all = new THREE.Box3();
    for (const [, , bb] of items) all.union(bb);
    const C = all.getCenter(new THREE.Vector3()), D = all.getSize(new THREE.Vector3()).length();
    const axis = { x: new THREE.Vector3(1, 0, 0), y: new THREE.Vector3(0, 1, 0), z: new THREE.Vector3(0, 0, 1) }[e.mode];
    if (axis) {
      // the largest part stays put; the others stack away from it along the axis in the order they sit,
      // so parts inside a housing lift out of it rather than dropping through it
      const vol = (bb) => { const s = bb.getSize(new THREE.Vector3()); return s.x * s.y * s.z; };
      const base = items.reduce((a, b) => (vol(b[2]) > vol(a[2]) ? b : a));
      const others = items.filter((it) => it !== base).sort((a, b) => a[1].dot(axis) - b[1].dot(axis));
      const span = all.getSize(new THREE.Vector3()).dot(axis) || D;
      others.forEach(([id], k) => map.set(id, axis.clone().multiplyScalar(e.amount * (k + 1) * Math.max(span, D * 0.25) * 0.9).toArray()));
      return map;
    }
    const dists = items.map(([, c]) => c.distanceTo(C));
    const maxD = Math.max(...dists.map(Math.abs)) || 1;
    items.forEach(([id, c], i) => {
      let dir;
      {
        dir = c.clone().sub(C);
        const l = dir.length();
        // bodies at the centre move up so nothing stays hidden inside
        dir = l < D * 1e-3 ? new THREE.Vector3(0, 0, 1) : dir.multiplyScalar(1 / maxD);
      }
      map.set(id, dir.multiplyScalar(e.amount * D * 0.8).toArray());
    });
    return map;
  }

  applyExplode() {
    const on = this.mode === 'explode' || (this.ws === 'render' && this.explode.render);
    this.vp.setExplode(on ? this.explodeOffsets() : null);
  }

  startExplode() {
    if (this.result.bodies.length < 2) return this.toast('An exploded view needs at least two bodies', 'warn');
    this.mode = 'explode';
    this.selection = [];
    this.updateHighlights();
    this.applyExplode();
    this.banner('Exploded view: use the slider to spread the parts apart', () => this.exitMode());
    this.renderRight();
  }

  renderExplodePanel() {
    const el = $('#right'), e = this.explode;
    el.innerHTML = `<div class="panel-head">${icon('explode')}<h3>Exploded view<small>For renders and videos</small></h3><button class="iconbtn" data-x>${icon('close')}</button></div>
      <div class="panel-body"><div class="insp"><div class="insp-sec">
        <div class="field"><label>Distance<span class="val" data-v>${Math.round(e.amount * 100)}%</span></label><input type="range" min="0" max="1.5" step="0.01" value="${e.amount}" data-amt></div>
        <div class="field"><label>Direction</label><div class="seg" data-dir>${[['radial', 'Radial'], ['x', 'X'], ['y', 'Y'], ['z', 'Z']].map(([v, l]) => `<button data-v="${v}" class="${e.mode === v ? 'on' : ''}">${l}</button>`).join('')}</div></div>
        <div class="field check"><label>Use in the Render workspace</label><label class="switch"><input type="checkbox" data-r ${e.render ? 'checked' : ''}><span></span></label></div>
        <div class="help">Parts move away from the centre of the assembly, or along one axis, in proportion to where they already sit. The model itself doesn't change. Turn on <b>Use in the Render workspace</b> to capture images and turntable videos of the exploded assembly.</div>
      </div></div></div>
      <div class="panel-foot"><span class="spacer"></span><button class="btn primary" data-x>Done</button></div>`;
    el.querySelectorAll('[data-x]').forEach((b) => (b.onclick = () => this.exitMode()));
    el.querySelector('[data-amt]').addEventListener('input', (ev) => { e.amount = +ev.target.value; el.querySelector('[data-v]').textContent = `${Math.round(e.amount * 100)}%`; this.applyExplode(); });
    el.querySelector('[data-amt]').addEventListener('change', () => this.scheduleSave());
    el.querySelectorAll('[data-dir] button').forEach((b) => (b.onclick = () => { e.mode = b.dataset.v; this.applyExplode(); this.scheduleSave(); this.renderRight(); }));
    el.querySelector('[data-r]').onchange = (ev) => { e.render = ev.target.checked; this.scheduleSave(); };
  }

  // ---------------------------------------------------------------- fonts for the Text feature
  // Font files live in the document (base64) so a project opens anywhere; each is sent to the
  // kernel once per session.
  async ensureFonts() {
    this._fontsSent ||= new Set();
    for (const [id, f] of Object.entries(this.doc.fonts || {})) {
      if (this._fontsSent.has(id)) continue;
      const bin = atob(f.data), buf = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) buf[i] = bin.charCodeAt(i);
      try { await this.kernel.font(id, buf.buffer); this._fontsSent.add(id); } catch (e) { this.toast(`Could not load the font ${f.name}: ${e.message}`, 'warn'); }
    }
  }

  loadFontFile(done) {
    const inp = document.createElement('input');
    inp.type = 'file';
    inp.accept = '.ttf,.otf,.woff';
    inp.onchange = async () => {
      const file = inp.files[0];
      if (!file) return;
      if (file.size > 8e6) return this.toast('That font file is larger than 8 MB', 'warn');
      const bytes = new Uint8Array(await file.arrayBuffer());
      let bin = '';
      for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
      const id = `font${Date.now().toString(36)}`;
      this.doc.fonts = { ...(this.doc.fonts || {}), [id]: { name: file.name.replace(/\.(ttf|otf|woff)$/i, ''), data: btoa(bin) } };
      try { await this.kernel.font(id, bytes.buffer.slice(0)); (this._fontsSent ||= new Set()).add(id); } catch (e) { delete this.doc.fonts[id]; return this.toast(`${file.name} could not be read as a font: ${e.message}`, 'warn'); }
      this.scheduleSave();
      this.toast(`Added the font ${file.name}. It is saved in this project.`, 'ok');
      done(id);
    };
    inp.click();
  }

  // ---------------------------------------------------------------- build & display
  async rebuild({ features, baseIndex = null, forPreview = false } = {}) {
    const feats = features || this.doc.features.slice(0, this.doc.marker);
    const seq = ++this.buildSeq;
    this.status('Computing…', 'busy');
    let res;
    try {
      await this.ensureFonts();
      res = await this.kernel.build(this.resolve(feats), { baseIndex, mates: this.asm.forKernel(), have: () => [...this.geoCache.keys()] });
    } catch (e) {
      this.status(`Kernel error: ${e.message}`, 'err');
      return null;
    }
    if (!res || seq !== this.buildSeq) return null;
    this.booting = false;
    const missing = [...res.bodies, ...(res.base?.bodies || [])].some((b) => !b.mesh && !b.error && !this.geoCache.has(b.uid));
    if (missing) { this.geoCache.clear(); return this.rebuild({ features, baseIndex, forPreview }); }
    this.ingest(res.bodies);
    if (res.base) this.ingest(res.base.bodies);
    this.result = res;
    if (!forPreview && this.asm.learn(res.assembly)) this.scheduleSave();
    if (!forPreview && this.storeProjections(res.sketches)) this.scheduleSave();
    if (!forPreview && this.mode === 'assembly' && this.doc.asmCollide) this.asm.checkCollisions().then(() => { if (this.mode === 'assembly') this.renderRight(); });
    if (!forPreview) { this.lastErrors = res.errors; this.lastWarnings = res.warnings || {}; this.propsCache.clear(); }
    this.display(res);
    this.evict();
    const nErr = Object.keys(res.errors).length, nWarn = Object.keys(res.warnings || {}).length;
    this.status(nErr ? `${nErr} feature${nErr > 1 ? 's have' : ' has'} errors` : nWarn ? `${nWarn} warning${nWarn > 1 ? 's' : ''}` : `Ready · rebuilt in ${Math.round(res.ms)} ms`, nErr ? 'err' : nWarn ? 'warn' : 'ok');
    if (!forPreview) { this.renderTimeline(); this.renderLeft(); this.renderStatusInfo(); if (!this.cmd && !this.sketcher.active) this.renderRight(); }
    return res;
  }

  ingest(list) {
    for (const b of list) {
      if (b.mesh && !this.geoCache.has(b.uid)) this.geoCache.set(b.uid, buildBodyGeometry(b.mesh));
      const g = this.geoCache.get(b.uid);
      if (g) g.seen = this.buildSeq;
    }
  }
  evict() {
    for (const [uid, g] of this.geoCache) if (g.seen < this.buildSeq - 4) { g.geo.dispose(); g.edges.dispose(); this.geoCache.delete(uid); }
  }

  // associative projections: keep the re-projected positions the kernel computed in the document
  storeProjections(sketches) {
    let changed = false;
    for (const s of sketches || []) {
      if (!s.proj) continue;
      const f = this.doc.features.find((x) => x.id === s.id);
      if (!f?.p.points) continue;
      for (const q of f.p.points) { const v = s.proj.pts[q.id]; if (v) { q.x = v[0]; q.y = v[1]; changed = true; } }
      for (const c of f.p.curves || []) { const r = s.proj.r[c.id]; if (r != null) { c.r = r; changed = true; } }
    }
    return changed;
  }
  // what a body is as a part: identical components share a key (BOM and drawing quantities)
  partInfo(id) {
    const meta = this.bodyMeta(id);
    const comp = id.includes('/') && this.doc.features.find((f) => f.type === 'component' && id.startsWith(`${f.id}/`));
    if (!comp || !comp.p.source) return { key: id, name: meta.name };
    const bid = id.slice(comp.id.length + 1);
    return { key: `${comp.p.source.projectId}|${comp.p.source.updated}|${bid}|${meta.material}`, name: `${comp.p.source.name}: ${comp.p.doc?.bodies?.[bid]?.name || 'Body'}` };
  }
  bodyMeta(id) {
    let m = this.doc.bodies[id];
    if (!m && this.cmd) {
      this.tempMeta ||= {};
      return (this.tempMeta[id] ||= { name: `Body${this.doc.counters.body + 1}`, material: DEFAULT_MATERIAL, visible: true });
    }
    const comp = !m && id.includes('/') && this.doc.features.find((f) => f.type === 'component' && id.startsWith(`${f.id}/`));
    if (comp) {
      // a body of a component: named and coloured as in its source project
      const bid = id.slice(comp.id.length + 1), src = comp.p.doc?.bodies?.[bid];
      return (this.doc.bodies[id] = { material: DEFAULT_MATERIAL, visible: true, ...(src || {}), name: `${comp.name}: ${src?.name || 'Body'}` });
    }
    if (!m) {
      this.doc.counters.body++;
      const surf = this.result?.bodies?.find((b) => b.id === id)?.surface;
      m = this.doc.bodies[id] = { name: `${surf ? 'Surface' : 'Body'}${this.doc.counters.body}`, material: DEFAULT_MATERIAL, visible: true };
    }
    return m;
  }
  appearanceOf(meta) {
    const look = bodyLook(meta);
    return { color: look.color, appearance: look, look };
  }
  // Painted faces of a body resolved to face indices of its current mesh (cached per mesh).
  faceLooks(meta, geo) {
    if (!meta.faces?.length) return [];
    const cache = (geo.geo.userData.faceLookup ||= new Map());
    const out = [];
    for (const f of meta.faces) {
      const key = f.p.join(',');
      if (!cache.has(key)) cache.set(key, faceAtPoint(geo.geo, f.p));
      const fi = cache.get(key);
      if (fi >= 0) out.push({ faceIndex: fi, color: f.look.color, appearance: f.look });
    }
    return out;
  }
  bodyDisplayList(bodies) {
    return bodies.filter((b) => this.geoCache.has(b.uid)).map((b) => {
      const meta = this.bodyMeta(b.id);
      const geo = this.geoCache.get(b.uid);
      return { id: b.id, geo, surface: !!b.surface, visible: meta.visible !== false, ...this.appearanceOf(meta), faces: this.faceLooks(meta, geo) };
    });
  }

  display(res) {
    this.vp.setBodies(this.bodyDisplayList(res.bodies));
    this.applyExplode();
    if (this.mode === 'compare' && this.cmp?.result) this.vp.setCompare(this.cmp.result, this.cmp.show);
    this.vp.setCanvases(this.ws === 'design' ? canvasList(this.doc).filter((c) => c.visible !== false) : []);
    this.vp.setDecals(this.ws === 'design' || this.ws === 'render' ? decalList(this.doc).filter((d) => d.visible !== false) : []);
    if (this.ws === 'simulate' && res === this.result) this.sim.display();
    if (this.ws === 'manufacture' && res === this.result && this._camUid !== res.bodies.map((b) => b.uid).join()) { this._camUid = res.bodies.map((b) => b.uid).join(); this.camws.compute(); }
    const hiddenCurve = new Set(this.doc.features.filter((f) => f.type === 'cvcurve' && f.hidden).map((f) => f.id));
    this.vp.setCurves((this.ws === 'render' || this.ws === 'simulate' || this.ws === 'manufacture') ? [] : (res.curves || []).map((c) => ({ ...c, visible: !hiddenCurve.has(c.id) || !!this.cmd?.showSketches })));
    if (this.mode === 'cv' && res === this.result) this.cvEdit.resync();
    if (this.mode === 'analysis' && res === this.result) {
      if (this.analysis.mode === 'curv') this.loadCurvature();
      if (this.analysis.mode === 'comb' && this._combUid !== res.bodies.map((b) => b.uid).join()) { this._combUid = res.bodies.map((b) => b.uid).join(); this.loadCombs(); }
    }
    const hiddenSketch = new Set(this.doc.features.filter((f) => f.type === 'sketch' && f.hidden).map((f) => f.id));
    this.vp.setSketches((this.ws === 'render' || this.ws === 'simulate' || this.ws === 'manufacture') ? [] : res.sketches.map((s) => ({ ...s, visible: !hiddenSketch.has(s.id) || !!this.cmd?.showSketches })));
    const hiddenPlane = new Set(this.doc.features.filter((f) => f.type === 'plane' && f.hidden).map((f) => f.id));
    const planeField = this.activeFieldDef()?.type === 'planeRef';
    this.vp.setPlanes((this.ws === 'render' || this.ws === 'simulate' || this.ws === 'manufacture') ? [] : (res.base && this.cmd ? res.base.planes : res.planes || []).map((p) => ({ ...p, visible: !hiddenPlane.has(p.id) || planeField || this.mode === 'planePick' })));
    if (res.base && this.cmd?.needsBase) this.vp.setPickBodies(this.bodyDisplayList(res.base.bodies));
    else this.vp.setPickBodies(null);
    this.updateHighlights();
  }

  // ---------------------------------------------------------------- theme & prefs
  applyTheme(viewport = true) {
    const t = resolvedTheme(this.prefs.theme);
    const root = document.documentElement;
    root.dataset.theme = t;
    // accent colour → CSS tokens (and viewport selection colour)
    const ac = ACCENTS[this.prefs.accent] || ACCENTS.blue;
    const hex = t === 'light' ? ac[2] : ac[1];
    const rgb = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16)).join(', ');
    const hi = new THREE.Color(hex).lerp(new THREE.Color(0xffffff), 0.18).getStyle();
    root.style.setProperty('--accent', hex);
    root.style.setProperty('--accent-hi', hi);
    root.style.setProperty('--accent-soft', `rgba(${rgb}, ${t === 'light' ? 0.1 : 0.16})`);
    root.style.setProperty('--accent-ring', `rgba(${rgb}, ${t === 'light' ? 0.3 : 0.35})`);
    root.style.setProperty('--icon-accent', hex);
    root.classList.toggle('colorful', this.prefs.colorIcons !== false);
    const vpEl = document.getElementById('viewport');
    if (vpEl) vpEl.dataset.bg = this.prefs.vpBg || 'default';
    if (this.vp) {
      this.vp.setAccent(hex);
      this.vp.setGridTone({ studio: 'light', horizon: 'light', white: 'light', black: 'dark', blueprint: 'blue' }[this.prefs.vpBg] || 'auto');
    }
    if (viewport && this.vp) { this.vp.setTheme(t); this.sketcher.active && this.sketcher.redraw(); }
    const b = $('#btn-theme');
    if (b) b.innerHTML = icon(t === 'dark' ? 'moon' : 'sun');
  }
  setPref(k, v) {
    this.prefs[k] = v;
    savePrefs(this.prefs);
    if (['theme', 'accent', 'colorIcons', 'vpBg'].includes(k)) this.applyTheme();
    else this.vp.setPrefs({ [k]: v });
    if (k === 'nav') this.renderStatusInfo();
  }

  // ---------------------------------------------------------------- app bar
  buildAppbar() {
    $('#appbar').innerHTML = `
      <button class="logo" data-act="home" data-tip="Projects" style="border:0;background:none;cursor:pointer;color:inherit">${icon('logo')}<span>Ruffle<em>3D</em></span></button>
      <div class="crumbs">
        <button data-act="home">Projects</button>${icon('chevronRight')}
        <input id="docname" spellcheck="false" data-tip="Rename design">
        <div class="menu-wrap"><button class="iconbtn" data-menu="project" data-tip="Project">${icon('caret')}</button>
          <div class="menu left" data-for="project">
            <button data-act="new">${icon('plus')}<span>New design</span><kbd>Ctrl N</kbd></button>
            <button data-act="home">${icon('dashboard')}<span>All projects</span></button>
            <hr>
            <button data-act="version">${icon('history')}<span>Save version…</span></button>
            <button data-act="duplicate">${icon('copy')}<span>Duplicate project</span></button>
            <hr>
            <button data-act="openfile">${icon('open')}<span>Open file from disk…</span></button>
            <button data-act="savefile">${icon('save')}<span>Download project file</span></button>
            <button data-act="import">${icon('import')}<span>Import STEP / STL…</span></button>
            <hr>
            <button data-act="install">${icon('download')}<span>Install desktop app</span></button>
          </div></div>
        <span id="savestate" class="savestate"></span>
      </div>
      <div class="appbar-center"><div class="seg" id="ws-seg">
        <button data-ws="design" class="on">${icon('cube')}Design</button>
        <button data-ws="render">${icon('render')}Render</button>
        <button data-ws="simulate">${icon('simulate')}Simulate</button>
        <button data-ws="manufacture">${icon('cam')}Manufacture</button>
        <button data-ws="drawing">${icon('drawing')}Drawing</button>
      </div></div>
      <div class="spacer"></div>
      <button class="cmdk" data-act="palette">${icon('search')}<span>Search commands…</span><kbd>Ctrl K</kbd></button>
      <button class="iconbtn" data-act="undo" data-tip="Undo" data-key="Ctrl+Z">${icon('undo')}</button>
      <button class="iconbtn" data-act="redo" data-tip="Redo" data-key="Ctrl+Y">${icon('redo')}</button>
      <button class="iconbtn" id="btn-theme" data-act="theme" data-tip="Toggle light / dark">${icon('moon')}</button>
      <button class="iconbtn" data-act="prefs" data-tip="Preferences">${icon('settings')}</button>
      <button class="iconbtn" data-act="panels" data-tip="Toggle panels" data-key="Tab">${icon('panelLeft')}</button>
      <div class="menu-wrap"><button class="btn primary sm" data-menu="export">${icon('export')}Export${icon('caret')}</button>
        <div class="menu" data-for="export">
          <div class="sec">CAD</div>
          <button data-exp="step">${icon('cube')}<span>STEP (.step)</span><kbd>CAD</kbd></button>
          <div class="sec">Mesh</div>
          <button data-exp="stl">${icon('boxes')}<span>STL (.stl)</span><kbd>3D print</kbd></button>
          <button data-exp="3mf">${icon('boxes')}<span>3MF (.3mf)</span><kbd>3D print · colour</kbd></button>
          <button data-exp="dxf">${icon('dxfout')}<span>DXF (face or sketch)</span><kbd>Laser · CNC</kbd></button>
          <button data-exp="glb">${icon('shapes')}<span>glTF binary (.glb)</span><kbd>Web / AR</kbd></button>
          <button data-exp="obj">${icon('shapes')}<span>Wavefront (.obj)</span></button>
          <div class="sec">Documents</div>
          <button data-exp="png">${icon('image')}<span>Image (.png)</span></button>
          <button data-exp="drawing">${icon('drawing')}<span>Drawing (SVG / PDF)</span></button>
        </div></div>`;
    const bar = $('#appbar');
    bar.addEventListener('click', (e) => {
      const m = e.target.closest('[data-menu]');
      if (m) { e.stopPropagation(); return this.toggleMenu(bar.querySelector(`.menu[data-for=${m.dataset.menu}]`)); }
      const ws = e.target.closest('[data-ws]');
      if (ws) return this.setWorkspace(ws.dataset.ws);
      const ex = e.target.closest('[data-exp]');
      if (ex) { this.closeMenus(); return this.exportAs(ex.dataset.exp); }
      const a = e.target.closest('[data-act]')?.dataset.act;
      if (!a) return;
      this.closeMenus();
      ({
        home: () => this.home.open(), new: () => this.home.open('templates'), version: () => this.saveVersion(), duplicate: () => this.duplicateProject(),
        openfile: () => this.openFile(), savefile: () => this.saveFile(), install: () => this.installApp(), import: () => this.runCommand('import'), palette: () => this.openPalette(),
        undo: () => this.undo(), redo: () => this.redo(), prefs: () => this.openPrefs(), panels: () => this.togglePanels(),
        theme: () => this.setPref('theme', resolvedTheme(this.prefs.theme) === 'dark' ? 'light' : 'dark'),
      })[a]?.();
    });
    $('#docname').onchange = (e) => { this.snapshot(); this.doc.name = e.target.value.trim() || 'Untitled'; this.changed(); };
    $('#docname').onkeydown = (e) => { if (e.key === 'Enter') e.target.blur(); };
    document.addEventListener('click', (e) => {
      if (!e.target.closest('.menu') && !e.target.closest('[data-menu]') && !e.target.closest('[data-more]')) this.closeMenus();
      if (!e.target.closest('.ctx')) this.closeCtx();
    });
    this.applyTheme(false);
  }

  toggleMenu(menu) {
    const open = menu.classList.contains('open');
    this.closeMenus();
    if (!open) menu.classList.add('open');
  }
  closeMenus() { document.querySelectorAll('.menu.open').forEach((m) => m.classList.remove('open')); document.querySelectorAll('.tb-pop').forEach((m) => m.remove()); }

  togglePanels() {
    const l = $('#left'), r = $('#right');
    const hide = !l.classList.contains('collapsed');
    l.classList.toggle('collapsed', hide);
    r.classList.toggle('collapsed', hide);
  }

  syncWsSeg(active = this.ws) { document.querySelectorAll('#ws-seg button').forEach((b) => b.classList.toggle('on', b.dataset.ws === active)); }

  setWorkspace(ws) {
    if (ws !== 'drawing' && this.drawing.isOpen) this.drawing.close(true);
    if (ws === this.ws) { this.syncWsSeg(); return; }
    if (this.sketcher.active) { this.toast('Finish or cancel the sketch first', 'warn'); return; }
    if (this.cmd) this.cancelCommand();
    this.exitMode();
    if (this.ws === 'simulate') this.sim.leave();
    if (this.ws === 'manufacture') this.camws.leave();
    if (ws === 'drawing') {
      this.syncWsSeg('drawing');
      this.drawing.open(() => this.syncWsSeg());
      return;
    }
    this.ws = ws;
    this.syncWsSeg();
    this.vp.setRenderMode(ws === 'render');
    this.selection = [];
    this.display(this.result);
    if (ws === 'simulate') this.sim.enter();
    if (ws === 'manufacture') this.camws.enter();
    this.renderToolbar();
    this.renderRight();
  }

  // ---------------------------------------------------------------- toolbar
  renderToolbar() {
    if (this.sketcher.active) return;
    const tb = $('#toolbar');
    const btn = (c) => { const i = cmdInfo(c); return `<button class="tbtn" data-cmd="${c}" ${c === 'sketch' ? `style="--icon-accent:${CATEGORY_COLORS.sketch}"` : ''} data-tip="${esc(i.label)}" data-key="${i.key || ''}" data-desc="${esc(i.desc || '')}">${icon(i.icon)}<span>${SHORT[c] || i.label}</span></button>`; };
    if (this.ws === 'simulate') return this.sim.toolbar(tb);
    if (this.ws === 'manufacture') return this.camws.toolbar(tb);
    if (this.ws === 'render') {
      tb.innerHTML = `
        <div class="tgroup"><span class="gname">Scene</span>${ENVS.map(([k, label, g]) => `<button class="tbtn ${this.vp.envName === k ? 'on' : ''}" data-env="${k}" data-tip="${label} lighting"><i style="width:20px;height:20px;border-radius:50%;background:${g};box-shadow:inset 0 0 0 1px rgba(255,255,255,.25)"></i><span>${label}</span></button>`).join('')}</div>
        <div class="tgroup"><span class="gname">Effects</span>
          <button class="tbtn ${this.vp.prefs.shadows ? 'on' : ''}" data-rt="shadows" data-tip="Ground shadows">${icon('layers')}<span>Shadows</span></button>
          <button class="tbtn ${this.vp.turntable ? 'on' : ''}" data-rt="turntable" data-tip="Turntable animation">${icon('rotate')}<span>Turntable</span></button></div>
        <div class="tgroup"><span class="gname">Decals</span><button class="tbtn" data-rt="decal" data-tip="Decals" data-desc="Put a logo, label or graphic on a face">${icon('decal')}<span>Decal</span></button></div>
        <div class="tgroup"><span class="gname">Output</span><button class="tbtn" data-rt="capture" data-tip="Capture image" data-desc="High-resolution PNG of the current view">${icon('camera')}<span>Capture</span></button></div>`;
      tb.onclick = (e) => {
        const env = e.target.closest('[data-env]');
        if (env) { this.vp.setEnvironment(env.dataset.env); this.renderToolbar(); this.renderRight(); return; }
        const rt = e.target.closest('[data-rt]')?.dataset.rt;
        if (rt === 'shadows') { this.setPref('shadows', !this.prefs.shadows); this.renderToolbar(); }
        if (rt === 'turntable') { this.vp.turntable = !this.vp.turntable; this.vp.setTurntable(this.vp.turntable); this.renderToolbar(); }
        if (rt === 'capture') this.captureImage();
        if (rt === 'decal') { if (decalList(this.doc).length) this.decals.open(); else this.decals.add(); }
      };
      return;
    }
    const groups = this.designTab === 'surface' ? SURFACE_GROUPS : DESIGN_GROUPS;
    tb.innerHTML = `<div class="tb-tabs">${[['solid', 'Solid'], ['surface', 'Surface']].map(([k, l]) => `<button data-dtab="${k}" class="${(this.designTab || 'solid') === k ? 'on' : ''}">${l}</button>`).join('')}</div>` + groups.map((g) => `
      <div class="tgroup" style="--icon-accent:${CATEGORY_COLORS[g.color]}"><span class="gname">${g.name}</span>${g.items.map(btn).join('')}${g.more.length ? `<button class="tbtn more" data-more="${g.name}" data-tip="More ${g.name.toLowerCase()} tools">${icon('caret')}</button>` : ''}</div>`).join('');
    tb.onclick = (e) => {
      const dt = e.target.closest('[data-dtab]');
      if (dt) { this.designTab = dt.dataset.dtab; try { localStorage.setItem('ruffle3d.designTab', this.designTab); } catch { /* ignore */ } return this.renderToolbar(); }
      const more = e.target.closest('[data-more]');
      if (more) {
        e.stopPropagation();
        const g = groups.find((x) => x.name === more.dataset.more);
        const existing = document.querySelector('.tb-pop');
        this.closeMenus();
        if (existing?.dataset.g === g.name) return;
        const m = document.createElement('div');
        m.className = 'menu open tb-pop';
        m.dataset.g = g.name;
        m.style.position = 'fixed';
        m.style.setProperty('--icon-accent', CATEGORY_COLORS[g.color]);
        m.innerHTML = `<div class="sec">${g.name}</div>${[...g.items, '-', ...g.more].map((c) => (c === '-' ? '<hr>' : `<button data-cmd="${c}">${icon(cmdInfo(c).icon)}<span>${cmdInfo(c).label}</span>${cmdInfo(c).key ? `<kbd>${cmdInfo(c).key}</kbd>` : ''}</button>`)).join('')}`;
        document.body.appendChild(m);
        const r = more.getBoundingClientRect();
        m.style.left = `${Math.min(r.left - 120, innerWidth - 250)}px`;
        m.style.top = `${r.bottom + 4}px`;
        m.onclick = (ev) => { const b = ev.target.closest('[data-cmd]'); if (b) { this.closeMenus(); this.runCommand(b.dataset.cmd); } };
        return;
      }
      const b = e.target.closest('[data-cmd]');
      if (b) this.runCommand(b.dataset.cmd);
    };
  }

  // ---------------------------------------------------------------- viewport chrome
  buildNav() {
    $('#navctl').innerHTML = `
      <button class="iconbtn" data-nav="home" data-tip="Home view">${icon('home')}</button>
      <button class="iconbtn" data-nav="fit" data-tip="Zoom to fit" data-key="F6">${icon('fit')}</button>
      <hr>
      <button class="iconbtn" data-nav="proj" data-tip="Perspective / orthographic">${icon('cube')}</button>
      <button class="iconbtn" data-nav="style" data-tip="Visual style">${icon('edges')}</button>
      <button class="iconbtn on" data-nav="grid" data-tip="Grid">${icon('grid')}</button>
      <hr>
      <button class="iconbtn" data-nav="section" data-tip="Section analysis">${icon('section')}</button>`;
    $('#navctl').onclick = (e) => {
      const a = e.target.closest('[data-nav]');
      if (!a) return;
      const k = a.dataset.nav;
      if (k === 'home') this.vp.setView([1, -1.2, 0.9]);
      if (k === 'fit') this.vp.fitAll();
      if (k === 'proj') { const o = !this.vp.camera.isOrthographicCamera; this.vp.setProjection(o); a.innerHTML = icon(o ? 'ortho' : 'cube'); a.classList.toggle('on', o); this.toast(o ? 'Orthographic view' : 'Perspective view'); }
      if (k === 'style') {
        e.stopPropagation();
        const r = a.getBoundingClientRect();
        const set = (mode) => { if (this.mode === 'analysis') this.exitMode(); this.vp.setDisplayMode(mode); this.syncStyleBtn(); };
        const cur = this.vp.displayMode;
        const mark = (on, l) => (on ? `${l}  ✓` : l);
        this.showCtx(r.right + 8, r.top - 60, [
          { label: mark(cur === 'shadedEdges' && !this.vp.analysis, 'Shaded with edges'), icon: 'edges', fn: () => set('shadedEdges') },
          { label: mark(cur === 'shaded' && !this.vp.analysis, 'Shaded'), icon: 'shaded', fn: () => set('shaded') },
          { label: mark(cur === 'xray' && !this.vp.analysis, 'X-ray'), icon: 'xray', fn: () => set('xray') },
          { label: mark(cur === 'wire' && !this.vp.analysis, 'Wireframe'), icon: 'wire', fn: () => set('wire') },
          '-',
          { label: mark(this.vp.analysis?.mode === 'zebra', 'Zebra analysis'), icon: 'zebra', fn: () => this.runCommand('zebra') },
          { label: mark(this.vp.analysis?.mode === 'draft', 'Draft analysis'), icon: 'draftan', fn: () => this.runCommand('draftan') },
          { label: mark(this.vp.analysis?.mode === 'curv', 'Curvature map'), icon: 'curvmap', fn: () => this.runCommand('curvmap') },
        ]);
      }
      if (k === 'grid') { this.vp.world.visible = !this.vp.world.visible; a.classList.toggle('on', this.vp.world.visible); this.vp.requestRender(); }
      if (k === 'section') this.runCommand('section');
    };
  }

  renderVpInfo() {
    const chips = [];
    if (this.vp.section.enabled) chips.push(`<button class="chip on" data-vi="section">${icon('section')}Section ${this.vp.section.axis} · ${this.len(this.vp.section.offset, 1)} <span style="opacity:.7">✕</span></button>`);
    const cfg = this.activeConfig();
    if (cfg) chips.push(`<button class="chip on" data-vi="config">${icon('configs')}${esc(cfg.name)}</button>`);
    if (this.doc.marker < this.doc.features.length) chips.push(`<button class="chip" data-vi="rolled" style="color:var(--warn)">${icon('history')}Rolled back · ${this.doc.features.length - this.doc.marker} hidden</button>`);
    $('#vpinfo').innerHTML = chips.join('');
    $('#vpinfo').onclick = (e) => {
      const v = e.target.closest('[data-vi]')?.dataset.vi;
      if (v === 'section') { this.vp.setSection({ enabled: false }); this.renderVpInfo(); if (this.mode === 'section') this.exitMode(); }
      if (v === 'rolled') { this.doc.marker = this.doc.features.length; this.changed(); }
      if (v === 'config') this.openConfigTable();
    };
  }

  buildStatusbar() {
    $('#statusbar').innerHTML = `<span id="status">Starting geometry kernel…</span>
      <span class="sb-right"><span id="sb-info"></span><span class="sep"></span>
        <select id="sb-units" data-tip="Document units">${Object.keys(UNITS_TABLE).map((u) => `<option value="${u}">${u}</option>`).join('')}</select>
        <span class="sep"></span><button id="sb-nav" data-tip="Mouse navigation preset">${icon('pointer')}</button>
        <span class="sep"></span><span>OpenCascade · WebAssembly</span></span>`;
    $('#sb-units').onchange = (e) => this.setUnits(e.target.value);
    $('#sb-nav').onclick = () => this.openPrefs('navigation');
  }

  renderStatusInfo() {
    const n = this.result.bodies.length;
    $('#sb-info').textContent = `${n} bod${n === 1 ? 'y' : 'ies'} · ${this.doc.features.length} features`;
    $('#sb-units').value = this.doc.units;
    $('#sb-nav').innerHTML = `${{ ruffle: 'Default', fusion: 'Shift-orbit', solidworks: 'Middle-orbit', onshape: 'Right-orbit' }[this.prefs.nav] || 'Default'} navigation`;
  }

  setUnits(u) {
    if (u === this.doc.units) return;
    this.snapshot();
    this.doc.units = u;
    this.toast(`Document units: ${u}. Plain numbers in fields are now read in ${u}.`, 'info');
    this.changed();
    this.renderRight();
  }

  // ---------------------------------------------------------------- tooltips
  bindTips() {
    const tip = document.createElement('div');
    tip.className = 'tip';
    document.body.appendChild(tip);
    let timer = null, cur = null;
    document.addEventListener('mouseover', (e) => {
      const el = e.target.closest('[data-tip]');
      if (el === cur) return;
      cur = el;
      clearTimeout(timer);
      tip.classList.remove('show');
      if (!el || !this.prefs.tooltips) return;
      timer = setTimeout(() => {
        const key = el.dataset.key, desc = el.dataset.desc;
        tip.innerHTML = `<b>${esc(el.dataset.tip)}</b>${key ? `<kbd>${esc(key)}</kbd>` : ''}${desc ? `<small>${esc(desc)}</small>` : ''}`;
        const r = el.getBoundingClientRect();
        tip.style.left = '0px'; tip.style.top = '0px';
        tip.classList.add('show');
        const tr = tip.getBoundingClientRect();
        let x = r.left + r.width / 2 - tr.width / 2, y = r.bottom + 8;
        if (y + tr.height > innerHeight - 8) y = r.top - tr.height - 8;
        tip.style.left = `${Math.max(8, Math.min(x, innerWidth - tr.width - 8))}px`;
        tip.style.top = `${y}px`;
      }, 380);
    });
    document.addEventListener('mousedown', () => { clearTimeout(timer); tip.classList.remove('show'); });
  }

  // ---------------------------------------------------------------- commands
  runCommand(c) {
    if (this.sketcher.active) return this.toast('Finish the sketch first', 'warn');
    if (this.ws !== 'design' && !['drawing', 'import'].includes(c)) this.setWorkspace('design');
    if (this.cmd) this.cancelCommand();
    const wasAnalysis = this.mode === 'analysis' && this.vp.analysis?.mode;
    this.exitMode();
    if (wasAnalysis && wasAnalysis === { zebra: 'zebra', draftan: 'draft', curvmap: 'curv', comb: 'comb', isophote: 'iso', printcheck: 'overhang' }[c]) return; // toggle off
    this.lastCmd = c;
    if (c === 'sketch') return this.startSketchPick();
    if (c === 'params') { this.leftTab = 'params'; $('#left').classList.remove('collapsed'); return this.renderLeft(); }
    if (c === 'appearance') return this.startPaint();
    if (c === 'zebra' || c === 'draftan') return this.startAnalysis(c === 'zebra' ? 'zebra' : 'draft');
    if (c === 'curvmap') return this.startAnalysis('curv');
    if (c === 'isophote') return this.startAnalysis('iso');
    if (c === 'bom') return this.openBOM();
    if (c === 'flatpattern') return this.openFlatPattern();
    if (c === 'printcheck') return this.startAnalysis('overhang');
    if (c === 'importdxf') return this.importDXF();
    if (c === 'exportdxf') return this.startDXFExport();
    if (c === 'configs') return this.openConfigTable();
    if (c === 'canvas') return canvasList(this.doc).length ? this.canvases.open() : this.canvases.add();
    if (c === 'decal') return decalList(this.doc).length ? this.decals.open() : this.decals.add();
    if (c === 'cvcurve') return this.startCV();
    if (c === 'editcv') return this.startCVEdit();
    if (c === 'rebuildcv') return this.openFeature('cvsurface', null, { source: 'face' });
    if (c === 'comb') return this.startAnalysis('comb');
    if (c === 'material' || c === 'props') {
      if (!this.selection.some((s) => s.kind === 'body')) {
        const first = this.result.bodies[0];
        if (!first) return this.toast('There are no bodies yet', 'warn');
        this.selection = [{ kind: 'body', bodyId: first.id }];
        this.updateHighlights();
      }
      $('#right').classList.remove('collapsed');
      return this.renderRight();
    }
    if (c === 'measure') return this.startMeasure();
    if (c === 'section') return this.startSection();
    if (c === 'import') return this.importFile();
    if (c === 'interference') return this.runInterference();
    if (c === 'drawing') return this.setWorkspace('drawing');
    if (c === 'animate') return this.animateJoints();
    if (c === 'component') return this.asm.insert();
    if (c === 'mate') return this.asm.startMate();
    if (c === 'assembly') return this.asm.openPanel();
    if (c === 'explode') return this.startExplode();
    if (c === 'thickness') return this.startThickness();
    if (c.startsWith('plane:')) return this.openFeature('plane', null, { mode: c.slice(6) });
    if (FEATURES[c]) this.openFeature(c);
  }

  ctx() {
    const bodies = this.result.bodies.map((b) => b.id);
    const sketches = this.doc.features.slice(0, this.doc.marker).filter((f) => f.type === 'sketch' && !f.suppressed).map((f) => f.id);
    const selBodies = this.selection.filter((s) => s.kind === 'body').map((s) => s.bodyId);
    const selSketch = this.selection.find((s) => s.kind === 'profile')?.sketchId;
    return { lastBody: selBodies[0] || bodies[bodies.length - 1], lastSketch: selSketch || sketches[sketches.length - 1], prevSketch: sketches[sketches.length - 2], selectedBodies: selBodies };
  }

  openFeature(type, editId = null, overrides = {}) {
    const def = FEATURES[type];
    let draft, index;
    const prevMarker = this.doc.marker;
    if (editId) {
      index = this.doc.features.findIndex((f) => f.id === editId);
      draft = structuredClone(this.doc.features[index]);
    } else {
      index = this.doc.marker;
      const p = { ...defaultsFor(type, this.ctx()), ...overrides };
      // scale length defaults into the document unit (20 mm → 0.79 in)
      if (this.units.scale !== 1) for (const f of def.fields) if (f.unit === 'mm' && /^[\d.]+$/.test(String(p[f.key]))) p[f.key] = String(+(parseFloat(p[f.key]) / this.units.scale).toPrecision(2));
      draft = { id: newFid(type), type, p };
    }
    const needsBase = def.fields.some((f) => ['edges', 'faces', 'points', 'body', 'bodies', 'face1', 'planeRef'].includes(f.type));
    const selTypes = ['edges', 'faces', 'points', 'bodies', 'face1', 'regions', 'planeRef', 'curves'];
    const firstSel = def.fields.find((f) => (selTypes.includes(f.type) || (f.type === 'sketch' && f.curve) || (f.type === 'body' && type === 'thicken')) && (!f.show || f.show(draft.p)) && (f.type === 'regions' || f.type === 'planeRef' || !draft.p[f.key]?.length));
    this.cmd = { type, draft, index, editId, prevMarker, needsBase, activeField: firstSel?.key || null, showSketches: def.fields.some((f) => f.type === 'sketch' || f.type === 'curves') };
    this.selection = [];
    $('#right').classList.remove('collapsed');
    this.renderDialog();
    this.renderTimeline();
    this.preview();
  }

  previewFeatures() {
    const { draft, index } = this.cmd;
    return [...this.doc.features.slice(0, index), draft];
  }

  preview() {
    if (!this.cmd) return;
    clearTimeout(this._pvTimer);
    this._pvTimer = setTimeout(async () => {
      if (!this.cmd) return;
      const res = await this.rebuild({ features: this.previewFeatures(), baseIndex: this.cmd.index, forPreview: true });
      if (!res || !this.cmd) return;
      const err = res.errors[this.cmd.draft.id];
      const hint = err && /^(Select|Pick|Choose|Click)/.test(err);
      const box = $('#right .dlg-err');
      if (box) {
        box.innerHTML = err ? `${icon(hint ? 'pointer' : 'warn')}<span>${esc(err)}</span>` : '';
        box.style.display = err ? 'flex' : 'none';
        box.classList.toggle('hint', !!hint);
      }
      this.status(err && !hint ? 'Preview has an error' : 'Previewing', err && !hint ? 'warn' : 'ok');
      const ok = $('#right [data-act=ok]');
      if (ok) ok.classList.toggle('warn', !!err);
    }, 60);
  }

  okCommand() {
    const c = this.cmd;
    if (!c) return;
    this.snapshot();
    const f = c.draft;
    if (c.editId) {
      this.doc.features[c.index] = f;
      this.doc.marker = c.prevMarker;
    } else {
      this.doc.features.splice(c.index, 0, f);
      this.doc.marker = c.index + 1;
      for (const k of ['sketch', 'sketch2', 'path']) {
        const s = this.doc.features.find((x) => x.id === f.p[k]);
        if (s) s.hidden = true;
      }
    }
    if (!f.name) f.name = `${FEATURES[f.type].label} ${this.doc.features.filter((x) => x.type === f.type).length}`;
    this.closeDialog();
    this.changed();
  }

  cancelCommand() {
    if (!this.cmd) return;
    this.closeDialog();
    this.rebuild();
  }

  closeDialog() {
    this.cmd = null;
    this.vp.setPickBodies(null);
    this.vp.stopAnimation();
    this.hover = null;
    this.vp.originPlanes.visible = this.doc.originVisible;
    this.updateHighlights();
    this.renderRight();
    this.renderTimeline();
  }

  renderDialog() {
    const c = this.cmd;
    const def = FEATURES[c.type];
    const p = c.draft.p;
    const u = this.units;
    const bodies = (this.result.base?.bodies || this.result.bodies).map((b) => b.id);
    const allBodies = [...new Set([...bodies, ...this.result.bodies.map((b) => b.id)])];
    const sketches = this.doc.features.slice(0, c.index).filter((f) => f.type === 'sketch' && !f.suppressed);
    const rows = def.fields.filter((f) => !f.show || f.show(p)).map((f) => {
      const v = p[f.key];
      let ctl = '';
      if (f.type === 'number' || f.type === 'int') {
        const unit = f.unit === 'mm' ? u.label : f.unit || '';
        ctl = `<div class="num"><input data-k="${f.key}" value="${esc(v)}" spellcheck="false"><span class="unit">${unit}</span></div>`;
      } else if (f.type === 'select') {
        ctl = f.options.length <= 3 && f.options.every(([, l]) => l.length < 12)
          ? `<div class="seg" data-segk="${f.key}">${f.options.map(([val, lab]) => `<button data-v="${val}" class="${val === v ? 'on' : ''}">${lab}</button>`).join('')}</div>`
          : `<select data-k="${f.key}">${f.options.map(([val, lab]) => `<option value="${val}" ${val === v ? 'selected' : ''}>${lab}</option>`).join('')}</select>`;
      } else if (f.type === 'string') {
        ctl = `<textarea class="input" rows="2" data-k="${f.key}" spellcheck="false" style="resize:vertical;min-height:34px;padding:7px 9px;font:inherit">${esc(v ?? '')}</textarea>`;
      } else if (f.type === 'font') {
        const fonts = Object.entries(this.doc.fonts || {});
        ctl = `<select data-k="${f.key}"><option value="builtin" ${!v || v === 'builtin' ? 'selected' : ''}>Ruffle Engrave (built-in)</option>${fonts.map(([id, fo]) => `<option value="${id}" ${v === id ? 'selected' : ''}>${esc(fo.name)}</option>`).join('')}<option value="__load">Load a font file (TTF, OTF)…</option></select>`;
      } else if (f.type === 'check') {
        ctl = `<label class="switch"><input type="checkbox" data-k="${f.key}" ${v ? 'checked' : ''}><span></span></label>`;
      } else if (f.type === 'curves') {
        const names = (v || []).map((id) => this.doc.features.find((x) => x.id === id)?.name || id);
        ctl = `<div class="selfield ${c.activeField === f.key ? 'active' : ''} ${names.length ? 'has' : ''}" data-selfield="${f.key}"><i class="dot"></i><span title="${esc(names.join(' → '))}">${names.length ? esc(names.length > 2 ? `${names.length} curves · ${names[0]} → …` : names.join(' → ')) : f.hint || 'Click sketch curves'}</span>${names.length ? `<button class="x" data-clear="${f.key}" data-tip="Clear selection">${icon('close')}</button>` : ''}</div>`;
      } else if (f.type === 'sketch' && f.curve) {
        const srcs = this.doc.features.slice(0, c.index).filter((x) => (x.type === 'sketch' || x.type === 'cvcurve') && !x.suppressed);
        ctl = `<select data-k="${f.key}" data-selfield="${f.key}" class="${c.activeField === f.key ? 'active' : ''}"><option value="">Click a curve or choose…</option>${srcs.map((s) => `<option value="${s.id}" ${s.id === v ? 'selected' : ''}>${esc(s.name)}</option>`).join('')}</select>`;
      } else if (f.type === 'sketch') {
        ctl = `<select data-k="${f.key}"><option value="">Select a sketch…</option>${sketches.map((s) => `<option value="${s.id}" ${s.id === v ? 'selected' : ''}>${esc(s.name)}</option>`).join('')}</select>`;
      } else if (f.type === 'body') {
        ctl = `<select data-k="${f.key}" class="${c.activeField === f.key ? 'active' : ''}" data-selfield="${f.key}"><option value="">Select a body…</option>${allBodies.map((id) => `<option value="${id}" ${id === v ? 'selected' : ''}>${esc(this.bodyMeta(id).name)}</option>`).join('')}</select>`;
      } else if (f.type === 'planeRef') {
        const planes = this.doc.features.slice(0, c.index).filter((x) => x.type === 'plane' && !x.suppressed && x.id !== c.draft.id);
        const cur = !v ? '' : typeof v === 'string' ? `std:${v}` : v.type === 'std' ? `std:${v.name}` : v.type === 'plane' ? `plane:${v.id}` : 'face';
        ctl = `<select data-pr="${f.key}" data-selfield="${f.key}" class="${c.activeField === f.key ? 'active' : ''}">
          ${['XY', 'XZ', 'YZ'].map((n) => `<option value="std:${n}" ${cur === `std:${n}` ? 'selected' : ''}>${n} plane</option>`).join('')}
          ${planes.map((x) => `<option value="plane:${x.id}" ${cur === `plane:${x.id}` ? 'selected' : ''}>${esc(x.name)}</option>`).join('')}
          ${cur === 'face' ? '<option value="face" selected>Selected face</option>' : ''}</select>`;
      } else if (f.type === 'regions') {
        const n = (v || []).length;
        const label = !p[f.of] ? 'Click a sketch profile' : n ? `${n} profile${n > 1 ? 's' : ''}` : 'All profiles';
        ctl = `<div class="selfield ${c.activeField === f.key ? 'active' : ''} ${p[f.of] ? 'has' : ''}" data-selfield="${f.key}"><i class="dot"></i><span>${label}</span>${n ? `<button class="x" data-clear="${f.key}" data-tip="Use all profiles">${icon('close')}</button>` : ''}</div>`;
      } else {
        const n = (v || []).length;
        const what = { bodies: 'bod', edges: 'edge', faces: 'face', points: 'point', face1: 'face' }[f.type];
        const label = n ? `${n} ${what}${f.type === 'bodies' ? (n === 1 ? 'y' : 'ies') : n === 1 ? '' : 's'}` : f.hint || 'Select in the viewport';
        ctl = `<div class="selfield ${c.activeField === f.key ? 'active' : ''} ${n ? 'has' : ''}" data-selfield="${f.key}"><i class="dot"></i><span>${label}</span>${n ? `<button class="x" data-clear="${f.key}" data-tip="Clear selection">${icon('close')}</button>` : ''}</div>`;
      }
      return `<div class="field ${f.type === 'check' ? 'check' : ''}"><label>${f.label}</label>${ctl}</div>`;
    }).join('');
    const d = $('#right');
    d.innerHTML = `
      <div class="panel-head">${icon(def.icon)}<h3>${def.label}<small>${c.editId ? `Editing ${esc(c.draft.name || '')}` : DESC[c.type] || 'New feature'}</small></h3><button class="iconbtn" data-act="cancel" data-tip="Cancel" data-key="Esc">${icon('close')}</button></div>
      <div class="panel-body"><div class="insp"><div class="insp-sec">${rows}</div><div class="dlg-err"></div></div></div>
      <div class="panel-foot">${c.type === 'surftrim' && p.dir === 'view' ? `<button class="btn sm" data-act="viewdir" data-tip="Use the current view direction" data-desc="Orbit to the view you want, then click">${icon('focus')}Use current view</button>` : c.type === 'cvsurface' && c.editId ? `<button class="btn sm" data-act="editcv">${icon('editcv')}Edit CVs</button>` : c.type === 'joint' && p.type !== 'rigid' ? `<button class="btn sm" data-act="animate">${icon('animate')}Animate</button>` : '<span class="hint"><kbd>Enter</kbd> OK · <kbd>Esc</kbd> Cancel</span>'}<button class="btn ghost" data-act="cancel">Cancel</button><button class="btn primary" data-act="ok">${icon('check')}OK</button></div>`;
    d.querySelectorAll('[data-act=cancel]').forEach((b) => (b.onclick = () => this.cancelCommand()));
    d.querySelector('[data-act=ok]').onclick = () => this.okCommand();
    if (c.type === 'surftrim' && p.dir === 'view' && !p.viewDir) p.viewDir = this.viewDirection();
    d.querySelector('[data-act=viewdir]')?.addEventListener('click', () => { p.viewDir = this.viewDirection(); this.toast('Trim direction set from the current view', 'ok'); this.preview(); });
    d.querySelector('[data-act=editcv]')?.addEventListener('click', () => { const id = c.editId; this.okCommand(); setTimeout(() => this.startCVEdit(id), 50); });
    const anim = d.querySelector('[data-act=animate]');
    if (anim) anim.onclick = () => { const j = (this.result.joints || []).find((x) => x.id === c.draft.id); if (j) this.vp.animateBody(j.body, j.origin, j.axis, j.type); else this.toast('Pick both faces first', 'warn'); };
    d.querySelectorAll('[data-pr]').forEach((el) => (el.onchange = () => {
      const [kind, id] = el.value.split(':');
      p[el.dataset.pr] = kind === 'std' ? { type: 'std', name: id } : kind === 'plane' ? { type: 'plane', id } : p[el.dataset.pr];
      this.renderDialog();
      this.preview();
    }));
    d.querySelectorAll('[data-segk]').forEach((seg) => seg.querySelectorAll('[data-v]').forEach((b) => (b.onclick = () => { p[seg.dataset.segk] = b.dataset.v; this.renderDialog(); this.preview(); })));
    d.querySelectorAll('[data-k]:not([data-pr])').forEach((el) => {
      const k = el.dataset.k;
      const fld = def.fields.find((f) => f.key === k);
      const apply = () => {
        if (fld.type === 'font' && el.value === '__load') { el.value = p[k] || 'builtin'; return this.loadFontFile((id) => { p[k] = id; this.renderDialog(); this.preview(); }); }
        p[k] = el.type === 'checkbox' ? el.checked : el.value;
        if (fld.type === 'number' || fld.type === 'int') {
          try { evaluate(el.value, this.vars); el.classList.remove('bad'); } catch { el.classList.add('bad'); }
        }
        if (el.tagName === 'SELECT' || el.type === 'checkbox') this.renderDialog();
        this.preview();
      };
      el.addEventListener((el.tagName === 'INPUT' && el.type !== 'checkbox') || el.tagName === 'TEXTAREA' ? 'input' : 'change', apply);
      if (el.tagName === 'INPUT' && el.type !== 'checkbox' && (fld.type === 'number' || fld.type === 'int')) {
        el.addEventListener('keydown', (e) => {
          if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
            let v; try { v = evaluate(el.value, this.vars); } catch { return; }
            const step = (fld.type === 'int' ? 1 : e.shiftKey ? 10 : e.altKey ? 0.1 : 1) * (e.key === 'ArrowUp' ? 1 : -1);
            el.value = String(+(v + step).toFixed(6));
            apply();
            e.preventDefault();
          }
        });
      }
    });
    d.querySelectorAll('[data-selfield]').forEach((el) => el.addEventListener('mousedown', (e) => {
      if (e.target.closest('[data-clear]')) return;
      if (c.activeField !== el.dataset.selfield) { c.activeField = el.dataset.selfield; if (el.tagName !== 'SELECT') this.renderDialog(); this.updateHighlights(); }
    }));
    d.querySelectorAll('[data-clear]').forEach((b) => (b.onclick = (e) => { e.stopPropagation(); p[b.dataset.clear] = []; this.renderDialog(); this.preview(); }));
    const firstNum = d.querySelector('.num input');
    if (firstNum && !c.focused) { c.focused = true; setTimeout(() => { firstNum.focus(); firstNum.select(); }, 30); }
    const pf = this.activeFieldDef()?.type === 'planeRef';
    this.vp.originPlanes.visible = this.doc.originVisible || pf;
    this.display(this.result);
  }

  activeFieldDef() {
    const c = this.cmd;
    if (!c?.activeField) return null;
    return FEATURES[c.type].fields.find((f) => f.key === c.activeField);
  }

  pickFilter() {
    if (this.mode === 'planePick') return new Set(['plane']);
    if (this.mode === 'measure') return new Set(['edge', 'face']);
    if (this.mode === 'paint') return new Set([this.paint.target === 'face' ? 'face' : 'body']);
    if (this.mode === 'dxfpick') return new Set(['face', 'profile', 'curve']);
    if (this.mode === 'decalpick') return new Set(['face']);
    if (this.mode === 'explode') return new Set([]);
    if (this.mode === 'thickness') return new Set([]);
    if (this.mode === 'compare') return new Set([]);
    if (this.mode === 'mate') return new Set(['face']);
    if (this.mode === 'assembly') return new Set([]);
    if (this.mode === 'analysis') return new Set(this.analysis?.mode === 'comb' ? ['edge'] : []);
    if (this.ws === 'render') return new Set(['body']);
    if (this.ws === 'simulate') return new Set(this.sim.pick ? ['face'] : ['body']);
    if (this.ws === 'manufacture') return new Set(this.camws.pick ? ['face'] : []);
    const f = this.activeFieldDef();
    if (!f) return this.cmd ? null : new Set(['body', 'profile']);
    return new Set({ body: ['body'], bodies: ['body'], edges: ['edge'], faces: ['face'], face1: ['face'], points: ['point'], sketch: ['curve', 'profile'], curves: ['curve', 'profile'], regions: ['profile'], planeRef: ['plane'] }[f.type] || []);
  }

  onPick(hit) {
    const c = this.cmd;
    const f = this.activeFieldDef();
    if (!c || !f || !hit) return;
    const p = c.draft.p;
    const toggle = (arr, item, same) => { const i = arr.findIndex(same); if (i >= 0) arr.splice(i, 1); else arr.push(item); };
    if (f.type === 'sketch' && (hit.kind === 'profile' || hit.kind === 'curve')) {
      p[f.key] = hit.sketchId;
      const next = FEATURES[c.type].fields.find((x) => x.type === 'sketch' && x.curve && x.key !== f.key && !p[x.key]);
      if (next) c.activeField = next.key;
    } else if (f.type === 'curves' && (hit.kind === 'profile' || hit.kind === 'curve')) toggle((p[f.key] ||= []), hit.sketchId, (x) => x === hit.sketchId);
    else if (f.type === 'body' && hit.bodyId) p[f.key] = hit.bodyId;
    else if (f.type === 'bodies' && hit.bodyId) toggle((p[f.key] ||= []), hit.bodyId, (x) => x === hit.bodyId);
    else if (f.type === 'edges' && hit.kind === 'edge') {
      const pt = this.edgeMidpoint(hit.bodyId, hit.edgeIndex) || hit.point;
      toggle((p[f.key] ||= []), { body: hit.bodyId, p: pt, ...this.pickRef(hit, pt) }, (x) => x.body === hit.bodyId && this.locateEdge(x)?.edgeIndex === hit.edgeIndex);
    } else if (f.type === 'faces' && hit.kind === 'face') {
      toggle((p[f.key] ||= []), { body: hit.bodyId, p: hit.point, n: hit.normal, ...this.pickRef(hit, hit.point) }, (x) => x.body === hit.bodyId && this.locateFace(x)?.faceIndex === hit.faceIndex);
    } else if (f.type === 'regions' && hit.kind === 'profile') {
      const sk = (this.result.sketches || []).find((x) => x.id === hit.sketchId);
      if (!sk) return;
      if (p[f.of] !== hit.sketchId) { p[f.of] = hit.sketchId; p[f.key] = []; }
      const regions = computeRegions(sk.geom || []);
      const r = regions[hit.region];
      const arr = (p[f.key] ||= []);
      const i = arr.findIndex((q) => r && inRegion(q, r));
      if (i >= 0) arr.splice(i, 1); else arr.push(r ? r.sample : toLocal(sk.plane, hit.point));
    } else if (f.type === 'planeRef' && hit.kind === 'plane') {
      p[f.key] = hit.planeName ? { type: 'std', name: hit.planeName } : hit.planeId ? { type: 'plane', id: hit.planeId } : { type: 'face', body: hit.bodyId, p: hit.point, n: hit.normal, ...this.pickRef(hit, hit.point) };
    } else if (f.type === 'face1' && hit.kind === 'face') {
      p[f.key] = [{ body: hit.bodyId, p: hit.point, n: hit.normal, ...this.pickRef(hit, hit.point) }];
      const next = FEATURES[c.type].fields.find((x) => (x.type === 'face1' && x.key !== f.key && !p[x.key]?.length) || (x.type === 'sketch' && x.curve && !p[x.key]));
      if (next) c.activeField = next.key;
    } else if (f.type === 'points' && hit.kind === 'face') {
      const pt = hit.point.map((v) => Math.round(v * 100) / 100);
      p[f.key] = [...(p[f.key] || []), { body: hit.bodyId, p: pt, n: hit.normal, ...this.pickRef(hit, pt) }];
    } else return;
    this.renderDialog();
    this.preview();
  }

  pickSet() { return this.vp.pickBodies || this.vp.bodies; }

  normInBody(bodyId, pt) {
    const b = this.pickSet().get(bodyId);
    const bb = b?.mesh.geometry.boundingBox;
    if (!bb) return undefined;
    return pt.map((v, i) => {
      const lo = bb.min.getComponent(i), hi = bb.max.getComponent(i);
      return hi - lo > 1e-9 ? +((v - lo) / (hi - lo)).toFixed(6) : 0.5;
    });
  }

  // Reference data stored with a pick: the normalised point (u) and a geometric signature (s) of the
  // face or edge, measured on the display mesh, which the kernel uses to find it again after edits.
  pickRef(hit, pt) {
    const out = { u: this.normInBody(hit.bodyId, pt) };
    try {
      const s = hit.kind === 'edge' ? this.edgeSig(hit.bodyId, hit.edgeIndex) : hit.faceIndex != null && hit.faceIndex >= 0 ? this.faceSig(hit.bodyId, hit.faceIndex) : null;
      if (s) out.s = s;
    } catch { /* no signature */ }
    return out;
  }
  faceSig(bodyId, fi) {
    const b = this.pickSet().get(bodyId) || this.vp.bodies.get(bodyId);
    const geo = b?.mesh.geometry, g = geo?.userData.faceGroups?.[fi];
    if (!g) return null;
    return faceSigFromMesh(geo.attributes.position.array, geo.index.array, g.start, g.count);
  }
  edgeSig(bodyId, ei) {
    const b = this.pickSet().get(bodyId) || this.vp.bodies.get(bodyId);
    const eg = b?.edges.geometry, map = eg?.userData.segEdge;
    if (!map) return null;
    const pos = eg.attributes.position.array, segs = [];
    for (let k = 0; k < map.length; k++) if (map[k] === ei) segs.push([[pos[k * 6], pos[k * 6 + 1], pos[k * 6 + 2]], [pos[k * 6 + 3], pos[k * 6 + 4], pos[k * 6 + 5]]]);
    return edgeSigFromSegments(segs);
  }

  edgeMidpoint(bodyId, edgeIndex) {
    const b = this.pickSet().get(bodyId);
    if (!b) return null;
    const eg = b.edges.geometry, pos = eg.attributes.position.array, map = eg.userData.segEdge;
    const segs = [];
    for (let k = 0; k < map.length; k++) if (map[k] === edgeIndex) segs.push(k);
    if (!segs.length) return null;
    if (segs.length === 1) { const k = segs[0]; return [0, 1, 2].map((i) => (pos[k * 6 + i] + pos[k * 6 + 3 + i]) / 2); }
    const k = segs[Math.floor(segs.length / 2)];
    return [pos[k * 6], pos[k * 6 + 1], pos[k * 6 + 2]];
  }

  locateEdge(pk) {
    const b = this.pickSet().get(pk.body) || this.vp.bodies.get(pk.body);
    if (!b) return null;
    const eg = b.edges.geometry, pos = eg.attributes.position.array, map = eg.userData.segEdge;
    const P = new THREE.Vector3(...pk.p), a = new THREE.Vector3(), c = new THREE.Vector3(), l = new THREE.Line3(), q = new THREE.Vector3();
    let best = -1, bd = Infinity;
    for (let k = 0; k < map.length; k++) {
      a.fromArray(pos, k * 6); c.fromArray(pos, k * 6 + 3);
      l.set(a, c).closestPointToPoint(P, true, q);
      const d = q.distanceToSquared(P);
      if (d < bd) { bd = d; best = map[k]; }
    }
    return best >= 0 && bd < 1 ? { kind: 'edge', bodyId: pk.body, edgeIndex: best } : null;
  }

  locateFace(pk) {
    const b = this.pickSet().get(pk.body) || this.vp.bodies.get(pk.body);
    if (!b) return null;
    const geo = b.mesh.geometry, idx = geo.index.array, pos = geo.attributes.position.array, groups = geo.userData.faceGroups;
    const P = new THREE.Vector3(...pk.p), tri = new THREE.Triangle(), q = new THREE.Vector3();
    let best = -1, bd = Infinity;
    groups.forEach((g, gi) => {
      for (let i = g.start; i < g.start + g.count; i += 3) {
        tri.a.fromArray(pos, idx[i] * 3); tri.b.fromArray(pos, idx[i + 1] * 3); tri.c.fromArray(pos, idx[i + 2] * 3);
        tri.closestPointToPoint(P, q);
        const d = q.distanceToSquared(P);
        if (d < bd) { bd = d; best = gi; }
      }
    });
    return best >= 0 && bd < 1 ? { kind: 'face', bodyId: pk.body, faceIndex: best } : null;
  }

  updateHighlights() {
    const sel = [];
    const c = this.cmd;
    if (c) {
      for (const f of FEATURES[c.type].fields) {
        if (f.show && !f.show(c.draft.p)) continue;
        const v = c.draft.p[f.key];
        if (f.type === 'edges') for (const pk of v || []) { const h = this.locateEdge(pk); if (h) sel.push(h); }
        if (f.type === 'faces' || f.type === 'face1') for (const pk of v || []) { const h = this.locateFace(pk); if (h) sel.push(h); }
        if (f.type === 'points') for (const pk of v || []) { const h = this.locateFace(pk); if (h) sel.push({ ...h, kind: 'point', point: pk.p }); }
        if (f.type === 'bodies' && f.key === c.activeField) for (const id of v || []) sel.push({ kind: 'body', bodyId: id });
        if (f.type === 'body' && f.key === c.activeField && v) sel.push({ kind: 'body', bodyId: v });
        if (f.type === 'curves') for (const id of v || []) sel.push({ kind: 'curve', sketchId: id });
        if (f.type === 'sketch' && f.curve && v) sel.push({ kind: 'curve', sketchId: v });
        if (f.type === 'regions' && c.draft.p[f.of]) {
          const sk = (this.result.sketches || []).find((x) => x.id === c.draft.p[f.of]);
          if (sk) {
            const regions = computeRegions(sk.geom || []);
            const pts = v || [];
            regions.forEach((r, i) => {
              const on = pts.length ? pts.some((q) => inRegion(q, r)) && !regions.some((o) => o !== r && o.area < r.area && pts.some((q) => inRegion(q, o) && inRegion(q, r))) : r.depth % 2 === 0;
              if (on) sel.push({ kind: 'profile', sketchId: sk.id, region: i });
            });
          }
        }
        if (f.type === 'planeRef' && v && f.key === c.activeField) {
          if (typeof v === 'string' || v.type === 'std') sel.push({ kind: 'plane', planeName: typeof v === 'string' ? v : v.name });
          else if (v.type === 'plane') sel.push({ kind: 'plane', planeId: v.id });
          else { const h = this.locateFace(v); if (h) sel.push(h); }
        }
      }
    } else if (this.mode === 'analysis' && this.analysis?.mode === 'comb') {
      for (const pk of this.analysis.combs) { const h = this.locateEdge(pk); if (h) sel.push(h); }
    } else if (this.mode === 'mate') {
      this.asm.highlights(sel);
    } else if (this.mode === 'measure') {
      for (const pk of this.measure?.picks || []) { const h = pk.kind === 'edge' ? this.locateEdge(pk) : this.locateFace(pk); if (h) sel.push(h); }
    } else if (this.selFeature) {
      // show what the selected timeline feature references
      const f = this.doc.features.find((x) => x.id === this.selFeature);
      if (f) {
        for (const fld of FEATURES[f.type].fields) {
          const v = f.p[fld.key];
          if (fld.type === 'edges') for (const pk of v || []) { const h = this.locateEdge(pk); if (h) sel.push(h); }
          if (fld.type === 'faces' || fld.type === 'face1' || fld.type === 'points') for (const pk of v || []) { const h = this.locateFace(pk); if (h) sel.push(h); }
          if (fld.type === 'bodies') for (const id of v || []) sel.push({ kind: 'body', bodyId: id });
        }
        if (this.result.bodies.some((b) => b.id === f.id)) sel.push({ kind: 'body', bodyId: f.id });
        if (f.type === 'sketch') sel.push({ kind: 'profile', sketchId: f.id });
      }
    } else if (this.ws === 'simulate') {
      this.sim.highlights(sel);
    } else if (this.ws === 'manufacture') {
      this.camws.highlights(sel);
    } else sel.push(...this.selection);
    if (this.mode === 'planePick' && this.planeHover) sel.push(this.planeHover);
    this.vp.setHighlights({ selected: sel, hover: this.hover });
  }

  // ---------------------------------------------------------------- viewport interaction
  bindViewport() {
    const vp = this.vp;
    let hoverRaf = null;
    vp.on('hover', (ev) => {
      if (this.sketcher.active) return this.sketcher.onHover(ev);
      if (this.mode === 'cv') return this.cvEdit.onHover(ev);
      if (hoverRaf) return;
      hoverRaf = requestAnimationFrame(() => {
        hoverRaf = null;
        const hit = vp.pick(ev, this.pickFilter());
        const key = hit ? `${hit.kind}:${hit.bodyId}:${hit.edgeIndex}:${hit.faceIndex}:${hit.sketchId}:${hit.region}:${hit.planeName}:${hit.planeId}` : '';
        if (this.mode === 'planePick') this.planeHover = hit;
        if (key !== this._hoverKey) {
          this._hoverKey = key;
          this.hover = hit && hit.kind !== 'ground' ? hit : null;
          if (hit?.kind === 'face' && this.activeFieldDef()?.type === 'points') this.hover = { ...hit, kind: 'point' };
          this.updateHighlights();
        }
        vp.renderer.domElement.style.cursor = hit ? 'pointer' : '';
      });
    });
    vp.on('leave', () => { this.hover = null; this._hoverKey = ''; this.updateHighlights(); });
    vp.on('down', (ev) => (this.mode === 'cv' ? this.cvEdit.onDown(ev) : this.mode === 'assembly' ? this.asm.onDown(ev) : this.sketcher.active && this.sketcher.onDown(ev)));
    vp.on('ldrag', (ev, d) => (this.mode === 'cv' ? this.cvEdit.onDrag(ev) : this.mode === 'assembly' ? this.asm.onDrag(ev) : this.sketcher.active && this.sketcher.onDrag(ev, d)));
    vp.on('up', (ev, moved) => (this.mode === 'cv' ? this.cvEdit.onUp() : this.mode === 'assembly' ? this.asm.onUp(moved) : this.sketcher.active && this.sketcher.onUp()));
    vp.on('click', (ev) => {
      if (this.sketcher.active) return this.sketcher.onClick(ev);
      if (this.mode === 'cv') return this.cvEdit.onClick(ev);
      const hit = vp.pick(ev, this.pickFilter());
      if (this.mode === 'planePick') return hit && this.beginSketchOn(hit);
      if (this.mode === 'measure') return this.measureClick(hit, ev);
      if (this.mode === 'mate') return this.asm.click(hit);
      if (this.mode === 'paint') return this.paintClick(hit, ev);
      if (this.mode === 'dxfpick') return this.dxfPickClick(hit);
      if (this.mode === 'decalpick') return this.decals.place(hit);
      if (this.ws === 'simulate' && !this.mode) return this.sim.click(hit);
      if (this.ws === 'manufacture' && !this.mode) return this.camws.click(hit);
      if (this.mode === 'analysis') {
        if (this.analysis.mode === 'comb' && hit?.kind === 'edge') {
          const pt = this.edgeMidpoint(hit.bodyId, hit.edgeIndex) || hit.point;
          const a = this.analysis;
          const i = a.combs.findIndex((x) => x.body === hit.bodyId && this.locateEdge(x)?.edgeIndex === hit.edgeIndex);
          if (i >= 0) a.combs.splice(i, 1); else a.combs.push({ body: hit.bodyId, p: pt });
          this.updateHighlights();
          this.loadCombs();
        }
        return;
      }
      if (this.cmd) return this.onPick(hit);
      if (!hit) this.selection = [];
      else {
        const item = hit.kind === 'profile' ? { kind: 'profile', sketchId: hit.sketchId } : { kind: 'body', bodyId: hit.bodyId };
        const same = (s) => s.kind === item.kind && s.bodyId === item.bodyId && s.sketchId === item.sketchId;
        if (ev.shiftKey || ev.ctrlKey) { const i = this.selection.findIndex(same); i >= 0 ? this.selection.splice(i, 1) : this.selection.push(item); }
        else this.selection = [item];
      }
      this.selFeature = null;
      this.updateHighlights();
      this.renderLeft();
      this.renderRight();
    });
    vp.on('dblclick', (ev) => {
      if (this.sketcher.active) return this.sketcher.onDblClick(ev);
      if (this.cmd || this.mode) return;
      const hit = vp.pick(ev, new Set(['profile', 'plane']));
      if (hit?.kind === 'profile') this.editFeature(hit.sketchId);
      if (hit?.planeId) this.editFeature(hit.planeId);
    });
    vp.on('rclick', (ev) => {
      if (this.sketcher.active || this.cmd) return;
      const hit = vp.pick(ev, new Set(['body']));
      const items = [];
      if (hit?.bodyId) {
        this.selection = [{ kind: 'body', bodyId: hit.bodyId }];
        this.updateHighlights();
        this.renderRight();
        items.push(...this.bodyMenuItems(hit.bodyId), '-');
      }
      if (this.lastCmd) items.push({ label: `Repeat ${cmdInfo(this.lastCmd).label}`, icon: cmdInfo(this.lastCmd).icon, fn: () => this.runCommand(this.lastCmd) });
      items.push({ label: 'New sketch', icon: 'sketch', fn: () => this.runCommand('sketch') }, { label: 'Measure', icon: 'measure', fn: () => this.runCommand('measure') }, { label: 'Zoom to fit', icon: 'fit', fn: () => this.vp.fitAll() }, { label: 'Search commands', icon: 'search', fn: () => this.openPalette() });
      this.showCtx(ev.clientX, ev.clientY, items);
    });
  }

  bindGlobal() {
    window.addEventListener('keydown', (e) => {
      if (this.home.isOpen) return this.home.onKey(e);
      if (this.sketcher.active && this.sketcher.onKey(e)) return;
      if (this.mode === 'cv' && this.cvEdit.onKey(e)) return;
      const typing = e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement || e.target instanceof HTMLSelectElement;
      const k = e.key, mod = e.ctrlKey || e.metaKey;
      if (mod && k.toLowerCase() === 's') { e.preventDefault(); this.scheduleSave(true); return this.toast('Saved', 'ok'); }
      if (mod && k.toLowerCase() === 'k') { e.preventDefault(); return this.openPalette(); }
      if (mod && k.toLowerCase() === 'n') { e.preventDefault(); return this.home.open('templates'); }
      if (k === 'Escape') {
        if ($('#modal').classList.contains('open')) return this.closeModal();
        if (this.vp._anim) { this.vp.stopAnimation(); return this.banner(null); }
        if (this.drawing.isOpen) return this.setWorkspace('design');
        if (this.cmd) return this.cancelCommand();
        if (this.ws === 'simulate' && this.sim.pick) return this.sim.setPick(null);
        if (this.ws === 'manufacture' && this.camws.pick) { this.camws.setPick(null); return this.camws.compute(); }
        if (this.mode) return this.exitMode();
        this.selection = []; this.selFeature = null; this.updateHighlights(); this.renderLeft(); this.renderRight(); this.renderTimeline();
        return;
      }
      if (k === 'Enter' && this.cmd && !(e.target instanceof HTMLSelectElement) && !(e.target instanceof HTMLTextAreaElement && e.shiftKey)) { e.preventDefault(); return this.okCommand(); }
      if (typing) return;
      if (mod && k.toLowerCase() === 'z') { e.preventDefault(); return e.shiftKey ? this.redo() : this.undo(); }
      if (mod && k.toLowerCase() === 'y') { e.preventDefault(); return this.redo(); }
      if (mod || e.altKey || this.sketcher.active) return;
      if (k === 'F6') { e.preventDefault(); return this.vp.fitAll(); }
      if (k === 'Tab') { e.preventDefault(); return this.togglePanels(); }
      if (k === 'Delete' && this.selection.length && !this.cmd) {
        const ids = this.selection.filter((s) => s.kind === 'body').map((s) => s.bodyId);
        if (ids.length) this.addFeature('remove', { bodies: ids });
        return;
      }
      const map = { e: 'extrude', f: 'fillet', h: 'hole', m: 'move', i: 'measure', q: 'presspull', j: 'joint', k: 'sketch', a: 'appearance', v: 'cvcurve' };
      if (map[k.toLowerCase()]) return this.runCommand(map[k.toLowerCase()]);
      if (k.toLowerCase() === 's' || k === '/') { e.preventDefault(); return this.openPalette(); }
      if (k === '?') return this.openPrefs('shortcuts');
    });
    window.addEventListener('beforeunload', () => { if (this.projectId) this.saveNow(); });
    matchMedia('(prefers-color-scheme: light)').addEventListener?.('change', () => this.prefs.theme === 'system' && this.applyTheme());
  }

  addFeature(type, p) {
    this.snapshot();
    const f = { id: newFid(type), type, p: { ...defaultsFor(type, this.ctx()), ...p } };
    f.name = `${FEATURES[type].label} ${this.doc.features.filter((x) => x.type === type).length + 1}`;
    this.doc.features.splice(this.doc.marker, 0, f);
    this.doc.marker++;
    this.selection = [];
    this.changed();
  }

  // ---------------------------------------------------------------- sketch
  startSketchPick() {
    this.mode = 'planePick';
    this.vp.originPlanes.visible = true;
    this.display(this.result);
    this.banner('Select a plane or a planar face to sketch on', () => this.exitMode());
  }

  exitMode() {
    if (this.mode === 'planePick') { this.vp.originPlanes.visible = this.doc.originVisible; this.planeHover = null; this.display(this.result); }
    if (this.mode === 'measure') this.clearMeasure();
    if (this.mode === 'mate') this.asm.mate = null;
    if (this.mode === 'cv') this.cvEdit.stop();
    if (this.mode === 'dxfpick') { this.mode = null; this.display(this.result); }
    if (this.mode === 'decalpick') this.decals.placing = null;
    if (this.mode === 'explode') { this.mode = null; this.applyExplode(); }
    if (this.mode === 'thickness') { this.thick?.worker?.terminate(); this.thick = null; this.vp.setField(null); }
    if (this.mode === 'compare') { this.cmp = null; this.vp.setCompare(null); }
    if (this.mode === 'interference') { this.interGroup.clear(); this.vp.requestRender(); }
    if (this.mode === 'analysis') { this.vp.setAnalysis(null); this.combGroup?.clear(); this._curvShown = false; this.syncStyleBtn(); }
    this.mode = null;
    this.banner(null);
    this.updateHighlights();
    if (!this.cmd && !this.sketcher.active) this.renderRight();
  }

  beginSketchOn(hit) {
    let plane, planeRef;
    if (hit.planeName) { plane = structuredClone(STD_PLANES[hit.planeName]); planeRef = { type: 'std', name: hit.planeName }; }
    else if (hit.planeId) { plane = structuredClone(hit.plane); planeRef = { type: 'plane', id: hit.planeId }; }
    else if (hit.kind === 'plane') {
      plane = planeFromPointNormal(hit.point, hit.normal);
      planeRef = { type: 'face', body: hit.bodyId, p: hit.point, n: hit.normal, ...this.pickRef(hit, hit.point) };
    } else return;
    this.exitMode();
    const id = newFid('sketch');
    this.doc.counters.sketch++;
    this.enterSketch({ id, name: `Sketch ${this.doc.counters.sketch}`, plane, planeRef, data: emptySketch(), isNew: true });
  }

  enterSketch({ id, name, plane, planeRef, data, isNew, index }) {
    document.body.classList.add('sketching');
    $('#right').classList.remove('collapsed');
    this.renderTimeline();
    const restoreMarker = this.doc.marker;
    if (!isNew) this.rebuild({ features: this.doc.features.slice(0, index), forPreview: true });
    const done = () => document.body.classList.remove('sketching');
    this.sketcher.begin({
      plane, data, name,
      onFinish: (sk) => {
        done();
        this.snapshot();
        if (isNew) {
          this.doc.features.splice(this.doc.marker, 0, { id, type: 'sketch', name, p: { planeRef, plane, ...sk } });
          this.doc.marker++;
          this.toast(`${name} created — press E to extrude it`, 'ok');
        } else {
          const f = this.doc.features[index];
          delete f.p.entities;
          Object.assign(f.p, sk);
          this.doc.marker = restoreMarker;
        }
        this.changed();
      },
      onCancel: () => { done(); if (isNew) this.doc.counters.sketch--; this.rebuild(); this.renderTimeline(); },
    });
  }

  pickEdgePolyline(ev) {
    const hit = this.vp.pick(ev, new Set(['edge']));
    if (!hit || hit.kind !== 'edge') return null;
    const b = this.vp.bodies.get(hit.bodyId);
    if (!b) return null;
    const eg = b.edges.geometry, pos = eg.attributes.position.array, map = eg.userData.segEdge;
    const pts = [];
    for (let k = 0; k < map.length; k++) {
      if (map[k] !== hit.edgeIndex) continue;
      if (!pts.length) pts.push([pos[k * 6], pos[k * 6 + 1], pos[k * 6 + 2]]);
      pts.push([pos[k * 6 + 3], pos[k * 6 + 4], pos[k * 6 + 5]]);
    }
    if (pts.length < 2) return null;
    // where the edge came from, so the kernel can re-project it when the body changes (associative)
    const mid = this.edgeMidpoint(hit.bodyId, hit.edgeIndex) || pts[Math.floor(pts.length / 2)];
    let sig = null;
    try { sig = this.edgeSig(hit.bodyId, hit.edgeIndex); } catch { /* no signature */ }
    return { points: pts, bodyId: hit.bodyId, ref: { body: hit.bodyId, p: mid, ...(sig ? { s: sig } : {}) } };
  }

  editFeature(id) {
    if (this.sketcher.active) return;
    if (this.ws !== 'design') this.setWorkspace('design');
    if (this.cmd) this.cancelCommand();
    this.exitMode();
    const index = this.doc.features.findIndex((f) => f.id === id);
    const f = this.doc.features[index];
    if (f?.type === 'cvcurve') return this.startCVEdit(id);
    if (!f) return;
    if (f.type === 'sketch') {
      const solved = (this.result.sketches || []).find((x) => x.id === id);
      const m = migrateSketch(f.p);
      return this.enterSketch({ id, name: f.name, plane: solved?.plane || f.p.plane || STD_PLANES.XY, data: { points: m.points, curves: m.curves, constraints: m.constraints, dims: m.dims }, isNew: false, index });
    }
    if (f.type === 'import') return this.toast('Imported geometry has no editable parameters', 'info');
    this.openFeature(f.type, id);
  }

  // ---------------------------------------------------------------- left panel
  renderLeft() {
    const el = $('#left');
    const tabs = [['model', 'Model', 'layers'], ['params', 'Parameters', 'params'], ['history', 'Versions', 'history']];
    el.innerHTML = `<div class="panel-tabs">${tabs.map(([k, l, ic]) => `<button data-tab="${k}" class="${this.leftTab === k ? 'on' : ''}">${icon(ic)}${l}</button>`).join('')}</div><div class="panel-body" id="left-body"></div>`;
    el.querySelectorAll('[data-tab]').forEach((b) => (b.onclick = () => { this.leftTab = b.dataset.tab; this.renderLeft(); }));
    if (this.leftTab === 'model') this.renderTree();
    if (this.leftTab === 'params') this.renderParams();
    if (this.leftTab === 'history') this.renderVersions();
  }

  renderTree() {
    const doc = this.doc;
    const body = $('#left-body');
    const ids = this.result.bodies.filter((b) => !b.surface).map((b) => b.id);
    const sids = this.result.bodies.filter((b) => b.surface).map((b) => b.id);
    const selIds = new Set(this.selection.filter((s) => s.kind === 'body').map((s) => s.bodyId));
    const upto = doc.features.slice(0, doc.marker);
    const cvcurves = upto.filter((f) => f.type === 'cvcurve');
    const sketches = upto.filter((f) => f.type === 'sketch'), planes = upto.filter((f) => f.type === 'plane'), joints = upto.filter((f) => f.type === 'joint');
    const open = (this.treeOpen ||= { origin: false, bodies: true, surfaces: true, curves: true, sketches: true, construction: true, joints: true });
    const grp = (k, label, ic, n) => `<div class="node group" data-toggle="${k}"><span class="tw ${open[k] ? 'open' : ''}">${icon('chevronRight')}</span>${icon(ic)}<span class="nm">${label}</span><span class="count">${n}</span></div>`;
    const eyeBtn = (attr, id, hidden) => `<button data-${attr}="${id}" class="${hidden ? 'on' : ''}" data-tip="${hidden ? 'Show' : 'Hide'}">${icon(hidden ? 'eyeOff' : 'eye')}</button>`;
    const state = (f) => (this.lastErrors?.[f.id] ? 'err' : this.lastWarnings?.[f.id] ? 'warn' : '');
    body.innerHTML = `<div class="tree">
      ${grp('origin', 'Origin', 'cube', 3)}
      ${open.origin ? ['XY', 'XZ', 'YZ'].map((n) => `<div class="node leaf">${icon('plane')}<span class="nm">${n} plane</span><span class="acts">${eyeBtn('origin', n, !doc.originVisible)}</span></div>`).join('') : ''}
      ${grp('bodies', 'Bodies', 'boxes', ids.length)}
      ${open.bodies ? (ids.length ? ids.map((id) => { const m = this.bodyMeta(id); const hid = m.visible === false; return `<div class="node leaf ${selIds.has(id) ? 'sel' : ''} ${hid ? 'hidden' : ''}" data-body="${id}"><span class="swatch" style="background:${esc(this.appearanceOf(m).color)}"></span><span class="nm">${esc(m.name)}</span><span class="acts">${eyeBtn('bodyeye', id, hid)}<button data-bodymenu="${id}">${icon('more')}</button></span></div>`; }).join('') : '<div class="empty" style="padding:10px 18px;text-align:left">No bodies yet</div>') : ''}
      ${sids.length ? grp('surfaces', 'Surfaces', 'surfextrude', sids.length) : ''}
      ${sids.length && open.surfaces ? sids.map((id) => { const m = this.bodyMeta(id); const hid = m.visible === false; return `<div class="node leaf ${selIds.has(id) ? 'sel' : ''} ${hid ? 'hidden' : ''}" data-body="${id}"><span class="swatch surf" style="background:${esc(this.appearanceOf(m).color)}"></span><span class="nm">${esc(m.name)}</span><span class="acts">${eyeBtn('bodyeye', id, hid)}<button data-bodymenu="${id}">${icon('more')}</button></span></div>`; }).join('') : ''}
      ${cvcurves.length ? grp('curves', 'Curves', 'cvcurve', cvcurves.length) : ''}
      ${cvcurves.length && open.curves ? cvcurves.map((s) => `<div class="node leaf ${state(s)} ${s.hidden ? 'hidden' : ''} ${this.selFeature === s.id ? 'sel' : ''}" data-feat="${s.id}">${icon('cvcurve')}<span class="nm">${esc(s.name)}</span><span class="acts">${eyeBtn('feateye', s.id, s.hidden)}<button data-featmenu="${s.id}">${icon('more')}</button></span></div>`).join('') : ''}
      ${grp('sketches', 'Sketches', 'sketch', sketches.length)}
      ${open.sketches ? sketches.map((s) => `<div class="node leaf ${state(s)} ${s.hidden ? 'hidden' : ''}" data-feat="${s.id}">${icon('sketch')}<span class="nm">${esc(s.name)}</span><span class="acts">${eyeBtn('feateye', s.id, s.hidden)}<button data-featmenu="${s.id}">${icon('more')}</button></span></div>`).join('') : ''}
      ${planes.length ? grp('construction', 'Construction', 'plane2', planes.length) : ''}
      ${planes.length && open.construction ? planes.map((s) => `<div class="node leaf ${state(s)} ${s.hidden ? 'hidden' : ''}" data-feat="${s.id}">${icon('plane2')}<span class="nm">${esc(s.name)}</span><span class="acts">${eyeBtn('feateye', s.id, s.hidden)}<button data-featmenu="${s.id}">${icon('more')}</button></span></div>`).join('') : ''}
      ${joints.length ? grp('joints', 'Joints', 'joint', joints.length) : ''}
      ${joints.length && open.joints ? joints.map((s) => `<div class="node leaf ${state(s)}" data-feat="${s.id}">${icon('joint')}<span class="nm">${esc(s.name)}</span><span class="badge">${esc(s.p.type)}</span><span class="acts"><button data-featmenu="${s.id}">${icon('more')}</button></span></div>`).join('') : ''}
    </div>`;
    body.onclick = (e) => {
      const t = e.target.closest('[data-toggle]');
      if (t) { open[t.dataset.toggle] = !open[t.dataset.toggle]; return this.renderTree(); }
      const btn = e.target.closest('.acts button');
      if (btn) {
        e.stopPropagation();
        const d = btn.dataset;
        if (d.origin) { doc.originVisible = !doc.originVisible; this.vp.originPlanes.visible = doc.originVisible; this.vp.requestRender(); }
        if (d.bodyeye) { const m = this.bodyMeta(d.bodyeye); m.visible = m.visible === false; this.display(this.result); this.scheduleSave(); }
        if (d.feateye) { const f = doc.features.find((x) => x.id === d.feateye); f.hidden = !f.hidden; this.display(this.result); this.scheduleSave(); }
        if (d.bodymenu) { const r = btn.getBoundingClientRect(); return this.showCtx(r.left, r.bottom + 4, this.bodyMenuItems(d.bodymenu)); }
        if (d.featmenu) { const r = btn.getBoundingClientRect(); return this.showCtx(r.left, r.bottom + 4, this.featureMenuItems(d.featmenu)); }
        return this.renderTree();
      }
      const b = e.target.closest('[data-body]');
      if (b) {
        if (this.cmd && ['body', 'bodies'].includes(this.activeFieldDef()?.type)) return this.onPick({ kind: 'body', bodyId: b.dataset.body });
        const item = { kind: 'body', bodyId: b.dataset.body };
        this.selection = e.shiftKey || e.ctrlKey ? [...this.selection, item] : [item];
        this.updateHighlights();
        this.renderTree();
        this.renderRight();
      }
      const f = e.target.closest('[data-feat]');
      if (f && !this.cmd) { this.selFeature = f.dataset.feat; this.selection = []; this.updateHighlights(); this.renderRight(); this.renderTimeline(); }
    };
    body.ondblclick = (e) => {
      const b = e.target.closest('[data-body] .nm');
      if (b) return this.renameBody(b.closest('[data-body]').dataset.body);
      const s = e.target.closest('[data-feat]');
      if (s) this.editFeature(s.dataset.feat);
    };
    body.oncontextmenu = (e) => {
      const b = e.target.closest('[data-body]'), s = e.target.closest('[data-feat]');
      if (!b && !s) return;
      e.preventDefault();
      this.showCtx(e.clientX, e.clientY, b ? this.bodyMenuItems(b.dataset.body) : this.featureMenuItems(s.dataset.feat));
    };
  }

  renderParams() {
    const body = $('#left-body');
    const draw = () => {
      const { vars, errors } = evalParams(this.effectiveParams(), this.units.scale);
      const cfg = this.activeConfig(), cfgs = this.doc.configs || [];
      body.innerHTML = `<div class="insp">
        <div class="insp-sec cfg-bar"><h4>${icon('configs')}Configuration</h4>
          <div style="display:flex;gap:6px"><select class="input" data-cfg style="flex:1"><option value="">Default</option>${cfgs.map((c) => `<option value="${c.id}" ${cfg?.id === c.id ? 'selected' : ''}>${esc(c.name)}</option>`).join('')}</select>
          <button class="btn sm" data-cfgtable data-tip="Configuration table" data-desc="Edit parameter values for every variant">${icon('grid')}Table</button></div>
          ${cfg ? `<p class="muted" style="margin:8px 0 0;font-size:12px">Values marked <span class="badge cfg">${esc(cfg.name)}</span> come from this configuration. Edits here change the Default values.</p>` : ''}
        </div>
        <p class="muted" style="margin-top:12px">Named values used in any field or sketch dimension, e.g. <code>width / 2 + 3</code>. Plain numbers are in ${this.units.label}.</p>
        ${this.doc.params.map((p, i) => `<div class="insp-sec" style="padding:10px 0">
          <div style="display:flex;gap:6px;align-items:center;margin-bottom:6px">
            <input class="input" data-i="${i}" data-f="name" value="${esc(p.name)}" style="font-weight:600;flex:1" spellcheck="false">
            <select class="input" data-i="${i}" data-f="unit" style="width:70px">${[['', this.units.label], ['deg', '°'], ['none', '—']].map(([v, l]) => `<option value="${v}" ${(p.unit || '') === v ? 'selected' : ''}>${l}</option>`).join('')}</select>
            <button class="iconbtn" data-del="${i}" data-tip="Delete parameter">${icon('trash')}</button></div>
          <div style="display:flex;gap:6px;align-items:center"><input class="input ${errors[p.name] ? 'bad' : ''}" data-i="${i}" data-f="expr" value="${esc(p.expr)}" spellcheck="false" style="flex:1;font-family:var(--mono);font-size:12px">
            ${cfg && cfg.values?.[p.name] != null && cfg.values[p.name] !== '' ? `<span class="badge cfg" data-tip="Set by ${esc(cfg.name)}: ${esc(cfg.values[p.name])}">${esc(cfg.name)}</span>` : ''}
            <span class="badge" style="min-width:64px;text-align:right" data-val="${i}">${errors[p.name] ? '⚠' : p.unit === 'none' || p.unit === 'deg' ? fmt(vars[p.name], 3) : fmt(vars[p.name] / this.units.scale, 3)}</span></div>
          <input class="input" data-i="${i}" data-f="comment" value="${esc(p.comment || '')}" placeholder="Comment" style="margin-top:6px;height:26px;font-size:12px;border-color:transparent;background:transparent">
        </div>`).join('') || '<div class="empty">' + icon('params') + 'No parameters yet.<br>Add one to drive your design.</div>'}
        <button class="btn" data-add style="width:100%;margin-top:10px">${icon('plus')}Add parameter</button></div>`;
      body.querySelector('[data-add]').onclick = () => {
        this.snapshot();
        let n = 1;
        while (this.doc.params.some((p) => p.name === `d${n}`)) n++;
        this.doc.params.push({ name: `d${n}`, expr: '10', comment: '' });
        draw();
        this.scheduleSave();
      };
      body.querySelectorAll('[data-del]').forEach((b) => (b.onclick = () => { this.snapshot(); this.doc.params.splice(+b.dataset.del, 1); draw(); this.changed(); }));
      body.querySelector('[data-cfg]').onchange = (e) => this.setConfig(e.target.value || null);
      body.querySelector('[data-cfgtable]').onclick = () => this.openConfigTable();
    };
    draw();
    let before = null;
    body.onfocusin = () => { before ||= JSON.stringify(this.doc.params); };
    body.oninput = (e) => {
      const i = e.target.dataset.i;
      if (i === undefined) return;
      const prm = this.doc.params[+i];
      if (e.target.dataset.f === 'name' && !isValidName(e.target.value)) { e.target.classList.add('bad'); return; }
      e.target.classList.remove('bad');
      prm[e.target.dataset.f] = e.target.value;
      clearTimeout(this._prmT);
      this._prmT = setTimeout(() => {
        const { vars, errors } = evalParams(this.effectiveParams(), this.units.scale);
        this.doc.params.forEach((p, j) => {
          const v = body.querySelector(`[data-val="${j}"]`);
          if (v) v.textContent = errors[p.name] ? '⚠' : fmt(p.unit ? vars[p.name] : vars[p.name] / this.units.scale, 3);
        });
        this.rebuild();
        this.scheduleSave();
      }, 250);
    };
    body.onchange = (e) => {
      if (e.target.dataset.f === 'unit') { this.doc.params[+e.target.dataset.i].unit = e.target.value || undefined; this.changed(); draw(); }
      if (before && before !== JSON.stringify(this.doc.params)) { this.undoStack.push(JSON.stringify({ ...this.doc, params: JSON.parse(before) })); this.redoStack = []; }
      before = null;
    };
  }

  async renderVersions() {
    const body = $('#left-body');
    body.innerHTML = `<div class="insp"><div class="insp-sec"><button class="btn primary" data-save style="width:100%">${icon('history')}Save version</button>
      <p class="muted" style="margin-top:10px">Versions are snapshots you can restore later. Your work is also autosaved continuously.</p></div><div id="vlist"></div></div>`;
    body.querySelector('[data-save]').onclick = () => this.saveVersion();
    if (!this.projectId) return;
    const vs = await store.listVersions(this.projectId);
    const list = body.querySelector('#vlist');
    if (!list) return;
    list.innerHTML = vs.length ? vs.map((v) => `<div class="card" style="margin-bottom:10px;cursor:default" data-v="${v.id}">
        <div class="thumb" style="aspect-ratio:16/8">${v.thumb ? `<img src="${v.thumb}">` : icon('cube')}</div>
        <div class="meta" style="display:flex;align-items:center;gap:8px"><div style="flex:1;min-width:0"><b>${esc(v.label)}</b><small>${new Date(v.time).toLocaleString()} · ${v.doc.features.length} features</small></div>
        <button class="btn sm" data-compare="${v.id}" data-tip="Compare with the current design">${icon('compare')}Compare</button><button class="btn sm" data-restore="${v.id}">${icon('reset')}Restore</button></div></div>`).join('')
      : `<div class="empty">${icon('clock')}No saved versions yet</div>`;
    list.querySelectorAll('[data-compare]').forEach((b) => (b.onclick = async () => this.startCompare(await store.getVersion(b.dataset.compare))));
    list.querySelectorAll('[data-restore]').forEach((b) => (b.onclick = async () => {
      const v = await store.getVersion(b.dataset.restore);
      this.loadDoc(v.doc);
      this.toast(`Restored "${v.label}"`, 'ok');
    }));
  }

  saveVersion() {
    if (!this.projectId) return this.toast('Open a project first', 'warn');
    const n = new Date();
    this.prompt('Save version', `Version ${n.toLocaleDateString()} ${n.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`, async (label) => {
      if (!label) return;
      await store.addVersion(this.projectId, label, structuredClone(this.doc), this.vp.thumbnail());
      this.toast(`Saved version "${label}"`, 'ok');
      this.leftTab = 'history';
      this.renderLeft();
    });
  }

  async duplicateProject() {
    const doc = structuredClone(this.doc);
    doc.name = `${doc.name} (copy)`;
    await this.createProject(doc);
    this.toast('Project duplicated', 'ok');
  }

  bodyMenuItems(id) {
    const sel = () => { this.selection = [{ kind: 'body', bodyId: id }]; this.updateHighlights(); };
    return [
      { label: 'Rename', icon: 'pencil', fn: () => this.renameBody(id) },
      { label: 'Properties & material', icon: 'props', fn: () => { sel(); this.renderRight(); } },
      { label: 'Edit appearance…', icon: 'appearance', fn: () => { sel(); this.runCommand('appearance'); } },
      { label: 'Paint faces…', icon: 'bucket', fn: () => { sel(); this.runCommand('appearance'); this.paint.target = 'face'; this.paint.applyTo = null; this.bannerPaint(); this.renderRight(); } },
      { label: 'Move / copy', icon: 'move', fn: () => { sel(); this.runCommand('move'); } },
      { label: this.bodyMeta(id).visible === false ? 'Show' : 'Hide', icon: 'eye', fn: () => { const m = this.bodyMeta(id); m.visible = m.visible === false; this.display(this.result); this.renderLeft(); } },
      '-',
      { label: 'Export STEP', icon: 'export', fn: () => this.exportBodies('step', [id]) },
      { label: 'Export STL', icon: 'export', fn: () => this.exportBodies('stl', [id]) },
      '-',
      { label: 'Remove body', icon: 'trash', danger: true, fn: () => this.addFeature('remove', { bodies: [id] }) },
    ];
  }

  renameBody(id) {
    const m = this.bodyMeta(id);
    this.prompt('Rename body', m.name, (v) => { if (v) { this.snapshot(); m.name = v; this.changed(); } });
  }

  // ---------------------------------------------------------------- right panel (inspector)
  renderRight() {
    if (this.sketcher.active) return;
    if (this.booting) {
      $('#right').innerHTML = `<div class="empty" style="margin-top:40px"><span class="savestate saving" style="justify-content:center;font-size:12.5px">${icon('spinner')}Loading geometry kernel…</span></div>`;
      return;
    }
    if (this.cmd) return this.renderDialog();
    if (this.ws === 'simulate' && !this.mode) return this.sim.panel($('#right'));
    if (this.ws === 'manufacture' && !this.mode) return this.camws.panel($('#right'));
    const el = $('#right');
    if (this.mode === 'measure') return this.renderMeasurePanel();
    if (this.mode === 'mate') return this.asm.matePanel(el);
    if (this.mode === 'assembly') return this.asm.panel(el);
    if (this.mode === 'explode') return this.renderExplodePanel();
    if (this.mode === 'thickness') return this.renderThicknessPanel();
    if (this.mode === 'compare') return this.renderComparePanel();
    if (this.mode === 'section') return this.renderSectionPanel();
    if (this.mode === 'interference') return this.renderInterferencePanel();
    if (this.mode === 'paint') return this.renderPaintPanel();
    if (this.mode === 'cv') return this.cvEdit.panel();
    if (this.mode === 'analysis') return this.renderAnalysisPanel();
    if (this.ws === 'render') return this.renderRenderPanel();
    const bodySel = this.selection.filter((s) => s.kind === 'body').map((s) => s.bodyId).filter((id) => this.result.bodies.some((b) => b.id === id));
    if (bodySel.length) return this.renderBodyPanel(bodySel);
    const prof = this.selection.find((s) => s.kind === 'profile');
    if (prof) return this.renderProfilePanel(prof.sketchId);
    if (this.selFeature && this.doc.features.some((f) => f.id === this.selFeature)) return this.renderFeaturePanel(this.selFeature);
    // document overview
    const doc = this.doc;
    el.innerHTML = `
      <div class="panel-head">${icon('cube')}<h3>${esc(doc.name)}<small>Part design · ${this.units.label}</small></h3></div>
      <div class="panel-body"><div class="insp">
        <div class="insp-sec"><div class="stat-grid">
          <div class="stat"><small>Bodies</small><b>${this.result.bodies.length}</b></div>
          <div class="stat"><small>Features</small><b>${doc.features.length}</b></div>
          <div class="stat"><small>Sketches</small><b>${doc.features.filter((f) => f.type === 'sketch').length}</b></div>
          <div class="stat"><small>Parameters</small><b>${doc.params.length}</b></div>
        </div></div>
        <div class="insp-sec"><h4>Quick start</h4><div class="stat-grid">
          ${['sketch', 'extrude', 'box', 'cylinder', 'import', 'measure'].map((c) => `<button class="btn" data-q="${c}" style="justify-content:flex-start">${icon(cmdInfo(c).icon)}${cmdInfo(c).label}</button>`).join('')}
        </div></div>
        <div class="insp-sec"><h4>Document</h4>
          <div class="field"><label>Units</label><select class="input" data-units>${Object.keys(UNITS_TABLE).map((u) => `<option ${u === doc.units ? 'selected' : ''}>${u}</option>`).join('')}</select></div>
        </div>
        <div class="insp-sec"><h4>${icon('keyboard')} Tips</h4><div class="help">
          Click a body to see its properties. Double-click timeline items to edit them.<br>
          <kbd>K</kbd> sketch · <kbd>E</kbd> extrude · <kbd>F</kbd> fillet · <kbd>Q</kbd> press pull · <kbd>Ctrl K</kbd> search · <kbd>Tab</kbd> hide panels
        </div></div>
      </div></div>`;
    el.querySelectorAll('[data-q]').forEach((b) => (b.onclick = () => this.runCommand(b.dataset.q)));
    el.querySelector('[data-units]').onchange = (e) => this.setUnits(e.target.value);
  }

  async renderBodyPanel(ids) {
    const el = $('#right');
    const id = ids[0];
    const meta = this.bodyMeta(id);
    const mat = MATERIALS[meta.material] || MATERIALS[DEFAULT_MATERIAL];
    const { look, color } = this.appearanceOf(meta);
    this.matCat ||= {};
    const matCat = this.matCat[id] || mat.cat || 'Metal';
    const isSurf = !!this.result.bodies.find((b) => b.id === id)?.surface;
    el.innerHTML = `
      <div class="panel-head"><span class="swatch" style="width:22px;height:22px;border-radius:7px;background:${esc(color)}"></span><h3><input class="input" data-name value="${esc(meta.name)}" style="height:26px;font-weight:650;border-color:transparent;background:transparent;padding:0 4px">${ids.length > 1 ? `<small>+${ids.length - 1} more selected</small>` : `<small>${isSurf ? 'Surface body · open shell' : 'Solid body'}</small>`}</h3>
        <button class="iconbtn" data-act="vis" data-tip="${meta.visible === false ? 'Show' : 'Hide'}">${icon(meta.visible === false ? 'eyeOff' : 'eye')}</button></div>
      <div class="panel-body"><div class="insp">
        <div class="insp-sec"><h4>Physical properties</h4><div class="stat-grid" id="bprops">
          ${['Mass', 'Volume', 'Surface area', 'Size'].map((k) => `<div class="stat"><small>${k}</small><b style="opacity:.4">…</b></div>`).join('')}</div>
          <dl class="kv" id="bkv" style="margin-top:10px"></dl></div>
        <div class="insp-sec"><h4>Appearance</h4>
          <div class="look-cur clickable" data-look><span class="ball" style="background:${lookBall(look)}"></span><div><b>${esc(meta.look || meta.color ? look.name || 'Custom' : mat.name)}</b><small>${meta.look || meta.color ? 'Override' : 'From material'}${meta.faces?.length ? ` · ${meta.faces.length} painted face${meta.faces.length === 1 ? '' : 's'}` : ''}</small></div>${icon('chevronRight')}</div>
          <div class="swatches sm" style="margin-top:10px">${PALETTE.slice(0, 12).map((c) => `<button data-sw="${c}" style="background:${c}" class="${c.toLowerCase() === String(look.color).toLowerCase() ? 'on' : ''}"></button>`).join('')}</div>
          <div style="display:flex;gap:6px;margin-top:10px"><button class="btn sm" data-look2 style="flex:1">${icon('appearance')}Edit appearance</button><button class="btn sm" data-paintf style="flex:1">${icon('bucket')}Paint faces</button>${meta.look || meta.color || meta.faces?.length ? `<button class="iconbtn" data-reset data-tip="Reset to material">${icon('reset')}</button>` : ''}</div>
        </div>
        <div class="insp-sec"><h4>Physical material · ${esc(mat.name)}</h4>
          <div class="seg full" data-mcat style="margin-bottom:8px">${MATERIAL_CATS.map((c) => `<button data-v="${c}" class="${matCat === c ? 'on' : ''}">${c === 'Elastomer' ? 'Rubber' : c === 'Composite' ? 'Comp.' : c}</button>`).join('')}</div>
          <div class="mat-grid">${Object.entries(MATERIALS).filter(([, v]) => v.cat === matCat).map(([k, v]) => `<button data-mat="${k}" class="${meta.material === k ? 'on' : ''}" data-tip="${v.name}" data-desc="${v.density} g/cm³"><span class="ball" style="background:${lookBall(v)}"></span>${esc(v.name.replace(/ \(.*\)/, '').split(' ').slice(0, 2).join(' ').replace('Stainless Steel', 'Stainless').replace('Aluminum', 'Alu'))}</button>`).join('')}</div>
        </div>
        ${isSurf ? `<div class="insp-sec"><h4>Surface tools</h4><div class="stat-grid">
          <button class="btn sm" data-sa="thicken">${icon('thicken')}Thicken</button>
          <button class="btn sm" data-sa="stitch">${icon('stitch')}Stitch</button>
          <button class="btn sm" data-sa="curvmap">${icon('curvmap')}Curvature</button>
          <button class="btn sm" data-sa="zebra">${icon('zebra')}Zebra</button>
          ${(this.result.cvgrids || []).some((g) => g.id === id) ? `<button class="btn sm primary" data-sa="editcv" style="grid-column:span 2">${icon('editcv')}Edit CVs</button>` : `<button class="btn sm" data-sa="rebuildcv" style="grid-column:span 2">${icon('rebuildcv')}Rebuild as CV surface</button>`}</div></div>` : ''}
        <div class="insp-sec"><h4>Actions</h4><div class="stat-grid">
          <button class="btn sm" data-a="move">${icon('move')}Move</button>
          <button class="btn sm" data-a="mirror">${icon('mirror')}Mirror</button>
          <button class="btn sm" data-a="step">${icon('export')}STEP</button>
          <button class="btn sm" data-a="stl">${icon('export')}STL</button>
          <button class="btn sm danger" data-a="remove" style="grid-column:span 2">${icon('trash')}Remove body</button>
        </div></div>
      </div></div>`;
    el.querySelector('[data-name]').onchange = (e) => { this.snapshot(); meta.name = e.target.value.trim() || meta.name; this.changed(); };
    el.querySelector('[data-act=vis]').onclick = () => { meta.visible = meta.visible === false; this.display(this.result); this.renderLeft(); this.renderRight(); this.scheduleSave(); };
    el.querySelectorAll('[data-mat]').forEach((b) => (b.onclick = () => {
      this.snapshot();
      for (const i of ids) { const m = this.bodyMeta(i); m.material = b.dataset.mat; }
      if (ids.some((i) => this.bodyMeta(i).look)) this.toast('Material set — the appearance override is kept. Reset the appearance to show the material look.', 'info');
      this.display(this.result); this.renderLeft(); this.renderRight(); this.scheduleSave();
    }));
    el.querySelectorAll('[data-sa]').forEach((b) => (b.onclick = () => {
      const a = b.dataset.sa;
      if (a === 'thicken') this.openFeature('thicken', null, { body: id });
      else if (a === 'stitch') this.openFeature('stitch', null, { bodies: ids.slice() });
      else if (a === 'editcv') this.startCVEdit(id);
      else if (a === 'rebuildcv') this.openFeature('cvsurface', null, { source: 'face' });
      else this.runCommand(a);
    }));
    el.querySelectorAll('[data-mcat] button').forEach((b) => (b.onclick = () => { this.matCat[id] = b.dataset.v; this.renderRight(); }));
    el.querySelectorAll('[data-sw]').forEach((b) => (b.onclick = () => {
      this.snapshot();
      for (const i of ids) { const m = this.bodyMeta(i); const cur = this.appearanceOf(m).look; m.look = { ...cur, color: b.dataset.sw, name: `${(FINISHES[cur.finish] || { name: 'Custom' }).name} ${b.dataset.sw.toUpperCase()}` }; delete m.color; }
      this.display(this.result); this.renderLeft(); this.renderRight(); this.scheduleSave();
    }));
    el.querySelector('[data-look]').onclick = () => this.startPaint();
    el.querySelector('[data-look2]').onclick = () => this.startPaint();
    el.querySelector('[data-paintf]').onclick = () => { this.paint ||= { look: { ...look }, target: 'face', cat: 'Paint' }; this.paint.look = { ...look }; this.startPaint('face'); };
    el.querySelector('[data-reset]')?.addEventListener('click', () => { this.snapshot(); for (const i of ids) { const m = this.bodyMeta(i); delete m.color; delete m.look; delete m.faces; } this.display(this.result); this.renderLeft(); this.renderRight(); this.scheduleSave(); });
    el.querySelectorAll('[data-a]').forEach((b) => (b.onclick = () => {
      const a = b.dataset.a;
      if (a === 'move' || a === 'mirror') this.runCommand(a);
      if (a === 'step' || a === 'stl') this.exportBodies(a, ids);
      if (a === 'remove') this.addFeature('remove', { bodies: ids });
    }));
    // physical properties from the kernel (cached per build)
    let pr = this.propsCache.get(id);
    if (!pr) {
      try { pr = (await this.kernel.props(id)).props; this.propsCache.set(id, pr); } catch { return; }
    }
    if (!$('#bprops') || this.selection[0]?.bodyId !== id) return;
    const [lo, hi] = pr.bbox;
    const mass = (pr.volume / 1000) * mat.density;
    if (isSurf) {
      $('#bprops').innerHTML = `
      <div class="stat"><small>Surface area</small><b>${this.area(pr.area)}</b></div>
      <div class="stat"><small>Type</small><b>Open shell</b></div>`;
      $('#bkv').innerHTML = `<dt>Size X × Y × Z</dt><dd>${[0, 1, 2].map((i) => fmt((hi[i] - lo[i]) / this.units.scale, 2)).join(' × ')} ${this.units.label}</dd>`;
      return;
    }
    $('#bprops').innerHTML = `
      <div class="stat"><small>Mass</small><b>${fmt(mass, mass < 10 ? 2 : 1)} g</b></div>
      <div class="stat"><small>Volume</small><b>${this.vol(pr.volume)}</b></div>
      <div class="stat"><small>Surface area</small><b>${this.area(pr.area)}</b></div>
      <div class="stat"><small>Density</small><b>${mat.density} g/cm³</b></div>`;
    $('#bkv').innerHTML = `<dt>Size X × Y × Z</dt><dd>${[0, 1, 2].map((i) => fmt((hi[i] - lo[i]) / this.units.scale, 2)).join(' × ')} ${this.units.label}</dd>
      <dt>Center of mass</dt><dd>${pr.centerOfMass.map((v) => fmt(v / this.units.scale, 2)).join(', ')}</dd>`;
  }

  renderProfilePanel(sketchId) {
    const f = this.doc.features.find((x) => x.id === sketchId);
    const el = $('#right');
    el.innerHTML = `<div class="panel-head">${icon('sketch')}<h3>${esc(f?.name || 'Sketch')}<small>Sketch profile</small></h3></div>
      <div class="panel-body"><div class="insp"><div class="insp-sec"><h4>Make it solid</h4><div class="stat-grid">
        ${['extrude', 'revolve', 'sweep', 'loft'].map((c) => `<button class="btn" data-c="${c}" style="justify-content:flex-start">${icon(cmdInfo(c).icon)}${cmdInfo(c).label}</button>`).join('')}</div></div>
        <div class="insp-sec"><button class="btn" data-edit style="width:100%">${icon('pencil')}Edit sketch</button></div></div></div>`;
    el.querySelectorAll('[data-c]').forEach((b) => (b.onclick = () => this.runCommand(b.dataset.c)));
    el.querySelector('[data-edit]').onclick = () => this.editFeature(sketchId);
  }

  renderFeaturePanel(fid) {
    const i = this.doc.features.findIndex((f) => f.id === fid);
    const f = this.doc.features[i];
    const def = FEATURES[f.type];
    const err = this.lastErrors?.[fid], warn = this.lastWarnings?.[fid];
    const el = $('#right');
    el.innerHTML = `<div class="panel-head">${icon(def.icon)}<h3>${esc(f.name || def.label)}<small>${def.label} · step ${i + 1} of ${this.doc.features.length}</small></h3></div>
      <div class="panel-body"><div class="insp">
        ${err ? `<div class="dlg-err" style="display:block">${esc(err)}</div>` : warn ? `<div class="dlg-err" style="display:block;color:var(--warn);border-color:var(--warn);background:rgba(245,165,36,.08)">${esc(warn)}</div>` : '<div class="sk-status ok"><div class="ring">✓</div><div><b>Healthy</b><small>This feature rebuilt without problems</small></div></div>'}
        <div class="insp-sec"><div class="stat-grid">
          <button class="btn" data-a="edit">${icon('pencil')}Edit</button>
          <button class="btn" data-a="supp">${icon(f.suppressed ? 'eye' : 'eyeOff')}${f.suppressed ? 'Unsuppress' : 'Suppress'}</button>
          <button class="btn" data-a="roll">${icon('stepBack')}Roll to here</button>
          <button class="btn danger" data-a="del">${icon('trash')}Delete</button>
        </div></div></div></div>`;
    const items = this.featureMenuItems(fid);
    el.querySelector('[data-a=edit]').onclick = () => this.editFeature(fid);
    el.querySelector('[data-a=supp]').onclick = items.find((x) => /uppress/.test(x.label || '')).fn;
    el.querySelector('[data-a=roll]').onclick = items.find((x) => /Roll/.test(x.label || '')).fn;
    el.querySelector('[data-a=del]').onclick = items.find((x) => x.label === 'Delete').fn;
  }

  renderRenderPanel() {
    const el = $('#right');
    const vp = this.vp;
    el.innerHTML = `<div class="panel-head">${icon('render')}<h3>Render<small>Lighting, materials and image capture</small></h3></div>
      <div class="panel-body"><div class="insp">
        <div class="insp-sec"><h4>Environment</h4><div class="rd-grid">${ENVS.map(([k, l, g]) => `<button class="envbtn ${vp.envName === k ? 'on' : ''}" data-env="${k}" style="background:${g}">${l}</button>`).join('')}</div>
          <div class="field" style="margin-top:12px"><label>Exposure</label><input type="range" min="0.4" max="2" step="0.05" value="${vp.renderer.toneMappingExposure}" data-exp></div>
          <div class="field"><label>Background</label><select class="input" data-bg>${[['gradient', 'Gradient'], ['env', 'Environment'], ['solid', 'Solid color'], ['transparent', 'Transparent']].map(([v, l]) => `<option value="${v}" ${(vp.bgMode || 'gradient') === v ? 'selected' : ''}>${l}</option>`).join('')}</select></div>
          ${vp.bgMode === 'solid' ? `<div class="field"><label>Color</label><input type="color" data-bgc value="${this._bgColor || '#ffffff'}"></div>` : ''}
          <div class="field check"><label>Ground shadows</label><label class="switch"><input type="checkbox" data-sh ${this.prefs.shadows ? 'checked' : ''}><span></span></label></div>
          <div class="field check"><label>Show grid</label><label class="switch"><input type="checkbox" data-gr ${vp.renderGrid ? 'checked' : ''}><span></span></label></div>
        </div>
        <div class="insp-sec"><h4>Appearances<button class="btn sm ghost" data-ap style="margin-left:auto;height:22px">${icon('appearance')}Editor</button></h4>${this.result.bodies.map((b) => { const m = this.bodyMeta(b.id); return `<div class="field"><label style="display:flex;gap:8px;align-items:center"><span class="swatch" style="background:${esc(this.appearanceOf(m).color)}"></span>${esc(m.name)}</label><select class="input" data-bm="${b.id}">${Object.entries(MATERIALS).map(([k, v]) => `<option value="${k}" ${m.material === k ? 'selected' : ''}>${v.name}</option>`).join('')}</select></div>`; }).join('') || '<p class="muted">No bodies.</p>'}</div>
        ${this.result.bodies.length > 1 ? `<div class="insp-sec"><h4>Exploded view</h4>
          <div class="field check"><label>Explode the assembly</label><label class="switch"><input type="checkbox" data-ex ${this.explode.render ? 'checked' : ''}><span></span></label></div>
          ${this.explode.render ? `<div class="field"><label>Distance</label><input type="range" min="0" max="1.5" step="0.01" value="${this.explode.amount}" data-exa></div>` : ''}</div>` : ''}
        <div class="insp-sec"><h4>Capture</h4>
          <div class="field"><label>Resolution</label><select class="input" data-res>${[['1', 'Viewport (1×)'], ['2', 'High (2×)'], ['4k', '4K · 3840 × 2160'], ['sq', 'Square · 2048 × 2048']].map(([v, l]) => `<option value="${v}">${l}</option>`).join('')}</select></div>
          <div class="field check"><label>Transparent background</label><label class="switch"><input type="checkbox" data-tr><span></span></label></div>
          <button class="btn primary" data-cap style="width:100%;margin-top:6px">${icon('camera')}Capture image</button>
        </div>
        <div class="insp-sec"><h4>Turntable video</h4>
          <div class="field"><label>Size</label><select class="input" data-vres>${[['1920x1080', '1080p · 1920 × 1080'], ['1280x720', '720p · 1280 × 720'], ['1080x1080', 'Square · 1080 × 1080'], ['1080x1920', 'Vertical · 1080 × 1920']].map(([v, l]) => `<option value="${v}">${l}</option>`).join('')}</select></div>
          <div class="field"><label>Length</label><select class="input" data-vlen>${[[4, '4 seconds'], [6, '6 seconds'], [10, '10 seconds'], [15, '15 seconds']].map(([v, l]) => `<option value="${v}" ${v === 6 ? 'selected' : ''}>${l}</option>`).join('')}</select></div>
          <button class="btn" data-vid style="width:100%;margin-top:6px">${icon('play')}Record video</button>
        </div>
      </div></div>`;
    el.querySelectorAll('[data-env]').forEach((b) => (b.onclick = () => { vp.setEnvironment(b.dataset.env); this.renderRight(); this.renderToolbar(); }));
    el.querySelector('[data-exp]').oninput = (e) => vp.setExposure(+e.target.value);
    el.querySelector('[data-bg]').onchange = (e) => {
      const v = e.target.value;
      vp.setBackground(v === 'gradient' || v === 'transparent' ? 'none' : v, this._bgColor || '#ffffff');
      vp.bgMode = v;
      $('#viewport').style.background = v === 'transparent' ? 'repeating-conic-gradient(#8883 0% 25%, transparent 0% 50%) 50% / 20px 20px' : '';
      this.renderRight();
    };
    el.querySelector('[data-bgc]')?.addEventListener('input', (e) => { this._bgColor = e.target.value; vp.setBackground('solid', e.target.value); vp.bgMode = 'solid'; });
    el.querySelector('[data-sh]').onchange = (e) => { this.setPref('shadows', e.target.checked); this.renderToolbar(); };
    el.querySelector('[data-gr]').onchange = (e) => { vp.renderGrid = e.target.checked; vp.grid.visible = e.target.checked; vp.requestRender(); };
    el.querySelectorAll('[data-bm]').forEach((s) => (s.onchange = () => { const m = this.bodyMeta(s.dataset.bm); m.material = s.value; delete m.color; delete m.look; this.display(this.result); this.renderRight(); this.scheduleSave(); }));
    el.querySelector('[data-ap]').onclick = () => { this.setWorkspace('design'); this.startPaint(); };
    el.querySelector('[data-vid]').onclick = () => { const [w, h] = el.querySelector('[data-vres]').value.split('x').map(Number); this.recordVideo(+el.querySelector('[data-vlen]').value, w, h); };
    el.querySelector('[data-cap]').onclick = () => this.captureImage(el.querySelector('[data-res]').value, el.querySelector('[data-tr]').checked);
    el.querySelector('[data-ex]')?.addEventListener('change', (e) => { this.explode.render = e.target.checked; this.scheduleSave(); this.applyExplode(); this.renderRight(); });
    el.querySelector('[data-exa]')?.addEventListener('input', (e) => { this.explode.amount = +e.target.value; this.applyExplode(); });
    el.querySelector('[data-exa]')?.addEventListener('change', () => this.scheduleSave());
  }

  captureImage(res = '2', transparent = false) {
    const opts = res === '4k' ? { scale: 2, width: 3840, height: 2160 } : res === 'sq' ? { scale: 2, width: 2048, height: 2048 } : { scale: +res };
    const url = this.vp.capture({ ...opts, transparent: transparent || this.vp.bgMode === 'transparent' });
    fetch(url).then((r) => r.blob()).then((b) => this.download(b, `${this.doc.name}.png`));
    this.toast('Image captured', 'ok');
  }

  // ---------------------------------------------------------------- timeline
  renderTimeline() {
    const doc = this.doc;
    const errs = this.lastErrors || {}, warns = this.lastWarnings || {};
    const tl = $('#timeline');
    const items = doc.features.map((f, i) => {
      const def = FEATURES[f.type];
      const after = i >= doc.marker;
      const cls = [after && 'rolled', f.suppressed && 'supp', !after && errs[f.id] && 'err', !after && !errs[f.id] && warns[f.id] && 'warn', this.cmd?.editId === f.id && 'editing', this.selFeature === f.id && 'sel'].filter(Boolean).join(' ');
      const cat = f.type === 'sketch' ? 'sketch' : def.group;
      return `<div class="tl-item ${cls}" style="--gc:${CATEGORY_COLORS[cat] || CATEGORY_COLORS.insert}" data-fid="${f.id}" data-tip="${esc(f.name || def.label)}" data-desc="${esc(errs[f.id] || warns[f.id] || 'Double-click to edit · right-click for options')}">${icon(def.icon)}</div>`;
    });
    items.splice(doc.marker, 0, '<div class="tl-marker" draggable="true" data-tip="History marker" data-desc="Drag to roll the model back"></div>');
    tl.innerHTML = `
      <div class="tl-ctrls">
        <button class="iconbtn" data-tl="start" data-tip="Go to start">${icon('toStart')}</button>
        <button class="iconbtn" data-tl="back" data-tip="Step back">${icon('stepBack')}</button>
        <button class="iconbtn" data-tl="play" data-tip="Play history">${icon('play')}</button>
        <button class="iconbtn" data-tl="fwd" data-tip="Step forward">${icon('stepFwd')}</button>
        <button class="iconbtn" data-tl="end" data-tip="Go to end">${icon('toEnd')}</button>
      </div>
      <div class="tl-track">${items.join('') || '<span class="tl-info" style="padding-left:8px">Your modelling history will appear here</span>'}</div>
      <div class="tl-info">${doc.marker} / ${doc.features.length}</div>`;
    tl.querySelector('.tl-ctrls').onclick = async (e) => {
      const a = e.target.closest('[data-tl]')?.dataset.tl;
      if (!a || this.cmd || this.sketcher.active) return;
      const n = doc.features.length;
      if (a === 'play') { for (let m = 0; m <= n; m++) { doc.marker = m; this.renderTimeline(); await this.rebuild(); await wait(260); } return; }
      doc.marker = a === 'start' ? 0 : a === 'end' ? n : a === 'back' ? Math.max(0, doc.marker - 1) : Math.min(n, doc.marker + 1);
      this.changed();
      this.renderVpInfo();
    };
    const track = tl.querySelector('.tl-track');
    track.onclick = (e) => {
      const it = e.target.closest('[data-fid]');
      if (!it || this.cmd || this.sketcher.active) return;
      this.selFeature = it.dataset.fid;
      this.selection = [];
      this.updateHighlights();
      this.renderTimeline();
      this.renderRight();
    };
    track.ondblclick = (e) => { const it = e.target.closest('[data-fid]'); if (it) this.editFeature(it.dataset.fid); };
    track.oncontextmenu = (e) => { const it = e.target.closest('[data-fid]'); if (!it) return; e.preventDefault(); this.showCtx(e.clientX, e.clientY, this.featureMenuItems(it.dataset.fid)); };
    const marker = track.querySelector('.tl-marker');
    if (marker) marker.ondragstart = (e) => { e.dataTransfer.setData('text/plain', 'marker'); e.dataTransfer.effectAllowed = 'move'; };
    track.ondragover = (e) => e.preventDefault();
    track.ondrop = (e) => {
      e.preventDefault();
      if (this.cmd || this.sketcher.active) return;
      const els = [...track.querySelectorAll('.tl-item')];
      let m = els.length;
      for (let i = 0; i < els.length; i++) { const r = els[i].getBoundingClientRect(); if (e.clientX < r.left + r.width / 2) { m = i; break; } }
      doc.marker = m;
      this.changed();
    };
    track.scrollLeft = track.scrollWidth;
    this.renderVpInfo();
  }

  featureMenuItems(fid) {
    const doc = this.doc;
    const i = doc.features.findIndex((f) => f.id === fid);
    const f = doc.features[i];
    return [
      ...(f.type === 'cvcurve' || f.type === 'cvsurface' ? [{ label: 'Edit CVs', icon: 'editcv', fn: () => this.startCVEdit(fid) }] : []),
      ...(f.type === 'cvcurve' ? [] : [{ label: f.type === 'sketch' ? 'Edit sketch' : 'Edit feature', icon: FEATURES[f.type].icon, fn: () => this.editFeature(fid) }]),
      { label: 'Rename', icon: 'pencil', fn: () => this.prompt('Rename feature', f.name, (v) => { if (v) { this.snapshot(); f.name = v; this.changed(); } }) },
      { label: f.suppressed ? 'Unsuppress' : 'Suppress', icon: 'eyeOff', fn: () => { this.snapshot(); f.suppressed = !f.suppressed; this.changed(); } },
      { label: 'Roll history marker here', icon: 'stepBack', fn: () => { doc.marker = i + 1; this.changed(); } },
      ...(f.type === 'sketch' || f.type === 'plane' ? [{ label: f.hidden ? 'Show' : 'Hide', icon: 'eye', fn: () => { f.hidden = !f.hidden; this.changed(); } }] : []),
      ...(f.type === 'joint' && f.p.type !== 'rigid' ? [{ label: 'Animate motion', icon: 'animate', fn: () => this.animateJoint(fid) }] : []),
      '-',
      { label: 'Delete', icon: 'trash', danger: true, fn: () => { this.snapshot(); doc.features.splice(i, 1); if (doc.marker > i) doc.marker--; if (this.selFeature === fid) this.selFeature = null; this.changed(); } },
    ];
  }

  // ---------------------------------------------------------------- overlays: context menu, modal, toast, banner
  showCtx(x, y, items) {
    this.closeCtx();
    const m = document.createElement('div');
    m.className = 'ctx';
    m.innerHTML = items.map((it, i) => (it === '-' ? '<hr>' : `<button data-i="${i}" class="${it.danger ? 'danger' : ''}">${icon(it.icon)}<span>${esc(it.label)}</span></button>`)).join('');
    document.body.appendChild(m);
    const r = m.getBoundingClientRect();
    m.style.left = `${Math.min(x, innerWidth - r.width - 8)}px`;
    m.style.top = `${Math.min(y, innerHeight - r.height - 8)}px`;
    m.onclick = (e) => { const b = e.target.closest('[data-i]'); if (b) { this.closeCtx(); items[+b.dataset.i].fn(); } };
    this._ctx = m;
  }
  closeCtx() { this._ctx?.remove(); this._ctx = null; }

  modal(title, html, { onOk, okLabel = 'OK', wide = false, cancel = true, ic = 'info', sub = '' } = {}) {
    const m = $('#modal');
    m.classList.remove('float');
    m.innerHTML = `<div class="mbox ${wide ? 'wide' : ''}"><div class="panel-head">${icon(ic)}<h3>${title}${sub ? `<small>${sub}</small>` : ''}</h3><button class="iconbtn" data-m="close">${icon('close')}</button></div><div class="mbody">${html}</div>${onOk !== undefined || cancel ? `<div class="panel-foot">${cancel ? '<button class="btn ghost" data-m="close">Cancel</button>' : ''}${onOk !== undefined ? `<button class="btn primary" data-m="ok">${okLabel}</button>` : ''}</div>` : ''}</div>`;
    m.classList.add('open');
    m.querySelectorAll('[data-m=close]').forEach((b) => (b.onclick = () => this.closeModal()));
    const ok = m.querySelector('[data-m=ok]');
    if (ok) ok.onclick = () => { if (onOk?.(m) !== false) this.closeModal(); };
    m.onmousedown = (e) => { if (e.target === m) this.closeModal(); };
    return m;
  }
  closeModal() { $('#modal').classList.remove('open'); $('#modal').innerHTML = ''; this._onModalClose?.(); this._onModalClose = null; }

  prompt(title, value, cb) {
    const m = this.modal(title, `<input class="input" value="${esc(value)}" style="height:36px">`, { onOk: (el) => cb(el.querySelector('input').value.trim()), ic: 'pencil' });
    const inp = m.querySelector('input');
    setTimeout(() => { inp.focus(); inp.select(); }, 20);
    inp.onkeydown = (e) => { if (e.key === 'Enter') { cb(inp.value.trim()); this.closeModal(); } };
  }

  banner(text, onCancel) {
    const b = $('#banner');
    if (!text) { b.classList.remove('open'); return; }
    b.innerHTML = `<span class="pulse"></span><span>${text}</span>${onCancel ? '<button class="btn sm">Cancel <kbd>Esc</kbd></button>' : ''}`;
    b.classList.add('open');
    if (onCancel) b.querySelector('button').onclick = onCancel;
  }

  toast(msg, kind = 'info') {
    const t = document.createElement('div');
    t.className = 'toast';
    const ic = { ok: 'ok', warn: 'warn', err: 'error', info: 'info' }[kind] || 'info';
    t.innerHTML = `${icon(ic)}<span>${esc(msg)}</span>`;
    if (kind === 'warn') t.querySelector('svg').style.color = 'var(--warn)';
    if (kind === 'ok') t.querySelector('svg').style.color = 'var(--ok)';
    $('#toasts').appendChild(t);
    setTimeout(() => t.classList.add('out'), 2800);
    setTimeout(() => t.remove(), 3200);
  }

  status(msg, kind = 'ok') {
    const s = $('#status');
    if (!s) return;
    s.className = kind;
    s.textContent = msg;
  }

  refreshAll() {
    $('#docname').value = this.doc.name;
    document.title = `${this.doc.name} — Ruffle3D`;
    this.vp.originPlanes.visible = this.doc.originVisible || this.mode === 'planePick';
    this.renderTimeline();
    this.renderLeft();
    this.renderStatusInfo();
  }

  // ---------------------------------------------------------------- command palette
  openPalette() {
    if (this.sketcher.active) return;
    const m = $('#modal');
    m.classList.remove('float');
    const actions = [
      ['New design…', 'plus', () => this.home.open('templates'), 'Project'], ['All projects', 'dashboard', () => this.home.open(), 'Project'],
      ['Save version…', 'history', () => this.saveVersion(), 'Project'], ['Export STEP', 'export', () => this.exportAs('step'), 'Export'],
      ['Export STL', 'export', () => this.exportAs('stl'), 'Export'], ['Export GLB', 'export', () => this.exportAs('glb'), 'Export'],
      ['Toggle light / dark theme', 'sun', () => this.setPref('theme', resolvedTheme(this.prefs.theme) === 'dark' ? 'light' : 'dark'), 'View'],
      ['Zoom to fit', 'fit', () => this.vp.fitAll(), 'View'], ['Colour each body differently', 'sparkles', () => this.autoColorBodies(), 'Appearance'],
      ['X-ray display', 'xray', () => { this.vp.setDisplayMode(this.vp.displayMode === 'xray' ? 'shadedEdges' : 'xray'); this.syncStyleBtn(); }, 'View'],
      ['Accent colour…', 'appearance', () => this.openPrefs('general'), 'App'],
      ['Install Ruffle3D as a desktop app', 'download', () => this.installApp(), 'App'],
      ['Record turntable video', 'camera', () => this.recordVideo(), 'Render'], ['Preferences', 'settings', () => this.openPrefs(), 'App'], ['Keyboard shortcuts', 'keyboard', () => this.openPrefs('shortcuts'), 'App'],
      ['Render workspace', 'render', () => this.setWorkspace('render'), 'Workspace'], ['Design workspace', 'cube', () => this.setWorkspace('design'), 'Workspace'],
    ];
    const entries = [...ALL_CMDS.map((c) => ({ label: cmdInfo(c).label, desc: cmdInfo(c).desc || '', ic: cmdInfo(c).icon, key: cmdInfo(c).key, sec: 'Commands', run: () => this.runCommand(c) })),
      ...actions.map(([label, ic, run, sec]) => ({ label, ic, run, sec, desc: '' })),
      ...this.doc.features.map((f) => ({ label: f.name || FEATURES[f.type].label, desc: `Edit ${FEATURES[f.type].label.toLowerCase()}`, ic: FEATURES[f.type].icon, sec: 'Features', run: () => this.editFeature(f.id) }))];
    m.innerHTML = `<div class="palette"><div class="palette-input">${icon('search')}<input placeholder="Search commands, features and actions…" spellcheck="false"><kbd>Esc</kbd></div><div class="palette-list"></div>
      <div class="palette-foot"><span><kbd>↑</kbd> <kbd>↓</kbd> navigate</span><span><kbd>Enter</kbd> run</span><span><kbd>Esc</kbd> close</span></div></div>`;
    m.classList.add('open');
    const inp = m.querySelector('input'), list = m.querySelector('.palette-list');
    let matches = [], idx = 0;
    const draw = () => {
      const q = inp.value.toLowerCase().trim();
      const score = (e) => { const l = e.label.toLowerCase(); return !q ? 1 : l.startsWith(q) ? 4 : l.split(/\s+/).some((w) => w.startsWith(q)) ? 3 : l.includes(q) ? 2 : e.desc.toLowerCase().includes(q) ? 1 : 0; };
      matches = entries.map((e, i) => ({ e, s: score(e), i })).filter((x) => x.s > 0)
        .sort((a, b) => (q ? b.s - a.s : 0) || (a.e.sec === b.e.sec ? a.i - b.i : 0)).map((x) => x.e).slice(0, 60);
      // keep section grouping stable: sort by section of best match order
      if (q) { const order = [...new Set(matches.map((e) => e.sec))]; matches.sort((a, b) => order.indexOf(a.sec) - order.indexOf(b.sec)); }
      if (!q) matches = matches.filter((e) => e.sec !== 'Features');
      idx = Math.min(idx, Math.max(0, matches.length - 1));
      let sec = '';
      list.innerHTML = matches.map((e, i) => {
        const head = e.sec !== sec ? `<div class="sec">${(sec = e.sec)}</div>` : '';
        return `${head}<button data-i="${i}" class="${i === idx ? 'on' : ''}"><span class="ic">${icon(e.ic)}</span><span>${esc(e.label)}<br><small>${esc(e.desc)}</small></span>${e.key ? `<kbd>${e.key}</kbd>` : ''}</button>`;
      }).join('') || '<div class="empty">No matches</div>';
      list.querySelector('.on')?.scrollIntoView({ block: 'nearest' });
    };
    const go = (e) => { this.closeModal(); e?.run(); };
    inp.oninput = () => { idx = 0; draw(); };
    inp.onkeydown = (e) => {
      if (e.key === 'ArrowDown') { idx = Math.min(matches.length - 1, idx + 1); draw(); e.preventDefault(); }
      if (e.key === 'ArrowUp') { idx = Math.max(0, idx - 1); draw(); e.preventDefault(); }
      if (e.key === 'Enter') { e.preventDefault(); e.stopPropagation(); go(matches[idx]); }
    };
    list.onclick = (e) => { const b = e.target.closest('[data-i]'); if (b) go(matches[+b.dataset.i]); };
    m.onmousedown = (e) => { if (e.target === m) this.closeModal(); };
    draw();
    setTimeout(() => inp.focus(), 10);
  }

  // ---------------------------------------------------------------- preferences
  openPrefs(section = 'general') {
    const P = this.prefs;
    const row = (title, sub, ctl) => `<div class="pref-row"><div><b>${title}</b><small>${sub}</small></div>${ctl}</div>`;
    const sw = (k) => `<label class="switch"><input type="checkbox" data-pref="${k}" ${P[k] ? 'checked' : ''}><span></span></label>`;
    const sections = {
      general: ['General', 'settings', () => row('Theme', 'Appearance of the interface and viewport', `<select class="input" data-pref="theme">${[['dark', 'Dark'], ['light', 'Light'], ['system', 'Match system']].map(([v, l]) => `<option value="${v}" ${P.theme === v ? 'selected' : ''}>${l}</option>`).join('')}</select>`)
        + row('Accent colour', 'Highlight colour for buttons, selection and focus', `<div class="accent-pick">${Object.entries(ACCENTS).map(([k, [l, d, li]]) => `<button data-accent="${k}" class="${(P.accent || 'blue') === k ? 'on' : ''}" style="--c:${resolvedTheme(P.theme) === 'light' ? li : d}" data-tip="${l}"></button>`).join('')}</div>`)
        + row('Colourful tool icons', 'Tint toolbar and timeline icons by category (sketch, create, modify…)', sw('colorIcons'))
        + row('Viewport background', 'Backdrop behind the model in the Design workspace', `<select class="input" data-pref="vpBg">${[['default', 'Theme gradient'], ['studio', 'Studio grey'], ['horizon', 'Horizon blue'], ['blueprint', 'Blueprint'], ['white', 'Plain white'], ['black', 'Plain black']].map(([v, l]) => `<option value="${v}" ${(P.vpBg || 'default') === v ? 'selected' : ''}>${l}</option>`).join('')}</select>`)
        + row('Tooltips', 'Show command names, shortcuts and descriptions on hover', sw('tooltips'))
        + row('Autosave', 'Save the project automatically after every change', sw('autosave'))],
      navigation: ['Navigation', 'pointer', () => row('Mouse preset', 'How the mouse orbits and pans the view', `<select class="input" data-pref="nav">${[['ruffle', 'Default — right orbit, middle pan'], ['fusion', 'Shift + middle orbit, middle pan'], ['solidworks', 'Middle orbit, Ctrl + middle pan'], ['onshape', 'Right orbit, middle pan']].map(([v, l]) => `<option value="${v}" ${P.nav === v ? 'selected' : ''}>${l}</option>`).join('')}</select>`)
        + row('Field of view', `Perspective camera angle (${P.fov}°)`, `<input type="range" min="20" max="70" step="1" value="${P.fov}" data-pref="fov" style="width:190px">`)],
      display: ['Display', 'monitor', () => row('Visible edges', 'Draw model edges in shaded mode', sw('edges')) + row('Ground shadows', 'Soft contact shadows under the model', sw('shadows'))
        + row('Ambient occlusion', 'Extra depth shading while modelling (always on in Render)', sw('ao')) + row('ViewCube', 'Orientation cube in the viewport', sw('viewcube'))],
      units: ['Units', 'measure', () => row('Document units', 'Plain numbers in fields and sketches are read in this unit', `<select class="input" data-units>${Object.keys(UNITS_TABLE).map((u) => `<option ${u === this.doc.units ? 'selected' : ''}>${u}</option>`).join('')}</select>`)],
      shortcuts: ['Shortcuts', 'keyboard', () => `<div class="shortcuts" style="padding-top:12px">${[['Search commands', 'Ctrl K / S'], ['New sketch', 'K'], ['Extrude', 'E'], ['Press pull', 'Q'], ['Fillet', 'F'], ['Hole', 'H'], ['Move', 'M'], ['Joint', 'J'], ['Measure', 'I'], ['Zoom to fit', 'F6'], ['Toggle panels', 'Tab'], ['Undo / redo', 'Ctrl Z / Ctrl Y'], ['Save', 'Ctrl S'], ['New design', 'Ctrl N'], ['Remove body', 'Del'], ['Cancel', 'Esc'],
        ['Sketch: line / rect / circle', 'L / R / C'], ['Sketch: arc / polygon / slot', 'A / P / S'], ['Sketch: dimension', 'D'], ['Sketch: trim / offset / fillet', 'T / O / F'], ['Sketch: construction', 'X']].map(([a, k]) => `<div><span>${a}</span><kbd>${k}</kbd></div>`).join('')}</div>`],
      about: ['About', 'info', () => `<div style="padding:16px 0"><div class="logo" style="font-size:18px;margin-bottom:10px">${icon('logo')}<span>Ruffle<em>3D</em></span></div><p class="muted">Parametric CAD in the browser. Geometry by OpenCascade (WebAssembly) via replicad, rendering by three.js, constraint solving and region detection built in.</p><p class="muted">Projects are stored locally in this browser (IndexedDB). Download project files to back them up or move them to another machine.</p></div>`],
    };
    const m = this.modal('Preferences', `<div class="pref-grid"><nav class="pref-nav">${Object.entries(sections).map(([k, [l, ic]]) => `<button data-sec="${k}" class="${k === section ? 'on' : ''}">${icon(ic)}${l}</button>`).join('')}</nav><div class="pref-body"></div></div>`, { wide: true, cancel: false, ic: 'settings' });
    m.querySelector('.mbody').style.padding = '0';
    const body = m.querySelector('.pref-body');
    const show = (k) => {
      m.querySelectorAll('[data-sec]').forEach((b) => b.classList.toggle('on', b.dataset.sec === k));
      body.innerHTML = sections[k][2]();
      body.querySelectorAll('[data-pref]').forEach((el) => {
        const ev = el.type === 'range' ? 'input' : 'change';
        el.addEventListener(ev, () => {
          const k2 = el.dataset.pref;
          const v = el.type === 'checkbox' ? el.checked : el.type === 'range' ? +el.value : el.value;
          this.setPref(k2, v);
          if (k2 === 'theme') show(k);
          if (el.type === 'range') el.closest('.pref-row').querySelector('small').textContent = `Perspective camera angle (${v}°)`;
        });
      });
      body.querySelector('[data-units]')?.addEventListener('change', (e) => this.setUnits(e.target.value));
      body.querySelectorAll('[data-accent]').forEach((b) => (b.onclick = () => { this.setPref('accent', b.dataset.accent); show(k); }));
    };
    m.querySelectorAll('[data-sec]').forEach((b) => (b.onclick = () => show(b.dataset.sec)));
    show(section);
  }

  // ---------------------------------------------------------------- section analysis
  startSection() {
    const sec = this.vp.section;
    if (!sec.enabled) {
      const [a, b] = this.sectionRange(sec.axis);
      this.vp.setSection({ enabled: true, offset: (a + b) / 2, flip: this.sectionFlip(sec.axis) });
    }
    this.mode = 'section';
    $('#right').classList.remove('collapsed');
    this.renderRight();
    this.renderVpInfo();
  }
  sectionRange(ax) {
    const box = this.vp.sceneBox(), i = { X: 0, Y: 1, Z: 2 }[ax];
    return box.isEmpty() ? [-50, 50] : [box.min.getComponent(i) - 1, box.max.getComponent(i) + 1];
  }
  sectionFlip(ax) { return this.vp.camera.position.clone().sub(this.vp.controls.target).getComponent({ X: 0, Y: 1, Z: 2 }[ax]) < 0; }

  renderSectionPanel() {
    const el = $('#right');
    const sec = this.vp.section;
    const [a, b] = this.sectionRange(sec.axis);
    el.innerHTML = `<div class="panel-head">${icon('section')}<h3>Section analysis<small>Cut faces are shown in red</small></h3><button class="iconbtn" data-x>${icon('close')}</button></div>
      <div class="panel-body"><div class="insp"><div class="insp-sec">
        <div class="field"><label>Plane</label><div class="seg" data-axis>${['X', 'Y', 'Z'].map((x) => `<button data-v="${x}" class="${x === sec.axis ? 'on' : ''}">${x === 'X' ? 'YZ' : x === 'Y' ? 'XZ' : 'XY'}</button>`).join('')}</div></div>
        <div class="field"><label>Offset</label><div class="num"><input class="input" data-off value="${fmt(sec.offset / this.units.scale, 3)}"><span class="unit">${this.units.label}</span></div></div>
        <div class="field stack"><input type="range" min="${a}" max="${b}" step="${(b - a) / 400}" value="${sec.offset}" data-rng></div>
        <div class="field check"><label>Flip side</label><label class="switch"><input type="checkbox" data-flip ${sec.flip ? 'checked' : ''}><span></span></label></div>
      </div></div></div>
      <div class="panel-foot"><button class="btn ghost" data-remove>Remove section</button><span class="spacer"></span><button class="btn primary" data-done>Done</button></div>`;
    const upd = (o) => { this.vp.setSection(o); this.renderVpInfo(); };
    el.querySelectorAll('[data-axis] [data-v]').forEach((bt) => (bt.onclick = () => { const [x, y] = this.sectionRange(bt.dataset.v); upd({ axis: bt.dataset.v, offset: (x + y) / 2, flip: this.sectionFlip(bt.dataset.v) }); this.renderRight(); }));
    el.querySelector('[data-rng]').oninput = (e) => { upd({ offset: +e.target.value }); el.querySelector('[data-off]').value = fmt(+e.target.value / this.units.scale, 3); };
    el.querySelector('[data-off]').onchange = (e) => { try { upd({ offset: evaluateLen(e.target.value, this.vars, this.units.scale) }); this.renderRight(); } catch { e.target.classList.add('bad'); } };
    el.querySelector('[data-flip]').onchange = (e) => upd({ flip: e.target.checked });
    el.querySelector('[data-remove]').onclick = () => { upd({ enabled: false }); this.exitMode(); };
    el.querySelector('[data-done]').onclick = () => this.exitMode();
    el.querySelector('[data-x]').onclick = () => this.exitMode();
  }

  async installApp() {
    if (window.matchMedia('(display-mode: standalone)').matches) return this.toast('Ruffle3D is already running as an installed app', 'info');
    if (!this.installPrompt) return this.toast('Use your browser menu → "Install Ruffle3D" (Chrome / Edge), or download the offline package from the website', 'info');
    this.installPrompt.prompt();
    const r = await this.installPrompt.userChoice;
    this.installPrompt = null;
    if (r.outcome === 'accepted') this.toast('Ruffle3D installed', 'ok');
  }

  async openBOM() {
    const bodies = this.result.bodies;
    if (!bodies.length) return this.toast('There are no bodies yet', 'warn');
    const m = this.modal('Bill of materials', `<div class="bom"><p class="muted">Computing mass properties…</p></div>`, { wide: true, ic: 'bom', cancel: false, sub: `${bodies.length} bod${bodies.length === 1 ? 'y' : 'ies'} · ${esc(this.doc.name)}` });
    const rows = [];
    for (const b of bodies) {
      const meta = this.bodyMeta(b.id), mat = MATERIALS[meta.material] || MATERIALS[DEFAULT_MATERIAL];
      let pr = this.propsCache.get(b.id);
      if (!pr) { try { pr = (await this.kernel.props(b.id)).props; this.propsCache.set(b.id, pr); } catch { pr = null; } }
      const size = pr ? [0, 1, 2].map((i) => pr.bbox[1][i] - pr.bbox[0][i]) : [0, 0, 0];
      // identical components (same source project and version) are listed once with a quantity
      const { key, name } = this.partInfo(b.id);
      const same = rows.find((r) => r.key === key);
      if (same) { same.qty++; continue; }
      rows.push({ key, qty: 1, name, type: b.surface ? 'Surface' : 'Solid', material: mat.name, density: mat.density, volume: b.surface ? 0 : pr?.volume || 0, area: pr?.area || 0, mass: b.surface ? 0 : ((pr?.volume || 0) / 1000) * mat.density, size, visible: meta.visible !== false });
    }
    if (!m.isConnected || !$('#modal').classList.contains('open')) return;
    const u = this.units, s3 = u.scale ** 3, s2 = u.scale ** 2;
    const tot = rows.reduce((a, r) => ({ mass: a.mass + r.mass * r.qty, volume: a.volume + r.volume * r.qty, area: a.area + r.area * r.qty, qty: a.qty + r.qty }), { mass: 0, volume: 0, area: 0, qty: 0 });
    const volU = this.doc.units === 'mm' ? 'cm³' : `${u.label}³`, vol = (v) => (this.doc.units === 'mm' ? v / 1000 : v / s3);
    m.querySelector('.bom').innerHTML = `<table class="bom-table"><thead><tr><th>#</th><th>Body</th><th class="n">Qty</th><th>Type</th><th>Material</th><th class="n">Volume (${volU})</th><th class="n">Mass (g)</th><th class="n">Area (${u.label}²)</th><th class="n">Size (${u.label})</th></tr></thead><tbody>
      ${rows.map((r, i) => `<tr class="${r.visible ? '' : 'dim'}"><td>${i + 1}</td><td>${esc(r.name)}</td><td class="n">${r.qty}</td><td>${r.type}</td><td>${esc(r.material)}</td><td class="n">${r.type === 'Solid' ? fmt(vol(r.volume), 3) : '–'}</td><td class="n">${r.type === 'Solid' ? fmt(r.mass, 2) : '–'}</td><td class="n">${fmt(r.area / s2, 2)}</td><td class="n">${r.size.map((v) => fmt(v / u.scale, 1)).join(' × ')}</td></tr>`).join('')}
      </tbody><tfoot><tr><td></td><td>Total</td><td class="n">${tot.qty}</td><td colspan="2"></td><td class="n">${fmt(vol(tot.volume), 3)}</td><td class="n">${fmt(tot.mass, 2)}</td><td class="n">${fmt(tot.area / s2, 2)}</td><td></td></tr></tfoot></table>
      <div class="bom-actions"><button class="btn sm" data-b="copy">${icon('copy')}Copy CSV</button><button class="btn sm primary" data-b="csv">${icon('download')}Download CSV</button></div>`;
    const csv = () => {
      const q = (v) => `"${String(v).replace(/"/g, '""')}"`;
      const head = ['#', 'Body', 'Qty', 'Type', 'Material', 'Density (g/cm3)', `Volume (${volU})`, 'Mass (g)', `Area (${u.label}2)`, `Size X (${u.label})`, `Size Y (${u.label})`, `Size Z (${u.label})`];
      const lines = rows.map((r, i) => [i + 1, r.name, r.qty, r.type, r.material, r.density, r.type === 'Solid' ? vol(r.volume).toFixed(4) : '', r.type === 'Solid' ? r.mass.toFixed(3) : '', (r.area / s2).toFixed(3), ...r.size.map((v) => (v / u.scale).toFixed(3))].map(q).join(','));
      return [head.map(q).join(','), ...lines].join('\r\n');
    };
    m.querySelector('[data-b=copy]').onclick = async () => { try { await navigator.clipboard.writeText(csv()); this.toast('Copied to the clipboard', 'ok'); } catch { this.toast('Clipboard is not available here', 'warn'); } };
    m.querySelector('[data-b=csv]').onclick = () => this.download(new Blob([csv()], { type: 'text/csv' }), `${this.doc.name} BOM.csv`);
  }

  async export3MF() {
    const bodies = [];
    for (const [id, b] of this.vp.bodies) {
      if (!b.group.visible) continue;
      const g = b.mesh.geometry;
      bodies.push({ name: this.bodyMeta(id).name, color: `#${b.mats.front.color.getHexString()}`, positions: g.attributes.position.array, index: g.index.array });
    }
    if (!bodies.length) return this.toast('Nothing to export', 'warn');
    const data = await build3MF(bodies, this.doc.name);
    this.download(new Blob([data], { type: 'model/3mf' }), `${this.doc.name}.3mf`);
    this.toast('Exported 3MF', 'ok');
  }

  // ---------------------------------------------------------------- DXF
  importDXF() {
    const inp = document.createElement('input');
    inp.type = 'file';
    inp.accept = '.dxf';
    inp.onchange = async () => {
      const file = inp.files[0];
      if (!file) return;
      let dxf;
      try { dxf = parseDXF(await file.text()); } catch (e) { return this.toast(`Could not read ${file.name}: ${e.message}`, 'warn'); }
      if (!dxf.entities.length) return this.toast('This DXF has no drawing entities', 'warn');
      const detected = dxf.unitScale, unitName = { 1: 'mm', 10: 'cm', 1000: 'm', 25.4: 'in', 304.8: 'ft' }[detected];
      const preview = dxfPrimitives(dxf, 1);
      const counts = preview.prims.reduce((a, p) => ((a[p.t] = (a[p.t] || 0) + 1), a), {});
      const skipped = Object.entries(preview.skipped).map(([k, v]) => `${v} ${k}`).join(', ');
      const m = this.modal('Import DXF', `
        <p class="muted" style="margin-top:0"><b>${esc(file.name)}</b> · ${preview.prims.length} curves (${Object.entries(counts).map(([k, v]) => `${v} ${k}${v === 1 ? '' : 's'}`).join(', ')})${skipped ? `<br>Not imported: ${esc(skipped)} (text, dimensions and hatches are ignored)` : ''}</p>
        <div class="field"><label>Units in file</label><select class="input" data-u>${[['auto', `From file${unitName ? ` (${unitName})` : ' (not set: mm)'}`], ['1', 'Millimetres'], ['10', 'Centimetres'], ['1000', 'Metres'], ['25.4', 'Inches'], ['304.8', 'Feet']].map(([v, l]) => `<option value="${v}">${l}</option>`).join('')}</select></div>
        <div class="field"><label>Sketch plane</label><select class="input" data-pl>${['XY', 'XZ', 'YZ'].map((n) => `<option>${n}</option>`).join('')}</select></div>
        <div class="field check"><label>Centre on the origin</label><label class="switch"><input type="checkbox" data-c checked><span></span></label></div>`,
      {
        ic: 'dxfin', okLabel: 'Import',
        onOk: (box) => {
          const u = box.querySelector('[data-u]').value, scale = u === 'auto' ? detected || 1 : +u;
          const { prims } = dxfPrimitives(dxf, scale);
          const data = primitivesToSketch(prims, { center: box.querySelector('[data-c]').checked });
          const pl = box.querySelector('[data-pl]').value;
          this.addFeature('sketch', { planeRef: { type: 'std', name: pl }, plane: structuredClone(STD_PLANES[pl]), ...data });
          const f = this.doc.features[this.doc.marker - 1];
          f.name = file.name.replace(/\.dxf$/i, '');
          this.renderTimeline(); this.renderLeft(); this.scheduleSave();
          this.toast(`Imported ${data.curves.length} curves into a sketch. Extrude its profiles to make a part`, 'ok');
        },
      });
      return m;
    };
    inp.click();
  }

  startDXFExport() {
    if (this.cmd) this.cancelCommand();
    this.exitMode();
    if (this.ws !== 'design') this.setWorkspace('design');
    this.mode = 'dxfpick';
    this.cmd = null;
    // show sketches so their profiles can be picked
    this.vp.setSketches((this.result.sketches || []).map((s) => ({ ...s, visible: true })));
    this.banner('Export DXF: click a flat face, or a sketch profile', () => this.exitMode());
    this.updateHighlights();
  }

  async dxfPickClick(hit) {
    if (!hit) return;
    let text, name;
    try {
      if (hit.kind === 'face') {
        text = (await this.kernel.dxf({ body: hit.bodyId, p: hit.point, n: hit.normal })).text;
        name = `${this.bodyMeta(hit.bodyId).name} face`;
      } else {
        const sk = (this.result.sketches || []).find((s) => s.id === hit.sketchId);
        if (!sk) return;
        text = this.sketchDXF(sk);
        name = this.doc.features.find((f) => f.id === sk.id)?.name || 'Sketch';
      }
    } catch (e) { return this.toast(e.message, 'warn'); }
    this.download(new Blob([text], { type: 'application/dxf' }), `${name}.dxf`);
    this.toast('Exported DXF (millimetres)', 'ok');
    this.exitMode();
    this.display(this.result);
  }

  // Sketch curves → DXF in sketch coordinates (millimetres); construction geometry is left out.
  sketchDXF(sk) {
    const ents = [];
    for (const g of sk.geom || []) {
      if (g.construction || g.type === 'point') continue;
      if (g.type === 'line') ents.push({ t: 'LINE', a: g.a, b: g.b });
      else if (g.type === 'circle') ents.push({ t: 'CIRCLE', c: g.c, r: g.r });
      else if (g.type === 'arc') {
        const a0 = (g.a0 * 180) / Math.PI, a1 = ((g.a0 + g.sweep) * 180) / Math.PI;
        ents.push(g.sweep >= 0 ? { t: 'ARC', c: g.c, r: g.r, a0, a1 } : { t: 'ARC', c: g.c, r: g.r, a0: a1, a1: a0 });
      } else {
        const pts = sampleGeom(g, 96);
        if (pts.length > 1) ents.push({ t: 'POLY', pts, closed: !!g.closed });
      }
    }
    if (!ents.length) throw new Error('This sketch has no curves to export');
    return writeDXF(ents);
  }

  // ---------------------------------------------------------------- configurations
  setConfig(id) {
    this.doc.activeConfig = id || null;
    this.changed();
    this.renderLeft();
    this.renderVpInfo();
    const c = this.activeConfig();
    this.toast(c ? `Configuration: ${c.name}` : 'Default configuration', 'info');
  }

  openConfigTable() {
    const doc = this.doc;
    doc.configs ||= [];
    const render = () => {
      const cfgs = doc.configs;
      const box = m.querySelector('.mbody');
      box.innerHTML = `<p class="muted" style="margin-top:0">Each column is a variant of this design. Leave a cell empty to use the Default value. Changes rebuild the model when you switch configurations.</p>
        <div class="cfg-wrap"><table class="cfg-table"><thead><tr><th>Parameter</th><th class="${doc.activeConfig ? '' : 'on'}"><button data-act-cfg="">Default</button></th>
        ${cfgs.map((c) => `<th class="${doc.activeConfig === c.id ? 'on' : ''}"><div class="cfg-head"><input value="${esc(c.name)}" data-rename="${c.id}" spellcheck="false"><button class="iconbtn" data-act-cfg="${c.id}" data-tip="Make active">${icon('check')}</button><button class="iconbtn" data-delcfg="${c.id}" data-tip="Delete">${icon('trash')}</button></div></th>`).join('')}
        <th><button class="btn sm" data-addcfg>${icon('plus')}Add</button></th></tr></thead><tbody>
        ${doc.params.map((p, i) => `<tr><td><b>${esc(p.name)}</b>${p.comment ? `<small>${esc(p.comment)}</small>` : ''}</td><td><input data-base="${i}" value="${esc(p.expr)}" spellcheck="false"></td>
          ${cfgs.map((c) => `<td><input data-cv="${c.id}" data-p="${esc(p.name)}" value="${esc(c.values?.[p.name] ?? '')}" placeholder="${esc(p.expr)}" spellcheck="false"></td>`).join('')}<td></td></tr>`).join('') || `<tr><td colspan="${cfgs.length + 3}" class="muted">Add parameters in the Parameters tab first.</td></tr>`}
        </tbody></table></div>
        <div class="cfg-foot"><button class="btn sm" data-stepall ${cfgs.length ? '' : 'disabled'}>${icon('export')}Export STEP for every configuration</button></div>`;
      box.querySelector('[data-addcfg]').onclick = () => {
        this.snapshot();
        const n = cfgs.length + 1;
        cfgs.push({ id: `cf${Date.now().toString(36)}`, name: `Variant ${n}`, values: {} });
        render(); this.scheduleSave(); this.renderLeft();
      };
      box.querySelectorAll('[data-rename]').forEach((inp) => (inp.onchange = () => { const c = cfgs.find((x) => x.id === inp.dataset.rename); if (c) { c.name = inp.value.trim() || c.name; this.scheduleSave(); this.renderLeft(); this.renderVpInfo(); } }));
      box.querySelectorAll('[data-delcfg]').forEach((b) => (b.onclick = () => { this.snapshot(); doc.configs = cfgs.filter((c) => c.id !== b.dataset.delcfg); if (doc.activeConfig === b.dataset.delcfg) doc.activeConfig = null; this.changed(); render(); this.renderLeft(); this.renderVpInfo(); }));
      box.querySelectorAll('[data-act-cfg]').forEach((b) => (b.onclick = () => { this.setConfig(b.dataset.actCfg || null); render(); }));
      box.querySelectorAll('[data-base]').forEach((inp) => (inp.onchange = () => { this.snapshot(); doc.params[+inp.dataset.base].expr = inp.value; this.changed(); this.renderLeft(); }));
      box.querySelectorAll('[data-cv]').forEach((inp) => (inp.onchange = () => {
        this.snapshot();
        const c = cfgs.find((x) => x.id === inp.dataset.cv);
        c.values ||= {};
        if (inp.value.trim()) c.values[inp.dataset.p] = inp.value.trim(); else delete c.values[inp.dataset.p];
        try { evalParams(this.effectiveParams(c), this.units.scale); } catch { /* shown as an error on rebuild */ }
        if (doc.activeConfig === c.id) this.changed(); else this.scheduleSave();
        this.renderLeft();
      }));
      box.querySelector('[data-stepall]').onclick = () => this.exportAllConfigs();
    };
    const m = this.modal('Configurations', '', { wide: true, ic: 'configs', cancel: false, sub: esc(doc.name) });
    render();
  }

  async exportAllConfigs() {
    const keep = this.doc.activeConfig;
    const list = [{ id: null, name: 'Default' }, ...this.doc.configs];
    this.closeModal();
    for (const c of list) {
      this.doc.activeConfig = c.id;
      this.toast(`Exporting ${c.name}…`, 'info');
      await this.rebuild();
      const bodies = this.result.bodies.filter((b) => this.bodyMeta(b.id).visible !== false).map((b) => { const m = this.bodyMeta(b.id); return { id: b.id, name: m.name, color: this.appearanceOf(m).color }; });
      if (!bodies.length) continue;
      try {
        const { buffer } = await this.kernel.export(bodies, 'step');
        this.download(new Blob([buffer], { type: 'application/step' }), `${this.doc.name} - ${c.name}.step`);
      } catch (e) { this.toast(`${c.name}: ${e.message}`, 'warn'); }
      await wait(400);
    }
    this.doc.activeConfig = keep;
    await this.rebuild();
    this.renderVpInfo();
    this.toast(`Exported ${list.length} configurations`, 'ok');
  }

  // ---------------------------------------------------------------- turntable video
  async recordVideo(seconds = 6, width = 1920, height = 1080) {
    if (this.ws !== 'render') this.setWorkspace('render');
    if (this._recording) return;
    this._recording = true;
    this.banner('Recording turntable video…', null);
    try {
      const blob = await this.vp.recordTurntable({ seconds, fps: 30, width, height, onProgress: (k) => this.status(`Recording ${Math.round(k * 100)}%`, 'busy') });
      this.download(blob, `${this.doc.name} turntable.webm`);
      this.status('Video saved', 'ok');
      this.toast('Turntable video saved', 'ok');
    } catch (e) { this.toast(e.message, 'warn'); this.status(e.message, 'err'); }
    this._recording = false;
    this.banner(null);
  }

  viewDirection() { return this.vp.camera.getWorldDirection(new THREE.Vector3()).toArray().map((v) => Math.round(v * 1e6) / 1e6); }

  // ---------------------------------------------------------------- free-form CV curves & surfaces
  startCV() {
    this.mode = 'cv';
    this.selection = [];
    this.cvEdit.startDraw();
    $('#right').classList.remove('collapsed');
    this.updateHighlights();
    this.renderRight();
  }
  startCVEdit(fid) {
    const isCV = (id) => this.doc.features.some((f) => f.id === id && (f.type === 'cvcurve' || f.type === 'cvsurface'));
    fid ||= [this.selFeature, ...this.selection.map((x) => x.bodyId || x.sketchId)].find((id) => id && isCV(id));
    if (!fid) {
      const all = this.doc.features.slice(0, this.doc.marker).filter((f) => f.type === 'cvcurve' || f.type === 'cvsurface');
      if (all.length === 1) fid = all[0].id;
      else return this.toast(all.length ? 'Select a CV curve or CV surface first' : 'Create a CV curve or CV surface first', 'warn');
    }
    if (this.cmd) this.cancelCommand();
    this.exitMode();
    this.mode = 'cv';
    if (!this.cvEdit.startEdit(fid)) { this.mode = null; return; }
    this.selection = [];
    $('#right').classList.remove('collapsed');
    this.updateHighlights();
    this.renderRight();
  }

  // ---------------------------------------------------------------- appearance (paint bodies & faces)
  startPaint(target) {
    const bodySel = this.selection.find((s) => s.kind === 'body');
    const base = bodySel ? this.appearanceOf(this.bodyMeta(bodySel.bodyId)).look : null;
    this.paint ||= { look: makeLook('#d0202a', 'paint', 'Racing Red'), target: 'body', cat: 'Paint' };
    if (base) this.paint.look = { ...base };
    if (target) this.paint.target = target;
    this.paint.applyTo = bodySel && !target ? this.selection.filter((s) => s.kind === 'body').map((s) => s.bodyId) : null;
    this.paint.eyedrop = false;
    this.mode = 'paint';
    this.selection = [];
    $('#right').classList.remove('collapsed');
    this.bannerPaint();
    this.updateHighlights();
    this.renderRight();
  }
  bannerPaint() {
    this.banner(`Appearance — click ${this.paint.target === 'face' ? 'faces' : 'bodies'} to apply · Alt-click to pick up an appearance`, () => this.exitMode());
  }

  paintClick(hit, ev) {
    if (!hit || (hit.kind !== 'body' && hit.kind !== 'face')) return;
    const P = this.paint;
    const meta = this.bodyMeta(hit.bodyId);
    const faceHit = hit.kind === 'face';
    const fIdx = faceHit ? (meta.faces || []).findIndex((f) => this.locateFace({ body: hit.bodyId, p: f.p })?.faceIndex === hit.faceIndex) : -1;
    if (ev?.altKey || P.eyedrop) {
      // eyedropper: pick up the appearance under the cursor
      P.look = { ...(fIdx >= 0 ? meta.faces[fIdx].look : this.appearanceOf(meta).look) };
      P.eyedrop = false;
      this.toast(`Picked up ${P.look.name || P.look.color}`, 'info');
      return this.renderRight();
    }
    this.snapshot();
    const look = { ...P.look };
    if (faceHit) {
      meta.faces ||= [];
      if (fIdx >= 0) meta.faces.splice(fIdx, 1);
      meta.faces.push({ p: hit.point, n: hit.normal, look });
    } else {
      meta.look = look;
      delete meta.color;
    }
    P.applyTo = null;
    this.display(this.result);
    this.renderLeft();
    this.renderRight();
    this.scheduleSave();
  }

  setPaintLook(patch, rerender = true) {
    const P = this.paint;
    P.look = { ...P.look, ...patch };
    if (!('name' in patch)) P.look.name = `${(FINISHES[P.look.finish] || { name: 'Custom' }).name} ${P.look.color.toUpperCase()}`;
    // live-apply to the bodies the editor was opened for
    if (P.applyTo?.length) {
      for (const id of P.applyTo) { const m = this.bodyMeta(id); m.look = { ...P.look }; delete m.color; }
      this.display(this.result);
      this.renderLeft();
      this.scheduleSave();
    }
    if (rerender) this.renderRight();
    else this.updatePaintPreview();
  }
  updatePaintPreview() {
    const L = this.paint.look, el = $('#right');
    const b = el.querySelector('.look-cur .ball');
    if (b) b.style.background = lookBall(L);
    const nm = el.querySelector('.look-cur b');
    if (nm) nm.textContent = L.name || 'Custom';
    const sm = el.querySelector('.look-cur small');
    if (sm) sm.textContent = `${(FINISHES[L.finish] || { name: 'Custom' }).name} · ${L.color.toUpperCase()}`;
  }

  renderPaintPanel() {
    const el = $('#right');
    const P = this.paint, L = P.look;
    const slider = (k, label, min, max, step) => `<div class="field"><label>${label}<span class="val" data-val="${k}">${fmt(L[k] ?? 0, 2)}</span></label><input type="range" min="${min}" max="${max}" step="${step}" value="${L[k] ?? 0}" data-sl="${k}"></div>`;
    const lib = APPEARANCES[P.cat] || [];
    const painted = this.result.bodies.map((b) => ({ id: b.id, m: this.bodyMeta(b.id) })).filter(({ m }) => m.look || m.color || m.faces?.length);
    const sub = P.applyTo?.length ? `Editing ${P.applyTo.length === 1 ? esc(this.bodyMeta(P.applyTo[0]).name) : `${P.applyTo.length} bodies`} live` : `Click ${P.target === 'face' ? 'faces' : 'bodies'} to apply`;
    el.innerHTML = `<div class="panel-head">${icon('appearance')}<h3>Appearance<small>${sub}</small></h3><button class="iconbtn" data-x>${icon('close')}</button></div>
      <div class="panel-body"><div class="insp">
        <div class="insp-sec">
          <div class="field"><label>Apply to</label><div class="seg full" data-target>${[['body', 'Bodies', 'cube'], ['face', 'Faces', 'bucket']].map(([v, l, ic]) => `<button data-v="${v}" class="${P.target === v ? 'on' : ''}">${icon(ic)}${l}</button>`).join('')}</div></div>
          <div class="look-cur"><span class="ball" style="background:${lookBall(L)}"></span><div><b>${esc(L.name || 'Custom')}</b><small>${(FINISHES[L.finish] || { name: 'Custom' }).name} · ${esc(L.color.toUpperCase())}</small></div>
            <button class="iconbtn ${P.eyedrop ? 'on' : ''}" data-eyedrop data-tip="Pick up from model" data-desc="Or Alt-click any body or face">${icon('pipette')}</button></div>
        </div>
        <div class="insp-sec"><h4>Colour</h4>
          <div class="swatches">${PALETTE.map((c) => `<button data-sw="${c}" style="background:${c}" class="${c.toLowerCase() === L.color.toLowerCase() ? 'on' : ''}" data-tip="${c.toUpperCase()}"></button>`).join('')}</div>
          <div class="field" style="margin-top:10px"><label>Custom colour</label><div style="display:flex;gap:8px;align-items:center"><input type="color" data-color value="${esc(L.color)}"><input class="input mono" data-hex value="${esc(L.color.toUpperCase())}" maxlength="7" style="flex:1"></div></div>
        </div>
        <div class="insp-sec"><h4>Finish</h4>
          <div class="finish-grid">${Object.entries(FINISHES).map(([k, f]) => `<button data-fin="${k}" class="${L.finish === k ? 'on' : ''}"><span class="ball" style="background:${lookBall(makeLook(L.color, k))}"></span>${f.name}</button>`).join('')}</div>
          <div style="margin-top:10px">${slider('roughness', 'Roughness', 0, 1, 0.01)}${slider('metalness', 'Metalness', 0, 1, 0.01)}${slider('clearcoat', 'Clear coat', 0, 1, 0.01)}${slider('opacity', 'Opacity', 0.1, 1, 0.01)}</div>
        </div>
        <div class="insp-sec"><h4>Library</h4>
          <div class="seg full" data-cat style="margin-bottom:10px">${Object.keys(APPEARANCES).map((c) => `<button data-v="${c}" class="${P.cat === c ? 'on' : ''}">${c}</button>`).join('')}</div>
          <div class="mat-grid">${lib.map(([n, c, f], i) => `<button data-lib="${i}" class="${L.name === n ? 'on' : ''}" data-tip="${esc(n)}" data-desc="${FINISHES[f].name}"><span class="ball" style="background:${lookBall(makeLook(c, f, n))}"></span>${esc(n.split(' ').slice(-1)[0])}</button>`).join('')}</div>
        </div>
        <div class="insp-sec"><h4>In this design</h4>
          ${painted.length ? `<div class="ov-list">${painted.map(({ id, m }) => `<div class="ov-row"><span class="swatch" style="background:${esc(this.appearanceOf(m).color)}"></span><span class="nm">${esc(m.name)}</span><small>${[m.look || m.color ? 'body' : '', m.faces?.length ? `${m.faces.length} face${m.faces.length === 1 ? '' : 's'}` : ''].filter(Boolean).join(' · ')}</small><button class="iconbtn" data-clr="${id}" data-tip="Reset to material">${icon('reset')}</button></div>`).join('')}</div>` : '<p class="muted" style="margin:0;font-size:12px">No overrides yet — bodies show their physical material.</p>'}
          <button class="btn sm" data-auto style="margin-top:10px;width:100%">${icon('sparkles')}Colour each body differently</button>
        </div>
      </div></div>
      <div class="panel-foot"><button class="btn ghost" data-resetall ${painted.length ? '' : 'disabled'}>${icon('reset')}Reset all</button><span class="spacer"></span><button class="btn primary" data-x>Done</button></div>`;
    el.querySelectorAll('[data-x]').forEach((b) => (b.onclick = () => this.exitMode()));
    el.querySelectorAll('[data-target] button').forEach((b) => (b.onclick = () => { P.target = b.dataset.v; P.applyTo = null; this.bannerPaint(); this.renderRight(); }));
    el.querySelectorAll('[data-cat] button').forEach((b) => (b.onclick = () => { P.cat = b.dataset.v; this.renderRight(); }));
    el.querySelector('[data-eyedrop]').onclick = () => { P.eyedrop = !P.eyedrop; this.renderRight(); };
    el.querySelectorAll('[data-sw]').forEach((b) => (b.onclick = () => this.setPaintLook({ color: b.dataset.sw })));
    el.querySelector('[data-color]').oninput = (e) => { el.querySelector('[data-hex]').value = e.target.value.toUpperCase(); this.setPaintLook({ color: e.target.value }, false); };
    el.querySelector('[data-color]').onchange = () => this.renderRight();
    el.querySelector('[data-hex]').onchange = (e) => {
      let v = e.target.value.trim();
      if (!v.startsWith('#')) v = `#${v}`;
      if (/^#[0-9a-f]{3}$/i.test(v)) v = `#${v[1]}${v[1]}${v[2]}${v[2]}${v[3]}${v[3]}`;
      if (/^#[0-9a-f]{6}$/i.test(v)) this.setPaintLook({ color: v.toLowerCase() });
      else { e.target.value = L.color.toUpperCase(); this.toast('Enter a hex colour like #1E90FF', 'warn'); }
    };
    el.querySelectorAll('[data-fin]').forEach((b) => (b.onclick = () => { const f = makeLook(L.color, b.dataset.fin); delete f.name; delete f.color; this.setPaintLook(f); }));
    el.querySelectorAll('[data-sl]').forEach((r) => (r.oninput = () => { el.querySelector(`[data-val=${r.dataset.sl}]`).textContent = fmt(+r.value, 2); this.setPaintLook({ [r.dataset.sl]: +r.value, finish: 'custom' }, false); }));
    el.querySelectorAll('[data-lib]').forEach((b) => (b.onclick = () => { const [n, c, f] = lib[+b.dataset.lib]; this.setPaintLook(makeLook(c, f, n)); }));
    el.querySelectorAll('[data-clr]').forEach((b) => (b.onclick = () => { this.snapshot(); const m = this.bodyMeta(b.dataset.clr); delete m.look; delete m.color; delete m.faces; this.display(this.result); this.renderLeft(); this.renderRight(); this.scheduleSave(); }));
    el.querySelector('[data-auto]').onclick = () => this.autoColorBodies();
    el.querySelector('[data-resetall]').onclick = () => {
      this.snapshot();
      for (const b of this.result.bodies) { const m = this.bodyMeta(b.id); delete m.look; delete m.color; delete m.faces; }
      this.display(this.result); this.renderLeft(); this.renderRight(); this.scheduleSave();
      this.toast('Appearances reset to materials', 'ok');
    };
  }

  // Gives every body a distinct colour (handy for assemblies).
  autoColorBodies() {
    const cols = ['#1764c4', '#d0202a', '#2fb56b', '#f5a524', '#5b2f91', '#14a39a', '#f2652a', '#c2378f', '#3f51d6', '#8cc63f'];
    if (!this.result.bodies.length) return this.toast('There are no bodies yet', 'warn');
    this.snapshot();
    this.result.bodies.forEach((b, i) => { const c = cols[i % cols.length]; const m = this.bodyMeta(b.id); m.look = makeLook(c, 'satin', `Satin ${c.toUpperCase()}`); delete m.color; });
    this.display(this.result); this.renderLeft(); this.renderRight(); this.scheduleSave();
    this.toast(`Coloured ${this.result.bodies.length} bod${this.result.bodies.length === 1 ? 'y' : 'ies'}`, 'ok');
  }

  // ---------------------------------------------------------------- surface analysis
  startAnalysis(kind) {
    this.analysis ||= { mode: kind, density: 9, dir: 'Z', flip: false, angle: 1, which: 'mean', gain: 1, combScale: 1, combs: [] };
    this.analysis.mode = kind;
    this.mode = 'analysis';
    this.applyAnalysis();
    $('#right').classList.remove('collapsed');
    this.banner({
      zebra: 'Zebra analysis — orbit to see how reflections flow across edges',
      draft: 'Draft analysis — green: OK · yellow: needs draft · red: undercut',
      curv: 'Curvature map — red: convex · green: flat · blue: concave',
      comb: 'Curvature comb — click edges to show their curvature combs',
      iso: 'Isophotes — lines of equal light angle; smooth, evenly spaced lines mean a fair surface',
      overhang: '3D print check — red: overhang needs support · amber: borderline · blue: on the build plate',
    }[kind], () => this.exitMode());
    this.renderRight();
  }
  async loadCurvature() {
    const a = this.analysis;
    this.curvCache ||= new Map();
    const fields = {};
    let pending = 0;
    for (const b of this.result.bodies) {
      if (this.bodyMeta(b.id).visible === false) continue;
      if (!this.curvCache.has(b.uid)) {
        pending++;
        try { this.curvCache.set(b.uid, (await this.kernel.curvature(b.id)).values); } catch { this.curvCache.set(b.uid, null); }
        if (this.mode !== 'analysis' || a.mode !== 'curv') return;
      }
      if (this.curvCache.get(b.uid)) fields[b.id] = this.curvCache.get(b.uid);
    }
    // automatic range: 90th percentile of |curvature| over curved vertices
    const vals = [];
    for (const f of Object.values(fields)) for (let i = 0; i < f.length; i += 2) {
      const v = a.which === 'gauss' ? Math.sqrt(Math.abs(f[i])) : Math.abs(f[i + 1]);
      if (v > 1e-7) vals.push(v);
    }
    vals.sort((x, y) => x - y);
    a.autoRange = vals.length ? vals[Math.floor(vals.length * 0.9)] || vals[vals.length - 1] : 0.05;
    a.fields = fields;
    a.loading = false;
    this.vp.setAnalysis({ mode: 'curv', fields, which: a.which, range: a.autoRange / (a.gain || 1) });
    if (pending || !this._curvShown) { this._curvShown = true; this.renderRight(); }
  }
  async loadCombs() {
    const a = this.analysis;
    this.combGroup ||= (() => { const g = new THREE.Group(); this.vp.scene.add(g); return g; })();
    this.combGroup.clear();
    if (!a.combs.length) return this.vp.requestRender();
    let res;
    try { res = (await this.kernel.combs(a.combs)).combs; } catch (e) { this.toast(e.message, 'warn'); return; }
    if (this.mode !== 'analysis' || a.mode !== 'comb') return;
    const kmax = Math.max(1e-9, ...res.flatMap((c) => c.k));
    const box = this.vp.sceneBox();
    const size = box.isEmpty() ? 50 : box.getSize(new THREE.Vector3()).length();
    const sc = ((size * 0.12) / kmax) * (a.combScale || 1);
    a.stats = res.map((c) => ({ kmax: Math.max(...c.k), kmin: Math.min(...c.k), length: c.length }));
    for (const c of res) {
      const teeth = [], env = [];
      c.pts.forEach((P, i) => {
        const tip = [0, 1, 2].map((j) => P[j] - c.n[i][j] * c.k[i] * sc);
        teeth.push(...P, ...tip);
        env.push(new THREE.Vector3(...tip));
      });
      const tl = this.vp._fatLine(teeth, 0xe46ee8, 1.5);
      const envSegs = [];
      for (let i = 0; i + 1 < env.length; i++) envSegs.push(...env[i].toArray(), ...env[i + 1].toArray());
      const el = this.vp._fatLine(envSegs, 0xf2994a, 2.5);
      tl.renderOrder = el.renderOrder = 14;
      this.combGroup.add(tl, el);
    }
    this.vp.requestRender();
    this.renderRight();
  }
  applyAnalysis() {
    const a = this.analysis;
    if (a.mode === 'curv' || a.mode === 'comb') {
      if (a.mode === 'curv') { a.loading = true; this.vp.setAnalysis({ mode: 'curv', fields: a.fields || {}, which: a.which, range: (a.autoRange || 0.05) / (a.gain || 1) }); this.loadCurvature(); }
      else { this.vp.setAnalysis(null); this.loadCombs(); }
      return this.syncStyleBtn();
    }
    if (a.mode === 'overhang') {
      a.print ||= { up: 'Z', limit: 45, printer: '220', material: 'pla', infill: 20 };
      const up = PRINT_UP[a.print.up];
      a.printStats = this.printStats(up, a.print);
      this.vp.setAnalysis({ mode: 'overhang', dir: up, angle: a.print.limit, floor: a.printStats.floor });
      return this.syncStyleBtn();
    }
    const d = { X: [1, 0, 0], Y: [0, 1, 0], Z: [0, 0, 1] }[a.dir].map((v) => (a.flip ? -v : v));
    this.vp.setAnalysis({ mode: a.mode, density: a.density, dir: d, angle: a.angle });
    this.syncStyleBtn();
  }
  syncStyleBtn() {
    const b = $('#navctl [data-nav=style]');
    if (!b) return;
    const m = this.vp.analysis?.mode;
    b.innerHTML = icon(m === 'overhang' ? 'printcheck' : m === 'zebra' ? 'zebra' : m === 'draft' ? 'draftan' : m === 'curv' ? 'curvmap' : m === 'iso' ? 'isophote' : { wire: 'wire', shaded: 'shaded', xray: 'xray' }[this.vp.displayMode] || 'edges');
    b.classList.toggle('on', !!m || this.vp.displayMode === 'xray');
  }
  renderAnalysisPanel() {
    const el = $('#right'), a = this.analysis;
    if (a.mode === 'curv' || a.mode === 'comb') return this.renderCurvPanel();
    if (a.mode === 'overhang') return this.renderPrintPanel();
    const zebra = a.mode === 'zebra' || a.mode === 'iso', iso = a.mode === 'iso';
    el.innerHTML = `<div class="panel-head">${icon(iso ? 'isophote' : zebra ? 'zebra' : 'draftan')}<h3>${iso ? 'Isophotes' : zebra ? 'Zebra analysis' : 'Draft analysis'}<small>Surface quality inspection</small></h3><button class="iconbtn" data-x>${icon('close')}</button></div>
      <div class="panel-body"><div class="insp">
        <div class="insp-sec"><div class="seg full" data-kind>${[['zebra', 'Zebra'], ['iso', 'Iso'], ['draft', 'Draft'], ['curv', 'Curv.'], ['comb', 'Comb']].map(([v, l]) => `<button data-v="${v}" class="${a.mode === v ? 'on' : ''}">${l}</button>`).join('')}</div></div>
        ${zebra ? `<div class="insp-sec"><h4>${iso ? 'Highlight lines' : 'Stripes'}</h4>
            <div class="field"><label>${iso ? 'Lines' : 'Density'}<span class="val" data-val>${a.density}</span></label><input type="range" min="3" max="30" step="1" value="${a.density}" data-den></div>
            ${iso ? `<div class="field"><label>Light from</label><div class="seg" data-dir>${['X', 'Y', 'Z'].map((x) => `<button data-v="${x}" class="${a.dir === x ? 'on' : ''}">${x}</button>`).join('')}</div></div>` : ''}
            <div class="help">${iso ? 'Each line joins points whose surface normal makes the same angle with the light. On a fair surface the lines flow smoothly and evenly; kinks or bunching show creases or curvature jumps.' : 'Stripes that run smoothly across an edge mean a tangent- or curvature-continuous blend. Kinks or breaks show where faces meet at a crease.'}</div></div>`
        : `<div class="insp-sec"><h4>Pull direction</h4>
            <div class="field"><label>Axis</label><div class="seg" data-dir>${['X', 'Y', 'Z'].map((x) => `<button data-v="${x}" class="${a.dir === x ? 'on' : ''}">${x}</button>`).join('')}</div></div>
            <div class="field check"><label>Reverse direction</label><label class="switch"><input type="checkbox" data-flip ${a.flip ? 'checked' : ''}><span></span></label></div>
            <div class="field"><label>Minimum draft<span class="val" data-val>${a.angle}°</span></label><input type="range" min="0" max="10" step="0.5" value="${a.angle}" data-ang></div></div>
          <div class="insp-sec"><h4>Legend</h4><div class="legend">
            <div><i style="background:#38bf6b"></i>Draft ≥ minimum — releases from the mould</div>
            <div><i style="background:#f7bf2e"></i>Within ± minimum — needs more draft</div>
            <div><i style="background:#e6454d"></i>Negative — undercut, belongs to the other half</div></div></div>`}
      </div></div>
      <div class="panel-foot"><span class="spacer"></span><button class="btn primary" data-x>Done</button></div>`;
    el.querySelectorAll('[data-x]').forEach((b) => (b.onclick = () => this.exitMode()));
    el.querySelectorAll('[data-kind] button').forEach((b) => (b.onclick = () => this.startAnalysis(b.dataset.v)));
    el.querySelector('[data-den]')?.addEventListener('input', (e) => { a.density = +e.target.value; el.querySelector('[data-val]').textContent = a.density; this.applyAnalysis(); });
    el.querySelectorAll('[data-dir] button').forEach((b) => (b.onclick = () => { a.dir = b.dataset.v; this.applyAnalysis(); this.renderRight(); }));
    el.querySelector('[data-flip]')?.addEventListener('change', (e) => { a.flip = e.target.checked; this.applyAnalysis(); });
    el.querySelector('[data-ang]')?.addEventListener('input', (e) => { a.angle = +e.target.value; el.querySelector('[data-val]').textContent = `${a.angle}°`; this.applyAnalysis(); });
  }

  // ---------------------------------------------------------------- 3D print check
  // Mesh statistics of the visible solids printed along `up`: size, build-volume fit, open edges,
  // overhang area beyond the limit angle (ignoring faces on the plate) and a filament estimate.
  printStats(up, opt) {
    const P = PRINTERS[opt.printer], mat = PRINT_MATERIALS[opt.material];
    const ax = up.map(Math.abs).indexOf(1), side = [0, 1, 2].filter((i) => i !== ax);
    const bodies = [];
    let floor = Infinity;
    for (const [id, b] of this.vp.bodies) {
      if (!b.group.visible || b.data?.surface) continue;
      const pos = b.mesh.geometry.attributes.position.array;
      for (let i = 0; i < pos.length; i += 3) floor = Math.min(floor, pos[i] * up[0] + pos[i + 1] * up[1] + pos[i + 2] * up[2]);
      bodies.push([id, b]);
    }
    if (!Number.isFinite(floor)) floor = 0;
    const sinL = Math.sin((opt.limit * Math.PI) / 180);
    const rows = bodies.map(([id, b]) => {
      const g = b.mesh.geometry, pos = g.attributes.position.array, idx = g.index ? g.index.array : null;
      const nt = idx ? idx.length / 3 : pos.length / 9;
      const V = (k) => (idx ? idx[k] : k);
      // weld coincident vertices, then count how many triangles use each edge
      const key = new Map(), wid = new Uint32Array(pos.length / 3);
      for (let i = 0; i < pos.length / 3; i++) {
        const k = `${Math.round(pos[i * 3] * 1e4)},${Math.round(pos[i * 3 + 1] * 1e4)},${Math.round(pos[i * 3 + 2] * 1e4)}`;
        let w = key.get(k);
        if (w === undefined) { w = key.size; key.set(k, w); }
        wid[i] = w;
      }
      const edges = new Map(), tri = [];
      let vol = 0, area = 0, over = 0;
      const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
      for (let t = 0; t < nt; t++) {
        const ia = V(t * 3), ib = V(t * 3 + 1), ic = V(t * 3 + 2);
        const A = [pos[ia * 3], pos[ia * 3 + 1], pos[ia * 3 + 2]], B = [pos[ib * 3], pos[ib * 3 + 1], pos[ib * 3 + 2]], C = [pos[ic * 3], pos[ic * 3 + 1], pos[ic * 3 + 2]];
        for (const q of [A, B, C]) for (let k = 0; k < 3; k++) { lo[k] = Math.min(lo[k], q[k]); hi[k] = Math.max(hi[k], q[k]); }
        const u = [B[0] - A[0], B[1] - A[1], B[2] - A[2]], v = [C[0] - A[0], C[1] - A[1], C[2] - A[2]];
        const n = [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]];
        const a2 = Math.hypot(n[0], n[1], n[2]);
        vol += (A[0] * (B[1] * C[2] - B[2] * C[1]) - A[1] * (B[0] * C[2] - B[2] * C[0]) + A[2] * (B[0] * C[1] - B[1] * C[0])) / 6;
        area += a2 / 2;
        tri.push([n, a2, ((A[0] + B[0] + C[0]) * up[0] + (A[1] + B[1] + C[1]) * up[1] + (A[2] + B[2] + C[2]) * up[2]) / 3]);
        for (const [x, y] of [[wid[ia], wid[ib]], [wid[ib], wid[ic]], [wid[ic], wid[ia]]]) {
          if (x === y) continue;
          const k = x < y ? x * 4294967296 + y : y * 4294967296 + x;
          edges.set(k, (edges.get(k) || 0) + 1);
        }
      }
      const sgn = vol < 0 ? -1 : 1; // outward normals are the ones that make the volume positive
      for (const [n, a2, h] of tri) {
        if (a2 < 1e-12) continue;
        const down = (-sgn * (n[0] * up[0] + n[1] * up[1] + n[2] * up[2])) / a2;
        if (down > sinL + 1e-6 && h - floor > 0.05) over += a2 / 2;
      }
      let open = 0;
      for (const c of edges.values()) if (c !== 2) open++;
      vol = Math.abs(vol);
      const size = [hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2]];
      const w = size[side[0]], d = size[side[1]], h = size[ax], e = 1e-6;
      const fits = h <= P.size[2] + e && ((w <= P.size[0] + e && d <= P.size[1] + e) || (w <= P.size[1] + e && d <= P.size[0] + e));
      const shell = Math.min(vol, area * 0.8); // about two 0.4 mm perimeters and skins
      const printed = shell + (opt.infill / 100) * (vol - shell);
      return { id, name: this.bodyMeta(id).name, size: [w, d, h], fits, open, vol, area, over, mass: (printed / 1000) * mat.density, metres: printed / (Math.PI * 0.875 ** 2) / 1000 };
    });
    return { floor, rows };
  }

  renderPrintPanel() {
    const el = $('#right'), a = this.analysis, o = a.print, st = a.printStats || { rows: [] };
    const tot = st.rows.reduce((t, r) => ({ mass: t.mass + r.mass, metres: t.metres + r.metres }), { mass: 0, metres: 0 });
    const u = this.units;
    el.innerHTML = `<div class="panel-head">${icon('printcheck')}<h3>3D print check<small>FDM printability</small></h3><button class="iconbtn" data-x>${icon('close')}</button></div>
      <div class="panel-body"><div class="insp">
        <div class="insp-sec"><h4>Setup</h4>
          <div class="field"><label>Build direction (up)</label><div class="seg" data-up>${Object.keys(PRINT_UP).map((x) => `<button data-v="${x}" class="${o.up === x ? 'on' : ''}">${x.replace('-', '−')}</button>`).join('')}</div></div>
          <div class="field"><label>Overhang limit<span class="val" data-val>${o.limit}°</span></label><input type="range" min="20" max="75" step="1" value="${o.limit}" data-lim></div>
          <div class="field"><label>Printer</label><select class="input" data-pr>${Object.entries(PRINTERS).map(([k, p]) => `<option value="${k}" ${o.printer === k ? 'selected' : ''}>${p.name}</option>`).join('')}</select></div>
          <div class="field"><label>Material</label><select class="input" data-mat>${Object.entries(PRINT_MATERIALS).map(([k, m]) => `<option value="${k}" ${o.material === k ? 'selected' : ''}>${m.name}</option>`).join('')}</select></div>
          <div class="field"><label>Infill<span class="val" data-iv>${o.infill}%</span></label><input type="range" min="0" max="100" step="5" value="${o.infill}" data-inf></div></div>
        <div class="insp-sec"><h4>Bodies</h4>
          ${st.rows.length ? st.rows.map((r) => `<div class="print-row">
            <div class="print-name">${esc(r.name)}</div>
            <dl class="kv">
              <dt>Size</dt><dd>${r.size.map((v) => fmt(v / u.scale, 1)).join(' × ')} ${u.label}</dd>
              <dt>Build volume</dt><dd class="${r.fits ? 'ok' : 'bad'}">${r.fits ? 'Fits' : 'Too large'}</dd>
              <dt>Mesh</dt><dd class="${r.open ? 'bad' : 'ok'}">${r.open ? `${r.open} open edges` : 'Watertight'}</dd>
              <dt>Overhangs</dt><dd class="${r.over > 1 ? 'warn' : 'ok'}">${r.over > 1 ? `${fmt(r.over / u.scale ** 2, 0)} ${u.label}² (${fmt((r.over / r.area) * 100, 1)}%)` : 'None'}</dd>
              <dt>Material</dt><dd>${fmt(r.mass, 1)} g · ${fmt(r.metres, 2)} m</dd>
            </dl></div>`).join('') : `<div class="empty">${icon('printcheck')}There are no visible solid bodies.</div>`}
          ${st.rows.length > 1 ? `<dl class="kv"><dt>Total</dt><dd>${fmt(tot.mass, 1)} g · ${fmt(tot.metres, 2)} m</dd></dl>` : ''}
          <div class="help">Material is estimated from two 0.4 mm perimeters plus infill, on 1.75 mm filament. Your slicer gives the exact figure.</div></div>
        <div class="insp-sec"><h4>Legend</h4><div class="legend">
          <div><i style="background:#e6454d"></i>More than ${o.limit}° from vertical: needs support</div>
          <div><i style="background:#f7bf2e"></i>Within 10° of the limit</div>
          <div><i style="background:#5994f2"></i>Resting on the build plate</div></div></div>
      </div></div>
      <div class="panel-foot"><button class="btn" data-ex="stl">${icon('download')}STL</button><button class="btn" data-ex="3mf">${icon('download')}3MF</button><span class="spacer"></span><button class="btn primary" data-x>Done</button></div>`;
    const redo = () => { this.applyAnalysis(); this.renderRight(); };
    el.querySelectorAll('[data-x]').forEach((b) => (b.onclick = () => this.exitMode()));
    el.querySelectorAll('[data-up] button').forEach((b) => (b.onclick = () => { o.up = b.dataset.v; redo(); }));
    el.querySelector('[data-lim]').addEventListener('input', (e) => { o.limit = +e.target.value; el.querySelector('[data-val]').textContent = `${o.limit}°`; this.vp.setAnalysis({ ...this.vp.analysis, angle: o.limit }); });
    el.querySelector('[data-lim]').addEventListener('change', redo);
    el.querySelector('[data-inf]').addEventListener('input', (e) => { o.infill = +e.target.value; el.querySelector('[data-iv]').textContent = `${o.infill}%`; });
    el.querySelector('[data-inf]').addEventListener('change', redo);
    el.querySelector('[data-pr]').onchange = (e) => { o.printer = e.target.value; redo(); };
    el.querySelector('[data-mat]').onchange = (e) => { o.material = e.target.value; redo(); };
    el.querySelector('[data-ex="stl"]').onclick = () => this.exportAs('stl');
    el.querySelector('[data-ex="3mf"]').onclick = () => this.export3MF();
  }

  // ---------------------------------------------------------------- sheet metal flat pattern
  async openFlatPattern() {
    const sheets = this.result.bodies.filter((b) => b.sheet);
    if (!sheets.length) return this.toast('There are no sheet metal bodies. Start with Sheet Metal ▸ Base.', 'warn');
    let bodyId = this.selection.find((s) => s.kind === 'body' && sheets.some((b) => b.id === s.bodyId))?.bodyId || sheets[0].id;
    const m = this.modal('Flat pattern', '<div class="flat"><p class="muted">Unfolding…</p></div>', { wide: true, ic: 'flatpattern', cancel: false });
    const show = async () => {
      let r;
      try { r = await this.kernel.flat(bodyId); } catch (e) { m.querySelector('.flat').innerHTML = `<p class="muted">${esc(e.message)}</p>`; return; }
      if (!m.isConnected) return;
      const name = this.bodyMeta(bodyId).name, L = (v) => this.len(v, 2);
      const pad = Math.max(r.size[0], r.size[1]) * 0.04 + 1;
      const Y = (y) => r.size[1] - y;
      const svg = (e) => {
        if (e.t === 'LINE') return `<line x1="${e.a[0]}" y1="${Y(e.a[1])}" x2="${e.b[0]}" y2="${Y(e.b[1])}"${e.layer === 'BEND' ? ' class="bend"' : ''}/>`;
        if (e.t === 'CIRCLE') return `<circle cx="${e.c[0]}" cy="${Y(e.c[1])}" r="${e.r}"/>`;
        if (e.t === 'ARC') {
          const p = (d) => [e.c[0] + e.r * Math.cos((d * Math.PI) / 180), Y(e.c[1] + e.r * Math.sin((d * Math.PI) / 180))];
          const sw = (((e.a1 - e.a0) % 360) + 360) % 360 || 360, [x0, y0] = p(e.a0), [x1, y1] = p(e.a1);
          return `<path d="M${x0} ${y0}A${e.r} ${e.r} 0 ${sw > 180 ? 1 : 0} 0 ${x1} ${y1}"/>`;
        }
        return `<polyline points="${e.pts.map((q) => `${q[0]},${Y(q[1])}`).join(' ')}"/>`;
      };
      m.querySelector('.flat').innerHTML = `
        ${sheets.length > 1 ? `<div class="field" style="max-width:320px"><label>Body</label><select class="input" data-body>${sheets.map((b) => `<option value="${b.id}" ${b.id === bodyId ? 'selected' : ''}>${esc(this.bodyMeta(b.id).name)}</option>`).join('')}</select></div>` : ''}
        <div class="flat-grid">
          <div class="flat-view"><svg viewBox="${-pad} ${-pad} ${r.size[0] + 2 * pad} ${r.size[1] + 2 * pad}" style="--sw:${Math.max(r.size[0], r.size[1]) / 400}">${r.ents.map(svg).join('')}</svg></div>
          <div class="flat-info">
            <dl class="kv"><dt>Flat size</dt><dd>${L(r.size[0])} × ${L(r.size[1])}</dd><dt>Thickness</dt><dd>${L(r.thickness)}</dd><dt>Inside bend radius</dt><dd>${L(r.radius)}</dd><dt>K-factor</dt><dd>${fmt(r.kfactor, 3)}</dd></dl>
            ${r.bends.length ? `<table class="bom-table"><thead><tr><th>#</th><th>Bend</th><th class="n">Angle</th><th class="n">Length</th><th class="n">Allowance</th></tr></thead><tbody>${r.bends.map((b, i) => `<tr><td>${i + 1}</td><td>${b.dir}</td><td class="n">${fmt(b.angle, 1)}°</td><td class="n">${L(b.length)}</td><td class="n">${L(b.allowance)}</td></tr>`).join('')}</tbody></table>` : '<p class="muted">No bends yet. Add flanges to the edges of the plate.</p>'}
            <p class="small muted">Dashed lines are bend lines. In the DXF they are on the <b>BEND</b> layer; the cut outline is on layer 0.</p>
            <div class="bom-actions"><button class="btn sm primary" data-b="dxf">${icon('download')}Download DXF</button></div>
          </div>
        </div>`;
      m.querySelector('[data-body]')?.addEventListener('change', (e) => { bodyId = e.target.value; show(); });
      m.querySelector('[data-b=dxf]').onclick = () => { this.download(new Blob([r.dxf], { type: 'application/dxf' }), `${name} flat pattern.dxf`); this.toast('Exported flat pattern DXF (millimetres)', 'ok'); };
    };
    show();
  }

  renderCurvPanel() {
    const el = $('#right'), a = this.analysis;
    const curv = a.mode === 'curv';
    const r = (a.autoRange || 0.05) / (a.gain || 1);
    const lab = (v) => (Math.abs(v) < 1e-9 ? '0' : `R ${this.len(1 / Math.abs(v), 1)}`);
    el.innerHTML = `<div class="panel-head">${icon(curv ? 'curvmap' : 'comb')}<h3>${curv ? 'Curvature map' : 'Curvature comb'}<small>Surface evaluation</small></h3><button class="iconbtn" data-x>${icon('close')}</button></div>
      <div class="panel-body"><div class="insp">
        <div class="insp-sec"><div class="seg full" data-kind>${[['zebra', 'Zebra'], ['iso', 'Iso'], ['draft', 'Draft'], ['curv', 'Curv.'], ['comb', 'Comb']].map(([v, l]) => `<button data-v="${v}" class="${a.mode === v ? 'on' : ''}">${l}</button>`).join('')}</div></div>
        ${curv ? `<div class="insp-sec"><h4>Curvature type</h4>
            <div class="seg full" data-which>${[['mean', 'Mean'], ['gauss', 'Gaussian'], ['max', 'Maximum']].map(([v, l]) => `<button data-v="${v}" class="${a.which === v ? 'on' : ''}">${l}</button>`).join('')}</div>
            <div class="field" style="margin-top:12px"><label>Sensitivity<span class="val" data-val>${fmt(a.gain, 2)}×</span></label><input type="range" min="0.2" max="5" step="0.05" value="${a.gain}" data-gain></div>
            ${a.loading && !Object.keys(a.fields || {}).length ? `<div class="savestate saving" style="margin-top:6px">${icon('spinner')}Evaluating surfaces…</div>` : ''}</div>
          <div class="insp-sec"><h4>Scale</h4>
            <div class="curv-bar ${a.which === 'max' ? 'pos' : ''}"></div>
            <div class="curv-labels">${a.which === 'max' ? `<span>0</span><span>${lab(r / 2)}</span><span>${lab(r)}</span>` : `<span>−${lab(r)}</span><span>Flat</span><span>+${lab(r)}</span>`}</div>
            <div class="help" style="margin-top:10px">${a.which === 'gauss' ? 'Gaussian: red = dome (both directions curve the same way), blue = saddle, green = developable (can be unrolled flat).' : a.which === 'max' ? 'Largest principal curvature: tight radii show red. Look for sudden jumps across edges.' : 'Mean curvature: red = convex, blue = concave, green = flat. Smooth colour gradients mean a fair surface.'}</div></div>`
        : `<div class="insp-sec"><h4>Comb</h4>
            <div class="field"><label>Scale<span class="val" data-val>${fmt(a.combScale, 2)}×</span></label><input type="range" min="0.1" max="5" step="0.05" value="${a.combScale}" data-cs></div>
            ${a.combs.length ? `<dl class="kv">${(a.stats || []).map((st, i) => `<dt>Edge ${i + 1}</dt><dd>${st.kmax < 1e-9 ? 'Straight' : `min R ${this.len(1 / st.kmax, 2)}`}</dd>`).join('')}</dl>` : `<div class="empty">${icon('comb')}Click edges in the viewport to show their curvature combs.</div>`}
            <div class="help" style="margin-top:10px">Tooth length is proportional to curvature. A fair curve has a smooth comb outline with no kinks or sudden steps.</div>
            ${a.combs.length ? '<button class="btn sm" data-clr style="margin-top:10px;width:100%">Clear combs</button>' : ''}</div>`}
      </div></div>
      <div class="panel-foot"><span class="spacer"></span><button class="btn primary" data-x>Done</button></div>`;
    el.querySelectorAll('[data-x]').forEach((b) => (b.onclick = () => this.exitMode()));
    el.querySelectorAll('[data-kind] button').forEach((b) => (b.onclick = () => this.startAnalysis(b.dataset.v)));
    el.querySelectorAll('[data-which] button').forEach((b) => (b.onclick = () => { a.which = b.dataset.v; this.applyAnalysis(); this.renderRight(); }));
    el.querySelector('[data-gain]')?.addEventListener('input', (e) => { a.gain = +e.target.value; el.querySelector('[data-val]').textContent = `${fmt(a.gain, 2)}×`; this.vp.setAnalysis({ mode: 'curv', fields: a.fields || {}, which: a.which, range: (a.autoRange || 0.05) / a.gain }); });
    el.querySelector('[data-gain]')?.addEventListener('change', () => this.renderRight());
    el.querySelector('[data-cs]')?.addEventListener('input', (e) => { a.combScale = +e.target.value; el.querySelector('[data-val]').textContent = `${fmt(a.combScale, 2)}×`; });
    el.querySelector('[data-cs]')?.addEventListener('change', () => this.loadCombs());
    el.querySelector('[data-clr]')?.addEventListener('click', () => { a.combs = []; this.updateHighlights(); this.loadCombs(); this.renderRight(); });
  }

  // ---------------------------------------------------------------- measure
  startMeasure() {
    this.mode = 'measure';
    this.measure = { picks: [], result: null };
    $('#right').classList.remove('collapsed');
    this.banner('Measure — click edges or faces (up to two)', () => this.exitMode());
    this.renderRight();
  }

  async measureClick(hit, ev) {
    const ms = this.measure;
    if (!hit || (hit.kind !== 'edge' && hit.kind !== 'face')) return;
    const pk = hit.kind === 'edge'
      ? { kind: 'edge', body: hit.bodyId, p: this.edgeMidpoint(hit.bodyId, hit.edgeIndex) || hit.point, at: hit.point }
      : { kind: 'face', body: hit.bodyId, p: hit.point, n: hit.normal, at: hit.point };
    if (ms.picks.length >= 2) ms.picks = [];
    ms.picks.push(pk);
    this.updateHighlights();
    this.drawMeasureMarkers();
    try { ms.result = (await this.kernel.measure(ms.picks.map(({ at, ...p }) => p))).result; } catch (e) { ms.result = { error: e.message }; }
    this.renderRight();
  }

  drawMeasureMarkers() {
    this.measureGroup.clear();
    if (this._mLabel) { this.vp.removeLabel(this._mLabel); this._mLabel = null; }
    const pts = (this.measure?.picks || []).map((p) => new THREE.Vector3(...p.at));
    for (const p of pts) this.measureGroup.add(this.vp._dot(p.toArray(), 0xf2994a));
    if (pts.length === 2) {
      const line = new THREE.Line(new THREE.BufferGeometry().setFromPoints(pts), new THREE.LineDashedMaterial({ color: 0xf2994a, dashSize: 2, gapSize: 1, depthTest: false }));
      line.computeLineDistances();
      line.renderOrder = 12;
      this.measureGroup.add(line);
    }
    this.vp.requestRender();
  }

  renderMeasurePanel() {
    const el = $('#right');
    const ms = this.measure || { picks: [] };
    const r = ms.result;
    const item = (it, i) => `<div class="insp-sec"><h4>${i === 0 ? 'First' : 'Second'} selection · ${esc(it.type)} ${it.kind}</h4><dl class="kv">
      ${it.length != null ? `<dt>Length</dt><dd>${this.len(it.length)}</dd>` : ''}${it.area != null ? `<dt>Area</dt><dd>${this.area(it.area)}</dd>` : ''}
      ${it.radius != null && Number.isFinite(it.radius) ? `<dt>Radius</dt><dd>${this.len(it.radius)}</dd><dt>Diameter</dt><dd>${this.len(it.radius * 2)}</dd>` : ''}</dl></div>`;
    let pair = '';
    if (r && ms.picks.length === 2) {
      const a = new THREE.Vector3(...ms.picks[0].at), b = new THREE.Vector3(...ms.picks[1].at), d = b.clone().sub(a);
      pair = `<div class="insp-sec"><h4>Between selections</h4><div class="stat-grid">
        <div class="stat" style="grid-column:span 2"><small>Minimum distance</small><b style="font-size:18px;color:var(--accent)">${r.distance != null ? this.len(r.distance) : '–'}</b></div>
        ${r.angle != null ? `<div class="stat" style="grid-column:span 2"><small>Angle</small><b>${fmt(r.angle, 3)}°</b></div>` : ''}</div>
        <dl class="kv" style="margin-top:10px"><dt>Point to point</dt><dd>${this.len(d.length())}</dd><dt>ΔX</dt><dd>${this.len(Math.abs(d.x))}</dd><dt>ΔY</dt><dd>${this.len(Math.abs(d.y))}</dd><dt>ΔZ</dt><dd>${this.len(Math.abs(d.z))}</dd></dl></div>`;
    }
    el.innerHTML = `<div class="panel-head">${icon('measure')}<h3>Measure<small>${ms.picks.length ? `${ms.picks.length} of 2 selected` : 'Pick edges or faces'}</small></h3><button class="iconbtn" data-x>${icon('close')}</button></div>
      <div class="panel-body"><div class="insp">
        ${!ms.picks.length ? `<div class="empty">${icon('measure')}Click an edge for its length or radius, a face for its area.<br>Pick a second entity for distance and angle.</div>` : ''}
        ${r?.error ? `<div class="dlg-err" style="display:block">${esc(r.error)}</div>` : ''}
        ${(r?.items || []).map(item).join('')}${pair}
      </div></div>
      <div class="panel-foot"><button class="btn ghost" data-clear>${icon('reset')}Clear</button><span class="spacer"></span><button class="btn primary" data-x>Done</button></div>`;
    el.querySelectorAll('[data-x]').forEach((b) => (b.onclick = () => this.exitMode()));
    el.querySelector('[data-clear]').onclick = () => { this.measure = { picks: [], result: null }; this.drawMeasureMarkers(); this.updateHighlights(); this.renderRight(); };
  }

  clearMeasure() {
    this.measure = null;
    this.measureGroup.clear();
    this.vp.requestRender();
  }

  // ---------------------------------------------------------------- assembly
  animateJoint(fid) {
    const j = (this.result.joints || []).find((x) => x.id === fid);
    if (!j) return this.toast('Joint is not active', 'warn');
    if (j.type === 'rigid') return this.toast('Rigid joints have no motion', 'info');
    this.vp.animateBody(j.body, j.origin, j.axis, j.type);
    this.banner(`Animating ${esc(this.doc.features.find((f) => f.id === fid)?.name || 'joint')}`, () => { this.vp.stopAnimation(); this.banner(null); });
  }

  animateJoints() {
    const js = (this.result.joints || []).filter((j) => j.type !== 'rigid');
    if (!js.length) return this.toast('Add a revolute or slider joint first', 'info');
    this.animateJoint(js[js.length - 1].id);
  }

  async runInterference() {
    const ids = this.result.bodies.map((b) => b.id).filter((id) => this.bodyMeta(id).visible !== false);
    if (ids.length < 2) return this.toast('Interference needs at least two visible bodies', 'info');
    this.status('Checking interference…', 'busy');
    let res;
    try { res = (await this.kernel.interference(ids)).results; } catch (e) { return this.status(e.message, 'err'); }
    this.status('Ready', 'ok');
    this.interGroup.clear();
    const mat = new THREE.MeshBasicMaterial({ color: 0xf0525b, transparent: true, opacity: 0.8, depthTest: false });
    for (const r of res) { const m = new THREE.Mesh(buildBodyGeometry(r.mesh).geo, mat); m.renderOrder = 30; this.interGroup.add(m); }
    this.vp.requestRender();
    this.mode = 'interference';
    this.interResults = res;
    $('#right').classList.remove('collapsed');
    this.renderRight();
  }

  renderInterferencePanel() {
    const res = this.interResults || [];
    const el = $('#right');
    el.innerHTML = `<div class="panel-head">${icon('interference')}<h3>Interference<small>${res.length ? `${res.length} overlapping pair${res.length > 1 ? 's' : ''}` : 'No overlaps found'}</small></h3><button class="iconbtn" data-x>${icon('close')}</button></div>
      <div class="panel-body"><div class="insp">${res.length ? res.map((r) => `<div class="insp-sec"><h4>${esc(this.bodyMeta(r.a).name)} ↔ ${esc(this.bodyMeta(r.b).name)}</h4><dl class="kv"><dt>Overlap volume</dt><dd style="color:var(--danger)">${this.vol(r.volume)}</dd></dl></div>`).join('')
        : `<div class="sk-status ok" style="margin-top:14px"><div class="ring">✓</div><div><b>No interference</b><small>Visible bodies don't overlap</small></div></div>`}</div></div>
      <div class="panel-foot"><span class="spacer"></span><button class="btn primary" data-x>Done</button></div>`;
    el.querySelectorAll('[data-x]').forEach((b) => (b.onclick = () => this.exitMode()));
  }

  // ---------------------------------------------------------------- files
  loadDoc(doc, { fresh = false } = {}) {
    if (this.cmd) this.closeDialog();
    if (this.sketcher.active) this.sketcher.end(false);
    if (fresh) { this.undoStack = []; this.redoStack = []; } else this.snapshot();
    this.doc = migrateDoc(structuredClone(doc));
    this.selection = [];
    this.selFeature = null;
    if (this.sim) { this.sim.cancel(); this.sim.clear(); this.sim.pick = null; }
    this.geoCache.clear();
    this.vp.setSection({ enabled: false });
    this.refreshAll();
    this.saveState('saved');
    if (!fresh) this.scheduleSave();
    this.rebuild().then(() => { this.vp.fitAll(false); this.renderRight(); if (fresh) setTimeout(() => this.saveNow(), 400); });
  }

  saveFile() {
    this.download(new Blob([JSON.stringify(this.doc, null, 1)], { type: 'application/json' }), `${this.doc.name || 'design'}.ruffle3d.json`);
    this.toast('Project file downloaded', 'ok');
  }

  openFile() {
    const inp = document.createElement('input');
    inp.type = 'file';
    inp.accept = '.json,.ruffle3d,.forge3d';
    inp.onchange = async () => {
      const f = inp.files[0];
      if (!f) return;
      try {
        const doc = JSON.parse(await f.text());
        if (doc.version !== 1 || !Array.isArray(doc.features)) throw new Error('Not a Ruffle3D project file');
        await this.createProject(doc);
        this.toast(`Opened ${f.name}`, 'ok');
      } catch (e) { this.toast(`Could not open: ${e.message}`, 'warn'); }
    };
    inp.click();
  }

  importFile() {
    const inp = document.createElement('input');
    inp.type = 'file';
    inp.accept = '.step,.stp,.stl';
    inp.onchange = async () => {
      const f = inp.files[0];
      if (!f) return;
      const buf = new Uint8Array(await f.arrayBuffer());
      let bin = '';
      for (let i = 0; i < buf.length; i += 0x8000) bin += String.fromCharCode(...buf.subarray(i, i + 0x8000));
      const format = /\.stl$/i.test(f.name) ? 'stl' : 'step';
      this.addFeature('import', { format, data: btoa(bin), file: f.name });
      const fid = this.doc.features[this.doc.marker - 1].id;
      this.doc.features[this.doc.marker - 1].name = f.name;
      this.bodyMeta(fid).name = f.name.replace(/\.[^.]+$/, '');
      this.toast(`Imported ${f.name}`, 'ok');
      this.rebuild().then(() => this.vp.fitAll());
    };
    inp.click();
  }

  exportAs(fmtName) {
    if (fmtName === 'drawing') return this.setWorkspace('drawing');
    if (fmtName === 'png') return this.captureImage('2');
    if (fmtName === 'glb' || fmtName === 'obj') return this.exportMesh(fmtName);
    if (fmtName === '3mf') return this.export3MF();
    if (fmtName === 'dxf') return this.startDXFExport();
    return this.exportBodies(fmtName);
  }

  async exportBodies(format, ids) {
    const list = (ids || this.result.bodies.map((b) => b.id).filter((id) => this.bodyMeta(id).visible !== false)).map((id) => {
      const m = this.bodyMeta(id);
      return { id, name: m.name, color: this.appearanceOf(m).color };
    });
    if (!list.length) return this.toast('Nothing to export', 'warn');
    this.status(`Exporting ${format.toUpperCase()}…`, 'busy');
    try {
      const { buffer } = await this.kernel.export(list, format);
      const name = list.length === 1 ? list[0].name : this.doc.name;
      this.download(new Blob([buffer], { type: format === 'stl' ? 'model/stl' : 'application/step' }), `${name}.${format === 'stl' ? 'stl' : 'step'}`);
      this.status('Export complete', 'ok');
      this.toast(`Exported ${format.toUpperCase()}`, 'ok');
    } catch (e) { this.status(`Export failed: ${e.message}`, 'err'); }
  }

  exportMesh(kind) {
    const scene = new THREE.Scene();
    for (const [id, b] of this.vp.bodies) {
      if (!b.group.visible) continue;
      const m = new THREE.Mesh(b.mesh.geometry, new THREE.MeshStandardMaterial({ color: b.mats.front.color, metalness: b.mats.front.metalness, roughness: b.mats.front.roughness }));
      m.name = this.bodyMeta(id).name;
      scene.add(m);
    }
    if (!scene.children.length) return this.toast('Nothing to export', 'warn');
    // glTF is Y-up; rotate so the model stands upright in viewers
    scene.rotation.x = -Math.PI / 2;
    scene.scale.setScalar(0.001); // mm → m
    scene.updateMatrixWorld(true);
    if (kind === 'obj') {
      scene.scale.setScalar(1);
      this.download(new Blob([new OBJExporter().parse(scene)], { type: 'text/plain' }), `${this.doc.name}.obj`);
      return this.toast('Exported OBJ', 'ok');
    }
    new GLTFExporter().parse(scene, (buf) => { this.download(new Blob([buf], { type: 'model/gltf-binary' }), `${this.doc.name}.glb`); this.toast('Exported GLB', 'ok'); }, (e) => this.toast(`Export failed: ${e.message}`, 'warn'), { binary: true });
  }

  download(blob, name) {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = name.replace(/[\\/:*?"<>|]/g, '_');
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
  }
}

export { TEMPLATES, demoDocument };
window.app = new App();

// installable, offline-capable desktop app (PWA) in production builds
if ('serviceWorker' in navigator && import.meta.env.PROD) navigator.serviceWorker.register('./sw.js').catch(() => {});
window.addEventListener('beforeinstallprompt', (e) => { e.preventDefault(); window.app.installPrompt = e; });
