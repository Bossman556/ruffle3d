// Version compare: material added and removed between two feature lists, without disturbing the main cache.
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import opencascade from 'replicad-opencascadejs';
import { setOC } from 'replicad';
import { rebuild, compareWithFeatures, properties } from '../src/kernel/build.js';

const root = path.dirname(fileURLToPath(import.meta.url));
setOC(await opencascade({ locateFile: () => path.join(root, '../node_modules/replicad-opencascadejs/dist/replicad_single.wasm') }));
let failures = 0;
const check = (name, cond, extra = '') => { console.log(`${cond ? 'PASS' : 'FAIL'}  ${name} ${extra}`); if (!cond) failures++; };
const near = (a, b, e = 1e-3) => Math.abs(a - b) < e;

const box = { id: 'b', type: 'box', p: { w: 100, d: 50, h: 10, x: 0, y: 0, z: 0, op: 'new' } };
const hole = { id: 'h', type: 'hole', p: { points: [{ body: 'b', p: [0, 0, 10], n: [0, 0, 1] }], diameter: 10, through: true, depth: 10 } };
const boss = { id: 'c', type: 'box', p: { w: 20, d: 20, h: 10, x: 30, y: 0, z: 10, op: 'join', target: 'b' } };
const extra = { id: 'e', type: 'box', p: { w: 10, d: 10, h: 10, x: 0, y: 40, z: 0, op: 'new' } };

const oldFeatures = [box];
const current = await rebuild([box, hole, boss, extra]);
const cur = current.states.at(-1);
const diff = await compareWithFeatures(cur, oldFeatures);
const b = diff.find((d) => d.id === 'b'), e = diff.find((d) => d.id === 'e');
check('changed body: the boss is added', b && b.status === 'changed' && b.added && near(b.added.volume, 20 * 20 * 10, 0.05), b?.added && b.added.volume.toFixed(3));
check('changed body: the hole is removed', b?.removed && near(b.removed.volume, Math.PI * 25 * 10, 0.05), b?.removed && b.removed.volume.toFixed(3));
check('new body is reported as new', e && e.status === 'new' && near(e.added.volume, 1000, 1e-3));
check('volumes then and now', near(b.volOld, 50000, 1e-3) && near(b.volNew, 50000 + 4000 - Math.PI * 250, 0.05), `${b.volOld.toFixed(1)} → ${b.volNew.toFixed(1)}`);
check('meshes come back for display', b.added.mesh.triangles.length > 0 && b.removed.mesh.triangles.length > 0);

// the main rebuild cache still holds the current model (a repeat build is a cache hit with the same shapes)
const again = await rebuild([box, hole, boss, extra]);
check('current model cache is untouched', again.states.at(-1).bodies.get('b') === cur.bodies.get('b') && near(properties(again.states.at(-1).bodies.get('b')).volume, b.volNew, 1e-6));
// deleted body
const d2 = await compareWithFeatures((await rebuild([box])).states.at(-1), [box, extra]);
check('a body removed since the version is reported as deleted', d2.find((d) => d.id === 'e')?.status === 'deleted');

console.log(failures ? `\n${failures} FAILED` : '\nALL PASSED');
process.exit(failures ? 1 : 0);
