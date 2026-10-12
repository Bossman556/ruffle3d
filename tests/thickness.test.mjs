// Wall thickness by inward ray casting, on a plate and a shelled box (real kernel meshes).
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import opencascade from 'replicad-opencascadejs';
import { setOC, makeBaseBox } from 'replicad';
import { meshShape } from '../src/kernel/build.js';
import { wallThickness, buildGrid, castRay } from '../src/thickness.js';
import { refineMesh } from '../src/fea.js';

const root = path.dirname(fileURLToPath(import.meta.url));
setOC(await opencascade({ locateFile: () => path.join(root, '../node_modules/replicad-opencascadejs/dist/replicad_single.wasm') }));
let failures = 0;
const check = (name, cond, extra = '') => { console.log(`${cond ? 'PASS' : 'FAIL'}  ${name} ${extra}`); if (!cond) failures++; };

const plate = meshShape(makeBaseBox(100, 60, 4)).mesh;
const G = buildGrid(plate.vertices, plate.triangles);
const down = castRay(G, [10, 5, 4 - 1e-6], [0, 0, -1], 1e-9, 10);
check('ray straight down through the plate hits the bottom 4 mm away', Math.abs(down - 4) < 1e-4, down.toFixed(5));
check('ray leaving the part hits nothing', castRay(G, [10, 5, 4 + 1e-3], [0, 0, 1], 1e-6, 1) === Infinity);
const nanCount = (arr) => arr.reduce((s, x) => s + (Number.isNaN(x) ? 1 : 0), 0);

const ref = refineMesh(plate.vertices, plate.normals, plate.triangles, plate.faceGroups, 5);
const t = wallThickness(ref.positions, ref.normals, ref.index);
const onTop = [...Array(ref.positions.length / 3).keys()].filter((v) => Math.abs(ref.positions[v * 3 + 2] - 4) < 1e-6 && Math.abs(ref.positions[v * 3]) < 45 && Math.abs(ref.positions[v * 3 + 1]) < 25);
check('top-face vertices measure 4 mm', onTop.length > 50 && onTop.every((v) => Math.abs(t[v] - 4) < 1e-3), `${onTop.length} vertices, ${Math.min(...onTop.map((v) => t[v])).toFixed(4)}–${Math.max(...onTop.map((v) => t[v])).toFixed(4)}`);
const onSide = [...Array(ref.positions.length / 3).keys()].filter((v) => Math.abs(ref.positions[v * 3] - 50) < 1e-6 && Math.abs(ref.positions[v * 3 + 1]) < 29.9 && Math.abs(ref.positions[v * 3 + 2] - 2) < 1.9 && Math.abs(ref.normals[v * 3] - 1) < 1e-6);
check('side-face vertices measure the 100 mm length', onSide.length && onSide.every((v) => Math.abs(t[v] - 100) < 1e-3), `${onSide.length} vertices, ${[...new Set(onSide.map((v) => t[v].toFixed(3)))].slice(0, 8).join(' ')}`);

// open box: 80 × 50 × 30 outside, 2 mm walls, 3 mm floor
const shell = makeBaseBox(80, 50, 30).cut(makeBaseBox(76, 46, 30).translate([0, 0, 3]));
const sm = meshShape(shell).mesh;
const sr = refineMesh(sm.vertices, sm.normals, sm.triangles, sm.faceGroups, 4);
const t0 = Date.now();
const st = wallThickness(sr.positions, sr.normals, sr.index);
const ms = Date.now() - t0;
const wallV = [...Array(sr.positions.length / 3).keys()].filter((v) => Math.abs(sr.positions[v * 3] - 40) < 1e-6 && sr.positions[v * 3 + 2] > 6 && sr.positions[v * 3 + 2] < 28 && Math.abs(sr.positions[v * 3 + 1]) < 20);
check('outer wall of the shell measures 2 mm', wallV.length > 10 && wallV.every((v) => Math.abs(st[v] - 2) < 1e-3), `${wallV.length} vertices`);
const floorV = [...Array(sr.positions.length / 3).keys()].filter((v) => Math.abs(sr.positions[v * 3 + 2]) < 1e-6 && Math.abs(sr.positions[v * 3]) < 35 && Math.abs(sr.positions[v * 3 + 1]) < 20);
check('floor measures 3 mm', floorV.length > 10 && floorV.every((v) => Math.abs(st[v] - 3) < 1e-3), `${floorV.length} vertices`);
check('every vertex of the closed shell gets a thickness', nanCount(st) === 0, `${nanCount(st)} without a hit`);
check('fast enough for interactive use', ms < 4000, `${sr.positions.length / 3} vertices in ${ms} ms`);

console.log(failures ? `\n${failures} FAILED` : '\nALL PASSED');
process.exit(failures ? 1 : 0);
