/**
 * Turning the corpora into the published table.
 *
 * Five choices here are deliberate, and they are why the numbers can be argued with rather than
 * merely quoted.
 *
 *  1. TWO MEASURES, EACH FOR THE KIND OF MARKER IT SUITS, AND EACH DECIDES ITS OWN VERDICT.
 *     A word or phrase is counted as occurrences per thousand words over every text in the arm. That
 *     rate is not free of length: a phrase used once in a text has half the rate in a text twice as
 *     long, and GPT-4 wrote its abstracts nearly 40% shorter than the people did. So the rates are
 *     shown whole, but the verdict compares the two arms only between texts of about the same length.
 *     A property of the whole text -- "every sentence the same length", "no contractions anywhere"
 *     -- cannot be counted that way, so it is reported as the share of texts that have it, on
 *     pairings that control length (below).
 *  2. LENGTH IS CONTROLLED PAIRWISE, AND THE PAIRS ARE NOT THE FILE'S ORDER.
 *     Matching eight arms together means every arm is cut down to the smallest one in every length
 *     bin, and the sample collapses. Each arm is instead matched against the reference human arm on
 *     its own. An arm written from the same documents as the reference is paired document by
 *     document, so both sides cover the same subjects. Any other arm is matched bin by bin on a
 *     seeded shuffle: the corpora are stored grouped by topic, and the first N texts of a bin are
 *     one topic, not a sample. The n and the kind of every pairing are published next to its numbers.
 *  3. A TEXT A MARKER CANNOT JUDGE IS LEFT OUT, NOT COUNTED AS "NO".
 *     "Every sentence the same length" says nothing about a text with three sentences. Such a text
 *     is dropped from that marker's shares on both sides of a pairing.
 *  4. A PLACEBO ARM.
 *     One human corpus is split at random and the same decision rules run on both halves. Every
 *     number there should be a tie; where it is not, the method is manufacturing signal and you can
 *     see it.
 *  5. INTERVALS, AND A CORRECTION.
 *     Wilson intervals at 95% for shares, exact Poisson intervals for rates, an exact test between
 *     rates, and Benjamini-Hochberg across the catalogue, because two dozen markers produce a finding
 *     by luck otherwise. A word's verdict needs its rate test to survive that correction.
 */
import { MARKERS, words, type Marker } from './markers.js';

export interface Text { id: string; text: string; source: string }
export interface Arm { id: string; label: string; kind: 'human' | 'machine'; texts: Text[] }

/** share of texts carrying the marker, on a length-matched pairing, among the texts the marker can judge */
export interface Share { n: number; k: number; pct: number; lo: number; hi: number }
/**
 * Occurrences per thousand words, on the whole arm. `dispersion` is how much more the per-text
 * counts scatter than independent occurrences would (1 when they do not); the interval is widened by it.
 */
export interface Rate { texts: number; words: number; occurrences: number; per1000: number; lo: number; hi: number; dispersion: number }

/**
 * How an arm was matched with the reference: `document` pairs the two texts written from each
 * document, `length` fills each length bin from a seeded shuffle of both arms, `self` is the
 * reference against itself.
 */
export type Pairing = 'document' | 'length' | 'self';

export interface Row {
  marker: string;
  label: string;
  family: string;
  belief: boolean;
  countable: boolean;
  /** per arm: the share in that arm's own pairing with the reference, and the reference's share in it */
  share: Record<string, { arm: Share; reference: Share }>;
  rate: Record<string, Rate>;
  /**
   * The reference split in two at random. `a`/`b` are the halves' shares, length-matched; `rate` is
   * their rates. `tie` applies the same rule the verdict uses: share intervals for a whole-text marker,
   * the rate test for a countable one, with `p` and `q` its test and its correction across the rows.
   */
  placebo: { a: Share; b: Share; tie: boolean; rate: { a: Rate; b: Rate }; p: number | null; q: number | null };
  p: number | null;
  q: number | null;
  /**
   * For a countable marker, what `p` tested: the machine arm's occurrences among the texts whose
   * length the reference also has, and how many the reference's rates at those lengths predict.
   * The verdict's direction is read from these, not from the whole-arm rates.
   */
  lengthMatched: { observed: number; expected: number } | null;
  verdict: 'machine marker' | 'register marker' | 'no signal' | 'points the other way' | 'not recorded';
}

export interface Report {
  generated_at: string;
  reference: string;
  machine: string;
  arms: { id: string; label: string; kind: string; n: number; matchedWithReference: number; pairing: Pairing; medianWords: number }[];
  rows: Row[];
}

/** the false discovery rate a countable verdict is held to, after Benjamini-Hochberg */
const SIGNIFICANCE = 0.05;
const DEFAULT_SEED = 20260916;

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

/** word counts, once per text: every marker, pairing and rate asks again */
const lengths = new WeakMap<Text, number>();
function lengthOf(t: Text): number {
  let n = lengths.get(t);
  if (n === undefined) { n = words(t.text).length; lengths.set(t, n); }
  return n;
}

/** log of the gamma function (Lanczos, g = 7), accurate to about 15 digits for positive x */
function logGamma(x: number): number {
  const c = [0.99999999999980993, 676.5203681218851, -1259.1392167224028, 771.32342877765313, -176.61502916214059,
    12.507343278686905, -0.13857109526572012, 9.9843695780195716e-6, 1.5056327351493116e-7];
  if (x < 0.5) return Math.log(Math.PI / Math.sin(Math.PI * x)) - logGamma(1 - x);
  const y = x - 1;
  let s = c[0]!;
  for (let i = 1; i < c.length; i++) s += c[i]! / (y + i);
  const t = y + 7.5;
  return 0.5 * Math.log(2 * Math.PI) + (y + 0.5) * Math.log(t) - t + Math.log(s);
}

/** regularised lower incomplete gamma P(a, x), by its series below a + 1 and its continued fraction above */
function gammaP(a: number, x: number): number {
  if (x <= 0) return 0;
  const front = Math.exp(a * Math.log(x) - x - logGamma(a));
  if (x < a + 1) {
    let term = 1 / a, sum = term;
    for (let n = 1; n < 1e6 && Math.abs(term) > Math.abs(sum) * 1e-15; n++) { term *= x / (a + n); sum += term; }
    return Math.min(1, sum * front);
  }
  const tiny = 1e-300;
  let b = x + 1 - a, c = 1 / tiny, d = 1 / b, h = d;
  for (let i = 1; i < 1e6; i++) {
    const an = -i * (i - a);
    b += 2;
    d = an * d + b; if (Math.abs(d) < tiny) d = tiny;
    c = b + an / c; if (Math.abs(c) < tiny) c = tiny;
    d = 1 / d;
    const delta = d * c;
    h *= delta;
    if (Math.abs(delta - 1) < 1e-15) break;
  }
  return Math.max(0, 1 - front * h);
}

/** the x at which P(a, x) reaches p, by bisection; P is increasing in x, so this cannot miss */
function gammaQuantile(a: number, p: number): number {
  if (a <= 0) return 0;
  let lo = 0, hi = a + 20 * Math.sqrt(a) + 20;
  for (let i = 0; i < 200 && hi - lo > 1e-12 * hi; i++) {
    const mid = (lo + hi) / 2;
    if (gammaP(a, mid) < p) lo = mid; else hi = mid;
  }
  return (lo + hi) / 2;
}

/**
 * Exact (Garwood) 95% bounds on a Poisson mean after seeing k events. At k = 0 they are 0 and about
 * 3.7; a normal approximation gives 0 and 0 there, and any arm that used the word once would clear it.
 */
export function poissonInterval(k: number): [number, number] {
  return [gammaQuantile(k, 0.025), gammaQuantile(k + 1, 0.975)];
}

/**
 * Pearson dispersion of per-text counts around the arm's own rate, floored at 1. A writer who uses
 * a word once tends to use it again in the same text, so occurrences are not independent and a
 * Poisson interval on their total is too narrow; this estimates how many times larger the variance
 * of the total really is.
 */
function dispersionOf(counts: number[], sizes: number[], occurrences: number, total: number): number {
  if (!occurrences || !total) return 1;
  const lambda = occurrences / total;
  let chi2 = 0, n = 0;
  counts.forEach((c, i) => {
    const e = lambda * sizes[i]!;
    if (e > 0) { chi2 += (c - e) ** 2 / e; n++; }
  });
  return n > 1 ? Math.max(1, chi2 / (n - 1)) : 1;
}

/** every text's count of the marker and its length in words, with their totals */
function tally(texts: Text[], m: Marker): { counts: number[]; sizes: number[]; occurrences: number; total: number } {
  let occurrences = 0, total = 0;
  const counts: number[] = [], sizes: number[] = [];
  for (const t of texts) {
    const w = lengthOf(t);
    const c = m.count ? m.count(t.text) : m.test(t.text) ? 1 : 0;
    counts.push(c); sizes.push(w);
    total += w;
    occurrences += c;
  }
  return { counts, sizes, occurrences, total };
}

/**
 * Occurrences per thousand words. The interval is the exact Poisson one, taken on the count divided
 * by the dispersion and scaled back (the quasi-Poisson reading), so a rate resting on three
 * occurrences, or on one text that repeats a word ten times, says so.
 */
export function rate(texts: Text[], m: Marker): Rate {
  const { counts, sizes, occurrences, total } = tally(texts, m);
  const dispersion = dispersionOf(counts, sizes, occurrences, total);
  if (!total) return { texts: texts.length, words: 0, occurrences, per1000: 0, lo: 0, hi: 0, dispersion };
  const [lo, hi] = poissonInterval(occurrences / dispersion);
  return {
    texts: texts.length, words: total, occurrences, per1000: (1000 * occurrences) / total,
    lo: (1000 * dispersion * lo) / total, hi: (1000 * dispersion * hi) / total, dispersion,
  };
}

/** two-sided tail of the standard normal beyond |z| (Abramowitz and Stegun 26.2.17) */
function normalTwoSided(z: number): number {
  const x = Math.abs(z);
  const t = 1 / (1 + 0.2316419 * x);
  const d = 0.3989423 * Math.exp((-x * x) / 2);
  const tail = d * t * (0.3193815 + t * (-0.3565638 + t * (1.781478 + t * (-1.821256 + t * 1.330274))));
  return Math.min(1, 2 * tail);
}

export function twoProportionP(k1: number, n1: number, k2: number, n2: number): number | null {
  if (!n1 || !n2) return null;
  const p1 = k1 / n1, p2 = k2 / n2, p = (k1 + k2) / (n1 + n2);
  const se = Math.sqrt(p * (1 - p) * (1 / n1 + 1 / n2));
  if (se === 0) return 1;
  return normalTwoSided(Math.abs(p1 - p2) / se);
}

/** the z at which the two-sided normal tail is p: the inverse of normalTwoSided, by bisection */
function normalDeviate(p: number): number {
  if (p >= 1) return 0;
  let lo = 0, hi = 40;
  for (let i = 0; i < 100; i++) {
    const mid = (lo + hi) / 2;
    if (normalTwoSided(mid) > p) lo = mid; else hi = mid;
  }
  return (lo + hi) / 2;
}

/** the binomial distribution of n trials at p, computed in logs so a long tail does not underflow early */
function binomialPmf(n: number, p: number): number[] {
  const lp = Math.log(p), lq = Math.log1p(-p), top = logGamma(n + 1);
  return Array.from({ length: n + 1 }, (_, k) => Math.exp(top - logGamma(k + 1) - logGamma(n - k + 1) + k * lp + (n - k) * lq));
}

function convolve(a: number[], b: number[]): number[] {
  const out = new Array<number>(a.length + b.length - 1).fill(0);
  for (let i = 0; i < a.length; i++) {
    if (a[i] === 0) continue;
    for (let j = 0; j < b.length; j++) out[i + j]! += a[i]! * b[j]!;
  }
  return out;
}

/**
 * Past this many occurrences the normal approximation is as good as the exact sum, and the
 * convolution, which grows with the square of the count, is not worth its time.
 */
const EXACT_LIMIT = 5000;

/** one stratum of a rate comparison: the first arm's occurrences, all occurrences, the first arm's share of the words */
interface Stratum { x: number; n: number; p0: number }

/**
 * The conditional test between two rates. If the rates were equal, then of the n occurrences seen in
 * a stratum, the number that fell in the first arm would be binomial with the first arm's share of
 * that stratum's words, whatever the common rate is; over several strata the first arm's total is
 * the sum of those binomials. Its distribution is summed exactly, and the p is the probability of
 * every total no likelier than the one seen. A normal approximation misjudges this badly when one arm
 * has most of a stratum's words: 2 occurrences in 2,000 words against 3 in 270,000 reads as
 * p = 2e-14 there, and exactly it is 5e-4.
 * Clustered occurrences carry less information than independent ones, so the dispersion widens the
 * variance: the exact p is turned into its normal deviate, which the dispersion scales down as it
 * would scale the normal test's. With no dispersion the p is the exact one.
 */
function conditionalTest(strata: Stratum[], phi: number): { p: number; observed: number; expected: number } {
  let observed = 0, expected = 0, variance = 0, n = 0;
  for (const s of strata) {
    observed += s.x; expected += s.n * s.p0; variance += s.n * s.p0 * (1 - s.p0); n += s.n;
  }
  if (n === 0) return { p: 1, observed, expected };
  if (n > EXACT_LIMIT) {
    const z = Math.max(0, Math.abs(observed - expected) - 0.5) / Math.sqrt(phi * variance);
    return { p: normalTwoSided(z), observed, expected };
  }
  let dist = [1];
  for (const s of strata) dist = convolve(dist, binomialPmf(s.n, s.p0));
  const seen = dist[observed]! * (1 + 1e-7);
  let p = 0;
  for (const q of dist) if (q <= seen) p += q;
  p = Math.min(1, p);
  return { p: phi > 1 ? normalTwoSided(normalDeviate(p) / Math.sqrt(phi)) : p, observed, expected };
}

/** the two arms' dispersion, pooled over their texts */
function pooledDispersion(x: { dispersion: number; texts: number }, y: { dispersion: number; texts: number }): number {
  const dfx = Math.max(0, x.texts - 1), dfy = Math.max(0, y.texts - 1);
  return dfx + dfy > 0 ? Math.max(1, (x.dispersion * dfx + y.dispersion * dfy) / (dfx + dfy)) : 1;
}

/**
 * Two whole-arm rates, compared on their counts with no regard to length (one stratum). A pair with
 * no occurrence at all has nothing to compare and gets p = 1.
 */
export function twoRateP(x: Rate, y: Rate): number | null {
  if (!x.words || !y.words) return null;
  const n = x.occurrences + y.occurrences;
  return conditionalTest([{ x: x.occurrences, n, p0: x.words / (x.words + y.words) }], pooledDispersion(x, y)).p;
}

/**
 * Length strata for comparing rates, a tenth wide on a log scale: two texts in one stratum differ in
 * length by less than a tenth. The share bins are too coarse for this. Inside 130-219 words GPT-4's
 * abstracts average 135 words and the people's 174, and a phrase that both use in one text of every
 * five would come out 29% more frequent in GPT-4.
 */
const STRATUM = Math.log(1.1);
const stratumOf = (words: number): number => Math.floor(Math.log(words) / STRATUM);

/**
 * Two arms' rates of a marker, compared only between texts of about the same length: the
 * conditional test above, one stratum per length stratum that both arms have texts in. A stratum
 * only one arm reaches says nothing about the writer and is left out; when no stratum is shared, or
 * no occurrence falls in one, p is 1. `observed` and `expected` say which way the first arm leans.
 */
export function lengthMatchedRateTest(xs: Text[], ys: Text[], m: Marker): { p: number; observed: number; expected: number } | null {
  const x = tally(xs, m), y = tally(ys, m);
  if (!x.total || !y.total) return null;
  // per stratum: the first arm's occurrences and words, then the second's
  const cells = new Map<number, [number, number, number, number]>();
  const add = (occ: 0 | 2, words: 1 | 3, counts: number[], sizes: number[]): void => {
    sizes.forEach((w, i) => {
      if (!w) return;
      const key = stratumOf(w);
      const cell = cells.get(key) ?? [0, 0, 0, 0];
      cell[occ] += counts[i]!;
      cell[words] += w;
      cells.set(key, cell);
    });
  };
  add(0, 1, x.counts, x.sizes);
  add(2, 3, y.counts, y.sizes);
  const strata: Stratum[] = [];
  for (const [ox, wx, oy, wy] of cells.values()) {
    if (wx && wy && ox + oy) strata.push({ x: ox, n: ox + oy, p0: wx / (wx + wy) });
  }
  const phi = pooledDispersion(
    { dispersion: dispersionOf(x.counts, x.sizes, x.occurrences, x.total), texts: xs.length },
    { dispersion: dispersionOf(y.counts, y.sizes, y.occurrences, y.total), texts: ys.length },
  );
  return conditionalTest(strata, phi);
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
const binOf = (t: Text): number => { const n = lengthOf(t); return BINS.findIndex(([lo, hi]) => n >= lo && n <= hi); };

/** a seed of its own for every bin and side, so no two shuffles in a pairing run in step */
const binSeed = (seed: number, bin: number, side: number): number => (seed + Math.imul(2 * bin + side + 1, 0x9e3779b1)) >>> 0;

/**
 * Two arms, cut to the same number of texts in every length bin. Each bin is shuffled before it is
 * cut: the corpora are stored grouped by topic, so the first N texts of a bin would be one subject.
 * The reference side gets the same shuffle in every pairing, so its samples are nested.
 */
export function pairMatch(a: Text[], b: Text[], seed = DEFAULT_SEED): [Text[], Text[]] {
  const outA: Text[] = [], outB: Text[] = [];
  BINS.forEach((_, i) => {
    const ba = seededShuffle(a.filter((t) => binOf(t) === i), binSeed(seed, i, 0));
    const bb = seededShuffle(b.filter((t) => binOf(t) === i), binSeed(seed, i, 1));
    const take = Math.min(ba.length, bb.length);
    outA.push(...ba.slice(0, take));
    outB.push(...bb.slice(0, take));
  });
  return [outA, outB];
}

/** the document a text was written from: a RAID id carries its writer in front, the Claude arm's does not */
export const sourceId = (id: string): string => id.replace(/^raid:[a-z0-9.-]+:/, '');

/**
 * Two arms written from the same documents, paired document by document. A pair is kept only when
 * both texts fall in the same length bin, so length is controlled inside every pair and the two sides
 * cover exactly the same subjects. The sides come back in step: the i-th text of each is one document.
 */
export function pairByDocument(a: Text[], b: Text[]): [Text[], Text[]] {
  const pool = new Map<string, Text[]>();
  for (const t of a) {
    const key = sourceId(t.id);
    const list = pool.get(key);
    if (list) list.push(t); else pool.set(key, [t]);
  }
  const outA: Text[] = [], outB: Text[] = [];
  for (const t of b) {
    const bin = binOf(t);
    const list = pool.get(sourceId(t.id));
    if (bin < 0 || !list) continue;
    const i = list.findIndex((x) => binOf(x) === bin);
    if (i < 0) continue;
    outA.push(list.splice(i, 1)[0]!);
    outB.push(t);
  }
  return [outA, outB];
}

/** whether most of an arm was written from documents the reference also has */
function sharesDocuments(reference: Text[], arm: Text[]): boolean {
  const ids = new Set(reference.map((t) => sourceId(t.id)));
  return arm.length > 0 && arm.filter((t) => ids.has(sourceId(t.id))).length * 2 > arm.length;
}

/** a 32-bit generator whose every bit is mixed (mulberry32), returning numbers in [0, 1) */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Deterministic shuffle, so the placebo split and the bin samples are random but the run reproduces.
 * The index is scaled from the whole output rather than taken as a remainder: the low bits of a
 * linear congruential generator alternate, and a remainder of them fixed the parity of every swap.
 */
export function seededShuffle<T>(items: T[], seed: number): T[] {
  const out = [...items];
  const r = mulberry32(seed);
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(r() * (i + 1));
    [out[i], out[j]] = [out[j]!, out[i]!];
  }
  return out;
}

interface Matched { pairing: Pairing; ref: Text[]; arm: Text[] }

/**
 * `notRecorded` names markers the kind of writing cannot show on either side (scripts/genres.ts). Their
 * shares and rates are still published, but they get no test: a marker no text can carry would add a
 * certain "no difference" to the correction and read as a measured "no signal".
 */
export function measure(arms: Arm[], opts: { reference: string; casual: string; machine: string; seed?: number; notRecorded?: string[] }): Report {
  const find = (id: string): Arm | undefined => arms.find((a) => a.id === id);
  const reference = find(opts.reference);
  if (!reference) throw new Error(`reference arm ${opts.reference} is not among the arms`);
  const seed = opts.seed ?? DEFAULT_SEED;

  // one pairing per arm, computed once; a marker that cannot judge every text narrows it (below)
  const matched = new Map<string, Matched>();
  for (const a of arms) {
    if (a.id === reference.id) matched.set(a.id, { pairing: 'self', ref: reference.texts, arm: reference.texts });
    else if (sharesDocuments(reference.texts, a.texts)) { const [ref, arm] = pairByDocument(reference.texts, a.texts); matched.set(a.id, { pairing: 'document', ref, arm }); }
    else { const [ref, arm] = pairMatch(reference.texts, a.texts, seed); matched.set(a.id, { pairing: 'length', ref, arm }); }
  }

  const shuffled = seededShuffle(reference.texts, seed);
  const half = Math.floor(shuffled.length / 2);
  const halfA = shuffled.slice(0, half), halfB = shuffled.slice(half);

  /**
   * The pairing a marker is measured on. With no eligibility rule it is the arm's own; otherwise a
   * document pair survives only when both texts can be judged, and a length match is redrawn from
   * the texts that can, so the bins are filled again rather than left short.
   */
  const pairingFor = (a: Arm, m: Marker): [Text[], Text[]] => {
    const x = matched.get(a.id)!;
    const ok = m.eligible;
    if (!ok) return [x.ref, x.arm];
    if (x.pairing === 'length') return pairMatch(reference.texts.filter((t) => ok(t.text)), a.texts.filter((t) => ok(t.text)), seed);
    const keep = x.ref.map((t, i) => ok(t.text) && ok(x.arm[i]!.text));
    return [x.ref.filter((_, i) => keep[i]), x.arm.filter((_, i) => keep[i])];
  };
  const judged = (texts: Text[], m: Marker): Text[] => (m.eligible ? texts.filter((t) => m.eligible!(t.text)) : texts);

  const machineArm = find(opts.machine);
  /**
   * The person's texts a word's rate test compares the machine arm with. A machine arm written from
   * the reference's documents is compared with the person's texts for the documents it still has:
   * the cleaning drops some of a model's texts (refusals cluster on some subjects, cut-off texts on
   * long ones), and the person's texts for those documents would otherwise stand on one side only.
   * Any other arm is compared with every reference text.
   */
  const testedReference = machineArm && matched.get(machineArm.id)?.pairing === 'document'
    ? ((ids) => reference.texts.filter((t) => ids.has(sourceId(t.id))))(new Set(machineArm.texts.map((t) => sourceId(t.id))))
    : reference.texts;
  const unrecorded = new Set(opts.notRecorded ?? []);
  const rows: Row[] = MARKERS.map((m) => {
    const countable = m.count !== undefined;
    const tested = !unrecorded.has(m.id);
    const sh: Row['share'] = {};
    const rt: Row['rate'] = {};
    for (const a of arms) {
      const [ref, arm] = pairingFor(a, m);
      sh[a.id] = { arm: share(arm, m), reference: share(ref, m) };
      rt[a.id] = rate(judged(a.texts, m), m);
    }

    const [pa, pb] = m.eligible ? pairMatch(judged(halfA, m), judged(halfB, m), seed) : pairMatch(halfA, halfB, seed);
    const a = share(pa, m), b = share(pb, m);
    const ra = rate(judged(halfA, m), m), rb = rate(judged(halfB, m), m);
    const placeboP = !tested ? null : countable
      ? (lengthMatchedRateTest(judged(halfA, m), judged(halfB, m), m)?.p ?? null)
      : twoProportionP(a.k, a.n, b.k, b.n);

    const machine = sh[opts.machine];
    const test = tested && countable && machineArm ? lengthMatchedRateTest(judged(machineArm.texts, m), judged(testedReference, m), m) : null;
    const p = !tested ? null : countable
      ? (test?.p ?? null)
      : (machine ? twoProportionP(machine.arm.k, machine.arm.n, machine.reference.k, machine.reference.n) : null);

    return {
      marker: m.id, label: m.label, family: m.family, belief: m.belief === true, countable,
      share: sh, rate: rt,
      // a whole-text tie is settled here; a countable one waits for the correction below
      placebo: { a, b, tie: countable || !tested || (a.lo <= b.hi && b.lo <= a.hi), rate: { a: ra, b: rb }, p: placeboP, q: null },
      p, q: null, lengthMatched: test && { observed: test.observed, expected: test.expected }, verdict: 'no signal',
    };
  });

  const qs = benjaminiHochberg(rows.map((r) => r.p));
  const placeboQs = benjaminiHochberg(rows.map((r) => r.placebo.p));
  rows.forEach((r, i) => {
    r.q = qs[i]!;
    r.placebo.q = placeboQs[i]!;
    if (r.countable) r.placebo.tie = !(r.placebo.q !== null && r.placebo.q < SIGNIFICANCE);
    r.verdict = unrecorded.has(r.marker) ? 'not recorded' : r.countable ? rateVerdict(r, reference.id, opts) : shareVerdict(r, opts);
  });

  const median = (texts: Text[]): number => {
    const l = texts.map(lengthOf).sort((x, y) => x - y);
    return l.length ? l[Math.floor(l.length / 2)]! : 0;
  };
  return {
    generated_at: new Date().toISOString(),
    reference: reference.id,
    machine: opts.machine,
    arms: arms.map((a) => {
      const x = matched.get(a.id)!;
      return { id: a.id, label: a.label, kind: a.kind, n: a.texts.length, matchedWithReference: x.arm.length, pairing: x.pairing, medianWords: median(a.texts) };
    }),
    rows,
  };
}

/**
 * A whole-text marker, decided on the length-matched shares: the machine and the reference apart
 * when their intervals do not overlap, and a register marker when both sit above casual writing.
 */
function shareVerdict(r: Row, opts: { casual: string; machine: string }): Row['verdict'] {
  const machine = r.share[opts.machine];
  const casual = r.share[opts.casual];
  if (!machine || machine.arm.n === 0) return 'not recorded';
  if (machine.arm.lo > machine.reference.hi) return 'machine marker';
  if (machine.arm.hi < machine.reference.lo) return 'points the other way';
  // with no casual text the marker can judge, an empty interval would sit below anything
  if (casual && casual.arm.n > 0 && machine.reference.lo > casual.arm.hi && machine.arm.lo > casual.arm.hi) return 'register marker';
  return 'no signal';
}

/**
 * A word or phrase, decided on the length-matched rate test: which way the machine arm leans at the
 * same lengths when the test survives the correction, and a register marker when neither side is
 * told apart but both whole-arm rate intervals sit above casual writing's. Every text of the machine
 * arm goes into the test, against the person's texts for the same documents (testedReference in
 * measure), so the two sides cover the same subjects without any pairing. The rates shown are whole
 * arms, the person's included, which for a model with texts dropped covers a few more documents than
 * its test did. Casual writing is the shortest arm, and a phrase used once per text has its highest
 * rate in short texts, so the register comparison errs toward no signal.
 */
function rateVerdict(r: Row, reference: string, opts: { casual: string; machine: string }): Row['verdict'] {
  const machine = r.rate[opts.machine], ref = r.rate[reference]!, casual = r.rate[opts.casual];
  if (!machine || machine.words === 0) return 'not recorded';
  if (r.q !== null && r.q < SIGNIFICANCE && r.lengthMatched) {
    return r.lengthMatched.observed > r.lengthMatched.expected ? 'machine marker' : 'points the other way';
  }
  if (casual && casual.words > 0 && ref.lo > casual.hi && machine.lo > casual.hi) return 'register marker';
  return 'no signal';
}
