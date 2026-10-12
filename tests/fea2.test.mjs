// Natural frequencies (against beam theory) and topology optimisation.
import { solveModal, optimizeTopology, surfaceNets } from '../src/fea.js';

let failures = 0;
const check = (name, cond, extra = '') => { console.log(`${cond ? 'PASS' : 'FAIL'}  ${name} ${extra}`); if (!cond) failures++; };
function boxMesh(L, W, H) {
  const P = [], I = [], groups = [];
  const quad = (a, b, c, d) => { const s = P.length / 3; P.push(...a, ...b, ...c, ...d); groups.push({ start: I.length, count: 6 }); I.push(s, s + 1, s + 2, s, s + 2, s + 3); };
  quad([0, 0, 0], [0, 0, H], [0, W, H], [0, W, 0]);
  quad([L, 0, 0], [L, W, 0], [L, W, H], [L, 0, H]);
  quad([0, 0, 0], [L, 0, 0], [L, 0, H], [0, 0, H]);
  quad([0, W, 0], [0, W, H], [L, W, H], [L, W, 0]);
  quad([0, 0, 0], [0, W, 0], [L, W, 0], [L, 0, 0]);
  quad([0, 0, H], [L, 0, H], [L, W, H], [0, W, H]);
  return { positions: new Float32Array(P), index: new Uint32Array(I), faceGroups: groups };
}

// steel cantilever 100 × 10 × 10: f1 = (1.875² / 2π) √(EI / ρAL⁴) ≈ 815 Hz (twice, square section);
// second bending ≈ 6.27 f1; torsion ≈ 7.19 kHz
const E = 200000, rho = 7.85e-9, b = 10, L = 100, I = b ** 4 / 12;
const f1 = ((1.875 ** 2) / (2 * Math.PI)) * Math.sqrt((E * I) / (rho * b * b * L ** 4));
const bar = boxMesh(L, b, b);
let t0 = Date.now();
const m = solveModal({ ...bar, E, nu: 0.3, density: 7.85, elements: 5120, fixed: [0], modes: 4 });
const fs = m.modes.map((x) => x.frequency);
check('modal analysis finds 4 modes', fs.length === 4 && fs.every((v) => v > 0), `${fs.map((v) => v.toFixed(0)).join(', ')} Hz in ${Date.now() - t0} ms, ${m.iterations} iterations`);
check('first bending frequency within 5% of beam theory', Math.abs(fs[0] - f1) / f1 < 0.05 && Math.abs(fs[1] - f1) / f1 < 0.05, `${fs[0].toFixed(0)} / ${fs[1].toFixed(0)} vs ${f1.toFixed(0)} Hz`);
check('second bending pair ≈ 6.27 × f1 (within 8%)', Math.abs(fs[2] / f1 - 6.267) / 6.267 < 0.08, `${(fs[2] / f1).toFixed(2)} × f1`);
check('mass is ρ × volume', Math.abs(m.mass - 7.85e-6 * 1e4) < 1e-4, `${m.mass.toFixed(4)} kg`);
const p0 = m.modes[0].participation;
check('first mode moves sideways (Y or Z), not along the bar', p0[0] < 0.01 && Math.max(p0[1], p0[2]) > 0.4, JSON.stringify(p0.map((v) => +v.toFixed(3))));
check('mode shapes are sampled at the mesh vertices', m.modes[0].shape.length === bar.positions.length);

// surface nets on a filled block gives a closed mesh
const NX = 6, NY = 6, NZ = 6, fld = new Float32Array(NX * NY * NZ);
for (let k = 1; k < 5; k++) for (let j = 1; j < 5; j++) for (let i = 1; i < 5; i++) fld[(k * NY + j) * NX + i] = 1;
const sn = surfaceNets(fld, [NX, NY, NZ], [0, 0, 0], 1, 0.5);
const edges = new Map();
for (let t = 0; t < sn.index.length; t += 3) for (let a = 0; a < 3; a++) { const x = sn.index[t + a], y = sn.index[t + ((a + 1) % 3)]; const k = x < y ? `${x},${y}` : `${y},${x}`; edges.set(k, (edges.get(k) || 0) + 1); }
check('surface nets mesh is closed', sn.index.length > 0 && [...edges.values()].every((c) => c === 2), `${sn.index.length / 3} triangles`);

// topology optimisation of a short cantilever plate: compliance must drop well below the uniform start
const plate = boxMesh(60, 30, 6);
t0 = Date.now();
const top = optimizeTopology({ ...plate, E: 70000, nu: 0.33, elements: 4000, fixed: [0], loads: [{ faces: [1], type: 'force', value: 500, dir: [0, 0, -1] }], volume: 0.4, iterations: 25 });
check('optimisation keeps about the requested volume', Math.abs(top.volumeFraction - 0.4) < 0.05, `${(top.volumeFraction * 100).toFixed(1)}%`);
check('compliance falls during optimisation', top.compliance < top.initialCompliance * 0.8, `${top.initialCompliance.toFixed(2)} → ${top.compliance.toFixed(2)} N·mm in ${top.iterations} steps, ${Date.now() - t0} ms`);
const solid = top.density.filter((d) => d > 0.9).length, voidish = top.density.filter((d) => d < 0.1).length;
check('densities converge towards solid or void', (solid + voidish) / top.density.length > 0.6, `${solid} solid, ${voidish} void of ${top.density.length}`);
check('optimised shape is stiffer per gram than the full plate', top.stiffnessRatio / top.volumeFraction > 1.1 && top.stiffnessRatio < 1, `${(top.stiffnessRatio * 100).toFixed(0)}% stiffness with ${(top.volumeFraction * 100).toFixed(0)}% material`);
check('optimised shape has a surface mesh', top.surface.index.length > 300, `${top.surface.index.length / 3} triangles`);

console.log(failures ? `\n${failures} FAILED` : '\nALL PASSED');
process.exit(failures ? 1 : 0);
