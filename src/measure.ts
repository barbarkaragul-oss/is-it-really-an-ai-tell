/**
 * Turning the corpora into the published table.
 *
 * Four choices here are deliberate, and they are why the numbers can be argued with rather than
 * merely quoted.
 *
 *  1. TWO MEASURES, EACH FOR THE KIND OF MARKER IT SUITS.
 *     A word or phrase is counted as occurrences per thousand words, which does not care how long
 *     the text is. A property of the whole text -- "every sentence the same length", "no
 *     contractions anywhere" -- cannot be counted that way, so it is reported as the share of texts
 *     that have it, and for that share length has to be controlled.
 *  2. LENGTH IS CONTROLLED PAIRWISE, NOT ACROSS EVERYTHING AT ONCE.
 *     Matching eight arms together means every arm is cut down to the smallest one in every length
 *     bin, and the sample collapses. Each arm is instead matched against the reference human arm on
 *     its own, so each comparison keeps as much data as that pair allows. The n of every pairing is
 *     published next to its numbers.
 *  3. A PLACEBO ARM.
 *     One human corpus is split at random and the whole pipeline runs on both halves. Every number
 *     there should be a tie; where it is not, the method is manufacturing signal and you can see it.
 *  4. INTERVALS, AND A CORRECTION.
 *     Wilson intervals at 95% for shares, a count-based interval for rates, and Benjamini-Hochberg
 *     across the catalogue, because two dozen markers produce a finding by luck otherwise.
 */
import { MARKERS, words, type Marker } from './markers.js';

export interface Text { id: string; text: string; source: string }
export interface Arm { id: string; label: string; kind: 'human' | 'machine'; texts: Text[] }

/** share of texts carrying the marker, on a length-matched pairing */
export interface Share { n: number; k: number; pct: number; lo: number; hi: number }
/** occurrences per thousand words, on the whole arm */
export interface Rate { texts: number; words: number; occurrences: number; per1000: number; lo: number; hi: number }

export interface Row {
  marker: string;
  label: string;
  family: string;
  belief: boolean;
  countable: boolean;
  /** per arm: the share in that arm's own pairing with the reference, and the reference's share in it */
  share: Record<string, { arm: Share; reference: Share }>;
  rate: Record<string, Rate>;
  placebo: { a: Share; b: Share; tie: boolean };
  p: number | null;
  q: number | null;
  verdict: 'machine marker' | 'register marker' | 'no signal' | 'points the other way' | 'not recorded';
}

export interface Report {
  generated_at: string;
  reference: string;
  machine: string;
  arms: { id: string; label: string; kind: string; n: number; matchedWithReference: number; medianWords: number }[];
  rows: Row[];
}

/** Wilson score interval: behaves when k is 0 and when n is small. */
export function wilson(k: number, n: number): [number, number] {
  if (n === 0) return [0, 0];
  const p = k / n, z = 1.96, d = 1 + (z * z) / n;
  const centre = p + (z * z) / (2 * n);
  const spread = z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n));
  return [(100 * (centre - spread)) / d, (100 * (centre + spread)) / d];
}

export function share(texts: Text[], m: Marker): Share {
  const k = texts.filter((t) => m.test(t.text)).length;
  const [lo, hi] = wilson(k, texts.length);
  return { n: texts.length, k, pct: texts.length ? (100 * k) / texts.length : 0, lo, hi };
}

/**
 * Occurrences per thousand words. The interval treats the occurrence count as Poisson, which is the
 * usual approximation for rare words and is honest about a rate resting on three occurrences.
 */
export function rate(texts: Text[], m: Marker): Rate {
  let occurrences = 0, total = 0;
  for (const t of texts) {
    total += words(t.text).length;
    occurrences += m.count ? m.count(t.text) : m.test(t.text) ? 1 : 0;
  }
  const per1000 = total ? (1000 * occurrences) / total : 0;
  // Garwood-style bounds via the normal approximation on sqrt(k), floored at zero
  const se = Math.sqrt(occurrences);
  const lo = total ? Math.max(0, (1000 * (occurrences - 1.96 * se)) / total) : 0;
  const hi = total ? (1000 * (occurrences + 1.96 * se)) / total : 0;
  return { texts: texts.length, words: total, occurrences, per1000, lo, hi };
}

export function twoProportionP(k1: number, n1: number, k2: number, n2: number): number | null {
  if (!n1 || !n2) return null;
  const p1 = k1 / n1, p2 = k2 / n2, p = (k1 + k2) / (n1 + n2);
  const se = Math.sqrt(p * (1 - p) * (1 / n1 + 1 / n2));
  if (se === 0) return 1;
  const z = Math.abs(p1 - p2) / se;
  const t = 1 / (1 + 0.2316419 * z);
  const d = 0.3989423 * Math.exp((-z * z) / 2);
  const tail = d * t * (0.3193815 + t * (-0.3565638 + t * (1.781478 + t * (-1.821256 + t * 1.330274))));
  return Math.min(1, 2 * tail);
}

export function benjaminiHochberg(ps: (number | null)[]): (number | null)[] {
  const idx = ps.map((p, i) => ({ p, i })).filter((x): x is { p: number; i: number } => x.p !== null);
  idx.sort((a, b) => a.p - b.p);
  const m = idx.length;
  const q: (number | null)[] = ps.map(() => null);
  let prev = 1;
  for (let r = m; r >= 1; r--) {
    const { p, i } = idx[r - 1]!;
    prev = Math.min(prev, (p * m) / r);
    q[i] = prev;
  }
  return q;
}

const BINS: [number, number][] = [[80, 129], [130, 219], [220, 399], [400, 800]];
const binOf = (t: string): number => { const n = words(t).length; return BINS.findIndex(([lo, hi]) => n >= lo && n <= hi); };

/** Two arms, cut to the same number of texts in every length bin. */
export function pairMatch(a: Text[], b: Text[]): [Text[], Text[]] {
  const outA: Text[] = [], outB: Text[] = [];
  BINS.forEach((_, i) => {
    const ba = a.filter((t) => binOf(t.text) === i), bb = b.filter((t) => binOf(t.text) === i);
    const take = Math.min(ba.length, bb.length);
    outA.push(...ba.slice(0, take));
    outB.push(...bb.slice(0, take));
  });
  return [outA, outB];
}

/** Deterministic shuffle, so the placebo split is random but the run reproduces. */
export function seededShuffle<T>(items: T[], seed: number): T[] {
  const out = [...items];
  let s = seed >>> 0;
  for (let i = out.length - 1; i > 0; i--) {
    s = (s * 1664525 + 1013904223) >>> 0;
    const j = s % (i + 1);
    [out[i], out[j]] = [out[j]!, out[i]!];
  }
  return out;
}

export function measure(arms: Arm[], opts: { reference: string; casual: string; machine: string; seed?: number }): Report {
  const find = (id: string): Arm | undefined => arms.find((a) => a.id === id);
  const reference = find(opts.reference);
  if (!reference) throw new Error(`reference arm ${opts.reference} is not among the arms`);

  // one length-matched pairing per arm, computed once and reused for every marker
  const pairings = new Map<string, [Text[], Text[]]>();
  for (const a of arms) pairings.set(a.id, a.id === reference.id ? [reference.texts, reference.texts] : pairMatch(reference.texts, a.texts));

  const shuffled = seededShuffle(reference.texts, opts.seed ?? 20260916);
  const half = Math.floor(shuffled.length / 2);
  const [pa, pb] = pairMatch(shuffled.slice(0, half), shuffled.slice(half));

  const rows: Row[] = MARKERS.map((m) => {
    const sh: Row['share'] = {};
    for (const a of arms) {
      const [ref, arm] = pairings.get(a.id)!;
      sh[a.id] = { arm: share(arm, m), reference: share(ref, m) };
    }
    const rt: Row['rate'] = {};
    for (const a of arms) rt[a.id] = rate(a.texts, m);

    const machine = sh[opts.machine];
    const casual = sh[opts.casual];
    const a = share(pa, m), b = share(pb, m);
    const tie = a.lo <= b.hi && b.lo <= a.hi;
    const p = machine ? twoProportionP(machine.arm.k, machine.arm.n, machine.reference.k, machine.reference.n) : null;

    let verdict: Row['verdict'] = 'no signal';
    if (!machine || machine.arm.n === 0) verdict = 'not recorded';
    else if (machine.arm.lo > machine.reference.hi) verdict = 'machine marker';
    else if (machine.arm.hi < machine.reference.lo) verdict = 'points the other way';
    else if (casual && machine.reference.lo > casual.arm.hi && machine.arm.lo > casual.arm.hi) verdict = 'register marker';

    return {
      marker: m.id, label: m.label, family: m.family, belief: m.belief === true, countable: m.count !== undefined,
      share: sh, rate: rt, placebo: { a, b, tie }, p, q: null, verdict,
    };
  });

  const qs = benjaminiHochberg(rows.map((r) => r.p));
  rows.forEach((r, i) => { r.q = qs[i]!; });

  const median = (texts: Text[]): number => {
    const l = texts.map((t) => words(t.text).length).sort((x, y) => x - y);
    return l.length ? l[Math.floor(l.length / 2)]! : 0;
  };
  return {
    generated_at: new Date().toISOString(),
    reference: reference.id,
    machine: opts.machine,
    arms: arms.map((a) => ({ id: a.id, label: a.label, kind: a.kind, n: a.texts.length, matchedWithReference: pairings.get(a.id)![1].length, medianWords: median(a.texts) })),
    rows,
  };
}
