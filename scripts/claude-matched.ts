/**
 * Writes data/claude-matched.json: every countable marker's rate on the documents the Claude arm
 * covers, for every RAID writer.
 *
 *   npx tsx scripts/claude-matched.ts
 *
 * The Claude arm is 45 abstracts, all from the first fifty documents of the file, and those are
 * mostly about image segmentation. Set against the other writers' whole arms, its rates would be
 * comparing subjects as much as writers. Here every writer is counted on the same 45 documents.
 * At this size a word turns up a handful of times, so the occurrences are published with the rates.
 */
import { writeFileSync, mkdirSync, existsSync } from 'node:fs';
import path from 'node:path';
import { MARKERS } from '../src/markers.js';
import { rate, sourceId } from '../src/measure.js';
import { loadArms } from './arms.js';

const WRITERS = ['raid-human', 'raid-chatgpt', 'raid-gpt4', 'raid-llama-chat', 'raid-mistral-chat', 'raid-claude'];
const DATA = path.resolve('data');

const arms = new Map(loadArms().map(({ arm }) => [arm.id, arm]));
const claude = arms.get('raid-claude');
if (!claude) { console.error('no Claude arm in out/; run scripts/contamination.ts first'); process.exit(1); }

// only the documents every writer has, so each column is the same set of abstracts
const ids = [...new Set(claude.texts.map((t) => sourceId(t.id)))]
  .filter((id) => WRITERS.every((w) => arms.get(w)?.texts.some((t) => sourceId(t.id) === id)))
  .sort();
const idSet = new Set(ids);

const rows = MARKERS.filter((m) => m.count).map((m) => ({
  marker: m.id,
  label: m.label,
  rate: Object.fromEntries(WRITERS.filter((w) => arms.has(w)).map((w) => {
    const r = rate(arms.get(w)!.texts.filter((t) => idSet.has(sourceId(t.id))), m);
    return [w, { per1000: r.per1000, occurrences: r.occurrences, words: r.words, lo: r.lo, hi: r.hi }];
  })),
}));

if (!existsSync(DATA)) mkdirSync(DATA, { recursive: true });
writeFileSync(path.join(DATA, 'claude-matched.json'), JSON.stringify({
  generated_at: new Date().toISOString(),
  documents: ids.length,
  note: 'Rates per thousand words on the documents the generated Claude arm covers, for every RAID writer. Small counts: read the occurrences.',
  source_ids: ids,
  rows,
}, null, 1) + '\n');

const short = (w: string): string => w.replace('raid-', '');
console.log(`${ids.length} documents every writer covered\n`);
console.log('marker'.padEnd(22) + WRITERS.map((w) => short(w).padEnd(14)).join(''));
for (const r of rows) {
  if (!Object.values(r.rate).some((x) => x.occurrences)) continue;
  console.log(r.marker.padEnd(22) + WRITERS.map((w) => {
    const x = r.rate[w];
    return (x ? `${x.per1000.toFixed(2)} (${x.occurrences})` : '-').padEnd(14);
  }).join(''));
}
console.log('\nwrote data/claude-matched.json');
