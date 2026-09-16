/**
 * Reads the corpora in out/, writes data/markers.json and prints the table.
 *
 *   npx tsx collector/fetch.ts      # once, to build out/
 *   npx tsx scripts/measure-all.ts  # as often as you like
 *
 * data/markers.json is what the repository publishes: the rates, the intervals, the placebo column
 * and the ids that were sampled. The corpus text stays in out/, which is not committed.
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { measure, type Arm, type Text } from '../src/measure.js';
import { MARKERS } from '../src/markers.js';

const OUT = path.resolve('out');
const DATA = path.resolve('data');

function arm(id: string, label: string, kind: 'human' | 'machine', file: string): Arm | null {
  const f = path.join(OUT, `${file}.json`);
  if (!existsSync(f)) { console.error(`missing ${f} -- run: npx tsx collector/fetch.ts`); return null; }
  const rows = JSON.parse(readFileSync(f, 'utf8')) as { id: string; text: string }[];
  const texts: Text[] = rows.map((r) => ({ id: r.id, text: r.text, source: file }));
  return { id, label, kind, texts };
}

const arms = [
  arm('casual-human', 'casual human (Hacker News, before ChatGPT)', 'human', 'casual-human'),
  arm('careful-human', 'careful human (Stack Exchange answers, same period)', 'human', 'careful-human'),
  arm('raid-human', 'careful human (RAID: the documents GPT-4 was asked to continue)', 'human', 'raid-human'),
  arm('machine-2023', 'machine (HC3, GPT-3.5, early 2023)', 'machine', 'machine-2023'),
  arm('machine-2024', 'machine (RAID, GPT-4, same prompts as raid-human)', 'machine', 'machine-2024'),
].filter((a): a is Arm => a !== null && a.texts.length > 0);

if (arms.length < 3) { console.error('need at least the three base arms'); process.exit(1); }

// The verdict is decided against the best-matched human arm available. RAID's human rows answer the
// same prompt as its machine rows, so genre and topic are held constant there and only the writer
// differs; the Stack Exchange arm stays in the table as an independent reading of careful writing.
const has = (id: string): boolean => arms.some((a) => a.id === id);
const report = measure(arms, {
  casual: 'casual-human',
  careful: has('raid-human') ? 'raid-human' : 'careful-human',
  machine: has('machine-2024') ? 'machine-2024' : 'machine-2023',
});
console.log(`verdicts decided against: ${has('raid-human') ? 'raid-human' : 'careful-human'} (human) and ${has('machine-2024') ? 'machine-2024' : 'machine-2023'} (machine)`);

if (!existsSync(DATA)) mkdirSync(DATA, { recursive: true });
writeFileSync(path.join(DATA, 'markers.json'), JSON.stringify(report, null, 1) + '\n');

const pad = (s: string, n: number): string => (s.length > n ? s.slice(0, n - 1) + '…' : s.padEnd(n));
const fmt = (c: { pct: number; lo: number; hi: number } | undefined): string =>
  c ? `${c.pct.toFixed(1)}% (${c.lo.toFixed(1)}-${c.hi.toFixed(1)})` : '-';

console.log('\narms, after the length match:');
for (const a of report.arms) console.log(`  ${pad(a.label, 52)} ${String(a.n).padStart(5)} texts, median ${a.medianWords} words`);
console.log('\nlength bins (each arm contributes the same number):');
for (const b of report.bins) console.log(`  ${pad(b.bin + ' words', 14)} had ${b.had.join(' / ')} -> took ${b.take} from each`);

const cols = report.arms.map((a) => a.id);
console.log('\n' + pad('marker', 30) + cols.map((c) => pad(c, 20)).join('') + pad('placebo', 16) + 'verdict');
console.log('-'.repeat(30 + 20 * cols.length + 16 + 22));
for (const r of report.rows) {
  const placebo = `${r.placebo.a.pct.toFixed(1)}/${r.placebo.b.pct.toFixed(1)}${r.placebo.tie ? '' : ' !'}`;
  console.log(
    pad((r.belief ? '* ' : '') + r.label, 30) +
    cols.map((c) => pad(fmt(r.cells[c]), 20)).join('') +
    pad(placebo, 16) +
    r.verdict + (r.q !== null && r.q < 0.05 ? '' : r.verdict === 'machine marker' ? ' (q>=.05)' : ''),
  );
}
console.log(`\n* = a marker people are documented to judge by, rather than one anybody measured.`);
console.log(`${MARKERS.length} markers, ${report.rows.filter((r) => r.verdict === 'machine marker').length} of them separate the machine arm from careful human writing.`);
console.log(`placebo disagreements (should be none): ${report.rows.filter((r) => !r.placebo.tie).length}`);
console.log(`\nwrote data/markers.json`);
