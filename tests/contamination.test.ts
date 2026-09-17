import test from 'node:test';
import assert from 'node:assert/strict';
import {
  containment, checkArm, cleanArm, claudeAgrees, datedExclusions, dayOf, titleKey, DATE_WINDOW, foreignDocuments,
  type Detectors, type DatesFile, type Generated,
} from '../scripts/contamination.js';

const paper = 'We propose a method for segmenting medical images with very few labels and show that it beats every baseline on three public datasets.';

test('containment: a copy is 1, an unrelated text is 0', () => {
  assert.equal(containment(paper, paper), 1);
  assert.equal(containment('An entirely different sentence about the weather in spring and autumn.', paper), 0);
  assert.equal(containment('too short', paper), 0);
});

test('checkArm drops what it remembered and what it could not check, and says which', () => {
  const human = new Map([['doc1', paper], ['doc2', 'A human abstract about graphs, trees and the colouring of both of them in linear time.']]);
  const rows = [
    { id: 'raid:gpt4:doc1', text: paper },
    { id: 'raid:gpt4:doc2', text: 'This paper delves into graph colouring and leverages a novel approach for trees and forests alike.' },
    { id: 'raid:gpt4:doc3', text: 'A text whose human document is not in the corpus at all, so nothing can be said about it.' },
  ];
  const { report, clean } = checkArm(rows, human, 'raid-gpt4');
  assert.deepEqual(report.remembered, ['doc1']);
  assert.equal(report.unchecked, 1, 'a text with no human document must not be passed as clean');
  assert.equal(report.compared, 2);
  assert.deepEqual(clean.map((r) => r.id), ['raid:gpt4:doc2']);
});

test('bare ids, as in the generated Claude arm, are matched too', () => {
  const { report } = checkArm([{ id: 'doc1', text: paper }], new Map([['doc1', paper]]), 'raid-claude');
  assert.deepEqual(report.remembered, ['doc1']);
});

test('Reddit post ids resolve to their document like the abstracts do', () => {
  const human = new Map([['0a1b-c2', paper]]);
  const { report } = checkArm([{ id: 'raid:mistral-chat:0a1b-c2', text: paper }], human, 'posts-mistral-chat');
  assert.deepEqual(report.remembered, ['0a1b-c2']);
  assert.equal(report.unchecked, 0);
});

// detectors that say what the test wants, so these tests are about the order and the counting, not
// about src/clean.ts's own rules
const detect: Detectors = {
  truncated: (t) => !/[.!?]$/.test(t.trim()),
  meta: (t) => /^Title:/.test(t),
};
const other = 'An unrelated sentence about sailing boats on a lake, written for this test and nothing else.';

test('cleanArm: dated, then cut off, then not an answer, then remembered, each counted once', () => {
  const human = new Map([['a', paper], ['b', paper], ['c', paper], ['d', paper]]);
  const rows = [
    { id: 'raid:llama-chat:a', text: 'Title: something that also stops' },   // cut off and meta: counted as cut off
    { id: 'raid:llama-chat:b', text: 'Title: a label and then a sentence.' },
    { id: 'raid:llama-chat:c', text: paper },                                // remembered
    { id: 'raid:llama-chat:d', text: other },                                // kept
    { id: 'raid:llama-chat:x', text: other },                                // dated out
  ];
  const { cleaning, clean } = cleanArm(rows, { id: 'raid-llama-chat', writer: 'llama-chat' }, human, new Set(['x']), detect);
  assert.deepEqual(clean.map((r) => r.id), ['raid:llama-chat:d']);
  assert.equal(cleaning.texts, 5);
  assert.equal(cleaning.excluded_by_date, 1);
  assert.equal(cleaning.truncated, 1);
  assert.equal(cleaning.meta, 1);
  assert.equal(cleaning.remembered, 1);
  assert.equal(cleaning.unchecked, 0);
  assert.equal(cleaning.kept, 1);
  assert.equal(cleaning.excluded_by_language, 0);
  assert.equal(cleaning.excluded_by_date + cleaning.excluded_by_language + cleaning.truncated! + cleaning.meta! + cleaning.remembered! + cleaning.kept, cleaning.texts);
  assert.deepEqual(cleaning.dropped, { truncated: ['a'], meta: ['b'], remembered: ['c'] });
});

test('a document is left out of every arm when any writer wrote it in another language', () => {
  // written for the test: the person in English, one model in Turkish-like text, and the reverse
  const english = 'I have been trying to fix this for a week and it is still not working for me.';
  const foreignText = 'Merhaba arkadaşlar, bu konuda yardımınıza ihtiyacım var, teşekkürler herkese.';
  const person = [{ id: 'raid:human:a', text: english }, { id: 'raid:human:b', text: foreignText }, { id: 'raid:human:c', text: english }];
  const model = [{ id: 'raid:gpt4:a', text: foreignText }, { id: 'raid:gpt4:b', text: english }, { id: 'raid:gpt4:c', text: other }];
  const foreign = foreignDocuments([person, model]);
  assert.deepEqual([...foreign].sort(), ['a', 'b']);
  const human = new Map(person.filter((r) => !foreign.has(r.id.slice(-1))).map((r) => [r.id.slice(-1), r.text]));
  const p = cleanArm(person, { id: 'posts-human', writer: 'human' }, human, new Set(), detect, foreign);
  const m = cleanArm(model, { id: 'posts-gpt4', writer: 'gpt4' }, human, new Set(), detect, foreign);
  assert.deepEqual(p.clean.map((r) => r.id), ['raid:human:c'], 'the person loses the documents too');
  assert.deepEqual(m.clean.map((r) => r.id), ['raid:gpt4:c']);
  assert.equal(p.cleaning.excluded_by_language, 2);
  assert.equal(m.cleaning.excluded_by_language, 2);
  assert.equal(m.cleaning.unchecked, 0, 'a document left out is not an unchecked text');
  // a date exclusion is counted first
  const both = cleanArm(model, { id: 'posts-gpt4', writer: 'gpt4' }, human, new Set(['a']), detect, foreign);
  assert.equal(both.cleaning.excluded_by_date, 1);
  assert.equal(both.cleaning.excluded_by_language, 1);
});

test('cleanArm: the model name reaches the truncation check', () => {
  const seen: (string | undefined)[] = [];
  cleanArm([{ id: 'raid:gpt4:a', text: other }], { id: 'posts-gpt4', writer: 'gpt4' }, new Map([['a', paper]]), new Set(),
    { truncated: (_t, m) => { seen.push(m); return false; }, meta: () => false });
  assert.deepEqual(seen, ['gpt4']);
});

test('cleanArm never cuts the person, and still takes the dated documents out', () => {
  const rows = [{ id: 'raid:human:a', text: 'no full stop at the end, which is how people post' }, { id: 'raid:human:x', text: paper }];
  const { cleaning, clean } = cleanArm(rows, { id: 'posts-human', writer: 'human' }, new Map(), new Set(['x']), { truncated: () => true, meta: () => true });
  assert.deepEqual(clean.map((r) => r.id), ['raid:human:a']);
  assert.equal(cleaning.truncated, null);
  assert.equal(cleaning.meta, null);
  assert.equal(cleaning.excluded_by_date, 1);
  assert.equal(cleaning.kept, 1);
});

test('cleanArm reports the Claude arm\'s cut and meta texts without dropping them', () => {
  const human = new Map([['a', paper], ['b', paper]]);
  const rows = [{ id: 'a', text: 'Title: no stop' }, { id: 'b', text: other }];
  const { cleaning, clean } = cleanArm(rows, { id: 'raid-claude', writer: 'claude' }, human, new Set(), detect);
  assert.equal(clean.length, 2);
  assert.equal(cleaning.truncated, null);
  assert.deepEqual(cleaning.reported_only, { truncated: 1, meta: 0 });
});

const generated = (flags: Record<string, boolean>): Generated => ({
  texts: Object.entries(flags).map(([source_id, remembered]) => ({ source_id, text: remembered ? paper : other, remembered_from_the_paper: remembered })),
});

test('a dated document the Claude arm covers does not fail the remembered-flag check', () => {
  const g = generated({ a: true, b: false, x: true });
  const human = new Map([['a', paper], ['b', paper], ['x', paper]]);
  const excluded = new Set(['x']);
  // x is out of every arm, the person's included, before the check runs
  const personLeft = new Map([...human].filter(([id]) => !excluded.has(id)));
  const rows = g.texts.map((t) => ({ id: t.source_id, text: t.text }));
  const { report } = cleanArm(rows, { id: 'raid-claude', writer: 'claude' }, personLeft, excluded, detect);
  assert.equal(report!.unchecked, 0, 'the dated text is gone, not unchecked');
  assert.deepEqual(claudeAgrees(g, report!, excluded), { ok: true, flagged: ['a'], found: ['a'] });
  // without the exclusion the same flags still agree, so the exclusion is what changed the list
  const { report: full } = cleanArm(rows, { id: 'raid-claude', writer: 'claude' }, human, new Set(), detect);
  assert.equal(claudeAgrees(g, full!, new Set()).ok, true);
});

test('the remembered-flag check still fails on a real disagreement or an unchecked text', () => {
  const g = generated({ a: false, b: false });
  const rows = g.texts.map((t) => ({ id: t.source_id, text: paper }));
  const { report } = cleanArm(rows, { id: 'raid-claude', writer: 'claude' }, new Map([['a', paper], ['b', paper]]), new Set(), detect);
  assert.equal(claudeAgrees(g, report!, new Set()).ok, false, 'remembered but not flagged');
  const { report: missing } = cleanArm(rows, { id: 'raid-claude', writer: 'claude' }, new Map([['a', paper]]), new Set(), detect);
  assert.equal(claudeAgrees(generated({ a: true, b: true }), missing!, new Set()).ok, false, 'b has no person to check against');
});

test('arXiv dates: a version inside the window excludes; one after RAID\'s file does not', () => {
  const file: DatesFile = {
    window: { from: DATE_WINDOW[0], to: DATE_WINDOW[1] },
    counts: { unmatched: 2 },
    documents: [
      { source_id: 'in', arxiv_id: '1202.3670', title: 'x', versions: [{ v: 1, date: '2012-02-16' }, { v: 4, date: '2023-07-25' }], excluded: true },
      { source_id: 'after', arxiv_id: '1505.06950', title: 'y', versions: [{ v: 1, date: '2015-05-26' }, { v: 2, date: '2025-01-03' }], excluded: false },
      { source_id: 'old', arxiv_id: '1101.0001', title: 'z', versions: [{ v: 1, date: '2011-01-01' }], excluded: false },
      { source_id: 'edge', arxiv_id: '2211.0001', title: 'w', versions: [{ v: 1, date: '2022-11-30' }] },
      { source_id: 'nomatch', arxiv_id: null, title: 'v', versions: [], excluded: false },
      { source_id: 'elsewhere', arxiv_id: '0001.0001', title: 'u', versions: [{ v: 1, date: '2023-01-01' }], excluded: true },
    ],
  };
  const corpus = new Set(['in', 'after', 'old', 'edge', 'nomatch', 'missing']);
  const d = datedExclusions(file, corpus, new Map());
  assert.deepEqual([...d.excluded].sort(), ['edge', 'in'], 'the window is inclusive, and a document not in the corpus is ignored');
  assert.equal(d.dated, 4);
  assert.equal(d.undated, 2, 'unmatched and absent documents are kept and counted');
  assert.equal(d.unmatched, 1, 'looked up, no paper found');
  assert.equal(d.notLookedUp, 1, 'no entry at all');
  assert.equal(d.complete, false, 'a document without an entry makes the dating partial');
  assert.deepEqual(d.firstPosted, ['2011-01-01', '2022-11-30'], 'the first versions of the dated corpus documents');
  assert.equal(d.unmatchedByLookup, 2);
  assert.deepEqual(d.disagreements, []);
});

test('arXiv dates: a partial lookup excludes what it covers and keeps the rest as not excluded yet', () => {
  const entry = (id: string, date: string, excluded: boolean) => ({ source_id: id, arxiv_id: `x${id}`, title: id, versions: [{ v: 1, date: '2015-01-01' }, { v: 2, date }], excluded });
  const sample: DatesFile = { complete: false, documents: [entry('a', '2023-03-01', true), entry('b', '2019-03-01', false)] };
  const corpus = new Set(['a', 'b', 'c', 'd']);
  const d = datedExclusions(sample, corpus, new Map());
  assert.deepEqual([...d.excluded], ['a']);
  assert.equal(d.notLookedUp, 2);
  assert.equal(d.complete, false);
  // every document looked up, but the file says it is a sample: still partial
  assert.equal(datedExclusions(sample, new Set(['a', 'b']), new Map()).complete, false);
  // a complete file covering the whole corpus
  const whole = datedExclusions({ ...sample, complete: true }, new Set(['a', 'b']), new Map());
  assert.equal(whole.complete, true);
  assert.equal(whole.notLookedUp, 0);
  assert.equal(whole.unmatched, 0);
});

test('arXiv dates: a paper found without its history is kept and counted as not dated', () => {
  const file: DatesFile = { complete: true, documents: [
    { source_id: 'a', arxiv_id: '1202.0001', title: 'a', versions: [], excluded: false },
    { source_id: 'b', arxiv_id: '1202.0002', title: 'b', versions: [{ v: 1, date: '2012-02-16' }], excluded: false },
  ] };
  const d = datedExclusions(file, new Set(['a', 'b']), new Map());
  assert.equal(d.excluded.size, 0);
  assert.equal(d.dated, 1);
  assert.equal(d.unmatched, 1, 'looked up, no versions: reported with the unmatched');
  assert.equal(d.complete, true, 'it was looked up, so the dating is still complete');
  assert.deepEqual(d.firstPosted, ['2012-02-16', '2012-02-16']);
});

test('arXiv dates: a verdict that contradicts its own dates is kept and reported', () => {
  const file: DatesFile = { documents: [{ source_id: 'a', arxiv_id: '1', versions: ['2023-02-01'], excluded: false }] };
  const d = datedExclusions(file, new Set(['a']), new Map());
  assert.equal(d.excluded.size, 0);
  assert.deepEqual(d.disagreements, ['1']);
  assert.deepEqual(d.window, DATE_WINDOW);
});

test('arXiv dates: entries without a source_id are joined by title, whatever the TeX and accents', () => {
  const titles = new Map([['s1', 'Toric K\\"ahler metrics and $\\mathbb{Z}$-graded rings'], ['s2', 'Lovász-Softmax loss']]);
  const file: DatesFile = { documents: [
    { title: 'Toric Kahler Metrics and Z-graded Rings', arxiv_id: '1', versions: ['Tue, 25 Jul 2023 07:21:25 GMT'] },
    { title: 'Lovasz-Softmax Loss', arxiv_id: '2', versions: ['2019-01-01'] },
  ] };
  const d = datedExclusions(file, new Set(['s1', 's2']), titles);
  assert.deepEqual([...d.excluded], ['s1']);
  assert.equal(d.dated, 2);
  assert.equal(titleKey('Lovász-Softmax'), titleKey('lovasz softmax'));
});

test('dayOf reads ISO dates and arXiv\'s RFC 2822 dates, and refuses anything else', () => {
  assert.equal(dayOf('2023-07-25'), '2023-07-25');
  assert.equal(dayOf('2023-07-25T23:59:00Z'), '2023-07-25');
  assert.equal(dayOf('Thu, 16 Feb 2012 19:13:16 GMT'), '2012-02-16');
  assert.throws(() => dayOf('last summer'));
});
