/**
 * Builds the static site into docs/.
 *
 *   npx tsx scripts/build.ts [--data <dir>] [--docs <dir>] [--release]
 *
 * --release (the weekly job) also refuses data whose dating is missing or partial (releaseProblems).
 *
 * The page gets one small file for the headline grid, docs/data/summary.json, and one file per kind
 * of writing, docs/data/genres/<genre>.json, loaded only when that kind is opened. Both are made
 * from data/ with the numbers rounded. The bundle is the same src/markers.ts the measurement uses,
 * so a pasted text is counted by exactly the code that produced the table.
 *
 * The site must build from whatever data is committed. Before the weekly job has written the
 * per-genre layout (data/summary.json, data/genres/<genre>/), the abstracts are read from
 * data/markers.json and data/evidence.json, and the grid shows GPT-4's verdict without the count
 * across models, which only the new measurement has.
 *
 * The page's payload has a budget, and the build fails past it rather than letting the page grow
 * unnoticed: the summary at most 100 KB, each kind of writing at most 250 KB.
 */
import { build } from 'esbuild';
import { mkdirSync, copyFileSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import type { Report } from '../src/measure.js';
import { flag } from './arms.js';
import { GENRES, COMPARISON, MODELS, NOT_COVERED, decodingOf, genreById, modelArm, snapshotOf, testedWriters, type Genre, type Model } from './genres.js';
import type { Cell, Document } from './evidence.js';
import type { Cleaning } from './contamination.js';
import type { summarize, SummaryCell, WriterCell } from './measure-all.js';

export const BUDGET = { summary: 100 * 1024, genre: 250 * 1024 };

type Summary = ReturnType<typeof summarize>;
export interface Evidence { arms: Record<string, { we_per1000: number }>; markers: Record<string, { arms: Record<string, Cell> }>; documents: Document[] }
export interface CleaningDates {
  applied: string; complete?: boolean; excluded?: number; documents?: number; dated?: number; undated?: number;
  unmatched?: number; not_looked_up?: number; first_posted?: [string, string] | null; unmatched_by_lookup?: number | null; window?: [string, string];
}
export interface CleaningFile { dates?: CleaningDates; language?: { documents: number; excluded: number }; arms: Cleaning[] }

/**
 * Where the dating of a kind of writing stands, as the page words it: not a rule this kind has, not
 * applied yet (no lookup committed), partial (some documents not looked up), or applied. Without a
 * cleaning file the numbers were measured before the checks existed, and that is said too.
 */
export type Dating =
  | { status: 'none' }
  | { status: 'unchecked' }
  | { status: 'not applied' }
  | { status: 'partial' | 'applied'; documents: number; excluded: number; unmatched: number; notLookedUp: number; firstPosted: [string, string] | null };

export function datingOf(g: Genre, cleaning: CleaningFile | null): Dating {
  if (!g.datesFile) return { status: 'none' };
  const d = cleaning?.dates;
  if (!d) return { status: 'unchecked' };
  if (typeof d.excluded !== 'number') return { status: 'not applied' };
  const notLookedUp = d.not_looked_up ?? 0;
  return {
    status: d.complete === false || notLookedUp > 0 ? 'partial' : 'applied',
    documents: d.documents ?? 0, excluded: d.excluded, unmatched: d.unmatched ?? 0, notLookedUp, firstPosted: d.first_posted ?? null,
  };
}

const r2 = (x: number): number => Math.round(x * 100) / 100;
const r1 = (x: number): number => Math.round(x * 10) / 10;

/** what the page needs to know about a kind of writing, all of it from the registry */
export function genreInfo(g: Genre) {
  const decider = g.writers.find((w) => w.id === g.decider)!;
  return {
    id: g.id, label: g.label, inText: g.inText, noun: g.noun, prompt: g.prompt, reference: g.reference, decider: g.decider, deciderShort: decider.short,
    titles: g.titles, humanQuotable: g.humanQuotable, documents: g.documents, source: g.source, notRecorded: g.notRecorded ?? {},
    // the footnote the columns written here carry, where this kind has any; the page fills in which
    // columns they are and how much each wrote, and names no writer of its own (scripts/genres.ts)
    writtenHere: g.writtenHere ?? null,
    // where the columns are not one set of documents written again, and a kind's line after "Not
    // covered": both only where the registry has them, so the RAID kinds' pages carry nothing new
    ...(g.pairs ? { pairs: g.pairs } : {}),
    ...(g.covered ? { covered: g.covered } : {}),
  };
}

/** one kind of writing as the page reads it */
export function pageFor(g: Genre, report: Report, evidence: Evidence, cleaning: CleaningFile | null) {
  const present = new Set(report.arms.map((a) => a.id));
  const label = new Map(report.arms.map((a) => [a.id, a.label]));
  return {
    generated_at: report.generated_at,
    reference: report.reference,
    machine: report.machine,
    genre: genreInfo(g),
    writers: g.writers.filter((w) => present.has(w.id)).map((w) => ({ id: w.id, short: w.short, long: label.get(w.id) ?? w.label, quotable: w.quotable })),
    context: COMPARISON.filter((c) => present.has(c.id)).map((c) => ({ id: c.id, short: c.short, long: c.long, quotable: false })),
    arms: report.arms.map((a) => ({
      id: a.id, label: a.label, kind: a.kind, n: a.n, matched: a.matchedWithReference, pairing: a.pairing, medianWords: a.medianWords,
      publishable: g.writers.find((w) => w.id === a.id)?.quotable ?? false,
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
    // what was dropped before measuring, in numbers; the dropped ids stay in data/
    cleaning: cleaning && {
      dates: datingOf(g, cleaning),
      language: cleaning.language ? { documents: cleaning.language.documents, excluded: cleaning.language.excluded } : null,
      arms: cleaning.arms.map((a) => ({ arm: a.arm, texts: a.texts, dated: a.excluded_by_date, language: a.excluded_by_language ?? 0, truncated: a.truncated, meta: a.meta, remembered: a.remembered, unchecked: a.unchecked, kept: a.kept, reported: a.reported_only ?? null })),
    },
  };
}

type PageCell = Omit<SummaryCell, 'k' | 'writers'> & { k: SummaryCell['k'] | null; writers: SummaryCell['writers'] | null };

/**
 * One grid cell as data/summary.json has it. A summary written before the count ran over each kind's
 * own writers keyed its cells by RAID's model names ("gpt4") rather than by arm id, and carried no
 * `writers` at all. The registry says which arm of this kind each of those models wrote, so the
 * committed data still names its writers on the page until the next weekly measurement rewrites it.
 */
export function pageCell(g: Genre, s: SummaryCell): PageCell {
  if (s.writers) return s;
  const named = (s as { models?: Record<string, WriterCell> }).models ?? {};
  const writers: SummaryCell['writers'] = {};
  for (const [name, own] of Object.entries(named)) {
    const arm = MODELS.includes(name as Model) ? modelArm(g, name as Model) : undefined;
    if (arm) writers[arm.id] = own;
  }
  return { ...s, writers };
}

/**
 * The grid's data. From data/summary.json when the measurement wrote one; otherwise from the
 * genre reports alone, with each kind's decider's verdict and no count across writers.
 */
export function summaryFor(found: { genre: Genre; report: Report; cleaning?: CleaningFile | null }[], summary: Summary | null) {
  const measured = summary !== null;
  const byGenre = new Map(summary?.genres.map((g) => [g.id, g]) ?? []);
  const cell = (g: Genre, report: Report, marker: string): PageCell | null => {
    const s = summary?.rows.find((r) => r.marker === marker)?.genres[g.id];
    if (s) return pageCell(g, s as SummaryCell);
    const row = report.rows.find((r) => r.marker === marker);
    if (!row) return null;
    const d = g.decider;
    return {
      verdict: row.verdict, q: row.countable ? row.q : null, placeboTie: row.placebo.tie,
      unit: row.countable ? 'per 1000 words' : '% of texts',
      person: row.countable ? (row.rate[g.reference]?.per1000 ?? null) : (row.share[d]?.reference.pct ?? null),
      decider: row.countable ? (row.rate[d]?.per1000 ?? null) : (row.share[d]?.arm.pct ?? null),
      n: row.countable ? (row.rate[d]?.texts ?? 0) : (row.share[d]?.arm.n ?? 0),
      k: null, writers: null,
    };
  };
  const first = found[0]?.report;
  return {
    generated_at: summary?.generated_at ?? first?.generated_at ?? '',
    measured,
    k_rule: summary?.rules.k ?? null,
    not_covered: NOT_COVERED,
    genres: found.map(({ genre, report, cleaning }) => ({
      ...genreInfo(genre),
      // The writers this kind's count runs over, in the registry's order, and how many that is. The
      // page reads the count out of these: "k of 4" where RAID's four models wrote the same documents,
      // "k of 2" where two models answered one assignment, with nothing about four written into it.
      writers: testedWriters(genre).map((w) => ({ id: w.id, short: w.short, snapshot: snapshotOf(w) })),
      countOver: testedWriters(genre).length,
      // one decoding setting for every writer of this kind, where the corpus fixes one; otherwise null
      decoding: decodingOf(genre),
      dating: datingOf(genre, cleaning ?? null),
      file: `data/genres/${genre.id}.json`,
      texts: report.arms.find((a) => a.id === genre.reference)?.n ?? 0,
      placebo_disagreements: byGenre.get(genre.id)?.placebo_disagreements ?? report.rows.filter((r) => !r.placebo.tie).length,
    })),
    rows: (first?.rows ?? []).map((row) => ({
      marker: row.marker, label: row.label, family: row.family, belief: row.belief, countable: row.countable,
      genres: Object.fromEntries(found.flatMap(({ genre, report }) => {
        const c = cell(genre, report, row.marker);
        return c ? [[genre.id, c]] : [];
      })),
    })),
  };
}

const readJson = <T>(f: string): T => JSON.parse(readFileSync(f, 'utf8')) as T;

/**
 * The reports on disk, per kind of writing, in the registry's order: the per-genre layout first, the
 * old single-genre files for the abstracts otherwise.
 */
export function findGenres(data: string): { genre: Genre; report: Report; evidence: Evidence; cleaning: CleaningFile | null }[] {
  const out = [];
  for (const genre of GENRES) {
    const dir = path.join(data, 'genres', genre.id);
    const own = path.join(dir, 'markers.json');
    const markers = existsSync(own) ? own : genre.id === 'abstracts' ? path.join(data, 'markers.json') : '';
    if (!markers || !existsSync(markers)) continue;
    // only the old single-genre report takes the old evidence file: a genre's own report without its
    // own evidence is an error, never the abstracts' evidence
    const legacy = markers !== own;
    const evidence = legacy ? path.join(data, 'evidence.json') : path.join(dir, 'evidence.json');
    if (!existsSync(evidence)) throw new Error(`${genre.id}: ${markers} has no evidence file next to it; run scripts/evidence.ts`);
    const cleaning = path.join(dir, 'cleaning.json');
    out.push({ genre, report: readJson<Report>(markers), evidence: readJson<Evidence>(evidence), cleaning: existsSync(cleaning) ? readJson<CleaningFile>(cleaning) : null });
  }
  return out;
}

/** a size budget, as the error the build fails with */
export function overBudget(name: string, bytes: number, limit: number): string | null {
  return bytes > limit ? `${name} is ${Math.round(bytes / 1024)} KB, over its budget of ${Math.round(limit / 1024)} KB` : null;
}

/**
 * What stops a release: a kind of writing with a dating rule whose dating is not complete. The
 * weekly job builds with --release, so numbers measured without the dating, or with part of it, are
 * never published; a local build of the committed data still works as before.
 */
export function releaseProblems(found: { genre: Genre; cleaning: CleaningFile | null }[]): string[] {
  const out: string[] = [];
  for (const { genre, cleaning } of found) {
    const d = datingOf(genre, cleaning);
    if (d.status === 'none' || d.status === 'applied') continue;
    const why = d.status === 'partial'
      ? `the dating is partial (${d.notLookedUp} of ${d.documents} documents not looked up)`
      : d.status === 'not applied' ? `data/${genre.datesFile} was not there when it was measured` : 'it was measured without the cleaning checks';
    out.push(`${genre.id}: ${why}; run scripts/arxiv-dates.ts to the end and commit data/${genre.datesFile}`);
  }
  return out;
}

if (process.argv[1] && process.argv[1].endsWith('build.ts')) {
  const DATA = path.resolve(flag('--data') ?? 'data');
  const DOCS = path.resolve(flag('--docs') ?? 'docs');
  mkdirSync(path.join(DOCS, 'data', 'genres'), { recursive: true });

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

  const found = findGenres(DATA);
  if (!found.some((x) => x.genre.id === 'abstracts')) { console.error(`no abstracts report in ${DATA}`); process.exit(1); }
  if (process.argv.includes('--release')) {
    const problems = releaseProblems(found);
    if (problems.length) { for (const p of problems) console.error(`not releasable: ${p}`); process.exit(1); }
  }
  const summaryFile = path.join(DATA, 'summary.json');
  const summary = existsSync(summaryFile) ? readJson<Summary>(summaryFile) : null;
  for (const g of summary?.genres ?? []) {
    if (!found.some((x) => x.genre.id === g.id)) { console.error(`summary.json has ${g.id}, and ${DATA}/genres/${g.id}/markers.json is missing`); process.exit(1); }
    if (!genreById.has(g.id as Genre['id'])) { console.error(`summary.json has ${g.id}, which scripts/genres.ts does not know`); process.exit(1); }
  }

  const errors: string[] = [];
  const sizes: string[] = [];
  const write = (rel: string, body: unknown, limit: number): void => {
    const text = JSON.stringify(body);
    writeFileSync(path.join(DOCS, rel), text);
    const bytes = Buffer.byteLength(text);
    sizes.push(`${rel} ${Math.round(bytes / 1024)} KB`);
    const err = overBudget(rel, bytes, limit);
    if (err) errors.push(err);
  };
  write('data/summary.json', summaryFor(found, summary), BUDGET.summary);
  for (const x of found) {
    const page = pageFor(x.genre, x.report, x.evidence, x.cleaning);
    write(`data/genres/${x.genre.id}.json`, page, BUDGET.genre);
    // The single-genre file the page read before, written for one more release: a browser that still
    // holds the old app.js (GitHub Pages lets it keep it for ten minutes) asks for it, and the
    // abstracts page has every field that script reads. Remove it with the legacy branch of findGenres.
    if (x.genre.id === 'abstracts') write('data/page.json', page, BUDGET.genre);
  }

  const kb = (f: string): number => Math.round(readFileSync(path.join(DOCS, f)).length / 1024);
  console.log(`docs/app.js ${kb('app.js')} KB, ${sizes.join(', ')}${summary ? '' : ' (no data/summary.json yet: the grid has no count across models)'}`);
  if (errors.length) { for (const e of errors) console.error(e); process.exit(1); }
}
