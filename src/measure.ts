/**
 * Turning a set of corpora into the published table.
 *
 * Three things here are deliberate and are the reason the numbers can be argued with:
 *
 *  1. LENGTH IS HELD CONSTANT. A marker that is merely "present somewhere" is easier to hit in a
 *     longer text, and the arms differ in length by a factor of two. Texts are binned by word
 *     count and every arm contributes the same number of texts to every bin.
 *  2. A PLACEBO ARM. One human corpus is split at random into two halves and the whole pipeline is
 *     run on the pair. Every number in that column should be a tie. Where it is not, the method is
 *     manufacturing signal and the reader can see it.
 *  3. INTERVALS, NOT POINTS. Wilson intervals at 95%, and Benjamini-Hochberg over the whole
 *     catalogue, because testing two dozen markers at once produces a "finding" by luck otherwise.
 */
import { MARKERS, words, type Marker } from './markers.js';

export interface Text { id: string; text: string; source: string }
export interface Arm { id: string; label: string; kind: 'human' | 'machine'; texts: Text[] }

export interface Cell { n: number; k: number; pct: number; lo: number; hi: number }
export interface Row {
  marker: string;
  label: string;
  family: string;
  belief: boolean;
  cells: Record<string, Cell>;
  placebo: { a: Cell; b: Cell; tie: boolean };
  /** two-sided p for the machine arm against the careful-human arm, before correction */
  p: number | null;
  q: number | null;
  verdict: 'machine marker' | 'register marker' | 'no signal' | 'points the other way' | 'not recorded';
}

/** Wilson score interval, the one that behaves when k is 0 or n is small. */
export function wilson(k: number, n: number): [number, number] {
  if (n === 0) return [0, 0];
  const p = k / n, z = 1.96, d = 1 + (z * z) / n;
  const centre = p + (z * z) / (2 * n);
  const spread = z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n));
  return [(100 * (centre - spread)) / d, (100 * (centre + spread)) / d];
}

export function cell(texts: Text[], m: Marker): Cell {
  const k = texts.filter((t) => m.test(t.text)).length;
  const [lo, hi] = wilson(k, texts.length);
  return { n: texts.length, k, pct: texts.length ? (100 * k) / texts.length : 0, lo, hi };
}

/** Two-proportion z test. Enough for a table that also prints intervals; no library needed. */
export function twoProportionP(k1: number, n1: number, k2: number, n2: number): number | null {
  if (!n1 || !n2) return null;
  const p1 = k1 / n1, p2 = k2 / n2, p = (k1 + k2) / (n1 + n2);
  const se = Math.sqrt(p * (1 - p) * (1 / n1 + 1 / n2));
  if (se === 0) return 1;
  const z = Math.abs(p1 - p2) / se;
  // two-sided normal tail, Abramowitz & Stegun 26.2.17
  const t = 1 / (1 + 0.2316419 * z);
  const d = 0.3989423 * Math.exp((-z * z) / 2);
  const tail = d * t * (0.3193815 + t * (-0.3565638 + t * (1.781478 + t * (-1.821256 + t * 1.330274))));
  return Math.min(1, 2 * tail);
}

/** Benjamini-Hochberg: with two dozen markers, some p below .05 are luck. */
export function benjaminiHochberg(ps: (number | null)[]): (number | null)[] {
  const idx = ps.map((p, i) => ({ p, i })).filter((x): x is { p: number; i: number } => x.p !== null);
  idx.sort((a, b) => a.p - b.p);
  const m = idx.length;
  const q: (number | null)[] = ps.map(() => null);
  let prev = 1;
  for (let rank = m; rank >= 1; rank--) {
    const { p, i } = idx[rank - 1]!;
    prev = Math.min(prev, (p * m) / rank);
    q[i] = prev;
  }
  return q;
}

const BINS: [number, number][] = [[80, 129], [130, 219], [220, 399], [400, 800]];
const binOf = (t: string): number => { const n = words(t).length; return BINS.findIndex(([lo, hi]) => n >= lo && n <= hi); };

/** Every arm contributes the same number of texts in every length bin. */
export function lengthMatch(arms: Arm[]): { arms: Arm[]; perBin: { bin: string; take: number; had: number[] }[] } {
  const byBin = arms.map((a) => BINS.map((_, i) => a.texts.filter((t) => binOf(t.text) === i)));
  const out: Arm[] = arms.map((a) => ({ ...a, texts: [] }));
  const perBin = BINS.map(([lo, hi], i) => {
    const had = byBin.map((b) => b[i]!.length);
    const take = Math.min(...had);
    byBin.forEach((b, ai) => out[ai]!.texts.push(...b[i]!.slice(0, take)));
    return { bin: `${lo}-${hi}`, take, had };
  });
  return { arms: out, perBin };
}

/** Deterministic shuffle, so the placebo split is random but the run reproduces. */
export function seededShuffle<T>(items: T[], seed: number): T[] {
  const a = [...items];
  let s = seed >>> 0;
  for (let i = a.length - 1; i > 0; i--) {
    s = (s * 1664525 + 1013904223) >>> 0;
    const j = s % (i + 1);
    [a[i], a[j]] = [a[j]!, a[i]!];
  }
  return a;
}

export interface Report {
  generated_at: string;
  arms: { id: string; label: string; kind: string; n: number; medianWords: number }[];
  bins: { bin: string; take: number; had: number[] }[];
  rows: Row[];
}

export function measure(arms: Arm[], opts: { casual: string; careful: string; machine: string; seed?: number }): Report {
  const { arms: matched, perBin } = lengthMatch(arms);
  const find = (id: string): Arm => matched.find((a) => a.id === id) ?? { id, label: id, kind: 'human', texts: [] };
  const careful = find(opts.careful), machine = find(opts.machine), casual = find(opts.casual);

  // the placebo: the casual human arm split at random, both halves through the same pipeline
  const shuffled = seededShuffle(casual.texts, opts.seed ?? 20260916);
  const half = Math.floor(shuffled.length / 2);
  const placeboA = shuffled.slice(0, half), placeboB = shuffled.slice(half);

  const rows: Row[] = MARKERS.map((m) => {
    const cells: Record<string, Cell> = {};
    for (const a of matched) cells[a.id] = cell(a.texts, m);
    const cMachine = cells[machine.id]!, cCareful = cells[careful.id]!, cCasual = cells[casual.id]!;
    const a = cell(placeboA, m), b = cell(placeboB, m);
    const tie = a.lo <= b.hi && b.lo <= a.hi;
    const p = twoProportionP(cMachine.k, cMachine.n, cCareful.k, cCareful.n);

    let verdict: Row['verdict'] = 'no signal';
    if (cMachine.n === 0 || cCareful.n === 0) verdict = 'not recorded';
    else if (cMachine.lo > cCareful.hi && cMachine.lo > cCasual.hi) verdict = 'machine marker';
    else if (cMachine.hi < cCareful.lo) verdict = 'points the other way';
    else if (cCareful.lo > cCasual.hi && cMachine.lo > cCasual.hi) verdict = 'register marker';

    return { marker: m.id, label: m.label, family: m.family, belief: m.belief === true, cells, placebo: { a, b, tie }, p, q: null, verdict };
  });

  const qs = benjaminiHochberg(rows.map((r) => r.p));
  rows.forEach((r, i) => { r.q = qs[i]!; });

  const median = (a: Arm): number => {
    const l = a.texts.map((t) => words(t.text).length).sort((x, y) => x - y);
    return l.length ? l[Math.floor(l.length / 2)]! : 0;
  };
  return {
    generated_at: new Date().toISOString(),
    arms: matched.map((a) => ({ id: a.id, label: a.label, kind: a.kind, n: a.texts.length, medianWords: median(a) })),
    bins: perBin,
    rows,
  };
}
