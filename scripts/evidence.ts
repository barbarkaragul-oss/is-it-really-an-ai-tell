/**
 * Writes data/genres/<genre>/evidence.json: for every countable marker and every arm, what the regex
 * matched.
 *
 *   npx tsx scripts/evidence.ts [--genres abstracts,posts] [--data <dir>]
 *
 * Per arm and marker: the forms that matched, the word in front of each match, and up to five
 * sentences picked by a seeded shuffle. Sentences are quoted only from arms whose licence allows it
 * (scripts/genres.ts); the others get a link to the original where one exists, and otherwise only
 * the id. A person's Reddit post is never quoted, and neither is a model's sentence that shares a
 * five-word sequence with that post, eight words in a row with anyone's post, or the post's title: a
 * model that copied part of a post would otherwise quote it. The titles are read from out/ for that
 * check alone (scripts/genres.ts, hiddenTitles).
 *
 * Each kind of writing also gets a few whole documents as every quotable writer wrote them, for the
 * page to open with: for abstracts the person and every model, for Reddit posts the models only,
 * with the person's post named as not reproduced. None is about suicide, self-harm, sexual violence,
 * psychosis, overdoses, addiction, eating disorders or accusations and attacks (SENSITIVE), and where
 * the person may not be quoted, no evidence sentence comes from such a document either.
 *
 * The arm summary also carries "we" per thousand words. It is not a marker anybody claims, but it is
 * the other half of the most visible pattern here: the models write "the proposed method leverages",
 * and the people who wrote the same abstracts write "we leverage".
 */
import { writeFileSync, mkdirSync, existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { MARKERS, words } from '../src/markers.js';
import { hits, top, forms, examples, linkFor, type Hit } from '../src/evidence.js';
import { seededShuffle, sourceId, type Arm } from '../src/measure.js';
import { loadArms, DATA, OUT, genresToRun, type ArmSpec } from './arms.js';
import { fiveGrams, gramWords } from './contamination.js';
import { GENRES, type Genre } from './genres.js';

export const SEED = 20260916;
const PER_CELL = 5;
const DOCUMENTS = 6;

export type Example = { id: string; sentence?: string; link?: string };

/**
 * An example as the arm's licence allows it: the sentence, a link to where it was posted, or the id
 * alone. The id is how the corpus is rebuilt; it is not the text.
 */
export function exampleFor(spec: Pick<ArmSpec, 'id' | 'publishable'>, h: Hit): Example {
  if (spec.publishable) return { id: h.id, sentence: h.sentence };
  const link = linkFor(spec.id, h.id);
  return link ? { id: h.id, link } : { id: h.id };
}

/** the set of eight-word sequences in a text, as fiveGrams reads its words */
export function eightGrams(text: string): Set<string> {
  const w = gramWords(text);
  const out = new Set<string>();
  for (let i = 0; i + 8 <= w.length; i++) out.add(w.slice(i, i + 8).join(' '));
  return out;
}

/** words as the guard compares them, joined by single spaces and padded, so a match is whole words */
const phrase = (t: string): string => ` ${gramWords(t).join(' ')} `;
/** a title shorter than this is a common phrase ("Need advice"), not the person's words */
export const TITLE_WORDS = 3;

/**
 * The text guard, for a person who may not be quoted: whether a machine text shares any five-word
 * sequence with the person's text for the same document, or any eight-word sequence with any
 * person's text in the arm, or repeats the document's title (the person's words too, and RAID told
 * the models not to repeat it, which some did anyway). The first catches a model continuing the post
 * it was given; the second a model that learned another poster's words (the models were trained on
 * Reddit), at a length that stock phrases ("has anyone else experienced this") rarely reach. Either
 * way the text is not shown. `titles` maps a document to its title. A document's own title counts
 * from three words; another document's title, like another post, from eight words in a row, since a
 * shorter one is often a stock question ("Has anyone else experienced this?") that any post may ask.
 */
export function makeTextGuard(person: Arm | undefined, titles: Map<string, string> = new Map()): (doc: string, text: string) => boolean {
  const grams = new Map<string, Set<string>>();
  const texts = new Map((person?.texts ?? []).map((t) => [sourceId(t.id), t.text]));
  let anyone: Set<string> | null = null;
  return (doc: string, text: string): boolean => {
    const title = titles.get(doc);
    if (title && gramWords(title).length >= TITLE_WORDS && phrase(text).includes(phrase(title))) return true;
    const own = texts.get(doc);
    if (own !== undefined) {
      let g = grams.get(doc);
      if (!g) { g = fiveGrams(own); grams.set(doc, g); }
      for (const x of fiveGrams(text)) if (g.has(x)) return true;
    }
    if (!anyone) {
      anyone = new Set();
      // a title is someone's words too; at eight words it is theirs whichever post repeats it
      for (const t of [...texts.values(), ...titles.values()]) for (const x of eightGrams(t)) anyone.add(x);
    }
    for (const x of eightGrams(text)) if (anyone.has(x)) return true;
    return false;
  };
}

/** the text guard for one matched sentence */
export function makeGuard(person: Arm | undefined, titles?: Map<string, string>): (h: Hit) => boolean {
  const guard = makeTextGuard(person, titles);
  return (h: Hit): boolean => guard(sourceId(h.id), h.sentence);
}

/**
 * Subjects a model's text is not shown on, where the person's text may not be quoted: suicide and
 * self-harm, sexual violence and abuse, psychosis, overdoses, addiction and drugs, eating disorders,
 * and accusations, attacks and killings. The Reddit titles the models wrote from are real people's
 * questions, and a model's invented post about someone's crisis, or about a named person accused of
 * a crime, is not a fair thing to publish as an example. Such a document is still measured; it only
 * supplies no sentence to the evidence and is never one of the documents the page opens with.
 */
export const SENSITIVE = /\b(?:suicid\w*|self[- ]?harm\w*|kill(?:ing)? myself|end(?:ing)? my (?:own )?life|sexual(?:ly)? (?:assault|abus)\w*|rap(?:e|ed|es|ing|ist)\b|molest\w*|abus(?:e|ed|er|ers|ive)\b|psychos[ie]s|psychotic|overdos\w*|addict\w*|alcoholi\w*|rehab\b|drugs?\b|heroin|cocaine|opioid\w*|fentanyl|meth\b|eating disorders?|anorexi\w*|bulimi\w*|accus(?:e|ed|es|ing|ation|ations)\b|convict\w*|arrest\w*|bomb\w*|terror\w*|shoot(?:ing|er|ers)\b|murder\w*|lawsuits?\b)/i;

/**
 * The documents whose text, from any writer the genre measures, touches a SENSITIVE subject. Used only
 * where the person may not be quoted: there the models' texts are invented posts about real people's
 * questions, and none of those documents gives the evidence a sentence.
 */
export function sensitiveDocuments(arms: Arm[]): Set<string> {
  const out = new Set<string>();
  for (const arm of arms) for (const t of arm.texts) if (SENSITIVE.test(t.text)) out.add(sourceId(t.id));
  return out;
}

export interface Cell { occurrences: number; forms: [string, number][]; before: [string, number][]; examples: Example[] }

/** one marker in one arm; `hidden` drops the hits the sentence guard keeps off the page */
export function cellFor(spec: Pick<ArmSpec, 'id' | 'publishable'>, all: Hit[], openEnded: boolean, hidden: ((h: Hit) => boolean) | null): Cell {
  const shown = hidden ? all.filter((h) => !hidden(h)) : all;
  return {
    occurrences: all.length,
    forms: forms(shown, spec.publishable, openEnded),
    before: top(all.map((h) => h.before), 8),
    examples: examples(shown, PER_CELL, SEED).map((h) => exampleFor(spec, h)),
  };
}

export interface Document { source_id: string; title: string; texts: Record<string, string>; person_not_reproduced?: true }

/**
 * The documents the page opens with, drawn by a seeded shuffle, never chosen. Only quotable arms'
 * texts are included. Where the person may not be quoted, a document is used only when no model's
 * text passes the text guard (five words of the person's post, eight of anyone's, or the title), so
 * the panel cannot carry a post in pieces. A document on one of the SENSITIVE subjects, in any
 * writer's text, is not used either. `titles` are shown only where the genre shows them.
 */
export function documentsFor(genre: Genre, loaded: { arm: Arm; spec: ArmSpec }[], titles: Map<string, string>): Document[] {
  const own = new Set(genre.writers.map((w) => w.id));
  const quotable = loaded.filter(({ spec }) => spec.publishable && own.has(spec.id));
  const byArm = new Map(quotable.map(({ arm }) => [arm.id, new Map(arm.texts.map((t) => [sourceId(t.id), t.text]))]));
  const claude = genre.writers.find((w) => w.writer === 'claude');
  const pool = genre.documents === 'claude' && claude ? [...(byArm.get(claude.id)?.keys() ?? [])] : [...(byArm.values().next().value?.keys() ?? [])];
  const person = loaded.find(({ spec }) => spec.id === genre.reference)?.arm;
  const personText = new Map((person?.texts ?? []).map((t) => [sourceId(t.id), t.text]));
  const guard = genre.humanQuotable ? null : makeTextGuard(person, titles);
  const clean = (id: string): boolean => {
    if ([personText, ...byArm.values()].some((m) => SENSITIVE.test(m.get(id) ?? ''))) return false;
    if (!guard) return true;
    if (!personText.has(id)) return false;
    return [...byArm.values()].every((m) => !guard(id, m.get(id) ?? ''));
  };
  // every writer, so each document can be read by all of them; the person too where it is quotable
  const complete = pool.filter((id) => [...byArm.values()].every((m) => m.has(id)) && (genre.humanQuotable || personText.has(id))).sort();
  const picked: string[] = [];
  for (const id of seededShuffle(complete, SEED)) {
    if (picked.length === DOCUMENTS) break;
    if (clean(id)) picked.push(id);
  }
  return picked.map((id) => ({
    source_id: id,
    title: genre.titles === 'show' ? (titles.get(id) ?? '') : '',
    texts: Object.fromEntries([...byArm].map(([arm, m]) => [arm, m.get(id) ?? ''])),
    ...(genre.humanQuotable ? {} : { person_not_reproduced: true as const }),
  }));
}

/**
 * Every document's title: for a genre that shows them, from the generated arm and the collector's
 * prompts; for one that hides them, from the collector's titles file in out/, which only the guard
 * reads. A hidden-titles file that is missing is an error, or the guard would quietly check less.
 */
export function titlesFor(genre: Genre, dir: string = OUT): Map<string, string> {
  const titles = new Map<string, string>();
  if (genre.titles !== 'show') {
    if (!genre.hiddenTitles) return titles;
    const f = path.join(dir, `${genre.hiddenTitles}.json`);
    if (!existsSync(f)) throw new Error(`${f} is missing; run the collector for ${genre.id} again`);
    for (const t of JSON.parse(readFileSync(f, 'utf8')) as { source_id: string; title: string }[]) titles.set(t.source_id, t.title);
    return titles;
  }
  if (genre.generated && existsSync(path.resolve(genre.generated))) {
    for (const t of (JSON.parse(readFileSync(path.resolve(genre.generated), 'utf8')) as { texts: { source_id: string; title: string }[] }).texts) titles.set(t.source_id, t.title);
  }
  const prompts = genre.prompts ? path.join(dir, `${genre.prompts}.json`) : '';
  if (prompts && existsSync(prompts)) {
    for (const p of JSON.parse(readFileSync(prompts, 'utf8')) as { source_id: string; title?: string }[]) if (!titles.has(p.source_id) && p.title) titles.set(p.source_id, p.title);
  }
  return titles;
}

export function evidenceFor(genre: Genre, loaded: { arm: Arm; spec: ArmSpec }[], generatedAt = new Date().toISOString(), titles: Map<string, string> = titlesFor(genre)) {
  const arms: Record<string, { label: string; publishable: boolean; texts: number; words: number; we_per1000: number }> = {};
  for (const { arm, spec } of loaded) {
    let w = 0, we = 0;
    for (const t of arm.texts) { w += words(t.text).length; we += (t.text.match(/\bwe\b/gi) ?? []).length; }
    arms[arm.id] = { label: arm.label, publishable: spec.publishable, texts: arm.texts.length, words: w, we_per1000: w ? (1000 * we) / w : 0 };
  }
  const own = new Set(genre.writers.filter((w) => w.writer !== 'human').map((w) => w.id));
  const writers = new Set(genre.writers.map((w) => w.id));
  const textGuard = genre.humanQuotable ? null : makeGuard(loaded.find(({ spec }) => spec.id === genre.reference)?.arm, titles);
  const sensitive = genre.humanQuotable ? new Set<string>() : sensitiveDocuments(loaded.filter(({ spec }) => writers.has(spec.id)).map(({ arm }) => arm));
  const guard = textGuard ? (h: Hit): boolean => sensitive.has(sourceId(h.id)) || textGuard(h) : null;

  const markers: Record<string, { label: string; arms: Record<string, Cell> }> = {};
  for (const m of MARKERS.filter((x) => x.pattern)) {
    const cells: Record<string, Cell> = {};
    for (const { arm, spec } of loaded) {
      const all = hits(arm.texts, m);
      if (!all.length) continue;
      cells[arm.id] = cellFor(spec, all, m.openEnded === true, guard && own.has(arm.id) ? guard : null);
    }
    markers[m.id] = { label: m.label, arms: cells };
  }

  const quoted = genre.writers.filter((w) => w.quotable).map((w) => w.short).join(', ');
  return {
    generated_at: generatedAt,
    genre: genre.id,
    seed: SEED,
    per_cell: PER_CELL,
    note: `Sentences are quoted only from ${quoted} (RAID's machine text is MIT${genre.humanQuotable ? ', arXiv abstracts are CC0' : ''}${genre.writers.some((w) => w.writer === 'claude') ? ', the Claude arm was generated for this repository' : ''}).`
      + (genre.humanQuotable ? '' : ` The people's ${genre.noun.many} are not quoted or linked, only counted and referenced by id, and a model's sentence that shares a five-word sequence with the person's ${genre.noun.one} for the same document, eight words in a row with any person's ${genre.noun.one}, or the document's title, is not quoted either.`)
      + ' Hacker News and Stack Exchange texts are linked, not quoted; HC3 is referenced by id.',
    arms,
    markers,
    documents: documentsFor(genre, loaded, titles),
  };
}

if (process.argv[1] && process.argv[1].endsWith('evidence.ts')) {
  const { genres, missing } = genresToRun();
  if (missing.length) { console.error(`not collected: ${missing.join(', ')}; run the collectors first`); process.exit(1); }
  for (const g of GENRES) {
    if (!genres.includes(g)) { console.log(`${g.label}: not collected, skipped`); continue; }
    const loaded = loadArms(g);
    const ev = evidenceFor(g, loaded);
    const dir = path.join(DATA, 'genres', g.id);
    mkdirSync(dir, { recursive: true });
    const body = JSON.stringify(ev, null, 1) + '\n';
    writeFileSync(path.join(dir, 'evidence.json'), body);
    // the README still links the abstracts evidence at its old path
    if (g.id === 'abstracts') writeFileSync(path.join(DATA, 'evidence.json'), body);

    // a readable summary of the cells worth looking at
    const short = (id: string): string => id.replace(/^(raid|posts)-/, '').replace('-human', '');
    console.log(`\n==== ${g.label}: ${ev.documents.length} documents for the page`);
    for (const mk of Object.values(ev.markers)) {
      const cells = Object.entries(mk.arms);
      if (!cells.length) continue;
      console.log(`\n${mk.label}`);
      for (const [a, c] of cells) {
        console.log(`  ${short(a).padEnd(14)} ${String(c.occurrences).padStart(4)}  forms ${c.forms.slice(0, 4).map(([f, n]) => `${f}:${n}`).join(' ')}   before ${c.before.slice(0, 4).map(([f, n]) => `${f}:${n}`).join(' ')}`);
      }
    }
    console.log('\n"we" per thousand words:');
    for (const [a, s] of Object.entries(ev.arms)) console.log(`  ${short(a).padEnd(14)} ${s.we_per1000.toFixed(2)}`);
    console.log(`wrote ${path.join(dir, 'evidence.json')}`);
  }
}
