/**
 * When was each abstract written? A one-off lookup of every RAID abstract on arXiv.
 *
 *   npx tsx scripts/arxiv-dates.ts                 # every title; writes data/abstracts-dates.json
 *   npx tsx scripts/arxiv-dates.ts --sample 40     # a seeded sample; writes out/abstracts-dates-sample.json
 *
 * Options: --titles <file> (repeatable; default out/raid-prompts.json and
 * data/generated/claude-abstracts.json), --human <file> (default out/raid-human.json), --out <file>,
 * --full-history (fetch every multi-version paper's history, not only the ones that need it),
 * --refresh-empty (ask again for searches whose cached answer was empty), --skip <source_id>
 * (repeatable; a document the lookup fails on every time is recorded as not dated instead).
 *
 * The human side of the abstracts comparison must be writing from before ChatGPT (2022-11-30).
 * RAID took its abstracts from a snapshot of arXiv's metadata, and a snapshot holds a paper's
 * newest text: RAID's abstract for 1202.3670 opens "In the fourth extended version", and arXiv
 * lists that fourth version as posted on 2023-07-25. So a paper is excluded when any of its
 * versions was posted between 2022-11-30 and 2024-06-04, the date of RAID's train_none.csv. A
 * version posted after that date cannot be the text RAID holds, so it does not count against the
 * paper.
 *
 * arXiv's search API gives only the first and the newest version's date. When the newest version
 * falls on or after 2022-11-30 the whole history is needed, and it comes from arXiv's OAI-PMH
 * interface, whose arXivRaw format lists every version with its date. The abs pages list it too,
 * but arxiv.org's robots.txt asks for 15 seconds between requests, and OAI-PMH is the interface
 * arXiv provides for harvesting metadata.
 *
 * Titles are matched with care, because arXiv's copy is not RAID's copy:
 * - the search index drops Lucene's stop words, so `ti:there` finds nothing and sinks a whole AND
 *   query ("... When There is a Nuisance Parameter ...");
 * - words with accents or TeX ("Lovász", `K\"ahler`) are indexed in a form a query cannot reach,
 *   so they are left out of the query and folded away before titles are compared;
 * - papers get renamed in later versions, and the API returns the newest title, so when the titles
 *   differ the match must be confirmed by the abstract: the share of RAID's word trigrams that
 *   also occur in arXiv's abstract. A paper renamed and rewritten after RAID's snapshot still
 *   reads like RAID's copy in its first version, which the API returns for a versioned id.
 * - the API ranks by relevance and returns one page, so after an AND of the title words comes an
 *   OR of them (a renamed paper keeps most of them), then an exact phrase from RAID's abstract.
 *
 * Politeness: one request at a time, and at least three seconds from the end of one answer to the
 * start of the next request (arXiv API terms of use, https://info.arxiv.org/help/api/tou.html);
 * Retry-After is honoured; the User-Agent names this repository. Every good answer is cached under
 * out/cache/arxiv, so an interrupted run resumes where it stopped and a re-run sends nothing.
 *
 * The output holds arXiv ids, titles and version dates, plus the match method and the abstract
 * overlap as numbers; no abstract text. arXiv's metadata is CC0 (the terms-of-use page above).
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { parseArgs } from 'node:util';

/** ChatGPT's release, and the Last-Modified date of RAID's train_none.csv */
export const WINDOW = { from: '2022-11-30', to: '2024-06-04' } as const;
export type Window = { from: string; to: string };

const API = 'https://export.arxiv.org/api/query';
const OAI = 'https://oaipmh.arxiv.org/oai';
const USER_AGENT = 'is-it-really-an-ai-tell/0.1 (+https://github.com/barbarkaragul-oss/is-it-really-an-ai-tell; one-off arXiv date lookup)';
/** arXiv's terms of use: no more than one request every three seconds */
export const MIN_GAP_MS = 3000;

export interface Version { v: number; date: string }

/** One search result, as the Atom feed gives it. `updated` is the date of the newest version. */
export interface Entry { id: string; version: number; title: string; summary: string; published: string; updated: string }

export interface OaiRecord { id: string; title: string; versions: Version[] }

/** A document to date: RAID's id and title, and the human abstract when the corpus has it. */
export interface Doc { source_id: string; title: string; human?: string }

export interface DateRow {
  source_id: string;
  arxiv_id: string | null;
  /** RAID's title, with its line wraps joined */
  title: string;
  /** arXiv's newest title, only when it differs from RAID's after folding */
  arxiv_title?: string;
  /**
   * how the record was accepted: `title`, `title+abstract` (renamed, the abstract confirms),
   * `abstract`, or `first-version` (the paper's first version has RAID's title or abstract)
   */
  match?: string;
  /** share of RAID's word trigrams that occur in arXiv's newest abstract; null without RAID's text */
  abstract_overlap?: number | null;
  /**
   * Every version with its date. Empty when the document is not dated: no paper was found, or the
   * paper was found and arXiv has no history for it. Either way the document is kept and counted.
   */
  versions: Version[];
  /** `first-and-last` when the newest version predates the window, so nothing between can be in it */
  history?: 'full' | 'first-and-last';
  excluded: boolean;
  reason: string;
}

/**
 * A failure that another run may not meet: the host kept refusing or could not be reached. Anything
 * else (a 404, an OAI-PMH error, which is cached like any well-formed answer) fails the same way on
 * every run, and the run can only get past it with --skip.
 */
export class TransientError extends Error {
  override name = 'TransientError';
}

/** a document the lookup could date: a paper, and that paper's versions */
export const isDated = (r: Pick<DateRow, 'arxiv_id' | 'versions'>): boolean => Boolean(r.arxiv_id) && r.versions.length > 0;

const oneLine = (s: string): string => s.replace(/\s+/g, ' ').trim();

/** The XML entities arXiv writes. One pass, so `&amp;lt;` becomes `&lt;` and no further. */
export function decodeXml(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos);/gi, (_, e: string) => {
    const k = e.toLowerCase();
    if (k === 'amp') return '&';
    if (k === 'lt') return '<';
    if (k === 'gt') return '>';
    if (k === 'quot') return '"';
    if (k === 'apos') return "'";
    return String.fromCodePoint(k.startsWith('#x') ? parseInt(k.slice(2), 16) : Number(k.slice(1)));
  });
}

const tag = (xml: string, name: string): string | undefined =>
  xml.match(new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)</${name}>`))?.[1];

/** A timestamp in either of arXiv's formats, as the UTC day. */
export function isoDay(s: string | undefined): string {
  const d = new Date(String(s ?? '').trim());
  if (Number.isNaN(d.getTime())) throw new Error(`not a date: ${JSON.stringify(s)}`);
  return d.toISOString().slice(0, 10);
}

/** The entries of an arXiv API answer. An error feed throws rather than reading as "no results". */
export function parseAtom(xml: string): Entry[] {
  if (!/<feed[\s>]/.test(xml)) throw new Error('the arXiv API answer is not an Atom feed');
  const out: Entry[] = [];
  for (const m of xml.matchAll(/<entry>([\s\S]*?)<\/entry>/g)) {
    const e = m[1]!;
    const url = oneLine(decodeXml(tag(e, 'id') ?? ''));
    if (/\/api\/errors/.test(url)) throw new Error(`arXiv API error: ${oneLine(decodeXml(tag(e, 'summary') ?? ''))}`);
    // new-style ids (1202.3670v4) and old-style ones (math/0211159v1)
    const id = url.match(/arxiv\.org\/abs\/(.+?)v(\d+)$/);
    if (!id) continue;
    out.push({
      id: id[1]!,
      version: Number(id[2]),
      title: oneLine(decodeXml(tag(e, 'title') ?? '')),
      summary: oneLine(decodeXml(tag(e, 'summary') ?? '')),
      published: isoDay(tag(e, 'published')),
      updated: isoDay(tag(e, 'updated')),
    });
  }
  return out;
}

/** An OAI-PMH GetRecord answer in arXivRaw. null when arXiv says the id does not exist. */
export function parseOai(xml: string): OaiRecord | null {
  if (!/<OAI-PMH[\s>]/.test(xml)) throw new Error('the OAI-PMH answer is not OAI-PMH');
  // arXiv quotes this attribute with single quotes
  const err = xml.match(/<error\s+code=["']([^"']+)["'][^>]*>([\s\S]*?)<\/error>/);
  if (err) {
    if (err[1] === 'idDoesNotExist') return null;
    throw new Error(`OAI-PMH error ${err[1]}: ${oneLine(decodeXml(err[2] ?? ''))}`);
  }
  const raw = tag(xml, 'arXivRaw');
  if (!raw) throw new Error('the OAI-PMH answer has no arXivRaw record');
  const versions = [...raw.matchAll(/<version\s+version="v(\d+)"\s*>([\s\S]*?)<\/version>/g)]
    .map((m) => ({ v: Number(m[1]), date: isoDay(decodeXml(tag(m[2]!, 'date') ?? '')) }))
    .sort((a, b) => a.v - b.v);
  if (!versions.length) throw new Error('the arXivRaw record lists no versions');
  return { id: oneLine(tag(raw, 'id') ?? ''), title: oneLine(decodeXml(tag(raw, 'title') ?? '')), versions };
}

// TeX accents: \"a, \'{e}, {\"o}, and the lettered ones only when a space or brace follows (\v{s}),
// so that \vec or \hat is not read as an accent
const SYMBOL_ACCENT = /\{?\\[`'^"~=.]\s*\{?\s*\\?([A-Za-z])\s*\}?\}?/g;
const LETTER_ACCENT = /\\[uvHckrbdt](?:\s+|\s*\{\s*)\\?([A-Za-z])\s*\}?/g;

/** Lower case, with accents removed whether they are written in Unicode or in TeX. */
export function fold(s: string): string {
  return s
    .replace(SYMBOL_ACCENT, '$1')
    .replace(LETTER_ACCENT, '$1')
    .replace(/\\(ss|ae|oe|aa|o|l|i|j)(?![A-Za-z])/gi, '$1')
    .normalize('NFKD')
    .replace(/\p{M}+/gu, '')
    .replace(/ß/g, 'ss').replace(/[øØ]/g, 'o').replace(/[łŁ]/g, 'l').replace(/æ/g, 'ae').replace(/œ/g, 'oe')
    .toLowerCase();
}

/** A title reduced to its letters and digits, for comparing RAID's copy with arXiv's. */
export function normTitle(s: string): string {
  return fold(s).replace(/\\[a-z]+/g, ' ').replace(/[^a-z0-9]+/g, ' ').trim();
}

const words = (s: string): string[] => fold(s).replace(/\\[a-z]+/g, ' ').match(/[a-z0-9]+/g) ?? [];

/** Lucene's English stop words: the index leaves them out, so a query term among them matches nothing. */
const STOP = new Set(['a', 'an', 'and', 'are', 'as', 'at', 'be', 'but', 'by', 'for', 'if', 'in', 'into', 'is', 'it', 'no', 'not', 'of', 'on', 'or', 'such', 'that', 'the', 'their', 'then', 'there', 'these', 'they', 'this', 'to', 'was', 'will', 'with']);

/** spaces, hyphens of every width and slashes: the index splits words at all of them */
const WORD_BREAK = /[\s\-‐-―\/]+/;
const EDGE_PUNCTUATION = /^[("`,.:;!?[]+|[)"`,.:;!?\]]+$/g;

/**
 * The words of a title a query can safely ask for: plain ASCII, three letters or more, not stop
 * words, longest first. Hyphenated words are indexed as their parts, so they are split; a word
 * with an accent, an apostrophe or TeX in it is left out, since its indexed form is unknown.
 */
export function titleTerms(title: string, max = 8): string[] {
  const seen = new Set<string>();
  for (const raw of title.split(WORD_BREAK)) {
    const t = raw.replace(EDGE_PUNCTUATION, '');
    const k = t.toLowerCase();
    if (!/^[A-Za-z0-9]+$/.test(t) || t.length < 3 || STOP.has(k)) continue;
    seen.add(k);
  }
  return [...seen].sort((a, b) => b.length - a.length || a.localeCompare(b)).slice(0, max);
}

/** words every abstract uses, which make a phrase no more distinctive */
const GENERIC = new Set(['we', 'our', 'here', 'also', 'can', 'which', 'has', 'have', 'been', 'its', 'paper', 'propose', 'proposed', 'present', 'presents', 'novel', 'method', 'methods', 'approach', 'result', 'results', 'show', 'shows', 'study', 'work', 'based', 'using', 'new', 'problem']);

/**
 * An exact phrase from an abstract, for the last search when the title searches failed.
 * Long common words are no use there: the API ranks by relevance and returns one page, and an
 * AND of "segmentation" and "representation" fills the page with other papers. A phrase of
 * eight words is nearly unique, if it is not "in this paper we propose a novel method", so the
 * window with the most letters outside stop and stock words is taken. A phrase never crosses
 * punctuation, TeX or a hyphen, whose indexed form is uncertain; stop words inside a phrase are
 * fine. null when no run of plain words is long and specific enough.
 */
export function abstractPhrase(text: string, min = 6, size = 8): string | null {
  const runs: string[][] = [];
  let run: string[] = [];
  for (const tok of text.split(/\s+/)) {
    if (/^[A-Za-z]+$/.test(tok)) { run.push(tok); continue; }
    // a word that ends a clause still belongs to the run it ends
    const last = tok.match(/^([A-Za-z]+)[,.;:]$/);
    if (last) run.push(last[1]!);
    if (run.length) runs.push(run);
    run = [];
  }
  if (run.length) runs.push(run);

  let best: string[] | null = null;
  let bestScore = 0;
  for (const r of runs) {
    if (r.length < min) continue;
    const n = Math.min(size, r.length);
    for (let i = 0; i + n <= r.length; i++) {
      const win = r.slice(i, i + n);
      const score = win.reduce((s, w) => s + (STOP.has(w.toLowerCase()) || GENERIC.has(w.toLowerCase()) ? 0 : w.length), 0);
      if (score > bestScore) { best = win; bestScore = score; }
    }
  }
  return best && bestScore >= 15 ? best.join(' ').toLowerCase() : null;
}

/** Share of a's word trigrams that also occur in b. A revised abstract keeps most of them; another paper's keeps almost none. */
export function overlap(a: string, b: string): number {
  const grams = (w: string[]): Set<string> => {
    const s = new Set<string>();
    for (let i = 0; i + 3 <= w.length; i++) s.add(`${w[i]} ${w[i + 1]} ${w[i + 2]}`);
    return s;
  };
  const A = grams(words(a)), B = grams(words(b));
  if (!A.size) return 0;
  let hit = 0;
  for (const g of A) if (B.has(g)) hit++;
  return hit / A.size;
}

/** Dice similarity of the two titles' word sets. */
export function titleSimilarity(a: string, b: string): number {
  const A = new Set(normTitle(a).split(' ').filter(Boolean)), B = new Set(normTitle(b).split(' ').filter(Boolean));
  if (!A.size || !B.size) return 0;
  let hit = 0;
  for (const w of A) if (B.has(w)) hit++;
  return (2 * hit) / (A.size + B.size);
}

export interface Match { entry: Entry; how: 'title' | 'title+abstract' | 'abstract' | 'first-version'; overlap: number | null }

/** below this, an abstract is not taken as the same paper's on its own */
const SAME_ABSTRACT = 0.5;
/** a renamed paper: most title words kept, and a fair part of the abstract */
const RENAMED_TITLE = 0.6, RENAMED_ABSTRACT = 0.25;

/**
 * Which search result, if any, is this document. The same title after folding is taken; among
 * several such, the one whose abstract is closest. A different title is taken only when the
 * abstract confirms it, so without RAID's text a renamed paper stays unmatched.
 */
export function pickMatch(doc: Doc, entries: Entry[]): Match | null {
  const want = normTitle(doc.title);
  const scored = entries.map((entry) => ({ entry, same: normTitle(entry.title) === want, ov: doc.human ? overlap(doc.human, entry.summary) : null }));
  const byOverlap = (a: { ov: number | null }, b: { ov: number | null }): number => (b.ov ?? 0) - (a.ov ?? 0);
  const same = scored.filter((s) => s.same).sort(byOverlap)[0];
  if (same) return { entry: same.entry, how: 'title', overlap: same.ov };
  const confirmed = scored
    .filter((s) => s.ov !== null && (s.ov >= SAME_ABSTRACT || (s.ov >= RENAMED_ABSTRACT && titleSimilarity(doc.title, s.entry.title) >= RENAMED_TITLE)))
    .sort(byOverlap)[0];
  if (!confirmed) return null;
  return { entry: confirmed.entry, how: titleSimilarity(doc.title, confirmed.entry.title) >= RENAMED_TITLE ? 'title+abstract' : 'abstract', overlap: confirmed.ov };
}

/** Whether a paper's history rules its RAID text out, and why, in words a reader can check. */
export function decide(versions: Version[], w: Window = WINDOW): { excluded: boolean; reason: string } {
  if (!versions.length) throw new Error('no versions to decide on');
  const list = (vs: Version[]): string => vs.map((v) => `v${v.v} ${v.date}`).join(', ');
  const inside = versions.filter((v) => v.date >= w.from && v.date <= w.to);
  if (inside.length) return { excluded: true, reason: `${list(inside)} posted between ${w.from} and ${w.to}` };
  const later = versions.filter((v) => v.date > w.to);
  if (later.length) return { excluded: false, reason: `no version between ${w.from} and ${w.to}; ${list(later)} came after RAID was built` };
  return { excluded: false, reason: `every version predates ${w.from}` };
}

export const searchUrl = (query: string, max = 10): string =>
  `${API}?search_query=${encodeURIComponent(query)}&start=0&max_results=${max}`;
/** the API answers a versioned id with that version's own title and abstract */
export const firstVersionUrl = (id: string): string =>
  `${API}?id_list=${encodeURIComponent(`${id}v1`)}&max_results=1`;

/** how close a search result must be to be worth checking against its first version */
const NEAR_TITLE = 0.5, NEAR_ABSTRACT = 0.1;
/** at most this many first versions are fetched for one document */
const FIRST_VERSION_CHECKS = 2;

/**
 * Results that were not accepted but look close, and have more than one version. A paper can be
 * renamed and have its abstract rewritten after RAID's snapshot, and then only its first version
 * still reads like RAID's copy. An old-style id (quant-ph/0211021) is left out: arXiv's API answers
 * its versioned form with a server error every time (checked 2026-09-17), so its first version
 * cannot be fetched, and asking would only stop the run. Such a paper stays unmatched unless a
 * search finds it by title or abstract.
 */
export function nearMisses(doc: Doc, entries: Entry[]): Entry[] {
  return entries
    .filter((e) => e.version > 1 && !e.id.includes('/'))
    .map((e) => ({ e, score: titleSimilarity(doc.title, e.title), ov: doc.human ? overlap(doc.human, e.summary) : 0 }))
    .filter((s) => s.score >= NEAR_TITLE || s.ov >= NEAR_ABSTRACT)
    .sort((a, b) => b.score + b.ov - (a.score + a.ov))
    .slice(0, FIRST_VERSION_CHECKS)
    .map((s) => s.e);
}
export const oaiUrl = (id: string): string =>
  `${OAI}?verb=GetRecord&identifier=${encodeURIComponent(`oai:arXiv.org:${id}`)}&metadataPrefix=arXivRaw`;

export interface Http { get(url: string): Promise<string>; sent: number }

export interface ClientOptions {
  /** where answers are kept between runs; null keeps nothing */
  cacheDir: string | null;
  /** gap between the end of one answer and the next request; never below MIN_GAP_MS */
  gapMs?: number;
  retries?: number;
  /** ask again for a cached search that found nothing */
  refreshEmpty?: boolean;
  fetchImpl?: (url: string, init: RequestInit) => Promise<Response>;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

const cacheName = (url: string): string =>
  `${url.startsWith(OAI) ? 'oai' : 'api'}-${createHash('sha256').update(url).digest('hex').slice(0, 24)}.xml`;

/** a well-formed answer worth keeping: an Atom feed that is not an error, or an OAI-PMH document */
const keepable = (body: string): boolean =>
  (/<feed[\s>]/.test(body) && !/\/api\/errors/.test(body)) || /<OAI-PMH[\s>]/.test(body);
const emptyFeed = (body: string): boolean => /<feed[\s>]/.test(body) && !/<entry>/.test(body);

/**
 * A client that sends one request at a time, waits at least the gap after each answer, backs off
 * on 429 and 5xx (honouring Retry-After), and keeps every good answer on disk.
 */
export function politeClient(o: ClientOptions): Http {
  const gap = Math.max(MIN_GAP_MS, o.gapMs ?? MIN_GAP_MS);
  const retries = o.retries ?? 6;
  const doFetch = o.fetchImpl ?? ((url: string, init: RequestInit) => fetch(url, init));
  const sleep = o.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const now = o.now ?? Date.now;
  let last = Number.NEGATIVE_INFINITY;
  // requests are chained, so two callers can never have two requests open at once
  let queue: Promise<unknown> = Promise.resolve();

  async function send(url: string): Promise<string> {
    for (let attempt = 0; ; attempt++) {
      const wait = last + gap - now();
      if (wait > 0) await sleep(wait);
      client.sent++;
      let r: Response | null = null;
      let failure: unknown = null;
      try {
        r = await doFetch(url, { headers: { 'user-agent': USER_AGENT, accept: 'application/atom+xml, application/xml, text/xml' } });
      } catch (e) {
        failure = e;
      }
      let body: string | null = null;
      if (r?.ok) {
        try { body = await r.text(); } catch (e) { failure = e; }
      }
      last = now();
      if (body !== null) return body;
      // an unread body keeps the connection busy
      await r?.body?.cancel().catch(() => undefined);
      const status = r?.status ?? 0;
      if (r && !(status === 429 || status >= 500)) throw new Error(`${status} ${r.statusText} for ${url}`);
      if (attempt >= retries) throw new TransientError(`gave up after ${attempt + 1} tries on ${url}: ${r ? status : (failure as Error)?.message}`);
      const after = Number(r?.headers.get('retry-after'));
      await sleep(Number.isFinite(after) && after > 0 ? after * 1000 : 5000 * 2 ** attempt);
    }
  }

  const client: Http = {
    sent: 0,
    get(url: string): Promise<string> {
      const file = o.cacheDir ? path.join(o.cacheDir, cacheName(url)) : null;
      if (file && existsSync(file)) {
        const cached = readFileSync(file, 'utf8');
        if (!(o.refreshEmpty && emptyFeed(cached))) return Promise.resolve(cached);
      }
      const run = queue.then(async () => {
        const body = await send(url);
        if (file && keepable(body)) {
          mkdirSync(path.dirname(file), { recursive: true });
          writeFileSync(file, body);
        }
        return body;
      });
      queue = run.catch(() => undefined);
      return run;
    },
  };
  return client;
}

/** The searches for one document, from the most precise to the widest. */
export function searchesFor(doc: Doc): { query: string; max: number }[] {
  const out: { query: string; max: number }[] = [];
  const terms = titleTerms(doc.title, 12);
  if (terms.length) out.push({ query: terms.slice(0, 8).map((t) => `ti:${t}`).join(' AND '), max: 10 });
  // a renamed paper keeps most of its title words, and relevance ranking puts it near the top
  if (terms.length > 1) out.push({ query: terms.map((t) => `ti:${t}`).join(' OR '), max: 25 });
  const phrase = doc.human ? abstractPhrase(doc.human) : null;
  if (phrase) out.push({ query: `abs:"${phrase}"`, max: 10 });
  return out;
}

/**
 * Find one document on arXiv and date it. The searches of searchesFor are sent in turn, each only
 * when the ones before found nothing acceptable; after them, the first versions of up to two near
 * misses. The history is fetched only when the newest version could put the paper inside the
 * window, unless `fullHistory` asks for all of it.
 */
export async function lookup(doc: Doc, http: Http, opts: { fullHistory?: boolean; window?: Window } = {}): Promise<DateRow> {
  const w = opts.window ?? WINDOW;
  const base = { source_id: doc.source_id, arxiv_id: null, title: oneLine(doc.title) };
  let found: Match | null = null;
  let tooLate: Entry | null = null;
  const seen = new Map<string, Entry>();
  for (const { query, max } of searchesFor(doc)) {
    const entries = parseAtom(await http.get(searchUrl(query, max)));
    // a paper first posted after RAID was built cannot be where RAID's text came from
    const possible = entries.filter((e) => e.published <= w.to);
    found = pickMatch(doc, possible);
    if (found) break;
    for (const e of possible) if (!seen.has(e.id)) seen.set(e.id, e);
    tooLate ??= pickMatch(doc, entries.filter((e) => e.published > w.to))?.entry ?? null;
  }
  for (const near of found ? [] : nearMisses(doc, [...seen.values()])) {
    const first = parseAtom(await http.get(firstVersionUrl(near.id)))[0];
    if (!first || first.id !== near.id) continue;
    const m = pickMatch(doc, [first]);
    // the newest version is what the history and the title column describe
    if (m) { found = { entry: near, how: 'first-version', overlap: m.overlap }; break; }
  }
  if (!found) {
    const reason = tooLate
      ? `the only matching record, ${tooLate.id}, was first posted ${tooLate.published}, after RAID was built`
      : 'no arXiv record found by title or abstract';
    return { ...base, versions: [], excluded: false, reason };
  }

  const e = found.entry;
  let versions: Version[];
  let history: 'full' | 'first-and-last' = 'full';
  if (e.version === 1) {
    versions = [{ v: 1, date: e.published }];
  } else if (e.updated < w.from && !opts.fullHistory) {
    // every version lies between the first and the newest, and the newest predates the window
    versions = [{ v: 1, date: e.published }, { v: e.version, date: e.updated }];
    history = 'first-and-last';
  } else {
    const record = parseOai(await http.get(oaiUrl(e.id)));
    if (!record) {
      // Not a guess either way: without the history the paper cannot be excluded, and the answer is
      // cached, so stopping here would stop every later run at this document too. It is kept and
      // counted with the documents that could not be dated.
      return {
        ...base,
        arxiv_id: e.id,
        ...(normTitle(e.title) === normTitle(doc.title) ? {} : { arxiv_title: e.title }),
        match: found.how,
        abstract_overlap: found.overlap === null ? null : Math.round(found.overlap * 100) / 100,
        versions: [],
        excluded: false,
        reason: `OAI-PMH has no record for ${e.id}, which the search API returned; its versions are unknown, so it is kept undated`,
      };
    }
    versions = record.versions;
  }

  return {
    ...base,
    arxiv_id: e.id,
    ...(normTitle(e.title) === normTitle(doc.title) ? {} : { arxiv_title: e.title }),
    match: found.how,
    abstract_overlap: found.overlap === null ? null : Math.round(found.overlap * 100) / 100,
    versions,
    history,
    ...decide(versions, w),
  };
}

/** the row for a document the lookup was told to pass over, after it failed the same way twice */
export function skippedRow(doc: Doc): DateRow {
  return { source_id: doc.source_id, arxiv_id: null, title: oneLine(doc.title), versions: [], excluded: false, reason: 'skipped by hand (--skip) after the lookup failed on it; kept undated' };
}

/** The dates file as consumers need it: which documents are out, and which could not be dated. */
export interface DatesFile {
  complete: boolean;
  window: Window;
  /**
   * `unmatched` is every document that is not dated, whether no paper was found, arXiv had no history
   * for the one found (`no_history`), or the document was passed over with --skip (`skipped`).
   */
  counts: { documents: number; matched: number; unmatched: number; excluded: number; no_history?: number; skipped?: number };
  documents: DateRow[];
}

/** the counts written into the file, from its rows */
export function countRows(rows: DateRow[], skipped: Set<string> = new Set()): DatesFile['counts'] {
  const matched = rows.filter(isDated).length;
  return {
    documents: rows.length,
    matched,
    unmatched: rows.length - matched,
    excluded: rows.filter((r) => r.excluded).length,
    no_history: rows.filter((r) => r.arxiv_id && !r.versions.length).length,
    skipped: rows.filter((r) => skipped.has(r.source_id)).length,
  };
}

export function readDates(file = path.resolve('data/abstracts-dates.json')): { file: DatesFile; excluded: Set<string>; unmatched: Set<string> } | null {
  if (!existsSync(file)) return null;
  const parsed = JSON.parse(readFileSync(file, 'utf8')) as DatesFile;
  return {
    file: parsed,
    excluded: new Set(parsed.documents.filter((d) => d.excluded).map((d) => d.source_id)),
    unmatched: new Set(parsed.documents.filter((d) => !isDated(d)).map((d) => d.source_id)),
  };
}

/** One row per line, so a re-run's diff shows which documents changed. */
export function serialize(meta: Omit<DatesFile, 'documents'> & Record<string, unknown>, rows: DateRow[]): string {
  const head = JSON.stringify(meta, null, 1).replace(/\n}$/, '');
  return `${head},\n "documents": [\n${rows.map((r) => `  ${JSON.stringify(r)}`).join(',\n')}\n ]\n}\n`;
}

/** Deterministic sample, so a validation run can be repeated. */
function seededSample<T>(items: T[], n: number, seed: number): T[] {
  let s = seed >>> 0;
  const rnd = (): number => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const pool = [...items];
  for (let i = pool.length - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1));
    [pool[i], pool[j]] = [pool[j]!, pool[i]!];
  }
  return pool.slice(0, n);
}

interface TitleSource { source_id?: unknown; title?: unknown }

function loadTitles(files: string[], explicit: boolean): Map<string, string> {
  const out = new Map<string, string>();
  for (const f of files) {
    if (!existsSync(f)) {
      if (explicit) throw new Error(`${f} does not exist`);
      console.error(`  (skipping ${f}: not found)`);
      continue;
    }
    const parsed = JSON.parse(readFileSync(f, 'utf8')) as TitleSource[] | { texts?: TitleSource[] };
    const items = Array.isArray(parsed) ? parsed : parsed.texts ?? [];
    let added = 0;
    for (const it of items) {
      if (typeof it.source_id !== 'string' || typeof it.title !== 'string' || out.has(it.source_id)) continue;
      out.set(it.source_id, it.title);
      added++;
    }
    console.error(`  ${items.length} titles in ${path.relative(process.cwd(), f)}, ${added} not seen before`);
  }
  return out;
}

function loadHuman(file: string): Map<string, string> {
  if (!existsSync(file)) {
    console.error(`  (no human texts at ${file}: renamed papers cannot be confirmed)`);
    return new Map();
  }
  const rows = JSON.parse(readFileSync(file, 'utf8')) as { id: string; text: string }[];
  return new Map(rows.map((r) => [String(r.id).replace(/^[a-z0-9]+:[a-z0-9._-]+:/, ''), r.text]));
}

if (process.argv[1] && process.argv[1].endsWith('arxiv-dates.ts')) {
  const { values } = parseArgs({
    options: {
      titles: { type: 'string', multiple: true },
      human: { type: 'string', default: 'out/raid-human.json' },
      out: { type: 'string' },
      sample: { type: 'string' },
      'full-history': { type: 'boolean', default: false },
      'refresh-empty': { type: 'boolean', default: false },
      skip: { type: 'string', multiple: true },
    },
  });
  const skip = new Set(values.skip ?? []);
  const sample = values.sample ? Number(values.sample) : null;
  if (sample !== null && !(Number.isInteger(sample) && sample > 0)) throw new Error('--sample takes a positive whole number');
  // a sample must never land where the committed file lives
  const outFile = path.resolve(values.out ?? (sample ? 'out/abstracts-dates-sample.json' : 'data/abstracts-dates.json'));

  const titleFiles = (values.titles ?? ['out/raid-prompts.json', 'data/generated/claude-abstracts.json']).map((f) => path.resolve(f));
  const titles = loadTitles(titleFiles, Boolean(values.titles));
  const human = loadHuman(path.resolve(values.human));
  let docs: Doc[] = [...titles].map(([source_id, title]) => {
    const text = human.get(source_id);
    return text ? { source_id, title, human: text } : { source_id, title };
  });
  if (sample) docs = seededSample(docs, sample, 20260917);
  docs.sort((a, b) => a.source_id.localeCompare(b.source_id));

  const http = politeClient({ cacheDir: path.resolve('out/cache/arxiv'), refreshEmpty: values['refresh-empty'] });
  console.error(`${docs.length} documents; at one request per ${MIN_GAP_MS / 1000} s or slower, and 1 to 4 requests each, allow ${Math.ceil((docs.length * 1.3 * 3.6) / 60)} minutes or more on a cold cache`);
  const started = Date.now();
  const rows: DateRow[] = [];
  for (const [i, doc] of docs.entries()) {
    const before = http.sent;
    let row: DateRow;
    try {
      row = skip.has(doc.source_id) ? skippedRow(doc) : await lookup(doc, http, { fullHistory: values['full-history'] });
    } catch (e) {
      // nothing is written, so a half-done file never stands in for the whole one
      console.error(`\nstopped at document ${i + 1} of ${docs.length} (${doc.source_id}): ${(e as Error).message}`);
      console.error('every answer so far is cached under out/cache/arxiv.');
      console.error(e instanceof TransientError
        ? `the host could not be reached or kept refusing; run the same command again later to resume, and if it stops at this document again, add --skip ${doc.source_id}`
        : `this document will fail the same way on the next run; to finish without it, run again with --skip ${doc.source_id} (it is then kept undated and counted)`);
      process.exit(1);
    }
    rows.push(row);
    const newest = row.versions.at(-1);
    console.error(
      `[${String(i + 1).padStart(String(docs.length).length)}/${docs.length}] ${http.sent - before} req  ` +
      `${(row.arxiv_id ?? '-').padEnd(16)} ${(newest ? `v${newest.v} ${newest.date}` : '').padEnd(14)} ` +
      `${(row.match ?? 'unmatched').padEnd(14)} ${row.excluded ? 'EXCLUDED ' : '         '}${row.title.slice(0, 70)}`,
    );
  }

  const matched = rows.filter(isDated);
  const counts = countRows(rows, skip);
  const byHow = matched.reduce<Record<string, number>>((m, r) => ((m[r.match!] = (m[r.match!] ?? 0) + 1), m), {});
  mkdirSync(path.dirname(outFile), { recursive: true });
  writeFileSync(outFile, serialize({
    about: 'arXiv dates for the RAID abstracts. A document is excluded when any version of its paper was posted inside the window: RAID may hold that version, written after ChatGPT. Documents that could not be dated (no paper found, no history for the paper found, or skipped by hand) are kept and counted as unmatched.',
    source: 'arXiv API search (https://export.arxiv.org/api/query) and OAI-PMH arXivRaw (https://oaipmh.arxiv.org/oai); arXiv metadata is CC0, https://info.arxiv.org/help/api/tou.html',
    generated_on: new Date().toISOString().slice(0, 10),
    script: 'scripts/arxiv-dates.ts',
    title_files: titleFiles.map((f) => path.relative(process.cwd(), f).split(path.sep).join('/')),
    window: { ...WINDOW },
    window_why: 'from: ChatGPT released; to: Last-Modified of RAID train_none.csv, so a later version cannot be the text RAID holds',
    complete: sample === null,
    ...(sample === null ? {} : { sample }),
    counts,
    matched_by: byHow,
  }, rows));

  const minutes = ((Date.now() - started) / 60000).toFixed(1);
  console.log(`\n${counts.documents} documents, ${http.sent} requests, ${minutes} min`);
  console.log(`matched ${counts.matched} (${(100 * counts.matched / Math.max(1, counts.documents)).toFixed(0)}%): ${Object.entries(byHow).map(([k, v]) => `${v} by ${k}`).join(', ')}`);
  console.log(`excluded ${counts.excluded}; not dated ${counts.unmatched} (${counts.no_history} with no history, ${counts.skipped} skipped)`);
  for (const r of rows.filter((x) => x.excluded)) console.log(`  excluded  ${r.arxiv_id}  ${r.reason}  ${r.title.slice(0, 60)}`);
  for (const r of rows.filter((x) => !isDated(x))) console.log(`  unmatched ${r.source_id}  ${r.title.slice(0, 80)}  (${r.reason})`);
  for (const r of rows.filter((x) => x.arxiv_title)) console.log(`  renamed   ${r.arxiv_id}  "${r.title.slice(0, 50)}" -> "${r.arxiv_title!.slice(0, 50)}"  overlap ${r.abstract_overlap}`);
  const low = rows.filter((x) => x.match === 'title' && x.abstract_overlap !== null && x.abstract_overlap !== undefined && x.abstract_overlap < 0.25);
  for (const r of low) console.log(`  check     ${r.arxiv_id}  same title, abstract overlap only ${r.abstract_overlap}  ${r.title.slice(0, 60)}`);
  console.log(`wrote ${path.relative(process.cwd(), outFile)}`);
}
