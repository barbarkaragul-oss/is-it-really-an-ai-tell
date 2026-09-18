/**
 * The second writer of the essays: Llama 3 8B, run on this machine through Ollama.
 *
 *   npx tsx scripts/llama-essays.ts [--limit 5] [--host http://localhost:11434] [--no-merge]
 *
 * The point of this arm is that it is not us. Every other machine essay in this genre is written by
 * the same assistant that wrote the page and the code, so a marker that separates the writers could
 * be a habit of this one system. A second model, from a different family, run locally with its
 * settings recorded, gives the genre two tested writers, and the grid can say "one of two" instead
 * of "one writer, no count".
 *
 * How it runs, and why:
 *  - SEQUENTIALLY, one request at a time. The machine has one GPU; two requests at once would slow
 *    both and make the seconds per essay meaningless as a record of the run.
 *  - RESUMABLE. Each essay is written to its own file in out/gen/essays/ as soon as it comes back,
 *    and a slot that already has a file is skipped. A run that is killed loses at most one essay,
 *    and re-running it costs only the essays that are missing.
 *  - AT ITS OWN SEED, WHICH IS NOT A PROMISE OF THE SAME ESSAY. Ollama is asked at temperature 1 with
 *    the slot's position in the generation order as its seed, and the seed actually used is recorded,
 *    so the run can be described exactly. It cannot be replayed: the same prompt at seed 7 was asked
 *    twice on this machine and came back as 469 words one time and 438 the next, different essays
 *    (the work is batched on a GPU, and the batching is not fixed). The arm reproduces as a record,
 *    not as an output, which is why every essay is committed with its prompt and its hash: what a
 *    reader can repeat is the measurement over those essays, not the writing of them. A retry after
 *    an empty answer still moves the seed, since asking the same question again is worth recording
 *    as a different attempt.
 *  - GIVING UP OUT LOUD. Three attempts at most. An empty answer, an answer too short to be an
 *    essay, or an error that survives the attempts is written to the slot file as an error and left
 *    there: the merge reports it and refuses to commit it, rather than a silent gap in the arm.
 *
 * Nothing about the text is judged here beyond "is there an essay at all". Whether an essay is a
 * refusal, a preamble or a text that stops mid-sentence is scripts/contamination.ts's question, and
 * it asks it of every writer with the same rules.
 *
 * Two fields of the record are of the run rather than of the text: `seconds`, measured from the clock
 * here, and `eval_count`, which the server reports. They are kept deliberately. Nothing here replays --
 * see the seed note above -- and how long the machine took to write an essay is the only evidence in
 * the file that a local model really wrote it, so the run's own log is worth the one number that
 * changes. Nothing is measured from either, and a committed record is never rewritten, so a second run
 * of a slot leaves both as the first run recorded them.
 */
import { existsSync } from 'node:fs';
import path from 'node:path';
import {
  MACHINE_ARMS, MIN_ESSAY_WORDS, SLOT_DIR, corpusIfPresent, inputs, mergeToDisk, promptFor, readJson, sha256,
  worklistFor, writeAtomic, type MachineArm, type Slot, type SlotFile,
} from './generate-essays.js';
import { words } from '../src/markers.js';
import { DATA, OUT, flag } from './arms.js';

export const HOST = 'http://localhost:11434';
/** the arm this runner writes; the model name is the one Ollama lists */
export const ARM: MachineArm = MACHINE_ARMS.find((a) => a.id === 'essays-llama3-student')!;
/** what is sent with every request. num_predict is the only cap, and it is far above an essay */
export const OPTIONS = { temperature: 1, num_predict: 1200 } as const;
/** the attempts one slot gets before it is written down as a failure */
export const ATTEMPTS = 3;
/** an essay takes 20 to 60 seconds on this machine; a request that takes ten minutes has gone wrong */
const REQUEST_TIMEOUT_MS = 600_000;

export interface ModelTag { name: string; digest: string; details?: { parameter_size?: string; quantization_level?: string; family?: string } }

/**
 * The model as Ollama holds it. The digest is recorded with every essay: "llama3:latest" is a
 * moving name, and a reader checking this arm in a year needs to know which weights wrote it.
 */
export async function modelTag(host: string, model: string): Promise<ModelTag> {
  const res = await fetch(`${host}/api/tags`, { signal: AbortSignal.timeout(30_000) });
  if (!res.ok) throw new Error(`${host}/api/tags: ${res.status} ${res.statusText}`);
  const { models } = (await res.json()) as { models?: ModelTag[] };
  const tag = (models ?? []).find((m) => m.name === model);
  if (!tag) throw new Error(`${model} is not pulled on ${host}; Ollama has ${(models ?? []).map((m) => m.name).join(', ') || 'nothing'}`);
  return tag;
}

export interface Answer { text: string; seconds: number; eval_count: number | undefined; done_reason: string | undefined }

/** one request, one essay: no context is passed in or kept, so every essay is written from nothing */
export async function askOllama(host: string, model: string, prompt: string, seed: number): Promise<Answer> {
  const started = Date.now();
  const res = await fetch(`${host}/api/generate`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model, prompt, stream: false, options: { ...OPTIONS, seed } }),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  const seconds = Math.round((Date.now() - started) / 100) / 10;
  if (!res.ok) throw new Error(`${host}/api/generate: ${res.status} ${res.statusText} (${(await res.text()).slice(0, 200)})`);
  const out = (await res.json()) as { response?: string; done_reason?: string; eval_count?: number; error?: string };
  if (out.error) throw new Error(`Ollama: ${out.error}`);
  return { text: String(out.response ?? '').trim(), seconds, eval_count: out.eval_count, done_reason: out.done_reason };
}

/**
 * One slot, up to three attempts. The seed moves between attempts so that an attempt is on the record
 * as its own question rather than as a repeat of the one that came back empty.
 * Whatever comes of it -- an essay or a failure -- is returned as the file to write, so the caller
 * writes exactly once and never leaves a slot half-recorded.
 */
export async function writeOne(slot: Slot, tag: ModelTag, host: string, now: () => string = (): string => new Date().toISOString()): Promise<SlotFile> {
  const prompt = promptFor(slot);
  const tried: { seed: number; seconds: number; outcome: string }[] = [];
  for (let attempt = 0; attempt < ATTEMPTS; attempt++) {
    const seed = slot.index + attempt * 100_000;
    try {
      const answer = await askOllama(host, ARM.model, prompt, seed);
      const n = words(answer.text).length;
      if (n >= MIN_ESSAY_WORDS) {
        return {
          slot: slot.id, arm: slot.arm, text: answer.text,
          model: ARM.model, harness: ARM.harness, generated_at: now(),
          // Ollama is given no context and returns to none, so each essay has a context of its own
          context_id: `ollama/api/generate:${slot.id}:seed=${seed}`,
          prompt, prompt_sha256: sha256(prompt), text_sha256: sha256(answer.text),
          settings: { model: ARM.model, digest: tag.digest, options: { ...OPTIONS, seed }, stream: false, endpoint: '/api/generate', attempts: tried.length + 1 },
          seconds: answer.seconds,
          ...(answer.eval_count === undefined ? {} : { eval_count: answer.eval_count }),
          ...(answer.done_reason === undefined ? {} : { done_reason: answer.done_reason }),
          attempts: tried.length + 1,
        };
      }
      tried.push({ seed, seconds: answer.seconds, outcome: n === 0 ? 'empty answer' : `${n} words` });
    } catch (e) {
      tried.push({ seed, seconds: 0, outcome: e instanceof Error ? e.message : String(e) });
    }
  }
  return {
    slot: slot.id, arm: slot.arm, text: '',
    model: ARM.model, harness: ARM.harness, generated_at: now(),
    context_id: `ollama/api/generate:${slot.id}:failed`,
    prompt, prompt_sha256: sha256(prompt),
    settings: { model: ARM.model, digest: tag.digest, options: OPTIONS, stream: false, endpoint: '/api/generate', attempts: tried },
    error: `no essay after ${ATTEMPTS} attempts: ${tried.map((t) => `${t.outcome} (seed ${t.seed})`).join('; ')}`,
    attempts: tried.length,
  };
}

/** a slot is done when its file holds an essay, or when a run already recorded that it could not get one */
export function slotState(file: string): 'missing' | 'written' | 'failed' {
  if (!existsSync(file)) return 'missing';
  const held = readJson<SlotFile>(file);
  return held.error || !held.text ? 'failed' : 'written';
}

if (process.argv[1] && process.argv[1].endsWith('llama-essays.ts')) {
  const host = flag('--host') ?? HOST;
  const slotDir = path.resolve(flag('--slot-dir') ?? path.join(OUT, SLOT_DIR));
  const limit = Number(flag('--limit') ?? Infinity);
  const retryFailed = process.argv.includes('--retry-failed');

  const { frame, assignments } = inputs();
  const { slots } = worklistFor(frame, assignments, {
    ...(flag('--slots') ? { slots: Number(flag('--slots')) } : {}),
    arms: [ARM],
  });

  const tag = await modelTag(host, ARM.model);
  console.log(`${ARM.model} ${tag.digest.slice(0, 12)} (${tag.details?.parameter_size ?? '?'}, ${tag.details?.quantization_level ?? '?'}) on ${host}`);
  console.log(`${slots.length} slots, options ${JSON.stringify(OPTIONS)}, seed = the slot's place in the generation order\n`);

  let written = 0, skipped = 0, failed = 0, secondsTotal = 0;
  for (const slot of slots) {
    const file = path.join(slotDir, `${slot.id}.json`);
    const state = slotState(file);
    if (state === 'written' || (state === 'failed' && !retryFailed)) { skipped++; continue; }
    if (written + failed >= limit) break;
    const out = await writeOne(slot, tag, host);
    writeAtomic(file, `${JSON.stringify(out, null, 1)}\n`);
    secondsTotal += out.seconds ?? 0;
    if (out.error) {
      failed++;
      console.error(`${slot.id}  FAILED  ${out.error}`);
    } else {
      written++;
      console.log(`${slot.id}  ${String(words(out.text).length).padStart(4)} words  ${String(out.seconds).padStart(6)}s  ${out.eval_count ?? '?'} tokens`);
    }
  }
  const done = written + failed;
  console.log(`\n${written} written, ${failed} failed, ${skipped} already on disk; ${secondsTotal.toFixed(1)}s${done ? `, ${(secondsTotal / done).toFixed(1)}s an essay` : ''}`);

  if (!process.argv.includes('--no-merge')) {
    const { report, written: files } = mergeToDisk({ arms: [ARM], slots, root: DATA, slotDir, corpus: corpusIfPresent() });
    console.log(`merged ${report.merged}, already committed ${report.kept}, missing ${report.missing.length}, rejected ${report.rejected.length}`);
    for (const r of report.rejected) console.error(`  rejected ${r.slot}: ${r.reasons.join('; ')}`);
    for (const f of files) console.log(`wrote ${path.relative(process.cwd(), f).split(path.sep).join('/')}`);
  }
}
