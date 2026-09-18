/**
 * The per-genre pipeline end to end on synthetic corpora: measure-all's count across each kind's own
 * writers, the evidence script's quoting rules, the build's files and budgets, and the page's wording.
 * No corpus text is used; every text here is made up of numbered filler words.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { Arm, Text } from '../src/measure.js';
import { MARKERS } from '../src/markers.js';
import { genreById, MODELS, type Genre } from '../scripts/genres.js';
import { armsFor } from '../scripts/arms.js';
import { measureGenre, summaryCell, summarize, separates, evidenceOf, K_RULE, MIN_EVIDENCE, type SummaryCell } from '../scripts/measure-all.js';
import { evidenceFor, documentsFor, exampleFor, makeGuard, makeTextGuard, titlesFor, SENSITIVE } from '../scripts/evidence.js';
import { findGenres, summaryFor, pageFor, pageCell, overBudget, datingOf, releaseProblems, BUDGET, type CleaningFile } from '../scripts/build.js';
import { sharedDocuments } from '../scripts/claude-matched.js';
import { fiveGrams, containment } from '../scripts/contamination.js';
import { verdictWords, gridCellHtml, kHtml, writerNames, countedWords, legendHtml, writtenHereNote, gridCaption, notCoveredText, sharesOneSet, genreFromHash, cleaningNote, datingWords, datesLinked, peopleWords, whyOf, esc, type SummaryGenre } from '../src/ui/main.js';

const filler = (word: string, n: number, seed: number): string => Array.from({ length: n }, (_, j) => `${word}${(j + seed) % 7}`).join(' ');
const DOCS = 60;

/**
 * A genre's arms: the person uses "moreover" in every text, GPT-3.5 and GPT-4 "delve", Llama writes
 * "moreover" like the person, Mistral neither. So "delve" separates 2 models toward the model (the
 * other 2 and the person never use it, which leaves them too little to compare),
 * and "moreover" 3 of 4 toward the person. GPT-4's text for d0 repeats five of the person's words.
 */
function corpus(g: Genre, docs = DOCS): Arm[] {
  const id = (w: string, i: number): string => (w === 'claude' ? `d${i}` : `raid:${w}:d${i}`);
  const texts = (w: string, make: (i: number) => string, n = docs): Text[] => Array.from({ length: n }, (_, i) => ({ id: id(w, i), text: make(i), source: w }));
  const arms: Arm[] = g.writers.map((wr): Arm => {
    const w = wr.writer;
    const make = w === 'human'
      ? (i: number) => `${filler('word', 150, i)}. Moreover it holds.`
      : w === 'chatgpt' || w === 'gpt4'
        ? (i: number) => `${filler('tok', 150, i)}. ${w === 'gpt4' && i === 0 ? 'word0 word1 word2 word3 word4 and we delve.' : 'We delve into it.'}`
        : w === 'llama-chat'
          ? (i: number) => `${filler('tok', 150, i)}. Moreover it holds too.`
          : (i: number) => `${filler('tok', 150, i)}. It holds.`;
    return { id: wr.id, label: wr.label, kind: w === 'human' ? 'human' : 'machine', texts: texts(w, make, w === 'claude' ? 8 : docs) };
  });
  arms.push({ id: 'casual-human', label: 'casual', kind: 'human', texts: Array.from({ length: 80 }, (_, i) => ({ id: String(1000 + i), text: `${filler('cas', 150, i)}.`, source: 'c' })) });
  return arms;
}

const posts = genreById.get('posts')!;
const abstracts = genreById.get('abstracts')!;
const essays = genreById.get('essays')!;
const measuredPosts = measureGenre(posts, corpus(posts))!;

/**
 * A kind of writing with two counted writers instead of four, whose writers answer an assignment
 * rather than rewrite a document, so it is paired by assignment and its placebo is calibrated. The
 * person writes "moreover" everywhere, the decider "delve", the second counted writer "moreover" like
 * the person, and the descriptive arm neither: "delve" then separates the decider alone (the other
 * writer has nothing to compare) and "moreover" separates the decider toward the person, of the two
 * writers this kind has, never of four.
 */
function assignmentCorpus(g: Genre, docs = DOCS): Arm[] {
  const arms: Arm[] = g.writers.map((wr): Arm => {
    const make = wr.writer === 'human'
      ? (i: number) => `${filler('word', 150, i)}. Moreover it holds.`
      : wr.id === g.decider
        ? (i: number) => `${filler('tok', 150, i)}. We delve into it.`
        : wr.tested
          ? (i: number) => `${filler('tok', 150, i)}. Moreover it holds too.`
          : (i: number) => `${filler('tok', 150, i)}. It holds.`;
    // every text names the assignment it was written to, which is what this kind pairs on
    return {
      id: wr.id, label: wr.label, kind: wr.writer === 'human' ? 'human' : 'machine',
      texts: Array.from({ length: docs }, (_, i) => ({ id: `${wr.id}:e${i}`, text: make(i), source: wr.id, group: `a${i % 3}` })),
    };
  });
  // the comparison column is another kind of writing and names no assignment: length-matched, as ever
  arms.push({ id: 'casual-human', label: 'casual', kind: 'human', texts: Array.from({ length: 80 }, (_, i) => ({ id: String(2000 + i), text: `${filler('cas', 150, i)}.`, source: 'c' })) });
  return arms;
}
const measuredEssays = measureGenre(essays, assignmentCorpus(essays))!;

test('the count runs over each kind\'s own writers, in each direction', () => {
  const delve = summaryCell(posts, measuredPosts.report, measuredPosts.perWriter, 'delve');
  assert.equal(delve.verdict, 'machine marker');
  assert.deepEqual(delve.k, { ai: 2, person: 0, of: 2, tooFew: 2 }, 'nobody else uses it: Llama and Mistral have nothing to compare');
  assert.deepEqual(Object.keys(delve.writers).sort(), MODELS.map((m) => `posts-${m}`).sort(), 'keyed by arm, one per tested writer');
  assert.equal(delve.unit, 'per 1000 words');
  assert.equal(delve.person, 0);
  assert.ok(delve.decider! > 5, `GPT-4's rate: ${delve.decider}`);
  const moreover = summaryCell(posts, measuredPosts.report, measuredPosts.perWriter, 'moreover');
  assert.equal(moreover.verdict, 'points the other way');
  assert.deepEqual(moreover.k, { ai: 0, person: 3, of: 4, tooFew: 0 });
  // Llama and the person both use it, more than casual writers: register, which the count leaves out
  assert.equal(moreover.writers['posts-llama-chat']!.verdict, 'register marker');
});

test('a kind with two counted writers counts of 2, and its descriptive arm is not one of them', () => {
  const counted = essays.writers.filter((w) => w.tested).map((w) => w.id);
  assert.deepEqual(counted, ['essays-claude-student', 'essays-llama3-student'], 'two, and the plain arm is not among them');
  const moreover = summaryCell(essays, measuredEssays.report, measuredEssays.perWriter, 'moreover');
  assert.deepEqual(moreover.k, { ai: 0, person: 1, of: 2, tooFew: 0 }, 'of 2, never of 4');
  assert.deepEqual(Object.keys(moreover.writers), counted);
  assert.equal(moreover.writers['essays-llama3-student']!.verdict, 'register marker');
  // the arm that is there to describe is measured for the table and stays out of the count
  assert.ok(measuredEssays.report.arms.some((a) => a.id === 'essays-claude-plain'));
  assert.equal(measuredEssays.perWriter['essays-claude-plain'], undefined);
  // the decider is not a RAID model here, and its own verdict is still the published one
  const delve = summaryCell(essays, measuredEssays.report, measuredEssays.perWriter, 'delve');
  assert.equal(delve.verdict, 'machine marker');
  assert.equal(delve.writers[essays.decider]!.verdict, delve.verdict);
  assert.deepEqual(delve.k, { ai: 1, person: 0, of: 1, tooFew: 1 }, 'the other writer never uses it');
  assert.ok(MODELS.every((m) => !Object.keys(delve.writers).includes(`essays-${m}`)));
  // the pairing this kind asked for reached the report, and every counted writer got one
  assert.equal(measuredEssays.report.arms.find((a) => a.id === essays.decider)!.pairing, 'prompt');
  assert.deepEqual(Object.keys(measuredEssays.perWriter).sort(), [...counted].sort());
});

test('a writer with too little to compare is not counted in "of", and says why', () => {
  // no writer uses "tapestry": nothing to compare, for every model
  const tapestry = summaryCell(posts, measuredPosts.report, measuredPosts.perWriter, 'tapestry');
  assert.equal(tapestry.verdict, 'no signal');
  assert.deepEqual(tapestry.k, { ai: 0, person: 0, of: 0, tooFew: 4 });
  assert.deepEqual(tapestry.writers['posts-gpt4'], { verdict: 'no signal', q: tapestry.writers['posts-gpt4']!.q, evidence: { occurrences: 0 }, tooFew: true });
  // GPT-4 separates "delve" on many uses
  const delve = summaryCell(posts, measuredPosts.report, measuredPosts.perWriter, 'delve');
  assert.deepEqual(delve.writers['posts-gpt4']!.evidence, { occurrences: DOCS });
  assert.equal(delve.writers['posts-gpt4']!.tooFew, false);
  // a property every text on both sides has cannot tell anyone apart, however many pairs
  const personal = summaryCell(posts, measuredPosts.report, measuredPosts.perWriter, 'no_personal_detail');
  assert.equal(personal.writers['posts-gpt4']!.tooFew, true);
  assert.deepEqual(personal.writers['posts-gpt4']!.evidence, { pairs: personal.n, minority: 0 });
  // evidenceOf on its own: a separated marker is never too few, whatever it rests on
  const row = { ...measuredPosts.report.rows.find((r) => r.marker === 'tapestry')!, verdict: 'machine marker' as const };
  assert.equal(evidenceOf(row, 'posts-human', 'posts-gpt4').tooFew, false);
  const few = { ...row, verdict: 'no signal' as const, rate: { 'posts-human': { ...row.rate['posts-human']!, occurrences: 2 }, 'posts-gpt4': { ...row.rate['posts-gpt4']!, occurrences: MIN_EVIDENCE - 2 } } };
  assert.equal(evidenceOf(few, 'posts-human', 'posts-gpt4').tooFew, false, 'five uses between them are enough');
  assert.equal(evidenceOf({ ...few, rate: { ...few.rate, 'posts-gpt4': { ...few.rate['posts-gpt4']!, occurrences: 2 } } }, 'posts-human', 'posts-gpt4').tooFew, true);
});

test('the decider\'s place in the count is its verdict, for every marker and kind', () => {
  for (const [g, m] of [[posts, measuredPosts], [essays, measuredEssays]] as const) {
    const counted = g.writers.filter((w) => w.tested).length;
    for (const mk of MARKERS) {
      const c = summaryCell(g, m.report, m.perWriter, mk.id);
      assert.equal(c.writers[g.decider]!.verdict, c.verdict, `${g.id} ${mk.id}`);
      assert.ok(c.k.ai + c.k.person <= c.k.of && c.k.of + c.k.tooFew <= counted, `${g.id} ${mk.id}`);
    }
    assert.equal(m.perWriter[g.decider], m.report, 'the decider is not measured twice');
  }
  assert.equal(separates('register marker'), null);
});

test('a writer that is missing is left out of the count, not counted as no signal', () => {
  const arms = corpus(posts).filter((a) => a.id !== 'posts-mistral-chat');
  const m = measureGenre(posts, arms)!;
  const c = summaryCell(posts, m.report, m.perWriter, 'moreover');
  assert.deepEqual(c.k, { ai: 0, person: 2, of: 3, tooFew: 0 });
  assert.equal(measureGenre(posts, arms.filter((a) => a.id !== 'posts-gpt4')), null, 'no decider, no genre');
  // and the same where the kind has two: one writer left, so the count can only reach 1
  const one = measureGenre(essays, assignmentCorpus(essays).filter((a) => a.id !== 'essays-llama3-student'))!;
  assert.deepEqual(summaryCell(essays, one.report, one.perWriter, 'moreover').k, { ai: 0, person: 1, of: 1, tooFew: 0 });
});

test('the summary has a cell for every marker in every measured genre, and states its rule', () => {
  const both = [measuredPosts, measureGenre(abstracts, corpus(abstracts))!];
  const s = summarize(both, '2026-09-17T00:00:00.000Z');
  assert.equal(s.rows.length, MARKERS.length);
  for (const r of s.rows) assert.deepEqual(Object.keys(r.genres), ['posts', 'abstracts'], r.marker);
  assert.equal(s.rules.k, K_RULE);
  assert.match(s.rules.k, /Benjamini-Hochberg/);
  assert.deepEqual(s.genres.map((g) => g.id), ['posts', 'abstracts']);
  assert.equal(s.genres[0]!.texts['posts-human'], DOCS);
  assert.ok(s.not_covered.includes('email'));
});

test('the summary says, per kind, how many writers the count is over and which they are', () => {
  const s = summarize([measuredPosts, measuredEssays], '2026-09-17T00:00:00.000Z');
  const [p, e] = s.genres;
  assert.equal(p!.count_over, 4);
  assert.deepEqual(p!.writers.map((w) => w.id), MODELS.map((m) => `posts-${m}`));
  assert.deepEqual(p!.writers.map((w) => w.short), ['GPT-3.5', 'GPT-4', 'Llama', 'Mistral']);
  assert.equal(p!.writers[1]!.snapshot, 'gpt-4-0613');
  assert.equal(p!.decider_short, 'GPT-4');
  assert.match(p!.decoding!, /greedy decoding/);
  // the kind with two writers says two, names them, and claims no checkpoint for arms written here
  assert.equal(e!.count_over, 2);
  assert.deepEqual(e!.writers.map((w) => w.id), ['essays-claude-student', 'essays-llama3-student']);
  assert.deepEqual(e!.writers.map((w) => w.snapshot), [null, null]);
  assert.equal(e!.decider_short, e!.writers[0]!.short);
  assert.notEqual(e!.decider_short, 'GPT-4');
  assert.equal(e!.decoding, null, 'no one setting covers a kind whose arms were run here');
  // every published cell of a kind carries exactly that kind's writers, by arm id
  for (const r of s.rows) {
    assert.ok(Object.keys(r.genres.essays!.writers).every((id) => e!.writers.some((w) => w.id === id)), r.marker);
    assert.ok(r.genres.essays!.k.of + r.genres.essays!.k.tooFew <= 2, r.marker);
  }
});

const loaded = (g: Genre, arms: Arm[]) => armsFor(g).flatMap((spec) => {
  const arm = arms.find((a) => a.id === spec.id);
  return arm ? [{ arm, spec }] : [];
});

test('evidence: a person\'s Reddit post is referenced by id only, the models are quoted', () => {
  const ev = evidenceFor(posts, loaded(posts, corpus(posts)), undefined, new Map());
  const person = ev.markers.moreover!.arms['posts-human']!;
  assert.ok(person.examples.length > 0);
  for (const x of person.examples) assert.deepEqual(Object.keys(x), ['id'], 'no sentence, no link');
  const gpt4 = ev.markers.delve!.arms['posts-gpt4']!;
  assert.ok(gpt4.examples.every((x) => typeof x.sentence === 'string'));
  assert.equal(ev.arms['posts-human']!.publishable, false);
  assert.match(ev.note, /not quoted or linked/);
});

test('evidence: a model sentence that repeats five words of the person\'s post is not quoted, but is counted', () => {
  const arms = corpus(posts);
  const ev = evidenceFor(posts, loaded(posts, arms), undefined, new Map());
  const gpt4 = ev.markers.delve!.arms['posts-gpt4']!;
  assert.equal(gpt4.occurrences, DOCS, 'every delve is counted');
  // five examples drawn from 60, and d0 is never among them however the shuffle falls
  assert.ok(!gpt4.examples.some((x) => x.id === 'raid:gpt4:d0'));
  const guard = makeGuard(arms[0]);
  assert.equal(guard({ id: 'raid:gpt4:d0', form: 'delve', before: '', sentence: 'word0 word1 word2 word3 word4 and we delve.' }), true);
  assert.equal(guard({ id: 'raid:gpt4:d1', form: 'delve', before: '', sentence: 'We delve into it.' }), false);
  assert.equal(guard({ id: 'raid:gpt4:unknown', form: 'delve', before: '', sentence: 'word0 word1 word2 word3 word4' }), false);
  // in the abstracts the person is quotable, so nothing is guarded
  const abs = evidenceFor(abstracts, loaded(abstracts, corpus(abstracts)));
  assert.equal(abs.markers.delve!.arms['raid-gpt4']!.occurrences, DOCS);
  assert.ok(abs.markers.moreover!.arms['raid-human']!.examples.every((x) => typeof x.sentence === 'string'));
});

test('evidence: eight words in a row of anyone\'s post keep a model text off the page, fewer do not', () => {
  const person: Arm = { id: 'posts-human', label: 'p', kind: 'human', texts: [
    { id: 'raid:human:d1', text: 'alpha beta gamma delta epsilon zeta eta theta iota kappa', source: 'p' },
    { id: 'raid:human:d2', text: 'one two three four five six seven eight nine ten', source: 'p' },
  ] };
  const guard = makeTextGuard(person);
  assert.equal(guard('d1', 'so one two three four five six seven eight it goes'), true, 'another poster\'s eight words');
  assert.equal(guard('d1', 'so one two three four five six seven it goes'), false, 'seven words of another post are a stock phrase');
  assert.equal(guard('d1', 'and alpha beta gamma delta epsilon too'), true, 'five words of the post it was written from');
  // the person types a curly apostrophe, the model a straight one: the same words all the same
  const curly = makeTextGuard({ ...person, texts: [
    { id: 'raid:human:d3', text: 'honestly i don’t think we’re ready for this at all', source: 'p' },
    { id: 'raid:human:d4', text: 'my cat can’t stand the new neighbour’s dog and i’m tired of it', source: 'p' },
  ] });
  assert.equal(curly('d3', "But I don't think we're ready yet."), true, 'five words of its own post');
  assert.equal(curly('d3', "The cat can't stand the new neighbour's dog, and it shows."), true, 'eight words of another post');
  assert.equal(curly('d3', "I don't think so."), false);
  assert.deepEqual([...fiveGrams('I don’t know what to say')], [...fiveGrams("I don't know what to say")]);
  assert.equal(containment("we don't know what to do", 'we don’t know what to do'), 1);
  assert.equal(guard('unknown', 'three four five six seven eight nine ten'), true, 'no paired post, still checked against everyone');
  assert.equal(makeGuard(person)({ id: 'raid:gpt4:d1', form: 'x', before: '', sentence: 'two three four five six seven eight nine' }), true);
  // a document whose model text repeats another poster's eight words is not drawn for the panel
  const arms = corpus(posts);
  const human = arms.find((a) => a.id === 'posts-human')!;
  human.texts[1]!.text = `${human.texts[1]!.text} zulu yankee xray whiskey victor uniform tango sierra`;
  const mistral = arms.find((a) => a.id === 'posts-mistral-chat')!;
  for (const t of mistral.texts) if (t.id !== 'raid:mistral-chat:d1') t.text += ' zulu yankee xray whiskey victor uniform tango sierra';
  const docs = documentsFor(posts, loaded(posts, arms), new Map());
  assert.equal(docs.length, 1, `only d1, whose Mistral text is its own: ${docs.map((d) => d.source_id)}`);
  assert.equal(docs[0]!.source_id, 'd1');
});

test('exampleFor: a sentence, a link, or the id alone', () => {
  const h = { id: '33795107', form: 'delve', before: '', sentence: 'a sentence' };
  assert.deepEqual(exampleFor({ id: 'posts-gpt4', publishable: true }, h), { id: '33795107', sentence: 'a sentence' });
  assert.deepEqual(exampleFor({ id: 'casual-human', publishable: false }, h), { id: '33795107', link: 'https://news.ycombinator.com/item?id=33795107' });
  assert.deepEqual(exampleFor({ id: 'posts-human', publishable: false }, { ...h, id: 'raid:human:abc' }), { id: 'raid:human:abc' });
});

test('documents: Reddit posts show the models only, never a copied post, and no title', () => {
  const docs = documentsFor(posts, loaded(posts, corpus(posts)), new Map([['d1', 'a title the poster wrote']]));
  assert.equal(docs.length, 6);
  for (const d of docs) {
    assert.deepEqual(Object.keys(d.texts).sort(), ['posts-chatgpt', 'posts-gpt4', 'posts-llama-chat', 'posts-mistral-chat']);
    assert.equal(d.title, '');
    assert.equal(d.person_not_reproduced, true);
    assert.notEqual(d.source_id, 'd0', 'GPT-4 repeats the person there');
  }
  assert.deepEqual(documentsFor(posts, loaded(posts, corpus(posts)), new Map()), docs, 'seeded, so the same every week');
});

test('documents and evidence: a model text that repeats the post\'s title stays off the page', () => {
  const arms = corpus(posts);
  const drawn = documentsFor(posts, loaded(posts, arms), new Map())[0]!.source_id;
  // Mistral opens the first document drawn with its title, in other capitals and punctuation
  const mistral = arms.find((a) => a.id === 'posts-mistral-chat')!;
  const text = mistral.texts.find((t) => t.id === `raid:mistral-chat:${drawn}`)!;
  text.text = `"My Landlord, Again!" ${text.text}`;
  const titles = new Map([[drawn, 'my landlord again'], ['d2', 'my landlord again'], ['d3', 'help']]);
  assert.ok(documentsFor(posts, loaded(posts, arms), new Map()).some((d) => d.source_id === drawn), 'or this test shows nothing');
  const docs = documentsFor(posts, loaded(posts, arms), titles);
  assert.equal(docs.length, 6);
  assert.ok(!docs.some((d) => d.source_id === drawn));
  const guard = makeTextGuard(arms[0], titles);
  assert.equal(guard('d2', 'About my landlord again: the heating is off.'), true);
  assert.equal(guard('d2', 'About my landlords again.'), false, 'whole words only');
  assert.equal(guard('d3', 'I need help with this.'), false, 'a title of fewer than three words is not checked');
  assert.equal(guard('d4', 'my landlord again'), false, 'another document\'s title is not this one\'s');
  // another document's title of eight words or more is someone's words wherever it turns up
  const long = makeTextGuard(arms[0], new Map([['d5', 'why does my old cat hate the new vet so much']]));
  assert.equal(long('d6', 'I wonder why does my old cat hate the new vet at all.'), true);
  assert.equal(long('d6', 'Why does my old cat hate the vet?'), false);
  // and in the evidence: the sentence is counted, not quoted
  const gpt4 = arms.find((a) => a.id === 'posts-gpt4')!;
  for (const t of gpt4.texts) t.text = t.text.replace('We delve into it.', 'We delve into my landlord again.');
  const ev = evidenceFor(posts, loaded(posts, arms), undefined, titles);
  const cell = ev.markers.delve!.arms['posts-gpt4']!;
  assert.equal(cell.occurrences, DOCS);
  assert.ok(!cell.examples.some((x) => x.id === 'raid:gpt4:d2'));
  assert.match(ev.note, /or the document's title/);
});

test('documents: none opens with a sensitive subject, in any writer\'s text', () => {
  for (const t of ['I have been thinking about suicide lately.', 'She was sexually assaulted last year.', 'my brother had a psychotic episode', 'recovering from anorexia', 'he nearly overdosed', 'I want to end my life']) {
    assert.ok(SENSITIVE.test(t), t);
  }
  for (const t of ['a grape harvest', 'rapid growth', 'the drapes', 'a self-help book', 'my rapeseed field'] ) assert.equal(SENSITIVE.test(t), false, t);
  const arms = corpus(posts);
  const before = documentsFor(posts, loaded(posts, arms), new Map()).map((d) => d.source_id);
  // the first document drawn is about self-harm in the person's text only, the second in a model's
  arms.find((a) => a.id === 'posts-human')!.texts.find((t) => t.id === `raid:human:${before[0]}`)!.text += ' I self-harm when it gets bad.';
  arms.find((a) => a.id === 'posts-llama-chat')!.texts.find((t) => t.id === `raid:llama-chat:${before[1]}`)!.text += ' Suicidal thoughts are common.';
  const after = documentsFor(posts, loaded(posts, arms), new Map()).map((d) => d.source_id);
  assert.equal(after.length, 6);
  assert.ok(!after.includes(before[0]!) && !after.includes(before[1]!), `${before} -> ${after}`);
  // the abstracts follow the same policy
  const abs = corpus(abstracts);
  const first = documentsFor(abstracts, loaded(abstracts, abs), new Map())[0]!.source_id;
  abs.find((a) => a.id === 'raid-claude')!.texts.find((t) => t.id === first)!.text += ' We study psychosis onset.';
  assert.ok(!documentsFor(abstracts, loaded(abstracts, abs), new Map()).some((d) => d.source_id === first));
});

test('evidence: no sentence comes from a Reddit document on a sensitive subject, in any writer\'s text, but every use is counted', () => {
  for (const t of ['he was wrongly accused after the bombing', 'my dad is an alcoholic', 'I got addicted to painkillers', 'the lawsuit against the church', 'he was arrested last night', 'a school shooting']) {
    assert.ok(SENSITIVE.test(t), t);
  }
  const arms = corpus(posts);
  const before = evidenceFor(posts, loaded(posts, arms), undefined, new Map()).markers.delve!.arms['posts-gpt4']!;
  const shown = before.examples.map((x) => x.id.replace(/^raid:gpt4:/, ''));
  assert.ok(shown.length >= 2);
  // one shown document turns sensitive in the person's text, another in a different model's
  arms.find((a) => a.id === 'posts-human')!.texts.find((t) => t.id === `raid:human:${shown[0]}`)!.text += ' He was accused of the bombing.';
  arms.find((a) => a.id === 'posts-mistral-chat')!.texts.find((t) => t.id === `raid:mistral-chat:${shown[1]}`)!.text += ' My brother is an addict.';
  const after = evidenceFor(posts, loaded(posts, arms), undefined, new Map()).markers.delve!.arms['posts-gpt4']!;
  assert.equal(after.occurrences, before.occurrences, 'still counted');
  const now = after.examples.map((x) => x.id.replace(/^raid:gpt4:/, ''));
  assert.ok(!now.includes(shown[0]!) && !now.includes(shown[1]!), `${shown} -> ${now}`);
  // the abstracts quote the person, and an academic subject is not hidden from their evidence
  const abs = corpus(abstracts);
  const absBefore = evidenceFor(abstracts, loaded(abstracts, abs)).markers.delve!.arms['raid-gpt4']!.examples.map((x) => x.id);
  const target = absBefore[0]!.replace(/^raid:gpt4:/, '');
  abs.find((a) => a.id === 'raid-human')!.texts.find((t) => t.id === `raid:human:${target}`)!.text += ' We model drug addiction.';
  assert.deepEqual(evidenceFor(abstracts, loaded(abstracts, abs)).markers.delve!.arms['raid-gpt4']!.examples.map((x) => x.id), absBefore);
});

test('titlesFor: hidden titles come from out/ and must be there', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'titles-'));
  assert.throws(() => titlesFor(posts, dir), /posts-titles\.json is missing/);
  writeFileSync(path.join(dir, 'posts-titles.json'), JSON.stringify([{ source_id: 'd1', title: 'a title' }]));
  assert.deepEqual([...titlesFor(posts, dir)], [['d1', 'a title']]);
  // the abstracts' titles are shown, and a missing prompts file only leaves them fewer
  assert.ok(titlesFor(abstracts, dir) instanceof Map);
});

test('documents: abstracts come from the Claude arm\'s documents, with every writer and the title', () => {
  const docs = documentsFor(abstracts, loaded(abstracts, corpus(abstracts)), new Map([['d3', 'A Paper']]));
  assert.equal(docs.length, 6);
  for (const d of docs) {
    assert.ok(Number(d.source_id.slice(1)) < 8, 'the Claude arm covers d0-d7');
    assert.deepEqual(Object.keys(d.texts), ['raid-human', 'raid-chatgpt', 'raid-gpt4', 'raid-llama-chat', 'raid-mistral-chat', 'raid-claude']);
    assert.equal(d.person_not_reproduced, undefined);
  }
  assert.equal(docs.find((d) => d.source_id === 'd3')?.title ?? 'A Paper', 'A Paper');
});

test('claude-matched: only the Claude documents every writer still has', () => {
  const arms = corpus(abstracts);
  const gpt4 = arms.find((a) => a.id === 'raid-gpt4')!;
  gpt4.texts = gpt4.texts.filter((t) => t.id !== 'raid:gpt4:d2');   // dropped by the cleaning
  const ids = sharedDocuments(new Map(arms.map((a) => [a.id, a])), abstracts.writers.map((w) => w.id), 'raid-claude');
  assert.deepEqual(ids, ['d0', 'd1', 'd3', 'd4', 'd5', 'd6', 'd7']);
});

function writeData(dir: string, layout: 'genres' | 'legacy'): void {
  const abs = measureGenre(abstracts, corpus(abstracts))!;
  const evA = evidenceFor(abstracts, loaded(abstracts, corpus(abstracts)));
  if (layout === 'legacy') {
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, 'markers.json'), JSON.stringify(abs.report));
    writeFileSync(path.join(dir, 'evidence.json'), JSON.stringify(evA));
    return;
  }
  for (const [g, m, ev] of [[abstracts, abs, evA], [posts, measuredPosts, evidenceFor(posts, loaded(posts, corpus(posts)), undefined, new Map())]] as const) {
    mkdirSync(path.join(dir, 'genres', g.id), { recursive: true });
    writeFileSync(path.join(dir, 'genres', g.id, 'markers.json'), JSON.stringify({ ...m.report, genre: g.id }));
    writeFileSync(path.join(dir, 'genres', g.id, 'evidence.json'), JSON.stringify(ev));
  }
  writeFileSync(path.join(dir, 'genres', 'posts', 'cleaning.json'), JSON.stringify({ dates: { applied: 'not applicable' }, arms: [
    { arm: 'posts-human', writer: 'human', texts: 60, excluded_by_date: 0, truncated: null, meta: null, unchecked: null, remembered: null, mean_containment: null, kept: 60 },
    { arm: 'posts-llama-chat', writer: 'llama-chat', texts: 70, excluded_by_date: 0, truncated: 7, meta: 3, unchecked: 0, remembered: 0, mean_containment: 0.01, kept: 60, dropped: { truncated: [], meta: [], remembered: [] } },
  ] }));
  writeFileSync(path.join(dir, 'summary.json'), JSON.stringify(summarize([abs, measuredPosts])));
}

test('build: the per-genre layout gives a grid cell for every genre and marker, with the count', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'data-'));
  writeData(dir, 'genres');
  const found = findGenres(dir);
  assert.deepEqual(found.map((x) => x.genre.id), ['abstracts', 'posts'], 'the registry\'s order');
  const summary = summaryFor(found, JSON.parse(readFileSync(path.join(dir, 'summary.json'), 'utf8')));
  assert.equal(summary.measured, true);
  assert.equal(summary.rows.length, MARKERS.length);
  for (const r of summary.rows) {
    for (const g of ['abstracts', 'posts']) assert.ok(r.genres[g]?.k, `${r.marker} × ${g}`);
  }
  assert.deepEqual(summary.rows.find((r) => r.marker === 'delve')!.genres.posts!.k, { ai: 2, person: 0, of: 2, tooFew: 2 });
  assert.deepEqual(summary.genres.map((g) => g.file), ['data/genres/abstracts.json', 'data/genres/posts.json']);
  assert.ok(Buffer.byteLength(JSON.stringify(summary)) < BUDGET.summary);

  const page = pageFor(found[1]!.genre, found[1]!.report, found[1]!.evidence, found[1]!.cleaning);
  assert.deepEqual(page.writers.map((w) => w.id), ['posts-human', 'posts-chatgpt', 'posts-gpt4', 'posts-llama-chat', 'posts-mistral-chat']);
  assert.deepEqual(page.context.map((w) => w.id), ['casual-human']);
  assert.equal(page.genre.deciderShort, 'GPT-4');
  assert.equal(page.genre.humanQuotable, false);
  assert.equal(page.arms.find((a) => a.id === 'posts-human')!.publishable, false);
  assert.equal(page.cleaning!.arms[1]!.truncated, 7);
  assert.ok(!JSON.stringify(page.cleaning).includes('dropped'), 'the dropped ids stay in data/');
  assert.equal(pageFor(found[0]!.genre, found[0]!.report, found[0]!.evidence, found[0]!.cleaning).cleaning, null);
  // posts have no dating rule; abstracts without a cleaning file were measured before the rule
  assert.deepEqual(summary.genres.map((g) => g.dating.status), ['unchecked', 'none']);
  // the markers flat posts cannot show: not recorded, no count, and the reason goes to the page
  const bold = summary.rows.find((r) => r.marker === 'bulleted_bold')!.genres.posts!;
  assert.equal(bold.verdict, 'not recorded');
  assert.deepEqual(bold.k, { ai: 0, person: 0, of: 0, tooFew: 0 });
  assert.equal(summary.rows.find((r) => r.marker === 'bulleted_bold')!.genres.abstracts!.verdict === 'not recorded', false);
  assert.match(page.genre.notRecorded.title_case_headings!, /flat text/);
});

test('build: the dating is read from cleaning.json, and the excluded ids stay in data/', () => {
  const base = { applied: 'applied from data/abstracts-dates.json', window: ['2022-11-30', '2024-06-04'] as [string, string], documents: 1499, excluded: 8, dated: 87, undated: 1412, unmatched: 0, first_posted: ['2008-10-21', '2021-09-21'] as [string, string] };
  const partial = datingOf(abstracts, { dates: { ...base, complete: false, not_looked_up: 1412 }, arms: [] });
  assert.deepEqual(partial, { status: 'partial', documents: 1499, excluded: 8, unmatched: 0, notLookedUp: 1412, firstPosted: ['2008-10-21', '2021-09-21'] });
  assert.equal(datingOf(abstracts, { dates: { ...base, complete: true, not_looked_up: 0 }, arms: [] }).status, 'applied');
  // a file that calls itself complete but misses documents is still partial
  assert.equal(datingOf(abstracts, { dates: { ...base, complete: true, not_looked_up: 3 }, arms: [] }).status, 'partial');
  assert.deepEqual(datingOf(abstracts, { dates: { applied: 'not applied: data/abstracts-dates.json does not exist yet' }, arms: [] }), { status: 'not applied' });
  assert.deepEqual(datingOf(abstracts, null), { status: 'unchecked' });
  assert.deepEqual(datingOf(posts, { dates: { applied: 'not applicable' }, arms: [] }), { status: 'none' });
  assert.ok(!JSON.stringify(partial).includes('excluded_ids'));
});

test('build: the old single-genre files still build, with verdicts and no count', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'legacy-'));
  writeData(dir, 'legacy');
  const found = findGenres(dir);
  assert.deepEqual(found.map((x) => x.genre.id), ['abstracts']);
  const summary = summaryFor(found, null);
  assert.equal(summary.measured, false);
  assert.equal(summary.k_rule, null);
  for (const r of summary.rows) {
    const c = r.genres.abstracts!;
    assert.equal(c.k, null);
    assert.equal(c.verdict, found[0]!.report.rows.find((x) => x.marker === r.marker)!.verdict);
  }
});

test('build: a kind decided against a writer of its own reaches the grid, counted over its own writers', () => {
  const summary = summarize([measuredPosts, measuredEssays], '2026-09-17T00:00:00.000Z');
  const grid = summaryFor([{ genre: posts, report: measuredPosts.report }, { genre: essays, report: measuredEssays.report }], summary);
  const p = grid.genres.find((g) => g.id === 'posts')!;
  const e = grid.genres.find((g) => g.id === 'essays')!;
  assert.equal(p.countOver, 4);
  assert.deepEqual(p.writers.map((w) => w.short), ['GPT-3.5', 'GPT-4', 'Llama', 'Mistral']);
  assert.match(p.decoding!, /greedy decoding/);
  // the kind whose two writers were written here: its own decider, its own two columns, no decoding claim
  assert.equal(e.deciderShort, 'Claude*');
  assert.notEqual(e.deciderShort, p.deciderShort);
  assert.equal(e.countOver, 2);
  assert.deepEqual(e.writers.map((w) => w.short), ['Claude*', 'Llama 3*']);
  assert.equal(e.decoding, null);
  assert.ok(e.writtenHere?.note.includes('{columns}'), 'the page fills in which columns are marked');
  const cell = grid.rows.find((r) => r.marker === 'moreover')!.genres.essays!;
  assert.deepEqual(cell.k, { ai: 0, person: 1, of: 2, tooFew: 0 });
  assert.deepEqual(Object.keys(cell.writers!), ['essays-claude-student', 'essays-llama3-student']);
  const html = gridCellHtml(cell, e, 'moreover');
  assert.match(html, /▼ 1 of 2 models</);
  assert.match(html, /Claude\* ▼/);
  assert.doesNotMatch(html, /of 4 models/);
  // the four-writer kind beside it is unmoved
  assert.match(gridCellHtml(grid.rows.find((r) => r.marker === 'moreover')!.genres.posts!, p, 'moreover'), /▼ 3 of 4 models</);
});

test('build: a summary written before the count ran over each kind\'s writers still names its writers', () => {
  const cell = summaryCell(posts, measuredPosts.report, measuredPosts.perWriter, 'moreover');
  const { writers, ...rest } = cell;
  // the committed file's shape: one entry per RAID model, keyed by the model's name, and no `writers`
  const legacy = { ...rest, models: Object.fromEntries(Object.entries(writers).map(([id, v]) => [id.replace(/^posts-/, ''), v])) } as unknown as SummaryCell;
  const out = pageCell(posts, legacy);
  assert.deepEqual(out.writers, writers, 'the registry says which arm each of those models wrote');
  assert.deepEqual(out.k, cell.k);
  assert.equal(pageCell(posts, cell), cell, 'a summary that already has them is passed through untouched');
  // a kind no RAID model wrote has nothing to recover, and says nothing rather than inventing a column
  assert.deepEqual(pageCell(essays, legacy).writers, {});
});

test('build: a genre report without its evidence is an error, and budgets are enforced', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'broken-'));
  mkdirSync(path.join(dir, 'genres', 'posts'), { recursive: true });
  writeFileSync(path.join(dir, 'genres', 'posts', 'markers.json'), JSON.stringify(measuredPosts.report));
  assert.throws(() => findGenres(dir), /evidence/);
  // the abstracts' old evidence file next to it, as the repository has it, changes nothing
  writeData(dir, 'legacy');
  assert.throws(() => findGenres(dir), /posts: .*has no evidence file next to it/);
  // nor does it stand in for the abstracts' own report's evidence in the new layout
  const own = mkdtempSync(path.join(tmpdir(), 'own-'));
  writeData(own, 'legacy');
  mkdirSync(path.join(own, 'genres', 'abstracts'), { recursive: true });
  writeFileSync(path.join(own, 'genres', 'abstracts', 'markers.json'), readFileSync(path.join(own, 'markers.json')));
  assert.throws(() => findGenres(own), /abstracts: .*has no evidence file next to it/);
  assert.equal(overBudget('x', 100, 200), null);
  assert.match(overBudget('data/genres/posts.json', 300 * 1024, BUDGET.genre)!, /300 KB, over its budget of 250 KB/);
});

test('build --release: undated or partly dated abstracts are not published', () => {
  const base = { applied: 'applied from data/abstracts-dates.json', window: ['2022-11-30', '2024-06-04'] as [string, string], documents: 1499, excluded: 150, dated: 1400, undated: 99, unmatched: 99, first_posted: ['2008-10-21', '2021-09-21'] as [string, string] };
  const at = (cleaning: CleaningFile | null) => releaseProblems([{ genre: abstracts, cleaning }, { genre: posts, cleaning: { dates: { applied: 'not applicable' }, arms: [] } }]);
  assert.deepEqual(at({ dates: { ...base, complete: true, not_looked_up: 0 }, arms: [] }), [], 'complete: releasable, unmatched and all');
  assert.match(at({ dates: { ...base, complete: false, not_looked_up: 1412 }, arms: [] })[0]!, /^abstracts: the dating is partial \(1412 of 1499/);
  assert.match(at({ dates: { applied: 'not applied: data/abstracts-dates.json does not exist yet' }, arms: [] })[0]!, /abstracts-dates\.json was not there/);
  assert.equal(at(null).length, 1, 'measured before the checks existed');
  // the committed data today builds without --release, and the posts never need a dating
  assert.deepEqual(releaseProblems([{ genre: posts, cleaning: null }]), []);
});

/** a kind of writing as the grid has it: its own decider and its own counted writers, from the registry */
const genreMeta = (g: Genre, extra: Partial<SummaryGenre> = {}): SummaryGenre => {
  const counted = g.writers.filter((w) => w.tested);
  return {
    id: g.id, label: g.label, inText: g.inText, noun: g.noun, prompt: g.prompt, reference: g.reference, decider: g.decider,
    deciderShort: g.writers.find((w) => w.id === g.decider)!.short,
    writers: counted.map((w) => ({ id: w.id, short: w.short, snapshot: null })), countOver: counted.length, decoding: null,
    titles: g.titles, humanQuotable: g.humanQuotable, documents: g.documents, source: g.source, file: `data/genres/${g.id}.json`, texts: 60, placebo_disagreements: 0, ...extra,
  };
};

test('page: the verdict is worded for its kind of writing and its decider', () => {
  const [cls, text, byRate, byShare] = verdictWords('machine marker', { deciderShort: 'GPT-4', noun: posts.noun });
  assert.equal(cls, 'machine');
  assert.equal(text, 'GPT-4 marker');
  assert.match(byRate, /the same posts/);
  assert.match(byShare, /the same posts/);
  assert.doesNotMatch(verdictWords('points the other way', { deciderShort: 'GPT-4', noun: abstracts.noun })[2], /posts/);
  assert.deepEqual(verdictWords('something new', { deciderShort: 'GPT-4', noun: posts.noun }), ['none', 'something new', '', '']);
});

test('page: a grid cell carries a glyph, the words and the count, never colour alone', () => {
  const names = writerNames(genreMeta(posts));
  const cell = {
    verdict: 'machine marker', q: 0.0001, placeboTie: false, unit: 'per 1000 words', person: 0, decider: 6.5, n: 60,
    k: { ai: 3, person: 1, of: 4 },
    writers: {
      'posts-chatgpt': { verdict: 'machine marker', q: 0.01 }, 'posts-gpt4': { verdict: 'machine marker', q: 0.0001 },
      'posts-llama-chat': { verdict: 'machine marker', q: 0.02 }, 'posts-mistral-chat': { verdict: 'points the other way', q: 0.03 },
    },
  };
  const html = gridCellHtml(cell, genreMeta(posts), 'delve');
  assert.match(html, /▲ GPT-4 marker/);
  assert.match(html, /▲ 3 of 4 models · ▼ 1 of 4 models/);
  assert.match(kHtml({ ai: 0, person: 0, of: 3 }, null, names), />0 of 3 models</);
  // a model with too little to compare is named in the tooltip, and a cell with none left says so
  const few = kHtml({ ai: 1, person: 0, of: 1, tooFew: 3 }, { 'posts-gpt4': { verdict: 'machine marker', q: 0.001, evidence: { occurrences: 12 }, tooFew: false }, 'posts-chatgpt': { verdict: 'no signal', q: 1, evidence: { occurrences: 1 }, tooFew: true } }, names);
  assert.match(few, />▲ 1 of 1 models</);
  assert.match(few, /and 3 with too little to compare/);
  assert.match(few, /GPT-4 ▲ \(12 uses\), GPT-3\.5 too few \(1 use\)/);
  const none = kHtml({ ai: 0, person: 0, of: 0, tooFew: 4 }, { 'posts-gpt4': { verdict: 'register marker', q: null, evidence: { pairs: 504, minority: 1 }, tooFew: true } }, names);
  assert.match(none, />too little to compare</);
  assert.match(none, /504 pairs, 1 on the rarer side/);
  assert.equal(kHtml({ ai: 0, person: 0, of: 0, tooFew: 0 }, null, names), '', 'not recorded: no count at all');
  assert.match(html, /placebo disagrees/);
  assert.match(html, /data-genre="posts" data-marker="delve"/);
  assert.match(html, /Mistral ▼/);
  assert.match(html, /q &lt; 0\.001/);
  assert.equal(kHtml(null, null, names), '', 'no count before the new measurement');
  assert.match(gridCellHtml({ ...cell, k: null, writers: null, verdict: 'register marker', placeboTie: true }, genreMeta(posts), 'delve'), /◆ careful writing<\/span><\/td>/);
  assert.match(gridCellHtml(undefined, genreMeta(posts), 'delve'), /–/);
});

test('page: a kind decided against a writer that is not GPT-4 renders its own cell, counted of 2', () => {
  const g = genreMeta(essays);
  assert.equal(g.deciderShort, 'Claude*');
  const cell = {
    verdict: 'machine marker', q: 0.0002, placeboTie: true, unit: 'per 1000 words', person: 0, decider: 4.2, n: 200,
    k: { ai: 1, person: 0, of: 2, tooFew: 0 },
    writers: {
      'essays-claude-student': { verdict: 'machine marker', q: 0.0002, evidence: { occurrences: 61 }, tooFew: false },
      'essays-llama3-student': { verdict: 'no signal', q: 0.4, evidence: { occurrences: 9 }, tooFew: false },
    },
  };
  const html = gridCellHtml(cell, g, 'delve');
  // the verdict is worded for this kind's own decider, and the count over the two writers it has
  assert.match(html, /▲ Claude\* marker/);
  assert.match(html, /▲ 1 of 2 models</);
  assert.doesNotMatch(html, /GPT-4|of 4 models/);
  // the names in the tooltip are this kind's own columns, taken from the kind rather than from a global list
  assert.match(html, /Claude\* ▲ \(61 uses\), Llama 3\* – \(9 uses\)/);
  assert.match(html, /Person 0\.00, Claude\* 4\.20/);
  // and the four-writer kinds are worded exactly as before
  assert.match(gridCellHtml({ ...cell, k: { ai: 3, person: 1, of: 4, tooFew: 0 }, writers: null }, genreMeta(posts), 'delve'), /▲ 3 of 4 models · ▼ 1 of 4 models/);
});

test('page: the column head says how many models a kind counts across, and the legend is built from the cells', () => {
  assert.equal(countedWords(genreMeta(posts, { decoding: 'greedy decoding, no repetition penalty' })),
    'counted across 4 models: GPT-3.5, GPT-4, Llama, Mistral; greedy decoding, no repetition penalty');
  assert.equal(countedWords(genreMeta(essays)), 'counted across 2 models: Claude*, Llama 3*');
  assert.equal(countedWords({ writers: [], countOver: 0, decoding: null }), '', 'nothing to say before the count exists');
  const legend = legendHtml();
  assert.match(legend, /<span class="pill machine">▲ model marker<\/span> the model uses it more/);
  assert.match(legend, /<span class="pill other">▼ more human<\/span> the person uses it more/);
  assert.match(legend, /<span class="pill none">· not recorded<\/span> no text of that kind can show it/);
  assert.doesNotMatch(legend, /GPT-4|Claude/, 'the legend stands over every column, so it names no writer');
});

test('page: the columns written for this project are all marked, and say so under the table', () => {
  const arms = [
    { id: 'essays-human', n: 5867 }, { id: 'essays-claude-student', n: 200 },
    { id: 'essays-llama3-student', n: 200 }, { id: 'essays-claude-plain', n: 200 },
  ].map((a) => ({ ...a, label: '', kind: 'machine', matched: 200, medianWords: 500, publishable: true, we: 0 }));
  const writers = essays.writers.map((w) => ({ id: w.id, short: w.short, long: w.label, quotable: w.quotable }));
  const note = writtenHereNote({ genre: { ...genreMeta(essays), writtenHere: essays.writtenHere! }, writers, arms });
  // all three starred columns are named with what each wrote: the mark is not about the first of them
  assert.match(note, /^\* /);
  assert.ok(note.includes('Claude* 200, Llama 3* 200 and Claude plain* 200 essays'), note);
  // written here, when, from what, that the run cannot be replayed and why, and who wrote the page
  assert.match(note, /written for this project in September 2026/);
  assert.match(note, /given the assignment alone/);
  assert.match(note, /cannot be written again word for word/);
  assert.match(note, /Ollama’s seed did not give back the same essay/);
  assert.match(note, /Claude Code exposes no sampling settings/);
  assert.match(note, /The same assistant that wrote the Claude columns also wrote this page/);
  assert.match(note, /<a href="[^"]+#school-essays">the caveats<\/a> matter\. $/);
  assert.doesNotMatch(note, /\{columns\}|\{caveats\}/);
  // one such column is named by what it wrote alone, being the only one marked, and the abstracts'
  // footnote is the sentence the page carried before the registry held it, byte for byte
  const one = writtenHereNote({
    genre: { ...genreMeta(abstracts), writtenHere: abstracts.writtenHere! },
    writers: [{ id: 'raid-claude', short: 'Claude*', long: '', quotable: true }],
    arms: [{ ...arms[0]!, id: 'raid-claude', n: 44 }],
  });
  assert.equal(one, '* Claude was generated for this project (44 abstracts, reached through Claude Code) and the same system wrote this page; '
    + '<a href="https://github.com/barbarkaragul-oss/is-it-really-an-ai-tell#a-claude-arm-generated-here">the caveats</a> matter. ');
  // a kind with nothing written here, or an arm that is not in the measurement, carries no footnote
  assert.equal(writtenHereNote({ genre: genreMeta(posts), writers, arms }), '');
  assert.equal(writtenHereNote({ genre: { ...genreMeta(essays), writtenHere: essays.writtenHere! }, writers, arms: [] }), '');
});

test('page: the grid caption keeps its old words for kinds that share one set of models, and names each decider otherwise', () => {
  const raid = [genreMeta(abstracts, { decoding: 'greedy decoding, no repetition penalty' }), genreMeta(posts, { decoding: 'greedy decoding, no repetition penalty' })];
  assert.equal(sharesOneSet(raid), true);
  // the caption the page carried while every kind came from RAID, word for word
  assert.equal(gridCaption(raid, true), 'Each cell is one kind of writing. The label is GPT-4’s verdict against the people who wrote the same documents, as in the table below. '
    + 'Under it, how many of the 4 models (GPT-3.5, GPT-4, Llama, Mistral; greedy decoding, no repetition penalty) the marker separates from the person there, each decided by the same rules: '
    + '▲ toward the model, ▼ toward the person. A model is counted only where there is something to compare: a word that it and the person hardly use, or a property every text has, '
    + 'leaves too little. Click a cell for that kind’s full table.');
  assert.equal(gridCaption(raid, false), 'Each cell is one kind of writing, with GPT-4’s verdict against the people who wrote the same documents. '
    + 'The count across all 4 models appears after the next weekly measurement. Click a cell for the full table.');
  // with the essays beside them, no kind is described under another kind's decider
  const all = [...raid, genreMeta(essays)];
  assert.equal(sharesOneSet(all), false);
  const mixed = gridCaption(all, true);
  assert.match(mixed, /GPT-4 against the people who wrote the same documents in research abstracts and Reddit posts; Claude\* against the people who answered the same assignments in school essays\./);
  assert.doesNotMatch(mixed, /GPT-4’s verdict|the 4 models/);
  assert.match(mixed, /A model marked \* was run for this project/);
  assert.match(gridCaption(all, false), /Claude\* against the people who answered the same assignments in school essays\. The count across each kind’s models/);
  // the legend names no writer, and is the legend the page always had
  assert.equal(legendHtml(), '<span class="pill machine">▲ model marker</span> the model uses it more · <span class="pill other">▼ more human</span> the person uses it more · '
    + '<span class="pill register">◆ careful writing</span> both, more than casual writers · <span class="pill none">– no signal</span> · <span class="pill none">· not recorded</span> no text of that kind can show it');
});

test('page: "Not covered" is unchanged for the RAID kinds and says the essays are covered where they are measured', () => {
  const raid = [genreMeta(abstracts), genreMeta(posts)];
  assert.equal(notCoveredText('email', raid), 'Not covered: email. Paired sets of a person’s text and models writing the same thing do exist for some of these, but none that can be used here under its terms, so they are left out rather than guessed at.');
  const withEssays = notCoveredText('email', [...raid, { ...genreMeta(essays), covered: essays.covered! }]);
  assert.match(withEssays, /guessed at\. Student essays are covered, with the machine side written for this project/);
});

test('page: a verdict in a kind paired by assignment never says the writers wrote the same texts', () => {
  const g = { deciderShort: 'Claude*', noun: essays.noun, documents: 'assignment' };
  for (const v of ['machine marker', 'points the other way']) {
    const [, , byRate, byShare] = verdictWords(v, g);
    assert.doesNotMatch(byRate + byShare, /the same essays/, v);
    assert.match(byRate + byShare, /the same assignments/, v);
  }
  // a kind whose writers rewrote the person's documents is worded exactly as before
  assert.equal(verdictWords('machine marker', { deciderShort: 'GPT-4', noun: posts.noun, documents: 'models' })[2],
    verdictWords('machine marker', { deciderShort: 'GPT-4', noun: posts.noun })[2]);
  assert.match(verdictWords('machine marker', { deciderShort: 'GPT-4', noun: posts.noun })[2], /^GPT-4 uses it more often than the person who wrote the same posts,/);
});

test('page: the address picks a known kind of writing only', () => {
  assert.equal(genreFromHash('#genre=posts', ['abstracts', 'posts']), 'posts');
  assert.equal(genreFromHash('#genre=essays', ['abstracts', 'posts']), null);
  assert.equal(genreFromHash('#method', ['abstracts', 'posts']), null);
  assert.equal(genreFromHash('', ['abstracts']), null);
});

test('page: what was dropped is said in numbers', () => {
  const arms = [
    { arm: 'raid-llama-chat', texts: 1500, dated: 12, truncated: 200, meta: 50, remembered: 0, unchecked: 0, kept: 1238, reported: null },
    { arm: 'raid-claude', texts: 50, dated: 1, truncated: null, meta: null, remembered: 5, unchecked: 0, kept: 44, reported: { truncated: 0, meta: 2 } },
  ];
  const writers = [{ id: 'raid-llama-chat', short: 'Llama', long: '', quotable: true }, { id: 'raid-claude', short: 'Claude*', long: '', quotable: true }];
  const applied = { status: 'applied' as const, excluded: 12, documents: 1500, unmatched: 3, notLookedUp: 0, firstPosted: ['2008-10-21', '2021-09-21'] as [string, string] };
  const note = cleaningNote({ genre: genreMeta(abstracts), writers, cleaning: { dates: applied, arms } });
  assert.match(note, /12 of 1500 abstracts left out/);
  assert.match(note, /3 could not be matched to a paper and are kept/);
  assert.doesNotMatch(note, /partial/);
  assert.match(note, /Llama 200 cut off, 50 not an answer, 0 remembered/);
  assert.ok(note.includes('Claude*: 0 would count as cut off and 2 as not an answer (reported, not dropped)'), note);
  const partial = cleaningNote({ genre: genreMeta(abstracts), writers, cleaning: { dates: { ...applied, status: 'partial', notLookedUp: 1410, unmatched: 0 }, arms } });
  assert.match(partial, /12 of 1500 abstracts left out of every column because a version was posted after ChatGPT \(the dating is partial, and 1410 not yet looked up are kept\)/);
  assert.match(cleaningNote({ genre: genreMeta(abstracts), writers: [], cleaning: { dates: { status: 'not applied' }, arms: [] } }), /not applied yet/);
  // a kind of writing without a dating rule says nothing about dates
  assert.doesNotMatch(cleaningNote({ genre: genreMeta(posts), writers: [], cleaning: { dates: { status: 'none' }, arms: [] } }), /dat/);
  // the documents left out for their language, then what each model lost, each its own sentence
  const lang = cleaningNote({ genre: genreMeta(posts), writers, cleaning: { dates: { status: 'none' }, language: { documents: 1375, excluded: 37 }, arms } });
  assert.match(lang, /^In Reddit posts: 37 of 1375 posts left out of every column because one of the writers, the person or a model, wrote it in another language\. Texts dropped per model: /);
  assert.doesNotMatch(cleaningNote({ genre: genreMeta(posts), writers, cleaning: { dates: { status: 'none' }, language: { documents: 1375, excluded: 0 }, arms } }), /language/);
  assert.equal(esc('<a href="x">'), '&lt;a href=&quot;x&quot;&gt;');
});

test('page: numbers measured before the cleaning are not described as cleaned', () => {
  const note = cleaningNote({ genre: genreMeta(abstracts), writers: [], cleaning: null });
  assert.match(note, /measured before the cut-off, not-an-answer and dating checks existed; the next weekly measurement applies them/);
  assert.match(datingWords({ status: 'unchecked' }, abstracts.noun), /measured before this rule existed/);
});

test('page: the dating says whether it is applied, partial or not yet, and what it found', () => {
  const found = { documents: 1499, excluded: 8, unmatched: 0, notLookedUp: 1412, firstPosted: ['2008-10-21', '2021-09-21'] as [string, string] };
  assert.equal(datingWords({ status: 'none' }, posts.noun), '');
  assert.equal(datingWords(undefined, posts.noun), '');
  assert.match(datingWords({ status: 'not applied' }, abstracts.noun), /not applied yet: the abstracts have not been dated/);
  assert.equal(datingWords({ status: 'partial', ...found }, abstracts.noun),
    'The dating is partial: 87 of 1499 abstracts have been looked up and 8 left out; the other 1412 are kept until they are dated. The dated ones were first posted between 2008 and 2021.');
  assert.equal(datingWords({ status: 'applied', ...found, notLookedUp: 0, unmatched: 4, excluded: 210 }, abstracts.noun),
    '210 of 1499 abstracts are left out by it. 4 could not be matched to a paper and are kept. The dated ones were first posted between 2008 and 2021.');
  // the dates file is linked only once it is in the repository
  assert.deepEqual((['none', 'unchecked', 'not applied'] as const).map((status) => datesLinked({ status })), [true, false, false]);
  assert.equal(datesLinked({ status: 'partial', ...found }), true);
  const g = genreMeta(abstracts);
  assert.equal(peopleWords(g), 'arXiv papers', 'no years claimed before the dating');
  assert.equal(peopleWords({ ...g, dating: { status: 'partial', ...found } }), 'arXiv papers, first posted 2008–2021 (of those dated so far)');
  assert.equal(peopleWords({ ...g, dating: { status: 'applied', ...found, notLookedUp: 0 } }), 'arXiv papers, first posted 2008–2021');
});

test('page: a marker a kind of writing cannot show is "not recorded", with its reason, and no count', () => {
  const reason = posts.notRecorded!.bulleted_bold!;
  const cell = { verdict: 'not recorded', q: null, placeboTie: true, unit: '% of texts', person: 0, decider: 0, n: 500, k: { ai: 0, person: 0, of: 0 }, writers: { 'posts-gpt4': { verdict: 'not recorded', q: null } } };
  const html = gridCellHtml(cell, genreMeta(posts, { notRecorded: posts.notRecorded! }), 'bulleted_bold');
  assert.match(html, /· not recorded/);
  assert.ok(html.includes(esc(reason)), 'the reason is the tooltip');
  assert.doesNotMatch(html, /of 0 models/);
  assert.equal(whyOf('not recorded', { ...genreMeta(abstracts), notRecorded: {} }, 'bulleted_bold', false), '');
  assert.match(whyOf('machine marker', genreMeta(posts), 'delve', true), /comparing texts of the same length/);
});

test('page: the script names no writer and no kind of writing; the data does', () => {
  const src = readFileSync(path.resolve('src/ui/main.ts'), 'utf8');
  assert.doesNotMatch(src, /\b(?:raid|posts|essays)-(?:human|chatgpt|gpt4|llama-chat|mistral-chat|claude|claude-student|llama3-student|claude-plain)\b/);
  assert.doesNotMatch(src, /'(?:casual|careful)-human'|hc3-gpt35/);
  // what wrote an arm, and through what, is the data's to say: the footnote under the table comes from
  // the registry for exactly this reason (scripts/genres.ts, writtenHere)
  assert.doesNotMatch(src, /\bClaude\b|\bLlama\b|\bMistral\b|GPT-\d|\bOllama\b|Opus/);
  assert.doesNotMatch(src, /\babstracts?\b|Reddit/);
});
