import test from 'node:test';
import assert from 'node:assert/strict';
import { GENRES, MODELS, COMPARISON, NOT_COVERED, genreById, writerById, modelArm } from '../scripts/genres.js';
import { byId } from '../src/markers.js';
import { armsFor, ARMS, cleanFile, genresToRun, flag } from '../scripts/arms.js';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

test('three kinds of writing: two from RAID, and the school essays from a corpus of its own', () => {
  assert.deepEqual(GENRES.map((g) => [g.id, g.raidDomain]),
    [['abstracts', 'abstracts'], ['posts', 'reddit'], ['essays', undefined]]);
});

test('every genre: the person first, and the verdict decided against one of the writers it counts', () => {
  for (const g of GENRES) {
    assert.equal(g.writers[0]!.writer, 'human', `${g.id}: the person comes first`);
    assert.equal(g.writers[0]!.id, g.reference);
    assert.equal(g.writers.filter((w) => w.writer === 'human').length, 1);
    assert.ok(g.writers.some((w) => w.id === g.decider && w.tested), `${g.id}: the decider is a counted writer`);
    if (g.raidDomain) {
      assert.deepEqual(g.writers.filter((w) => w.tested).map((w) => w.writer), MODELS, `${g.id}: the k-of-4 models`);
      assert.equal(modelArm(g, 'gpt4')?.id, g.decider, `${g.id}: GPT-4 is the decider`);
    } else {
      // a kind of writing that is not from RAID has none of RAID's models, and the count runs over the
      // writers it does have: the essays have two, so the page must say "k of 2" and never "k of 4"
      assert.deepEqual(g.writers.filter((w) => w.tested).map((w) => w.id), ['essays-claude-student', 'essays-llama3-student']);
      assert.ok(MODELS.every((m) => modelArm(g, m) === undefined), `${g.id}: no RAID model wrote it`);
    }
  }
});

test('the essays: written here, paired by assignment, and the person never published', () => {
  const essays = genreById.get('essays')!;
  assert.deepEqual(essays.writers.map((w) => w.id),
    ['essays-human', 'essays-claude-student', 'essays-llama3-student', 'essays-claude-plain']);
  assert.deepEqual(essays.writers.map((w) => w.raw), essays.writers.map((w) => w.id));
  // the plain arm describes, as raid-claude does: quotable, published beside the others, not counted
  assert.equal(essays.writers.find((w) => w.id === 'essays-claude-plain')!.tested, false);
  // both Claude columns say so with a star, and the one writer this project did not author is Llama 3
  assert.deepEqual(essays.writers.filter((w) => w.writer === 'claude').map((w) => w.short), ['Claude*', 'Claude plain*']);
  assert.equal(essays.writers.find((w) => w.writer === 'llama3')!.short, 'Llama 3*');
  // two answers to one assignment are not one document written twice, and the pairing says so
  assert.equal(essays.pairing, 'prompt');
  assert.equal(essays.placebo, 'matched');
  assert.equal(essays.documents, 'assignment');
  assert.ok(essays.assignments, 'the assignments the panel opens with are committed');
  assert.equal(essays.humanQuotable, false);
  // nothing is not recorded here: the essays keep their line breaks, so a dash, a list and a heading
  // can all be typed on either side (data/genres/essays/census.json)
  assert.equal(essays.notRecorded, undefined);
  for (const g of GENRES) assert.equal(Boolean(g.pairing), g.id === 'essays', `${g.id}: only the essays pair by assignment`);
});

test('the abstracts keep the arm ids the published data has always used', () => {
  assert.deepEqual(genreById.get('abstracts')!.writers.map((w) => w.id),
    ['raid-human', 'raid-chatgpt', 'raid-gpt4', 'raid-llama-chat', 'raid-mistral-chat', 'raid-claude']);
  assert.deepEqual(genreById.get('abstracts')!.writers.map((w) => w.raw),
    ['raid-human', 'raid-chatgpt', 'raid-gpt4', 'raid-llama-chat', 'raid-mistral-chat', 'raid-claude']);
});

test('Reddit posts: the arm ids and the collector\'s file names', () => {
  const posts = genreById.get('posts')!;
  assert.deepEqual(posts.writers.map((w) => w.id), ['posts-human', 'posts-chatgpt', 'posts-gpt4', 'posts-llama-chat', 'posts-mistral-chat']);
  assert.deepEqual(posts.writers.map((w) => w.raw), posts.writers.map((w) => w.id));
  assert.equal(posts.writers.some((w) => w.writer === 'claude'), false, 'the Claude arm is abstracts only');
});

test('a person\'s text is quotable only in the abstracts, and a Reddit title is never shown', () => {
  for (const g of GENRES) {
    assert.equal(g.humanQuotable, g.id === 'abstracts');
    assert.equal(g.writers[0]!.quotable, g.humanQuotable, `${g.id}: the person's arm follows the genre`);
    assert.ok(g.writers.filter((w) => w.writer !== 'human').every((w) => w.quotable), `${g.id}: RAID's model text is MIT`);
  }
  assert.equal(genreById.get('posts')!.titles, 'hide');
  assert.equal(genreById.get('abstracts')!.titles, 'show');
  assert.equal(genreById.get('essays')!.titles, 'hide', 'a school essay has no title, so none is shown');
  // a hidden title is still read, from out/, to keep a model's text that repeats it off the page; the
  // essays have no titles at all, so there is no file and nothing for the guard to read
  for (const g of GENRES) assert.equal(Boolean(g.hiddenTitles), g.titles === 'hide' && g.id !== 'essays', g.id);
  assert.ok(COMPARISON.every((c) => c.quotable === false));
});

test('every genre says where its people come from, why they predate ChatGPT, and under what licence', () => {
  for (const g of GENRES) {
    for (const k of ['humanUrl', 'datesUrl', 'licenceUrl'] as const) assert.match(g.source[k], /^https:\/\//, `${g.id}.${k}`);
    for (const k of ['human', 'dates', 'licence', 'people'] as const) assert.ok(g.source[k].length > 5, `${g.id}.${k}`);
  }
  assert.ok(genreById.get('abstracts')!.datesFile, 'the abstracts are dated by arXiv versions');
});

test('ids and files are unique across genres; the comparison arms are shared', () => {
  const ids = GENRES.flatMap((g) => g.writers.map((w) => w.id));
  assert.equal(new Set(ids).size, ids.length);
  const raws = GENRES.flatMap((g) => g.writers.map((w) => w.raw));
  assert.equal(new Set(raws).size, raws.length);
  for (const g of GENRES) {
    const arms = armsFor(g);
    assert.deepEqual(arms.slice(-3).map((a) => a.id), ['casual-human', 'careful-human', 'hc3-gpt35']);
    // the person is measured from the dated file too, the comparison arms from their own files
    assert.deepEqual(arms.slice(0, -3).map((a) => a.file), g.writers.map((w) => cleanFile(w.raw)));
  }
  assert.equal(ARMS.length, ids.length + 3);
  assert.equal(writerById('posts-gpt4')?.genre.id, 'posts');
  assert.equal(writerById('casual-human'), null);
});

test('flat Reddit posts cannot show a list or a heading, and say so; the abstracts record everything', () => {
  const posts = genreById.get('posts')!;
  assert.deepEqual(Object.keys(posts.notRecorded ?? {}).sort(), ['bulleted_bold', 'title_case_headings']);
  for (const [id, why] of Object.entries(posts.notRecorded!)) {
    assert.ok(byId.has(id), `${id} is a marker`);
    assert.match(why, /flat text/);
  }
  assert.equal(genreById.get('abstracts')!.notRecorded, undefined);
  // no year is claimed for the dated papers: the lookup says what it found
  assert.doesNotMatch(genreById.get('abstracts')!.source.dates + genreById.get('abstracts')!.source.people, /first posted|checked sample/);
});

test('the gaps are named', () => {
  for (const gap of ['email', 'chat', 'product reviews', 'X', 'Facebook', 'LinkedIn']) assert.ok(NOT_COVERED.includes(gap), gap);
  assert.ok(!GENRES.some((g) => /poetry|recipe/i.test(g.id + g.label)));
});

test('genresToRun: collected genres run, abstracts are required, a named genre must exist', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'genres-'));
  const argv = (...a: string[]): string[] => ['node', 'script.ts', ...a];
  assert.deepEqual(genresToRun(argv(), dir), { genres: [], missing: ['abstracts'] });
  writeFileSync(path.join(dir, 'raid-human.json'), '[]');
  assert.deepEqual(genresToRun(argv(), dir).genres.map((g) => g.id), ['abstracts'], 'posts not collected: skipped, not failed');
  assert.deepEqual(genresToRun(argv('--genres', 'abstracts,posts'), dir).missing, ['posts'], 'named: required');
  writeFileSync(path.join(dir, 'posts-human.json'), '[]');
  assert.deepEqual(genresToRun(argv(), dir).genres.map((g) => g.id), ['abstracts', 'posts']);
  assert.deepEqual(genresToRun(argv('--genres', 'posts,essays'), dir), { genres: [genreById.get('posts')!], missing: ['essays'] });
  assert.equal(flag('--data', argv('--data', 'x')), 'x');
});
