// Import: STL (sewn into a solid) and STEP round trips through the Import feature.
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import opencascade from 'replicad-opencascadejs';
import { setOC, makeBaseBox, makeCylinder, exportSTEP } from 'replicad';
import { rebuild, properties, hasSolid } from '../src/kernel/build.js';
import { surfaceNets } from '../src/fea.js';

const root = path.dirname(fileURLToPath(import.meta.url));
setOC(await opencascade({ locateFile: () => path.join(root, '../node_modules/replicad-opencascadejs/dist/replicad_single.wasm') }));
let failures = 0;
const check = (name, cond, extra = '') => { console.log(`${cond ? 'PASS' : 'FAIL'}  ${name} ${extra}`); if (!cond) failures++; };
const b64 = async (blob) => Buffer.from(await blob.arrayBuffer()).toString('base64');
const imp = async (id, format, data) => (await rebuild([{ id, type: 'import', p: { format, data, file: `x.${format}` } }]));

let r = await imp('s1', 'stl', await b64(makeBaseBox(20, 10, 5).blobSTL({ binary: true })));
let s = r.states.at(-1).bodies.get('s1');
check('binary STL box imports as a solid', !r.errors.s1 && s && hasSolid(s), r.errors.s1 || '');
check('imported box has the right volume and merged faces', s && Math.abs(properties(s).volume - 1000) < 1e-3 && s.faces.length === 6, s && `${properties(s).volume.toFixed(3)} mm³, ${s.faces.length} faces`);

r = await imp('s2', 'stl', await b64(makeCylinder(5, 10).blobSTL({ binary: false, tolerance: 0.02 })));
s = r.states.at(-1).bodies.get('s2');
check('ASCII STL cylinder imports as a solid', !r.errors.s2 && s && hasSolid(s) && Math.abs(properties(s).volume - Math.PI * 250) / (Math.PI * 250) < 0.01, r.errors.s2 || (s && properties(s).volume.toFixed(2)));

// a surface-nets mesh (the kind generative design produces)
const NX = 10, NY = 8, NZ = 6, fld = new Float32Array(NX * NY * NZ);
for (let k = 1; k < 5; k++) for (let j = 1; j < 7; j++) for (let i = 1; i < 9; i++) fld[(k * NY + j) * NX + i] = 1;
const sn = surfaceNets(fld, [NX, NY, NZ], [0, 0, 0], 2, 0.5);
const nt = sn.index.length / 3, buf = Buffer.alloc(84 + nt * 50);
buf.writeUInt32LE(nt, 80);
let o = 84;
for (let t = 0; t < nt; t++) { o += 12; for (let k = 0; k < 3; k++) { const i = sn.index[t * 3 + k]; for (let c = 0; c < 3; c++) { buf.writeFloatLE(sn.positions[i * 3 + c], o); o += 4; } } o += 2; }
r = await imp('s3', 'stl', buf.toString('base64'));
s = r.states.at(-1).bodies.get('s3');
check('generated organic mesh imports as a closed solid', !r.errors.s3 && s && hasSolid(s) && properties(s).volume > 100, r.errors.s3 || (s && `${properties(s).volume.toFixed(1)} mm³`));

r = await imp('p1', 'step', await b64(exportSTEP([{ shape: makeBaseBox(30, 20, 10).cut(makeCylinder(4, 20, [0, 0, -5])), name: 'part' }])));
s = r.states.at(-1).bodies.get('p1');
check('STEP round trip keeps the exact volume', !r.errors.p1 && s && Math.abs(properties(s).volume - (6000 - Math.PI * 16 * 10)) < 1e-3, r.errors.p1 || (s && properties(s).volume.toFixed(3)));

console.log(failures ? `\n${failures} FAILED` : '\nALL PASSED');
process.exit(failures ? 1 : 0);
