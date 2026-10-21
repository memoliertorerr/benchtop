import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ProjectDoc } from '@benchtop/core';
import { describe, expect, it } from 'vitest';
import { REPO_ROOT } from '../../../../packages/core/src/firmware/fixtures.test-helper.ts';
import { exampleHash, MAX_LINK_CHARS, projectHash, readHash, shareable } from './share.ts';

const project = (name: string): ProjectDoc => JSON.parse(readFileSync(join(REPO_ROOT, 'fixtures', 'projects', `${name}.json`), 'utf8')) as ProjectDoc;

describe('share links (BT44)', () => {
  it('round-trips a project through the URL hash, without firmware that cannot travel', async () => {
    const doc = project('servo-knob');
    doc.firmware.uno = { kind: 'inline', fqbn: 'arduino:avr:uno', files: { 'sketch.ino': 'void setup() {}\nvoid loop() {}\n' }, main: 'sketch.ino' };
    const shared = await projectHash(doc);
    expect(shared.ok).toBe(true);
    if (!shared.ok) return;
    expect(shared.hash).toMatch(/^#project=[A-Za-z0-9_-]+$/);
    const opened = await readHash(shared.hash);
    expect(opened.kind).toBe('project');
    if (opened.kind !== 'project' || !opened.result.ok) throw new Error('did not parse');
    expect(opened.result.doc).toEqual(doc); // the inline sketch travels
    // A dropped file's name means nothing elsewhere: left out.
    const withFile = project('blink-led');
    expect(Object.keys(withFile.firmware)).toEqual(['uno']);
    expect(shareable(withFile).firmware).toEqual({});
  });

  it('refuses a link over 8 KB, with a message', async () => {
    const doc = project('blink-led');
    // Incompressible text in an inline sketch.
    let text = '';
    let x = 12345;
    for (let i = 0; i < 20_000; i++) {
      x = (x * 1103515245 + 12345) & 0x7fffffff;
      text += String.fromCharCode(33 + (x % 90));
    }
    doc.firmware.uno = { kind: 'inline', fqbn: 'arduino:avr:uno', files: { 'sketch.ino': text }, main: 'sketch.ino' };
    const shared = await projectHash(doc);
    expect(shared.ok).toBe(false);
    if (!shared.ok) expect(shared.error).toMatch(/over the 8 KB/);
    expect(MAX_LINK_CHARS).toBe(8192);
  });

  it('opens nothing from a malformed hash, and says why', async () => {
    for (const hash of ['#project=!!!', '#project=AAAA', '#project=' + 'A'.repeat(9000), '#example=../../etc']) {
      const opened = await readHash(hash);
      expect([hash.slice(0, 20), opened.kind]).toEqual([hash.slice(0, 20), 'error']);
    }
    // A well-formed link to JSON that isn't a project: parseProject refuses it.
    const deflated = new Uint8Array(await new Response(new Blob(['{"hello":1}']).stream().pipeThrough(new CompressionStream('deflate-raw'))).arrayBuffer());
    const hash = `#project=${btoa(String.fromCharCode(...deflated)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')}`;
    const notProject = await readHash(hash);
    expect(notProject.kind === 'project' && notProject.result.ok).toBe(false);
    expect((await readHash('#something-else')).kind).toBe('none');
    expect((await readHash('')).kind).toBe('none');
  });

  it('links examples by id', async () => {
    expect(exampleHash('traffic-light')).toBe('#example=traffic-light');
    expect(await readHash('#example=traffic-light')).toEqual({ kind: 'example', id: 'traffic-light' });
  });
});
