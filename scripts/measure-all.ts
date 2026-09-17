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
 * from. Across kinds: data/summary.json, one cell per marker and kind with GPT-4's verdict against
 * the person (decided exactly as the page has always decided it) and "k of 4", how many of RAID's
 * four models the marker separates from the person in that kind. data/markers.json stays a copy of
 * the abstracts report for as long as the README links it.
 *
 * A local out/ is usually older than the collector. Point --data at a scratch directory there; only
 * the weekly job writes data/.
 */
import { writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { measure, type Arm, type Pairing, type Report, type Row } from '../src/measure.js';
import { MARKERS } from '../src/markers.js';
import { loadArms, DATA, genresToRun } from './arms.js';
import { GENRES, MODELS, MODEL_INFO, CASUAL, NOT_COVERED, DECODING, modelArm, type Genre, type Model } from './genres.js';

export type Verdict = Row['verdict'];
export interface ModelCell {
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
  /** GPT-4 against the person, as the page's table has it */
  verdict: Verdict;
  /** the corrected q behind a word's verdict; a whole-text verdict is decided on intervals and has none */
  q: number | null;
  placeboTie: boolean;
  unit: 'per 1000 words' | '% of texts';
  /** the numbers the verdict read: whole-arm rates, or the shares on GPT-4's document pairs */
  person: number | null;
  decider: number | null;
  /** texts behind a rate (GPT-4's arm), or document pairs behind a share */
  n: number;
  models: Partial<Record<Model, ModelCell>>;
  /**
   * How many models the marker separates from the person, in each direction, of how many could be
   * compared; `tooFew` counts the models left out of `of` because there was too little to compare.
   */
  k: { ai: number; person: number; of: number; tooFew: number };
}

/** below this, a comparison that separates nothing is "too few" rather than "no difference" */
export const MIN_EVIDENCE = 5;
/** and a property of the whole text needs at least this many document pairs */
export const MIN_PAIRS = 30;

export const K_RULE =
  'A model separates a marker from the person in a kind of writing when its own comparison with the person, decided by the same rules as the GPT-4 verdict, ' +
  'says "machine marker" (counted under ai) or "points the other way" (counted under person): for a word or phrase, the length-matched rate test survives ' +
  'Benjamini-Hochberg at 0.05 over that model\'s markers in that kind of writing, and the direction is read at the same lengths; for a property of the whole text, ' +
  'the 95% intervals of the shares on document pairs do not overlap. "of" counts the models that could be compared there: a model that does not separate the marker ' +
  `is left out of "of" and counted under tooFew when the comparison rests on too little, that is, a word used fewer than ${MIN_EVIDENCE} times by the person and the model together, ` +
  `or a property of the whole text on fewer than ${MIN_PAIRS} document pairs or with fewer than ${MIN_EVIDENCE} texts on its rarer side (with it, or without it) across both. ` +
  'The count describes; it is not a further test, and it is not corrected across the four models (each model\'s q and evidence are published next to it).';

/** which way a verdict separates the writer from the person, if it does */
export function separates(v: Verdict): 'ai' | 'person' | null {
  return v === 'machine marker' ? 'ai' : v === 'points the other way' ? 'person' : null;
}

/** what one model's comparison rested on, and whether that was too little (see K_RULE) */
export function evidenceOf(r: Row, person: string, arm: string): Pick<ModelCell, 'evidence' | 'tooFew'> {
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
 * One marker in one kind of writing. `perModel` holds each model's own report (the decider's is the
 * genre's full report), so every model's verdict comes from measure() itself and GPT-4's count agrees
 * with GPT-4's verdict by construction.
 */
export function summaryCell(genre: Genre, report: Report, perModel: Partial<Record<Model, Report>>, marker: string): SummaryCell {
  const row = report.rows.find((r) => r.marker === marker);
  if (!row) throw new Error(`${genre.id}: no row for ${marker}`);
  const models: SummaryCell['models'] = {};
  const k = { ai: 0, person: 0, of: 0, tooFew: 0 };
  for (const m of MODELS) {
    const r = perModel[m]?.rows.find((x) => x.marker === marker);
    const w = modelArm(genre, m);
    if (!r || !w) continue;
    const ev = evidenceOf(r, genre.reference, w.id);
    models[m] = { verdict: r.verdict, q: r.countable ? r.q : null, ...ev };
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
    models,
    k,
  };
}

export interface Measured { genre: Genre; report: Report; perModel: Partial<Record<Model, Report>> }

export function summarize(measured: Measured[], generatedAt = new Date().toISOString()) {
  const round = (x: number | null, digits: number): number | null => (x === null ? null : Number(x.toPrecision(digits)));
  return {
    generated_at: generatedAt,
    decider: 'gpt4' as const,
    models: MODELS.map((m) => ({ id: m, short: MODEL_INFO[m].short, snapshot: MODEL_INFO[m].snapshot })),
    decoding: DECODING,
    rules: {
      verdict: 'GPT-4 against the person in each kind of writing, decided as the page has always decided it: a word or phrase by the length-matched rate test after Benjamini-Hochberg over that kind\'s markers, a property of the whole text by non-overlapping 95% intervals on document pairs.',
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
      texts: Object.fromEntries(report.arms.map((a) => [a.id, a.n])),
      pairs: Object.fromEntries(report.arms.filter((a) => a.pairing === 'document').map((a) => [a.id, a.matchedWithReference])),
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
        const c = summaryCell(x.genre, x.report, x.perModel, mk.id);
        const models = Object.fromEntries(Object.entries(c.models).map(([m, v]) => [m, { ...v, q: round(v.q, 3) }]));
        return [x.genre.id, { ...c, q: round(c.q, 3), person: round(c.person, 4), decider: round(c.decider, 4), models }];
      })),
    })),
  };
}

/** measure one kind of writing: the full report against GPT-4, and each other model on its own */
export function measureGenre(genre: Genre, arms: Arm[] = loadArms(genre).map((x) => x.arm)): Measured | null {
  const has = (id: string): boolean => arms.some((a) => a.id === id);
  if (!has(genre.reference) || !has(genre.decider)) return null;
  const notRecorded = Object.keys(genre.notRecorded ?? {});
  const report = measure(arms, { reference: genre.reference, casual: CASUAL, machine: genre.decider, notRecorded });
  const perModel: Measured['perModel'] = {};
  for (const m of MODELS) {
    const w = modelArm(genre, m);
    if (!w || !has(w.id)) continue;
    if (w.id === genre.decider) { perModel[m] = report; continue; }
    // the other arms change nothing in this model's test, so only the three it reads are passed
    const own = arms.filter((a) => a.id === genre.reference || a.id === CASUAL || a.id === w.id);
    perModel[m] = measure(own, { reference: genre.reference, casual: CASUAL, machine: w.id, notRecorded });
  }
  return { genre, report, perModel };
}

const pad = (s: string, n: number): string => (s.length > n ? s.slice(0, n - 1) + '…' : s.padEnd(n));
const PAIRED: Record<Pairing, string> = {
  document: 'document pairs with the reference',
  length: 'length-matched with the reference',
  self: 'the reference itself',
};

function print({ genre, report, perModel }: Measured): void {
  console.log(`\n==== ${genre.label}: reference ${report.reference}, verdicts decided against ${report.machine}`);
  console.log('\narms:');
  for (const a of report.arms) {
    console.log(`  ${pad(a.label, 52)} ${String(a.n).padStart(5)} texts, ${String(a.matchedWithReference).padStart(4)} ${PAIRED[a.pairing]}, median ${a.medianWords} words`);
  }
  const cols = report.arms.map((a) => a.id);
  const head = (c: string): string => c.replace(/^(raid|posts)-/, '').replace('casual-human', 'casual').replace('careful-human', 'careful');

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

  console.log('\neach model against the person (a = machine marker, p = points the other way, r = register, . = no signal):');
  const code = (v: Verdict | undefined): string => (v === 'machine marker' ? 'a' : v === 'points the other way' ? 'p' : v === 'register marker' ? 'r' : v === 'not recorded' ? 'n' : v ? '.' : '-');
  console.log(pad('marker', 30) + MODELS.map((m) => pad(MODEL_INFO[m].short, 9)).join('') + 'k of n');
  for (const mk of MARKERS) {
    const c = summaryCell(genre, report, perModel, mk.id);
    console.log(pad(mk.label, 30) + MODELS.map((m) => pad(code(c.models[m]?.verdict), 9)).join('') + `${c.k.ai} ai, ${c.k.person} person, of ${c.k.of}${c.k.tooFew ? ` (${c.k.tooFew} too few)` : ''}`);
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
  writeFileSync(path.join(DATA, 'summary.json'), JSON.stringify(summarize(measured), null, 1) + '\n');
  console.log(`\n* = a marker people are documented to judge by, rather than one anybody measured.`);
  console.log(`wrote ${path.relative(process.cwd(), DATA) || '.'}/genres/*/markers.json, markers.json and summary.json`);
}
