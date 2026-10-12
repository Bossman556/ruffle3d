// Assemblies: components from other feature lists, mates solved together, degrees of freedom, conflicts.
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import opencascade from 'replicad-opencascadejs';
import { setOC } from 'replicad';
import { rebuild, solveAssembly, properties, projectViews, drawingHoles } from '../src/kernel/build.js';

const root = path.dirname(fileURLToPath(import.meta.url));
setOC(await opencascade({ locateFile: () => path.join(root, '../node_modules/replicad-opencascadejs/dist/replicad_single.wasm') }));
let failures = 0;
const check = (name, cond, extra = '') => { console.log(`${cond ? 'PASS' : 'FAIL'}  ${name} ${extra}`); if (!cond) failures++; };
const near = (a, b, e = 1e-4) => Math.abs(a - b) < e;

// part projects: a 60 × 40 × 10 plate with a Ø8 through hole at its centre, and a Ø8 × 30 pin
const plate = [
  { id: 'pl', type: 'box', p: { w: 60, d: 40, h: 10, x: 0, y: 0, z: 0, op: 'new' } },
  { id: 'ho', type: 'hole', p: { points: [{ body: 'pl', p: [0, 0, 10], n: [0, 0, 1] }], diameter: 8, through: true, depth: 10 } },
];
const pin = [{ id: 'pn', type: 'cylinder', p: { r: 4, h: 30, axis: 'Z', x: 0, y: 0, z: 0, op: 'new' } }];
const comp = (id, features, extra = {}) => ({ id, type: 'component', p: { name: id, features, x: 0, y: 0, z: 0, rx: 0, ry: 0, rz: 0, ...extra } });
const asm = [comp('A', plate, { grounded: true }), comp('B', pin, { x: 100, y: 20, z: 5, rx: 90 })];
const r = await rebuild(asm);
const st = r.states.at(-1);
check('components build and insert their bodies', !r.errors.A && !r.errors.B && st.bodies.has('A/pl') && [...st.bodies.keys()].some((k) => k.startsWith('B/')), JSON.stringify([...st.bodies.keys()]));
const pinId = [...st.components.get('B').local.keys()][0];
check('the unmated pin sits where it was placed', near(properties(st.bodies.get(`B/${pinId}`)).bbox[0][0], 96, 1e-3), JSON.stringify(properties(st.bodies.get(`B/${pinId}`)).bbox));

// mates: the pin in the hole (concentric) with its end flush with the bottom of the plate
const mates = [
  { id: 'm1', type: 'concentric', a: { comp: 'A', body: 'pl', p: [4, 0, 5], n: [-1, 0, 0] }, b: { comp: 'B', body: pinId, p: [4, 0, 15], n: [1, 0, 0] } },
  { id: 'm2', type: 'flush', a: { comp: 'A', body: 'pl', p: [20, 10, 0], n: [0, 0, -1] }, b: { comp: 'B', body: pinId, p: [0, 1, 0], n: [0, 0, -1] } },
];
let s = solveAssembly(st, mates);
const bb = properties(s.state.bodies.get(`B/${pinId}`)).bbox;
check('all mates are satisfied', s.assembly.mates.every((m) => m.ok), JSON.stringify(s.assembly.mates));
check('the pin is in the hole, upright, flush with the bottom', near(bb[0][0], -4, 1e-3) && near(bb[1][0], 4, 1e-3) && near(bb[0][1], -4, 1e-3) && near(bb[0][2], 0, 1e-3) && near(bb[1][2], 30, 1e-3), JSON.stringify(bb.map((v) => v.map((x) => +x.toFixed(4)))));
check('one degree of freedom is left (spin about the axis)', s.assembly.dof === 1, `dof ${s.assembly.dof}, ${s.assembly.iterations} iterations`);
check('the plate stays grounded', near(properties(s.state.bodies.get('A/pl')).bbox[0][0], -30, 1e-6));

// a 2 mm gap by offset
s = solveAssembly(st, [mates[0], { ...mates[1], offset: -2 }]);
check('flush with an offset moves the pin by the offset', s.assembly.mates.every((m) => m.ok) && near(properties(s.state.bodies.get(`B/${pinId}`)).bbox[0][2], 2, 1e-3), JSON.stringify(properties(s.state.bodies.get(`B/${pinId}`)).bbox[0]));

// conflicting: the pin end flush with both the top and the bottom of the plate
s = solveAssembly(st, [...mates, { id: 'm3', type: 'flush', a: { comp: 'A', body: 'pl', p: [20, 10, 10], n: [0, 0, 1] }, b: { comp: 'B', body: pinId, p: [0, 1, 0], n: [0, 0, -1] }, flip: true }]);
check('only the conflicting mate is reported; the earlier ones stay satisfied', s.assembly.mates.filter((m) => !m.ok).map((m) => m.id).join() === 'm3' && /Conflicts/.test(s.assembly.mates.find((m) => m.id === 'm3').error), JSON.stringify(s.assembly.mates.map((m) => [m.id, m.ok, +m.residual.toFixed(3)])));

// a part with no mates keeps its placement (and counts 6 degrees of freedom)
const st4 = (await rebuild([...asm, comp('D', pin, { x: 50, y: 60, rz: 45 })])).states.at(-1);
const s4 = solveAssembly(st4, mates);
check('an unmated part stays where it was placed', JSON.stringify(s4.assembly.transforms.D.t) === '[50,60,0]' && near(s4.assembly.transforms.D.r[2], Math.PI / 4) && s4.assembly.dof === 7, `${JSON.stringify(s4.assembly.transforms.D)} dof ${s4.assembly.dof}`);

// distance is measured out from the first face: a second plate 18 mm above the top of the first
const st5 = (await rebuild([comp('A', plate, { grounded: true }), comp('E', plate, { z: -40 })])).states.at(-1);
const s5 = solveAssembly(st5, [{ id: 'd', type: 'distance', offset: 18, a: { comp: 'A', body: 'pl', p: [20, 10, 10], n: [0, 0, 1] }, b: { comp: 'E', body: 'pl', p: [20, 10, 0], n: [0, 0, -1] } }]);
check('distance puts the part on the side the first face points to', s5.assembly.mates[0].ok && near(s5.assembly.transforms.E.t[2], 28, 1e-3), JSON.stringify(s5.assembly.transforms.E));

// angle mate: a second plate hinged on the pin at 30° to the first
const asm2 = [comp('A', plate, { grounded: true }), comp('C', plate, { x: 0, y: 80, z: 30 })];
const st2 = (await rebuild(asm2)).states.at(-1);
const s2 = solveAssembly(st2, [
  { id: 'c', type: 'concentric', a: { comp: 'A', body: 'pl', p: [4, 0, 5], n: [-1, 0, 0] }, b: { comp: 'C', body: 'pl', p: [4, 0, 5], n: [-1, 0, 0] } },
  { id: 'f', type: 'mate', a: { comp: 'A', body: 'pl', p: [20, 10, 10], n: [0, 0, 1] }, b: { comp: 'C', body: 'pl', p: [20, 10, 0], n: [0, 0, -1] } },
  { id: 'g', type: 'angle', angle: 30, a: { comp: 'A', body: 'pl', p: [30, 0, 5], n: [1, 0, 0] }, b: { comp: 'C', body: 'pl', p: [30, 0, 5], n: [1, 0, 0] } },
]);
const T = s2.assembly.transforms.C, ang = (Math.hypot(...T.r) * 180) / Math.PI;
check('stacked plate: on top, concentric, turned 30°', s2.assembly.mates.every((m) => m.ok) && near(ang, 30, 1e-3) && near(T.t[2], 10, 1e-3), `${ang.toFixed(4)}°, t ${T.t.map((v) => +v.toFixed(4))}`);
check('fully constrained: no degrees of freedom left', s2.assembly.dof === 0, `dof ${s2.assembly.dof}`);

// bad references are reported per mate without breaking the others
const s3 = solveAssembly(st, [mates[0], { id: 'x', type: 'concentric', a: { comp: 'A', body: 'pl', p: [20, 10, 10], n: [0, 0, 1] }, b: { comp: 'B', body: pinId, p: [4, 0, 15], n: [1, 0, 0] } }]);
check('a mate on the wrong kind of face explains why', /round faces/.test(s3.assembly.mates.find((m) => m.id === 'x')?.error || '') && s3.assembly.mates.find((m) => m.id === 'm1').ok, JSON.stringify(s3.assembly.mates));

// drawing the assembly must not consume its bodies, and the front view maps model points onto the sheet
const sh = [...s2.state.bodies.values()];
const fv = projectViews(sh, ['front'])[0];
drawingHoles(sh);
let alive = true;
try { for (const b of sh) properties(b); } catch { alive = false; }
const P = fv.proj, mapX = (q) => q[0] * P.x[0] + q[1] * P.x[1] + q[2] * P.x[2] + P.ox, mapY = (q) => -(q[0] * P.up[0] + q[1] * P.up[1] + q[2] * P.up[2]) + P.oy;
check('drawing views leave the bodies usable', alive);
check('front view projection maps the model onto the view', near(mapX([Math.min(...sh.map((b) => properties(b).bbox[0][0])), 0, 0]), fv.bbox[0][0], 1e-3) && near(mapY([0, 0, 0]), fv.bbox[1][1], 1e-3), JSON.stringify({ bbox: fv.bbox, P }));

// the part changes: its hole moves 15 mm; the mate follows the hole with the same radius
{
  const plate2 = (w, hx) => [{ id: 'pl', type: 'box', p: { w, d: 40, h: 8, x: 0, y: 0, z: 0, op: 'new' } }, { id: 'ho', type: 'hole', p: { points: [{ body: 'pl', p: [-hx, 0, 8], n: [0, 0, 1] }, { body: 'pl', p: [hx, 0, 8], n: [0, 0, 1] }], diameter: 8, through: true, depth: 8 } }];
  const sig = { k: 'f', c: [-30, 0, 4], n: [0, 0, 0], a: 2 * Math.PI * 4 * 8, pl: false };
  const mm = [{ id: 'c', type: 'concentric', a: { comp: 'A', body: 'pl', p: [-26, 0, 4], n: [-1, 0, 0], s: sig, r: 4 }, b: { comp: 'B', body: 'pn', p: [4, 0, 15], n: [1, 0, 0] } }];
  const st6 = (await rebuild([comp('A', plate2(120, 45), { grounded: true }), comp('B', pin, { x: 100 })])).states.at(-1);
  const s6 = solveAssembly(st6, mm);
  check('a mate follows a hole that moved when the part changed', s6.assembly.mates[0].ok && near(s6.assembly.transforms.B.t[0], -45, 1e-3) && s6.assembly.mates[0].ra === 4, JSON.stringify(s6.assembly.mates) + " it " + s6.assembly.iterations + " " + JSON.stringify(s6.assembly.transforms.B));
}

// motion limits: a hinged plate placed at 90° stops at its 45° limit; one placed at 20° stays there and can still swing
{
  const hinge = (rz) => [comp('A', plate, { grounded: true }), comp('C', plate, { z: 10, rz })];
  const ms = (min, max) => [
    { id: 'c', type: 'concentric', a: { comp: 'A', body: 'pl', p: [4, 0, 5], n: [-1, 0, 0] }, b: { comp: 'C', body: 'pl', p: [4, 0, 5], n: [-1, 0, 0] } },
    { id: 'f', type: 'mate', a: { comp: 'A', body: 'pl', p: [20, 10, 10], n: [0, 0, 1] }, b: { comp: 'C', body: 'pl', p: [20, 10, 0], n: [0, 0, -1] } },
    { id: 'g', type: 'angle', limit: true, min, max, a: { comp: 'A', body: 'pl', p: [30, 0, 5], n: [1, 0, 0] }, b: { comp: 'C', body: 'pl', p: [30, 0, 5], n: [1, 0, 0] } },
  ];
  const sA = solveAssembly((await rebuild(hinge(90))).states.at(-1), ms(0, 45));
  const angA = (Math.hypot(...sA.assembly.transforms.C.r) * 180) / Math.PI;
  check('an angle limit stops a part at the end of its range', sA.assembly.mates.every((m) => m.ok) && near(angA, 45, 1e-3), `${angA.toFixed(4)}°`);
  const sB = solveAssembly((await rebuild(hinge(20))).states.at(-1), ms(0, 45));
  const angB = (Math.hypot(...sB.assembly.transforms.C.r) * 180) / Math.PI;
  check('inside its range the part stays put and keeps its freedom', near(angB, 20, 1e-3) && sB.assembly.dof === 1, `${angB.toFixed(4)}° dof ${sB.assembly.dof}`);
  // a slide with end stops: plate E above A at 40 mm, limited to 5–15 mm
  const sC = solveAssembly((await rebuild([comp('A', plate, { grounded: true }), comp('E', plate, { z: 50 })])).states.at(-1), [{ id: 'd', type: 'distance', limit: true, min: 5, max: 15, a: { comp: 'A', body: 'pl', p: [20, 10, 10], n: [0, 0, 1] }, b: { comp: 'E', body: 'pl', p: [20, 10, 0], n: [0, 0, -1] } }]);
  check('a distance range stops a slide at its end stop', sC.assembly.mates[0].ok && near(sC.assembly.transforms.E.t[2], 25, 1e-3), JSON.stringify(sC.assembly.transforms.E.t));
}

// gear mate: two gears on a grounded plate, 2:1; turning the first 30° turns the second 60° the other way
{
  const base = [{ id: 'pl', type: 'box', p: { w: 200, d: 100, h: 10, x: 0, y: 0, z: 0, op: 'new' } }, { id: 'ho', type: 'hole', p: { points: [{ body: 'pl', p: [0, 0, 10], n: [0, 0, 1] }, { body: 'pl', p: [50, 0, 10], n: [0, 0, 1] }], diameter: 8, through: true, depth: 10 } }];
  const gearPart = [{ id: 'g', type: 'box', p: { w: 20, d: 10, h: 5, x: 0, y: 0, z: 0, op: 'new' } }, { id: 'gh', type: 'hole', p: { points: [{ body: 'g', p: [0, 0, 5], n: [0, 0, 1] }], diameter: 8, through: true, depth: 5 } }];
  const st7 = (await rebuild([comp('P', base, { grounded: true }), comp('G1', gearPart, { z: 10 }), comp('G2', gearPart, { x: 50, z: 10 })])).states.at(-1);
  const hole = (C, x) => ({ comp: C, body: C === 'P' ? 'pl' : 'g', p: [x + 4, 0, C === 'P' ? 5 : 2.5], n: [-1, 0, 0] });
  const mates = [
    { id: 'c1', type: 'concentric', a: hole('P', 0), b: hole('G1', 0) }, { id: 'f1', type: 'mate', a: { comp: 'P', body: 'pl', p: [-20, 30, 10], n: [0, 0, 1] }, b: { comp: 'G1', body: 'g', p: [8, 3, 0], n: [0, 0, -1] } },
    { id: 'c2', type: 'concentric', a: hole('P', 50), b: hole('G2', 0) }, { id: 'f2', type: 'mate', a: { comp: 'P', body: 'pl', p: [-20, 30, 10], n: [0, 0, 1] }, b: { comp: 'G2', body: 'g', p: [8, 3, 0], n: [0, 0, -1] } },
    { id: 'gr', type: 'gear', ratio: 2, a: hole('G1', 0), b: hole('G2', 0) },
  ];
  const s0 = solveAssembly(st7, mates);
  check('gears mesh where they were placed; one turn is left free', s0.assembly.mates.every((m) => m.ok) && s0.assembly.dof === 1, `dof ${s0.assembly.dof} ${JSON.stringify(s0.assembly.mates.map((m) => m.ok))}`);
  const s1 = solveAssembly(st7, [...mates, { id: 'an', type: 'angle', angle: 30, a: { comp: 'P', body: 'pl', p: [100, 0, 5], n: [1, 0, 0] }, b: { comp: 'G1', body: 'g', p: [10, 0, 2.5], n: [1, 0, 0] } }]);
  const z1 = (s1.assembly.transforms.G1.r[2] * 180) / Math.PI, z2 = (s1.assembly.transforms.G2.r[2] * 180) / Math.PI;
  check('turning the first gear 30° turns the second 60° the other way', s1.assembly.mates.every((m) => m.ok) && near(Math.abs(z1), 30, 1e-3) && near(z2, -2 * z1, 1e-3) && s1.assembly.dof === 0, `${z1.toFixed(4)}° → ${z2.toFixed(4)}°, dof ${s1.assembly.dof}`);
}

// rack and pinion: a pinion (pitch radius 10) turned 90° slides a rack 10 × π/2 along its length
{
  const base = [{ id: 'pl', type: 'box', p: { w: 200, d: 100, h: 10, x: 0, y: 0, z: 0, op: 'new' } }, { id: 'ho', type: 'hole', p: { points: [{ body: 'pl', p: [0, 0, 10], n: [0, 0, 1] }], diameter: 8, through: true, depth: 10 } }];
  const pinion = [{ id: 'g', type: 'box', p: { w: 20, d: 10, h: 5, x: 0, y: 0, z: 0, op: 'new' } }, { id: 'gh', type: 'hole', p: { points: [{ body: 'g', p: [0, 0, 5], n: [0, 0, 1] }], diameter: 8, through: true, depth: 5 } }];
  const rackPart = [{ id: 'rk', type: 'box', p: { w: 80, d: 6, h: 5, x: 0, y: 0, z: 0, op: 'new' } }];
  const st8 = (await rebuild([comp('P', base, { grounded: true }), comp('G', pinion, { z: 10 }), comp('R', rackPart, { y: 15, z: 10 })])).states.at(-1);
  const top = { comp: 'P', body: 'pl', p: [-20, 30, 10], n: [0, 0, 1] };
  const mates = [
    { id: 'c', type: 'concentric', a: { comp: 'P', body: 'pl', p: [4, 0, 5], n: [-1, 0, 0] }, b: { comp: 'G', body: 'g', p: [4, 0, 2.5], n: [-1, 0, 0] } },
    { id: 'f', type: 'mate', a: top, b: { comp: 'G', body: 'g', p: [8, 3, 0], n: [0, 0, -1] } },
    // the rack lies on the plate, against a line y = 15, and slides along x
    { id: 'rf', type: 'mate', a: top, b: { comp: 'R', body: 'rk', p: [0, 0, 0], n: [0, 0, -1] } },
    { id: 'ry', type: 'distance', offset: -62, a: { comp: 'P', body: 'pl', p: [0, -50, 5], n: [0, -1, 0] }, b: { comp: 'R', body: 'rk', p: [0, -3, 2.5], n: [0, -1, 0] } },
    { id: 'rp', type: 'parallel', a: { comp: 'P', body: 'pl', p: [100, 0, 5], n: [1, 0, 0] }, b: { comp: 'R', body: 'rk', p: [40, 0, 2.5], n: [1, 0, 0] } },
    { id: 'rk', type: 'rack', radius: 10, a: { comp: 'G', body: 'g', p: [4, 0, 2.5], n: [-1, 0, 0] }, b: { comp: 'R', body: 'rk', p: [40, 0, 2.5], n: [1, 0, 0] } },
  ];
  const s0 = solveAssembly(st8, mates);
  const x0 = s0.assembly.transforms.R.t[0];
  const s1 = solveAssembly(st8, [...mates, { id: 'an', type: 'angle', angle: 90, a: { comp: 'P', body: 'pl', p: [100, 0, 5], n: [1, 0, 0] }, b: { comp: 'G', body: 'g', p: [10, 0, 2.5], n: [1, 0, 0] } }]);
  const dx = s1.assembly.transforms.R.t[0] - x0, turn = s1.assembly.transforms.G.r[2];
  check('rack and pinion: turning the pinion 90° slides the rack 15.708', s0.assembly.mates.every((m) => m.ok) && s1.assembly.mates.every((m) => m.ok) && near(Math.abs(dx), 10 * Math.PI / 2, 1e-3), `s0 ${JSON.stringify(s0.assembly.mates.filter((m) => !m.ok))} dx ${dx.toFixed(4)} turn ${(turn * 180 / Math.PI).toFixed(3)}° ${JSON.stringify(s1.assembly.mates.filter((m) => !m.ok))}`);
}

// contact: a plate dropped into the base stops at the surface; one placed above stays there
{
  const st9 = (await rebuild([comp('A', plate, { grounded: true }), comp('E', plate, { z: 4 }), comp('F', plate, { y: 100, z: 30 })])).states.at(-1);
  const ct = (C) => ({ id: 'k' + C, type: 'contact', a: { comp: 'A', body: 'pl', p: [20, 10, 10], n: [0, 0, 1] }, b: { comp: C, body: 'pl', p: [20, 10, 0], n: [0, 0, -1] } });
  const s9 = solveAssembly(st9, [ct('E'), ct('F')]);
  check('contact pushes a part out of another but lets it lift off', s9.assembly.mates.every((m) => m.ok) && near(s9.assembly.transforms.E.t[2], 10, 1e-3) && near(s9.assembly.transforms.F.t[2], 30, 1e-3), `${s9.assembly.transforms.E.t[2]} ${s9.assembly.transforms.F.t[2]}`);
}

console.log(failures ? `\n${failures} FAILED` : '\nALL PASSED');
process.exit(failures ? 1 : 0);
