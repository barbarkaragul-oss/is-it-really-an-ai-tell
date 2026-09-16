/**
 * Reads the corpora in out/, writes data/markers.json, prints the table.
 *
 *   npx tsx collector/fetch.ts       # Hacker News, Stack Exchange, HC3
 *   npx tsx collector/fetch-raid.ts  # one document, several writers
 *   npx tsx scripts/measure-all.ts
 *
 * data/markers.json is what the repository publishes: the shares, the rates, the intervals, the
 * placebo column and the size and kind of every pairing. The corpus text stays in out/, uncommitted.
 */
import { writeFileSync, existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { measure, type Pairing } from '../src/measure.js';
import { MARKERS } from '../src/markers.js';
import { loadArms } from './arms.js';

const DATA = path.resolve('data');

const arms = loadArms().map((x) => x.arm);

if (arms.length < 3) { console.error('need at least three arms; run the collectors first'); process.exit(1); }

const has = (id: string): boolean => arms.some((a) => a.id === id);
// The reference is the human side of the matched set: the same documents every model was asked to
// continue, so a difference is about the writer rather than about the subject.
const reference = has('raid-human') ? 'raid-human' : 'careful-human';
const machine = has('raid-gpt4') ? 'raid-gpt4' : 'hc3-gpt35';
const report = measure(arms, { reference, casual: 'casual-human', machine });

if (!existsSync(DATA)) mkdirSync(DATA, { recursive: true });
writeFileSync(path.join(DATA, 'markers.json'), JSON.stringify(report, null, 1) + '\n');

const pad = (s: string, n: number): string => (s.length > n ? s.slice(0, n - 1) + '…' : s.padEnd(n));
const PAIRED: Record<Pairing, string> = {
  document: 'document pairs with the reference',
  length: 'length-matched with the reference',
  self: 'the reference itself',
};
console.log(`\nreference: ${reference}   verdicts decided against: ${machine}`);
console.log('\narms:');
for (const a of report.arms) {
  console.log(`  ${pad(a.label, 52)} ${String(a.n).padStart(5)} texts, ${String(a.matchedWithReference).padStart(4)} ${PAIRED[a.pairing]}, median ${a.medianWords} words`);
}

const cols = report.arms.map((a) => a.id);
const head = (c: string): string => c.replace('raid-', '').replace('casual-human', 'casual').replace('careful-human', 'careful');

// A whole-text marker is decided on these shares; a word's shares are shown for comparison only.
console.log('\nshare of texts carrying the marker (each arm on its pairing with the reference; texts a marker cannot judge left out):');
console.log(pad('marker', 30) + cols.map((c) => pad(head(c), 14)).join('') + pad('placebo', 13) + 'verdict');
console.log('-'.repeat(30 + 14 * cols.length + 13 + 20));
for (const r of report.rows) {
  const placebo = r.countable ? '' : `${r.placebo.a.pct.toFixed(1)}/${r.placebo.b.pct.toFixed(1)}${r.placebo.tie ? '' : ' !'}`;
  console.log(
    pad((r.belief ? '* ' : '') + r.label, 30) +
    cols.map((c) => pad(r.share[c] ? `${r.share[c]!.arm.pct.toFixed(1)}%` : '-', 14)).join('') +
    pad(placebo, 13) + (r.countable ? '(by rate, below)' : r.verdict),
  );
}

// Rates over every text in the arm; a word's verdict compares texts of about the same length.
console.log('\noccurrences per thousand words (whole arm; q and verdict compare texts of the same length):');
const countable = report.rows.filter((r) => r.countable);
console.log(pad('marker', 30) + cols.map((c) => pad(head(c), 14)).join('') + pad('placebo', 13) + pad('q', 10) + 'verdict');
console.log('-'.repeat(30 + 14 * cols.length + 13 + 10 + 20));
for (const r of countable) {
  const placebo = `${r.placebo.rate.a.per1000.toFixed(2)}/${r.placebo.rate.b.per1000.toFixed(2)}${r.placebo.tie ? '' : ' !'}`;
  console.log(pad(r.label, 30) + cols.map((c) => {
    const x = r.rate[c];
    return pad(x && x.occurrences ? `${x.per1000.toFixed(2)} (${x.occurrences})` : '.', 14);
  }).join('') + pad(placebo, 13) + pad(r.q === null ? '-' : r.q < 0.001 ? '<0.001' : r.q.toFixed(3), 10) + r.verdict);
}

console.log(`\n* = a marker people are documented to judge by, rather than one anybody measured.`);
console.log(`${MARKERS.length} markers; ${report.rows.filter((r) => r.verdict === 'machine marker').length} separate ${machine} from ${reference}, ${report.rows.filter((r) => r.verdict === 'register marker').length} mark register, ${report.rows.filter((r) => r.verdict === 'points the other way').length} point the other way.`);
console.log(`placebo disagreements (should be none): ${report.rows.filter((r) => !r.placebo.tie).length}`);
console.log('wrote data/markers.json');
