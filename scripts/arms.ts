/**
 * The arms, in one place, so the measurement and the evidence read the same corpora.
 *
 * Which arms exist is decided by scripts/genres.ts: each kind of writing has its own person and
 * models, and the comparison columns (casual writing, careful writing, GPT-3.5 answering questions)
 * are shared by every kind.
 *
 * Every arm of a kind of writing, the person's included, is read from the -clean file
 * scripts/contamination.ts writes, never from the raw download: a machine text that stops mid-
 * sentence, that is a refusal or a label, or that reproduces the human document cannot reach the
 * table, and a person's abstract that may have been revised after ChatGPT is left out of every arm.
 *
 * `publishable` says whether an arm's own text may be quoted in this repository. RAID's machine text
 * is MIT, arXiv abstracts are CC0 and the Claude arm was generated here; Reddit posts, Hacker News
 * comments (licensed to Y Combinator) and Stack Exchange answers (CC BY-SA) are not quoted, and HC3
 * is referenced by id.
 */
import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import type { Arm, Text } from '../src/measure.js';
import { GENRES, COMPARISON, type Genre } from './genres.js';

/** the value after a command-line flag, if it was given */
export function flag(name: string, argv: string[] = process.argv): string | undefined {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
}

/**
 * Where the corpora are read from and the published numbers written to. Both can be pointed
 * elsewhere, because a local out/ is usually older than the collector and its numbers must never
 * replace the ones the weekly job commits: `--data <scratch dir>` keeps them apart.
 */
export const OUT = path.resolve(flag('--corpora') ?? 'out');
export const DATA = path.resolve(flag('--data') ?? 'data');

export interface ArmSpec { id: string; label: string; kind: 'human' | 'machine'; file: string; publishable: boolean }

/** the measured file of a writer: its raw file after scripts/contamination.ts */
export const cleanFile = (raw: string): string => `${raw}-clean`;

export const COMPARISON_ARMS: ArmSpec[] = COMPARISON.map((c) => ({ id: c.id, label: c.label, kind: c.kind, file: c.raw, publishable: false }));

/** a genre's own arms, the person first, then the shared comparison arms */
export function armsFor(genre: Genre): ArmSpec[] {
  return [
    ...genre.writers.map((w): ArmSpec => ({ id: w.id, label: w.label, kind: w.writer === 'human' ? 'human' : 'machine', file: cleanFile(w.raw), publishable: w.quotable })),
    ...COMPARISON_ARMS,
  ];
}

/** every arm of every genre, once */
export const ARMS: ArmSpec[] = [...new Map(GENRES.flatMap(armsFor).map((a) => [a.id, a])).values()];

export function loadArm(spec: ArmSpec, dir: string = OUT): Arm | null {
  const f = path.join(dir, `${spec.file}.json`);
  if (!existsSync(f)) {
    // an arm that was fetched but never checked must not quietly drop out of the table
    if (spec.file.endsWith('-clean') && existsSync(path.join(dir, `${spec.file.replace(/-clean$/, '')}.json`))) {
      throw new Error(`${path.join(dir, spec.file)}.json is missing; run scripts/contamination.ts first`);
    }
    return null;
  }
  const rows = JSON.parse(readFileSync(f, 'utf8')) as { id: string; text: string; group?: string }[];
  /**
   * `group` is the assignment a text was written to, where a kind of writing pairs on that rather than
   * on the document (src/measure.ts, pairByPrompt). It is carried through untouched: a collector that
   * writes it means it, and a text without one must keep no field at all, since `exactOptionalPropertyTypes`
   * tells `measure` apart from a text whose assignment is unknown. Both sides of such a pairing have to
   * name the assignment the same way -- the slug, not the name the page prints -- or no pair will match.
   */
  const texts: Text[] = rows.map((r) => ({ id: String(r.id), text: r.text, source: spec.file, ...(r.group === undefined ? {} : { group: String(r.group) }) }));
  return texts.length ? { id: spec.id, label: spec.label, kind: spec.kind, texts } : null;
}

/** a genre's arms that are present in out/; the comparison arms are loaded once and shared */
const cache = new Map<string, Arm | null>();
export function loadArms(genre: Genre = GENRES[0]!, dir: string = OUT): { arm: Arm; spec: ArmSpec }[] {
  return armsFor(genre).flatMap((spec) => {
    const key = path.join(dir, spec.file);
    if (!cache.has(key)) cache.set(key, loadArm(spec, dir));
    const arm = cache.get(key);
    return arm ? [{ arm: { ...arm, id: spec.id, label: spec.label }, spec }] : [];
  });
}

/** whether a genre's person was collected at all; a genre that was not is skipped, not failed */
export const collected = (genre: Genre, dir: string = OUT): boolean =>
  existsSync(path.join(dir, `${genre.writers[0]!.raw}.json`));

/**
 * The genres a script works on: those named with `--genres a,b` (each one then required), or every
 * genre whose person was collected. Abstracts are always required, as they have always been.
 */
export function genresToRun(argv: string[] = process.argv, dir: string = OUT): { genres: Genre[]; missing: string[] } {
  const named = flag('--genres', argv)?.split(',').map((s) => s.trim()).filter(Boolean);
  const wanted = named ? GENRES.filter((g) => named.includes(g.id)) : GENRES;
  const unknown = named?.filter((n) => !GENRES.some((g) => g.id === n)) ?? [];
  const required = new Set(named ?? ['abstracts']);
  const genres = wanted.filter((g) => collected(g, dir));
  const missing = [...unknown, ...wanted.filter((g) => required.has(g.id) && !collected(g, dir)).map((g) => g.id)];
  return { genres, missing };
}
