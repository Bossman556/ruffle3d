// Templates build cleanly, measurement API works, and unit-aware expressions behave.
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import opencascade from 'replicad-opencascadejs';
import { setOC } from 'replicad';
import { rebuild, properties, measurePicks } from '../src/kernel/build.js';
import { FEATURES } from '../src/features.js';
import { evaluate, evaluateLen, evalParams } from '../src/expr.js';
import { TEMPLATES } from '../src/demo.js';

const root = path.dirname(fileURLToPath(import.meta.url));
setOC(await opencascade({ locateFile: () => path.join(root, '../node_modules/replicad-opencascadejs/dist/replicad_single.wasm') }));

let failures = 0;
const check = (name, cond, extra = '') => { console.log(`${cond ? 'PASS' : 'FAIL'}  ${name} ${extra}`); if (!cond) failures++; };
const near = (a, b, e = 1e-3) => Math.abs(a - b) < e;

function resolve(doc) {
  const { vars } = evalParams(doc.params);
  return doc.features.slice(0, doc.marker).map((f) => {
    const p = { ...f.p };
    for (const fld of FEATURES[f.type].fields) if (fld.type === 'number' || fld.type === 'int') p[fld.key] = evaluate(p[fld.key] ?? fld.default, vars);
    if (f.type === 'sketch') p.dims = p.dims.map((d) => ({ ...d, value: evaluate(d.expr, vars) }));
    return { id: f.id, type: f.type, p };
  });
}

for (const t of TEMPLATES) {
  const doc = t.make();
  const r = await rebuild(resolve(doc));
  check(`template "${t.name} (${t.sub})" builds`, !Object.keys(r.errors).length, JSON.stringify(r.errors));
}

const enc = TEMPLATES.find((t) => t.id === 'enclosure').make();
const r = await rebuild(resolve(enc));
const st = r.states.at(-1);
const v = properties(st.bodies.get('enB')).volume;
check('enclosure is hollow', v < 90 * 60 * 32 * 0.4, v.toFixed(0));

// measure: a straight vertical outer wall edge? use the top rim line on the long side and the bottom face
const m1 = measurePicks(st, [{ kind: 'face', body: 'enB', p: [0, 0, 0], n: [0, 0, -1] }]);
check('measure face area & type', m1.items[0].type === 'Plane' && m1.items[0].area > 4000, JSON.stringify(m1.items[0]));
const m2 = measurePicks(st, [{ kind: 'face', body: 'enB', p: [0, 0, 0], n: [0, 0, -1] }, { kind: 'face', body: 'enB', p: [0, -30, 20], n: [0, -1, 0] }]);
check('measure angle between floor and wall = 90°', near(m2.angle, 90, 1e-6), String(m2.angle));
const m3 = measurePicks(st, [{ kind: 'face', body: 'enB', p: [-45, 0, 14 + 4], n: [-1, 0, 0] }]);
console.log('   port face', JSON.stringify(m3.items[0]));

// units
check('plain number uses document unit', near(evaluateLen('2', {}, 25.4), 50.8));
check('parameter expression stays absolute', near(evaluateLen('w/2', { w: 100 }, 25.4), 50));
check('explicit unit suffix stays absolute', near(evaluateLen('1 in', {}, 10), 25.4));
check('params in inch document', near(evalParams([{ name: 'a', expr: '2' }, { name: 'b', expr: 'a*2' }], 25.4).vars.b, 101.6));

console.log(failures ? `\n${failures} FAILED` : '\nALL PASSED');
process.exit(failures ? 1 : 0);
