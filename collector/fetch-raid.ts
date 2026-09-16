/**
 * The matched arms: one document, several writers.
 *
 *   npx tsx collector/fetch-raid.ts [--want 2500] [--models gpt4,chatgpt,llama-chat]
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
 * the attack.
 *
 * The published parquet is 2.3 GB over ten shards and none of it is downloaded whole: each shard's
 * row-group statistics say which groups can hold the wanted rows, and only those are fetched over
 * HTTP range requests, paced by collector/range-buffer.ts so the host is not hammered.
 */
import { writeFileSync, existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { parquetMetadataAsync, parquetReadObjects } from 'hyparquet';
import { toText, type Fetched } from './fetch.js';
import { rangeBuffer, type AsyncBuffer } from './range-buffer.js';

const SHARD = (i: number): string => `https://huggingface.co/api/datasets/liamdugan/raid/parquet/raid/train/${i}.parquet`;
const SHARDS = 10;
const OUT = path.resolve('out');
const COLUMNS = ['source_id', 'model', 'attack', 'domain', 'title', 'prompt', 'generation'];
/** the writer whose rows decide which documents the whole comparison uses */
const ANCHOR = 'gpt4';

export interface RaidRow { source_id: string; model: string; attack: string; domain: string; title: string; prompt: string; generation: string }

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

async function readGroup(file: AsyncBuffer, md: Meta, group: number): Promise<RaidRow[]> {
  let start = 0;
  for (let i = 0; i < group; i++) start += Number(md.row_groups[i]!.num_rows);
  const rows = Number(md.row_groups[group]!.num_rows);
  return (await parquetReadObjects({ file: file as never, metadata: md, columns: COLUMNS, rowStart: start, rowEnd: start + rows })) as unknown as RaidRow[];
}

/**
 * Walk the shards for one writer. `only` restricts to a set of documents, which is how every arm
 * after the first is kept to the same documents as the first.
 */
/** The instruction RAID gave for each anchored document, so another model can be handed the same one. */
export const prompts = new Map<string, RaidPrompt>();

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
        if (r.model !== model || r.attack !== 'none') continue;
        const id = String(r.source_id);
        if (found.has(id) || (only && !only.has(id))) continue;
        const text = toText(String(r.generation ?? ''));
        if (text.length < 400) continue;
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

if (process.argv[1] && process.argv[1].endsWith('fetch-raid.ts')) {
  const argv = process.argv;
  const arg = (name: string, dflt: string): string => (argv.includes(name) ? (argv[argv.indexOf(name) + 1] ?? dflt) : dflt);
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
