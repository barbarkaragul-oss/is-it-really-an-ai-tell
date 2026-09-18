import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  MACHINE_ARMS, MIN_HUMAN_CELL, PROTOCOL_VERSION, SEED, SLOTS_PER_ARM, TEMPLATES, allocate, armById, assignmentEcho,
  containedInCorpus, humanCorpusFrom, memorisationOf, mergeToDisk, problemsWith, promptFor, readAssignments, readFrame,
  recordFor, sha256, slugify, worklistFor, worklistFiles, type GeneratedFile, type MachineArm, type SlotFile,
} from '../scripts/generate-essays.js';
import {
  COLUMNS, GENRE, PROMPTS, compare, frame, isPlaceholder, measuredText, readCsv, splitPlaceholder,
  stripPlaceholders, whitespaceWords, type Corpus, type Essay, type Frame as HumanFrame,
} from '../scripts/collect-essays.js';
import { binOfWords } from '../src/measure.js';
import { words as markerWords } from '../src/markers.js';
import { GENRES } from '../scripts/genres.js';

/**
 * A sentence no assignment and no prompt could contain, planted in the human side of every fixture.
 * If it is ever found in a prompt, a work list or a committed record, a person's essay has reached
 * the machine side, which is the one thing this genre may not do.
 */
const HUMAN_SENTENCE = 'The wombat in my grandmother\'s greenhouse ate every single tomato on a Tuesday in April.';

const ASSIGNMENTS = {
  prompts: [
    {
      slug: 'distance-learning', name: 'Distance learning',
      assignment: 'Some schools offer distance learning as an option for pupils to attend classes from home by '
        + 'online or video conferencing. Take a position on whether pupils would benefit from attending their '
        + 'classes from home, and support your position with reasons and examples of your own.',
    },
    {
      slug: 'cell-phones-at-school', name: 'Cell phones at school',
      assignment: 'Your principal is considering letting pupils carry a phone during lunch and other free times, '
        + 'as long as it is switched off in lessons. Write a letter to your principal arguing for or against that '
        + 'policy, and support your argument with reasons and examples of your own.',
    },
  ],
};

/** a frame of the shape the human side writes: a row per essay, cells of known sizes, and no text */
function frameRows(cells: { prompt: string; grade: number; n: number }[], extra: Record<string, unknown> = {}): { essays: unknown[] } {
  const essays: unknown[] = [];
  for (const c of cells) {
    for (let i = 0; i < c.n; i++) {
      essays.push({ id: `${c.prompt}-${c.grade}-${i}`, prompt: c.prompt, grade: c.grade, words: 200 + i, bin: 1, sha256: sha256(`${c.prompt}${c.grade}${i}`), ...extra });
    }
  }
  return { essays };
}

const CELLS = [
  { prompt: 'distance-learning', grade: 8, n: 120 },
  { prompt: 'distance-learning', grade: 11, n: 40 },
  { prompt: 'cell-phones-at-school', grade: 8, n: 60 },
  // below MIN_HUMAN_CELL: no machine essay may be asked for it
  { prompt: 'cell-phones-at-school', grade: 12, n: 7 },
];

/** a fixture on disk: the two files the human side of this genre writes, and nowhere for text to hide */
function fixture(cells = CELLS, extra: Record<string, unknown> = {}): { dir: string; frame: string; assignments: string } {
  const dir = mkdtempSync(path.join(tmpdir(), 'essays-'));
  const frame = path.join(dir, 'frame.json');
  const assignments = path.join(dir, 'assignments.json');
  writeFileSync(frame, JSON.stringify(frameRows(cells, extra)));
  writeFileSync(assignments, JSON.stringify(ASSIGNMENTS));
  return { dir, frame, assignments };
}

function worklist(cells = CELLS, opts: { slots?: number; arms?: MachineArm[] } = {}): ReturnType<typeof worklistFor> {
  const f = fixture(cells);
  return worklistFor(readFrame(f.frame), readAssignments(f.assignments), opts);
}

const answer = (slot: { id: string; arm: string }, text: string): SlotFile => ({
  slot: slot.id, arm: slot.arm, text,
  model: armById.get(slot.arm)!.model, harness: armById.get(slot.arm)!.harness,
  generated_at: '2026-09-17T12:00:00.000Z', context_id: `test:${slot.id}`,
});

/** an essay of about the right size, written for the test and with nothing of any corpus in it */
const essay = (n: number): string => `I think this matters for three reasons, and the first one is number ${n}. `
  + 'When people are given a choice they take the one that suits the day they are having, and that is the whole argument in a sentence. '
  .repeat(6);

// ---- what is asked

test('a slot\'s prompt is the template with that cell\'s values, and nothing else', () => {
  const { slots } = worklist();
  const student = slots.find((s) => s.arm === 'essays-claude-student' && s.grade === 11)!;
  const assignment = ASSIGNMENTS.prompts.find((p) => p.name === student.prompt)!.assignment;
  // written out rather than rebuilt from TEMPLATES: a test that substitutes into the template the same
  // way the code does passes whatever the template becomes, and the prompt is the protocol here
  assert.equal(promptFor(student),
    'You are a student in grade 11 at a school in the United States. Your teacher\n'
    + 'has given the class this assignment:\n\n'
    + `${assignment}\n\n`
    + 'Write your essay and hand it in. It is one draft, written in class, not revised.\n'
    + 'Return only the essay itself, with nothing before or after it.');

  const plain = slots.find((s) => s.arm === 'essays-claude-plain')!;
  const plainAssignment = ASSIGNMENTS.prompts.find((p) => p.name === plain.prompt)!.assignment;
  assert.equal(promptFor(plain), `${plainAssignment}\n\nWrite the essay. Return only the essay itself, with nothing before or after it.`);
  // the plain arm is the same assignment with the framing removed: nothing about who is writing or how
  assert.equal(promptFor(plain).replace(plainAssignment, '').trim(), 'Write the essay. Return only the essay itself, with nothing before or after it.');
  assert.doesNotMatch(promptFor(plain).replace(plainAssignment, ''), /grade|draft|hand it in/i);
  // nothing anywhere tells a writer how long to write, which is why length can be measured at all
  for (const s of slots) assert.doesNotMatch(promptFor(s), /\bwords?\b|\bparagraphs?\b|\bsentences\b|\blength\b/i);
});

test('an assignment carrying a dollar sign reaches the writer as the corpus has it', () => {
  const { slots } = worklist();
  // $&, $` and $1 are replacement patterns: a string replacement would expand them and quietly send,
  // and commit, an assignment the teacher never set
  const tricky = { ...slots[0]!, assignment: 'Some schools spend $5 a pupil. Is $& of it, or $1 of it, well spent? Take a position.' };
  assert.ok(promptFor(tricky).includes(tricky.assignment), 'the assignment was mangled on its way into the prompt');
});

test('both templates are used, and the two Claude arms differ only in the framing', () => {
  assert.deepEqual([...new Set(MACHINE_ARMS.map((a) => a.template))].sort(), ['plain', 'student']);
  const { slots } = worklist();
  const cell = (arm: string): string => slots.filter((s) => s.arm === arm).map((s) => `${s.prompt} ${s.grade}`).sort().join('|');
  assert.equal(cell('essays-claude-student'), cell('essays-claude-plain'), 'the same cells, so the framing is the only difference');
  assert.equal(cell('essays-claude-student'), cell('essays-llama3-student'), 'and the same cells for the second writer');
});

test('the genre has two tested writers, and the plain arm is not one of them', () => {
  assert.deepEqual(MACHINE_ARMS.map((a) => a.id), ['essays-claude-student', 'essays-llama3-student', 'essays-claude-plain']);
  assert.deepEqual([...new Set(MACHINE_ARMS.map((a) => a.writer))], ['claude', 'llama3']);
  const essays = GENRES.find((g) => g.id === ('essays' as string));
  if (essays) {
    // once scripts/genres.ts has the genre, the arms it publishes and the arms written here must agree
    const ids = new Set(essays.writers.map((w) => w.id));
    for (const a of MACHINE_ARMS) assert.ok(ids.has(a.id), `${a.id} is missing from the genre registry`);
    assert.deepEqual(essays.writers.filter((w) => w.tested).map((w) => w.id).sort(), ['essays-claude-student', 'essays-llama3-student']);
  }
});

// ---- no human text, anywhere

test('a frame that carries a person\'s essay fails the run instead of reaching a prompt', () => {
  for (const extra of [{ text: HUMAN_SENTENCE }, { full_text: HUMAN_SENTENCE }, { note: HUMAN_SENTENCE.repeat(4) }]) {
    const f = fixture(CELLS, extra);
    assert.throws(() => readFrame(f.frame), /must not hold any essay text/);
    // the error says which field and how long, never what it said
    try { readFrame(f.frame); } catch (e) { assert.doesNotMatch(String(e), /wombat/); }
  }
});

test('nothing a person wrote can reach a prompt, a work list or a record', () => {
  // a short field the length guard lets through: it still must not travel, because nothing reads it
  const f = fixture(CELLS, { title: HUMAN_SENTENCE.slice(0, 60) });
  const frame = readFrame(f.frame);
  const assignments = readAssignments(f.assignments);
  const { allocation, slots } = worklistFor(frame, assignments);
  const { listed, full } = worklistFiles(allocation, slots);
  const everything = [
    ...slots.map(promptFor),
    JSON.stringify(listed), JSON.stringify(full),
    JSON.stringify(slots.map((s) => recordFor(s, answer(s, essay(1))))),
  ].join('\n');
  assert.equal(everything.includes('wombat'), false, 'a person\'s sentence reached the machine side');
  assert.equal(everything.includes('greenhouse'), false);
  // the only corpus text in a prompt is the teacher's, and it is there in full
  for (const p of ASSIGNMENTS.prompts) assert.ok(slots.some((s) => promptFor(s).includes(p.assignment)));
});

test('the committed work list carries no text at all', () => {
  const { allocation, slots } = worklist();
  const { listed } = worklistFiles(allocation, slots);
  const rows = (listed as { slots: Record<string, unknown>[] }).slots;
  for (const row of rows) assert.deepEqual(Object.keys(row).sort(), ['arm', 'grade', 'id', 'prompt']);
  assert.equal(JSON.stringify(listed).includes('Take a position'), false, 'even the assignment stays out of the committed list');
  // the copy in out/ is the one a runner reads, and it carries the exact prompt
  const { full } = worklistFiles(allocation, slots);
  assert.equal((full as { slots: { prompt_text: string }[] }).slots[0]!.prompt_text, promptFor(slots[0]!));
});

// ---- which essays, and how many

test('the slots follow the people\'s cells, and a cell the people barely fill gets none', () => {
  const f = fixture();
  // allocate() reads the frame as it is written; the assignment names are resolved by worklistFor
  const alloc = allocate(readFrame(f.frame), 200);
  assert.deepEqual(alloc.cells.map((c) => [c.prompt, c.grade, c.human, c.slots]), [
    ['cell-phones-at-school', 8, 60, 55],
    ['distance-learning', 8, 120, 109],
    ['distance-learning', 11, 40, 36],
  ]);
  // and the slots carry the name the page uses, whichever of the two the frame writes
  assert.deepEqual([...new Set(worklistFor(readFrame(f.frame), readAssignments(f.assignments)).slots.map((s) => s.prompt))].sort(),
    ['Cell phones at school', 'Distance learning']);
  assert.equal(alloc.cells.reduce((n, c) => n + c.slots, 0), 200, 'every slot is allocated');
  assert.deepEqual(alloc.skipped_cells.map((c) => [c.prompt, c.grade, c.human]), [['cell-phones-at-school', 12, 7]]);
  assert.match(alloc.skipped_cells[0]!.reason, new RegExp(`fewer than ${MIN_HUMAN_CELL}`));
  // proportional: each cell's share of the slots is its share of the people's essays, to within a slot
  for (const c of alloc.cells) assert.ok(Math.abs(c.slots - c.share * 200) <= 1, `${c.prompt} ${c.grade}`);
});

test('a cell exactly at the minimum is used, one below it is not', () => {
  const cells = [{ prompt: 'distance-learning', grade: 8, n: 100 }, { prompt: 'distance-learning', grade: 11, n: MIN_HUMAN_CELL }, { prompt: 'cell-phones-at-school', grade: 8, n: MIN_HUMAN_CELL - 1 }];
  const f = fixture(cells);
  const alloc = allocate(readFrame(f.frame), 200);
  assert.deepEqual(alloc.cells.map((c) => c.human), [100, MIN_HUMAN_CELL]);
  assert.deepEqual(alloc.skipped_cells.map((c) => c.human), [MIN_HUMAN_CELL - 1]);
});

test('every arm is asked for the same number of essays, 200 of them in a real run', () => {
  const { slots } = worklist();
  for (const a of MACHINE_ARMS) assert.equal(slots.filter((s) => s.arm === a.id).length, SLOTS_PER_ARM);
  assert.equal(slots.length, SLOTS_PER_ARM * MACHINE_ARMS.length);
});

test('slot ids are unique, readable, and the same on a second run', () => {
  const first = worklist().slots;
  const second = worklist().slots;
  assert.deepEqual(first.map((s) => s.id), second.map((s) => s.id), 'the ids are a function of the frame and the seed');
  assert.deepEqual(first.map((s) => s.index), second.map((s) => s.index), 'and so is the generation order');
  assert.equal(new Set(first.map((s) => s.id)).size, first.length);
  for (const s of first) {
    assert.match(s.id, /^[a-z0-9.-]+$/, 'a slot id is also a file name');
    assert.equal(s.id, `${s.arm}.${slugify(s.prompt)}.g${s.grade}.${String(Number(s.id.slice(-3))).padStart(3, '0')}`);
  }
  // the order is shuffled, not the file's: a run that stops halfway still covers every cell
  assert.notDeepEqual(first.map((s) => s.id), [...first].map((s) => s.id).sort());
  assert.deepEqual(
    first.filter((s) => s.arm === 'essays-claude-student').map((s) => `${s.prompt} ${s.grade}`),
    first.filter((s) => s.arm === 'essays-llama3-student').map((s) => `${s.prompt} ${s.grade}`),
    'the arms are shuffled together, so a stopped run leaves them matched',
  );
});

test('the work list is drawn at the repository\'s own seed', () => {
  const src = readFileSync(path.join(process.cwd(), 'src', 'measure.ts'), 'utf8');
  assert.match(src, new RegExp(`DEFAULT_SEED\\s*=\\s*${SEED}\\b`), 'src/measure.ts and SEED here have parted company');
});

// ---- what comes back

test('a returned essay becomes a record with its prompt, its hashes and its settings', () => {
  const { slots } = worklist();
  const slot = slots[0]!;
  const text = essay(7);
  const record = recordFor(slot, answer(slot, text));
  assert.equal(record.prompt_text, promptFor(slot));
  assert.equal(record.prompt_sha256, sha256(promptFor(slot)));
  assert.equal(record.text_sha256, sha256(text.trim()));
  assert.equal(record.protocol_version, PROTOCOL_VERSION);
  assert.equal(record.settings, 'not exposed by the harness', 'Claude Code exposes none, and the record says so');
  assert.equal(record.generated_at, '2026-09-17T12:00:00.000Z', 'the time comes from the run, never from the merge');
  assert.equal(record.grade, slot.grade);
  assert.ok(record.words > 50);
});

test('an empty answer, a wrong prompt, a wrong hash and a copied assignment are each caught', () => {
  const { slots } = worklist();
  const slot = slots.find((s) => s.arm === 'essays-claude-student')!;
  const ok = answer(slot, essay(1));
  assert.deepEqual(problemsWith(slot, ok), []);
  assert.match(problemsWith(slot, { ...ok, text: '' })[0]!, /empty/);
  assert.match(problemsWith(slot, { ...ok, text: 'Three words only.' })[0]!, /too short/);
  assert.match(problemsWith(slot, { ...ok, prompt: 'write me an essay' })[0]!, /not the template/);
  assert.match(problemsWith(slot, { ...ok, text_sha256: sha256('something else') })[0]!, /hash/);
  assert.match(problemsWith(slot, { ...ok, generated_at: '' })[0]!, /generated_at/);
  assert.match(problemsWith(slot, { ...ok, context_id: '' })[0]!, /context_id/);
  assert.match(problemsWith(slot, { ...ok, error: 'no essay after 3 attempts' })[0]!, /error/);
  // the assignment pasted into the essay: rejected, because every marker would count it as the writer's
  const copied = answer(slot, `${slot.assignment} ${essay(2)}`);
  assert.match(problemsWith(slot, copied)[0]!, /characters of the assignment are in the essay/);
  // a phrase of the assignment, as any writer answering it would write: measured, not rejected
  const echoed = answer(slot, `I am writing about ${slot.assignment.slice(20, 70)} and here is why. ${essay(3)}`);
  assert.deepEqual(problemsWith(slot, echoed), []);
  assert.ok(problemsWith(slot, echoed, { strictEcho: true }).length, '--strict-echo applies the stricter rule');
  const echo = recordFor(slot, echoed).assignment_echo;
  assert.ok(echo && echo.longest >= 40, 'and the echo is published with the essay');
});

test('assignmentEcho measures the longest run, not the first one it finds', () => {
  const assignment = 'Write a letter to your principal arguing for or against phones at lunch.';
  assert.equal(assignmentEcho('Nothing here is shared with that sentence at all, not one clause of it.', assignment), null);
  const echo = assignmentEcho(`Dear Principal, I am writing a letter to your principal arguing for or against phones at lunch, and here is why.`, assignment);
  assert.ok(echo && echo.longest >= 60, `expected a long run, got ${JSON.stringify(echo)}`);
});

// ---- the memorisation check

test('memorisation: a remembered essay shows as containment, an original one does not', () => {
  const { slots } = worklist();
  const remembered = 'Pupils should be allowed to keep their phones in their lockers during the school day, because a phone '
    + 'that is out of sight is not a distraction, and a pupil who is unwell can still ring home without walking to the office.';
  const corpus = humanCorpusFrom([remembered, 'An unrelated essay about the school garden and the people who water it every morning before class.']);
  assert.equal(containedInCorpus(remembered, corpus), 1);
  assert.ok(containedInCorpus(essay(4), corpus) < 0.05);
  const records = [recordFor(slots[0]!, answer(slots[0]!, remembered)), recordFor(slots[1]!, answer(slots[1]!, essay(5)))];
  const memo = memorisationOf(records, corpus);
  const arm = memo[slots[0]!.arm]!;
  assert.equal(arm.essays, 2);
  assert.equal(arm.max, 1);
  assert.equal(arm.above_20_percent, 1);
  assert.equal(arm.worst[0]!.slot, records[0]!.slot);
});

// ---- the merge

/** a work list, a slot directory and a data directory: what a driver leaves behind between runs */
function bench(written: number, cells = CELLS): { slots: ReturnType<typeof worklistFor>['slots']; arms: MachineArm[]; root: string; slotDir: string } {
  const { slots } = worklistFor(readFrame(fixture(cells).frame), readAssignments(fixture(cells).assignments), { slots: 4, arms: [armById.get('essays-llama3-student')!] });
  const dir = mkdtempSync(path.join(tmpdir(), 'essays-run-'));
  const slotDir = path.join(dir, 'gen');
  mkdirSync(slotDir, { recursive: true });
  slots.slice(0, written).forEach((s, i) => writeFileSync(path.join(slotDir, `${s.id}.json`), JSON.stringify(answer(s, essay(i)))));
  return { slots, arms: [armById.get('essays-llama3-student')!], root: path.join(dir, 'data'), slotDir };
}

test('merging twice writes the same files, and the second run writes nothing', () => {
  const b = bench(2);
  const first = mergeToDisk(b);
  assert.equal(first.report.merged, 2);
  assert.ok(first.written.length, 'the first merge writes the files');
  const files = first.written.map((f) => readFileSync(f, 'utf8'));
  const second = mergeToDisk(b);
  assert.deepEqual(second.written, [], 'nothing changed, so nothing is written');
  assert.equal(second.report.merged, 0);
  assert.equal(second.report.kept, 2, 'the committed records are kept as they are');
  assert.deepEqual(first.written.map((f) => readFileSync(f, 'utf8')), files);
});

test('a missing slot is reported as missing and never invented', () => {
  const b = bench(1);
  const { report } = mergeToDisk(b);
  assert.equal(report.merged, 1);
  assert.deepEqual(report.missing, b.slots.slice(1).map((s) => s.id));
  const file = path.join(b.root, 'generated/llama3-essays', `${b.slots[0]!.slug}.json`);
  const committed = JSON.parse(readFileSync(file, 'utf8')) as GeneratedFile;
  assert.deepEqual(committed.essays.map((e) => e.slot), [b.slots[0]!.id]);
  // the files say how many were asked for as well as how many exist, so the gap is visible in the data
  const dir = path.join(b.root, 'generated/llama3-essays');
  const asked = b.slots.map((s) => s.slug).filter((v, i, xs) => xs.indexOf(v) === i)
    .map((slug) => JSON.parse(readFileSync(path.join(dir, `${slug}.json`), 'utf8')) as GeneratedFile)
    .map((f) => f.summary.arms['essays-llama3-student']!);
  assert.equal(asked.reduce((n, a) => n + a.asked, 0), b.slots.length);
  assert.equal(asked.reduce((n, a) => n + a.written, 0), 1);
  for (const e of committed.essays) assert.ok(e.text.length > 0);
});

test('a rejected slot is named with its reason and does not reach the committed file', () => {
  const b = bench(0);
  const slot = b.slots[0]!;
  writeFileSync(path.join(b.slotDir, `${slot.id}.json`), JSON.stringify({ ...answer(slot, ''), error: 'no essay after 3 attempts' }));
  const { report } = mergeToDisk(b);
  assert.equal(report.merged, 0);
  assert.equal(report.rejected.length, 1);
  assert.equal(report.rejected[0]!.slot, slot.id);
  assert.ok(report.rejected[0]!.reasons.some((r) => /error/.test(r)));
  const file = path.join(b.root, 'generated/llama3-essays', `${slot.slug}.json`);
  const committed = JSON.parse(readFileSync(file, 'utf8')) as GeneratedFile;
  assert.deepEqual(committed.essays, []);
  assert.deepEqual(committed.summary.rejected.map((r) => r.slot), [slot.id]);
});

test('a committed essay is never rewritten by a later run of the same slot unless asked', () => {
  const b = bench(1);
  mergeToDisk(b);
  const slot = b.slots[0]!;
  writeFileSync(path.join(b.slotDir, `${slot.id}.json`), JSON.stringify(answer(slot, essay(99))));
  const again = mergeToDisk(b);
  assert.deepEqual(again.report.conflicts, [slot.id], 'a different text for a committed slot is reported');
  const file = path.join(b.root, 'generated/llama3-essays', `${slot.slug}.json`);
  assert.ok(!(JSON.parse(readFileSync(file, 'utf8')) as GeneratedFile).essays[0]!.text.includes('number 99'));
  mergeToDisk({ ...b, replace: true });
  assert.ok((JSON.parse(readFileSync(file, 'utf8')) as GeneratedFile).essays[0]!.text.includes('number 99'));
});

test('two essays written in one context are rejected, and neither reaches the committed file', () => {
  const b = bench(0);
  const [one, two] = [b.slots[0]!, b.slots[1]!];
  // a runner that writes a batch in one conversation and stamps one id on all of it: every slot file
  // passes on its own, and only a check across the arm can see it
  for (const s of [one, two]) writeFileSync(path.join(b.slotDir, `${s.id}.json`), JSON.stringify({ ...answer(s, essay(1)), context_id: 'one conversation, two essays' }));
  const { report } = mergeToDisk(b);
  assert.equal(report.merged, 0, 'neither essay is merged');
  assert.deepEqual(report.sharedContexts.map((c) => c.slots), [[one.id, two.id].sort()]);
  assert.deepEqual(report.rejected.map((r) => r.slot).sort(), [one.id, two.id].sort());
  for (const r of report.rejected) assert.match(r.reasons.join(' '), /one essay per context/);
  const dir = path.join(b.root, 'generated/llama3-essays');
  const committed = [...new Set(b.slots.map((s) => s.slug))]
    .flatMap((slug) => (JSON.parse(readFileSync(path.join(dir, `${slug}.json`), 'utf8')) as GeneratedFile).essays);
  assert.deepEqual(committed.map((e) => e.slot), []);
  // a context of its own for each essay, which is what the runners write, merges as usual
  for (const s of [one, two]) writeFileSync(path.join(b.slotDir, `${s.id}.json`), JSON.stringify(answer(s, essay(2))));
  const again = mergeToDisk(b);
  assert.deepEqual(again.report.sharedContexts, []);
  assert.equal(again.report.merged, 2);
});

test('merging one arm leaves the other arm of the same directory in the summary and the manifest', () => {
  // the two Claude arms share data/generated/claude-essays: a run of one of them rewrites the file the
  // other's essays are in, and the file must not come back saying that arm has none
  const f = fixture();
  const both = [armById.get('essays-claude-student')!, armById.get('essays-claude-plain')!];
  const { slots } = worklistFor(readFrame(f.frame), readAssignments(f.assignments), { slots: 2, arms: both });
  const dir = mkdtempSync(path.join(tmpdir(), 'essays-two-'));
  const slotDir = path.join(dir, 'gen');
  mkdirSync(slotDir, { recursive: true });
  for (const s of slots) writeFileSync(path.join(slotDir, `${s.id}.json`), JSON.stringify(answer(s, essay(3))));
  const root = path.join(dir, 'data');
  mergeToDisk({ arms: both, slots, root, slotDir });
  // now merge the decider alone, as --arms essays-claude-student would
  const alone = both.slice(0, 1);
  mergeToDisk({ arms: alone, slots: slots.filter((s) => s.arm === alone[0]!.id), root, slotDir });
  const generated = path.join(root, 'generated/claude-essays');
  for (const slug of [...new Set(slots.map((s) => s.slug))]) {
    const file = JSON.parse(readFileSync(path.join(generated, `${slug}.json`), 'utf8')) as GeneratedFile;
    const plain = file.summary.arms['essays-claude-plain'];
    assert.ok(plain, `${slug}.json lost the plain arm from its summary`);
    assert.equal(plain.written, file.essays.filter((e) => e.arm === 'essays-claude-plain').length);
    assert.ok(plain.asked > 0, 'and it keeps the number the run that asked for it recorded');
  }
  const manifest = JSON.parse(readFileSync(path.join(generated, 'manifest.json'), 'utf8')) as { arms: { id: string; essays: number }[] };
  assert.deepEqual(manifest.arms.map((a) => a.id).sort(), ['essays-claude-plain', 'essays-claude-student']);
});

test('the merged file carries the licence of the assignment it quotes, and the manifest the templates', () => {
  const b = bench(2);
  mergeToDisk(b);
  const dir = path.join(b.root, 'generated/llama3-essays');
  const file = JSON.parse(readFileSync(path.join(dir, `${b.slots[0]!.slug}.json`), 'utf8')) as GeneratedFile;
  assert.match(file.licence, /CC BY-NC-SA 4\.0/);
  assert.equal(file.assignment_sha256, sha256(file.assignment));
  assert.equal(file.assignment, b.slots[0]!.assignment);
  const manifest = JSON.parse(readFileSync(path.join(dir, 'manifest.json'), 'utf8')) as { templates: Record<string, string>; arms: { id: string }[] };
  assert.deepEqual(manifest.templates, TEMPLATES);
  assert.deepEqual(manifest.arms.map((a) => a.id), ['essays-llama3-student']);
});

test('a dry run reports what would be written and writes nothing', () => {
  const b = bench(2);
  const { written } = mergeToDisk({ ...b, dryRun: true });
  assert.ok(written.length);
  for (const f of written) assert.equal(existsSync(f), false, `${f} was written on a dry run`);
});

test('a failure written for a slot that is already committed is reported, not a crash', () => {
  const b = bench(1);
  mergeToDisk(b);
  const slot = b.slots[0]!;
  // a slot file with no text at all: what the llama runner writes when it gives up, for a slot a
  // previous run already committed
  writeFileSync(path.join(b.slotDir, `${slot.id}.json`), JSON.stringify({ slot: slot.id, arm: slot.arm, error: 'no essay after 3 attempts' }));
  const again = mergeToDisk(b);
  assert.deepEqual(again.report.conflicts, [slot.id]);
  assert.equal(again.report.kept, 1, 'the committed essay stands');
});

// ---- the people's side: reading the corpus, taking its placeholders out, and re-reading it

/** one row of the mirror: the 17 pinned columns, with only the few this project reads worth setting */
const corpusRow = (over: Partial<Record<(typeof COLUMNS)[number], string>>): Record<string, string> => ({
  essay_id_comp: 'E1', full_text: '', holistic_essay_score: '3', word_count: '0',
  prompt_name: 'Distance learning', task: 'Independent', assignment: 'Take a position on distance learning.',
  source_text: '', gender: 'M', grade_level: '8.0', ell_status: 'No', race_ethnicity: '',
  economically_disadvantaged: '', student_disability_status: '', prompt_url: '', gpt4_summary: '', scoring_rubric_url: '',
  ...over,
});

const csvCell = (s: string): string => (/["\n,]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s);
const csvOf = (rows: Record<string, string>[]): Uint8Array => new TextEncoder().encode(
  [[...COLUMNS], ...rows.map((r) => COLUMNS.map((c) => r[c] ?? ''))].map((cells) => cells.map(csvCell).join(',')).join('\n') + '\n',
);

/** an essay long enough for the filter to keep, with a placeholder where the corpus took a name out */
const studentEssay = (n: number): string =>
  `Dear Generic_Name, I think pupils should be allowed to learn at home one day a week, and here is reason ${n}. `
  + 'A pupil working at home has a quiet room, no bus to catch and no bell to run for, and that is worth a great deal to some of us. '.repeat(4);

type CorpusRow = Parameters<Parameters<typeof readCsv>[1]>[0];

/** what collect() returns, built from rows a test wrote, so the frame and the re-read can be run here */
function corpusOf(rows: CorpusRow[]): Corpus {
  const essays: Essay[] = rows.map((r, i) => {
    const { text, placeholders } = measuredText(r.full_text);
    const slug = PROMPTS.find((p) => p.name === r.prompt_name)!.slug;
    const binWords = markerWords(text).length;
    // the two providers alternate so that a frame written here has a provider split to publish and a
    // re-read has a provider to disagree about
    return {
      id: `${GENRE}:${slug}:${r.essay_id_comp}`, prompt: slug, name: r.prompt_name, grade: Number(r.grade_level),
      provider: i % 2 ? 'NCES' : 'Virginia', text,
      words: whitespaceWords(text), binWords, bin: binOfWords(binWords), sha256: sha256(text), placeholders,
    };
  });
  return {
    files: [{ name: 'train.csv', url: 'https://example.invalid/train.csv', bytes: 10, sha256: sha256('train.csv'), rows: rows.length }],
    rows: rows.length,
    steps: [
      { step: 'independent', rule: 'a fixture: every row is kept', kept: rows.length, dropped: 0 },
      { step: 'kaggle-2021', rule: 'a fixture: every row is on the 2021 release list, and one more essay is not', kept: rows.length, dropped: 1 },
    ],
    essays,
    kaggle: {
      file: 'data/genres/essays/kaggle-2021.json', note: 'a fixture', key: 'first 16 hex of the SHA-256 of full_text',
      listed: rows.length + 1, providers: { Virginia: rows.length, NCES: 1 },
    },
    wordCountColumn: { rows: rows.length, disagrees: rows.length },
    tokens: [{ token: 'Generic_Name', corpus: rows.length, eligible: rows.length, removed: true }],
    assignments: PROMPTS.map((p) => ({ slug: p.slug, name: p.name, text: `Take a position on ${p.name.toLowerCase()}.` })),
    over: new Map(PROMPTS.map((p) => [p.name, { base: rows.length, dropped: 0 }])),
    cleaned: { changedWordCount: rows.length, outsideWordRange: 0, outsidePairingBins: 0 },
  };
}

test('the corpus reader takes the pinned columns, and refuses a file that is not that file', () => {
  const rows: CorpusRow[] = [];
  const n = readCsv(csvOf([
    corpusRow({ essay_id_comp: 'E1', full_text: studentEssay(1) }),
    // a field with a comma, a quote and a line break in it: the parser has to give it back whole
    corpusRow({ essay_id_comp: 'E2', full_text: 'One, "two" and three.\n\nA second paragraph.', prompt_name: 'Community service' }),
  ]), (r) => rows.push(r));
  assert.equal(n, 2, 'the header is not a row');
  assert.equal(rows.length, 2);
  assert.equal(rows[1]!.full_text, 'One, "two" and three.\n\nA second paragraph.');
  assert.equal(rows[0]!.prompt_name, 'Distance learning');
  assert.equal(rows[0]!.grade_level, '8.0');
  // a mirror with other columns is a different file, and every count here is about the pinned one
  assert.throws(() => readCsv(new TextEncoder().encode('essay_id_comp,full_text\nE1,hello\n'), () => {}), /expected/);
});

test('the placeholder scan takes the corpus\'s tokens and leaves the writer\'s own capitals alone', () => {
  assert.deepEqual(splitPlaceholder('Generic_Name'), { placeholder: 'Generic_Name', rest: '' });
  assert.deepEqual(splitPlaceholder('GENERIC_NAME'), { placeholder: 'GENERIC_NAME', rest: '' });
  // the corpus writes the same token in three casings, and misspells three of them
  assert.deepEqual(splitPlaceholder('Generic_name'), { placeholder: 'Generic_name', rest: '' });
  assert.deepEqual(splitPlaceholder('Genric_Name'), { placeholder: 'Genric_Name', rest: '' });
  // and a few reached the file stuck to the word that follows, which is the writer's
  assert.deepEqual(splitPlaceholder('TEACHER_NAMEif'), { placeholder: 'TEACHER_NAME', rest: 'if' });
  assert.deepEqual(splitPlaceholder('SCHOOL_NAMEt'), { placeholder: 'SCHOOL_NAME', rest: 't' });
  // one word of the scheme is not the scheme: a heading typed in capitals is the student's
  assert.equal(splitPlaceholder('COMMUNITY_SERVICE'), null);
  assert.equal(splitPlaceholder('Distracted_Driving'), null);
  assert.equal(isPlaceholder('STUDENT_NAME'), true);
  assert.equal(isPlaceholder('utm_source'), false);
});

test('a placeholder is taken out, its tail kept only when it is a word, and the punctuation left alone', () => {
  assert.equal(stripPlaceholders('Dear TEACHER_NAMEif you read this, I agree.').text, 'Dear if you read this, I agree.');
  // the comma after a removed name is the writer's, and stays
  assert.equal(stripPlaceholders('Dear STUDENT_NAME, I think so.').text, 'Dear , I think so.');
  // a single letter left behind is the annotation's own slip rather than a word
  assert.equal(stripPlaceholders('the SCHOOL_NAMEt building').text, 'the building');
  assert.equal(stripPlaceholders('Dear Generic_Name and Generic_Name again.').removed, 2);
  const untouched = 'My COMMUNITY_SERVICE hours were at the shelter.';
  assert.deepEqual(stripPlaceholders(untouched), { text: untouched, removed: 0 });
});

test('measuredText normalises the essay and removes what the corpus wrote, not what the student did', () => {
  const { text, placeholders } = measuredText('Dear Generic_Name,&nbsp;I wrote this in &quot;class&quot;.\n\n\n\nIt is my COMMUNITY_SERVICE essay.');
  assert.equal(placeholders, 1);
  assert.equal(text.includes('Generic_Name'), false);
  assert.ok(text.includes('COMMUNITY_SERVICE'), 'the student\'s own capitals stay');
  assert.ok(text.includes('"class"'), 'entities are decoded');
  assert.ok(text.includes('\n\n') && !text.includes('\n\n\n'), 'a paragraph break is kept, and only one');
});

test('a re-read of the corpus agrees with the frame, and names whatever moved', () => {
  const rows: CorpusRow[] = [];
  readCsv(csvOf([
    corpusRow({ essay_id_comp: 'E1', full_text: studentEssay(1) }),
    corpusRow({ essay_id_comp: 'E2', full_text: studentEssay(2), grade_level: '11.0' }),
    corpusRow({ essay_id_comp: 'E3', full_text: studentEssay(3), prompt_name: 'Community service' }),
  ]), (r) => rows.push(r));
  const c = corpusOf(rows);
  const written = JSON.parse(frame(c, '2026-09-17T00:00:00.000Z')) as HumanFrame;
  assert.deepEqual(compare(written, c), [], 'the frame this corpus wrote must agree with the corpus');
  assert.equal(JSON.stringify(written).includes('pupils should be allowed'), false, 'the frame holds no essay text');
  // the dating claim is per essay, and the file says which list it rests on and how many essays that
  // list left out, because a reader counting the corpus will find more essays than this file holds
  const dating = (written as unknown as { dating: { per_document: boolean; kept: number; not_on_the_list: number; list: { file: string; essays: number } } }).dating;
  assert.equal(dating.per_document, true);
  assert.equal(dating.kept, c.essays.length);
  assert.equal(dating.not_on_the_list, 1);
  assert.equal(dating.list.file, 'data/genres/essays/kaggle-2021.json');
  assert.equal(dating.list.essays, c.essays.length + 1);
  // the provider travels into the row: it is a confounder, since providers differ by state and grade
  assert.deepEqual(written.essays!.map((r) => r.provider), ['Virginia', 'NCES', 'Virginia']);
  assert.match(compare({ ...written, essays: written.essays!.map((r, i) => (i ? r : { ...r, provider: 'NCES' })) }, c)[0]!, /provider is "NCES" in the frame/);
  // one essay measured differently: named, with the field, what the frame said and what this run says
  const moved = { ...written, essays: written.essays!.map((r, i) => (i ? r : { ...r, words: r.words + 1 })) };
  const problems = compare(moved, c);
  assert.equal(problems.length, 1);
  assert.ok(problems[0]!.startsWith(`${c.essays[0]!.id}: words is`), problems[0]);
  // an essay the frame does not have, and bytes upstream that are not the ones it was written from
  assert.match(compare({ ...written, essays: written.essays!.slice(1) }, c)[0]!, /is in this run and not in the frame/);
  assert.match(compare({ ...written, source: { files: [{ name: 'train.csv', sha256: `${'0'.repeat(64)}` }] } }, c)[0]!, /train\.csv: the frame was written from SHA-256/);
});
