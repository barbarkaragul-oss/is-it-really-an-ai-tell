/**
 * Writes data/evidence.json: for every countable marker and every arm, what the regex matched.
 *
 *   npx tsx scripts/evidence.ts
 *
 * Per arm and marker: the forms that matched, the word in front of each match, and up to five
 * sentences picked by a seeded shuffle. Sentences are quoted only from arms whose licence allows it
 * (see scripts/arms.ts); the others get a link to the original where one exists, and nothing else.
 *
 * The arm summary also carries "we" per thousand words. It is not a marker anybody claims, but it is
 * the other half of the most visible pattern here: the models write "the proposed method leverages",
 * and the people who wrote the same abstracts write "we leverage".
 */
import { writeFileSync, mkdirSync, existsSync } from 'node:fs';
import path from 'node:path';
import { MARKERS, words } from '../src/markers.js';
import { hits, top, forms, examples, linkFor } from '../src/evidence.js';
import { loadArms } from './arms.js';

const SEED = 20260916;
const PER_CELL = 5;
const DATA = path.resolve('data');

const loaded = loadArms();
if (!loaded.length) { console.error('no corpora in out/; run the collectors first'); process.exit(1); }

const arms: Record<string, { label: string; publishable: boolean; texts: number; words: number; we_per1000: number }> = {};
for (const { arm, spec } of loaded) {
  let w = 0, we = 0;
  for (const t of arm.texts) { w += words(t.text).length; we += (t.text.match(/\bwe\b/gi) ?? []).length; }
  arms[arm.id] = { label: arm.label, publishable: spec.publishable, texts: arm.texts.length, words: w, we_per1000: w ? (1000 * we) / w : 0 };
}

type Example = { id: string; sentence?: string; link?: string };
const markers: Record<string, { label: string; arms: Record<string, { occurrences: number; forms: [string, number][]; before: [string, number][]; examples: Example[] }> }> = {};

for (const m of MARKERS.filter((x) => x.pattern)) {
  const cells: (typeof markers)[string]['arms'] = {};
  for (const { arm, spec } of loaded) {
    const all = hits(arm.texts, m);
    if (!all.length) continue;
    const picked = examples(all, PER_CELL, SEED);
    cells[arm.id] = {
      occurrences: all.length,
      forms: forms(all, spec.publishable, m.openEnded === true),
      before: top(all.map((h) => h.before), 8),
      examples: picked.map((h): Example => {
        if (spec.publishable) return { id: h.id, sentence: h.sentence };
        const link = linkFor(arm.id, h.id);
        return link ? { id: h.id, link } : { id: h.id };
      }),
    };
  }
  markers[m.id] = { label: m.label, arms: cells };
}

if (!existsSync(DATA)) mkdirSync(DATA, { recursive: true });
writeFileSync(path.join(DATA, 'evidence.json'), JSON.stringify({
  generated_at: new Date().toISOString(),
  seed: SEED,
  per_cell: PER_CELL,
  note: 'Sentences are quoted only from RAID (MIT) and from the Claude arm generated for this repository. Hacker News and Stack Exchange texts are linked, not quoted; HC3 is referenced by id.',
  arms,
  markers,
}, null, 1) + '\n');

// a readable summary of the cells worth looking at
const short = (id: string): string => id.replace('raid-', '').replace('-human', '');
for (const [id, mk] of Object.entries(markers)) {
  const cells = Object.entries(mk.arms);
  if (!cells.length) continue;
  console.log(`\n${mk.label}`);
  for (const [a, c] of cells) {
    console.log(`  ${short(a).padEnd(14)} ${String(c.occurrences).padStart(4)}  forms ${c.forms.slice(0, 4).map(([f, n]) => `${f}:${n}`).join(' ')}   before ${c.before.slice(0, 4).map(([f, n]) => `${f}:${n}`).join(' ')}`);
  }
  void id;
}
console.log('\n"we" per thousand words:');
for (const [a, s] of Object.entries(arms)) console.log(`  ${short(a).padEnd(14)} ${s.we_per1000.toFixed(2)}`);
console.log('\nwrote data/evidence.json');
