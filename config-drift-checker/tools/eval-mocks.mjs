// eval-mocks: the official `claude plugin eval` MCP mock format, shared by the shim (which serves the
// mocks through tools/eval-mock-server.mjs) and suite-doctor (which checks the files statically).
//
// Layout (https://code.claude.com/docs/en/plugin-evals, Claude Code 2.1.295):
//   <eval dir>/mocks/<server>/<tool>.md     one mocked tool for the whole suite; body = the tool result
//   <case>/mocks/<server>/<tool>.md         the same for one case; overrides the suite file by file
//   <server>/_server.md                     one type: agent mock answering the tools in its tools: list
//   <server>/_tools.json                    a saved tools/list response (real descriptions and schemas)
//   <server>/fixtures/                      files a body inserts with {{file:fixtures/...}}
//   mocks/.replay/<server>/                 adopted agent-mock recordings (agent mocks only)
// <tool>.md frontmatter: type (fixed | agent), expect (dotted input path -> type name, /regex/,
// literal, or list of literals), error (fixed only), abort_when (agent only).
// <server> is the server's name in the plugin's MCP config (or the full normalized registered name,
// plugin_<plugin>_<server>); any other directory name registers a standalone server under that name.
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';

export const MOCK_KEYS = ['type', 'expect', 'error', 'abort_when'];
export const SERVER_MD_KEYS = ['type', 'tools', 'expect', 'abort_when'];
export const EXPECT_TYPES = ['string', 'number', 'boolean', 'array', 'object'];
export const ABORT_PREFIX = 'EVAL_MOCK_ABORT';
// the body `claude plugin eval init` scaffolds; the runner refuses to start while a mock still holds it
export const STUB_BODY = 'TODO: replace with the canned result this tool should return';

// The tool-name segment Claude Code derives from a server name (mcp__<segment>__<tool>).
export const segment = (name) => String(name).replace(/[^A-Za-z0-9_-]/g, '_');
export const pluginServerKey = (plugin, server) => segment(`plugin:${plugin}:${server}`);
export const toolFullName = (key, tool) => `mcp__${key}__${tool}`;

// ---------- frontmatter: top-level keys, one level of nested map (expect:), flow and block lists ----------
function scalar(v) {
  v = String(v).trim();
  if (v === '') return '';
  if (/^\[.*\]$/.test(v)) return v.slice(1, -1).split(',').map((s) => scalar(s)).filter((s) => s !== '');
  if (/^(['"]).*\1$/.test(v)) return v.slice(1, -1);
  if (v === 'true') return true; if (v === 'false') return false;
  if (v === 'null') return null;
  if (/^-?\d+(\.\d+)?$/.test(v)) return Number(v);
  return v;
}
const uncomment = (v) => v.replace(/\s+#[^'"]*$/, '').trim();
const unquote = (k) => k.trim().replace(/^(['"])(.*)\1$/, '$2');

export function parseMockFile(text) {
  const m = text.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (!m) return { meta: {}, body: cleanBody(text) };
  const lines = m[1].split(/\r?\n/);
  const meta = {};
  for (let i = 0; i < lines.length; i++) {
    const kv = lines[i].match(/^([A-Za-z_][\w-]*):(?:[ \t]+(.*))?$/);
    if (!kv) continue;
    const raw = uncomment(kv[2] ?? '');
    const kids = [];
    while (i + 1 < lines.length && (/^\s+\S/.test(lines[i + 1]) || /^-\s/.test(lines[i + 1]) || lines[i + 1].trim() === '')) kids.push(lines[++i]);
    if (/^[|>][-+]?$/.test(raw)) {
      const ind = Math.min(...kids.filter((l) => l.trim()).map((l) => l.match(/^\s*/)[0].length));
      meta[kv[1]] = kids.map((l) => l.slice(Number.isFinite(ind) ? ind : 0)).join(raw[0] === '|' ? '\n' : ' ').trim();
    } else if (raw !== '') meta[kv[1]] = scalar(raw);
    else if (kids.some((l) => /^\s*-\s/.test(l)) && !kids.some((l) => /^\s+[^-\s]/.test(l) && /:(\s|$)/.test(l))) meta[kv[1]] = kids.filter((l) => /^\s*-\s/.test(l)).map((l) => scalar(uncomment(l.replace(/^\s*-\s+/, ''))));
    else meta[kv[1]] = mapOf(kids);
  }
  return { meta, body: cleanBody(m[2]) };
}
const cleanBody = (b) => b.replace(/\r\n/g, '\n').replace(/^\n+/, '').replace(/\s+$/, '');
function mapOf(kids) {
  const out = {};
  for (let j = 0; j < kids.length; j++) {
    const kv = kids[j].match(/^\s+((?:'[^']*'|"[^"]*"|[^\s:'"][^:]*?)):(?:[ \t]+(.*))?$/);
    if (!kv) continue;
    const raw = uncomment(kv[2] ?? '');
    if (raw !== '') { out[unquote(kv[1])] = scalar(raw); continue; }
    const items = [];
    while (j + 1 < kids.length && /^\s+-\s/.test(kids[j + 1])) items.push(scalar(uncomment(kids[++j].replace(/^\s*-\s+/, ''))));
    out[unquote(kv[1])] = items;
  }
  return out;
}

// ---------- expect: ----------
const REGEX_SPEC = /^\/([\s\S]*)\/([a-z]*)$/;
export const isRegexSpec = (v) => typeof v === 'string' && REGEX_SPEC.test(v);

// The small regex dialect the official runner accepts in expect: (anything else stops the case loading).
export function checkExpectRegex(spec) {
  const m = String(spec).match(REGEX_SPEC);
  if (!m) return 'not a /regex/';
  const [, src, flags] = m;
  if (/[^is]/.test(flags)) return `flag(s) "${flags}" (only i and s are allowed)`;
  let i = src.startsWith('^') ? 1 : 0;
  const end = src.endsWith('$') && !src.endsWith('\\$') ? src.length - 1 : src.length;
  let atom = false;
  while (i < end) {
    const ch = src[i];
    if (ch === '\\') {
      if (i + 1 >= end) return 'a trailing backslash';
      if (/[1-9k]/.test(src[i + 1])) return 'a backreference';
      i += 2; atom = true; continue;
    }
    if (ch === '[') {
      let j = i + 1;
      if (src[j] === '^') j++;
      if (src[j] === ']') j++;
      while (j < end && src[j] !== ']') { if (src[j] === '\\') j++; j++; }
      if (j >= end) return 'an unclosed character class';
      i = j + 1; atom = true; continue;
    }
    if ('*+?'.includes(ch)) {
      if (!atom) return src[i - 1] && '*+?}'.includes(src[i - 1]) ? 'a quantifier on a quantifier (lazy or possessive forms are not allowed)' : `a ${ch} with nothing to repeat`;
      i++; atom = false; continue;
    }
    if (ch === '{') {
      const q = src.slice(i).match(/^\{\d+(,\d*)?\}/);
      if (q) { if (!atom) return 'a {m,n} quantifier with nothing to repeat'; i += q[0].length; atom = false; continue; }
      i++; atom = true; continue;
    }
    if (ch === '(' || ch === ')') return 'a group';
    if (ch === '|') return 'an alternation (write a list of literals instead)';
    if (ch === '^' || ch === '$') return `an anchor ${ch} in the middle`;
    i++; atom = true;
  }
  try { new RegExp(src, flags); } catch (e) { return e.message; }
  return null;
}

const dig = (obj, dotted) => String(dotted).split('.').reduce((o, k) => (o === null || o === undefined ? undefined : o[k]), obj);
const show = (v) => (v === undefined ? 'nothing' : JSON.stringify(v));
const sameLiteral = (v, w) => v === w || (v !== undefined && v !== null && typeof v !== 'object' && String(v) === String(w));
function isType(v, t) {
  if (t === 'array') return Array.isArray(v);
  if (t === 'object') return v !== null && typeof v === 'object' && !Array.isArray(v);
  return typeof v === t;
}

// null when the input satisfies expect:, else why not (the run is then aborted with score 0).
export function checkExpect(input, expect) {
  for (const [p, want] of Object.entries(expect ?? {})) {
    const v = dig(input, p);
    if (Array.isArray(want)) { if (!want.some((w) => sameLiteral(v, w))) return `${p}: ${show(v)} is not one of ${want.map((w) => JSON.stringify(w)).join(', ')}`; continue; }
    if (isRegexSpec(want)) {
      const [, src, flags] = want.match(REGEX_SPEC);
      if (!(typeof v === 'string' || typeof v === 'number') || !new RegExp(src, flags).test(String(v))) return `${p}: ${show(v)} does not match ${want}`;
      continue;
    }
    if (EXPECT_TYPES.includes(want)) { if (!isType(v, want)) return `${p}: expected ${want}, got ${show(v)}`; continue; }
    if (!sameLiteral(v, want)) return `${p}: expected ${JSON.stringify(want)}, got ${show(v)}`;
  }
  return null;
}

// ---------- the body: {{input.<field>}} and {{file:fixtures/{input.<field>}.json}} ----------
export function renderMock(body, input, dir) {
  return String(body).replace(/\{\{\s*(?:input\.([\w.-]+)|file:((?:[^{}]|\{[^{}]*\})+?))\s*\}\}/g, (all, field, file) => {
    if (field !== undefined) { const v = dig(input, field); return v === undefined || v === null ? '' : typeof v === 'object' ? JSON.stringify(v) : String(v); }
    const rel = file.trim().replace(/\{input\.([\w.-]+)\}/g, (_, k) => String(dig(input, k) ?? ''));
    const abs = path.resolve(dir, rel);
    if (!abs.startsWith(path.resolve(dir) + path.sep)) return `[mock fixture ${rel} is outside the mock directory]`;
    try { return readFileSync(abs, 'utf8'); } catch { return `[mock fixture ${rel} not found]`; }
  });
}

// ---------- validation (what stops the official runner loading the case) ----------
function validateExpect(expect, file) {
  if (expect === undefined) return [];
  if (expect === null || typeof expect !== 'object' || Array.isArray(expect)) return [{ level: 'ERROR', file, key: 'expect', message: 'expect: must be a map from input paths to a type, /regex/, literal or list' }];
  const out = [];
  for (const [p, want] of Object.entries(expect)) {
    const bad = isRegexSpec(want) ? checkExpectRegex(want) : null;
    if (bad) out.push({ level: 'ERROR', file, key: 'expect', message: `expect.${p}: ${want} uses ${bad}, outside the regex dialect the runner accepts` });
  }
  return out;
}
export function validateToolMock(meta, file, body = '') {
  const out = Object.keys(meta).filter((k) => !MOCK_KEYS.includes(k)).map((k) => ({ level: 'ERROR', file, key: k,
    message: k === 'tools' ? 'tools: belongs in _server.md (a <tool>.md answers the tool it is named after)' : `unknown mock key ${k}: (allowed: ${MOCK_KEYS.join(', ')})` }));
  const type = meta.type ?? 'fixed';
  if (type === 'agent' && (body === '' || body.includes(STUB_BODY))) out.push({ level: 'ERROR', file, key: null, message: 'a type: agent mock needs a description of the server it plays as its body' });
  if (type === 'fixed' && body.includes(STUB_BODY)) out.push({ level: 'ERROR', file, key: null, message: 'still holds the scaffolded placeholder; write the tool\'s canned answer as the body' });
  if (!['fixed', 'agent'].includes(type)) out.push({ level: 'ERROR', file, key: 'type', message: `type: ${type} is not fixed or agent` });
  if ('error' in meta && type !== 'fixed') out.push({ level: 'ERROR', file, key: 'error', message: 'error: applies to type: fixed mocks only' });
  if ('error' in meta && typeof meta.error !== 'boolean') out.push({ level: 'ERROR', file, key: 'error', message: 'error: must be true or false' });
  if ('abort_when' in meta && type !== 'agent') out.push({ level: 'ERROR', file, key: 'abort_when', message: 'abort_when: applies to type: agent mocks only' });
  return [...out, ...validateExpect(meta.expect, file)];
}
export function validateServerMock(meta, file, body = '') {
  const out = Object.keys(meta).filter((k) => !SERVER_MD_KEYS.includes(k)).map((k) => ({ level: 'ERROR', file, key: k, message: `unknown _server.md key ${k}: (allowed: ${SERVER_MD_KEYS.join(', ')})` }));
  if (meta.type !== 'agent') out.push({ level: 'ERROR', file, key: 'type', message: '_server.md needs type: agent (one agent answering several tools); put a fixed answer in <tool>.md' });
  if (body === '' || body.includes(STUB_BODY)) out.push({ level: 'ERROR', file, key: null, message: 'an agent mock needs a description of the server it plays as its body' });
  const tools = Array.isArray(meta.tools) ? meta.tools : meta.tools ? [meta.tools] : [];
  if (!tools.length) out.push({ level: 'ERROR', file, key: 'tools', message: '_server.md needs a tools: list naming the tools it answers' });
  if ('expect' in meta && tools.length !== 1) out.push({ level: 'ERROR', file, key: 'expect', message: 'expect: in _server.md is a load error unless tools: lists a single tool; put the guard on the tool\'s own <tool>.md' });
  return [...out, ...validateExpect(meta.expect, file)];
}

// ---------- loading ----------
// Reads mock roots in order (suite first, then case), later files overriding earlier ones tool by tool.
// relBase makes problem paths readable (the eval dir).
export function loadMockRoots(roots, relBase) {
  const servers = new Map();
  const problems = [];
  for (const root of roots) {
    if (!root || !existsSync(root)) continue;
    for (const d of readdirSync(root, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      if (!d.isDirectory() || d.name.startsWith('.')) continue;
      const dir = path.join(root, d.name);
      const rel = (f) => path.relative(relBase, path.join(dir, f)) || '.';
      if (segment(d.name) !== d.name) problems.push({ level: 'ERROR', file: rel(''), key: null, message: `mocks/${d.name}/ is not a tool-name segment (letters, digits, "_" and "-" only); name it mocks/${segment(d.name)}/` });
      else if (d.name.includes('__')) problems.push({ level: 'ERROR', file: rel(''), key: null, message: `mocks/${d.name}/: "__" is the tool-name separator and cannot appear in a mock directory name` });
      const s = servers.get(d.name) ?? { name: d.name, tools: new Map(), server: null, listing: null };
      for (const f of readdirSync(dir).sort()) {
        const fp = path.join(dir, f);
        if (!statSync(fp).isFile()) continue;
        if (f === '_tools.json') {
          let j;
          try { j = JSON.parse(readFileSync(fp, 'utf8')); } catch (e) { problems.push({ level: 'ERROR', file: rel(f), key: null, message: `_tools.json is not valid JSON (${e.message})` }); continue; }
          const list = (j && typeof j === 'object' && 'result' in j ? j.result : j)?.tools;
          if (!Array.isArray(list) || !list.every((t) => t && typeof t.name === 'string')) problems.push({ level: 'ERROR', file: rel(f), key: null, message: 'expected a saved tools/list response ({"tools": [{"name", "description", "inputSchema"}]})' });
          else s.listing = list;
          continue;
        }
        if (!f.endsWith('.md')) continue;
        const { meta, body } = parseMockFile(readFileSync(fp, 'utf8'));
        if (f === '_server.md') {
          s.server = { file: rel(f), meta, body, dir, tools: Array.isArray(meta.tools) ? meta.tools.map(String) : meta.tools ? [String(meta.tools)] : [] };
          problems.push(...validateServerMock(meta, rel(f), body));
          continue;
        }
        const name = f.slice(0, -3);
        if (segment(name) !== name || name.includes('__')) problems.push({ level: 'ERROR', file: rel(f), key: null, message: `${f}: name tool files after the tool (letters, digits, "_" and "-" only, no "__"), e.g. list_issues.md` });
        s.tools.set(name, { name, file: rel(f), dir, kind: meta.type ?? 'fixed', body, error: meta.error === true, expect: meta.expect ?? null });
        problems.push(...validateToolMock(meta, rel(f), body));
      }
      servers.set(d.name, s);
    }
  }
  for (const s of servers.values()) if (!s.tools.size && !s.server) problems.push({ level: 'WARN', file: path.relative(relBase, path.join(roots.find((r) => r && existsSync(path.join(r, s.name))), s.name)), key: null, message: `mocks/${s.name}/ has no <tool>.md responders, so nothing is mocked for ${s.name}` });
  return { servers, problems };
}
export const loadMocks = (evalDir, caseDir) => loadMockRoots([path.join(evalDir, 'mocks'), caseDir ? path.join(caseDir, 'mocks') : null], evalDir);

// Every tool a server answers, with who answers it: its own <tool>.md, else _server.md (an agent).
export function answeredTools(s) {
  const out = new Map([...s.tools].map(([k, t]) => [k, t.kind]));
  for (const t of s.server?.tools ?? []) if (!out.has(t)) out.set(t, 'agent');
  return out;
}

// ---------- the plugin's own MCP servers ----------
// { servers: { name: config }, unenumerable: [why] } from plugin.json mcpServers (inline map, a path
// or a list of either) and a root .mcp.json. An MCPB bundle cannot be enumerated or shadowed.
export function declaredServers(pluginDir) {
  const servers = {}, unenumerable = [];
  const readJson = (p) => { try { return JSON.parse(readFileSync(p, 'utf8')); } catch { return null; } };
  const absorb = (j) => { if (j && typeof j === 'object') Object.assign(servers, j.mcpServers && typeof j.mcpServers === 'object' ? j.mcpServers : j); };
  const manifest = readJson(path.join(pluginDir, '.claude-plugin/plugin.json')) ?? {};
  const decl = manifest.mcpServers;
  for (const item of decl === undefined ? [] : Array.isArray(decl) ? decl : [decl]) {
    if (typeof item === 'string') {
      if (/\.mcpb$/i.test(item)) { unenumerable.push(item); continue; }
      absorb(readJson(path.resolve(pluginDir, item)));
    } else absorb({ mcpServers: item });
  }
  if (existsSync(path.join(pluginDir, '.mcp.json'))) absorb(readJson(path.join(pluginDir, '.mcp.json')));
  return { servers, unenumerable };
}

// How each mock directory is registered for a run: a shadow of a plugin server (registered under the
// plugin's own name, so tool names match what the plugin's skills call) or a standalone server.
export function planMocks(servers, pluginName, declared) {
  const byDir = new Map();
  for (const name of Object.keys(declared)) {
    byDir.set(segment(name), name);
    byDir.set(pluginServerKey(pluginName, name), name);
  }
  return [...servers.values()].map((s) => {
    const declaredAs = byDir.get(s.name) ?? null;
    const key = declaredAs ? pluginServerKey(pluginName, declaredAs) : s.name;
    const tools = answeredTools(s);
    return { dir: s.name, key, shadow: !!declaredAs, declaredAs, tools, fullNames: [...tools.keys()].map((t) => toolFullName(key, t)), source: s };
  });
}
