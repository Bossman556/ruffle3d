// Configuration tables as CSV, for editing design variants in a spreadsheet.
// Layout: a header row "Parameter, Default, <configuration names…>", then one row per parameter.
// An empty cell in a configuration column means "use the Default value".

const quote = (v) => { const s = String(v ?? ''); return /[",\r\n]/.test(s) || /^\s|\s$/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };

export function configsToCSV(params, configs) {
  const rows = [['Parameter', 'Default', ...configs.map((c) => c.name)]];
  for (const p of params) rows.push([p.name, p.expr, ...configs.map((c) => c.values?.[p.name] ?? '')]);
  return `${rows.map((r) => r.map(quote).join(',')).join('\r\n')}\r\n`;
}

/** RFC 4180 CSV (quoted fields, doubled quotes, CRLF or LF, comma or semicolon); a leading byte-order mark is ignored. */
export function parseCSV(text) {
  const rows = [];
  let row = [], field = '', q = false;
  const s = text.replace(/^\uFEFF/, '');
  // Excel in many European locales separates with semicolons: use whichever the header row has more of
  const nl = s.search(/\r?\n/), head = (nl < 0 ? s : s.slice(0, nl)).replace(/"[^"]*"/g, '');
  const sep = (head.match(/;/g) || []).length > (head.match(/,/g) || []).length ? ';' : ',';
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (q) {
      if (ch === '"') { if (s[i + 1] === '"') { field += '"'; i++; } else q = false; } else field += ch;
    } else if (ch === '"') q = true;
    else if (ch === sep) { row.push(field); field = ''; }
    else if (ch === '\n' || ch === '\r') { if (ch === '\r' && s[i + 1] === '\n') i++; row.push(field); rows.push(row); row = []; field = ''; }
    else field += ch;
  }
  if (field || row.length) { row.push(field); rows.push(row); }
  return rows.filter((r) => r.some((c) => c.trim() !== ''));
}

/**
 * Applies a parsed table. Returns new params and configs (the inputs are not changed) and what was
 * skipped: rows for parameters that don't exist. Configurations are matched by name; new names are added.
 */
export function applyConfigTable(params, configs, rows, newId = () => `cf${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`) {
  if (!rows.length) throw new Error('The file is empty');
  const head = rows[0].map((h) => h.trim());
  if (!/^parameter$/i.test(head[0]) || !/^default$/i.test(head[1] || '')) throw new Error('The first row must be: Parameter, Default, then one column per configuration');
  const outParams = params.map((p) => ({ ...p }));
  const outConfigs = configs.map((c) => ({ ...c, values: { ...(c.values || {}) } }));
  const cols = head.slice(2).map((name) => {
    if (!name) return null;
    let c = outConfigs.find((x) => x.name.trim().toLowerCase() === name.toLowerCase());
    if (!c) { c = { id: newId(), name, values: {} }; outConfigs.push(c); }
    return c;
  });
  const unknown = [];
  let changed = 0;
  for (const r of rows.slice(1)) {
    const name = (r[0] || '').trim();
    if (!name) continue;
    const p = outParams.find((x) => x.name === name);
    if (!p) { unknown.push(name); continue; }
    const base = (r[1] ?? '').trim();
    if (base && base !== p.expr) { p.expr = base; changed++; }
    cols.forEach((c, k) => {
      if (!c) return;
      const v = (r[k + 2] ?? '').trim();
      if (v) { if (c.values[name] !== v) { c.values[name] = v; changed++; } } else if (name in c.values) { delete c.values[name]; changed++; }
    });
  }
  return { params: outParams, configs: outConfigs, unknown, changed, added: outConfigs.length - configs.length };
}
