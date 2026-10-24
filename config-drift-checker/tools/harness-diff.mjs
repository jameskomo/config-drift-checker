#!/usr/bin/env node
// harness-diff: what changed inside Claude Code between two releases, in the text the model reads?
//
//   node tools/harness-diff.mjs [--from <v>] [--to <v>] [--json | --md | --html] [--out <file>]
//        [--from-file <a.d.ts> --to-file <b.d.ts>] [--cache-dir <dir>]
//
// Every @anthropic-ai/claude-code release ships sdk-tools.d.ts: the input schema of each built-in tool,
// generated from the JSON Schema the model is given, with every parameter's description as JSDoc. That
// text steers the agent: when to pass a parameter, when to leave it out, what it does. This tool fetches
// the file from both releases with `npm pack` (a download only: nothing is installed or executed; cached
// by version), parses it into tool, field and description, and diffs it by meaning, not by line:
//   instruction wording  a description the model reads changed (shown word by word, before and after)
//   capability           a tool or input parameter appeared or went away, or an input gained or lost a value
//   type-only            the rest: result (output) types, which the model is not shown, and constraints
// Defaults: --to is npm latest, --from the stable release before it. Free: no credentials, no model.
//
// Not compared: the system prompt and each tool's main description. They live in the native binary of the
// platform packages, where the text is assembled at run time behind feature gates, so a string scan of
// the binary cannot tell what a given session actually reads.
import { existsSync, readFileSync, writeFileSync, mkdirSync, mkdtempSync, rmSync, readdirSync, realpathSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { gunzipSync } from 'node:zlib';
import { spawnSync, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { CSS, esc } from './report-style.mjs';

const PACKAGE = '@anthropic-ai/claude-code';
const REPO_URL = 'https://github.com/jameskomo/config-drift-checker';
const SEMVER = /^\d+\.\d+\.\d+$/;
export const CLASSES = ['instruction', 'capability', 'type-only'];
export const CLASS_LABEL = { instruction: 'instruction wording', capability: 'capability', 'type-only': 'type-only' };
// interface names whose tool goes by another name in a session
const TOOL_NAMES = { FileRead: 'Read', FileEdit: 'Edit', FileWrite: 'Write' };

export const cmpV = (a, b) => {
  const pa = String(a).split('.').map(Number), pb = String(b).split('.').map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) { const d = (pa[i] ?? 0) - (pb[i] ?? 0); if (d) return d; }
  return 0;
};

// ---------- parsing sdk-tools.d.ts (the subset json-schema-to-typescript writes) ----------
function cleanDoc(body) {
  const lines = body.split('\n').map((l) => l.replace(/^\s*\* ?/, '').replace(/\s+$/, ''));
  const tags = lines.filter((l) => l.startsWith('@')).map((l) => l.slice(1).trim());
  const text = lines.filter((l) => !l.startsWith('@')).join('\n').replace(/\n{3,}/g, '\n\n').trim();
  return { text, tags };
}

function tokenize(src) {
  const toks = [];
  const WORD = /[A-Za-z_$][\w$]*|-?\d+(?:\.\d+)?/y;
  for (let i = 0; i < src.length;) {
    const c = src[i];
    if (/\s/.test(c)) { i++; continue; }
    if (src.startsWith('/**', i) && !src.startsWith('/**/', i)) {
      const e = src.indexOf('*/', i + 3), end = e < 0 ? src.length : e;
      toks.push({ t: 'doc', v: cleanDoc(src.slice(i + 3, end)) }); i = end + 2; continue;
    }
    if (src.startsWith('/*', i)) { const e = src.indexOf('*/', i + 2); i = e < 0 ? src.length : e + 2; continue; }
    if (src.startsWith('//', i)) { const e = src.indexOf('\n', i); i = e < 0 ? src.length : e + 1; continue; }
    if (c === '"' || c === "'") {
      let j = i + 1;
      while (j < src.length && src[j] !== c) j += src[j] === '\\' ? 2 : 1;
      const raw = src.slice(i, j + 1);
      toks.push({ t: 'str', v: c === '"' ? raw : JSON.stringify(raw.slice(1, -1).replace(/\\'/g, "'")) }); i = j + 1; continue;
    }
    if (src.startsWith('...', i)) { toks.push({ t: 'p', v: '...' }); i += 3; continue; }
    WORD.lastIndex = i;
    const m = WORD.exec(src);
    if (m) { toks.push({ t: /^[-\d]/.test(m[0]) ? 'num' : 'id', v: m[0] }); i += m[0].length; continue; }
    toks.push({ t: 'p', v: c }); i++;
  }
  return toks;
}

// Type nodes: object {members} | array {of} | tuple {items} | union {parts} | inter {parts} | lit {v} | ref {name, args}
function parseDeclarations(src) {
  const toks = tokenize(src);
  let p = 0;
  const peek = (k = 0) => toks[p + k];
  const is = (v, k = 0) => toks[p + k] !== undefined && toks[p + k].t !== 'str' && toks[p + k].t !== 'doc' && toks[p + k].v === v;
  const next = () => toks[p++];
  const fail = (what) => { throw new Error(`sdk-tools.d.ts: expected ${what} at token ${p} (got ${JSON.stringify(peek()?.v ?? 'end of file').slice(0, 40)})`); };
  const expect = (v) => (is(v) ? next() : fail(`"${v}"`));
  const skipDocs = () => { let d = null; while (peek()?.t === 'doc') d = next().v; return d; };

  function objectBody() {
    expect('{');
    const members = [];
    for (;;) {
      const doc = skipDocs();
      if (is('}')) { next(); return members; }
      if (!peek()) fail('"}"');
      if (is('readonly') && !is(':', 1) && !is('?', 1)) next();
      let key;
      if (is('[')) { next(); const pn = next().v; expect(':'); const kt = typeExpr(); expect(']'); key = `[${pn}: ${typeText(kt)}]`; }
      else { const t = next(); key = t.t === 'str' ? JSON.parse(t.v) : t.v; }
      let optional = false;
      if (is('?')) { next(); optional = true; }
      expect(':');
      const type = typeExpr();
      if (is(';') || is(',')) next();
      members.push({ key, optional, doc, type });
    }
  }
  function typeExpr() {
    skipDocs();
    if (is('|')) next();
    const parts = [intersection()];
    while (is('|')) { next(); parts.push(intersection()); }
    return parts.length === 1 ? parts[0] : { k: 'union', parts };
  }
  function intersection() {
    if (is('&')) next();
    const parts = [postfix()];
    while (is('&')) { next(); parts.push(postfix()); }
    return parts.length === 1 ? parts[0] : { k: 'inter', parts };
  }
  function postfix() {
    let t = primary();
    while (is('[') && is(']', 1)) { next(); next(); t = { k: 'array', of: t }; }
    return t;
  }
  function primary() {
    skipDocs();
    const t = peek();
    if (!t) fail('a type');
    if (is('{')) return { k: 'object', members: objectBody() };
    if (is('(')) { next(); const inner = typeExpr(); expect(')'); return inner; }
    if (is('[')) {
      next();
      const items = [];
      for (;;) {
        skipDocs();
        if (is(']')) { next(); return { k: 'tuple', items }; }
        let rest = false;
        if (is('...')) { next(); rest = true; }
        if (peek()?.t === 'id' && (is(':', 1) || (is('?', 1) && is(':', 2)))) { next(); if (is('?')) next(); next(); } // a named tuple member
        const it = typeExpr();
        items.push(rest && it.k === 'array' ? it.of : it);
        if (is(',')) next();
      }
    }
    if (t.t === 'str' || t.t === 'num') { next(); return { k: 'lit', v: t.v }; }
    if (t.t === 'id') {
      next();
      if ((t.v === 'keyof' || t.v === 'typeof' || t.v === 'readonly' || t.v === 'unique') && peek()?.t === 'id') return { k: 'ref', name: `${t.v} ${typeText(primary())}` };
      let name = t.v;
      while (is('.')) { next(); name += `.${next().v}`; }
      let args = null;
      if (is('<')) { next(); args = [typeExpr()]; while (is(',')) { next(); args.push(typeExpr()); } expect('>'); }
      return { k: 'ref', name, args };
    }
    return fail('a type');
  }

  const decls = [];
  while (p < toks.length) {
    const doc = skipDocs();
    if (p >= toks.length) break;
    if (is(';')) { next(); continue; }
    if (is('export')) next();
    if (is('declare')) next();
    if (is('interface')) {
      next();
      const name = next().v;
      while (!is('{')) { if (!peek()) fail('"{"'); next(); } // generics and extends clauses
      decls.push({ name, kind: 'interface', doc, type: { k: 'object', members: objectBody() } });
    } else if (is('type')) {
      next();
      const name = next().v;
      if (is('<')) { let depth = 0; do { if (is('<')) depth++; else if (is('>')) depth--; next(); } while (depth > 0 && peek()); }
      expect('=');
      const type = typeExpr();
      if (is(';')) next();
      decls.push({ name, kind: 'type', doc, type });
    } else fail('an interface or type declaration');
  }
  return decls;
}

// a short, stable rendering of a type: nested objects collapse to `object`, tuples to arrays
const wrap = (n) => (n.k === 'union' || n.k === 'inter' ? `(${typeText(n)})` : typeText(n));
const uniq = (xs) => [...new Set(xs)];
export function typeText(n) {
  switch (n.k) {
    case 'lit': return n.v;
    case 'ref': return n.args ? `${n.name}<${n.args.map(typeText).join(', ')}>` : n.name;
    case 'object': return 'object';
    case 'array': return `${wrap(n.of)}[]`;
    case 'tuple': { const el = uniq(n.items.map(typeText)); return el.length === 0 ? '[]' : el.length === 1 ? `${wrap(n.items[0])}[]` : `(${el.join(' | ')})[]`; }
    case 'union': return uniq(n.parts.map(typeText)).join(' | ');
    case 'inter': return n.parts.map(wrap).join(' & ');
    default: return '?';
  }
}
// the full shape (no docs), to tell identical union variants apart from different ones
function shapeKey(n) {
  switch (n.k) {
    case 'object': return `{${n.members.map((m) => `${m.key}${m.optional ? '?' : ''}:${shapeKey(m.type)}`).join(';')}}`;
    case 'array': return `${shapeKey(n.of)}[]`;
    case 'tuple': return `[${n.items.map(shapeKey).join(',')}]`;
    case 'union': return `(${n.parts.map(shapeKey).join('|')})`;
    case 'inter': return `(${n.parts.map(shapeKey).join('&')})`;
    default: return typeText(n);
  }
}
const litValues = (t) => (t.k === 'lit' && t.v.startsWith('"') ? [JSON.parse(t.v)] : t.k === 'union' && t.parts.every((x) => x.k === 'lit' && x.v.startsWith('"')) ? t.parts.map((x) => JSON.parse(x.v)) : null);

// A name for each object variant of a union, stable across releases: a literal tag only it has
// (status=completed), else the first key only it has (required keys first), else its position.
export function variantLabels(objs) {
  const labels = objs.map((o, i) => {
    const others = objs.filter((_, j) => j !== i);
    for (const m of o.members) {
      const vals = litValues(m.type);
      if (!vals) continue;
      const clash = others.some((x) => { const mm = x.members.find((y) => y.key === m.key); const ov = mm ? litValues(mm.type) : null; return ov && ov.some((v) => vals.includes(v)); });
      if (!clash) return `${m.key}=${vals.join('|')}`;
    }
    const only = (m) => others.every((x) => !x.members.some((y) => y.key === m.key));
    const u = o.members.find((m) => !m.optional && only(m)) ?? o.members.find(only);
    return u ? u.key : `#${i + 1}`;
  });
  return labels.map((l, i) => (labels.indexOf(l) === i ? l : `${l}#${i + 1}`));
}

function flatten(root) {
  const fields = new Map();
  const put = (key, rec) => {
    const old = fields.get(key);
    if (!old) { fields.set(key, rec); return; }
    if (old.type !== rec.type) old.type = uniq([...old.type.split(' | '), ...rec.type.split(' | ')]).join(' | ');
    if (!old.description && rec.description) old.description = rec.description;
    old.optional = old.optional && rec.optional;
  };
  const walk = (n, prefix) => {
    if (n.k === 'object') {
      for (const m of n.members) {
        const key = prefix ? `${prefix}.${m.key}` : m.key;
        put(key, { type: typeText(m.type), optional: m.optional, description: m.doc?.text ?? '', tags: m.doc?.tags ?? [] });
        walk(m.type, key);
      }
    } else if (n.k === 'array') walk(n.of, `${prefix}[]`);
    else if (n.k === 'tuple') for (const it of n.items) walk(it, `${prefix}[]`);
    else if (n.k === 'inter') for (const part of n.parts) walk(part, prefix);
    else if (n.k === 'union') {
      for (const part of n.parts) if (part.k !== 'object') walk(part, prefix);
      const seen = new Set();
      const objs = n.parts.filter((x) => x.k === 'object' && !seen.has(shapeKey(x)) && seen.add(shapeKey(x)));
      if (objs.length === 1) walk(objs[0], prefix);
      else { const labels = variantLabels(objs); objs.forEach((o, i) => walk(o, `${prefix}{${labels[i]}}`)); }
    }
  };
  walk(root, '');
  return Object.fromEntries(fields);
}

export function toolOf(declName) {
  const m = declName.match(/^(.+?)(Input|Output)$/);
  if (!m) return { tool: null, side: 'other' };
  return { tool: TOOL_NAMES[m[1]] ?? m[1], side: m[2].toLowerCase() };
}

// sdk-tools.d.ts → { tools: [names], declarations: { Name: { tool, side, description, fields: { path: { type, optional, description, tags } } } } }
export function parseSdkTools(src) {
  const declarations = {};
  for (const d of parseDeclarations(src)) {
    const { tool, side } = toolOf(d.name);
    declarations[d.name] = { tool, side, description: d.doc?.text ?? '', fields: flatten(d.type) };
  }
  const tools = uniq(Object.values(declarations).filter((d) => d.side === 'input').map((d) => d.tool)).sort();
  if (!tools.length) throw new Error('sdk-tools.d.ts: no tool input schemas found');
  return { tools, declarations };
}

// ---------- word-level diff ----------
const words = (s) => String(s).match(/\s+|[\p{L}\p{N}_'’]+|[^\s\p{L}\p{N}_]/gu) ?? [];
// [[op, text]] with op '=' (both), '-' (only before), '+' (only after); each run of changes is one '-' then one '+'
export function wordDiff(a, b) {
  const A = words(a), B = words(b);
  let s = 0;
  while (s < A.length && s < B.length && A[s] === B[s]) s++;
  let e = 0;
  while (e < A.length - s && e < B.length - s && A[A.length - 1 - e] === B[B.length - 1 - e]) e++;
  const a2 = A.slice(s, A.length - e), b2 = B.slice(s, B.length - e);
  const raw = [['=', A.slice(0, s).join('')]];
  if (a2.length * b2.length > 4_000_000) raw.push(['-', a2.join('')], ['+', b2.join('')]);
  else {
    const n = a2.length, m = b2.length, w = m + 1;
    const L = new Uint32Array((n + 1) * w);
    for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) L[i * w + j] = a2[i] === b2[j] ? L[(i + 1) * w + j + 1] + 1 : Math.max(L[(i + 1) * w + j], L[i * w + j + 1]);
    let i = 0, j = 0;
    while (i < n && j < m) {
      if (a2[i] === b2[j]) { raw.push(['=', a2[i]]); i++; j++; }
      else if (L[(i + 1) * w + j] >= L[i * w + j + 1]) raw.push(['-', a2[i++]]);
      else raw.push(['+', b2[j++]]);
    }
    while (i < n) raw.push(['-', a2[i++]]);
    while (j < m) raw.push(['+', b2[j++]]);
  }
  raw.push(['=', A.slice(A.length - e).join('')]);
  // a lone space between two changes belongs to the change, so a rewritten phrase reads as one block
  const ops = [];
  let del = '', ins = '';
  const flush = () => { if (del) ops.push(['-', del]); if (ins) ops.push(['+', ins]); del = ins = ''; };
  raw.forEach(([op, t], k) => {
    if (!t) return;
    if (op === '=' && /^\s+$/.test(t) && (del || ins) && raw.slice(k + 1).find(([, x]) => x)?.[0] !== '=' && k < raw.length - 1) { del += t; ins += t; return; }
    if (op === '-') del += t; else if (op === '+') ins += t;
    else { flush(); if (ops.at(-1)?.[0] === '=') ops.at(-1)[1] += t; else ops.push(['=', t]); }
  });
  flush();
  return ops;
}
const sameText = (a, b) => String(a ?? '').replace(/\s+/g, ' ').trim() === String(b ?? '').replace(/\s+/g, ' ').trim();

// ---------- the semantic diff ----------
const isUnder = (p, parent) => p.length > parent.length && p.startsWith(parent) && ['.', '[', '{'].includes(p[parent.length]);
const litSet = (type) => (/^"[^"]*"( \| "[^"]*")*$/.test(type) ? type.split(' | ').map((x) => JSON.parse(x)) : null);

export function diffSdkTools(a, b, { from = null, to = null } = {}) {
  const changes = [];
  const add = (c) => changes.push({ ...c, display: c.field ? `${c.tool ?? c.decl}.${c.field}` : (c.tool ?? c.decl) });
  const names = uniq([...Object.keys(a.declarations), ...Object.keys(b.declarations)]);
  const inputDecl = (m, t) => Object.keys(m.declarations).find((n) => m.declarations[n].tool === t && m.declarations[n].side === 'input');
  const params = (d) => Object.keys(d.fields).filter((k) => !/[.[{]/.test(k)).join(', ');
  for (const t of b.tools.filter((x) => !a.tools.includes(x))) { const decl = inputDecl(b, t); add({ class: 'capability', kind: 'tool-added', tool: t, decl, side: 'input', after: params(b.declarations[decl]) }); }
  for (const t of a.tools.filter((x) => !b.tools.includes(x))) add({ class: 'capability', kind: 'tool-removed', tool: t, decl: inputDecl(a, t), side: 'input' });
  for (const name of names) {
    const da = a.declarations[name], db = b.declarations[name];
    const { tool, side } = (db ?? da);
    const model = side === 'input';
    const base = { tool, decl: name, side };
    if (!da || !db) {
      if (side === 'input') continue; // a whole tool appearing or going away is reported once, above
      add({ ...base, class: 'type-only', kind: db ? 'type-added' : 'type-removed' });
      continue;
    }
    if (!sameText(da.description, db.description)) add({ ...base, class: model ? 'instruction' : 'type-only', kind: 'description-changed', field: null, before: da.description, after: db.description });
    const fa = da.fields, fb = db.fields;
    const added = Object.keys(fb).filter((k) => !(k in fa)), removed = Object.keys(fa).filter((k) => !(k in fb));
    const top = (list) => list.filter((k) => !list.some((q) => isUnder(k, q)));
    for (const k of top(added)) add({ ...base, class: model ? 'capability' : 'type-only', kind: 'field-added', field: k, type: fb[k].type, optional: fb[k].optional, after: fb[k].description, nested: added.filter((q) => isUnder(q, k)).length });
    for (const k of top(removed)) add({ ...base, class: model ? 'capability' : 'type-only', kind: 'field-removed', field: k, type: fa[k].type, optional: fa[k].optional, before: fa[k].description, nested: removed.filter((q) => isUnder(q, k)).length });
    for (const k of Object.keys(fb).filter((x) => x in fa)) {
      const x = fa[k], y = fb[k];
      if (!sameText(x.description, y.description)) add({ ...base, class: model ? 'instruction' : 'type-only', kind: 'description-changed', field: k, before: x.description, after: y.description });
      if (x.type !== y.type) {
        const sa = litSet(x.type), sb = litSet(y.type);
        if (model && sa && sb) {
          const gained = sb.filter((v) => !sa.includes(v)), lost = sa.filter((v) => !sb.includes(v));
          if (gained.length) add({ ...base, class: 'capability', kind: 'values-added', field: k, values: gained, before: x.type, after: y.type });
          if (lost.length) add({ ...base, class: 'capability', kind: 'values-removed', field: k, values: lost, before: x.type, after: y.type });
          if (!gained.length && !lost.length) add({ ...base, class: 'type-only', kind: 'type-changed', field: k, before: x.type, after: y.type });
        } else add({ ...base, class: 'type-only', kind: 'type-changed', field: k, before: x.type, after: y.type });
      }
      if (x.optional !== y.optional) add({ ...base, class: 'type-only', kind: y.optional ? 'now-optional' : 'now-required', field: k });
      if (x.tags.join('\n') !== y.tags.join('\n')) add({ ...base, class: 'type-only', kind: 'constraints-changed', field: k, before: x.tags.join(', '), after: y.tags.join(', ') });
    }
  }
  const order = (c) => [CLASSES.indexOf(c.class), c.side === 'input' ? 0 : 1, c.tool ?? c.decl, c.field ?? ''];
  changes.sort((p, q) => { const x = order(p), y = order(q); for (let i = 0; i < x.length; i++) if (x[i] !== y[i]) return x[i] < y[i] ? -1 : 1; return 0; });
  const diff = { schemaVersion: 1, source: 'sdk-tools.d.ts', from, to, tools: { from: a.tools.length, to: b.tools.length }, changes };
  diff.summary = summarize(diff);
  return diff;
}

const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const listNames = (xs, max = 5) => (xs.length <= max ? xs.join(', ') : `${xs.slice(0, max).join(', ')} and ${xs.length - max} more`);
const andJoin = (parts) => (parts.length <= 1 ? parts.join('') : `${parts.slice(0, -1).join(', ')} and ${parts.at(-1)}`);
// model-visible text touched: a description edit, or a parameter (with its text) appearing or going away
const touchesText = (c) => c.side === 'input' && (c.kind === 'description-changed' || ((c.kind === 'field-added' || c.kind === 'field-removed') && (c.after || c.before)));

// One line per change, for the release report and the plain list
export function changeLine(c) {
  const f = c.field ? `\`${c.field}\`` : null;
  switch (c.kind) {
    case 'tool-added': return `new tool ${c.tool}`;
    case 'tool-removed': return `tool ${c.tool} removed`;
    case 'description-changed': return c.side === 'input' ? `${c.tool}: new wording for ${f ?? 'the tool'}` : `${c.tool ?? c.decl} result: new wording for ${f ?? 'the type'}`;
    case 'field-added': return c.side === 'input' ? `${c.tool}: new parameter ${f}` : `${c.tool ?? c.decl} result: new field ${f}`;
    case 'field-removed': return c.side === 'input' ? `${c.tool}: parameter ${f} removed` : `${c.tool ?? c.decl} result: field ${f} removed`;
    case 'values-added': return `${c.tool}: ${f} now accepts ${c.values.map((v) => `"${v}"`).join(', ')}`;
    case 'values-removed': return `${c.tool}: ${f} no longer accepts ${c.values.map((v) => `"${v}"`).join(', ')}`;
    case 'type-changed': return `${c.tool ?? c.decl}${c.side === 'output' ? ' result' : ''}: ${f} is now ${c.after} (was ${c.before})`;
    case 'now-optional': return `${c.tool ?? c.decl}${c.side === 'output' ? ' result' : ''}: ${f} is now optional`;
    case 'now-required': return `${c.tool ?? c.decl}${c.side === 'output' ? ' result' : ''}: ${f} is now required`;
    case 'constraints-changed': return `${c.tool ?? c.decl}${c.side === 'output' ? ' result' : ''}: constraints on ${f} changed`;
    case 'type-added': return `new type ${c.decl}`;
    case 'type-removed': return `type ${c.decl} removed`;
    default: return c.display;
  }
}

// "Claude Code 2.1.310" for a version, the file name for a local file, a fallback otherwise
const named = (v, fallback) => (!v ? fallback : SEMVER.test(v) ? `Claude Code ${v}` : v);

export function summarize(diff) {
  const cs = diff.changes;
  const count = (cls) => cs.filter((c) => c.class === cls).length;
  const capAdded = cs.filter((c) => c.class === 'capability' && /-added$/.test(c.kind)).length;
  const capRemoved = cs.filter((c) => c.class === 'capability' && /-removed$/.test(c.kind)).length;
  const newTools = cs.filter((c) => c.kind === 'tool-added').map((c) => c.tool);
  const instructionTools = uniq(cs.filter(touchesText).map((c) => c.tool)).filter((t) => !newTools.includes(t)).sort();
  const typeOnly = count('type-only');
  const parts = [];
  if (instructionTools.length) parts.push(`changed the instructions of ${plural(instructionTools.length, 'built-in tool')} (${listNames(instructionTools)})`);
  if (capAdded) parts.push(`added ${plural(capAdded, 'capability', 'capabilities')}`);
  if (capRemoved) parts.push(`removed ${plural(capRemoved, 'capability', 'capabilities')}`);
  const to = named(diff.to, 'The newer release');
  const headline = parts.length ? `${to} ${andJoin(parts)}.`
    : typeOnly ? `${to} kept every built-in tool's instructions and capabilities; ${plural(typeOnly, 'change')} touch${typeOnly === 1 ? 'es' : ''} types only.`
      : `${to} made no changes to the built-in tool definitions.`;
  return {
    from: diff.from, to: diff.to, headline,
    counts: { instruction: count('instruction'), capability: count('capability'), typeOnly },
    instructionTools, capabilitiesAdded: capAdded, capabilitiesRemoved: capRemoved,
    toolsAdded: newTools, toolsRemoved: cs.filter((c) => c.kind === 'tool-removed').map((c) => c.tool),
    items: cs.filter((c) => c.class !== 'type-only').map((c) => ({ class: c.class, text: changeLine(c) })),
  };
}

// ---------- fetching (npm pack: a download, never an install; cached by version) ----------
// The one file a tarball entry names, read without extracting anything to disk.
export function tarEntry(tgz, wanted, maxBytes = 16 * 2 ** 20) {
  const tar = gunzipSync(tgz, { maxOutputLength: 256 * 2 ** 20 });
  let longName = null;
  for (let off = 0; off + 512 <= tar.length;) {
    const h = tar.subarray(off, off + 512);
    if (h.every((x) => x === 0)) break;
    const field = (s, e) => h.subarray(s, e).toString('utf8').replace(/\0[\s\S]*$/, '');
    const prefix = field(345, 500);
    let name = (h.subarray(257, 262).toString() === 'ustar' && prefix ? `${prefix}/` : '') + field(0, 100);
    const size = parseInt(field(124, 136).trim() || '0', 8);
    const type = String.fromCharCode(h[156]);
    const body = tar.subarray(off + 512, off + 512 + size);
    if (longName) { name = longName; longName = null; }
    if (type === 'L') longName = body.toString('utf8').replace(/\0[\s\S]*$/, '');
    else if ((type === '0' || type === '\0') && name === wanted) {
      if (size > maxBytes) throw new Error(`${wanted} is ${size} bytes, over the ${maxBytes} byte cap`);
      return Buffer.from(body);
    }
    off += 512 + Math.ceil(size / 512) * 512;
  }
  return null;
}

export const defaultCacheDir = () => process.env.CDC_HARNESS_CACHE || path.join(os.tmpdir(), 'cdc-harness-cache');

// sdk-tools.d.ts of one release, from the cache or a fresh `npm pack`
export function fetchSdkTools(version, { cacheDir = defaultCacheDir(), timeoutMs = 180_000 } = {}) {
  if (!SEMVER.test(String(version))) throw new Error(`'${version}' is not a version`);
  const cached = path.join(cacheDir, version, 'sdk-tools.d.ts');
  if (existsSync(cached)) return readFileSync(cached, 'utf8');
  mkdirSync(cacheDir, { recursive: true });
  const dir = mkdtempSync(path.join(cacheDir, `.pack-${version}-`));
  try {
    const r = spawnSync('npm', ['pack', `${PACKAGE}@${version}`, '--pack-destination', dir, '--json', '--ignore-scripts', '--loglevel', 'error'], { encoding: 'utf8', timeout: timeoutMs, cwd: dir });
    if (r.status !== 0) throw new Error(`npm pack ${PACKAGE}@${version} failed: ${(r.stderr || r.error?.message || '').trim().split('\n').filter(Boolean).pop() ?? `exit ${r.status}`}`);
    const tgz = readdirSync(dir).find((f) => f.endsWith('.tgz'));
    if (!tgz) throw new Error(`npm pack ${PACKAGE}@${version} wrote no tarball`);
    const body = tarEntry(readFileSync(path.join(dir, tgz)), 'package/sdk-tools.d.ts');
    if (!body) throw new Error(`${PACKAGE}@${version} has no sdk-tools.d.ts`);
    mkdirSync(path.dirname(cached), { recursive: true });
    writeFileSync(cached, body);
    return body.toString('utf8');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

export function harnessDiff({ from, to, fromText = null, toText = null, cacheDir } = {}) {
  const a = parseSdkTools(fromText ?? fetchSdkTools(from, { cacheDir }));
  const b = parseSdkTools(toText ?? fetchSdkTools(to, { cacheDir }));
  return diffSdkTools(a, b, { from, to });
}

// ---------- rendering ----------
// long unchanged stretches shrink to their ends, so a one-word edit in a long description stays readable
function condense(text, where, keep = 90) {
  if (text.length <= keep * 2 + 40) return text;
  const head = text.slice(0, keep).replace(/\S*$/, ''), tail = text.slice(-keep).replace(/^\S*/, '');
  return where === 'first' ? `...${tail}` : where === 'last' ? `${head}...` : `${head} ... ${tail}`;
}
// the before and after texts of a word diff: changed runs wrapped in <del> / <ins>, text escaped by `escape`
function sides(ops, escape) {
  const render = (dropOp, tag) => ops.filter(([op]) => op !== dropOp).map(([op, t], i, arr) => {
    if (op !== '=') return `<${tag}>${escape(t)}</${tag}>`;
    return escape(condense(t, i === 0 ? 'first' : i === arr.length - 1 ? 'last' : 'mid'));
  }).join('');
  return { before: render('+', 'del'), after: render('-', 'ins') };
}
const fieldName = (c) => (c.field ? c.field : 'tool description');
const typeNote = (c) => [c.type, c.optional === false ? 'required' : c.optional ? 'optional' : null].filter(Boolean).join(', ');

export function renderMarkdown(diff) {
  const s = diff.summary ?? summarize(diff);
  const md = (t) => String(t ?? '').replace(/[<>]/g, (ch) => (ch === '<' ? '&lt;' : '&gt;'));
  const by = (cls) => diff.changes.filter((c) => c.class === cls);
  const out = [`# What changed inside ${named(diff.to, 'Claude Code')}`, '', `**${s.headline}**`, '',
    `Built-in tool definitions (sdk-tools.d.ts) of ${named(diff.from, 'the older release')} and ${named(diff.to, 'the newer release')}: ${plural(s.counts.instruction, 'instruction wording change')}, ${plural(s.counts.capability, 'capability change')}, ${plural(s.counts.typeOnly, 'type-only change')}.`];
  const instr = by('instruction');
  if (instr.length) {
    out.push('', '## Instruction wording');
    for (const c of instr) {
      const { before, after } = sides(wordDiff(c.before, c.after), md);
      out.push('', `### ${c.tool}: \`${fieldName(c)}\``, '', `Before: ${before.replace(/\n+/g, ' ')}`, '', `After: ${after.replace(/\n+/g, ' ')}`);
    }
  }
  const caps = by('capability');
  if (caps.length) {
    out.push('', '## Capabilities', '');
    for (const c of caps) out.push(`- ${md(changeLine(c))}${c.type ? ` (${typeNote(c)})` : ''}${c.after && c.kind !== 'values-added' && c.kind !== 'values-removed' ? `: ${md(c.after).replace(/\n+/g, ' ')}` : ''}${c.before && c.kind === 'field-removed' ? `. It said: ${md(c.before).replace(/\n+/g, ' ')}` : ''}`);
  }
  const types = by('type-only');
  if (types.length) {
    out.push('', '## Type-only', '', 'Result types (which the model is not shown) and constraints.', '');
    for (const c of types) out.push(`- ${md(changeLine(c))}${c.type ? ` (${c.type})` : ''}`);
  }
  if (!diff.changes.length) out.push('', 'No tool, parameter, description or type changed.');
  return out.join('\n') + '\n';
}

export function renderDiffHtml(diff, { backLink = null, generatedAt = null } = {}) {
  const s = diff.summary ?? summarize(diff);
  const by = (cls) => diff.changes.filter((c) => c.class === cls);
  const tile = (label, n, cls = '') => `<div class="tile"><div class="tl">${label}</div><div class="tb ${cls}">${n}</div></div>`;
  const block = (label, html) => `<div><span class="bl">${label}</span>${html}</div>`;
  const plain = (t) => esc(t);
  const instr = by('instruction');
  const instrTools = uniq(instr.map((c) => c.tool));
  const instrHtml = instrTools.map((t) => `<section class="card"><div class="ch"><div><h3>${esc(t)}</h3></div><div class="sum"><span class="warn">${plural(instr.filter((c) => c.tool === t).length, 'wording change')}</span></div></div>${instr.filter((c) => c.tool === t).map((c) => {
    const { before, after } = sides(wordDiff(c.before, c.after), esc);
    return `<div class="chg"><div class="fl mono">${esc(fieldName(c))}</div><div class="ba">${block(`before${diff.from ? `, ${esc(diff.from)}` : ''}`, before)}${block(`after${diff.to ? `, ${esc(diff.to)}` : ''}`, after)}</div></div>`;
  }).join('')}</section>`).join('\n');
  const caps = by('capability');
  const capHtml = caps.length ? `<section class="card"><ul class="chl">${caps.map((c) => `<li><span class="pill ${/-added$/.test(c.kind) ? 'pass' : 'fail'}">${/-added$/.test(c.kind) ? 'added' : 'removed'}</span>${esc(changeLine(c).replace(/`/g, ''))}${c.type ? ` <span class="muted mono">${esc(typeNote(c))}</span>` : ''}${c.after && c.kind === 'field-added' ? `<div class="fix">${plain(c.after)}</div>` : ''}${c.before && c.kind === 'field-removed' ? `<div class="fix">It said: ${plain(c.before)}</div>` : ''}${c.kind === 'tool-added' && c.after ? `<div class="fix">Parameters: <span class="mono">${esc(c.after)}</span></div>` : ''}</li>`).join('')}</ul></section>` : '';
  const types = by('type-only');
  const typeHtml = types.length ? `<section class="card"><details><summary>${plural(types.length, 'change')} to result types and constraints</summary><ul class="chl">${types.map((c) => `<li>${esc(changeLine(c).replace(/`/g, ''))}${c.type ? ` <span class="muted mono">${esc(c.type)}</span>` : ''}</li>`).join('')}</ul></details></section>` : '';
  const when = generatedAt ? ` Generated ${esc(new Date(generatedAt).toISOString().slice(0, 16).replace('T', ' '))} UTC.` : '';
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Claude Code Harness Diff</title><meta name="description" content="${esc(s.headline)}"><style>${CSS}</style></head><body><main class="wrap">
<p class="eyebrow">config-drift-checker · <b>What changed inside Claude Code</b>${backLink ? ` · <a href="${esc(backLink)}">release report</a>` : ''}</p>
<h1>${esc(s.headline)}</h1>
<p class="lede">The built-in tool definitions of ${esc(named(diff.to, 'the newer release'))}, compared with ${esc(named(diff.from, 'the older release'))}: each tool's input schema and the description of every parameter, the text the model reads when it decides how to call a tool.${when}</p>
<div class="tiles">${tile('tools', diff.tools?.to ?? '')}${tile('tools with new instructions', s.instructionTools.length, s.instructionTools.length ? 'warn' : '')}${tile('capabilities added', s.capabilitiesAdded, s.capabilitiesAdded ? 'pass' : '')}${tile('capabilities removed', s.capabilitiesRemoved, s.capabilitiesRemoved ? 'fail' : '')}${tile('type-only', s.counts.typeOnly)}</div>
${instr.length ? `<h2>Instruction wording</h2>\n${instrHtml}` : ''}
${caps.length ? `<h2>Capabilities</h2>\n${capHtml}` : ''}
${types.length ? `<h2>Type-only</h2>\n${typeHtml}` : ''}
${diff.changes.length ? '' : '<div class="note">No tool, parameter, description or type changed between these two releases.</div>'}
<p class="foot">How this is computed: both releases' <code>sdk-tools.d.ts</code> come from <code>npm pack ${PACKAGE}@&lt;version&gt;</code>, a download with nothing installed or run. The file holds every built-in tool's input schema with each parameter's description, generated from the schema the model is given. A changed description is instruction wording; a tool, parameter or accepted value that appears or goes away is a capability; result types, which the model is not shown, and constraints are type-only. Not compared: the system prompt and each tool's main description, which live in the native binary and are assembled at run time. ${diff.to ? `Data: <a href="${esc(diff.to)}.json">${esc(diff.to)}.json</a>. ` : ''}Generated by <a href="${REPO_URL}">config-drift-checker</a>.</p>
</main></body></html>
`;
}

// ---------- CLI ----------
const isMain = (() => { try { return process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url); } catch { return false; } })();
if (isMain) {
  const argv = process.argv.slice(2);
  const usage = 'usage: harness-diff.mjs [--from <v>] [--to <v>] [--json | --md | --html] [--out <file>] [--from-file a.d.ts --to-file b.d.ts] [--cache-dir dir]';
  const opt = { from: null, to: null, format: 'md', out: null, fromFile: null, toFile: null, cacheDir: undefined };
  const need = (i) => { if (argv[i + 1] === undefined) { console.error(usage); process.exit(2); } return argv[i + 1]; };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--from') opt.from = need(i), i++;
    else if (a === '--to') opt.to = need(i), i++;
    else if (a === '--from-file') opt.fromFile = need(i), i++;
    else if (a === '--to-file') opt.toFile = need(i), i++;
    else if (a === '--out') opt.out = need(i), i++;
    else if (a === '--cache-dir') opt.cacheDir = need(i), i++;
    else if (a === '--json' || a === '--md' || a === '--html') opt.format = a.slice(2);
    else if (a === '-h' || a === '--help') { console.log(usage); process.exit(0); }
    else { console.error(`unknown option ${a}\n${usage}`); process.exit(2); }
  }
  for (const v of [opt.from, opt.to]) if (v && !SEMVER.test(v)) { console.error(`'${v}' is not a version`); process.exit(2); }
  try {
    if ((!opt.to && !opt.toFile) || (!opt.from && !opt.fromFile)) {
      opt.to ??= opt.toFile ? null : execFileSync('npm', ['view', PACKAGE, 'version'], { encoding: 'utf8', timeout: 60_000 }).trim();
      if (!opt.from && !opt.fromFile) {
        const all = JSON.parse(execFileSync('npm', ['view', PACKAGE, 'versions', '--json'], { encoding: 'utf8', timeout: 60_000 }));
        opt.from = [].concat(all).filter((v) => SEMVER.test(v) && cmpV(v, opt.to) < 0).sort(cmpV).at(-1) ?? null;
        if (!opt.from) throw new Error(`no release before ${opt.to}`);
      }
    }
    const diff = harnessDiff({ from: opt.from ?? path.basename(opt.fromFile), to: opt.to ?? path.basename(opt.toFile), cacheDir: opt.cacheDir,
      fromText: opt.fromFile ? readFileSync(opt.fromFile, 'utf8') : null, toText: opt.toFile ? readFileSync(opt.toFile, 'utf8') : null });
    const text = opt.format === 'json' ? JSON.stringify(diff, null, 2) + '\n' : opt.format === 'html' ? renderDiffHtml(diff, { generatedAt: Date.now() }) : renderMarkdown(diff);
    if (opt.out) { writeFileSync(opt.out, text); console.log(diff.summary.headline); } else process.stdout.write(text);
  } catch (e) { console.error(`harness-diff: ${e.message}`); process.exit(1); }
}
