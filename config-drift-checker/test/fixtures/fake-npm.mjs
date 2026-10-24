// A stand-in for `npm pack @anthropic-ai/claude-code@<v>` so harness-diff and the release report can be
// tested without the network: fakeNpm({ '2.1.1': '<sdk-tools.d.ts text>' }) writes real .tgz tarballs
// (package/sdk-tools.d.ts inside) and an `npm` script that copies the right one to --pack-destination,
// logging every call. Put the returned binDir first on PATH.
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { gzipSync } from 'node:zlib';

// a minimal ustar archive: one 512-byte header per file, the body padded to 512, two zero blocks at the end
export function tarball(files) {
  const blocks = [];
  for (const [name, text] of Object.entries(files)) {
    const body = Buffer.from(text);
    const h = Buffer.alloc(512);
    h.write(name, 0, 100, 'utf8');
    h.write('0000644\0', 100); h.write('0000000\0', 108); h.write('0000000\0', 116);
    h.write(body.length.toString(8).padStart(11, '0') + '\0', 124);
    h.write('00000000000\0', 136);
    h.write('        ', 148);
    h.write('0', 156);
    h.write('ustar\0', 257); h.write('00', 263);
    let sum = 0;
    for (const b of h) sum += b;
    h.write(sum.toString(8).padStart(6, '0') + '\0 ', 148);
    blocks.push(h, body, Buffer.alloc((512 - (body.length % 512)) % 512));
  }
  blocks.push(Buffer.alloc(1024));
  return gzipSync(Buffer.concat(blocks));
}

export async function fakeNpm(versions) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'fake-npm-'));
  const store = path.join(dir, 'store'), binDir = path.join(dir, 'bin'), log = path.join(dir, 'calls.jsonl');
  await fs.mkdir(store); await fs.mkdir(binDir);
  for (const [v, text] of Object.entries(versions)) {
    await fs.writeFile(path.join(store, `${v}.tgz`), tarball({ 'package/package.json': JSON.stringify({ name: '@anthropic-ai/claude-code', version: v }), 'package/sdk-tools.d.ts': text }));
  }
  await fs.writeFile(path.join(binDir, 'npm'), `#!${process.execPath}
const fs = require('node:fs'), path = require('node:path');
const a = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify(a) + '\\n');
if (a[0] !== 'pack') { console.error('fake npm: only pack'); process.exit(1); }
const v = a[1].split('@').pop(), src = path.join(${JSON.stringify(store)}, v + '.tgz');
if (!fs.existsSync(src)) { console.error('npm error 404 No match found for version ' + v); process.exit(1); }
const file = 'anthropic-ai-claude-code-' + v + '.tgz';
fs.copyFileSync(src, path.join(a[a.indexOf('--pack-destination') + 1], file));
console.log(JSON.stringify([{ filename: file }]));
`);
  await fs.chmod(path.join(binDir, 'npm'), 0o755);
  const calls = async () => { try { return (await fs.readFile(log, 'utf8')).trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)); } catch { return []; } };
  return { binDir, calls, cacheDir: path.join(dir, 'cache') };
}
