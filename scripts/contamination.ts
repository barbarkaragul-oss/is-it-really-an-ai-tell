/**
 * Did the model write this, or remember it?
 *
 *   npx tsx scripts/contamination.ts
 *
 * Every machine arm here is a model continuing a document that exists in the world. Asked to write
 * the abstract of a real paper, a model can reproduce the published abstract instead of composing
 * one, and a reproduced abstract is human writing wearing a machine label. Any marker measured on
 * it is measuring the person who wrote the paper.
 *
 * This compares each machine text with the human text for the same document, by the share of the
 * machine text's five-word sequences that also occur in the human one. Above the threshold the text
 * is treated as remembered rather than written, and dropped from the arm.
 *
 * The check is run on every machine arm, not only the ones suspected of it, because the point is to
 * publish the number rather than to defend a particular arm.
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import path from 'node:path';

const OUT = path.resolve('out');
const THRESHOLD = 0.5;

export interface Row { id: string; text: string }

const sourceOf = (id: string): string => String(id).replace(/^raid:[a-z0-9.-]+:/, '');

/** the set of five-word sequences in a text */
export function fiveGrams(text: string): Set<string> {
  const w = text.toLowerCase().match(/[a-z0-9']+/g) ?? [];
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

function load(name: string): Row[] | null {
  const f = path.join(OUT, `${name}.json`);
  return existsSync(f) ? (JSON.parse(readFileSync(f, 'utf8')) as Row[]) : null;
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

export function checkArm(rows: Row[], human: Map<string, string>, name: string): { report: ArmReport; clean: Row[] } {
  let sum = 0, unchecked = 0;
  const scored: { row: Row; c: number }[] = [];
  for (const r of rows) {
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

/**
 * The Claude arm lives in the repository, not in out/, because nobody can re-download it. It is
 * written out fresh from data/generated on every run so the weekly job measures it like the rest.
 */
const GENERATED = path.resolve('data/generated/claude-abstracts.json');
interface Generated { texts: { source_id: string; text: string; remembered_from_the_paper: boolean }[] }

if (process.argv[1] && process.argv[1].endsWith('contamination.ts')) {
  const humanRows = load('raid-human');
  if (!humanRows) { console.error('out/raid-human.json is missing; run the RAID collector first'); process.exit(1); }
  const human = new Map(humanRows.map((r) => [sourceOf(r.id), r.text]));

  let generated: Generated | null = null;
  if (existsSync(GENERATED)) {
    generated = JSON.parse(readFileSync(GENERATED, 'utf8')) as Generated;
    writeFileSync(path.join(OUT, 'raid-claude.json'), JSON.stringify(generated.texts.map((t) => ({ id: t.source_id, text: t.text }))));
  }

  const arms = ['raid-gpt4', 'raid-chatgpt', 'raid-llama-chat', 'raid-mistral-chat', 'raid-claude'];
  console.log(`five-gram containment against the human document, threshold ${THRESHOLD}\n`);
  console.log('arm'.padEnd(20) + 'compared'.padEnd(10) + 'unchecked'.padEnd(11) + 'mean'.padEnd(9) + 'remembered');
  console.log('-'.repeat(62));
  let failed = false;
  for (const name of arms) {
    const rows = load(name);
    if (!rows) continue;
    const { report, clean } = checkArm(rows, human, name);
    console.log(
      name.padEnd(20) + String(report.compared).padEnd(10) + String(report.unchecked).padEnd(11) +
      `${(100 * report.mean).toFixed(1)}%`.padEnd(9) +
      `${report.remembered.length} of ${rows.length}` + (report.remembered.length ? `  (worst ${(100 * report.worst[0]!.containment).toFixed(0)}%)` : ''),
    );
    // every machine arm is measured from its -clean file, so it is written even when nothing was dropped
    writeFileSync(path.join(OUT, `${name}-clean.json`), JSON.stringify(clean));
    if (name === 'raid-claude' && generated) {
      // the flag in the committed file and this check must say the same thing
      const flagged = generated.texts.filter((t) => t.remembered_from_the_paper).map((t) => t.source_id).sort();
      const found = [...report.remembered].sort();
      if (report.unchecked || flagged.join() !== found.join()) {
        failed = true;
        console.error(`    the committed remembered_from_the_paper flags (${flagged.length}) and this check (${found.length}, ${report.unchecked} unchecked) disagree`);
      }
    }
  }
  if (failed) process.exit(1);
  console.log('\nA text above the threshold is the published document, not a continuation of it, and any');
  console.log('marker counted there belongs to the person who wrote the paper.');
}
