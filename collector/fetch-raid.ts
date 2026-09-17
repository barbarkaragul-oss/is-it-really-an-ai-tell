/**
 * The matched arms: one document, several writers.
 *
 *   npx tsx collector/fetch-raid.ts [--want 2500] [--models gpt4,chatgpt,llama-chat]   research abstracts
 *   npx tsx collector/fetch-raid.ts --genre posts [--record-windows]                    Reddit posts
 *
 * RAID (Dugan et al., ACL 2024, MIT) holds a human document and each model's continuation of that
 * same document, keyed by `source_id`, across news, abstracts, books and poetry. Taking every
 * writer for the same set of keys gives a comparison with genre, topic and prompt held constant,
 * so a difference is about the writer and not about the subject. It also settles the generation
 * question properly: RAID's `chatgpt` rows are GPT-3.5 answering the same prompts as its `gpt4`
 * rows, which is the comparison the 2023-vintage corpora cannot make.
 *
 * Only `attack: none` rows are used. The rest are adversarially perturbed on purpose -- homoglyphs,
 * inserted whitespace, deliberate misspellings -- and measuring style markers there would measure
 * the attack. Of each model's texts, only the ones written with greedy decoding and no repetition
 * penalty are used (collector/raid-csv.ts, MAIN_SETTING), for every genre.
 *
 * Abstracts come from the published parquet, 2.3 GB over ten shards, none of it downloaded whole:
 * each shard's row-group statistics say which groups can hold the wanted rows, and only those are
 * fetched over HTTP range requests, paced by collector/range-buffer.ts so the host is not hammered.
 * That parquet is a partial conversion and has no Reddit posts, so the other genres come from RAID's
 * CSV of unattacked rows, two byte windows per genre (collector/raid-csv.ts, raid-windows.json). The
 * rows kept from those windows are cached in cache/raid/, so a week in which the file did not change
 * costs the host one HEAD request.
 */
import { writeFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parquetMetadataAsync, parquetReadObjects } from 'hyparquet';
import { sourceText, proseLength, type Fetched } from './fetch.js';
import { rangeBuffer, type AsyncBuffer } from './range-buffer.js';
import {
  Host, checkSource, readWindow, namedRow, isMeasuredRow, hasMainSetting, RaidSourceError, ROW_FORMAT, RAID_WRITERS,
  type SourceFile, type Window,
} from './raid-csv.js';

const SHARD = (i: number): string => `https://huggingface.co/api/datasets/liamdugan/raid/parquet/raid/train/${i}.parquet`;
const SHARDS = 10;
const OUT = path.resolve('out');
const COLUMNS = ['source_id', 'model', 'decoding', 'repetition_penalty', 'attack', 'domain', 'title', 'prompt', 'generation'];
/** the writer whose rows decide which documents the whole comparison uses */
const ANCHOR = 'gpt4';

export interface RaidRow { source_id: string; model: string; decoding?: string | null; repetition_penalty?: string | null; attack: string; domain: string; title: string; prompt: string; generation: string }

/** The instruction RAID gave the model for one document, kept so another model can be given the same one. */
export interface RaidPrompt { source_id: string; domain: string; title: string; prompt: string }
type Meta = Awaited<ReturnType<typeof parquetMetadataAsync>>;

/** A row group can only hold a model if its recorded min..max range covers the name. */
function groupsThatMayHold(md: Meta, model: string): number[] {
  const col = md.schema.slice(1).findIndex((s) => s.name === 'model');
  const out: number[] = [];
  md.row_groups.forEach((rg, i) => {
    const st = rg.columns[col]?.meta_data?.statistics;
    if (!st) { out.push(i); return; }                    // no statistics: cannot rule it out
    const min = String(st.min_value ?? ''), max = String(st.max_value ?? '');
    if (min <= model && model <= max) out.push(i);
  });
  return out;
}

/**
 * A generation as the markers read it. It is plain text, not HTML, so it is not given to toText:
 * the abstracts are full of TeX, and a tag stripper reads "$p<0.05$ ... $n>2$" as one tag and
 * deletes everything between. Its paragraph breaks, headings and list items are kept, as the Claude
 * arm (written straight from data/generated) keeps its own, because the markers for headings and
 * bullets look at the start of a line. The human abstracts are also wrapped at 79 columns, and
 * those line breaks are not the writer's: they are joined, as the models' texts have none.
 */
export const generationText = (r: Pick<RaidRow, 'generation'>): string => sourceText(String(r.generation ?? ''));

async function readGroup(file: AsyncBuffer, md: Meta, group: number): Promise<RaidRow[]> {
  let start = 0;
  for (let i = 0; i < group; i++) start += Number(md.row_groups[i]!.num_rows);
  const rows = Number(md.row_groups[group]!.num_rows);
  return (await parquetReadObjects({ file: file as never, metadata: md, columns: COLUMNS, rowStart: start, rowEnd: start + rows })) as unknown as RaidRow[];
}

/** The instruction RAID gave for each anchored document, so another model can be handed the same one. */
export const prompts = new Map<string, RaidPrompt>();

/**
 * Walk the shards for one writer. `only` restricts to a set of documents, which is how every arm
 * after the first is kept to the same documents as the first.
 */
async function collect(model: string, want: number, only: Set<string> | null): Promise<Map<string, Fetched>> {
  const found = new Map<string, Fetched>();
  for (let shard = 0; shard < SHARDS && found.size < want; shard++) {
    const file = await rangeBuffer(SHARD(shard));
    const md = await parquetMetadataAsync(file as never);
    const groups = groupsThatMayHold(md, model);
    if (!groups.length) continue;
    for (const g of groups) {
      if (found.size >= want) break;
      let rows: RaidRow[];
      try { rows = await readGroup(file, md, g); } catch (e) { console.error(`    ${model} shard ${shard} group ${g}: ${(e as Error).message}`); continue; }
      for (const r of rows) {
        if (r.model !== model || r.attack !== 'none' || !hasMainSetting({ model: r.model, decoding: r.decoding ?? '', repetition_penalty: r.repetition_penalty ?? '' })) continue;
        const id = String(r.source_id);
        if (found.has(id) || (only && !only.has(id))) continue;
        const text = generationText(r);
        if (proseLength(text) < 400) continue;
        found.set(id, { id: `raid:${model}:${id}`, text });
        if (model === ANCHOR) prompts.set(id, { source_id: id, domain: String(r.domain ?? ''), title: String(r.title ?? ''), prompt: String(r.prompt ?? '') });
        if (found.size >= want) break;
      }
    }
    console.error(`  ${model}: ${found.size} after shard ${shard}`);
  }
  return found;
}

export async function fetchRaid(models: string[], want: number): Promise<Record<string, Fetched[]>> {
  // the anchor writer decides the documents; every other writer is held to the same ones
  const anchor = await collect(ANCHOR, want, null);
  const keys = new Set(anchor.keys());
  const byModel: Record<string, Map<string, Fetched>> = { [ANCHOR]: anchor };
  for (const m of [...models, 'human']) {
    if (m === ANCHOR || byModel[m]) continue;
    byModel[m] = await collect(m, keys.size, keys);
  }

  // keep only the documents every writer produced, so the arms are matched rather than merely similar
  const common = [...keys].filter((k) => Object.values(byModel).every((m) => m.has(k)));
  console.error(`  ${common.length} documents have every writer (from ${keys.size} anchored on ${ANCHOR})`);
  const out: Record<string, Fetched[]> = {};
  for (const [model, map] of Object.entries(byModel)) out[model] = common.map((k) => map.get(k)!);
  return out;
}

// ---- genres read from the CSV

/**
 * The genres this collector reads from the CSV, with the RAID domain each one is. The registry in
 * scripts/genres.ts says the same; this copy keeps the collector free of the measurement code.
 */
export const CSV_GENRES: Record<string, { domain: string; text: (generation: string) => string }> = {
  posts: { domain: 'reddit', text: (g) => flatText(g) },
};

/** every writer of a CSV genre, human first; the file names are <genre>-<writer>.json */
export const CSV_WRITERS = RAID_WRITERS;

export interface WindowCensus { rows: number; rowsByModel: Record<string, number>; firstId: string; lastId: string }
interface IndexedWindow extends Window, Partial<WindowCensus> { name: string; holds: string }
export interface WindowsIndex {
  about: string;
  file: SourceFile & { lastModified: string; columns: string[] };
  domains: Record<string, { windows: IndexedWindow[] }>;
}

export const WINDOWS_FILE = fileURLToPath(new URL('./raid-windows.json', import.meta.url));
const CACHE = path.resolve('cache/raid');

/**
 * A row kept from a window: the writer's text for one document, before any normalisation. The
 * person's row also keeps the document's title, which the evidence needs to keep a model's text that
 * repeats it off the page; like the posts themselves, it never leaves out/ and cache/.
 */
export interface KeptRow { source_id: string; model: string; generation: string; title?: string }

/** What cache/raid/<domain>.json holds, and what makes it valid: the same file, windows, filter and writers. */
export interface DomainRows {
  format: number;
  file: SourceFile;
  domain: string;
  writers: string[];
  windows: (Window & WindowCensus)[];
  rows: KeptRow[];
}

const sameCensus = (a: Partial<WindowCensus>, b: WindowCensus): boolean =>
  a.rows === b.rows && a.firstId === b.firstId && a.lastId === b.lastId &&
  JSON.stringify(sortKeys(a.rowsByModel ?? {})) === JSON.stringify(sortKeys(b.rowsByModel));

const sortKeys = (o: Record<string, number>): Record<string, number> =>
  Object.fromEntries(Object.entries(o).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));

/**
 * Read a domain's windows and keep its measured rows (collector/raid-csv.ts, isMeasuredRow). Every
 * row in a window must be of the domain, and the rows counted must be the ones the index recorded:
 * with the file pinned, a difference can only mean the reader or the windows are wrong. `record`
 * allows a window without a recorded count, for the one run that writes the counts.
 */
export async function readDomain(index: WindowsIndex, domain: string, host: Host, record = false): Promise<DomainRows> {
  const entry = index.domains[domain];
  if (!entry) throw new RaidSourceError(`collector/raid-windows.json has no windows for the "${domain}" domain`);
  const writers = new Set<string>(CSV_WRITERS);
  const rows: KeptRow[] = [];
  const seen = new Set<string>();
  const windows: DomainRows['windows'] = [];
  for (const w of entry.windows) {
    const census: WindowCensus = { rows: 0, rowsByModel: {}, firstId: '', lastId: '' };
    const t0 = Date.now();
    const read = await readWindow(index.file, w, (fields, start) => {
      const row = namedRow(fields, index.file.columns);
      if (!census.rows && w.firstId !== undefined && row.id !== w.firstId) {
        throw new RaidSourceError(`window ${w.name} of ${domain} starts with row ${row.id}, expected ${w.firstId}`);
      }
      if (row.domain !== domain) throw new RaidSourceError(`window ${w.name} of ${domain} holds a ${row.domain} row at byte ${start}`);
      census.rows++;
      census.rowsByModel[row.model] = (census.rowsByModel[row.model] ?? 0) + 1;
      if (!census.firstId) census.firstId = row.id;
      census.lastId = row.id;
      if (!isMeasuredRow(row, domain, writers)) return;
      const key = `${row.model} ${row.source_id}`;
      if (seen.has(key)) throw new RaidSourceError(`two ${row.model} rows with the main setting for document ${row.source_id}`);
      seen.add(key);
      rows.push(row.model === 'human'
        ? { source_id: row.source_id, model: row.model, generation: row.generation, title: row.title }
        : { source_id: row.source_id, model: row.model, generation: row.generation });
    }, host);
    census.rowsByModel = sortKeys(census.rowsByModel);
    host.log(`  ${domain} window ${w.name}: ${census.rows} rows, ${(read.bytes / 1e6).toFixed(1)} MB in ${((Date.now() - t0) / 1000).toFixed(1)} s, ${read.requests} request(s), ${read.resumed} resumed`);
    if (w.rows === undefined) {
      if (!record) throw new RaidSourceError(`window ${w.name} of ${domain} has no recorded row count; run once with --record-windows`);
    } else if (!sameCensus(w, census)) {
      throw new RaidSourceError(`window ${w.name} of ${domain} holds ${census.rows} rows (${census.firstId} .. ${census.lastId}), the index recorded ${w.rows} (${w.firstId} .. ${w.lastId})`);
    }
    windows.push({ start: w.start, end: w.end, ...census });
  }
  return { format: ROW_FORMAT, file: { url: index.file.url, etag: index.file.etag, size: index.file.size }, domain, writers: [...CSV_WRITERS], windows, rows };
}

/** Whether cached rows were read from this file, these windows, this filter and for these writers. */
export function cacheMatches(cached: DomainRows, index: WindowsIndex, domain: string): boolean {
  const entry = index.domains[domain];
  if (!entry || cached.format !== ROW_FORMAT || cached.domain !== domain) return false;
  if (cached.writers?.join() !== CSV_WRITERS.join()) return false;
  if (cached.file.url !== index.file.url || cached.file.etag !== index.file.etag || cached.file.size !== index.file.size) return false;
  return cached.windows.length === entry.windows.length && entry.windows.every((w, i) => {
    const c = cached.windows[i]!;
    return w.start === c.start && w.end === c.end && w.rows !== undefined && sameCensus(w, c);
  });
}

/**
 * A Reddit post as the markers read it. The human posts reached RAID with no line breaks at all (0 of
 * 1,779; the source dataset joined them), while the models write paragraphs (28% to 99% of texts) and
 * lists (1% to 7%); this puts the models' texts into the same one-line form. Joining lines as they are
 * would turn a bullet into a spaced hyphen and a "---" rule into a dash, both of which the dash marker
 * counts, so rule lines are dropped and list markers, heading marks and bold are taken off each line
 * first. A block that did not end a sentence (a list item, a heading) is closed with a full stop
 * before the next one starts: the markers' sentence splitter ends a sentence at a list item or a
 * blank line, and without the stop a list would become one long sentence on the machine side only.
 * A block ending in a comma ("Thanks," above a name) or an emoji is left open, as it reads on one line.
 *
 * Two more things are done for every writer alike, because the markers would otherwise read them
 * differently on the two sides:
 *  - A post wrapped whole in quotation marks (14 of the Llama and Mistral posts, 1 of the people's) is
 *    unwrapped. Otherwise the belief markers, which skip quoted spans as someone else's words, would
 *    skip the first 300 characters of the writer's own post.
 *  - The dashes people type on Reddit are spaced. A hyphen stuck to the word before it ("the season-
 *    however") and "--" between two words are how many people type a dash there, and the dash marker
 *    counts neither, since in abstracts the first is a word broken at a line end or a suspended
 *    compound and the second a TeX range or name join. In posts no model types either, so leaving them
 *    uncounted undercounted the person alone. A hyphen before "and", "or", "to", "nor", "vs" or
 *    "through" is a suspended compound ("two- and three-year") and stays as it is. The abstracts are
 *    not read through this function, so their dashes are counted as before.
 * On the human side, the rest of this function only decodes entities and tidies spaces.
 */
export function flatText(generation: string): string {
  const blocks: string[] = [];
  for (const raw of unquoted(sourceText(generation)).split('\n')) {
    if (/^\s*(?:[-*_]\s*){3,}$/.test(raw)) continue;
    const line = raw
      .replace(/\*\*/g, '')
      .replace(/^\s*(?:#{1,6}|[-*•+]|\d{1,2}[.)])\s+/, '')
      .trim();
    if (line) blocks.push(line);
  }
  const open = /(?:[.!?:;,…]["'”’)\]]*|\p{Extended_Pictographic}[\u{FE0F}\u{1F3FB}-\u{1F3FF}\u{200D}]*)$/u;
  const flat = blocks.map((b, i) => (i < blocks.length - 1 && !open.test(b) ? `${b}.` : b)).join(' ');
  return flat
    .replace(/(?<=[A-Za-z'’][A-Za-z])- (?!(?:and|or|to|nor|vs|through)\b)(?=[A-Za-z])/g, ' - ')
    .replace(/(?<=[A-Za-z])--(?=[A-Za-z])/g, ' -- ');
}

/**
 * A text without the quotation marks around the whole of it, when it has them: it opens with one and
 * closes with its pair, and every quotation mark inside opens and closes a span of its own, so the
 * outer two belong together. In '"Yes" and "no"' the first mark is closed early, and nothing is
 * taken off. A straight mark opens when nothing but a space or an opening bracket stands before it.
 */
export function unquoted(text: string): string {
  const t = text.trim();
  const curly = /^“[\s\S]+”$/.test(t);
  if (!curly && !/^"[\s\S]+"$/.test(t)) return text;
  const inner = t.slice(1, -1);
  let depth = 0;
  for (let i = 0; i < inner.length; i++) {
    const c = inner[i]!;
    if (curly ? c === '“' : c === '"' && (i === 0 || /[\s([{—–-]/.test(inner[i - 1]!))) depth++;
    else if (curly ? c === '”' : c === '"') depth--;
    if (depth < 0) return text;
  }
  return depth === 0 ? inner.trim() : text;
}

/**
 * The arms of one genre from its kept rows: each writer's text normalised, at least 400 characters
 * of prose, and only the documents every writer has, in the order of the human rows.
 */
export function genreArms(rows: KeptRow[], text: (generation: string) => string): { arms: Record<string, Fetched[]>; kept: Record<string, number>; passed: Record<string, number> } {
  const byWriter = new Map<string, Map<string, string>>(CSV_WRITERS.map((w) => [w, new Map()]));
  const kept: Record<string, number> = {}, passed: Record<string, number> = {};
  const order: string[] = [];
  for (const r of rows) {
    const map = byWriter.get(r.model);
    if (!map) continue;
    kept[r.model] = (kept[r.model] ?? 0) + 1;
    if (r.model === 'human') order.push(r.source_id);
    const t = text(r.generation);
    if (proseLength(t) < 400) continue;
    passed[r.model] = (passed[r.model] ?? 0) + 1;
    map.set(r.source_id, t);
  }
  const common = order.filter((id) => CSV_WRITERS.every((w) => byWriter.get(w)!.has(id)));
  const arms: Record<string, Fetched[]> = {};
  for (const w of CSV_WRITERS) arms[w] = common.map((id) => ({ id: `raid:${w}:${id}`, text: byWriter.get(w)!.get(id)! }));
  return { arms, kept, passed };
}

/** A cache file as far as cacheMatches can read it; anything else, a half-written file included, is no cache. */
export function readCache(file: string): DomainRows | null {
  try {
    const c = JSON.parse(readFileSync(file, 'utf8')) as Partial<DomainRows> | null;
    const ok = c !== null && typeof c === 'object' && Array.isArray(c.rows) && Array.isArray(c.windows) && Array.isArray(c.writers)
      && typeof c.file === 'object' && c.file !== null && typeof c.domain === 'string';
    return ok ? (c as DomainRows) : null;
  } catch {
    return null;
  }
}

export interface RowsOptions {
  /** cache/raid/<domain>.json */
  cacheFile: string;
  /** collector/raid-windows.json, rewritten with the counts when `record` is set */
  windowsFile: string;
  /** read the windows even with a valid cache, and write the counts they hold into the index */
  record?: boolean;
  host?: Host;
  log?: (line: string) => void;
}

/**
 * A domain's kept rows. From the cache when it was read from the pinned file, windows, filter and
 * writers, after one HEAD request: a host that now serves another file is an error, and one that does
 * not answer is not, since nothing needs downloading. Otherwise from the host, and cached. A cache
 * that cannot be read is read again from the host, like one that does not match.
 */
export async function rowsFor(index: WindowsIndex, domain: string, o: RowsOptions): Promise<{ data: DomainRows; from: 'cache' | 'host' }> {
  const host = o.host ?? new Host();
  const log = o.log ?? ((line: string) => console.error(line));
  if (!o.record && existsSync(o.cacheFile)) {
    const cached = readCache(o.cacheFile);
    if (cached && cacheMatches(cached, index, domain)) {
      try {
        await checkSource(index.file, host);
      } catch (e) {
        if (e instanceof RaidSourceError) throw e;
        log(`  could not reach ${index.file.url} (${(e as Error).message}); using the cached rows`);
      }
      log(`  ${domain}: ${cached.rows.length} rows from ${o.cacheFile}`);
      return { data: cached, from: 'cache' };
    }
    log(`  ${o.cacheFile} ${cached ? 'was read from another file, windows or filter' : 'cannot be read'}; reading again`);
  }
  await checkSource(index.file, host);
  const data = await readDomain(index, domain, host, o.record);
  mkdirSync(path.dirname(o.cacheFile), { recursive: true });
  writeFileSync(o.cacheFile, JSON.stringify(data));
  if (o.record) {
    const entry = index.domains[domain]!;
    entry.windows = entry.windows.map((w, i) => ({ ...w, ...data.windows[i]!, name: w.name, holds: w.holds }));
    writeFileSync(o.windowsFile, `${JSON.stringify(index, null, 2)}\n`);
    log(`  recorded the row counts in ${o.windowsFile}`);
  }
  return { data, from: 'host' };
}

/** the title of each document the arms kept, from the person's rows; written to out/ only */
export function titlesOf(rows: KeptRow[], ids: string[]): { source_id: string; title: string }[] {
  const byId = new Map(rows.filter((r) => r.model === 'human').map((r) => [r.source_id, r.title ?? '']));
  return ids.map((id) => ({ source_id: id, title: byId.get(id) ?? '' }));
}

async function csvGenre(genre: string, record: boolean): Promise<void> {
  const spec = CSV_GENRES[genre];
  if (!spec) throw new Error(`unknown genre "${genre}"; the CSV genres are ${Object.keys(CSV_GENRES).join(', ')}`);
  const index = JSON.parse(readFileSync(WINDOWS_FILE, 'utf8')) as WindowsIndex;
  const { data } = await rowsFor(index, spec.domain, { cacheFile: path.join(CACHE, `${spec.domain}.json`), windowsFile: WINDOWS_FILE, record });

  const { arms, kept, passed } = genreArms(data.rows, spec.text);
  if (!existsSync(OUT)) mkdirSync(OUT, { recursive: true });
  for (const w of CSV_WRITERS) {
    const rows = arms[w]!;
    writeFileSync(path.join(OUT, `${genre}-${w}.json`), JSON.stringify(rows));
    console.error(`  wrote ${genre}-${w}: ${rows.length} texts (${kept[w] ?? 0} rows with the main setting, ${passed[w] ?? 0} of them at least 400 characters)`);
  }
  const ids = arms.human!.map((t) => t.id.replace(/^raid:human:/, ''));
  writeFileSync(path.join(OUT, `${genre}-titles.json`), JSON.stringify(titlesOf(data.rows, ids)));
  console.error(`  wrote ${genre}-titles: the titles of the ${ids.length} documents, for the evidence's guard`);
}

if (process.argv[1] && process.argv[1].endsWith('fetch-raid.ts')) {
  const argv = process.argv;
  const arg = (name: string, dflt: string): string => (argv.includes(name) ? (argv[argv.indexOf(name) + 1] ?? dflt) : dflt);
  const genre = arg('--genre', 'abstracts');
  if (genre !== 'abstracts') {
    console.error(`RAID ${genre}: every document, written by ${CSV_WRITERS.join(', ')}`);
    await csvGenre(genre, argv.includes('--record-windows'));
  } else {
    const want = Number(arg('--want', '2500'));
    const models = arg('--models', 'gpt4,chatgpt,llama-chat,mistral-chat').split(',').map((s) => s.trim()).filter(Boolean);
    console.error(`RAID: ${want} documents, written by: human, ${models.join(', ')}`);
    const arms = await fetchRaid(models, want);
    if (!existsSync(OUT)) mkdirSync(OUT, { recursive: true });
    const kept = new Set((arms[ANCHOR] ?? []).map((r) => r.id.replace(`raid:${ANCHOR}:`, '')));
    writeFileSync(path.join(OUT, 'raid-prompts.json'), JSON.stringify([...prompts.values()].filter((p) => kept.has(p.source_id))));
    console.error(`  wrote raid-prompts: ${[...prompts.values()].filter((p) => kept.has(p.source_id)).length} instructions`);
    for (const [model, rows] of Object.entries(arms)) {
      const file = model === 'human' ? 'raid-human' : `raid-${model}`;
      writeFileSync(path.join(OUT, `${file}.json`), JSON.stringify(rows));
      console.error(`  wrote ${file}: ${rows.length} texts`);
    }
  }
}
