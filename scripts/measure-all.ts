/**
 * Reads the corpora in out/, measures every kind of writing on its own, writes the numbers.
 *
 *   npx tsx collector/fetch.ts           # Hacker News, Stack Exchange, HC3
 *   npx tsx collector/fetch-raid.ts      # one document, several writers, per kind of writing
 *   npx tsx scripts/contamination.ts
 *   npx tsx scripts/measure-all.ts [--genres abstracts,posts] [--data <dir>]
 *
 * One measure() per kind of writing: its own person as the reference, its own models, and the
 * comparison columns every kind shares. The placebo splits that kind's own person, and the
 * Benjamini-Hochberg correction runs over that kind's markers, so adding a kind of writing does not
 * move the numbers of another.
 *
 * Written, per kind: data/genres/<genre>/markers.json, the full report the page's table is built
 * from. Across kinds: data/summary.json, one cell per marker and kind with that kind's decider
 * against the person (decided exactly as the page has always decided it) and "k of n", how many of
 * that kind's own tested writers the marker separates from the person there. n is whatever that kind
 * has: 4 where RAID's four models wrote the same documents, 2 where two models answered one
 * assignment. Each kind therefore publishes the writers it counts over, so the page never has to
 * guess at four. data/markers.json stays a copy of the abstracts report for as long as the README
 * links it.
 *
 * A local out/ is usually older than the collector. Point --data at a scratch directory there; only
 * the weekly job writes data/.
 */
import { writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { measure, type Arm, type Pairing, type Report, type Row } from '../src/measure.js';
import { MARKERS } from '../src/markers.js';
import { loadArms, DATA, genresToRun } from './arms.js';
import { GENRES, CASUAL, NOT_COVERED, decodingOf, snapshotOf, testedWriters, type Genre } from './genres.js';

export type Verdict = Row['verdict'];
export interface WriterCell {
  verdict: Verdict;
  q: number | null;
  /**
   * What the comparison rested on: for a word, its occurrences in the person's arm and the model's
   * together; for a property of the whole text, the document pairs and how many texts on the smaller
   * side of the property (with it, or without it) the two sides hold between them.
   */
  evidence: { occurrences: number } | { pairs: number; minority: number };
  /** too little to compare: not separated, and resting on fewer than MIN_EVIDENCE (see K_RULE) */
  tooFew: boolean;
}
export interface SummaryCell {
  /** the kind's decider against the person, as the page's table has it */
  verdict: Verdict;
  /** the corrected q behind a word's verdict; a whole-text verdict is decided on intervals and has none */
  q: number | null;
  placeboTie: boolean;
  unit: 'per 1000 words' | '% of texts';
  /** the numbers the verdict read: whole-arm rates, or the shares on the decider's document pairs */
  person: number | null;
  decider: number | null;
  /** texts behind a rate (the decider's arm), or document pairs behind a share */
  n: number;
  /**
   * One cell per writer this kind counts across, by arm id rather than by a model name: a kind counts
   * over its own writers (scripts/genres.ts, testedWriters), and two kinds can hold arms written by the
   * same model. The genre's `writers` in the summary says which arms these are and what to call them.
   */
  writers: Record<string, WriterCell>;
  /**
   * How many writers the marker separates from the person, in each direction, of how many could be
   * compared; `tooFew` counts the writers left out of `of` because there was too little to compare.
   */
  k: { ai: number; person: number; of: number; tooFew: number };
}

/** below this, a comparison that separates nothing is "too few" rather than "no difference" */
export const MIN_EVIDENCE = 5;
/** and a property of the whole text needs at least this many document pairs */
export const MIN_PAIRS = 30;

export const K_RULE =
  'The count runs over the writers a kind of writing has, never over a fixed number: the writers it measures against the person, which the genre publishes beside its numbers. ' +
  'A writer separates a marker from the person in a kind of writing when its own comparison with the person, decided by the same rules as that kind\'s own verdict, ' +
  'says "machine marker" (counted under ai) or "points the other way" (counted under person): for a word or phrase, the length-matched rate test survives ' +
  'Benjamini-Hochberg at 0.05 over that writer\'s markers in that kind of writing, and the direction is read at the same lengths; for a property of the whole text, ' +
  'the 95% intervals of the shares on the kind\'s pairs do not overlap (document pairs, or, where the writers answered one assignment, assignment pairs). "of" counts the writers that could be compared there: a writer that does not separate the marker ' +
  `is left out of "of" and counted under tooFew when the comparison rests on too little, that is, a word used fewer than ${MIN_EVIDENCE} times by the person and that writer together, ` +
  `or a property of the whole text on fewer than ${MIN_PAIRS} pairs or with fewer than ${MIN_EVIDENCE} texts on its rarer side (with it, or without it) across both. ` +
  'The count describes; it is not a further test, and it is not corrected across the writers (each writer\'s q and evidence are published next to it).';

/** which way a verdict separates the writer from the person, if it does */
export function separates(v: Verdict): 'ai' | 'person' | null {
  return v === 'machine marker' ? 'ai' : v === 'points the other way' ? 'person' : null;
}

/** what one writer's comparison rested on, and whether that was too little (see K_RULE) */
export function evidenceOf(r: Row, person: string, arm: string): Pick<WriterCell, 'evidence' | 'tooFew'> {
  if (r.countable) {
    const occurrences = (r.rate[person]?.occurrences ?? 0) + (r.rate[arm]?.occurrences ?? 0);
    return { evidence: { occurrences }, tooFew: !separates(r.verdict) && occurrences < MIN_EVIDENCE };
  }
  const s = r.share[arm];
  const pairs = s?.arm.n ?? 0;
  const carrying = (s?.arm.k ?? 0) + (s?.reference.k ?? 0);
  const minority = Math.min(carrying, 2 * pairs - carrying);
  return { evidence: { pairs, minority }, tooFew: !separates(r.verdict) && (pairs < MIN_PAIRS || minority < MIN_EVIDENCE) };
}

/**
 * One marker in one kind of writing. `perWriter` holds each counted writer's own report (the
 * decider's is the genre's full report), so every writer's verdict comes from measure() itself and the
 * decider's count agrees with the published verdict by construction. The loop runs over the genre's
 * tested writers, which is what makes "of" 4 in a kind RAID's four models wrote and 2 in a kind two
 * models wrote: nothing here knows how many there are supposed to be.
 */
export function summaryCell(genre: Genre, report: Report, perWriter: Record<string, Report>, marker: string): SummaryCell {
  const row = report.rows.find((r) => r.marker === marker);
  if (!row) throw new Error(`${genre.id}: no row for ${marker}`);
  const writers: SummaryCell['writers'] = {};
  const k = { ai: 0, person: 0, of: 0, tooFew: 0 };
  for (const w of testedWriters(genre)) {
    const r = perWriter[w.id]?.rows.find((x) => x.marker === marker);
    if (!r) continue;
    const ev = evidenceOf(r, genre.reference, w.id);
    writers[w.id] = { verdict: r.verdict, q: r.countable ? r.q : null, ...ev };
    if (r.verdict === 'not recorded') continue;
    if (ev.tooFew) { k.tooFew++; continue; }
    k.of++;
    const side = separates(r.verdict);
    if (side) k[side]++;
  }
  const d = genre.decider, p = genre.reference;
  const rate = row.countable;
  return {
    verdict: row.verdict,
    q: rate ? row.q : null,
    placeboTie: row.placebo.tie,
    unit: rate ? 'per 1000 words' : '% of texts',
    person: rate ? (row.rate[p]?.per1000 ?? null) : (row.share[d]?.reference.pct ?? null),
    decider: rate ? (row.rate[d]?.per1000 ?? null) : (row.share[d]?.arm.pct ?? null),
    n: rate ? (row.rate[d]?.texts ?? 0) : (row.share[d]?.arm.n ?? 0),
    writers,
    k,
  };
}

/** a kind of writing measured: the report against its decider, and each counted writer's own report by arm id */
export interface Measured { genre: Genre; report: Report; perWriter: Record<string, Report> }

export function summarize(measured: Measured[], generatedAt = new Date().toISOString()) {
  const round = (x: number | null, digits: number): number | null => (x === null ? null : Number(x.toPrecision(digits)));
  return {
    generated_at: generatedAt,
    rules: {
      verdict: 'Each kind of writing\'s own decider against the person, decided as the page has always decided it: a word or phrase by the length-matched rate test after Benjamini-Hochberg over that kind\'s markers, a property of the whole text by non-overlapping 95% intervals on that kind\'s pairs: document pairs, or assignment pairs where the writers answered one assignment rather than rewrote one document.',
      k: K_RULE,
      placebo: 'Each kind of writing splits its own person\'s texts at random and runs the same tests on both halves; placebo_disagreements counts the rows where the halves differ.',
      correction: 'Benjamini-Hochberg runs within one kind of writing and one model, never across kinds, so adding a kind of writing leaves the others\' numbers alone.',
      not_recorded: 'A marker that a kind of writing cannot show in anyone\'s text (scripts/genres.ts, notRecorded) is "not recorded" there: it gets no test, stays out of the correction, and is not counted in "of".',
    },
    not_covered: NOT_COVERED,
    genres: measured.map(({ genre, report }) => ({
      id: genre.id,
      label: genre.label,
      reference: genre.reference,
      decider: genre.decider,
      decider_short: genre.writers.find((w) => w.id === genre.decider)?.short ?? genre.decider,
      // the writers "k of n" runs over here, in the registry's order, and how many that is: a reader of
      // this file, and the page built from it, is told the n rather than left to count a fixed four
      writers: testedWriters(genre).map((w) => ({ id: w.id, short: w.short, snapshot: snapshotOf(w) })),
      count_over: testedWriters(genre).length,
      // one decoding setting for every writer of this kind, where the corpus fixes one; otherwise null,
      // and each arm's own settings are recorded with the text it wrote
      decoding: decodingOf(genre),
      texts: Object.fromEntries(report.arms.map((a) => [a.id, a.n])),
      // the arms whose texts are paired with a person's rather than merely drawn to the same lengths:
      // document for document, or, where a class and a model answered one assignment, pair for pair
      pairs: Object.fromEntries(report.arms.filter((a) => a.pairing === 'document' || a.pairing === 'prompt').map((a) => [a.id, a.matchedWithReference])),
      placebo_disagreements: report.rows.filter((r) => !r.placebo.tie).length,
      not_recorded: genre.notRecorded ?? {},
    })),
    rows: MARKERS.map((mk) => ({
      marker: mk.id,
      label: mk.label,
      family: mk.family,
      belief: mk.belief === true,
      countable: mk.count !== undefined,
      genres: Object.fromEntries(measured.map((x) => {
        const c = summaryCell(x.genre, x.report, x.perWriter, mk.id);
        const writers = Object.fromEntries(Object.entries(c.writers).map(([id, v]) => [id, { ...v, q: round(v.q, 3) }]));
        return [x.genre.id, { ...c, q: round(c.q, 3), person: round(c.person, 4), decider: round(c.decider, 4), writers }];
      })),
    })),
  };
}

/** measure one kind of writing: the full report against its decider, and each other counted writer on its own */
export function measureGenre(genre: Genre, arms: Arm[] = loadArms(genre).map((x) => x.arm)): Measured | null {
  const has = (id: string): boolean => arms.some((a) => a.id === id);
  if (!has(genre.reference) || !has(genre.decider)) return null;
  const notRecorded = Object.keys(genre.notRecorded ?? {});
  // how this kind of writing pairs a machine arm with the person and how much of the person its
  // placebo splits, passed through from the registry: nothing in an arm could tell measure() that two
  // writers were given one assignment rather than one document (scripts/genres.ts, pairing, placebo)
  const how = {
    notRecorded,
    ...(genre.pairing ? { pairing: genre.pairing } : {}),
    ...(genre.placebo ? { placebo: genre.placebo } : {}),
  };
  const report = measure(arms, { reference: genre.reference, casual: CASUAL, machine: genre.decider, ...how });
  const perWriter: Measured['perWriter'] = {};
  for (const w of testedWriters(genre)) {
    if (!has(w.id)) continue;
    if (w.id === genre.decider) { perWriter[w.id] = report; continue; }
    // the other arms change nothing in this writer's test, so only the three it reads are passed
    const own = arms.filter((a) => a.id === genre.reference || a.id === CASUAL || a.id === w.id);
    perWriter[w.id] = measure(own, { reference: genre.reference, casual: CASUAL, machine: w.id, ...how });
  }
  return { genre, report, perWriter };
}

const pad = (s: string, n: number): string => (s.length > n ? s.slice(0, n - 1) + '…' : s.padEnd(n));
const PAIRED: Record<Pairing, string> = {
  document: 'document pairs with the reference',
  prompt: 'assignment pairs with the reference',
  length: 'length-matched with the reference',
  self: 'the reference itself',
};

function print({ genre, report, perWriter }: Measured): void {
  console.log(`\n==== ${genre.label}: reference ${report.reference}, verdicts decided against ${report.machine}`);
  console.log('\narms:');
  for (const a of report.arms) {
    console.log(`  ${pad(a.label, 52)} ${String(a.n).padStart(5)} texts, ${String(a.matchedWithReference).padStart(4)} ${PAIRED[a.pairing]}, median ${a.medianWords} words`);
  }
  const cols = report.arms.map((a) => a.id);
  // console only: an arm id without the prefix that says which kind of writing it belongs to
  const head = (c: string): string => c.replace(/^(raid|posts|essays)-/, '').replace('casual-human', 'casual').replace('careful-human', 'careful');

  console.log('\nshare of texts carrying the marker (each arm on its pairing with the reference; texts a marker cannot judge left out):');
  console.log(pad('marker', 30) + cols.map((c) => pad(head(c), 14)).join('') + pad('placebo', 13) + 'verdict');
  for (const r of report.rows) {
    const placebo = r.countable ? '' : `${r.placebo.a.pct.toFixed(1)}/${r.placebo.b.pct.toFixed(1)}${r.placebo.tie ? '' : ' !'}`;
    console.log(pad((r.belief ? '* ' : '') + r.label, 30) + cols.map((c) => pad(r.share[c] ? `${r.share[c]!.arm.pct.toFixed(1)}%` : '-', 14)).join('') + pad(placebo, 13) + (r.countable ? '(by rate, below)' : r.verdict));
  }

  console.log('\noccurrences per thousand words (whole arm; q and verdict compare texts of the same length):');
  console.log(pad('marker', 30) + cols.map((c) => pad(head(c), 14)).join('') + pad('placebo', 13) + pad('q', 10) + 'verdict');
  for (const r of report.rows.filter((x) => x.countable)) {
    const placebo = `${r.placebo.rate.a.per1000.toFixed(2)}/${r.placebo.rate.b.per1000.toFixed(2)}${r.placebo.tie ? '' : ' !'}`;
    console.log(pad(r.label, 30) + cols.map((c) => {
      const x = r.rate[c];
      return pad(x && x.occurrences ? `${x.per1000.toFixed(2)} (${x.occurrences})` : '.', 14);
    }).join('') + pad(placebo, 13) + pad(r.q === null ? '-' : r.q < 0.001 ? '<0.001' : r.q.toFixed(3), 10) + r.verdict);
  }

  // the writers this kind counts across, which is what "of n" is counted out of: never a fixed four
  const counted = testedWriters(genre);
  console.log(`\neach writer against the person, of the ${counted.length} this kind counts (a = machine marker, p = points the other way, r = register, . = no signal):`);
  const code = (v: Verdict | undefined): string => (v === 'machine marker' ? 'a' : v === 'points the other way' ? 'p' : v === 'register marker' ? 'r' : v === 'not recorded' ? 'n' : v ? '.' : '-');
  console.log(pad('marker', 30) + counted.map((w) => pad(w.short, 9)).join('') + 'k of n');
  for (const mk of MARKERS) {
    const c = summaryCell(genre, report, perWriter, mk.id);
    console.log(pad(mk.label, 30) + counted.map((w) => pad(code(c.writers[w.id]?.verdict), 9)).join('') + `${c.k.ai} ai, ${c.k.person} person, of ${c.k.of}${c.k.tooFew ? ` (${c.k.tooFew} too few)` : ''}`);
  }
  const count = (v: Verdict): number => report.rows.filter((r) => r.verdict === v).length;
  console.log(`\n${MARKERS.length} markers; ${count('machine marker')} separate ${report.machine} from ${report.reference}, ${count('register marker')} mark register, ${count('points the other way')} point the other way.`);
  console.log(`placebo disagreements (should be none): ${report.rows.filter((r) => !r.placebo.tie).length}`);
}

if (process.argv[1] && process.argv[1].endsWith('measure-all.ts')) {
  const { genres, missing } = genresToRun();
  if (missing.length) { console.error(`not collected: ${missing.join(', ')}; run the collectors first`); process.exit(1); }
  const measured: Measured[] = [];
  for (const g of GENRES) {
    if (!genres.includes(g)) { console.log(`${g.label}: not collected, skipped`); continue; }
    const m = measureGenre(g);
    if (!m) { console.error(`${g.label}: the person or ${g.decider} is missing from out/; run scripts/contamination.ts`); process.exit(1); }
    measured.push(m);
    print(m);
    const dir = path.join(DATA, 'genres', g.id);
    mkdirSync(dir, { recursive: true });
    const body = JSON.stringify({ ...m.report, genre: g.id }, null, 1) + '\n';
    writeFileSync(path.join(dir, 'markers.json'), body);
    // the README still links the abstracts report at its old path
    if (g.id === 'abstracts') writeFileSync(path.join(DATA, 'markers.json'), body);
  }
  mkdirSync(DATA, { recursive: true });
  // The summary is rebuilt from the kinds measured in this run and replaces the one on disk: a run for
  // one kind (--genres essays) leaves a summary, and so a grid, with that kind alone in it. The weekly
  // job runs every kind, which is what data/summary.json has to hold; a partial run belongs in a
  // scratch directory (--data), never in data/.
  writeFileSync(path.join(DATA, 'summary.json'), JSON.stringify(summarize(measured), null, 1) + '\n');
  console.log(`\n* = a marker people are documented to judge by, rather than one anybody measured.`);
  console.log(`wrote ${path.relative(process.cwd(), DATA) || '.'}/genres/*/markers.json, markers.json and summary.json`);
}
