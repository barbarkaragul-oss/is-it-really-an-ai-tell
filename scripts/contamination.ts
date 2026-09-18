/**
 * Did the model write this, or remember it? And did it finish?
 *
 *   npx tsx scripts/contamination.ts [--genres abstracts,posts] [--corpora out] [--data data] [--dates file]
 *
 * The arXiv dates are an input, like the generated Claude arm: they are read from the repository's
 * data/abstracts-dates.json whatever --data says (that is where the results go), or from --dates.
 * A missing or partial dating is measured with a warning here; the weekly job's build refuses to
 * publish it (scripts/build.ts --release).
 *
 * Every machine arm here is a model writing a document that exists in the world. Before a marker is
 * counted on a machine text, five things are checked, in this order, and every text that fails one
 * is dropped from its arm and counted in data/genres/<genre>/cleaning.json:
 *
 *  1. DATED. RAID's arXiv abstracts come from a 2023 snapshot, so a paper revised after ChatGPT may
 *     carry the revised text. A document with any arXiv version posted between 2022-11-30 and the
 *     date of RAID's file (data/abstracts-dates.json) is left out of every abstracts arm, the
 *     person's and the Claude arm's included. A version posted later cannot be the text RAID holds.
 *  2. NOT IN ENGLISH. A document is left out of every arm when any writer's text for it, the
 *     person's included, is in another language (src/clean.ts, isEnglish): 37 Reddit posts are.
 *     The markers are English patterns, and the models' texts in other languages mostly meet the
 *     length cap early and are dropped by check 3, while the person's stayed in every rate.
 *  3. CUT OFF. Some model texts stop mid-sentence at the generation limit (203 of 1,499 Llama chat
 *     abstracts did). A cut text has lost its ending, and every marker that lives in endings with it.
 *  4. NOT AN ANSWER. A refusal ("I couldn't find information on ..."), or a label, a preamble or a
 *     description ("Title:", "Here is a Reddit post", "The abstract would likely describe") is the
 *     model talking about the task, not writing it.
 *  5. REMEMBERED. Asked to write the abstract of a real paper, a model can reproduce the published
 *     one, and a reproduced abstract is human writing wearing a machine label. Each machine text is
 *     compared with the human text for the same document, by the share of its five-word sequences
 *     that also occur there; above the threshold it is treated as remembered.
 *
 * Checks 3 and 4 are src/clean.ts, and run on every RAID model arm of every kind of writing. They
 * never run on the person's text: a person's post may end without a full stop, and that is data.
 * The Claude arm was generated here with nothing discarded, so it is reported by checks 3 and 4 but
 * not cut by them, and its committed remembered_from_the_paper flags must agree with check 5 on the
 * documents that remain after checks 1 and 2.
 *
 * Every check runs on every arm, not only the ones suspected of it, because the point is to publish
 * the number rather than to defend a particular arm.
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { isTruncated, isMetaText, isEnglish, ENGLISH_FROM } from '../src/clean.js';
import { GENRES, type Genre, type Writer } from './genres.js';
import { OUT, DATA, cleanFile, genresToRun, flag } from './arms.js';

const THRESHOLD = 0.5;
/** ChatGPT's release, and the Last-Modified date of RAID's train_none.csv */
export const DATE_WINDOW: [string, string] = ['2022-11-30', '2024-06-04'];

export interface Row { id: string; text: string; group?: string }

/**
 * The arms written for this repository, read back out of their committed records.
 *
 * An arm nobody can re-download is only as good as the record that holds it, so the record is the
 * source and the measured file in out/ is written from it on every run: a reader who changes an essay
 * in data/generated sees the numbers move, and the weekly job measures these arms exactly as it
 * measures a downloaded one. One file per assignment, every essay carrying the slot it was asked for
 * and the assignment it answers -- the assignment travels as `group`, since these arms are paired
 * inside one assignment rather than document by document (src/measure.ts, pairByPrompt).
 */
export function generatedArm(dir: string, armId: string): Row[] {
  const files = readdirSync(dir).filter((f) => f.endsWith('.json') && f !== 'manifest.json').sort();
  const rows: Row[] = [];
  for (const f of files) {
    const file = JSON.parse(readFileSync(path.join(dir, f), 'utf8')) as { prompt_slug?: string; essays?: { slot: string; arm: string; text: string }[] };
    for (const e of file.essays ?? []) {
      if (e.arm !== armId || !e.text) continue;
      rows.push({ id: e.slot, text: e.text, ...(file.prompt_slug ? { group: file.prompt_slug } : {}) });
    }
  }
  return rows;
}

const sourceOf = (id: string): string => String(id).replace(/^raid:[a-z0-9.-]+:/, '');

/**
 * A text's words as the overlap checks compare them: lower case, with a curly apostrophe read as a
 * straight one. 41% of the people's Reddit posts type "don’t" and the models almost never do, so
 * splitting at "’" would hide from both checks a sequence the two sides share.
 */
export const gramWords = (text: string): string[] => text.toLowerCase().replace(/[’‘]/g, "'").match(/[a-z0-9']+/g) ?? [];

/** the set of five-word sequences in a text */
export function fiveGrams(text: string): Set<string> {
  const w = gramWords(text);
  const out = new Set<string>();
  for (let i = 0; i + 5 <= w.length; i++) out.add(w.slice(i, i + 5).join(' '));
  return out;
}

/** share of a's five-grams that also occur in b; 1 means a is contained in b */
export function containment(a: string, b: string): number {
  const A = fiveGrams(a), B = fiveGrams(b);
  if (!A.size) return 0;
  let hit = 0;
  for (const g of A) if (B.has(g)) hit++;
  return hit / A.size;
}

function load<T = Row>(name: string): T[] | null {
  const f = path.join(OUT, `${name}.json`);
  return existsSync(f) ? (JSON.parse(readFileSync(f, 'utf8')) as T[]) : null;
}

export interface ArmReport {
  arm: string;
  compared: number;
  /** texts whose human document is not in the corpus: they cannot be checked, so they are dropped */
  unchecked: number;
  mean: number;
  remembered: string[];
  worst: { id: string; containment: number }[];
}

/**
 * The people's five-word sequences, pooled per assignment, for a kind of writing where no machine text
 * has a person's text of its own to be compared with.
 *
 * Asked to write the abstract of a real paper, a model can give back the published one, and the check
 * that catches it compares the two texts of the same document. In the school essays there is no such
 * pair: a class answered an assignment and so did the models, so the question becomes whether a machine
 * essay repeats any of the essays the students wrote to that assignment. Pooling the assignment's
 * essays asks exactly that, and asks it of a much larger body of text than one document, so the
 * threshold is met more easily -- which is the safe direction for a check whose purpose is to catch
 * remembered text.
 */
export function poolFiveGrams(rows: Row[]): Map<string, Set<string>> {
  const pool = new Map<string, Set<string>>();
  for (const r of rows) {
    const key = r.group ?? '';
    let set = pool.get(key);
    if (!set) { set = new Set<string>(); pool.set(key, set); }
    for (const g of fiveGrams(r.text)) set.add(g);
  }
  return pool;
}

export function checkArm(rows: Row[], human: Map<string, string>, name: string, pool: Map<string, Set<string>> | null = null): { report: ArmReport; clean: Row[] } {
  let sum = 0, unchecked = 0;
  const scored: { row: Row; c: number }[] = [];
  for (const r of rows) {
    // against the assignment's pooled essays where the kind of writing has no document pairs, and
    // against this text's own document where it has
    const against = pool ? pool.get(r.group ?? '') : null;
    if (pool) {
      if (!against) { unchecked++; continue; }
      const grams = fiveGrams(r.text);
      let hit = 0;
      for (const g of grams) if (against.has(g)) hit++;
      const c = grams.size ? hit / grams.size : 0;
      sum += c;
      scored.push({ row: r, c });
      continue;
    }
    const h = human.get(sourceOf(r.id));
    if (!h) { unchecked++; continue; }
    const c = containment(r.text, h);
    sum += c;
    scored.push({ row: r, c });
  }
  return {
    report: {
      arm: name,
      compared: scored.length,
      unchecked,
      mean: scored.length ? sum / scored.length : 0,
      remembered: scored.filter((s) => s.c > THRESHOLD).map((s) => sourceOf(s.row.id)),
      worst: [...scored].sort((a, b) => b.c - a.c).slice(0, 3).map((s) => ({ id: sourceOf(s.row.id), containment: s.c })),
    },
    clean: scored.filter((s) => s.c <= THRESHOLD).map((s) => s.row),
  };
}

// ---- 1. dated abstracts

/**
 * data/abstracts-dates.json (scripts/arxiv-dates.ts), as far as this script relies on it: one entry
 * per RAID abstract, with its arXiv id (null when the lookup found no paper), its title and the date
 * of every version. `excluded` is the lookup's own verdict; the version dates are checked against it.
 * An entry carries a `source_id`, or is joined to the corpus by its title.
 */
export interface DatedEntry {
  source_id?: string;
  title?: string;
  arxiv_id?: string | null;
  versions?: (string | { v?: number; date: string })[];
  excluded?: boolean;
}
export interface DatesFile {
  window?: [string, string] | { from: string; to: string };
  documents: DatedEntry[];
  counts?: { unmatched?: number };
  /** false for a sample run; a file without the flag is taken at its word and checked against the corpus */
  complete?: boolean;
}

/**
 * A title as both sides can agree on it: accents gone whether typed or written in TeX (K\"ahler,
 * Me\v{s}trovi\'c), other TeX commands and math delimiters gone, punctuation folded to one space.
 */
export const titleKey = (t: string): string =>
  t.normalize('NFKD').replace(/\p{M}/gu, '')
    .replace(/\\(?:['"`^~=.]|[a-zA-Z](?![a-zA-Z]))\s*\{?([a-zA-Z])\}?/g, '$1')
    .replace(/\\[a-zA-Z]+/g, ' ')
    .replace(/[{}$\\]/g, '')
    .toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

/**
 * The documents to leave out of every arm because a writer's text for them is not in English. Every
 * writer's raw text counts, before any other check, so a document is out whichever side wrote the
 * other language.
 */
export function foreignDocuments(arms: Row[][]): Set<string> {
  const out = new Set<string>();
  for (const rows of arms) for (const r of rows) if (!isEnglish(r.text)) out.add(sourceOf(r.id));
  return out;
}

/** a version date as YYYY-MM-DD in UTC; arXiv writes "Tue, 25 Jul 2023 07:21:25 GMT" */
export function dayOf(d: string): string {
  if (/^\d{4}-\d{2}-\d{2}/.test(d)) return d.slice(0, 10);
  const t = Date.parse(d);
  if (Number.isNaN(t)) throw new Error(`unreadable version date "${d}" in the arXiv dates`);
  return new Date(t).toISOString().slice(0, 10);
}

export interface Dating {
  excluded: Set<string>;
  /** corpus documents the lookup matched to an arXiv paper */
  dated: number;
  /** corpus documents with no matched entry: kept, and counted (unmatched + notLookedUp) */
  undated: number;
  /** corpus documents the lookup looked for and matched to no paper */
  unmatched: number;
  /**
   * Corpus documents the file has no entry for: a partial lookup, or a corpus that grew after it.
   * They are kept, as "not excluded yet", and the page says how many there are.
   */
  notLookedUp: number;
  /** whether every corpus document was looked up, and the file does not call itself a sample */
  complete: boolean;
  /** the earliest and latest first-version date among the dated corpus documents */
  firstPosted: [string, string] | null;
  /** documents the lookup itself could not match, as it counts them over all its titles */
  unmatchedByLookup: number | null;
  /** entries whose written verdict disagrees with their own version dates */
  disagreements: string[];
  window: [string, string];
}

/**
 * Which of the corpus's documents the arXiv dates exclude. `titles` maps each source_id to its RAID
 * title, for entries that have no source_id.
 */
export function datedExclusions(file: DatesFile, corpus: Set<string>, titles: Map<string, string>): Dating {
  const w = file.window;
  const window: [string, string] = Array.isArray(w) ? w : w ? [w.from, w.to] : DATE_WINDOW;
  const byTitle = new Map<string, string[]>();
  for (const [id, t] of titles) {
    const k = titleKey(t);
    byTitle.set(k, [...(byTitle.get(k) ?? []), id]);
  }
  const excluded = new Set<string>();
  const seen = new Set<string>();
  const listed = new Set<string>();
  const first: string[] = [];
  const disagreements: string[] = [];
  for (const e of file.documents) {
    const ids = e.source_id ? [e.source_id] : e.title ? (byTitle.get(titleKey(e.title)) ?? []) : [];
    const days = (e.versions ?? []).map((v) => dayOf(typeof v === 'string' ? v : v.date));
    const inside = days.some((d) => d >= window[0] && d <= window[1]);
    const out = typeof e.excluded === 'boolean' ? e.excluded : inside;
    if (typeof e.excluded === 'boolean' && days.length && e.excluded !== inside) disagreements.push(e.arxiv_id ?? e.title ?? '?');
    // dated means a paper and its versions: a paper whose history arXiv did not give is undated
    const matched = e.arxiv_id !== null && days.length > 0;
    for (const id of ids) {
      if (!corpus.has(id)) continue;
      listed.add(id);
      if (matched) {
        seen.add(id);
        if (days.length) first.push([...days].sort()[0]!);
      }
      if (out) excluded.add(id);
    }
  }
  const notLookedUp = [...corpus].filter((id) => !listed.has(id)).length;
  first.sort();
  return {
    excluded, dated: seen.size, undated: [...corpus].filter((id) => !seen.has(id)).length,
    unmatched: [...listed].filter((id) => !seen.has(id)).length,
    notLookedUp,
    complete: file.complete !== false && notLookedUp === 0,
    firstPosted: first.length ? [first[0]!, first[first.length - 1]!] : null,
    unmatchedByLookup: file.counts?.unmatched ?? null,
    disagreements, window,
  };
}

// ---- 2-4. one arm

export interface Detectors { truncated: (text: string, model?: string) => boolean; meta: (text: string) => boolean }
export const SRC_CLEAN: Detectors = { truncated: isTruncated, meta: isMetaText };

export interface Cleaning {
  arm: string;
  writer: Writer['writer'];
  texts: number;
  excluded_by_date: number;
  /** documents left out because a writer's text for them is not in English (check 2) */
  excluded_by_language: number;
  /** null where the check does not run on this arm */
  truncated: number | null;
  meta: number | null;
  unchecked: number | null;
  remembered: number | null;
  mean_containment: number | null;
  kept: number;
  /** the Claude arm: what checks 2 and 3 would have dropped, reported and not applied */
  reported_only?: { truncated: number; meta: number };
  dropped?: { truncated: string[]; meta: string[]; remembered: string[] };
}

/**
 * One arm through checks 1 to 5. The person's arm goes through checks 1 and 2 only; a RAID model arm
 * through all five; the Claude arm through 1, 2 and 5, with 3 and 4 reported. A text is counted under
 * the first check that drops it, so the numbers add up to what was dropped. `foreign` is the
 * documents check 2 leaves out (foreignDocuments), decided over every writer before any arm is cleaned.
 */
export function cleanArm(rows: Row[], writer: Pick<Writer, 'id' | 'writer'>, human: Map<string, string>, excluded: Set<string>, detect: Detectors, foreign: Set<string> = new Set(), pool: Map<string, Set<string>> | null = null):
  { cleaning: Cleaning; clean: Row[]; report: ArmReport | null } {
  const inWindow = rows.filter((r) => !excluded.has(sourceOf(r.id)));
  const dated = inWindow.filter((r) => !foreign.has(sourceOf(r.id)));
  const base = { arm: writer.id, writer: writer.writer, texts: rows.length, excluded_by_date: rows.length - inWindow.length, excluded_by_language: inWindow.length - dated.length };
  if (writer.writer === 'human') {
    return { cleaning: { ...base, truncated: null, meta: null, unchecked: null, remembered: null, mean_containment: null, kept: dated.length }, clean: dated, report: null };
  }
  // the writer's own length cap decides what counts as cut off, and the arms written here have one of
  // their own (src/clean.ts CAP_FROM): before they were named there, "claude" fell through to the
  // lowest RAID threshold and every finished letter that ends on a signature read as cut off
  const model = writer.writer;
  const cut = new Set(dated.filter((r) => detect.truncated(r.text, model)));
  const talk = new Set(dated.filter((r) => !cut.has(r) && detect.meta(r.text)));
  const cleans = writer.writer !== 'claude';
  const rest = cleans ? dated.filter((r) => !cut.has(r) && !talk.has(r)) : dated;
  const ids = (xs: Set<Row>): string[] => [...xs].map((r) => sourceOf(r.id));
  const { report, clean } = checkArm(rest, human, writer.id, pool);
  return {
    cleaning: {
      ...base,
      truncated: cleans ? cut.size : null,
      meta: cleans ? talk.size : null,
      unchecked: report.unchecked,
      remembered: report.remembered.length,
      mean_containment: Math.round(report.mean * 10000) / 10000,
      kept: clean.length,
      ...(cleans ? {} : { reported_only: { truncated: cut.size, meta: talk.size } }),
      dropped: { truncated: cleans ? ids(cut) : [], meta: cleans ? ids(talk) : [], remembered: report.remembered },
    },
    clean,
    report,
  };
}

/**
 * The Claude arm lives in the repository, not in out/, because nobody can re-download it. It is
 * written out fresh from data/generated on every run so the weekly job measures it like the rest.
 */
export interface Generated { texts: { source_id: string; title?: string; text: string; remembered_from_the_paper: boolean }[] }

/**
 * Whether the committed remembered_from_the_paper flags and check 4 say the same thing, on the
 * documents check 1 left in. A document left out by date is not a disagreement: it was never checked.
 */
export function claudeAgrees(generated: Generated, report: ArmReport, excluded: Set<string>): { ok: boolean; flagged: string[]; found: string[] } {
  const flagged = generated.texts.filter((t) => t.remembered_from_the_paper && !excluded.has(t.source_id)).map((t) => t.source_id).sort();
  const found = [...report.remembered].sort();
  return { ok: report.unchecked === 0 && flagged.join() === found.join(), flagged, found };
}

const RULES = {
  order: 'Each text is counted under the first check that drops it: dated, then language, then truncated, then meta, then remembered.',
  dated: `Abstracts only, every arm: a document with any arXiv version posted between ${DATE_WINDOW[0]} and ${DATE_WINDOW[1]} (the Last-Modified date of RAID's train_none.csv) is left out. Documents the lookup could not date (no paper found, or no version history for the paper found) are kept and counted as unmatched, documents it has no entry for as not_looked_up; complete is false while any document is not looked up.`,
  language: `Every arm, the person's included: a document is left out when any writer's text for it is not in English, that is, when fewer than ${ENGLISH_FROM * 100}% of its words are common English function words (src/clean.ts, isEnglish).`,
  truncated: 'src/clean.ts isTruncated: a model text that stops before it is finished: inside a clause, in a loop, on a bare list marker, at a length the model\'s cap could have stopped it without a finished ending, or at that length inside a quotation or bracket it opened. RAID model arms only; never the person.',
  meta: 'src/clean.ts isMetaText: a refusal, a lecture, a preamble, a description of the text instead of the text, a label, a note to the requester, or a slot left to fill ("[Your Name]"), about the task instead of the text. A text with any of these is dropped whole, a slot in a sign-off included, since the rest was framed as a draft for someone else. RAID model arms only; never the person.',
  remembered: `More than ${THRESHOLD * 100}% of the text's five-word sequences also occur in the person's text for the same document. Every machine arm.`,
  unchecked: 'A machine text whose document the person\'s arm does not have cannot be checked, and is dropped.',
  claude: 'The Claude arm was generated here with nothing discarded: truncated and meta are reported for it, not applied.',
};

/**
 * The rules as a kind of writing's cleaning file states them. A kind paired by assignment is checked
 * differently in three places -- the five-word check reads the students' essays to the same assignment
 * rather than one document, a name slot under a letter's sign-off is not task talk (src/clean.ts,
 * SIGNATURE_TAIL), and its model arms are not RAID's -- and its file has to say what was done to it
 * rather than repeat the RAID wording. The two RAID kinds keep RULES as they are, so their files do
 * not change.
 */
export function rulesFor(genre: Pick<Genre, 'pairing'>): typeof RULES {
  if (genre.pairing !== 'prompt') return RULES;
  return {
    ...RULES,
    truncated: 'src/clean.ts isTruncated: a model text that stops before it is finished: inside a clause, in a loop, on a bare list marker, at a length the model\'s cap could have stopped it without a finished ending, or at that length inside a quotation or bracket it opened. Model arms only; never the person.',
    meta: 'src/clean.ts isMetaText: a refusal, a lecture, a preamble, a description of the text instead of the text, a label, a note to the requester, or a slot left to fill ("[Your Name]"), about the task instead of the text. A text with any of these is dropped whole, except that a slot on the lines after a letter\'s sign-off ("Sincerely," and then "[Your Name]") is where a letter puts a name, and a letter that ends that way is kept. Model arms only; never the person.',
    remembered: `More than ${THRESHOLD * 100}% of the text's five-word sequences also occur in the students' essays written to the same assignment, taken together: no machine essay has a student's essay of its own to be compared with. Every machine arm.`,
    unchecked: 'A machine essay written to an assignment the person\'s arm has no essays for cannot be checked, and is dropped.',
    claude: 'The Claude arms were generated here with nothing discarded: truncated and meta are reported for them, not applied.',
  };
}

function titlesFor(genre: Genre, generated: Generated | null): Map<string, string> {
  const titles = new Map<string, string>();
  const prompts = genre.prompts ? load<{ source_id: string; title?: string }>(genre.prompts) : null;
  for (const p of prompts ?? []) titles.set(String(p.source_id), String(p.title ?? ''));
  for (const t of generated?.texts ?? []) if (t.title && !titles.has(t.source_id)) titles.set(t.source_id, t.title);
  return titles;
}

function runGenre(genre: Genre): boolean {
  const person = genre.writers[0]!;
  const humanRows = load(person.raw);
  if (!humanRows) { console.error(`out/${person.raw}.json is missing; run the RAID collector first`); return false; }
  const corpus = new Set(humanRows.map((r) => sourceOf(r.id)));

  let generated: Generated | null = null;
  const claude = genre.writers.find((w) => w.writer === 'claude');
  if (claude && genre.generated && existsSync(path.resolve(genre.generated))) {
    generated = JSON.parse(readFileSync(path.resolve(genre.generated), 'utf8')) as Generated;
    writeFileSync(path.join(OUT, `${claude.raw}.json`), JSON.stringify(generated.texts.map((t) => ({ id: t.source_id, text: t.text }))));
  }

  // the arms written here: their records are the only copy, so the measured file is written from them
  // on every run, the same way the Claude abstracts arm above is
  for (const w of genre.writers) {
    if (!w.generated) continue;
    const dir = path.resolve(w.generated);
    if (!existsSync(dir)) { console.error(`  ${w.id}: ${w.generated} is missing; run the generation first`); continue; }
    const rows = generatedArm(dir, w.id);
    if (!rows.length) { console.error(`  ${w.id}: ${w.generated} holds no essay for this arm`); continue; }
    writeFileSync(path.join(OUT, `${w.raw}.json`), JSON.stringify(rows));
  }

  let ok = true;
  let dating: Dating | null = null;
  let datesNote = 'not applicable';
  if (genre.datesFile) {
    const f = path.resolve(flag('--dates') ?? path.join('data', genre.datesFile));
    const shown = path.relative(process.cwd(), f).split(path.sep).join('/');
    if (existsSync(f)) {
      const titles = titlesFor(genre, generated);
      const file = JSON.parse(readFileSync(f, 'utf8')) as DatesFile | DatedEntry[];
      const dates: DatesFile = Array.isArray(file) ? { documents: file } : file;
      if (dates.documents.some((e) => !e.source_id) && !titles.size) {
        console.error(`  ${genre.id}: ${genre.datesFile} joins by title, and out/${genre.prompts}.json with the titles is missing`);
        return false;
      }
      dating = datedExclusions(dates, corpus, titles);
      datesNote = `applied from ${shown}`;
      console.log(`${genre.id}: ${dating.excluded.size} of ${corpus.size} documents left out by arXiv version date (${dating.dated} dated, ${dating.unmatched} unmatched, ${dating.notLookedUp} not looked up)`);
      // a partial lookup is used for what it covers; the rest is kept and the page says how much
      if (!dating.complete) console.error(`  warning: ${genre.id}: the dating is partial${dates.complete === false ? ` (${genre.datesFile} calls itself incomplete)` : ''}; ${dating.notLookedUp} documents are not looked up and are kept`);
      if (dating.disagreements.length) console.error(`  warning: ${dating.disagreements.length} entries of ${genre.datesFile} are marked against their own version dates: ${dating.disagreements.slice(0, 5).join(', ')}`);
    } else {
      datesNote = `not applied: ${shown} does not exist yet`;
      console.error(`  warning: ${genre.id}: ${datesNote}`);
    }
  }
  const excluded = dating?.excluded ?? new Set<string>();

  // every writer's raw rows, read once: check 2 is decided over all of them before any arm is cleaned
  const rowsOf = new Map<Writer, Row[] | null>(genre.writers.map((w) => [w, w === person ? humanRows : load(w.raw)]));
  const foreign = foreignDocuments([...rowsOf.values()].filter((x): x is Row[] => x !== null));
  const foreignInCorpus = [...foreign].filter((id) => corpus.has(id) && !excluded.has(id));
  console.log(`${genre.id}: ${foreignInCorpus.length} of ${corpus.size} documents left out because a writer's text is not in English`);
  const out = new Set([...excluded, ...foreign]);

  const human = new Map(humanRows.filter((r) => !out.has(sourceOf(r.id))).map((r) => [sourceOf(r.id), r.text]));
  // no machine text here has a person's text of its own: check 5 asks whether it repeats any essay
  // the students wrote to the same assignment (poolFiveGrams)
  const pool = genre.pairing === 'prompt' ? poolFiveGrams(humanRows.filter((r) => !out.has(sourceOf(r.id)))) : null;
  console.log(`\n${genre.label}: five-gram containment against ${pool ? 'the person\'s texts to the same assignment' : 'the person\'s document'}, threshold ${THRESHOLD}\n`);
  console.log('arm'.padEnd(22) + 'texts'.padEnd(7) + 'dated'.padEnd(7) + 'lang'.padEnd(6) + 'cut'.padEnd(6) + 'meta'.padEnd(6) + 'uncheck'.padEnd(9) + 'mean'.padEnd(8) + 'remembered'.padEnd(12) + 'kept');
  console.log('-'.repeat(90));
  const cleanings: Cleaning[] = [];
  for (const w of genre.writers) {
    const rows = rowsOf.get(w) ?? null;
    if (!rows) {
      if (w.writer !== 'claude') { console.error(`  out/${w.raw}.json is missing`); ok = false; }
      continue;
    }
    const { cleaning, clean, report } = cleanArm(rows, w, human, excluded, SRC_CLEAN, foreign, pool);
    cleanings.push(cleaning);
    const n = (x: number | null): string => (x === null ? '-' : String(x));
    console.log(
      w.id.padEnd(22) + String(cleaning.texts).padEnd(7) + String(cleaning.excluded_by_date).padEnd(7) + String(cleaning.excluded_by_language).padEnd(6) +
      n(cleaning.truncated ?? cleaning.reported_only?.truncated ?? null).padEnd(6) + n(cleaning.meta ?? cleaning.reported_only?.meta ?? null).padEnd(6) +
      n(cleaning.unchecked).padEnd(9) + (cleaning.mean_containment === null ? '-' : `${(100 * cleaning.mean_containment).toFixed(1)}%`).padEnd(8) +
      n(cleaning.remembered).padEnd(12) + cleaning.kept +
      (cleaning.reported_only ? '   (cut and meta reported, not applied)' : ''),
    );
    // every arm is measured from its -clean file, so it is written even when nothing was dropped
    writeFileSync(path.join(OUT, `${cleanFile(w.raw)}.json`), JSON.stringify(clean));
    if (w.writer === 'claude' && generated && report) {
      // the flags in the committed file and this check must say the same thing
      const agree = claudeAgrees(generated, report, out);
      if (!agree.ok) {
        ok = false;
        console.error(`    the committed remembered_from_the_paper flags (${agree.flagged.length}) and this check (${agree.found.length}, ${report.unchecked} unchecked) disagree`);
      }
    }
  }

  const dir = path.join(DATA, 'genres', genre.id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, 'cleaning.json'), JSON.stringify({
    generated_at: new Date().toISOString(),
    genre: genre.id,
    rules: rulesFor(genre),
    dates: dating
      ? {
        applied: datesNote, complete: dating.complete, window: dating.window, documents: corpus.size, excluded: dating.excluded.size,
        dated: dating.dated, undated: dating.undated, unmatched: dating.unmatched, not_looked_up: dating.notLookedUp,
        first_posted: dating.firstPosted, unmatched_by_lookup: dating.unmatchedByLookup,
        marked_against_their_dates: dating.disagreements.length, excluded_ids: [...dating.excluded].sort(),
      }
      : { applied: datesNote },
    language: { threshold: ENGLISH_FROM, documents: corpus.size, excluded: foreignInCorpus.length, excluded_ids: foreignInCorpus.sort() },
    arms: cleanings,
  }, null, 1) + '\n');
  return ok;
}

if (process.argv[1] && process.argv[1].endsWith('contamination.ts')) {
  const { genres, missing } = genresToRun();
  if (missing.length) { console.error(`not collected: ${missing.join(', ')}`); process.exit(1); }
  let failed = false;
  for (const g of GENRES) {
    if (!genres.includes(g)) { console.log(`${g.label}: not collected, skipped`); continue; }
    if (!runGenre(g)) failed = true;
  }
  if (failed) process.exit(1);
  console.log('\nA text above the threshold is the published document, not a continuation of it, and any');
  console.log('marker counted there belongs to the person who wrote it.');
}
