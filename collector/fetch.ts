/**
 * Builds the corpora. Everything here is public, dated or permissively licensed, and free.
 *
 *   npx tsx collector/fetch.ts [--want 4000]
 *
 * Four arms:
 *   casual-human   Hacker News comments posted before 2022-11-30, the day ChatGPT opened. Human by
 *                  construction: the timestamp is the proof, and no argument about it is possible.
 *   careful-human  Stack Exchange answers (english, academia, writing) from the same period. Human,
 *                  and edited: this is the arm that tells a machine marker from a careful-writing
 *                  marker, and it is the column nobody publishes.
 *   machine-2023   HC3's chatgpt_answers (GPT-3.5, early 2023, CC BY-SA 4.0).
 *   machine-2024   RAID's gpt4 generations (MIT), read from the published parquet in CI.
 *
 * What lands in the repository: ids and computed numbers, never the corpus text. Hacker News
 * licenses its content to YC, not to me; Stack Exchange answers are CC BY-SA and would need
 * attribution per answer. The fetch script plus the ids is enough for a reader to rebuild the
 * exact corpus, which is the part that matters.
 */
import { writeFileSync, mkdirSync, existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

/** 2022-11-30 00:00 UTC: ChatGPT's release. Everything before it is human. */
export const CUTOFF = 1669766400;
const OUT = path.resolve('out');

export interface Fetched { id: string; at?: number; text: string }

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

const NAMED: Record<string, string> = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: '\u00a0', shy: '', hellip: '…',
  mdash: '—', ndash: '–', lsquo: '‘', rsquo: '’', ldquo: '“', rdquo: '”', laquo: '«', raquo: '»',
  bull: '•', middot: '·', times: '×', minus: '−', deg: '°',
};

/**
 * What a browser shows for &#128; to &#159;: old pages mean Windows-1252 there, and that range is
 * where the dashes and curly quotes live, which are exactly what the markers count.
 */
const CP1252 = '€\x81‚ƒ„…†‡ˆ‰Š‹Œ\x8DŽ\x8F\x90‘’“”•–—˜™š›œ\x9DžŸ';

/**
 * Named and numeric character references, in one pass so "&amp;lt;" stays "&lt;". Hacker News
 * writes every slash as &#x2F;, and left encoded each one counted as the two words "x" and "f".
 * An unknown name is left as written.
 */
export function decodeEntities(s: string): string {
  return s.replace(/&(?:#[xX]([0-9a-fA-F]{1,6})|#(\d{1,7})|([a-zA-Z][a-zA-Z0-9]{1,31}));/g, (m, hex?: string, dec?: string, name?: string) => {
    if (name !== undefined) return NAMED[name] ?? m;
    const cp = hex !== undefined ? parseInt(hex, 16) : Number(dec);
    if (cp >= 0x80 && cp <= 0x9f) return CP1252[cp - 0x80]!;
    if (cp === 0 || cp > 0x10ffff || (cp >= 0xd800 && cp <= 0xdfff)) return '\ufffd';
    return String.fromCodePoint(cp);
  });
}

/**
 * Plain text as the markers read it: entities decoded, one space for any run of spaces or tabs, and
 * the line breaks kept. Several markers only exist at the start of a line (a "## Heading", a
 * "- **bold**" bullet), and a text squeezed onto one line can never show them. Blank lines are kept
 * as paragraph breaks, and anything longer is shortened to one. A plain-text source also has lines
 * that only wrap, which sourceText joins.
 */
export function plainText(s: string): string {
  return decodeEntities(s)
    .replace(/\r\n?/g, '\n')
    .replace(/[^\S\n]+/g, ' ')
    .replace(/ ?\n ?/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

const ITEM_LINE = /^(?:[-*•+]|\d{1,2}[.)]) /;
const HEADING_LINE = /^#{1,6} /;

/**
 * The line breaks of plainText's output that carry structure, and none that only wrap. RAID's human
 * abstracts come wrapped at 79 columns and the models' texts do not, so a wrap inside
 * "segmentation, tracking and diagnosis" hid the phrase from every pattern with a space in it, on the
 * human side only. A single line break becomes a space unless it is part of a blank line or has a
 * heading or a list item on either side. A line that starts like an item is one only after a line
 * that ends a sentence or a lead-in, inside a list, or before another item; otherwise it is a "- "
 * that a wrap happened to put first.
 */
export function joinWraps(t: string): string {
  const lines = t.split('\n');
  let out = lines[0] ?? '';
  // whether the line being built, which may already hold wrapped lines, is a list item
  let inItem = ITEM_LINE.test(out);
  for (let i = 1; i < lines.length; i++) {
    const prev = lines[i - 1]!, cur = lines[i]!, next = lines[i + 1];
    const item = ITEM_LINE.test(cur) && (prev === '' || /[.:!?;]$/.test(prev) || inItem || (next !== undefined && ITEM_LINE.test(next)));
    const breaks = cur === '' || prev === '' || item || HEADING_LINE.test(cur) || HEADING_LINE.test(prev);
    out += (breaks ? '\n' : ' ') + cur;
    if (breaks) inItem = item;
  }
  return out;
}

/** a plain-text source (RAID, HC3) as the markers read it */
export const sourceText = (s: string): string => joinWraps(plainText(s));

/**
 * How much prose a text holds, for the 400-character gate. The Markdown written back and the line
 * structure are not prose, and a few answers passed the gate on them alone.
 */
export const proseLength = (text: string): number =>
  text.replace(/\*\*|^#{1,6} |^(?:[-*•+]|\d{1,2}[.)]) /gm, '').replace(/\s+/g, ' ').trim().length;

/**
 * Other people's words and things that are not prose. A <blockquote> is the question, a dictionary
 * entry or a court ruling being quoted, and <pre>/<code> is a program or an ASCII table (one table
 * alone was a fifth of the careful arm's "---" dashes). Blockquotes nest, and a lazy match stops at
 * the inner closing tag and keeps the outer quote's tail, so they are removed by depth instead.
 * What was removed leaves a <br>, so the text on either side still ends and starts a line.
 */
function dropQuotesAndCode(html: string): string {
  const s = html.replace(/<pre\b[\s\S]*?<\/pre\s*>/gi, '<br>').replace(/<code\b[\s\S]*?<\/code\s*>/gi, ' ');
  let depth = 0, out = '';
  s.split(/(<\/?blockquote\b[^>]*>)/i).forEach((part, i) => {
    if (i % 2 === 0) { if (depth === 0) out += part; return; }
    depth = part[1] === '/' ? Math.max(0, depth - 1) : depth + 1;
    out += '<br>';
  });
  return out;
}

/**
 * Hacker News has no blockquote: a quote is a line typed with ">" in front. Only that line goes,
 * not its paragraph, because a reply often follows the quote after a single line break; a quote
 * pasted with its own wraps goes on in indented lines, and those go with it. Stack Exchange bodies
 * have no such lines once their blockquotes are gone (0 in 1,600), so this runs for every HTML arm
 * alike. It has to run after <pre> is removed, since code can hold a ">" line.
 */
function dropQuotedLines(html: string): string {
  return html.split(/(<p\b[^>]*>|<br\s*\/?>)/i).map((part, i) => {
    if (i % 2) return part;
    let quoting = false;
    return part.split('\n').filter((line) => {
      const text = line.replace(/<[^>]+>/g, '');
      quoting = /^\s*(?:&gt;|>)/.test(text) || (quoting && /^\s+\S/.test(text));
      return !quoting;
    }).join('\n');
  }).join('');
}

/**
 * A list item as its Markdown: "- " in a bulleted list, "1. ", "2. " in a numbered one, so a numbered
 * list reads as it does in the plain-text arms and the bulleted-list marker does not take it for a
 * bulleted one. Lists nest, so an item belongs to the innermost list still open.
 */
function listItems(html: string): string {
  const open: { numbered: boolean; n: number }[] = [];
  return html.replace(/<(\/?)(ol|ul)\b[^>]*>|<li\b[^>]*>\s*(?:<p\b[^>]*>)?/gi, (tag, close?: string, kind?: string) => {
    if (kind) {
      if (close) open.pop(); else open.push({ numbered: kind.toLowerCase() === 'ol', n: 0 });
      return tag;
    }
    const list = open[open.length - 1];
    return list?.numbered ? `\n${++list.n}. ` : '\n- ';
  });
}

const BLOCK = /<\/?(?:div|br|hr|h[1-6]|li|ul|ol|dl|dt|dd|blockquote|pre|table|tr|section|article|aside|header|footer|figure|figcaption|details|summary)\b[^>]*>/gi;

/**
 * HTML to the text its writer wrote, the same way for every HTML arm so no arm is advantaged by its
 * formatting. Line structure comes from the elements, as it does in a browser: whitespace in the
 * source is one space (a hard-wrapped Markdown paragraph is still one paragraph, and 263 of 1,600
 * Stack Exchange bodies have one), while line breaks and list items start a new line and a paragraph
 * leaves a blank one, whether Stack Exchange closes it or Hacker News only opens the next.
 * Headings, list items and bold are written back as the Markdown they came from, so the markers that
 * look for them see what the reader saw. Other inline tags vanish without a space, so
 * "<em>a</em>, <em>b</em>" reads "a, b" and not "a , b".
 * An unspaced "--" between two words is a dash typed without one ("him--he won", "forth--I am"), as
 * all 77 in 5,200 cached answers and comments were, and becomes one. The TeX arms use "--" for
 * ranges and joined names, but they are plain text and never come here.
 */
export function toText(html: string): string {
  const s = listItems(dropQuotedLines(dropQuotesAndCode(html.replace(/<!--[\s\S]*?-->/g, '')))
    .replace(/\s+/g, ' ')
    .replace(/<\/li\s*>\s*(?=<li\b)/gi, ''))
    .replace(/<h([1-6])\b[^>]*>/gi, (_, n: string) => `\n${'#'.repeat(Number(n))} `)
    .replace(/<(?:strong|b)\b[^>]*>(\s*)/gi, '$1**')
    .replace(/(\s*)<\/(?:strong|b)\s*>/gi, '**$1')
    .replace(/<\/?p\b[^>]*>/gi, '\n\n')
    .replace(BLOCK, '\n')
    .replace(/<\/?t[dh]\b[^>]*>/gi, ' ')
    .replace(/<[^>]+>/g, '');
  return plainText(s).replace(/(?<=[A-Za-z])--(?=[A-Za-z])/g, '—');
}

async function getJson(url: string, tries = 4): Promise<any | null> {
  for (let i = 0; i < tries; i++) {
    const r = await fetch(url, { headers: { 'user-agent': 'is-it-really-an-ai-tell/0.1 (+https://github.com/barbarkaragul-oss/is-it-really-an-ai-tell)' } });
    if (r.ok) return r.json();
    if (r.status === 429 || r.status >= 500) { await sleep(1500 * (i + 1)); continue; }
    console.error(`  ${r.status} ${url.slice(0, 80)}`);
    return null;
  }
  return null;
}

/**
 * Algolia answers at most 1000 hits for one query however you page it, and pages past that come
 * back as an empty object rather than an error. So walk backwards in time instead, using the
 * oldest timestamp on each page as the next cursor.
 */
export async function hackerNews(want: number): Promise<Fetched[]> {
  const out: Fetched[] = [], seen = new Set<string>();
  let cursor = CUTOFF, guard = 0;
  while (out.length < want && guard++ < 200) {
    const j = await getJson(`https://hn.algolia.com/api/v1/search_by_date?tags=comment&numericFilters=created_at_i<${cursor}&hitsPerPage=1000`);
    const hits: any[] = j?.hits ?? [];
    if (!hits.length) break;   // the empty page is how this API says "no more"
    for (const h of hits) {
      if (seen.has(h.objectID)) continue;
      seen.add(h.objectID);
      const text = toText(h.comment_text ?? '');
      if (proseLength(text) >= 400) out.push({ id: String(h.objectID), at: h.created_at_i, text });
    }
    const oldest = Math.min(...hits.map((h) => h.created_at_i as number));
    if (!(oldest < cursor)) break;
    cursor = oldest;
    await sleep(350);
  }
  return out.slice(0, want);
}

/** Stack Exchange: 300 requests a day unauthenticated, 100 answers a page, filtered by date. */
export async function stackExchange(site: string, want: number): Promise<Fetched[]> {
  const out: Fetched[] = [];
  for (let page = 1; out.length < want && page <= 25; page++) {
    const j = await getJson(`https://api.stackexchange.com/2.3/answers?site=${site}&pagesize=100&page=${page}&filter=withbody&sort=creation&order=desc&todate=${CUTOFF}`);
    if (!j || j.error_id) { if (j?.error_message) console.error('  se:', j.error_message); break; }
    for (const a of j.items ?? []) {
      const text = toText(a.body ?? '');
      if (proseLength(text) >= 400) out.push({ id: `${site}:${a.answer_id}`, at: a.creation_date, text });
    }
    if (!j.has_more) break;
    await sleep(400);
  }
  return out.slice(0, want);
}

/**
 * HC3 through the rows endpoint, so no parquet reader is needed for the small arm. Its answers are
 * plain text, not HTML: run through toText, a "<" in them would take everything up to the next ">"
 * with it, and every line break would be read as source whitespace. They are read as RAID's are.
 */
export async function hc3(want: number, field: 'chatgpt_answers' | 'human_answers'): Promise<Fetched[]> {
  const out: Fetched[] = [];
  for (let offset = 0; out.length < want; offset += 100) {
    const j = await getJson(`https://datasets-server.huggingface.co/rows?dataset=Hello-SimpleAI%2FHC3&config=all&split=train&offset=${offset}&length=100`);
    const rows: any[] = j?.rows ?? [];
    if (!rows.length) break;
    for (const { row } of rows) {
      for (const a of (row[field] ?? []) as string[]) {
        const text = sourceText(a);
        if (proseLength(text) >= 400) out.push({ id: `hc3:${offset}:${out.length}`, text });
      }
    }
    await sleep(250);
  }
  return out.slice(0, want);
}

function save(name: string, rows: Fetched[]): void {
  if (!existsSync(OUT)) mkdirSync(OUT, { recursive: true });
  writeFileSync(path.join(OUT, `${name}.json`), JSON.stringify(rows));
  console.error(`  ${name}: ${rows.length} texts`);
}

function load(name: string): Fetched[] | null {
  const f = path.join(OUT, `${name}.json`);
  return existsSync(f) ? (JSON.parse(readFileSync(f, 'utf8')) as Fetched[]) : null;
}

async function cached(name: string, want: number, fn: () => Promise<Fetched[]>): Promise<Fetched[]> {
  const have = load(name);
  if (have && have.length >= want) { console.error(`  ${name}: ${have.length} texts (already fetched)`); return have; }
  const rows = await fn();
  save(name, rows);
  return rows;
}

if (process.argv[1] && process.argv[1].endsWith('fetch.ts')) {
  const want = Number(process.argv.includes('--want') ? process.argv[process.argv.indexOf('--want') + 1] : 4000);
  console.error(`fetching about ${want} texts per arm:`);
  await cached('casual-human', want, () => hackerNews(want));
  const per = Math.ceil(want / 3);
  const se: Fetched[] = [];
  for (const site of ['english', 'academia', 'writing']) se.push(...await cached(`se-${site}`, per, () => stackExchange(site, per)));
  save('careful-human', se);
  await cached('machine-2023', want, () => hc3(want, 'chatgpt_answers'));
  console.error('done; out/ holds the texts and is not committed');
}
