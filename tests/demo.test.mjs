// Builds the demo design, then changes parameters and checks it still rebuilds without errors.
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import opencascade from 'replicad-opencascadejs';
import { setOC } from 'replicad';
import { rebuild, properties } from '../src/kernel/build.js';
import { FEATURES } from '../src/features.js';
import { evaluate, evalParams } from '../src/expr.js';
import { demoDocument } from '../src/demo.js';

const root = path.dirname(fileURLToPath(import.meta.url));
setOC(await opencascade({ locateFile: () => path.join(root, '../node_modules/replicad-opencascadejs/dist/replicad_single.wasm') }));

function resolve(doc) {
  const { vars } = evalParams(doc.params);
  return doc.features.slice(0, doc.marker).map((f) => {
    const p = { ...f.p };
    for (const fld of FEATURES[f.type].fields) if (fld.type === 'number' || fld.type === 'int') p[fld.key] = evaluate(p[fld.key] ?? fld.default, vars);
    if (f.type === 'sketch') p.dims = p.dims.map((d) => ({ ...d, value: evaluate(d.expr, vars) }));
    return { id: f.id, type: f.type, p, suppressed: !!f.suppressed };
  });
}

let failures = 0;
const check = (name, cond, extra = '') => { console.log(`${cond ? 'PASS' : 'FAIL'}  ${name} ${extra}`); if (!cond) failures++; };

const doc = demoDocument();
let r = await rebuild(resolve(doc));
check('demo builds without errors or warnings', !Object.keys(r.errors).length && !Object.keys(r.warnings).length, JSON.stringify([r.errors, r.warnings]));
const v0 = properties(r.states.at(-1).bodies.get('exA')).volume;
console.log('demo volume', v0.toFixed(1));

for (const [name, val] of [['plate_w', '120'], ['thick', '10'], ['plate_d', '70']]) {
  doc.params.find((p) => p.name === name).expr = val;
  r = await rebuild(resolve(doc));
  const errs = Object.keys(r.errors);
  check(`rebuild after ${name}=${val}`, !errs.length || (errs.length === 1 && errs[0] === 'chA'), JSON.stringify(r.errors));
  const bb = properties(r.states.at(-1).bodies.get('exA')).bbox;
  console.log('   bbox', JSON.stringify(bb.map((v) => v.map((x) => +x.toFixed(2)))));
}
check('fillets survived resize (corner rounded)', !r.errors.fiA);
check('throughholes still cut through boss', !r.errors.hoA);
console.log(failures ? `\n${failures} FAILED` : '\nALL PASSED');
process.exit(failures ? 1 : 0);
