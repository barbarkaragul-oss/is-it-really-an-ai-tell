/**
 * The 2024 arm, and the only pair in this project where human and machine answer the same prompt.
 *
 *   npx tsx collector/fetch-raid.ts [--want 4000]
 *
 * RAID (Dugan et al., ACL 2024, MIT) holds human documents and machine continuations of the same
 * documents, keyed by `source_id`, across news, abstracts, books and poetry. Taking both sides of
 * that key gives a comparison with the genre, the topic and the prompt held constant -- which is
 * what the Hacker News and Stack Exchange arms cannot offer, and what makes a marker's verdict
 * about the writer rather than about the subject.
 *
 * Only `attack: none` rows are used. RAID's other rows are adversarially perturbed on purpose
 * (homoglyphs, inserted whitespace, misspellings); measuring style markers on those would measure
 * the attack.
 *
 * The published parquet is 2.3 GB over ten shards, so nothing is downloaded whole: each shard's
 * row-group statistics say which groups can contain the rows wanted, and only those groups are
 * fetched, over HTTP range requests.
 */
import { writeFileSync, existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { parquetMetadataAsync, parquetReadObjects } from 'hyparquet';
import { toText, type Fetched } from './fetch.js';
import { rangeBuffer, type AsyncBuffer } from './range-buffer.js';

const SHARD = (i: number): string => `https://huggingface.co/api/datasets/liamdugan/raid/parquet/raid/train/${i}.parquet`;
const SHARDS = 10;
const OUT = path.resolve('out');
const COLUMNS = ['source_id', 'model', 'attack', 'domain', 'generation'];

export interface RaidRow { source_id: string; model: string; attack: string; domain: string; generation: string }

/** A row group can only hold the model we want if its recorded min..max range covers it. */
type Meta = Awaited<ReturnType<typeof parquetMetadataAsync>>;

function groupsThatMayHold(md: Meta, model: string): number[] {
  const col = md.schema.slice(1).findIndex((s) => s.name === 'model');
  const out: number[] = [];
  md.row_groups.forEach((rg, i) => {
    const st = rg.columns[col]?.meta_data?.statistics;
    if (!st) { out.push(i); return; }                       // no statistics: cannot rule it out
    const min = String(st.min_value ?? ''), max = String(st.max_value ?? '');
    if (min <= model && model <= max) out.push(i);
  });
  return out;
}

/** Rows of one group, as objects, pulling only the columns we read. */
async function readGroup(file: AsyncBuffer, md: Meta, group: number): Promise<RaidRow[]> {
  let start = 0;
  for (let i = 0; i < group; i++) start += Number(md.row_groups[i]!.num_rows);
  const rows = Number(md.row_groups[group]!.num_rows);
  return (await parquetReadObjects({ file: file as never, metadata: md, columns: COLUMNS, rowStart: start, rowEnd: start + rows })) as unknown as RaidRow[];
}

export async function fetchRaid(want: number): Promise<{ machine: Fetched[]; human: Fetched[] }> {
  const machine: Fetched[] = [];
  const wantedSources = new Set<string>();
  const humanBySource = new Map<string, Fetched>();

  for (let shard = 0; shard < SHARDS && machine.length < want; shard++) {
    const file = await rangeBuffer(SHARD(shard));
    const md = await parquetMetadataAsync(file as never);
    const groups = groupsThatMayHold(md, 'gpt4');
    if (!groups.length) continue;
    console.error(`  shard ${shard}: ${groups.length} of ${md.row_groups.length} row groups may hold gpt4`);
    for (const g of groups) {
      if (machine.length >= want) break;
      let rows: RaidRow[];
      try { rows = await readGroup(file, md, g); } catch (e) { console.error(`    group ${g}: ${(e as Error).message}`); continue; }
      for (const r of rows) {
        if (r.model !== 'gpt4' || r.attack !== 'none') continue;
        const text = toText(String(r.generation ?? ''));
        if (text.length < 400) continue;
        machine.push({ id: `raid:gpt4:${r.source_id}`, text });
        wantedSources.add(String(r.source_id));
        if (machine.length >= want) break;
      }
    }
  }

  // the human side of the same source_ids: same prompt, same genre, different writer
  for (let shard = 0; shard < SHARDS && humanBySource.size < wantedSources.size; shard++) {
    const file = await rangeBuffer(SHARD(shard));
    const md = await parquetMetadataAsync(file as never);
    const groups = groupsThatMayHold(md, 'human');
    if (!groups.length) continue;
    console.error(`  shard ${shard}: ${groups.length} row groups may hold the human side`);
    for (const g of groups) {
      if (humanBySource.size >= wantedSources.size) break;
      let rows: RaidRow[];
      try { rows = await readGroup(file, md, g); } catch (e) { console.error(`    group ${g}: ${(e as Error).message}`); continue; }
      for (const r of rows) {
        if (r.model !== 'human') continue;
        const id = String(r.source_id);
        if (!wantedSources.has(id) || humanBySource.has(id)) continue;
        const text = toText(String(r.generation ?? ''));
        if (text.length < 400) continue;
        humanBySource.set(id, { id: `raid:human:${id}`, text });
      }
    }
  }

  // keep only the pairs where both sides survived, so the arms really are matched
  const paired = machine.filter((m) => humanBySource.has(m.id.replace('raid:gpt4:', '')));
  const human = paired.map((m) => humanBySource.get(m.id.replace('raid:gpt4:', ''))!);
  return { machine: paired, human };
}

if (process.argv[1] && process.argv[1].endsWith('fetch-raid.ts')) {
  const want = Number(process.argv.includes('--want') ? process.argv[process.argv.indexOf('--want') + 1] : 4000);
  console.error(`RAID: looking for ${want} unattacked gpt4 texts and their human counterparts`);
  const { machine, human } = await fetchRaid(want);
  if (!existsSync(OUT)) mkdirSync(OUT, { recursive: true });
  writeFileSync(path.join(OUT, 'machine-2024.json'), JSON.stringify(machine));
  writeFileSync(path.join(OUT, 'raid-human.json'), JSON.stringify(human));
  console.error(`  wrote ${machine.length} machine and ${human.length} human texts, paired by source`);
}
