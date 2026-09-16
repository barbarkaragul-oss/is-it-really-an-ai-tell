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

/** HTML to plain text, the same way for every arm so no arm is advantaged by its formatting. */
export function toText(s: string): string {
  return s
    .replace(/<\/(p|div|li|h[1-6]|blockquote)>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&quot;/g, '"').replace(/&#x27;|&#39;/g, "'").replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&nbsp;/g, ' ').replace(/&hellip;/g, '…')
    .replace(/\s+/g, ' ')
    .trim();
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
      if (text.length >= 400) out.push({ id: String(h.objectID), at: h.created_at_i, text });
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
      if (text.length >= 400) out.push({ id: `${site}:${a.answer_id}`, at: a.creation_date, text });
    }
    if (!j.has_more) break;
    await sleep(400);
  }
  return out.slice(0, want);
}

/** HC3 through the rows endpoint, so no parquet reader is needed for the small arm. */
export async function hc3(want: number, field: 'chatgpt_answers' | 'human_answers'): Promise<Fetched[]> {
  const out: Fetched[] = [];
  for (let offset = 0; out.length < want; offset += 100) {
    const j = await getJson(`https://datasets-server.huggingface.co/rows?dataset=Hello-SimpleAI%2FHC3&config=all&split=train&offset=${offset}&length=100`);
    const rows: any[] = j?.rows ?? [];
    if (!rows.length) break;
    for (const { row } of rows) {
      for (const a of (row[field] ?? []) as string[]) {
        const text = toText(a);
        if (text.length >= 400) out.push({ id: `hc3:${offset}:${out.length}`, text });
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
