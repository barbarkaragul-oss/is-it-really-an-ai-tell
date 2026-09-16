import test from 'node:test';
import assert from 'node:assert/strict';
import { wilson, twoProportionP, benjaminiHochberg, pairMatch, seededShuffle, measure, rate, share, type Arm, type Text } from '../src/measure.js';
import { MARKERS, sentenceLengthCv, byId } from '../src/markers.js';

const texts = (n: number, body: (i: number) => string, tag = 't') =>
  Array.from({ length: n }, (_, i) => ({ id: `${tag}${i}`, text: body(i), source: tag }));

/** a filler sentence of about `w` words, so a text can be put in a chosen length bin */
const filler = (w: number, seed = 0) => Array.from({ length: w }, (_, i) => `word${(i + seed) % 7}`).join(' ') + '.';

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

test('seeded shuffle: reproducible, a permutation, and not the identity', () => {
  const xs = Array.from({ length: 50 }, (_, i) => i);
  const a = seededShuffle(xs, 7), b = seededShuffle(xs, 7), c = seededShuffle(xs, 8);
  assert.deepEqual(a, b, 'the same seed must give the same order');
  assert.notDeepEqual(a, c, 'a different seed must give a different order');
  assert.deepEqual([...a].sort((p, q) => p - q), xs, 'must be a permutation');
  assert.notDeepEqual(a, xs);
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

test('a rate per thousand words does not care how long the text is', () => {
  const short = texts(50, () => 'We delve into it. ' + filler(40), 's');
  const long = texts(50, () => 'We delve into it. ' + filler(400), 'l');
  const m = MARKERS.find((x) => x.id === 'delve')!;
  // presence is identical, but the rate falls with length, which is the point of having both
  assert.equal(share(short, m).pct, 100);
  assert.equal(share(long, m).pct, 100);
  assert.ok(rate(short, m).per1000 > rate(long, m).per1000 * 5, 'the rate must fall as the text grows');
  assert.equal(rate(short, m).occurrences, 50);
});

test('countable markers count every occurrence, not just the first', () => {
  const m = MARKERS.find((x) => x.id === 'em_dash')!;
  assert.equal(m.count!('a — b — c —'), 3);
  assert.equal(m.count!('none here'), 0);
  const words = MARKERS.find((x) => x.id === 'delve')!;
  assert.equal(words.count!('delve, delving, delved'), 3);
  assert.equal(MARKERS.find((x) => x.id === 'uniform_sentences')!.count, undefined, 'a whole-text property cannot be counted');
});
