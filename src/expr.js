// Tiny safe expression evaluator for parametric values, e.g. "width/2 + 3 mm".
// Supports + - * / ^ %, parentheses, numbers, named parameters, unit suffixes and math functions.

const UNITS = { mm: 1, cm: 10, m: 1000, in: 25.4, ft: 304.8, deg: 1 };
const FUNCS = {
  sin: (d) => Math.sin((d * Math.PI) / 180), cos: (d) => Math.cos((d * Math.PI) / 180),
  tan: (d) => Math.tan((d * Math.PI) / 180), sqrt: Math.sqrt, abs: Math.abs, min: Math.min,
  max: Math.max, round: Math.round, floor: Math.floor, ceil: Math.ceil, pow: Math.pow,
};
const CONSTS = { pi: Math.PI, PI: Math.PI, e: Math.E };

function tokenize(src) {
  const toks = [];
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    if (/\s/.test(c)) { i++; continue; }
    if (/[0-9.]/.test(c)) {
      let j = i;
      while (j < src.length && /[0-9.eE]/.test(src[j])) {
        if ((src[j] === 'e' || src[j] === 'E') && /[+-]/.test(src[j + 1])) j++;
        j++;
      }
      toks.push({ t: 'num', v: parseFloat(src.slice(i, j)) });
      i = j; continue;
    }
    if (/[A-Za-z_]/.test(c)) {
      let j = i;
      while (j < src.length && /[A-Za-z0-9_]/.test(src[j])) j++;
      toks.push({ t: 'id', v: src.slice(i, j) });
      i = j; continue;
    }
    if ('+-*/^%(),'.includes(c)) { toks.push({ t: 'op', v: c }); i++; continue; }
    throw new Error(`Unexpected "${c}"`);
  }
  return toks;
}

export function evaluate(src, vars = {}) {
  if (typeof src === 'number') return src;
  const toks = tokenize(String(src));
  let p = 0;
  const peek = () => toks[p];
  const eat = (v) => {
    const t = toks[p];
    if (!t || (v && t.v !== v)) throw new Error(`Expected "${v}"`);
    p++; return t;
  };
  function expr() {
    let v = term();
    while (peek() && (peek().v === '+' || peek().v === '-')) v = eat().v === '+' ? v + term() : v - term();
    return v;
  }
  function term() {
    let v = power();
    while (peek() && ['*', '/', '%'].includes(peek().v)) {
      const op = eat().v, r = power();
      v = op === '*' ? v * r : op === '/' ? v / r : v % r;
    }
    return v;
  }
  function power() {
    const b = unary();
    if (peek() && peek().v === '^') { eat(); return Math.pow(b, power()); }
    return b;
  }
  function unary() {
    if (peek() && peek().v === '-') { eat(); return -unary(); }
    if (peek() && peek().v === '+') { eat(); return unary(); }
    return postfix();
  }
  function postfix() {
    let v = atom();
    // unit suffix directly after a value: "10 mm", "2in"
    if (peek() && peek().t === 'id' && UNITS[peek().v] !== undefined) v *= UNITS[eat().v];
    return v;
  }
  function atom() {
    const t = peek();
    if (!t) throw new Error('Unexpected end');
    if (t.t === 'num') { p++; return t.v; }
    if (t.v === '(') { eat('('); const v = expr(); eat(')'); return v; }
    if (t.t === 'id') {
      p++;
      if (peek() && peek().v === '(' && FUNCS[t.v]) {
        eat('(');
        const args = [];
        if (peek() && peek().v !== ')') { args.push(expr()); while (peek() && peek().v === ',') { eat(','); args.push(expr()); } }
        eat(')');
        return FUNCS[t.v](...args);
      }
      if (Object.prototype.hasOwnProperty.call(vars, t.v)) return vars[t.v];
      if (CONSTS[t.v] !== undefined) return CONSTS[t.v];
      throw new Error(`Unknown parameter "${t.v}"`);
    }
    throw new Error(`Unexpected "${t.v}"`);
  }
  const v = expr();
  if (p < toks.length) throw new Error(`Unexpected "${toks[p].v}"`);
  if (!Number.isFinite(v)) throw new Error('Not a finite number');
  return v;
}

// Document unit systems. Internally everything is millimetres.
export const UNITS_TABLE = { mm: { label: 'mm', scale: 1 }, cm: { label: 'cm', scale: 10 }, m: { label: 'm', scale: 1000 }, in: { label: 'in', scale: 25.4 } };

// A "plain" expression has no identifiers (no parameters, no unit suffix): its number is read in the
// document unit. Expressions that reference parameters (stored in mm) or carry units are absolute.
const isPlain = (src) => typeof src === 'number' || !/[A-Za-z_]/.test(String(src).replace(/\de[+-]?\d/gi, ''));
export function evaluateLen(src, vars = {}, scale = 1) {
  const v = evaluate(src, vars);
  return isPlain(src) ? v * scale : v;
}

// Evaluates the user parameter table in order; later parameters may reference earlier ones.
// Parameters are lengths unless their unit is 'none' (counts, ratios) or 'deg'.
export function evalParams(params, scale = 1) {
  const vars = {}, errors = {};
  for (const prm of params) {
    try { vars[prm.name] = prm.unit === 'none' || prm.unit === 'deg' ? evaluate(prm.expr, vars) : evaluateLen(prm.expr, vars, scale); } catch (e) { errors[prm.name] = e.message; }
  }
  return { vars, errors };
}

export const isValidName = (n) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(n) && !UNITS[n] && !FUNCS[n] && !CONSTS[n];
