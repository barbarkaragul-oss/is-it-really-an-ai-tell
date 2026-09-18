/**
 * The people's side of the essays: PERSUADE 2.0, read once and published as counts.
 *
 *   npx tsx scripts/collect-essays.ts            read the corpus and write the arm and the committed files
 *   npx tsx scripts/collect-essays.ts --check    read it again and fail if the committed frame disagrees
 *
 * PERSUADE 2.0 (Crossley et al., 2024) is argumentative writing by American students in grades 6-12,
 * collected by the testing providers that set the assignments and published for the Feedback Prize
 * competition about a year before ChatGPT. Every essay comes with the assignment the class was given,
 * which is the teacher's words rather than a student's, so the machine arms of this genre can be given
 * the same assignment without any person's essay ever entering a prompt.
 *
 * What this script keeps and what it never keeps:
 *  - The essays themselves are read into out/essays-human.json, which is not committed, and the CSVs
 *    stay in cache/persuade/, which is not committed either. No essay text, and no part of one, is
 *    written to data/ or printed. The person's arm of this genre is not quotable anywhere.
 *  - What is committed is three files of counts: the frame (one row per eligible essay, with a hash of
 *    its text but not the text), the seven assignments verbatim, and a census of the typography and of
 *    every marker in the catalogue, so the decisions the page has to make about this genre -- which
 *    markers it cannot record, what the sample actually is -- are made from published numbers.
 *
 * Only the independent prompts are used. The source-based prompts hand the class a reading passage
 * that the corpus does not distribute, so no other writer could be given what the student read.
 * "Phones and driving" is dropped as well: its grade_level is blank in every row, and this genre
 * publishes the grade of every essay.
 *
 * The three CSVs are a mirror of the essay-level file. They are pinned here by size and SHA-256, and a
 * file that does not match them is refused rather than read, because every count below and every row
 * of the frame is a statement about those exact bytes.
 *
 * What the mirror drops, and where it is read back from. The mirror does not carry the corpus's
 * `competition_set` and `provider` columns. Both are restored from data/genres/essays/kaggle-2021.json,
 * a committed list built from the official 616 MB annotation-level file (one row per discourse element,
 * 173,266 rows for 15,594 essays, which is why it is that large and why it is not the file measured
 * here): it names every independent essay
 * that was released in the Kaggle Feedback Prize competition of December 2021, with the testing
 * provider that set its assignment. An essay is joined to that list by the SHA-256 of its `full_text`
 * rather than by its id, because a spreadsheet damaged some ids on the way into the mirror, and only
 * essays on the list are kept. That is what lets this genre say "this essay was in a public
 * competition release in December 2021" instead of "the corpus was published before ChatGPT": the
 * first is a fact about the essay being measured, the second only about the file it came from.
 *
 * The frame holds one short row per kept essay -- id, grade, provider, words, bin, and 16 hex of the
 * hash -- because there is one row for every essay rather than for a sample, and a megabyte of rows
 * nobody can read is not evidence. 16 hex is 64 bits: enough that no two of these essays collide, and
 * enough for --check to name the essay whose text moved. The full text is nowhere in this directory.
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { CsvRows, Host } from '../collector/raid-csv.js';
import { plainText } from '../collector/fetch.js';
import { isEnglish } from '../src/clean.js';
import { MARKERS, byId, words } from '../src/markers.js';
import { BINS, binOfWords, rate, share, type Text } from '../src/measure.js';
import { DATA, OUT, flag } from './arms.js';

export const GENRE = 'essays';
export const ARM = 'essays-human';

/** the corpus, as the page and the committed files name it */
export const CORPUS = 'PERSUADE 2.0';
export const CITATION = 'PERSUADE 2.0 corpus (Crossley et al., 2024)';
export const LICENCE = 'CC BY-NC-SA 4.0';
export const LICENCE_URL = 'https://creativecommons.org/licenses/by-nc-sa/4.0/';
export const CORPUS_HOME = 'https://github.com/scrosseye/persuade_corpus_2.0';
export const ATTRIBUTION = `Assignments and essay metadata from the ${CITATION}, ${CORPUS_HOME}, used under ${LICENCE} (${LICENCE_URL}). No student essay is reproduced here.`;

/**
 * The three splits of the essay-level file, pinned. The mirror is one Hugging Face repository with the
 * corpus already split; the splits together are the whole corpus, so all three are read and the split
 * a row came from is not recorded anywhere -- it is an artefact of the mirror, not of the writing.
 */
export interface SourceCsv { name: string; bytes: number; sha256: string }
export const SOURCE_FILES: SourceCsv[] = [
  { name: 'train.csv', bytes: 59568406, sha256: 'f028f673c836ab880a5d8b51371b2fd98aa07d1e11a0eeae64a495fb8356ed8b' },
  { name: 'validation.csv', bytes: 17056666, sha256: 'd2c9e60e332e2ffef245104c24688baab07c7927b69ff6b2261c15c2a6ddaf98' },
  { name: 'test.csv', bytes: 8359124, sha256: 'aa93f6ec4a5eaa9f374770639d872ce777aff4175c28f8fd2497008d71504ff2' },
];
export const sourceUrl = (name: string): string => `https://huggingface.co/datasets/nlpatunt/D_persuade_2/resolve/main/${name}`;
export const MIRROR = 'https://huggingface.co/datasets/nlpatunt/D_persuade_2';

/** the file's columns, in order, as the pinned bytes have them; a different header is a different file */
export const COLUMNS = [
  'essay_id_comp', 'full_text', 'holistic_essay_score', 'word_count', 'prompt_name', 'task', 'assignment', 'source_text',
  'gender', 'grade_level', 'ell_status', 'race_ethnicity', 'economically_disadvantaged', 'student_disability_status',
  'prompt_url', 'gpt4_summary', 'scoring_rubric_url',
] as const;
/** the columns this script reads; the rest are the writer's demographics, which this project does not use */
const WANTED = ['essay_id_comp', 'full_text', 'word_count', 'prompt_name', 'task', 'assignment', 'grade_level'] as const;
type Row = Record<(typeof WANTED)[number], string>;

/**
 * The seven independent prompts, with the slug each one has in an id and a file name. The registry in
 * scripts/genres.ts will name the genre; the prompts live here until it does, because they are a
 * property of the corpus rather than of the page.
 */
export interface EssayPrompt { slug: string; name: string }
export const PROMPTS: EssayPrompt[] = [
  { slug: 'distance-learning', name: 'Distance learning' },
  { slug: 'summer-projects', name: 'Summer projects' },
  { slug: 'mandatory-extracurricular-activities', name: 'Mandatory extracurricular activities' },
  { slug: 'cell-phones-at-school', name: 'Cell phones at school' },
  { slug: 'grades-for-extracurricular-activities', name: 'Grades for extracurricular activities' },
  { slug: 'seeking-multiple-opinions', name: 'Seeking multiple opinions' },
  { slug: 'community-service', name: 'Community service' },
];
const slugOf = new Map(PROMPTS.map((p) => [p.name, p.slug]));
/** the eighth independent prompt, left out: its grade_level is blank in all 1,168 of its rows */
export const EXCLUDED_PROMPT = 'Phones and driving';

/** several assignments ask for a letter to the principal rather than an essay; the page has to say so */
export const asksForALetter = (assignment: string): boolean => /\bwrite a letter\b/i.test(assignment);

/**
 * The length bins the pairing uses, imported from src/measure.ts rather than copied: an essay outside
 * every bin can never be paired with a machine essay, whatever the pairing does, and the frame says
 * which bin each essay is in so that is visible. A second copy of the numbers here would go quietly
 * out of date the day those move, and every row of the frame would then say the wrong bin. The bin
 * follows the marker word count (src/markers.ts, words), which counts runs of letters, so it differs
 * by a few from a whitespace count; both are published per essay.
 */
/** the word count the eligibility filter uses, and the one the frame publishes as `words` */
export const whitespaceWords = (t: string): number => (t.trim().match(/\S+/g) ?? []).length;
export const MIN_WORDS = BINS[0]![0];
export const MAX_WORDS = BINS[BINS.length - 1]![1];

// ---- anonymisation placeholders

/**
 * PERSUADE replaces the names, addresses and dates a student wrote with a token naming what stood
 * there: "Generic_Name", "STUDENT_NAME", "SCHOOL_NAME", "STREET_ADDRESS". They are the corpus's words,
 * not the writer's, and they are capitalised compounds no model would write, so they are taken out
 * before anything is counted.
 *
 * Which tokens exist is not assumed. Every token with an underscore in it whose first part is
 * capitalised or all capitals is scanned out of the whole corpus and marked removed or left alone. The
 * census names the removed ones with their counts; the ones left alone are the writer's own text, so
 * they are counted there but not named. The scan starts after a lower-case letter as well, because
 * three of them reached the file stuck to the word in front ("andGeneric_Name"); it does not start
 * after a capital, a digit or an underscore, which is what keeps it out of the middle of the tracking
 * codes some essays paste in.
 */
const SCAN = /(?<![A-Z0-9_])(?:[A-Z][A-Za-z0-9]*|[A-Z0-9]+)(?:_[A-Za-z0-9]+)+(?![A-Za-z0-9_])/g;
/**
 * The words the scheme's tokens are made of: not a guess, but every word that appears in the tokens
 * the scan finds in this corpus, with the plurals it uses and the three misspellings that reached the
 * published file ("Genric_Name", "Generric_School", "PROEPR_NAME"). A token that begins with two or
 * more of these words is the corpus speaking; anything else is the writer, however it is capitalised,
 * so the scan's pasted links and the heading one student typed in capitals above their essay
 * ("COMMUNITY_SERVICE", "Distracted_Driving") are left where they are. Case is ignored, since the
 * corpus writes the same token in three casings ("Generic_Name", "GENERIC_NAME", "Generic_name").
 */
const PLACEHOLDER_WORDS = new Set([
  'GENERIC', 'GENRIC', 'GENERRIC', 'PROPER', 'PROEPR', 'STUDENT', 'TEACHER', 'RELATIVE', 'OTHER', 'LOCATION',
  'NAMES', 'NAME', 'SCHOOLS', 'SCHOOL', 'CITY', 'STATE', 'STREET', 'ADDRESS', 'EMAIL', 'PHONE', 'NUMBER',
  'ZIP', 'CODE', 'MONTH', 'DAY', 'YEAR', 'HOTEL', 'TEST', 'COURSE', 'LAST',
]);

/**
 * The placeholder a scanned token begins with, and whatever is left of the token after it, or null
 * when the token is not one. The rest matters: a few tokens are stuck to the word that follows them
 * ("TEACHER_NAMEif you", "SCHOOL_NAMEto"), and taking the whole token would delete that word too.
 */
export function splitPlaceholder(token: string): { placeholder: string; rest: string } | null {
  const parts = token.split('_');
  let used = 0, chars = 0;
  for (const part of parts) {
    if (PLACEHOLDER_WORDS.has(part.toUpperCase())) { used++; chars += (used > 1 ? 1 : 0) + part.length; continue; }
    // the placeholder with a word stuck to its end: the lower-case tail is the writer's, not the corpus's
    const upper = part.toUpperCase();
    const word = [...PLACEHOLDER_WORDS].filter((w) => upper.startsWith(w) && /^[a-z]+$/.test(part.slice(w.length)))
      .sort((a, b) => b.length - a.length)[0];
    if (word) { used++; chars += (used > 1 ? 1 : 0) + word.length; }
    break;
  }
  if (used < 2) return null;
  return { placeholder: token.slice(0, chars), rest: token.slice(chars) };
}

/** whether a scanned token is one of the corpus's placeholders, decided exactly as the removal decides it */
export const isPlaceholder = (token: string): boolean => splitPlaceholder(token) !== null;

/**
 * The text with its placeholders taken out and the gap they left closed up. What was stuck to a
 * placeholder is kept when it is a word ("TEACHER_NAMEif" leaves "if") and dropped when it is a single
 * letter, which is the annotation's own slip rather than anything the student typed. Only spaces are
 * tidied: the punctuation around a removed name ("Dear STUDENT_NAME,") is the writer's and stays.
 */
export function stripPlaceholders(text: string): { text: string; removed: number } {
  let removed = 0;
  const out = text.replace(SCAN, (token) => {
    const split = splitPlaceholder(token);
    if (!split) return token;
    removed++;
    return split.rest.length >= 2 ? split.rest : '';
  });
  if (!removed) return { text, removed };
  return { text: out.replace(/[^\S\n]{2,}/g, ' ').split('\n').map((l) => l.trim()).join('\n').trim(), removed };
}

/**
 * An essay as the markers read it: the corpus's field with its entities decoded, its runs of spaces and
 * its non-breaking spaces squeezed, its blank lines kept as paragraph breaks (collector/fetch.ts,
 * plainText), and its anonymisation placeholders removed. The wrapped lines other collectors join are
 * not joined here: these essays were typed into a box, not wrapped by a tool, and all but one of the
 * 24,910 essays with a line break in them break between paragraphs.
 */
export function measuredText(fullText: string): { text: string; placeholders: number } {
  const { text, removed } = stripPlaceholders(plainText(fullText));
  return { text, placeholders: removed };
}

// ---- reading the corpus

const sha256 = (data: string | Uint8Array): string => createHash('sha256').update(data).digest('hex');

/**
 * One CSV, read whole and handed out row by row. The parser is collector/raid-csv.ts: the same RFC 4180
 * reader the RAID collector uses, strict about stray quotes and short rows, which is what catches a
 * file that is not the one pinned above. The header must be the pinned columns, in order.
 */
export function readCsv(bytes: Uint8Array, onRow: (row: Row) => void): number {
  const at = WANTED.map((c) => [c, COLUMNS.indexOf(c)] as const);
  let seenHeader = false;
  let rows = 0;
  const parser = new CsvRows(0, (fields) => {
    if (!seenHeader) {
      seenHeader = true;
      if (fields.length !== COLUMNS.length || COLUMNS.some((c, i) => fields[i] !== c)) {
        throw new Error(`the file's columns are ${fields.join(',')}, expected ${COLUMNS.join(',')}`);
      }
      return;
    }
    if (fields.length !== COLUMNS.length) throw new Error(`a row has ${fields.length} fields, the file has ${COLUMNS.length} columns`);
    const row = {} as Record<string, string>;
    for (const [c, i] of at) row[c] = fields[i]!;
    rows++;
    onRow(row as Row);
  });
  parser.push(bytes);
  parser.finish();
  return rows;
}

/**
 * The pinned file, from cache/persuade/ or from the mirror. A file already there is never downloaded
 * again; whichever way it arrives, its size and SHA-256 must be the pinned ones, and a download is
 * written under another name and moved into place so a broken one cannot look like a cached one.
 */
export async function ensureCsv(f: SourceCsv, dir: string, host: Host): Promise<{ bytes: Uint8Array; downloaded: boolean }> {
  const file = path.join(dir, f.name);
  let downloaded = false;
  if (!existsSync(file)) {
    mkdirSync(dir, { recursive: true });
    const url = sourceUrl(f.name);
    host.log(`  downloading ${url} (${(f.bytes / 1e6).toFixed(1)} MB)`);
    const r = await host.request(url, { headers: {} });
    if (r.status !== 200) throw new Error(`${url} answered ${r.status} ${r.statusText}`);
    // tens of megabytes: small enough to hold once, and the file is verified before it is used
    const body = new Uint8Array(await r.arrayBuffer());
    const part = `${file}.part`;
    writeFileSync(part, body);
    renameSync(part, file);
    downloaded = true;
  }
  const size = statSync(file).size;
  const bytes = new Uint8Array(readFileSync(file));
  const digest = sha256(bytes);
  if (size !== f.bytes || digest !== f.sha256) {
    if (downloaded) rmSync(file, { force: true });
    throw new Error(
      `${file} is not the file this script was written against: ${size} bytes and SHA-256 ${digest}, expected ${f.bytes} and ${f.sha256}. ` +
      'Every count in data/genres/essays/ is a statement about those bytes, so the pins in scripts/collect-essays.ts have to be measured again for a new file.',
    );
  }
  return { bytes, downloaded };
}

// ---- the Kaggle 2021 release list

/** the committed list, and the release it records */
export const KAGGLE_FILE = 'kaggle-2021.json';
export const KAGGLE_RELEASE = 'the Kaggle Feedback Prize competition of December 2021';

/**
 * data/genres/essays/kaggle-2021.json: one entry per independent PERSUADE essay that carries
 * `competition_set=train` in the official file, that is, that was released in that competition. The
 * key is the first 16 hex of the SHA-256 of the essay's `full_text` as the official file stores it,
 * and the value is the testing provider. The file's own `note` records where it was built from and is
 * copied into the frame, so a reader who only has the frame still knows what the list is.
 */
export interface KaggleList { note: string; key: string; count: number; providers: Record<string, number>; essays: Record<string, string> }
export interface Kaggle { file: string; note: string; key: string; listed: number; providers: Record<string, number>; of: Map<string, string> }

/**
 * The list, read and checked against itself. The count and the provider tally are in the file as
 * written, so a file whose entries no longer match them has been edited by hand rather than rebuilt,
 * and every number in this directory would then be about a list nobody can reproduce.
 */
export function readKaggleList(file: string): Kaggle {
  const list = JSON.parse(readFileSync(file, 'utf8')) as KaggleList;
  const of = new Map(Object.entries(list.essays ?? {}));
  if (!of.size) throw new Error(`${file}: no essays; this file names the essays released in ${KAGGLE_RELEASE}`);
  if (list.count !== of.size) throw new Error(`${file}: says count ${list.count} and holds ${of.size} essays`);
  const providers: Record<string, number> = {};
  for (const p of of.values()) providers[p] = (providers[p] ?? 0) + 1;
  for (const [p, n] of Object.entries(list.providers ?? {})) {
    if (providers[p] !== n) throw new Error(`${file}: says ${n} essays from ${p} and holds ${providers[p] ?? 0}`);
  }
  return { file, note: list.note, key: list.key, listed: of.size, providers, of };
}

/**
 * The key an essay is looked up by: the hash of the corpus's field exactly as the CSV stores it,
 * before plainText and before the placeholders come out. The list was built from the official file's
 * bytes, so anything done to the text here would look the essay up under a hash nobody else has.
 */
export const textKey = (fullText: string): string => sha256(fullText).slice(0, 16);

// ---- the filter

/** one step of the eligibility filter, with what it left and what it took */
export interface Step { step: string; rule: string; kept: number; dropped: number }

/** an eligible essay, with everything the frame, the arm and the census need */
export interface Essay {
  id: string;
  prompt: string;
  name: string;
  grade: number;
  /** the testing provider that set the assignment and collected the essay, from the Kaggle 2021 list */
  provider: string;
  text: string;
  /** whitespace words of the measured text: the count the filter used */
  words: number;
  /** the marker word count (src/markers.ts), which the length bin follows */
  binWords: number;
  bin: number;
  sha256: string;
  placeholders: number;
}

export interface Corpus {
  files: { name: string; url: string; bytes: number; sha256: string; rows: number }[];
  rows: number;
  steps: Step[];
  essays: Essay[];
  /** the Kaggle 2021 release list this run was filtered against */
  kaggle: Omit<Kaggle, 'of'>;
  /** the corpus's own word_count column against a whitespace count of the same field */
  wordCountColumn: { rows: number; disagrees: number };
  /** every placeholder-shaped token in the corpus, with what was done about it */
  tokens: { token: string; corpus: number; eligible: number; removed: boolean }[];
  assignments: { slug: string; name: string; text: string }[];
  /** per prompt, on the base the word filter was applied to: how many essays it dropped for being too long */
  over: Map<string, { base: number; dropped: number }>;
  /** essays whose word count changed when the text was normalised and the placeholders removed */
  cleaned: { changedWordCount: number; outsideWordRange: number; outsidePairingBins: number };
}

/**
 * The corpus, filtered. The steps run in this order and each one publishes what it took:
 * the independent prompts, minus "Phones and driving", with a grade, of a length the pairing can
 * reach, in English, not a repeat of an essay already kept, and on the Kaggle 2021 release list. The
 * word count is computed here because the corpus's own word_count column disagrees with the field it
 * describes in most rows.
 */
export async function collect(cacheDir: string, kaggleFile: string, log: (line: string) => void): Promise<Corpus> {
  const kaggle = readKaggleList(kaggleFile);
  const host = new Host({ log });
  const files: Corpus['files'] = [];
  const rows: Row[] = [];
  const tokens = new Map<string, { corpus: number; eligible: number }>();
  let all = 0, wrongColumn = 0;
  const counted = { independent: 0, prompt: 0, grade: 0 };

  for (const f of SOURCE_FILES) {
    const { bytes, downloaded } = await ensureCsv(f, cacheDir, host);
    const n = readCsv(bytes, (row) => {
      all++;
      if (whitespaceWords(row.full_text) !== Number(row.word_count)) wrongColumn++;
      for (const t of row.full_text.match(SCAN) ?? []) {
        const seen = tokens.get(t) ?? { corpus: 0, eligible: 0 };
        seen.corpus++;
        tokens.set(t, seen);
      }
      // the cheap steps first, so only the rows that survive them are held in memory with their text
      if (row.task !== 'Independent') return;
      counted.independent++;
      if (row.prompt_name === EXCLUDED_PROMPT) return;
      counted.prompt++;
      if (!row.grade_level.trim()) return;
      counted.grade++;
      rows.push(row);
    });
    files.push({ name: f.name, url: sourceUrl(f.name), bytes: f.bytes, sha256: f.sha256, rows: n });
    log(`  ${f.name}: ${n} rows${downloaded ? ' (downloaded)' : ''}`);
  }

  const steps: Step[] = [
    { step: 'independent', rule: "task === 'Independent': the source-based prompts hand the class a reading passage the corpus does not distribute", kept: counted.independent, dropped: all - counted.independent },
    { step: 'prompt', rule: `prompt_name !== '${EXCLUDED_PROMPT}': that prompt's grade_level is blank in every row`, kept: counted.prompt, dropped: counted.independent - counted.prompt },
    { step: 'grade', rule: 'grade_level present: this genre publishes the grade of every essay', kept: counted.grade, dropped: counted.prompt - counted.grade },
  ];

  // length, on the field as the corpus has it: the pairing bins reach 80 to 800 words and nothing else
  const over = new Map<string, { base: number; dropped: number }>();
  for (const r of rows) {
    const e = over.get(r.prompt_name) ?? { base: 0, dropped: 0 };
    e.base++;
    if (whitespaceWords(r.full_text) > MAX_WORDS) e.dropped++;
    over.set(r.prompt_name, e);
  }
  const sized = rows.filter((r) => { const w = whitespaceWords(r.full_text); return w >= MIN_WORDS && w <= MAX_WORDS; });
  steps.push({ step: 'length', rule: `${MIN_WORDS} to ${MAX_WORDS} whitespace words, computed here: the length bins the pairing uses (src/measure.ts) reach no further, and the corpus's word_count column disagrees with its own full_text in ${wrongColumn} of ${all} rows`, kept: sized.length, dropped: rows.length - sized.length });

  const english = sized.filter((r) => isEnglish(r.full_text));
  steps.push({ step: 'english', rule: 'src/clean.ts isEnglish: at least 12% of the words are common English function words, as every other arm is held to', kept: english.length, dropped: sized.length - english.length });

  const seen = new Set<string>();
  const unique = english.filter((r) => { if (seen.has(r.full_text)) return false; seen.add(r.full_text); return true; });
  steps.push({ step: 'unique', rule: 'no essay whose full_text a kept essay already has', kept: unique.length, dropped: english.length - unique.length });

  // the dating step, and the last one: an essay is kept only if the official file says it was released
  // in the 2021 competition. What this buys is a date for the essay rather than for the corpus, which
  // is the only form of "written before ChatGPT" a reader can check one document at a time.
  const released = unique.filter((r) => kaggle.of.has(textKey(r.full_text)));
  steps.push({
    step: 'kaggle-2021',
    rule: `on the list in data/genres/${GENRE}/${KAGGLE_FILE}: the essay's full_text, hashed as the CSV stores it, is one of the ${kaggle.listed} independent essays released in ${KAGGLE_RELEASE}`,
    kept: released.length, dropped: unique.length - released.length,
  });

  const cleaned = { changedWordCount: 0, outsideWordRange: 0, outsidePairingBins: 0 };
  const essays: Essay[] = released.map((r) => {
    const { text, placeholders } = measuredText(r.full_text);
    const slug = slugOf.get(r.prompt_name);
    if (!slug) throw new Error(`no slug for the prompt "${r.prompt_name}"; scripts/collect-essays.ts lists ${PROMPTS.length}`);
    const grade = Number(r.grade_level);
    if (!Number.isInteger(grade) || grade < 1 || grade > 12) throw new Error(`essay ${r.essay_id_comp}: grade_level is ${JSON.stringify(r.grade_level)}`);
    const w = whitespaceWords(text), bw = words(text).length;
    if (w !== whitespaceWords(r.full_text)) cleaned.changedWordCount++;
    if (w < MIN_WORDS || w > MAX_WORDS) cleaned.outsideWordRange++;
    const bin = binOfWords(bw);
    if (bin < 0) cleaned.outsidePairingBins++;
    for (const t of r.full_text.match(SCAN) ?? []) {
      const e = tokens.get(t)!;
      e.eligible++;
    }
    const provider = kaggle.of.get(textKey(r.full_text))!;
    return { id: `${GENRE}:${slug}:${r.essay_id_comp}`, prompt: slug, name: r.prompt_name, grade, provider, text, words: w, binWords: bw, bin, sha256: sha256(text), placeholders };
  });

  const ids = new Set(essays.map((e) => e.id));
  if (ids.size !== essays.length) {
    const once = new Set<string>(), twice = new Set<string>();
    for (const e of essays) (once.has(e.id) ? twice : once).add(e.id);
    throw new Error(`${essays.length - ids.size} essay ids are not unique, for example ${[...twice].slice(0, 3).join(', ')}`);
  }

  // one assignment per prompt: the corpus repeats the same string in every row of a prompt, and a
  // second one would mean the machine arms were given two different tasks under one name
  const assignments: Corpus['assignments'] = [];
  for (const p of PROMPTS) {
    const texts = new Set(released.filter((r) => r.prompt_name === p.name).map((r) => r.assignment));
    if (texts.size !== 1) throw new Error(`"${p.name}" has ${texts.size} distinct assignment strings, expected one`);
    assignments.push({ slug: p.slug, name: p.name, text: [...texts][0]! });
  }

  return {
    files, rows: all, steps, essays,
    kaggle: { file: kaggle.file, note: kaggle.note, key: kaggle.key, listed: kaggle.listed, providers: kaggle.providers },
    wordCountColumn: { rows: all, disagrees: wrongColumn },
    tokens: [...tokens].map(([token, c]) => ({ token, corpus: c.corpus, eligible: c.eligible, removed: isPlaceholder(token) }))
      .sort((a, b) => b.corpus - a.corpus || (a.token < b.token ? -1 : 1)),
    assignments, over, cleaned,
  };
}

// ---- what the three committed files say

const pct = (k: number, n: number): number => (n ? Number(((100 * k) / n).toFixed(2)) : 0);
const tallyBy = <T>(items: T[], key: (x: T) => string | number): Record<string, number> => {
  const out: Record<string, number> = {};
  for (const i of items) { const k = String(key(i)); out[k] = (out[k] ?? 0) + 1; }
  return out;
};
const median = (xs: number[]): number => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length ? s[Math.floor(s.length / 2)]! : 0;
};

export interface PromptRow {
  slug: string; name: string; essays: number; grades: Record<string, number>; modal_grade: number | null;
  providers: Record<string, number>;
  letter: boolean; words: { median: number; min: number; max: number }; over_800: { base: number; dropped: number; share: number };
}

/**
 * Per prompt: how many essays, whose grades, which providers collected them, how long they are, and
 * whether the class was asked for a letter. The providers are here and not only in the totals because
 * a prompt is usually one provider's: a difference this page finds between prompts may be a difference
 * between the states and the grades those providers test, and a reader cannot see that from a total.
 */
export function promptRows(c: Corpus): PromptRow[] {
  return PROMPTS.map((p) => {
    const mine = c.essays.filter((e) => e.prompt === p.slug);
    const grades = tallyBy(mine, (e) => e.grade);
    const modal = Object.entries(grades).sort((a, b) => b[1] - a[1])[0];
    const over = c.over.get(p.name) ?? { base: 0, dropped: 0 };
    const assignment = c.assignments.find((a) => a.slug === p.slug)!.text;
    return {
      slug: p.slug, name: p.name, essays: mine.length, grades, modal_grade: modal ? Number(modal[0]) : null,
      providers: tallyBy(mine, (e) => e.provider),
      letter: asksForALetter(assignment),
      words: { median: median(mine.map((e) => e.words)), min: Math.min(...mine.map((e) => e.words)), max: Math.max(...mine.map((e) => e.words)) },
      over_800: { base: over.base, dropped: over.dropped, share: pct(over.dropped, over.base) },
    };
  });
}

/**
 * One row per essay on its own line, as data/abstracts-dates.json is written: a re-read's diff then
 * shows which essays changed rather than one line of a megabyte.
 */
function serialize(meta: Record<string, unknown>, key: string, rows: unknown[]): string {
  const head = JSON.stringify(meta, null, 1).replace(/\n}$/, '');
  return `${head},\n ${JSON.stringify(key)}: [\n${rows.map((r) => `  ${JSON.stringify(r)}`).join(',\n')}\n ]\n}\n`;
}

/**
 * One row per kept essay, as short as it can be and still say what the essay is. The prompt is not a
 * field: it is already the middle of the id, and repeating it cost a quarter of the file. The marker
 * word count is not a field either -- `bin` is what the pairing uses it for, and the count itself is
 * published per prompt and per arm elsewhere. `sha256` is the first 16 hex of the measured text's
 * hash, which is what --check compares; it is not the key into kaggle-2021.json, which hashes the
 * corpus's field before this project touches it.
 */
export interface FrameRow { id: string; grade: number; provider: string; words: number; bin: number; sha256: string }
export const frameRows = (c: Corpus): FrameRow[] =>
  c.essays.map((e) => ({ id: e.id, grade: e.grade, provider: e.provider, words: e.words, bin: e.bin, sha256: e.sha256.slice(0, 16) }));

export function frame(c: Corpus, at: string): string {
  // the dating step, read back rather than recomputed, so the summary and the step table cannot differ
  const kaggleStep = c.steps.find((s) => s.step === 'kaggle-2021');
  // whether the provider is anything but another name for the prompt, measured rather than assumed
  const mixedProviders = promptRows(c).filter((p) => Object.keys(p.providers).length > 1);
  const touched = c.essays.filter((e) => e.placeholders > 0);
  const grades = [...new Set(c.essays.map((e) => e.grade))].sort((a, b) => a - b);
  const top = Object.entries(tallyBy(c.essays, (e) => e.grade)).sort((a, b) => b[1] - a[1])[0];
  const meta = {
    generated_at: at,
    genre: GENRE,
    arm: ARM,
    about: 'One row per kept essay: its id, the grade it was written in, the testing provider that collected it, how long it is, its length bin, and 16 hex of the SHA-256 of the text this project measures -- but never the text. The prompt is the middle of the id. The essays stay in cache/persuade/ and out/, neither of which is committed, and this project does not quote them anywhere.',
    licence: `${CITATION}, ${LICENCE}`,
    licence_url: LICENCE_URL,
    source: { corpus: CORPUS, home: CORPUS_HOME, read_from: MIRROR, columns: [...COLUMNS], rows: c.rows, files: c.files },
    dating: {
      per_document: true,
      claim: `Every essay in this file was published in ${KAGGLE_RELEASE}, about eleven months before ChatGPT. That is a `
        + 'statement about each essay rather than about the corpus it came from, which is the only form of "written before '
        + 'ChatGPT" a reader can check one document at a time.',
      list: {
        file: `data/genres/${GENRE}/${KAGGLE_FILE}`,
        essays: c.kaggle.listed,
        key: c.kaggle.key,
        providers: c.kaggle.providers,
        note: c.kaggle.note,
      },
      kept: kaggleStep?.kept ?? 0,
      not_on_the_list: kaggleStep?.dropped ?? 0,
      note: `${kaggleStep?.dropped ?? 0} essays that pass every other step are not on that list, and they are not measured `
        + 'here at all: they are in the corpus, and a reader who counts the corpus will find more independent essays than this '
        + 'file holds. They are left out because nothing dates them one by one, not because anything is wrong with them.',
      joined_by: 'The mirror read here drops the corpus\'s competition_set and provider columns -- the 17 columns these files '
        + 'hold are listed above -- so both are taken from the committed list, which was built from the official '
        + 'annotation-level file, one row per discourse element rather than per essay. An essay is joined to the list by the '
        + 'SHA-256 of its full_text as the CSV stores it, before this project '
        + 'normalises anything, because a spreadsheet damaged some ids on the way into the mirror. The per-row sha256 below is '
        + 'a different hash: it is of the measured text.',
      official_file: CORPUS_HOME,
    },
    text: {
      normalised: 'collector/fetch.ts plainText: entities decoded, runs of spaces and non-breaking spaces squeezed to one, blank lines kept as paragraph breaks. The wrapped lines other collectors join are not joined: these essays were typed, not wrapped.',
      placeholders: 'The corpus replaces the names, schools, addresses and dates a student wrote with tokens such as Generic_Name and STUDENT_NAME. They are removed before anything is counted, and the space they leave is closed up; census.json lists every such token the corpus holds, with its count, and counts the other tokens of the same shape, which were left to the writer, without listing them, since those are the students\' own words and links.',
      sha256: 'the first 16 hex of the SHA-256 of the measured text, UTF-8: what out/essays-human.json holds and what the markers read. 16 hex is 64 bits, which no two essays of this size collide in, and it is what --check compares a later run against.',
      words: 'whitespace words of the measured text. bin is the index into [80-129, 130-219, 220-399, 400-800] of the marker word count (src/markers.ts, words), which counts runs of letters and so differs from `words` by a few; -1 means no bin, so the essay can be measured but never paired.',
    },
    eligibility: {
      order: 'Each essay is counted under the first step that drops it: independent prompt, then the excluded prompt, then a missing grade, then length, then language, then a repeated essay, then an essay the 2021 release list does not name.',
      steps: c.steps,
      note: 'Every eligible essay is kept: there is no sample and no shuffle here, so nothing in this file depends on a seed.',
    },
    word_count_column: {
      ...c.wordCountColumn,
      share: pct(c.wordCountColumn.disagrees, c.wordCountColumn.rows),
      note: "The corpus's word_count column disagrees with a whitespace count of its own full_text in most rows, so the length filter and this file count the words again.",
    },
    counts: {
      essays: c.essays.length,
      by_prompt: tallyBy(c.essays, (e) => e.prompt),
      by_grade: tallyBy(c.essays, (e) => e.grade),
      // the provider set the assignment and collected the essay, and the providers differ by state and
      // by grade, so any difference between prompts may be a difference between providers instead
      by_provider: tallyBy(c.essays, (e) => e.provider),
      providers_note: `Of the ${c.kaggle.listed} essays on the 2021 release list, ${Object.entries(c.kaggle.providers).map(([p, n]) => `${n} are ${p}`).join(', ')}. The ones missing from the counts above are lost to the earlier steps, not to the list.`,
      provider_and_prompt: mixedProviders.length === 0
        ? 'Every one of these prompts was collected by one provider alone, so provider and prompt are the same split in this arm: a difference between prompts is also a difference between providers, and nothing here can tell the two apart.'
        : `${mixedProviders.length} of the ${PROMPTS.length} prompts hold essays from more than one provider (${mixedProviders.map((p) => p.slug).join(', ')}); the rest are one provider each.`,
      by_bin: { ...Object.fromEntries(BINS.map((_, i) => [i, 0])), ...tallyBy(c.essays, (e) => e.bin) },
      bins: Object.fromEntries(BINS.map(([lo, hi], i) => [i, `${lo}-${hi} words`])),
      grades_present: grades,
      note: `The corpus is described as grades 6-12. These seven prompts, filtered, hold ${grades.length === 1 ? `grade ${grades[0]}` : `grades ${grades.join(', ')}`}: no grade 6 or 7, and grade ${top?.[0]} alone is ${pct(top?.[1] ?? 0, c.essays.length)}% of them. The page should say "grades ${grades[0]} to ${grades[grades.length - 1]}", not "6-12".`,
    },
    prompts: promptRows(c),
    prompts_note: 'essays, grades, providers and words describe the essays this file holds. over_800 does not: it is what the '
      + 'length step took, counted on the rows that step saw, which is every graded independent essay of that prompt and so a '
      + 'larger set than the one kept here. It is published because the 800-word cap falls unevenly between prompts.',
    placeholders: {
      essays: touched.length,
      share_of_essays: pct(touched.length, c.essays.length),
      tokens_removed: touched.reduce((s, e) => s + e.placeholders, 0),
      distinct_removed: c.tokens.filter((t) => t.removed).length,
      distinct_left_alone: c.tokens.filter((t) => !t.removed).length,
      note: 'Counted over the eligible essays. census.json holds the full list, with each token\'s count in the whole corpus.',
    },
    cleaning: {
      ...c.cleaned,
      note: 'changedWordCount: essays whose word count moved when the text was normalised and the placeholders removed. outsideWordRange: of those, essays that no longer sit between 80 and 800 words, the filter having been applied to the corpus\'s own field. outsidePairingBins: essays the length bins cannot reach by the marker word count, which are measured but never paired.',
    },
  };
  return serialize(meta, 'essays', frameRows(c));
}

export function assignments(c: Corpus, at: string): string {
  const body = {
    generated_at: at,
    genre: GENRE,
    about: 'The assignment each class was given, verbatim. These are the teacher\'s words, not a student\'s, and they are the only text of this corpus this project reproduces: the machine arms of this genre are given the same assignment, so it has to be published for the comparison to be checkable.',
    attribution: ATTRIBUTION,
    licence: LICENCE,
    licence_url: LICENCE_URL,
    source: { corpus: CORPUS, home: CORPUS_HOME, citation: CITATION },
    letters: `${c.assignments.filter((a) => asksForALetter(a.text)).length} of the ${PROMPTS.length} assignments ask the class for a letter to the principal rather than an essay. The salutation, the first person and the register of those essays follow from the assignment, so "letter" and the counts are published per prompt.`,
    prompts: promptRows(c).map((row) => {
      const text = c.assignments.find((a) => a.slug === row.slug)!.text;
      return { ...row, assignment: text, assignment_sha256: sha256(text) };
    }),
  };
  return `${JSON.stringify(body, null, 1)}\n`;
}

/**
 * What the typography of this corpus can and cannot show. A marker that no essay can carry because of
 * the keyboard or the file -- an em dash character, a heading -- has to be marked "not recorded" rather
 * than measured as an absence, and that decision is made from this file rather than from an impression.
 * The catalogue's own markers are counted here too, descriptively: this is one arm, with nothing to
 * compare it against yet.
 */
export function census(c: Corpus, at: string): string {
  const texts: Text[] = c.essays.map((e) => ({ id: e.id, text: e.text, source: ARM }));
  const noContraction = byId.get('no_contraction')!;
  const count = (re: RegExp): ((t: string) => number) => {
    const g = new RegExp(re.source, re.flags.includes('g') ? re.flags : `${re.flags}g`);
    return (t) => (t.match(g) ?? []).length;
  };
  const features: { id: string; what: string; test: (t: string) => boolean; count?: (t: string) => number }[] = [
    { id: 'em_dash_char', what: 'an em dash, U+2014', test: (t) => t.includes('—'), count: count(/—/) },
    { id: 'en_dash_char', what: 'an en dash, U+2013', test: (t) => t.includes('–'), count: count(/–/) },
    { id: 'double_hyphen', what: '"--", the typewriter dash', test: (t) => t.includes('--'), count: count(/--/) },
    { id: 'spaced_hyphen', what: 'a hyphen with a space on both sides', test: (t) => / - /.test(t), count: count(/ - /) },
    { id: 'curly_double_quotes', what: 'curly double quotation marks', test: (t) => /[“”]/.test(t), count: count(/[“”]/) },
    { id: 'straight_double_quotes', what: 'straight double quotation marks', test: (t) => t.includes('"'), count: count(/"/) },
    { id: 'curly_apostrophe', what: 'a curly apostrophe, U+2019', test: (t) => t.includes('’'), count: count(/’/) },
    { id: 'straight_apostrophe', what: "a straight apostrophe, '", test: (t) => t.includes("'"), count: count(/'/) },
    { id: 'no_apostrophe_at_all', what: 'neither apostrophe anywhere in the essay', test: (t) => !/['’]/.test(t) },
    { id: 'contraction', what: 'a contraction of any form, as src/markers.ts counts one', test: (t) => !noContraction.test(t) },
    { id: 'contraction_without_an_apostrophe', what: 'a contraction typed with no apostrophe at all ("dont", "im"), the only kind an essay without apostrophes can have', test: (t) => !/['’]/.test(t) && !noContraction.test(t) },
    // "wont" is the one apostrophe-less contraction src/markers.ts does not know (it knows dont, cant,
    // thats, youre and the rest), so this is the size of that gap in the arm it costs the most.
    { id: 'wont_without_an_apostrophe', what: '"wont" for "won\'t", which the catalogue\'s contraction marker does not count', test: (t) => /(?<![\p{L}\p{N}_'’])wont(?![\p{L}\p{N}_'’])/iu.test(t), count: count(/(?<![\p{L}\p{N}_'’])wont(?![\p{L}\p{N}_'’])/giu) },
    { id: 'ellipsis_char', what: 'an ellipsis character, U+2026', test: (t) => t.includes('…'), count: count(/…/) },
    { id: 'three_dots', what: 'three full stops in a row', test: (t) => t.includes('...'), count: count(/\.\.\./) },
    { id: 'bold_marks', what: '"**", Markdown bold', test: (t) => t.includes('**'), count: count(/\*\*/) },
    { id: 'bullet_line', what: 'a line that starts with a bullet or a number', test: (t) => /^[^\S\n]*(?:[-*•+]|\d{1,2}[.)])[^\S\n]/m.test(t) },
    { id: 'heading_line', what: 'a line that starts with "#"', test: (t) => /^[^\S\n]*#{1,6}[^\S\n]/m.test(t) },
    { id: 'blank_line', what: 'a blank line, that is, a paragraph break', test: (t) => /\n[^\S\n]*\n/.test(t) },
    { id: 'line_break', what: 'any line break at all', test: (t) => t.includes('\n') },
  ];

  const body = {
    generated_at: at,
    genre: GENRE,
    arm: ARM,
    about: 'The typography of the people\'s essays, and the catalogue\'s markers over the same arm. Counts only: no essay, and no part of one, is reproduced. A marker no essay can carry because of the keyboard or the file belongs in the genre\'s notRecorded rather than in its results, and this file is where that is decided.',
    licence: `${CITATION}, ${LICENCE}`,
    texts: c.essays.length,
    words: c.essays.reduce((s, e) => s + e.binWords, 0),
    typography: features.map((f) => {
      const k = texts.filter((t) => f.test(t.text)).length;
      return { id: f.id, what: f.what, texts: k, share: pct(k, texts.length), occurrences: f.count ? texts.reduce((s, t) => s + f.count!(t.text), 0) : null };
    }),
    placeholder_tokens: {
      about: 'Every token with an underscore and a capitalised or all-capitals first part, over the whole corpus. "tokens" are the ones taken out before counting, with their count in the whole corpus and in the eligible essays: a token that begins with two or more of the words the corpus\'s anonymisation scheme is built from. "left_to_the_writer" counts the rest -- the writer\'s own capitals and the links some essays paste in, which are left where they are -- without naming them, because they are the students\' own words.',
      tokens: c.tokens.filter((t) => t.removed),
      // the rest are pieces of the students' own text (a pasted link, a click id, a heading typed in
      // capitals), and this project publishes no part of a student's essay, however short
      left_to_the_writer: {
        distinct: c.tokens.filter((t) => !t.removed).length,
        corpus: c.tokens.filter((t) => !t.removed).reduce((n, t) => n + t.corpus, 0),
        eligible: c.tokens.filter((t) => !t.removed).reduce((n, t) => n + t.eligible, 0),
      },
    },
    markers: MARKERS.map((m) => {
      const judged = m.eligible ? texts.filter((t) => m.eligible!(t.text)) : texts;
      const s = share(judged, m), r = rate(judged, m);
      return {
        marker: m.id, label: m.label, family: m.family, belief: m.belief === true, countable: m.count !== undefined,
        texts: s.n, with: s.k, share: Number(s.pct.toFixed(2)), occurrences: r.occurrences, words: r.words,
        per1000: Number(r.per1000.toFixed(4)),
      };
    }),
  };
  return `${JSON.stringify(body, null, 1)}\n`;
}

// ---- writing, and checking what was written

/** the arm as every other collector writes one, with the prompt and grade each pairing by prompt needs */
export const armRows = (c: Corpus): { id: string; text: string; group: string; grade: number }[] =>
  c.essays.map((e) => ({ id: e.id, text: e.text, group: e.prompt, grade: e.grade }));

export interface Frame { source?: { files?: { name: string; sha256: string }[] }; eligibility?: { steps?: Step[] }; counts?: { essays?: number }; essays?: FrameRow[] }

/**
 * Whether a frame written earlier still describes the corpus this run read. Anything that moved is
 * reported, because the answer a reader wants is which essays changed, not that something did.
 */
export function compare(committed: Frame, c: Corpus): string[] {
  const problems: string[] = [];
  const hashes = new Map((committed.source?.files ?? []).map((f) => [f.name, f.sha256]));
  for (const f of c.files) {
    const was = hashes.get(f.name);
    if (was !== f.sha256) problems.push(`${f.name}: the frame was written from SHA-256 ${was ?? '(not recorded)'}, this run read ${f.sha256}`);
  }
  const steps = new Map((committed.eligibility?.steps ?? []).map((s) => [s.step, s]));
  for (const s of c.steps) {
    const was = steps.get(s.step);
    if (!was) problems.push(`the frame has no "${s.step}" step`);
    else if (was.kept !== s.kept || was.dropped !== s.dropped) problems.push(`step ${s.step}: the frame kept ${was.kept} and dropped ${was.dropped}, this run kept ${s.kept} and dropped ${s.dropped}`);
  }
  const was = new Map((committed.essays ?? []).map((r) => [r.id, r]));
  const now = new Map(frameRows(c).map((r) => [r.id, r]));
  for (const [id, r] of now) {
    const old = was.get(id);
    if (!old) { problems.push(`${id} is in this run and not in the frame`); continue; }
    for (const k of ['grade', 'provider', 'words', 'bin', 'sha256'] as const) {
      if (old[k] !== r[k]) problems.push(`${id}: ${k} is ${JSON.stringify(old[k])} in the frame and ${JSON.stringify(r[k])} in this run`);
    }
  }
  for (const id of was.keys()) if (!now.has(id)) problems.push(`${id} is in the frame and not in this run`);
  return problems;
}

async function main(): Promise<void> {
  const check = process.argv.includes('--check');
  const cacheDir = path.resolve(flag('--cache') ?? 'cache/persuade');
  const dir = path.join(DATA, 'genres', GENRE);
  const frameFile = path.join(dir, 'frame.json');
  // the release list is a committed input of this genre and lives beside the files this script writes,
  // so --data moves both together: a run against another directory reads the list that directory holds
  const kaggleFile = path.join(dir, KAGGLE_FILE);
  const log = (line: string): void => console.error(line);

  console.error(`${CORPUS}: the people's essays for ${PROMPTS.length} independent prompts`);
  if (!existsSync(kaggleFile)) throw new Error(`${kaggleFile} does not exist; it names the essays released in ${KAGGLE_RELEASE} and every essay kept here is on it`);
  const c = await collect(cacheDir, kaggleFile, log);
  for (const s of c.steps) console.error(`  ${s.step.padEnd(12)} kept ${String(s.kept).padStart(6)}   dropped ${String(s.dropped).padStart(6)}   (${s.rule.split(':')[0]})`);
  console.error(`  ${c.essays.length} eligible essays, ${c.essays.reduce((s, e) => s + e.binWords, 0)} words`);
  console.error(`  by provider: ${Object.entries(tallyBy(c.essays, (e) => e.provider)).map(([p, n]) => `${p} ${n}`).join(', ')}`);

  if (check) {
    if (!existsSync(frameFile)) throw new Error(`${frameFile} does not exist, so there is nothing to check against`);
    const problems = compare(JSON.parse(readFileSync(frameFile, 'utf8')) as Frame, c);
    if (problems.length) {
      console.error(`\n${frameFile} disagrees with the corpus in ${problems.length} place(s):`);
      for (const p of problems.slice(0, 20)) console.error(`  ${p}`);
      if (problems.length > 20) console.error(`  ... and ${problems.length - 20} more`);
      process.exitCode = 1;
      return;
    }
    console.error(`  ${frameFile} agrees: same files, same counts, same ${c.essays.length} essays, same text`);
    return;
  }

  const at = new Date().toISOString();
  mkdirSync(OUT, { recursive: true });
  writeFileSync(path.join(OUT, `${ARM}.json`), JSON.stringify(armRows(c)));
  console.error(`  wrote ${path.join(OUT, `${ARM}.json`)}: ${c.essays.length} essays (not committed, and never quoted)`);
  mkdirSync(dir, { recursive: true });
  for (const [name, body] of [['frame.json', frame(c, at)], ['assignments.json', assignments(c, at)], ['census.json', census(c, at)]] as const) {
    writeFileSync(path.join(dir, name), body);
    console.error(`  wrote ${path.join(dir, name)}: ${(body.length / 1024).toFixed(0)} KB`);
  }
}

if (process.argv[1] && process.argv[1].endsWith('collect-essays.ts')) await main();
