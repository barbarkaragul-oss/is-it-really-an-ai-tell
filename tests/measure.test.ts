import test from 'node:test';
import assert from 'node:assert/strict';
import {
  wilson, twoProportionP, twoRateP, lengthMatchedRateTest, benjaminiHochberg, pairMatch, pairByDocument, pairByPrompt, sourceId, seededShuffle, measure, rate, share,
  poissonInterval, type Arm, type Text,
} from '../src/measure.js';
import { MARKERS, sentenceLengthCv, byId } from '../src/markers.js';

const texts = (n: number, body: (i: number) => string, tag = 't') =>
  Array.from({ length: n }, (_, i) => ({ id: `${tag}${i}`, text: body(i), source: tag }));

/** a filler sentence of about `w` words, so a text can be put in a chosen length bin */
const filler = (w: number, seed = 0) => Array.from({ length: w }, (_, i) => `word${(i + seed) % 7}`).join(' ') + '.';

const delve = byId.get('delve')!;

test('wilson: an interval that survives zero events and small n', () => {
  const [lo, hi] = wilson(0, 100);
  assert.equal(lo, 0);
  assert.ok(hi > 0 && hi < 5, `0/100 should have a small but non-zero upper bound, got ${hi}`);
  const [lo2, hi2] = wilson(50, 100);
  assert.ok(lo2 > 39 && hi2 < 61, `50/100 -> ${lo2}..${hi2}`);
  assert.deepEqual(wilson(0, 0), [0, 0]);
  const wide = wilson(1, 5), narrow = wilson(200, 1000);
  assert.ok(wide[1] - wide[0] > narrow[1] - narrow[0], 'more data must give a tighter interval');
});

test('two-proportion p: obvious differences are small, identical ones are not', () => {
  assert.ok(twoProportionP(90, 100, 10, 100)! < 1e-10);
  assert.ok(twoProportionP(50, 100, 50, 100)! > 0.9);
  assert.ok(twoProportionP(55, 100, 45, 100)! > 0.05, 'a 10 point gap at n=100 is not significant');
  assert.equal(twoProportionP(1, 0, 1, 10), null);
});

test('poisson interval: the exact Garwood bounds, and room above zero when nothing was seen', () => {
  // chi-square quantiles halved: qchisq(0.025, 2k) / 2 and qchisq(0.975, 2k + 2) / 2
  const known: [number, number, number][] = [[0, 0, 3.688879], [1, 0.025318, 5.571643], [5, 1.623486, 11.668332], [10, 4.795389, 18.390356]];
  for (const [k, lo, hi] of known) {
    const [a, b] = poissonInterval(k);
    assert.ok(Math.abs(a - lo) < 1e-4 && Math.abs(b - hi) < 1e-4, `k=${k}: got ${a}..${b}, want ${lo}..${hi}`);
  }
  const zero = rate(texts(100, (i) => filler(100, i)), delve);
  assert.equal(zero.occurrences, 0);
  assert.equal(zero.lo, 0);
  assert.ok(zero.hi > 0, 'a word nobody used must still have a non-zero upper bound, or any other arm clears it');
});

test('rate: clustered occurrences widen the interval, spread-out ones do not', () => {
  // the same 40 occurrences, once in each of 40 texts or ten times in each of 4
  const spread = rate(texts(400, (i) => (i % 10 === 0 ? 'We delve. ' : 'We look. ') + filler(100, i)), delve);
  const clumped = rate(texts(400, (i) => (i % 100 === 0 ? 'delve '.repeat(10) + '. ' : 'We look. ') + filler(100, i)), delve);
  assert.equal(spread.occurrences, 40);
  assert.equal(clumped.occurrences, 40);
  assert.equal(spread.dispersion, 1);
  assert.ok(clumped.dispersion > 5, `ten to a text is not ten independent uses, dispersion ${clumped.dispersion}`);
  assert.ok(clumped.hi - clumped.lo > 2 * (spread.hi - spread.lo), 'the clumped rate must be less certain');
});

test('two-rate p: exact when one arm has far fewer words, where a normal approximation is not', () => {
  const r = (occurrences: number, words: number) => ({ texts: 1000, words, occurrences, per1000: 0, lo: 0, hi: 0, dispersion: 1 });
  // the conditional binomial test, two-sided by summing every outcome no likelier than the one seen (R's binom.test)
  const known: [number, number, number, number, number][] = [
    [1, 2000, 0, 270000, 7.35e-3],
    [2, 2000, 3, 270000, 5.33e-4],
    [3, 11000, 10, 270000, 1.28e-2],
    [5, 164000, 0, 270000, 7.70e-3],
  ];
  for (const [x, wx, y, wy, want] of known) {
    const got = twoRateP(r(x, wx), r(y, wy))!;
    assert.ok(Math.abs(got - want) / want < 0.01, `${x} in ${wx} against ${y} in ${wy}: ${got}, want ${want}`);
  }
});

test('two-rate p: follows the counts and the words, and knows when there is nothing to compare', () => {
  const r = (occurrences: number, words: number, texts = 100) => ({ texts, words, occurrences, per1000: 0, lo: 0, hi: 0, dispersion: 1 });
  assert.ok(twoRateP(r(200, 10000), r(20, 10000))! < 1e-10);
  assert.ok(twoRateP(r(100, 10000), r(100, 10000))! > 0.9);
  assert.ok(twoRateP(r(100, 10000), r(200, 20000))! > 0.9, 'twice the words and twice the count is the same rate');
  assert.equal(twoRateP(r(0, 10000), r(0, 10000)), 1, 'no occurrence anywhere is no evidence');
  assert.equal(twoRateP(r(3, 0, 0), r(3, 10000)), null);
  assert.equal(twoRateP(r(30, 10000), r(10, 10000)), twoRateP(r(10, 10000), r(30, 10000)), 'the test must not care which arm comes first');
  const clustered = { ...r(30, 10000), dispersion: 8 };
  assert.ok(twoRateP(clustered, { ...r(10, 10000), dispersion: 8 })! > twoRateP(r(30, 10000), r(10, 10000))!, 'dispersion must weaken the evidence');
});

test('benjamini-hochberg: monotone, never below the raw p, nulls preserved', () => {
  const ps = [0.001, 0.01, 0.03, 0.2, null, 0.5];
  const qs = benjaminiHochberg(ps);
  assert.equal(qs[4], null);
  for (let i = 0; i < ps.length; i++) if (ps[i] !== null) assert.ok(qs[i]! >= ps[i]!, `q must not be below p at ${i}`);
  const got = qs.filter((q): q is number => q !== null);
  for (let i = 1; i < got.length; i++) assert.ok(got[i]! >= got[i - 1]!, 'q must not decrease as p increases');
});

test('pair match: two arms, the same count in every length bin', () => {
  const a: Text[] = [...texts(10, () => filler(100), 'a'), ...texts(2, () => filler(150), 'a2')];
  const b: Text[] = [...texts(3, () => filler(100), 'b'), ...texts(9, () => filler(150), 'b2')];
  const [ma, mb] = pairMatch(a, b);
  assert.equal(ma.length, 5, 'three in the first bin and two in the second');
  assert.equal(mb.length, 5);
  const inBin = (ts: Text[], lo: number, hi: number) => ts.filter((t) => { const n = t.text.split(/\s+/).length; return n >= lo && n <= hi; }).length;
  assert.equal(inBin(ma, 80, 129), inBin(mb, 80, 129));
  assert.equal(inBin(ma, 130, 219), inBin(mb, 130, 219));
});

test('pair match: a bin is sampled from a shuffle, not from the top of the file', () => {
  // the file is grouped by topic: the first half of this arm is the topic that says "delve"
  const grouped = texts(200, (i) => (i < 100 ? 'We delve. ' : 'We look. ') + filler(100, i), 'g');
  const few = texts(50, (i) => filler(100, i), 'f');
  const [sample] = pairMatch(grouped, few);
  assert.equal(sample.length, 50);
  const firstHalf = sample.filter((t) => Number(t.id.slice(1)) < 100).length;
  assert.ok(firstHalf > 12 && firstHalf < 38, `the sample should mix both halves of the file, took ${firstHalf} of 50 from the first`);
  assert.notDeepEqual(sample.map((t) => t.id), grouped.slice(0, 50).map((t) => t.id));
  assert.deepEqual(pairMatch(grouped, few, 5)[0].map((t) => t.id), pairMatch(grouped, few, 5)[0].map((t) => t.id), 'the same seed must draw the same sample');
  assert.notDeepEqual(pairMatch(grouped, few, 5)[0].map((t) => t.id), pairMatch(grouped, few, 6)[0].map((t) => t.id));
});

test('document pairing: one document on each side, both in the same length bin, nothing else', () => {
  const ref: Text[] = [
    ...Array.from({ length: 10 }, (_, i) => ({ id: `raid:human:d${i}`, text: filler(100, i), source: 'h' })),
    // the person wrote 150 words, the model 100: different bins, so the pair is dropped
    ...Array.from({ length: 5 }, (_, i) => ({ id: `raid:human:d${10 + i}`, text: filler(150, i), source: 'h' })),
    // documents only the person has
    ...Array.from({ length: 5 }, (_, i) => ({ id: `raid:human:d${20 + i}`, text: filler(100, i), source: 'h' })),
    { id: 'raid:human:d25', text: filler(100), source: 'h' },
  ];
  const model: Text[] = [
    ...Array.from({ length: 10 }, (_, i) => ({ id: `raid:gpt4:d${9 - i}`, text: filler(100, i + 3), source: 'm' })),
    ...Array.from({ length: 5 }, (_, i) => ({ id: `raid:gpt4:d${10 + i}`, text: filler(100, i), source: 'm' })),
    // documents the person does not have
    ...Array.from({ length: 5 }, (_, i) => ({ id: `raid:gpt4:x${i}`, text: filler(100, i), source: 'm' })),
    // too short for any bin
    { id: 'raid:gpt4:d25', text: filler(40), source: 'm' },
  ];
  const [a, b] = pairByDocument(ref, model);
  assert.equal(a.length, 10);
  assert.equal(b.length, 10);
  const len = (t: Text) => t.text.split(/\s+/).length;
  for (let i = 0; i < a.length; i++) {
    assert.equal(sourceId(a[i]!.id), sourceId(b[i]!.id), `pair ${i} joins two different documents`);
    assert.ok(len(a[i]!) >= 80 && len(a[i]!) <= 129 && len(b[i]!) >= 80 && len(b[i]!) <= 129, `pair ${i} is not in one bin`);
  }
  assert.equal(new Set(a.map((t) => t.id)).size, 10, 'a reference text is used once');

  // the generated Claude arm carries the bare document id, and pairs all the same
  const bare = Array.from({ length: 10 }, (_, i) => ({ id: `d${i}`, text: filler(100, i), source: 'c' }));
  assert.equal(pairByDocument(ref, bare)[0].length, 10);

  const arms: Arm[] = [
    { id: 'casual', label: 'casual', kind: 'human', texts: texts(30, (i) => filler(100, i), 'c') },
    { id: 'person', label: 'person', kind: 'human', texts: ref },
    { id: 'model', label: 'model', kind: 'machine', texts: model },
  ];
  const r = measure(arms, { reference: 'person', casual: 'casual', machine: 'model' });
  const info = (id: string) => r.arms.find((x) => x.id === id)!;
  assert.equal(info('model').pairing, 'document');
  assert.equal(info('model').matchedWithReference, 10);
  assert.equal(info('casual').pairing, 'length', 'an arm with none of the documents is matched by length');
  assert.equal(info('person').pairing, 'self');
  assert.equal(r.rows.find((x) => x.marker === 'delve')!.share.model!.reference.n, 10);
});

/** essays written to one assignment: what a pairing by assignment has to pair inside */
const essays = (n: number, group: string, length: number, tag: string): Text[] =>
  Array.from({ length: n }, (_, i) => ({ id: `${tag}${i}`, text: filler(length, i), source: tag, group }));

/** which of the two bins these fixtures use a text falls in, or -1 for a text no bin holds */
const twoBins = (t: Text): number => {
  const n = t.text.split(/\s+/).length;
  return [[80, 129], [130, 219]].findIndex(([lo, hi]) => n >= lo! && n <= hi!);
};

test('prompt pairing: inside one assignment and one length bin, and nothing across two', () => {
  // two assignments, two bins, and on each side essays too long or too short for any bin
  const person: Text[] = [
    ...essays(10, 'phones', 100, 'p1'), ...essays(4, 'phones', 150, 'p2'),
    ...essays(6, 'summer', 100, 'p3'), ...essays(8, 'summer', 150, 'p4'),
    ...essays(3, 'phones', 900, 'p5'), ...essays(2, 'summer', 60, 'p6'),
  ];
  const model: Text[] = [
    ...essays(3, 'phones', 100, 'm1'), ...essays(9, 'phones', 150, 'm2'),
    ...essays(7, 'summer', 100, 'm3'), ...essays(2, 'summer', 150, 'm4'),
    ...essays(5, 'phones', 900, 'm5'),
  ];
  const [a, b] = pairByPrompt(person, model);
  // the smaller side of each (assignment, bin) cell: 3 + 4 + 6 + 2
  assert.equal(a.length, 15);
  assert.equal(b.length, 15);
  for (let i = 0; i < a.length; i++) {
    assert.equal(a[i]!.group, b[i]!.group, `pair ${i} joins two assignments`);
    assert.equal(twoBins(a[i]!), twoBins(b[i]!), `pair ${i} joins two length bins`);
    assert.ok(twoBins(a[i]!) >= 0, `pair ${i} rests on a text no bin holds`);
  }
  const cell = (ts: Text[], g: string, bin: number) => ts.filter((t) => t.group === g && twoBins(t) === bin).length;
  const cells = (ts: Text[]) => [cell(ts, 'phones', 0), cell(ts, 'phones', 1), cell(ts, 'summer', 0), cell(ts, 'summer', 1)];
  assert.deepEqual(cells(a), [3, 4, 6, 2]);
  assert.deepEqual(cells(b), [3, 4, 6, 2]);
  // the 900-word and 60-word essays belong to no bin and are dropped on both sides, not paired across bins
  assert.equal([...a, ...b].filter((t) => /^(p5|p6|m5)/.test(t.id)).length, 0);
  // an assignment only one side wrote to pairs with nothing at all
  assert.deepEqual(pairByPrompt(essays(5, 'phones', 100, 'x'), essays(5, 'summer', 100, 'y')), [[], []]);
  // and a text that names no assignment is left out rather than pooled with the others
  assert.deepEqual(pairByPrompt(texts(5, () => filler(100), 'u'), essays(5, 'summer', 100, 'y')), [[], []]);
  // the draw is seeded per assignment: one seed takes the same essays every time, another does not
  const ids = (seed: number) => pairByPrompt(person, model, seed)[0].map((t) => t.id);
  assert.deepEqual(ids(5), ids(5), 'the same seed must draw the same sample');
  assert.notDeepEqual(ids(5), ids(6));
});

test('prompt pairing is asked for by the kind of writing, and is never reported as a document pairing', () => {
  const person = [...essays(40, 'phones', 100, 'ph'), ...essays(40, 'summer', 150, 'su')];
  // the machine arm carries the person's own ids, as forging a document pairing would have them
  const model = [...essays(20, 'phones', 100, 'ph'), ...essays(20, 'summer', 150, 'su')];
  const arms: Arm[] = [
    { id: 'casual', label: 'casual', kind: 'human', texts: texts(60, (i) => filler(100, i), 'c') },
    { id: 'person', label: 'person', kind: 'human', texts: person },
    { id: 'model', label: 'model', kind: 'machine', texts: model },
  ];
  const opts = { reference: 'person', casual: 'casual', machine: 'model' };
  const asked = measure(arms, { ...opts, pairing: 'prompt' });
  const info = (r: typeof asked, id: string) => r.arms.find((x) => x.id === id)!;
  assert.equal(info(asked, 'model').pairing, 'prompt', 'the ids say document; only the kind of writing may say otherwise');
  assert.equal(info(asked, 'model').matchedWithReference, 40, 'twenty essays in each of the two cells');
  assert.equal(info(asked, 'casual').pairing, 'length', 'a column from another kind of writing names no assignment');
  assert.equal(info(asked, 'person').pairing, 'self');
  // the shares are read on those pairs, both sides the same size
  const row = asked.rows.find((x) => x.marker === 'delve')!;
  assert.equal(row.share.model!.arm.n, 40);
  assert.equal(row.share.model!.reference.n, 40);
  // without the option nothing asks for it, and these ids are shared, so the old document pairing stands
  assert.equal(info(measure(arms, opts), 'model').pairing, 'document');
  // an arm where only some texts name an assignment is a collection fault, not a length pairing
  const half: Arm = { ...arms[2]!, texts: model.map((t, i) => (i % 2 ? t : { id: t.id, text: t.text, source: t.source })) };
  assert.throws(() => measure([arms[0]!, arms[1]!, half], { ...opts, pairing: 'prompt' }), /20 of 40 texts name no assignment/);
  assert.doesNotThrow(() => measure([arms[0]!, arms[1]!, half], opts), 'a kind of writing that pairs by document never looks at assignments');
  // a reference that names no assignment cannot give the pairing that was asked for either, and the
  // run stops instead of publishing "length" for a kind of writing whose registry says "prompt"
  const bare: Arm = { ...arms[1]!, texts: person.map((t) => ({ id: t.id, text: t.text, source: t.source })) };
  assert.throws(() => measure([arms[0]!, bare, arms[2]!], { ...opts, pairing: 'prompt' }), /none of its 80 texts name an assignment/);
});

test('seeded shuffle: reproducible, a permutation, and not the identity', () => {
  const xs = Array.from({ length: 50 }, (_, i) => i);
  const a = seededShuffle(xs, 7), b = seededShuffle(xs, 7), c = seededShuffle(xs, 8);
  assert.deepEqual(a, b, 'the same seed must give the same order');
  assert.notDeepEqual(a, c, 'a different seed must give a different order');
  assert.deepEqual([...a].sort((p, q) => p - q), xs, 'must be a permutation');
  assert.notDeepEqual(a, xs);
});

test('seeded shuffle: a random half holds even and odd positions alike', () => {
  // the old generator took each swap from its low bits and put 314 even and 435 odd positions in half A
  const xs = Array.from({ length: 1499 }, (_, i) => i);
  for (const seed of [20260916, 1, 2, 3, 12345]) {
    const half = seededShuffle(xs, seed).slice(0, 749);
    const even = half.filter((x) => x % 2 === 0).length;
    assert.ok(Math.abs(even - 749 / 2) < 40, `seed ${seed}: ${even} even of 749`);
    // and every tenth of the file is represented about equally
    const perTenth = Array.from({ length: 10 }, (_, s) => half.filter((x) => Math.floor(x / 150) === s).length);
    assert.ok(Math.min(...perTenth) > 45 && Math.max(...perTenth) < 105, `seed ${seed}: ${perTenth.join(' ')}`);
  }
});

test('the placebo agrees when both halves come from one corpus', () => {
  // one arm, half its texts carrying a marker, split at random: the two halves must tie
  const human = texts(400, (i) => (i % 3 === 0 ? 'It is important to note that. ' : '') + filler(120, i), 'h');
  const arms: Arm[] = [
    { id: 'casual', label: 'casual', kind: 'human', texts: human },
    { id: 'careful', label: 'careful', kind: 'human', texts: texts(400, (i) => filler(120, i), 'c') },
    { id: 'machine', label: 'machine', kind: 'machine', texts: texts(400, (i) => filler(120, i), 'm') },
  ];
  const r = measure(arms, { reference: 'careful', casual: 'casual', machine: 'machine' });
  const disagreements = r.rows.filter((x) => !x.placebo.tie);
  assert.equal(disagreements.length, 0, `placebo must tie everywhere, disagreed on: ${disagreements.map((d) => d.marker).join(', ')}`);
});

test('the placebo ties on a word a few writers repeat, whichever way the split falls', () => {
  // twenty texts use "delve" fifteen times each; a split that puts 7 in one half and 13 in the other
  // is 105 against 195, which a test that took every occurrence as independent would call a finding
  const reference = texts(400, (i) => (i % 20 === 0 ? 'delve '.repeat(15) + '. ' : 'We look. ') + filler(120, i), 'r');
  const arms: Arm[] = [
    { id: 'casual', label: 'casual', kind: 'human', texts: texts(100, (i) => filler(120, i), 'c') },
    { id: 'reference', label: 'reference', kind: 'human', texts: reference },
    { id: 'machine', label: 'machine', kind: 'machine', texts: texts(100, (i) => filler(120, i), 'm') },
  ];
  for (let seed = 1; seed <= 10; seed++) {
    const row = measure(arms, { reference: 'reference', casual: 'casual', machine: 'machine', seed }).rows.find((x) => x.marker === 'delve')!;
    assert.ok(row.placebo.tie, `seed ${seed}: ${row.placebo.rate.a.occurrences} against ${row.placebo.rate.b.occurrences}, q ${row.placebo.q}`);
    assert.equal(row.placebo.rate.a.occurrences + row.placebo.rate.b.occurrences, 300);
  }
});

test('the placebo is the size and the shape of the comparison it stands next to', () => {
  // 800 essays over two assignments and two bins; only the long ones say "delve", so the placebo's
  // occurrences say how many long essays it drew, and its length mix can be read off the numbers
  const long = (n: number, group: string, tag: string) =>
    Array.from({ length: n }, (_, i) => ({ id: `${tag}${i}`, text: 'We delve. ' + filler(148, i), source: tag, group }));
  const person: Text[] = [
    ...essays(200, 'phones', 100, 'ph'), ...long(200, 'phones', 'phl'),
    ...essays(200, 'summer', 100, 'su'), ...long(200, 'summer', 'sul'),
  ];
  const model: Text[] = [
    ...essays(30, 'phones', 100, 'mph'), ...long(20, 'phones', 'mphl'),
    ...essays(25, 'summer', 100, 'msu'), ...long(25, 'summer', 'msul'),
  ];
  const arms: Arm[] = [
    { id: 'casual', label: 'casual', kind: 'human', texts: texts(100, (i) => filler(100, i), 'c') },
    { id: 'person', label: 'person', kind: 'human', texts: person },
    { id: 'model', label: 'model', kind: 'machine', texts: model },
  ];
  const opts = { reference: 'person', casual: 'casual', machine: 'model' };
  const row = (r: ReturnType<typeof measure>) => r.rows.find((x) => x.marker === 'delve')!;

  const calibrated = measure(arms, { ...opts, pairing: 'prompt' });
  assert.equal(calibrated.arms.find((a) => a.id === 'model')!.matchedWithReference, 100, 'the person fills every cell the model has');
  const placebo = row(calibrated).placebo;
  assert.equal(placebo.rate.a.texts, 100, 'a placebo of 400 against 400 is not the null of a test of 100');
  assert.equal(placebo.rate.b.texts, 100);
  assert.equal(placebo.a.n, 100);
  assert.equal(placebo.b.n, 100);
  // and cell by cell: the model has 20 long phones essays and 25 long summer ones, so each half has 45
  assert.equal(placebo.rate.a.occurrences, 45, 'the halves must follow the comparison bin by bin, not the file');
  assert.equal(placebo.rate.b.occurrences, 45);

  // asking for the whole reference back gives the old split: four times the texts, and the file's own mix
  const whole = row(measure(arms, { ...opts, pairing: 'prompt', placebo: 'whole-reference' })).placebo;
  assert.equal(whole.rate.a.texts, 400);
  assert.ok(whole.rate.a.occurrences > 150, `half the file is about 200 long essays, got ${whole.rate.a.occurrences}`);
  // and a kind of writing that names no pairing mode keeps that split without asking, as the published two do
  assert.equal(row(measure(arms, opts)).placebo.rate.a.texts, 400);
});

test('an assignment on the texts changes nothing until the kind of writing asks to pair on it', () => {
  const person = Array.from({ length: 200 }, (_, i) => ({ id: `raid:human:d${i}`, text: 'We delve. ' + filler(120, i), source: 'p' }));
  const model = Array.from({ length: 100 }, (_, i) => ({ id: `raid:gpt4:d${i}`, text: filler(122, i), source: 'm' }));
  const arms: Arm[] = [
    { id: 'casual', label: 'casual', kind: 'human', texts: texts(100, (i) => filler(120, i), 'c') },
    { id: 'person', label: 'person', kind: 'human', texts: person },
    { id: 'gpt4', label: 'gpt4', kind: 'machine', texts: model },
  ];
  const opts = { reference: 'person', casual: 'casual', machine: 'gpt4' };
  const bare = measure(arms, opts);
  const tagged = measure(arms.map((a) => ({ ...a, texts: a.texts.map((t, i) => ({ ...t, group: i % 3 ? 'one' : 'two' })) })), opts);
  assert.equal(bare.arms.find((a) => a.id === 'gpt4')!.pairing, 'document', 'the two kinds of writing published so far pair by document');
  assert.equal(
    JSON.stringify({ ...tagged, generated_at: '' }),
    JSON.stringify({ ...bare, generated_at: '' }),
    'a group nobody asked to pair on must not move a single number',
  );
});

test('a text the marker cannot judge is left out of its shares, not counted as a no', () => {
  const uniform = (i: number) => Array.from({ length: 8 }, (_, s) => filler(12, i + s)).join(' ');
  // one sentence of a hundred words: too few sentences for "every sentence the same length" to mean anything
  const oneSentence = (i: number) => filler(100, i);
  const arms: Arm[] = [
    { id: 'casual', label: 'casual', kind: 'human', texts: texts(100, uniform, 'c') },
    { id: 'careful', label: 'careful', kind: 'human', texts: [...texts(100, uniform, 'f'), ...texts(100, oneSentence, 'g')] },
    { id: 'machine', label: 'machine', kind: 'machine', texts: texts(100, uniform, 'm') },
  ];
  const m = byId.get('uniform_sentences')!;
  assert.ok(m.eligible, 'uniform_sentences needs an eligibility rule');
  assert.equal(m.eligible(oneSentence(0)), false);
  const r = measure(arms, { reference: 'careful', casual: 'casual', machine: 'machine' });
  const row = r.rows.find((x) => x.marker === 'uniform_sentences')!;
  assert.equal(row.share.careful!.arm.n, 100, 'the reference is judged on its hundred eligible texts');
  assert.equal(row.share.careful!.arm.k, 100);
  assert.equal(row.share.machine!.reference.n, 100);
  assert.equal(row.share.machine!.reference.pct, 100, 'counting the one-sentence texts as "no" would halve this');
  assert.equal(row.rate.careful!.texts, 100);
  assert.equal(row.placebo.a.n + row.placebo.b.n <= 100, true);
  assert.notEqual(row.verdict, 'machine marker', 'the machine arm is no more uniform than the eligible reference');
  // the pairing itself is published whole: the other markers see all two hundred texts
  assert.equal(r.rows.find((x) => x.marker === 'no_contraction')!.share.careful!.arm.n, 200);
});

test('a countable marker is decided on its rates, even where the shares say otherwise', () => {
  const plain = (i: number) => filler(120, i);
  const once = (i: number) => 'We delve. ' + plain(i);
  // every text on both sides carries the word, so the shares tie at 100%, but the machine uses it ten
  // times as often; the texts are as long as the reference's, so the rate test can compare them
  const tenTimes = (i: number) => 'delve '.repeat(10) + '. ' + filler(112, i);
  const heavy = measure([
    { id: 'casual', label: 'casual', kind: 'human', texts: texts(300, once, 'c') },
    { id: 'careful', label: 'careful', kind: 'human', texts: texts(300, once, 'f') },
    { id: 'machine', label: 'machine', kind: 'machine', texts: texts(300, tenTimes, 'm') },
  ], { reference: 'careful', casual: 'casual', machine: 'machine' }).rows.find((x) => x.marker === 'delve')!;
  assert.equal(heavy.share.machine!.arm.pct, heavy.share.machine!.reference.pct);
  assert.equal(heavy.verdict, 'machine marker');
  assert.ok(heavy.q! < 1e-6);

  // half the machine texts use it twice and half not at all: the shares separate (50% against 100%), the rates do not
  const twiceOrNot = (i: number) => (i % 2 ? 'delve delve. ' : 'look look. ') + plain(i);
  const even = measure([
    { id: 'casual', label: 'casual', kind: 'human', texts: texts(300, once, 'c') },
    { id: 'careful', label: 'careful', kind: 'human', texts: texts(300, once, 'f') },
    { id: 'machine', label: 'machine', kind: 'machine', texts: texts(300, twiceOrNot, 'm') },
  ], { reference: 'careful', casual: 'casual', machine: 'machine' }).rows.find((x) => x.marker === 'delve')!;
  assert.ok(even.share.machine!.arm.hi < even.share.machine!.reference.lo, 'the shares must be apart for this test to mean anything');
  assert.equal(even.verdict, 'no signal');
});

test('a phrase used once per text is not a machine marker because the machine writes shorter texts', () => {
  // one text in five says "in conclusion" on both sides; the machine's texts are 139 words and the
  // reference's 204, both inside one share bin, so per thousand words the machine is half as high again
  const body = (w: number) => (i: number) => (i % 5 === 0 ? 'In conclusion, it works. ' : 'So it works. ') + filler(w, i);
  const machineTexts = texts(1500, body(135), 'm'), referenceTexts = texts(1500, body(200), 'r');
  const m = byId.get('in_conclusion')!;
  assert.ok(twoRateP(rate(machineTexts, m), rate(referenceTexts, m))! < 1e-4, 'the whole-arm rates must differ for this test to mean anything');
  const r = measure([
    { id: 'casual', label: 'casual', kind: 'human', texts: texts(300, (i) => filler(150, i), 'c') },
    { id: 'reference', label: 'reference', kind: 'human', texts: referenceTexts },
    { id: 'machine', label: 'machine', kind: 'machine', texts: machineTexts },
  ], { reference: 'reference', casual: 'casual', machine: 'machine' });
  const row = r.rows.find((x) => x.marker === 'in_conclusion')!;
  assert.equal(row.share.machine!.arm.pct, 20);
  assert.equal(row.share.machine!.reference.pct, 20, 'as many texts say it on both sides');
  assert.ok(row.rate.machine!.per1000 > 1.4 * row.rate.reference!.per1000);
  assert.notEqual(row.verdict, 'machine marker');
  assert.equal(row.p, 1, 'no text of the machine is as long as one of the reference');
});

test('the length-matched rate test: compares like with like, and still finds a real difference', () => {
  const m = delve;
  // the same one use per text, in 100-word and 200-word texts: at each length the arms are equal
  const short = texts(200, (i) => 'We delve. ' + filler(98, i), 's');
  const long = texts(200, (i) => 'We delve. ' + filler(198, i), 'l');
  const mixedA = [...short.slice(0, 150), ...long.slice(0, 50)], mixedB = [...short.slice(150), ...long.slice(50)];
  const even = lengthMatchedRateTest(mixedA, mixedB, m)!;
  assert.ok(even.p > 0.5, `equal use at equal lengths, p ${even.p}`);
  assert.ok(twoRateP(rate(mixedA, m), rate(mixedB, m))! < 0.01, 'the whole-arm test is fooled by the length mix');
  // twice the use at every length is found, and the direction is reported
  const twice = texts(200, (i) => 'We delve, delve. ' + filler(97, i), 't');
  const more = lengthMatchedRateTest(twice, short, m)!;
  assert.ok(more.p < 1e-6 && more.observed > more.expected, JSON.stringify(more));
  const fewer = lengthMatchedRateTest(short, twice, m)!;
  assert.ok(fewer.p < 1e-6 && fewer.observed < fewer.expected);
  // a length only one arm has is left out, however much it uses the word
  const onlyLong = lengthMatchedRateTest([...short, ...texts(50, (i) => 'delve '.repeat(20) + filler(300, i), 'x')], short, m)!;
  assert.ok(onlyLong.p > 0.5, `the 320-word texts have nothing to be compared with, p ${onlyLong.p}`);
  assert.equal(lengthMatchedRateTest([], short, m), null);
});

test('a word is tested against the person\'s texts for the documents the model still has', () => {
  // the person writes "delve" in documents 0-49 only; the model's texts for those were dropped by the
  // cleaning, and on the documents both still have neither uses it
  const person = Array.from({ length: 100 }, (_, i) => ({ id: `raid:human:d${i}`, text: (i < 50 ? 'We delve and delve. ' : 'We look. ') + filler(120, i), source: 'p' }));
  const model = Array.from({ length: 50 }, (_, i) => ({ id: `raid:gpt4:d${i + 50}`, text: 'We look. ' + filler(120, i), source: 'm' }));
  const arms: Arm[] = [
    { id: 'casual', label: 'casual', kind: 'human', texts: texts(100, (i) => filler(120, i), 'c') },
    { id: 'person', label: 'person', kind: 'human', texts: person },
    { id: 'gpt4', label: 'gpt4', kind: 'machine', texts: model },
  ];
  const row = measure(arms, { reference: 'person', casual: 'casual', machine: 'gpt4' }).rows.find((x) => x.marker === 'delve')!;
  assert.equal(row.verdict, 'no signal', 'the documents the model lost are not held against it');
  assert.ok(row.rate.person!.occurrences === 100, 'the person\'s rate shown is still the whole arm');
  assert.deepEqual(row.lengthMatched && row.lengthMatched.observed, 0);
  assert.equal(row.lengthMatched!.expected, 0, 'the person\'s texts in the test hold no "delve"');
  // the same model texts with ids from no shared document are length-matched, and meet every person text
  const loose: Arm = { ...arms[2]!, texts: model.map((t, i) => ({ ...t, id: `other${i}` })) };
  const whole = measure([arms[0]!, arms[1]!, loose], { reference: 'person', casual: 'casual', machine: 'gpt4' }).rows.find((x) => x.marker === 'delve')!;
  assert.equal(whole.verdict, 'points the other way');
});

test('a register verdict needs casual texts the marker can judge', () => {
  const uniform = (i: number) => Array.from({ length: 8 }, (_, s) => filler(12, i + s)).join(' ');
  const r = measure([
    // one long sentence each: nothing here can be judged for "every sentence the same length"
    { id: 'casual', label: 'casual', kind: 'human', texts: texts(60, (i) => filler(100, i), 'c') },
    { id: 'careful', label: 'careful', kind: 'human', texts: texts(60, uniform, 'f') },
    { id: 'machine', label: 'machine', kind: 'machine', texts: texts(60, uniform, 'm') },
  ], { reference: 'careful', casual: 'casual', machine: 'machine' });
  const row = r.rows.find((x) => x.marker === 'uniform_sentences')!;
  assert.equal(row.share.casual!.arm.n, 0);
  assert.equal(row.verdict, 'no signal', 'an empty casual share is no evidence of anything');
});

test('a marker only the machine arm carries is called a machine marker; one both human arms carry is not', () => {
  const plain = (i: number) => filler(120, i);
  const arms: Arm[] = [
    { id: 'casual', label: 'casual', kind: 'human', texts: texts(300, plain, 'c') },
    { id: 'careful', label: 'careful', kind: 'human', texts: texts(300, plain, 'f') },
    { id: 'machine', label: 'machine', kind: 'machine', texts: texts(300, (i) => 'It is important to note that. ' + plain(i), 'm') },
  ];
  const r = measure(arms, { reference: 'careful', casual: 'casual', machine: 'machine' });
  const row = r.rows.find((x) => x.marker === 'important_to_note')!;
  assert.equal(row.verdict, 'machine marker');
  assert.ok(row.q !== null && row.q < 0.01, `q should be tiny, got ${row.q}`);
  assert.equal(r.rows.find((x) => x.marker === 'delve')!.verdict, 'no signal');
});

test('a marker both the careful and the machine arm carry is a register marker, not a machine marker', () => {
  const plain = (i: number) => filler(120, i);
  const formal = (i: number) => 'Moreover. ' + plain(i);
  const arms: Arm[] = [
    { id: 'casual', label: 'casual', kind: 'human', texts: texts(300, plain, 'c') },
    { id: 'careful', label: 'careful', kind: 'human', texts: texts(300, formal, 'f') },
    { id: 'machine', label: 'machine', kind: 'machine', texts: texts(300, formal, 'm') },
  ];
  const r = measure(arms, { reference: 'careful', casual: 'casual', machine: 'machine' });
  assert.equal(r.rows.find((x) => x.marker === 'moreover')!.verdict, 'register marker');
});

test('a marker the humans carry and the machine does not points the other way', () => {
  const arms: Arm[] = [
    { id: 'casual', label: 'casual', kind: 'human', texts: texts(300, (i) => 'A dash — here. ' + filler(120, i), 'c') },
    { id: 'careful', label: 'careful', kind: 'human', texts: texts(300, (i) => 'A dash — here. ' + filler(120, i), 'f') },
    { id: 'machine', label: 'machine', kind: 'machine', texts: texts(300, (i) => filler(120, i), 'm') },
  ];
  const r = measure(arms, { reference: 'careful', casual: 'casual', machine: 'machine' });
  assert.equal(r.rows.find((x) => x.marker === 'em_dash')!.verdict, 'points the other way');
});

test('a marker named not recorded gets no test, no verdict and no place in the correction', () => {
  const plain = (i: number) => filler(120, i);
  const arms: Arm[] = [
    { id: 'casual', label: 'casual', kind: 'human', texts: texts(300, plain, 'c') },
    { id: 'careful', label: 'careful', kind: 'human', texts: texts(300, (i) => 'Moreover it is. ' + plain(i), 'f') },
    { id: 'machine', label: 'machine', kind: 'machine', texts: texts(300, (i) => 'We delve. It is important to note that. ' + plain(i), 'm') },
  ];
  const opts = { reference: 'careful', casual: 'casual', machine: 'machine' };
  const all = measure(arms, opts);
  const some = measure(arms, { ...opts, notRecorded: ['delve', 'bulleted_bold'] });
  for (const id of ['delve', 'bulleted_bold']) {
    const row = some.rows.find((x) => x.marker === id)!;
    assert.equal(row.verdict, 'not recorded', id);
    assert.equal(row.p, null, id);
    assert.equal(row.q, null, id);
    assert.equal(row.placebo.tie, true, id);
    assert.equal(row.placebo.p, null, id);
  }
  // the shares and rates are still there to read
  assert.equal(some.rows.find((x) => x.marker === 'delve')!.rate.machine!.occurrences, 300);
  // the correction runs over the tested markers only: the same p values, without the two
  const expected = benjaminiHochberg(all.rows.map((r) => (['delve', 'bulleted_bold'].includes(r.marker) ? null : r.p)));
  assert.deepEqual(some.rows.map((r) => r.q), expected);
  assert.notDeepEqual(all.rows.map((r) => r.q), expected, 'the family did change');
  assert.equal(all.rows.find((x) => x.marker === 'delve')!.verdict, 'machine marker');
  assert.equal(some.rows.find((x) => x.marker === 'moreover')!.verdict, all.rows.find((x) => x.marker === 'moreover')!.verdict);
});

test('sentence length variation: the same length every time scores low, varied prose does not', () => {
  const uniform = Array.from({ length: 8 }, () => filler(10)).join(' ');
  const varied = 'Short. ' + filler(30) + ' Tiny. ' + filler(45) + ' No. ' + filler(20) + ' Yes.';
  assert.ok(sentenceLengthCv(uniform)! < 0.2, `uniform cv ${sentenceLengthCv(uniform)}`);
  assert.ok(sentenceLengthCv(varied)! > 0.5, `varied cv ${sentenceLengthCv(varied)}`);
  assert.equal(sentenceLengthCv('Too short.'), null);
});

test('the belief markers are the ones people judge by, and they are labelled as such', () => {
  const beliefs = MARKERS.filter((m) => m.belief).map((m) => m.id);
  assert.deepEqual(beliefs.sort(), ['no_contraction', 'no_first_person', 'no_personal_detail', 'no_typo_markers'].sort());
  for (const id of beliefs) assert.ok(byId.has(id));
  for (const m of MARKERS.filter((x) => x.belief)) assert.match(m.source, /Jakesch|readers/, `${m.id} must name where the belief comes from`);
});

test('every marker has a unique id, a label, and a source', () => {
  const ids = MARKERS.map((m) => m.id);
  assert.equal(new Set(ids).size, ids.length, 'duplicate marker id');
  for (const m of MARKERS) {
    assert.match(m.id, /^[a-z][a-z0-9_]*$/, `bad id ${m.id}`);
    assert.ok(m.label.length > 0 && m.source.length > 0, `${m.id} needs a label and a source`);
    assert.doesNotThrow(() => m.test('a short text — with an em dash, "quotes" and 1234.'), `${m.id} threw`);
  }
});

test('a word used once per text: its share does not change with length, its rate does', () => {
  const short = texts(50, () => 'We delve into it. ' + filler(40), 's');
  const long = texts(50, () => 'We delve into it. ' + filler(400), 'l');
  // presence is identical, but the rate falls with length, which is why the rate test compares like lengths
  assert.equal(share(short, delve).pct, 100);
  assert.equal(share(long, delve).pct, 100);
  assert.ok(rate(short, delve).per1000 > rate(long, delve).per1000 * 5, 'the rate must fall as the text grows');
  assert.equal(rate(short, delve).occurrences, 50);
});

test('countable markers count every occurrence, not just the first', () => {
  const m = MARKERS.find((x) => x.id === 'em_dash')!;
  assert.equal(m.count!('a — b — c —'), 3);
  assert.equal(m.count!('none here'), 0);
  assert.equal(delve.count!('delve, delving, delved'), 3);
  assert.equal(MARKERS.find((x) => x.id === 'uniform_sentences')!.count, undefined, 'a whole-text property cannot be counted');
});
