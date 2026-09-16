/**
 * Builds the static site into docs/.
 *
 *   npx tsx scripts/build.ts
 *
 * The page gets one compact file, docs/data/page.json, made from data/markers.json and
 * data/evidence.json with the numbers rounded, and the same src/markers.ts the measurement uses,
 * bundled, so a pasted text is counted by exactly the code that produced the table.
 */
import { build } from 'esbuild';
import { mkdirSync, copyFileSync, writeFileSync, readFileSync } from 'node:fs';
import path from 'node:path';
import type { Report } from '../src/measure.js';
import { ARMS } from './arms.js';

const DOCS = path.resolve('docs');
mkdirSync(path.join(DOCS, 'data'), { recursive: true });

const result = await build({
  entryPoints: ['src/ui/main.ts'],
  bundle: true,
  format: 'esm',
  platform: 'browser',
  target: ['es2022'],
  minify: true,
  outfile: path.join(DOCS, 'app.js'),
  logLevel: 'warning',
});
if (result.errors.length) process.exit(1);
for (const f of ['index.html', 'style.css']) copyFileSync(path.join('src/ui', f), path.join(DOCS, f));
writeFileSync(path.join(DOCS, '.nojekyll'), '');

const report = JSON.parse(readFileSync('data/markers.json', 'utf8')) as Report;
const evidence = JSON.parse(readFileSync('data/evidence.json', 'utf8')) as {
  arms: Record<string, { we_per1000: number }>;
  markers: Record<string, { arms: Record<string, unknown> }>;
  documents: unknown[];
};

const r2 = (x: number): number => Math.round(x * 100) / 100;
const r1 = (x: number): number => Math.round(x * 10) / 10;
const publishable = new Map(ARMS.map((a) => [a.id, a.publishable]));

const page = {
  generated_at: report.generated_at,
  reference: report.reference,
  machine: report.machine,
  arms: report.arms.map((a) => ({
    id: a.id, label: a.label, kind: a.kind, n: a.n, matched: a.matchedWithReference, medianWords: a.medianWords,
    publishable: publishable.get(a.id) ?? false,
    we: r2(evidence.arms[a.id]?.we_per1000 ?? 0),
  })),
  rows: report.rows.map((row) => ({
    marker: row.marker, label: row.label, family: row.family, belief: row.belief, countable: row.countable,
    verdict: row.verdict, placeboTie: row.placebo.tie,
    rate: Object.fromEntries(Object.entries(row.rate).map(([arm, x]) => [arm, { v: r2(x.per1000), lo: r2(x.lo), hi: r2(x.hi), occ: x.occurrences, words: x.words }])),
    share: Object.fromEntries(Object.entries(row.share).map(([arm, x]) => [arm, { v: r1(x.arm.pct), lo: r1(x.arm.lo), hi: r1(x.arm.hi), k: x.arm.k, n: x.arm.n, ref: r1(x.reference.pct), rlo: r1(x.reference.lo), rhi: r1(x.reference.hi) }])),
  })),
  evidence: Object.fromEntries(Object.entries(evidence.markers).map(([m, x]) => [m, x.arms])),
  documents: evidence.documents,
};
writeFileSync(path.join(DOCS, 'data', 'page.json'), JSON.stringify(page));

const kb = (f: string): number => Math.round(readFileSync(path.join(DOCS, f)).length / 1024);
console.log(`docs/app.js ${kb('app.js')} KB, docs/data/page.json ${kb('data/page.json')} KB`);
