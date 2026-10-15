// Configuration tables to and from CSV.
import { configsToCSV, parseCSV, applyConfigTable } from '../src/configcsv.js';

let failures = 0;
const check = (name, cond, extra = '') => { console.log(`${cond ? 'PASS' : 'FAIL'}  ${name} ${extra}`); if (!cond) failures++; };

const params = [{ name: 'width', expr: '60' }, { name: 'height', expr: 'width / 2' }, { name: 'label', expr: '3' }];
const configs = [{ id: 'a', name: 'Small', values: { width: '40' } }, { id: 'b', name: 'Large, "XL"', values: { width: '120', height: '70' } }];
const csv = configsToCSV(params, configs);
check('exports a header and one row per parameter', csv.split('\r\n').filter(Boolean).length === 4 && csv.startsWith('Parameter,Default,Small,"Large, ""XL"""'), JSON.stringify(csv.split('\r\n')[0]));
const rows = parseCSV(csv);
check('parses its own output back (quotes, commas, empty cells)', rows.length === 4 && rows[0][3] === 'Large, "XL"' && rows[2][1] === 'width / 2' && rows[2][2] === '' && rows[2][3] === '70', JSON.stringify(rows));
const same = applyConfigTable(params, configs, rows);
check('a round trip changes nothing', same.changed === 0 && same.added === 0 && same.unknown.length === 0);

// edited in a spreadsheet: new default, a value cleared, a new configuration, an unknown parameter, Excel BOM and LF endings
const edited = '\uFEFFParameter,Default,Small,"Large, ""XL""",Huge\nwidth,65,40,,300\nheight,width / 2,,70,\nmystery,1,2,3,4\n';
const r = applyConfigTable(params, configs, parseCSV(edited), () => 'new1');
const large = r.configs.find((c) => c.id === 'b'), huge = r.configs.find((c) => c.name === 'Huge');
check('updates the default value', r.params[0].expr === '65');
check('an emptied cell goes back to the default', !('width' in large.values) && large.values.height === '70');
check('a new column becomes a new configuration', r.added === 1 && huge?.id === 'new1' && huge.values.width === '300');
check('unknown parameters are reported, not added', r.unknown.join() === 'mystery' && r.params.length === 3);
check('the inputs are not modified', configs[1].values.width === '120' && params[0].expr === '60');
const semi = parseCSV('Parameter;Default;Small\r\nwidth;"60,5";40\r\n');
check('semicolon-separated files (European Excel) work too', semi[1][1] === '60,5' && semi[1][2] === '40', JSON.stringify(semi));
let err = '';
try { applyConfigTable(params, configs, parseCSV('Name,Value\nwidth,1\n')); } catch (e) { err = e.message; }
check('a file in the wrong layout explains the expected header', /Parameter, Default/.test(err), err);

console.log(failures ? `\n${failures} FAILED` : '\nALL PASSED');
process.exit(failures ? 1 : 0);
