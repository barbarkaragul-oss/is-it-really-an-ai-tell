import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { sentenceAround, hits, top, forms, examples, linkFor } from '../src/evidence.js';
import { byId, MARKERS, words as countWords } from '../src/markers.js';
import { ARMS, loadArms, type ArmSpec } from '../scripts/arms.js';
import { documentsFor, assignmentDocumentsFor, assignmentsFor, personCountsFor, makeWholeTextGuard, drawMatched, evidenceFor } from '../scripts/evidence.js';
import { genreById, type Genre } from '../scripts/genres.js';
import type { Arm, Text } from '../src/measure.js';

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
  // RAID's model texts (MIT), arXiv abstracts (CC0), the Claude arms and the Llama 3 arm written here;
  // never a person's Reddit post and never a student's essay
  assert.deepEqual(quoted.sort(), [
    'essays-claude-plain', 'essays-claude-student', 'essays-llama3-student',
    'posts-chatgpt', 'posts-gpt4', 'posts-llama-chat', 'posts-mistral-chat',
    'raid-chatgpt', 'raid-claude', 'raid-gpt4', 'raid-human', 'raid-llama-chat', 'raid-mistral-chat',
  ]);
  assert.ok(!quoted.includes('posts-human') && !quoted.includes('essays-human'));
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

// ---- the panel for a kind of writing whose writers share an assignment and no document
//
// Nothing here is a real essay. The rule the panel exists to keep -- a student's essay is never
// published -- is tested on texts written for the test, so that the test itself can print what it
// checked; the last test in this file runs the same check over the real corpora when they are there.

const assignmentGenre = (dir: string): Genre => ({
  ...genreById.get('essays')!,
  assignments: path.join(dir, 'assignments.json'),
});

/** the assignments file the genre names, as the collector writes one */
function writeAssignments(dir: string): void {
  writeFileSync(path.join(dir, 'assignments.json'), JSON.stringify({
    prompts: [
      { slug: 'phones', name: 'Phones', assignment: 'Write a letter to your principal about phones.', letter: true },
      { slug: 'service', name: 'Service', assignment: 'Should students do community service? Explain your answer.', letter: false },
    ],
  }));
}

/** a sentence every writer uses, so that sharing it is nobody's own words */
const COMMON = 'Students at this school care about the rules and about each other every single day. ';
/** a run of words exactly one person wrote; a machine text holding it may never be shown */
const ONLY_ONE = 'Aardvark banjo crimson dulcimer eggplant fennel gossamer harpsichord. ';

const filler = (n: number): string => COMMON.repeat(n);

function armsFixture(): { arm: Arm; spec: ArmSpec }[] {
  const spec = (id: string, kind: 'human' | 'machine', publishable: boolean): ArmSpec =>
    ({ id, label: id, kind, file: `${id}-clean`, publishable });
  const person: Text[] = [];
  for (const group of ['phones', 'service'] as const) {
    for (let i = 1; i <= 6; i++) {
      // "delve" three times in the phones essays and never in the service ones, so a count that came
      // from the wrong assignment cannot pass
      const delve = group === 'phones' && i <= 3 ? 'We delve into it. ' : '';
      person.push({ id: `essays:${group}:${i}`, text: `${delve}${filler(20)}${i === 1 && group === 'phones' ? ONLY_ONE : ''}`, source: 'p', group });
    }
  }
  const machine = (id: string): Text[] => ['phones', 'service'].flatMap((group) =>
    [1, 2, 3, 4].map((i): Text => ({
      id: `${id}.${group}.g8.00${i}`,
      // the first Claude essay about phones repeats the run only one person wrote, and must be passed over
      text: `${filler(20)}${id === 'essays-claude-student' && group === 'phones' && i === 1 ? ONLY_ONE : ''}`,
      source: 'm', group,
    })));
  return [
    { arm: { id: 'essays-human', label: 'people', kind: 'human', texts: person }, spec: spec('essays-human', 'human', false) },
    { arm: { id: 'essays-claude-student', label: 'Claude', kind: 'machine', texts: machine('essays-claude-student') }, spec: spec('essays-claude-student', 'machine', true) },
    { arm: { id: 'essays-llama3-student', label: 'Llama 3', kind: 'machine', texts: machine('essays-llama3-student') }, spec: spec('essays-llama3-student', 'machine', true) },
    { arm: { id: 'essays-claude-plain', label: 'Claude plain', kind: 'machine', texts: machine('essays-claude-plain') }, spec: spec('essays-claude-plain', 'machine', true) },
  ];
}

test('a kind of writing with no shared document opens on the assignment, not on a document', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'assignments-'));
  writeAssignments(dir);
  const docs = documentsFor(assignmentGenre(dir), armsFixture(), new Map());
  assert.deepEqual(docs.map((d) => d.source_id), ['phones', 'service'], 'one entry per assignment, in the file\'s order');
  assert.deepEqual(docs.map((d) => d.assignment?.text), [
    'Write a letter to your principal about phones.',
    'Should students do community service? Explain your answer.',
  ], 'the teacher\'s words, verbatim');
  // no titles are invented where the corpus has none, and the person's column is named as missing
  assert.deepEqual(docs.map((d) => d.title), ['', '']);
  assert.deepEqual(docs.map((d) => d.person_not_reproduced), [true, true]);
  assert.deepEqual(docs.map((d) => d.assignment?.letter), [true, false]);
});

test('every assignment in the panel carries at least two machine essays', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'assignments-two-'));
  writeAssignments(dir);
  for (const d of documentsFor(assignmentGenre(dir), armsFixture(), new Map())) {
    const written = Object.entries(d.texts).filter(([, t]) => t.trim().length);
    assert.ok(written.length >= 2, `${d.source_id} has ${written.length} machine essays, which is not a comparison`);
    // every essay shown is named, so a reader can find it under data/generated
    assert.deepEqual(Object.keys(d.assignment!.essays).sort(), written.map(([a]) => a).sort());
    for (const [arm, t] of written) assert.equal(d.assignment!.essays[arm]!.id.startsWith(`${arm}.${d.source_id}.`), true, `${arm}: the essay named is not one of its own`);
  }
});

test('a machine essay that repeats a run only one person wrote is passed over, and the next drawn', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'assignments-guard-'));
  writeAssignments(dir);
  const docs = documentsFor(assignmentGenre(dir), armsFixture(), new Map());
  const phones = docs.find((d) => d.source_id === 'phones')!;
  assert.equal(phones.texts['essays-claude-student']!.includes('Aardvark banjo'), false);
  assert.notEqual(phones.assignment!.essays['essays-claude-student']!.id, 'essays-claude-student.phones.g8.001');
  // and the rule is about one person's words, not about any two texts agreeing: the sentence every
  // writer used is not anybody's, so it does not keep an essay off the page
  const guard = makeWholeTextGuard(armsFixture()[0]!.arm, [COMMON.repeat(3), ONLY_ONE.repeat(2)], []);
  assert.equal(guard(filler(3)), false, 'a run many people wrote is not one person\'s');
  assert.equal(guard(ONLY_ONE), true, 'a run one person wrote is theirs');
});

test('the assignment\'s own words do not count as a person\'s, however many people repeat them', () => {
  const assignment = 'Policy 1: Allow students to bring phones to school and use them during lunch.';
  // one student restated the assignment, which many of them do, and the model did the same
  const person: Arm = { id: 'p', label: 'p', kind: 'human', texts: [{ id: '1', text: `${assignment} I agree with that.`, source: 'p' }] };
  const machine = `In my view, ${assignment} That is the better one.`;
  assert.equal(makeWholeTextGuard(person, [machine], [])(machine), true, 'without the assignment it reads as the one person\'s');
  assert.equal(makeWholeTextGuard(person, [machine], [assignment])(machine), false, 'the teacher wrote it, and this project publishes it');
});

test('the counts beside an assignment are that assignment\'s students, not the whole corpus', () => {
  const person = armsFixture()[0]!.arm;
  const phones = personCountsFor(person, 'phones');
  const service = personCountsFor(person, 'service');
  assert.equal(phones.texts, 6, 'six people wrote to this assignment, not twelve');
  assert.equal(service.texts, 6);
  const delve = (p: typeof phones): number => p.markers.find((m) => m.marker === 'delve')!.occurrences!;
  assert.equal(delve(phones), 3, 'the three "delve"s are in the phones essays');
  assert.equal(delve(service), 0, 'and the service essays have none');
  // the middle essay's length, over these essays alone
  const lengths = person.texts.filter((t) => t.group === 'phones').map((t) => countWords(t.text).length).sort((a, b) => a - b);
  assert.equal(phones.median_words, lengths[Math.floor(lengths.length / 2)]);
  assert.equal(phones.words, lengths.reduce((s, n) => s + n, 0));
  // a marker with no count has no rate: 0 there would read as "never", not as "never asked"
  const noCount = phones.markers.find((m) => m.per1000 === null)!;
  assert.equal(noCount.occurrences, null);
  assert.equal(MARKERS.find((m) => m.id === noCount.marker)!.count, undefined);
});

test('the machine essays of an entry are held as level as the arms allow, and the panel says which', () => {
  const t = (id: string, words: number): Text => ({ id, text: 'word '.repeat(words), source: 'm' });
  // both writers have a grade-8 essay in the same band
  const level = drawMatched([
    { id: 'a', texts: [t('a.x.g8.001', 500), t('a.x.g11.002', 500)] },
    { id: 'b', texts: [t('b.x.g11.001', 500), t('b.x.g8.002', 450)] },
  ])!;
  assert.equal(level.matched, 'grade and length');
  assert.deepEqual(level.picked.map(([, x]) => x.id), ['a.x.g8.001', 'b.x.g8.002']);
  // the same grade, but no band both can fill
  const byGrade = drawMatched([
    { id: 'a', texts: [t('a.x.g8.001', 500)] },
    { id: 'b', texts: [t('b.x.g8.001', 150)] },
  ])!;
  assert.equal(byGrade.matched, 'grade');
  // not even a grade in common: the assignment is still shared, and the page is told that is all
  const byPrompt = drawMatched([
    { id: 'a', texts: [t('a.x.g8.001', 500)] },
    { id: 'b', texts: [t('b.x.g11.001', 150)] },
  ])!;
  assert.equal(byPrompt.matched, 'assignment only');
});

test('no person\'s sentence reaches the evidence of a kind of writing built round an assignment', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'assignments-quiet-'));
  writeAssignments(dir);
  const loaded = armsFixture();
  const body = JSON.stringify(evidenceFor(assignmentGenre(dir), loaded, '2026-01-01T00:00:00.000Z', new Map()));
  for (const t of loaded[0]!.arm.texts) {
    for (const s of t.text.split(/(?<=[.!?])\s+/).filter((x) => x.trim().length > 30)) {
      if (COMMON.trim() === s.trim()) continue; // every writer wrote it, so it is nobody's
      assert.equal(body.includes(s.trim()), false, `${t.id}: a person's sentence reached the evidence`);
    }
  }
});

/**
 * The same rule over the corpora themselves, where they have been collected. It is the check the
 * licence rests on, so it is made against every essay rather than a sample: the longest sentence of
 * each one, which is the least likely of its sentences to be a coincidence, must appear nowhere in
 * what the panel would publish. Nothing of an essay is printed, only its id if one ever fails.
 *
 * A sentence the assignment itself holds is not the student's and is not counted as one: on these
 * corpora the longest sentence of three essays is the assignment restated, written that way by eight
 * to forty-three students each, and the assignment is published here in full on purpose.
 */
const collectedEssays = ['essays-human', 'essays-claude-student', 'essays-llama3-student', 'essays-claude-plain']
  .every((a) => existsSync(path.resolve('out', `${a}-clean.json`)));

test('no student\'s essay reaches the panel built from the corpora in out/', { skip: collectedEssays ? false : 'the essays are not collected in out/' }, () => {
  const genre = genreById.get('essays')!;
  const docs = assignmentDocumentsFor(genre, loadArms(genre));
  assert.ok(docs.length, 'the panel is empty');
  const body = JSON.stringify(docs);
  const assignment = new Map(assignmentsFor(genre).map((a) => [a.slug, a.assignment]));
  const students = JSON.parse(readFileSync(path.resolve('out', 'essays-human.json'), 'utf8')) as { id: string; text: string; group: string }[];
  let checked = 0;
  for (const s of students) {
    const longest = s.text.split(/(?<=[.!?])\s+/).map((x) => x.trim()).sort((a, b) => b.length - a.length)[0] ?? '';
    if (longest.length < 40 || (assignment.get(s.group) ?? '').includes(longest)) continue;
    checked++;
    assert.equal(body.includes(longest), false, `${s.id}: a student's sentence reached the panel`);
  }
  assert.ok(checked > students.length * 0.9, `only ${checked} of ${students.length} essays were checked`);
});
