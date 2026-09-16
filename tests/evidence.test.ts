import test from 'node:test';
import assert from 'node:assert/strict';
import { sentenceAround, hits, top, forms, examples, linkFor } from '../src/evidence.js';
import { byId, MARKERS } from '../src/markers.js';
import { ARMS } from '../scripts/arms.js';

const doc = (id: string, text: string) => ({ id, text, source: 't' });

test('"leverage" counts the verb and leaves the noun and the financial adjective alone', () => {
  const m = byId.get('leverage')!;
  for (const verb of ['We leverage unlabeled data.', 'The proposed method leverages attention.', 'by leveraging priors', 'can be leveraged to improve', 'to leverage the structure', 'the potential of leveraging unlabeled data']) {
    assert.equal(m.count!(verb), 1, `should count: ${verb}`);
  }
  for (const noun of ['There is not as much leverage there.', 'trading with 100x leverage', 'no real leverage to prevent it', 'a lot of leverage', 'leveraged trades without a stop', 'the leverage ratio']) {
    assert.equal(m.count!(noun), 0, `should not count: ${noun}`);
  }
});

test('every counting marker exposes its pattern, and the pattern counts what count counts', () => {
  const sample = 'We delve into it — moreover, crucially, we leverage red, green and blue. In conclusion, it is important to note this.';
  for (const m of MARKERS.filter((x) => x.count)) {
    assert.ok(m.pattern, `${m.id} counts but has no pattern`);
    assert.equal(hits([doc('a', sample)], m).length, m.count!(sample), `${m.id}: hits and count disagree`);
  }
});

test('the sentence around a match is the sentence, not the paragraph', () => {
  const t = 'First sentence here. We delve into the data now! Last one.';
  const i = t.indexOf('delve');
  assert.equal(sentenceAround(t, i, i + 5), 'We delve into the data now!');
});

test('a long sentence is cut around the match and says so', () => {
  const t = 'a '.repeat(300) + 'delve ' + 'b '.repeat(300) + '.';
  const i = t.indexOf('delve');
  const s = sentenceAround(t, i, i + 5, 80);
  assert.ok(s.includes('delve'), 'the match must stay in view');
  assert.ok(s.startsWith('…') && s.endsWith('…'), `cut on both sides: ${s}`);
  assert.ok(s.length <= 84, `too long: ${s.length}`);
});

test('the word before a match is recorded, across punctuation', () => {
  const h = hits([doc('a', 'The proposed method leverages it. Moreover, (we) leverage that.')], byId.get('leverage')!);
  assert.deepEqual(h.map((x) => x.before), ['method', 'we']);
  assert.deepEqual(h.map((x) => x.form), ['leverages', 'leverage']);
});

test('top: most frequent first, ties alphabetical, empty values ignored', () => {
  assert.deepEqual(top(['b', 'a', 'b', '', 'c', 'a'], 2), [['a', 2], ['b', 2]]);
});

test('examples are reproducible, at most one per document, and not simply the first ones', () => {
  const all = Array.from({ length: 60 }, (_, i) => ({ id: `d${Math.floor(i / 2)}`, form: 'x', before: '', sentence: `s${i}` }));
  const a = examples(all, 5, 1), b = examples(all, 5, 1);
  assert.deepEqual(a, b);
  assert.equal(new Set(a.map((x) => x.id)).size, 5);
  assert.notDeepEqual(a.map((x) => x.sentence), ['s0', 's2', 's4', 's6', 's8']);
});

test('links are decided by the arm: a bare number from Stack Exchange is not a Hacker News item', () => {
  assert.equal(linkFor('casual-human', '33795107'), 'https://news.ycombinator.com/item?id=33795107');
  assert.equal(linkFor('careful-human', '599156'), null);
  assert.equal(linkFor('careful-human', 'academia:1234'), 'https://academia.stackexchange.com/a/1234');
  assert.equal(linkFor('hc3-gpt35', 'hc3:0:0'), null);
});

test('only arms whose licence allows it are quoted', () => {
  const quoted = ARMS.filter((a) => a.publishable).map((a) => a.id);
  assert.ok(!quoted.includes('casual-human') && !quoted.includes('careful-human') && !quoted.includes('hc3-gpt35'));
  assert.ok(quoted.every((id) => id.startsWith('raid-')), `unexpected quoted arm in ${quoted.join(', ')}`);
});

test('an arm that cannot be quoted gives up its open-ended matches, not just its sentences', () => {
  const text = 'It would not only be rude to the student in question but also pointless. It is worth noting that. We sell apples, pears and plums.';
  const of = (id: string) => hits([doc('a', text)], byId.get(id)!);
  assert.deepEqual(forms(of('not_only_but_also'), false, true), []);
  assert.deepEqual(forms(of('rule_of_three'), false, true), []);
  assert.deepEqual(forms(of('important_to_note'), false, false), [['it is worth noting', 1]], 'a fixed phrase is not anybody\'s text');
  assert.equal(forms(of('not_only_but_also'), true, true).length, 1, 'a quotable arm keeps it');
});

test('the open-ended patterns are marked as such', () => {
  const open = MARKERS.filter((m) => m.openEnded).map((m) => m.id).sort();
  assert.deepEqual(open, ['not_only_but_also', 'not_x_its_y', 'rule_of_three']);
});
