/**
 * Writes data/genres/abstracts/claude-matched.json: every countable marker's rate on the documents
 * the Claude arm covers, for every writer of the abstracts.
 *
 *   npx tsx scripts/claude-matched.ts [--data <dir>]
 *
 * The Claude arm is at most 50 abstracts, all from the first fifty documents of the file, and those
 * are mostly about image segmentation. Set against the other writers' whole arms, its rates would be
 * comparing subjects as much as writers. Here every writer is counted on the same documents: the
 * ones Claude covers that every writer still has after scripts/contamination.ts, which can leave a
 * document out of one arm (cut off, remembered) or of all of them (revised after ChatGPT). At this
 * size a word turns up a handful of times, so the occurrences are published with the rates.
 *
 * data/claude-matched.json stays a copy for as long as the README links it.
 */
import { writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { MARKERS } from '../src/markers.js';
import { rate, sourceId, type Arm } from '../src/measure.js';
import { loadArms, DATA } from './arms.js';
import { genreById } from './genres.js';

const GENRE = genreById.get('abstracts')!;
export const WRITERS = GENRE.writers.map((w) => w.id);

/** the documents the Claude arm covers that every writer has, sorted */
export function sharedDocuments(arms: Map<string, Arm>, writers: string[], claude: string): string[] {
  const has = new Map(writers.map((w) => [w, new Set((arms.get(w)?.texts ?? []).map((t) => sourceId(t.id)))]));
  return [...new Set((arms.get(claude)?.texts ?? []).map((t) => sourceId(t.id)))]
    .filter((id) => writers.every((w) => has.get(w)?.has(id)))
    .sort();
}

if (process.argv[1] && process.argv[1].endsWith('claude-matched.ts')) {
  const arms = new Map(loadArms(GENRE).map(({ arm }) => [arm.id, arm]));
  const claude = GENRE.writers.find((w) => w.writer === 'claude')!.id;
  if (!arms.has(claude)) { console.error('no Claude arm in out/; run scripts/contamination.ts first'); process.exit(1); }

  // only the documents every writer has, so each column is the same set of abstracts
  const ids = sharedDocuments(arms, WRITERS, claude);
  const idSet = new Set(ids);

  const rows = MARKERS.filter((m) => m.count).map((m) => ({
    marker: m.id,
    label: m.label,
    rate: Object.fromEntries(WRITERS.filter((w) => arms.has(w)).map((w) => {
      const r = rate(arms.get(w)!.texts.filter((t) => idSet.has(sourceId(t.id))), m);
      return [w, { per1000: r.per1000, occurrences: r.occurrences, words: r.words, lo: r.lo, hi: r.hi }];
    })),
  }));

  const body = JSON.stringify({
    generated_at: new Date().toISOString(),
    genre: GENRE.id,
    documents: ids.length,
    note: 'Rates per thousand words on the documents the generated Claude arm covers, for every RAID writer. Small counts: read the occurrences.',
    source_ids: ids,
    rows,
  }, null, 1) + '\n';
  const dir = path.join(DATA, 'genres', GENRE.id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, 'claude-matched.json'), body);
  writeFileSync(path.join(DATA, 'claude-matched.json'), body);

  const short = (w: string): string => w.replace('raid-', '');
  console.log(`${ids.length} documents every writer covered\n`);
  console.log('marker'.padEnd(22) + WRITERS.map((w) => short(w).padEnd(14)).join(''));
  for (const r of rows) {
    if (!Object.values(r.rate).some((x) => x.occurrences)) continue;
    console.log(r.marker.padEnd(22) + WRITERS.map((w) => {
      const x = r.rate[w];
      return (x ? `${x.per1000.toFixed(2)} (${x.occurrences})` : '-').padEnd(14);
    }).join(''));
  }
  console.log(`\nwrote ${path.join(dir, 'claude-matched.json')} and its copy at data/claude-matched.json`);
}
