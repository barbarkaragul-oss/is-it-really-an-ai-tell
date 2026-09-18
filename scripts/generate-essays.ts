/**
 * The machine side of the essays: which essays are asked for, what exactly is asked, and how a
 * returned essay becomes a committed record.
 *
 *   npx tsx scripts/generate-essays.ts --worklist   writes the work list (out/ and data/)
 *   npx tsx scripts/generate-essays.ts --report     lists the slots that are still missing
 *   npx tsx scripts/generate-essays.ts              merges the finished slots into data/generated/
 *
 * Five things are decided here rather than in the runner that calls them, because the runner is a
 * different one for every writer (Claude Code subagents write their essays into out/gen/essays/,
 * scripts/llama-essays.ts writes its own there), and every writer must be asked the same way.
 *
 *  1. WHICH ESSAYS. The people's essays are not spread evenly over the seven assignments or the
 *     grades: the frame (data/genres/essays/frame.json, one row per sampled human essay, no text)
 *     holds far more grade-8 essays than grade-12 ones. A machine arm is therefore allocated over
 *     the (assignment, grade) cells in the same proportions, by largest remainder, so that the two
 *     sides differ in who wrote them and not in what they were asked to write about. A cell the
 *     people barely fill cannot support a comparison at all, so a cell with fewer than
 *     MIN_HUMAN_CELL human essays gets no slots and is published as skipped, with its count.
 *  2. IN WHICH ORDER. The slots are shuffled once, seeded, and every arm is shuffled the same way.
 *     The order matters because a run can stop: with the cells in file order a half-finished run is
 *     all of one assignment, and with this order it is a spread over every cell, the same spread in
 *     every arm. The position in that order is also the seed the local model is run at, which is
 *     recorded with each essay; it describes the run rather than replaying it, since the local model
 *     does not return the same essay twice (scripts/llama-essays.ts says what was measured).
 *  3. WHAT IS ASKED. Two templates, from the design: the assignment on its own, and the assignment
 *     with the student framing. Nothing is said about length, style, formatting or titles -- a
 *     length instruction would make length unmeasurable, and a "plain paragraphs" instruction would
 *     make the formatting markers ours rather than the writer's. promptFor() is the only place a
 *     prompt is built, so the runner, the committed record and the test cannot drift apart.
 *  4. WHAT NEVER ENTERS A PROMPT. The only corpus text a prompt carries is the assignment, which is
 *     the teacher's words. No human essay text is read by this file at all: readFrame() refuses a
 *     frame that carries any long string, so a frame that grew a text column fails the run instead
 *     of quietly reaching a prompt. The people's essays are read once, by the memorisation check
 *     below, which keeps five-word sequences and drops the text.
 *  5. WHAT IS COMMITTED. One record per essay, with the prompt it was given, the hash of that
 *     prompt, the writer, the harness and the settings, so the generation can be audited rather
 *     than taken on trust. The merge is idempotent: a record already committed stays as it is, a
 *     slot that is missing is reported as missing and never invented, and a slot whose text fails a
 *     check is rejected with the reason rather than merged.
 *
 * On size: 600 records put data/generated/ near 2.2 MB, above the 1.8 MB the design budgeted, and the
 * two reasons are both deliberate. The design costed 400 essays and this genre asks for 600, because it
 * has a second writer; and every record carries the prompt it was given, which is about a third of the
 * file. A record without its prompt cannot be audited from the file alone, which is the whole point of
 * committing it, so the budget is restated here rather than met by dropping either. Nothing enforces a
 * size today (the CI has no such step), so this is the number, not a limit.
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { words } from '../src/markers.js';
import { seededShuffle } from '../src/measure.js';
import { fiveGrams } from './contamination.js';
import { DATA, OUT, flag } from './arms.js';

/** the protocol these records were written under; it changes when a template or a setting changes */
export const PROTOCOL_VERSION = 'essays-1';
/** essays asked of each machine arm */
export const SLOTS_PER_ARM = 200;
/** a cell with fewer human essays than this gets no machine slots: there is nothing to compare with */
export const MIN_HUMAN_CELL = 20;
/**
 * The seed everything random here is drawn at: DEFAULT_SEED in src/measure.ts, which is not
 * exported. tests/essays.test.ts reads that file and fails if the two ever part company.
 */
export const SEED = 20260916;
/** a returned answer shorter than this is not an essay; the runner records it and does not merge it */
export const MIN_ESSAY_WORDS = 30;
/**
 * Two lengths of copied assignment, because they are two different things.
 *
 * ECHO_SPAN is the length at which a run of characters shared with the assignment stops being
 * coincidence: forty characters is about seven words. Every essay is measured against it and the
 * number is published per essay and per arm. It is not a reason to drop the essay. Writers answering
 * "should students be allowed to use phones at lunch" write "allowing students to use phones at
 * lunch", and the people's essays do it too -- they are not filtered for it, and could not be, so
 * filtering the machine essays for it would manufacture a difference between the sides rather than
 * measure one. `--strict-echo` rejects at this length for anyone who wants the stricter rule.
 *
 * ECHO_COPIED is the length at which the essay is carrying the assignment rather than answering it:
 * a whole sentence of the teacher's, counted as the writer's words by every marker. That is rejected,
 * because it is usually a harness fault (a prompt pasted into the answer) rather than writing.
 */
export const ECHO_SPAN = 40;
export const ECHO_COPIED = 200;

/**
 * The assignment text is quoted verbatim in every record, so the licence travels with the files
 * rather than living only on the page.
 */
export const ASSIGNMENT_LICENCE =
  'The assignment text is quoted verbatim from PERSUADE 2.0 (Crossley et al., 2024), CC BY-NC-SA 4.0 '
  + '(https://creativecommons.org/licenses/by-nc-sa/4.0/). The essays themselves were written for this '
  + 'repository and are under its own licence.';

/**
 * A machine arm as the generation side needs it. scripts/genres.ts owns what the page calls these
 * arms and which of them the verdict is decided against; this list owns what each one is asked and
 * where its essays are committed. tests/essays.test.ts checks the two agree once the genre exists.
 */
export interface MachineArm {
  id: string;
  /** which template the arm is given */
  template: 'student' | 'plain';
  /** the writer, as scripts/genres.ts names it */
  writer: 'claude' | 'llama3';
  model: string;
  harness: string;
  /** where its merged files go, inside data/ (so --data points a test run somewhere else) */
  generated: string;
}

export const MACHINE_ARMS: MachineArm[] = [
  { id: 'essays-claude-student', template: 'student', writer: 'claude', model: 'claude-opus-5', harness: 'Claude Code', generated: 'generated/claude-essays' },
  { id: 'essays-llama3-student', template: 'student', writer: 'llama3', model: 'llama3:latest', harness: 'Ollama, on this machine', generated: 'generated/llama3-essays' },
  // descriptive only: the same assignment with no student framing, to show how much the framing moves the numbers
  { id: 'essays-claude-plain', template: 'plain', writer: 'claude', model: 'claude-opus-5', harness: 'Claude Code', generated: 'generated/claude-essays' },
];

export const armById = new Map(MACHINE_ARMS.map((a) => [a.id, a]));

/**
 * The two prompts, reproduced from the design word for word, line breaks included: the committed
 * record must be the string the design says was sent, and a rewrapped line is a different string.
 * `{assignment}` is the teacher's words as the corpus has them, `{grade}` the cell's grade.
 */
export const TEMPLATES: Record<MachineArm['template'], string> = {
  plain: '{assignment}\n\nWrite the essay. Return only the essay itself, with nothing before or after it.',
  student: 'You are a student in grade {grade} at a school in the United States. Your teacher\n'
    + 'has given the class this assignment:\n\n'
    + '{assignment}\n\n'
    + 'Write your essay and hand it in. It is one draft, written in class, not revised.\n'
    + 'Return only the essay itself, with nothing before or after it.',
};

export const sha256 = (s: string): string => createHash('sha256').update(s, 'utf8').digest('hex');

/** a prompt name as a file name: "Cell phones at school" -> "cell-phones-at-school" */
export const slugify = (name: string): string =>
  name.normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

// ---- the human frame, read for its shape only

/**
 * One row of data/genres/essays/frame.json: a human essay's cell and hash, never its text. `prompt`
 * is whatever that file calls its assignment -- the collector writes the slug into the middle of the
 * id, an earlier draft of the shape wrote a separate column -- and it is resolved against the
 * assignments before anything is counted.
 */
export interface FrameRow { id: string; prompt: string; grade: number; words: number; bin: number; sha256: string }
export interface Frame { rows: FrameRow[]; summary?: Record<string, unknown> }

/**
 * Fields that would carry a person's essay, and the length past which any field is treated as text.
 * A frame row holds an id, a name, three numbers and a hash; nothing in it is long. The guard is on
 * the length and not only on the names because the column that leaks is the one nobody expected.
 */
const TEXT_FIELDS = ['text', 'full_text', 'body', 'essay', 'content', 'excerpt'];
const LONGEST_FRAME_FIELD = 200;

/**
 * The frame, checked before it is used. A frame that carries text fails here, loudly, rather than
 * reaching a prompt: the error names the field and its length and never prints the value.
 */
export function readFrame(file: string): Frame {
  const parsed: unknown = JSON.parse(readFileSync(file, 'utf8'));
  // the collector writes its rows under "essays"; the shape this was first written against says "rows"
  const held = parsed as { rows?: FrameRow[]; essays?: FrameRow[]; summary?: Record<string, unknown> };
  const list = Array.isArray(parsed) ? (parsed as FrameRow[]) : held.rows ?? held.essays;
  if (!Array.isArray(list) || list.length === 0) throw new Error(`${file}: expected { essays: [...] } or { rows: [...] } with at least one row`);
  const raw: Partial<Frame> = Array.isArray(parsed) ? { rows: list } : { rows: list, ...(held.summary ? { summary: held.summary } : {}) };
  const rows = raw.rows!.map((r, i) => {
    const row = r as unknown as Record<string, unknown>;
    for (const [k, v] of Object.entries(row)) {
      if (TEXT_FIELDS.includes(k)) throw new Error(`${file}: row ${i} carries a "${k}" field; the frame must not hold any essay text`);
      if (typeof v === 'string' && v.length > LONGEST_FRAME_FIELD) {
        throw new Error(`${file}: row ${i} field "${k}" is ${v.length} characters; the frame must not hold any essay text`);
      }
    }
    /*
     * Which assignment the essay answers. The collector writes it into the middle of the id
     * ("essays:<assignment>:<essay>") and keeps no column of its own, because a column repeating the
     * id in 5,867 rows is a third of the file for nothing; a row that does carry one is still
     * accepted, since the fixtures and the first draft of this shape wrote it that way. Either form
     * is resolved against the assignments file before it is counted (worklistFor), so the slug and
     * the name are the same cell.
     */
    const id = String(row['id'] ?? i);
    const column = row['prompt'];
    const prompt = typeof column === 'string' && column ? column : (id.split(':')[1] ?? '');
    const grade = Number(row['grade']);
    if (!prompt) throw new Error(`${file}: row ${i} names no assignment, in a "prompt" field or in the middle of its id`);
    if (!Number.isFinite(grade)) throw new Error(`${file}: row ${i} has no grade`);
    return {
      id, prompt, grade,
      words: Number(row['words'] ?? 0), bin: Number(row['bin'] ?? -1), sha256: String(row['sha256'] ?? ''),
    };
  });
  return raw.summary ? { rows, summary: raw.summary } : { rows };
}

/** one assignment: the teacher's words, the name the page uses, and the slug the files are named by */
export interface AssignmentEntry { slug: string; name: string; assignment: string }

/**
 * data/genres/essays/assignments.json, written by the human side of this genre:
 * { prompts: [{ slug, name, assignment }] }, or that array on its own. Every entry is indexed under
 * its slug and its name, because the frame names its assignments by slug and the page by name, and
 * a prompt that cannot be found under the name the frame uses would silently go unwritten.
 */
export function readAssignments(file: string): Map<string, AssignmentEntry> {
  const parsed: unknown = JSON.parse(readFileSync(file, 'utf8'));
  const list = Array.isArray(parsed)
    ? parsed
    : ((parsed as { prompts?: unknown[]; assignments?: unknown[] }).prompts ?? (parsed as { assignments?: unknown[] }).assignments);
  if (!Array.isArray(list) || list.length === 0) throw new Error(`${file}: expected { prompts: [{ slug, name, assignment }] }`);
  const out = new Map<string, AssignmentEntry>();
  for (const item of list) {
    const row = item as Record<string, unknown>;
    const name = row['name'] ?? row['prompt'] ?? row['prompt_name'];
    // the assignment is used exactly as it is stored, not trimmed or rewrapped: it is the corpus text
    const assignment = row['assignment'] ?? row['text'] ?? row['assignment_text'];
    if (typeof name !== 'string' || typeof assignment !== 'string' || !assignment) {
      throw new Error(`${file}: every entry needs a name and an assignment`);
    }
    const slug = typeof row['slug'] === 'string' && row['slug'] ? row['slug'] : slugify(name);
    const entry: AssignmentEntry = { slug, name, assignment };
    for (const key of [slug, name, slugify(name)]) out.set(key, entry);
  }
  return out;
}

/** the assignment a frame row or a slot names, however it names it */
export function assignmentFor(key: string, assignments: Map<string, AssignmentEntry>): AssignmentEntry {
  const entry = assignments.get(key) ?? assignments.get(slugify(key));
  if (!entry) throw new Error(`no assignment for "${key}" in the assignments file; it has ${[...new Set([...assignments.values()].map((a) => a.slug))].join(', ')}`);
  return entry;
}

// ---- 1. which essays: the cells, in the people's proportions

/** one (assignment, grade) cell: how many of the people's essays it holds, and how many are asked for */
export interface Cell { prompt: string; grade: number; human: number; share: number; slots: number }
export interface SkippedCell { prompt: string; grade: number; human: number; reason: string }
export interface Allocation {
  slots_per_arm: number;
  min_human_cell: number;
  /** the people's essays in the cells that are used; the share of each cell is taken over this */
  human_in_used_cells: number;
  human_total: number;
  cells: Cell[];
  skipped_cells: SkippedCell[];
}

/**
 * The slots per cell, by largest remainder: every cell gets the whole part of its share, and the
 * slots that are left over go to the cells with the largest fractions, ties broken by the larger
 * human cell and then by name, so the allocation is a function of the frame and nothing else.
 */
export function allocate(frame: Frame, slotsPerArm: number = SLOTS_PER_ARM, minHumanCell: number = MIN_HUMAN_CELL): Allocation {
  const counts = new Map<string, { prompt: string; grade: number; human: number }>();
  for (const r of frame.rows) {
    const key = JSON.stringify([r.prompt, r.grade]);
    const cell = counts.get(key) ?? { prompt: r.prompt, grade: r.grade, human: 0 };
    cell.human++;
    counts.set(key, cell);
  }
  const all = [...counts.values()].sort((a, b) => a.prompt.localeCompare(b.prompt) || a.grade - b.grade);
  const used = all.filter((c) => c.human >= minHumanCell);
  const skipped = all.filter((c) => c.human < minHumanCell).map((c): SkippedCell => ({
    prompt: c.prompt, grade: c.grade, human: c.human,
    reason: `fewer than ${minHumanCell} human essays in this cell: no machine essay is asked for it`,
  }));
  const pool = used.reduce((n, c) => n + c.human, 0);
  const quota = used.map((c) => (pool ? (c.human / pool) * slotsPerArm : 0));
  const base = quota.map(Math.floor);
  let left = slotsPerArm - base.reduce((a, b) => a + b, 0);
  const order = used.map((c, i) => ({ i, c, rest: quota[i]! - base[i]! }))
    .sort((a, b) => b.rest - a.rest || b.c.human - a.c.human || a.c.prompt.localeCompare(b.c.prompt) || a.c.grade - b.c.grade);
  for (const { i } of order) {
    if (left <= 0) break;
    base[i]!++;
    left--;
  }
  return {
    slots_per_arm: slotsPerArm,
    min_human_cell: minHumanCell,
    human_in_used_cells: pool,
    human_total: frame.rows.length,
    cells: used.map((c, i): Cell => ({ prompt: c.prompt, grade: c.grade, human: c.human, share: pool ? c.human / pool : 0, slots: base[i]! })),
    skipped_cells: skipped,
  };
}

// ---- 2 and 3. the slots, and the prompt each one is given

export interface Slot {
  /** stable and file-name safe: the arm, the assignment, the grade, and the essay's number in that cell */
  id: string;
  arm: string;
  /** the assignment's name, as the frame writes it */
  prompt: string;
  slug: string;
  grade: number;
  /** the position in the generation order, and the seed the local model is run at */
  index: number;
  /** the teacher's words, verbatim; the only corpus text a prompt ever carries */
  assignment: string;
}

/** the row the committed work list keeps: no text, nothing a person wrote */
export interface ListedSlot { id: string; arm: string; prompt: string; grade: number }

export const slotId = (arm: string, slug: string, grade: number, n: number): string =>
  `${arm}.${slug}.g${grade}.${String(n).padStart(3, '0')}`;

/**
 * One arm's slots. The cells are expanded one slot at a time and shuffled once at the seed, and
 * every arm is shuffled the same way, so a run that stops leaves the arms covering the same cells.
 * The id does not depend on the shuffle, only on the cell, so a re-run gives every essay the same id.
 */
export function slotsFor(arm: MachineArm, alloc: Allocation, assignments: Map<string, AssignmentEntry>, seed: number = SEED): Slot[] {
  const entries: { prompt: string; grade: number; n: number }[] = [];
  for (const c of alloc.cells) for (let n = 1; n <= c.slots; n++) entries.push({ prompt: c.prompt, grade: c.grade, n });
  return seededShuffle(entries, seed).map((e, index) => {
    const { slug, name, assignment } = assignmentFor(e.prompt, assignments);
    return { id: slotId(arm.id, slug, e.grade, e.n), arm: arm.id, prompt: name, slug, grade: e.grade, index, assignment };
  });
}

/**
 * Every arm's slots, in generation order, arm by arm. The frame's own name for an assignment is
 * resolved to the assignments file's name first, so the cells, the slot ids and the committed record
 * all speak of the same seven assignments however the frame writes them.
 */
export function worklistFor(frame: Frame, assignments: Map<string, AssignmentEntry>, opts: { slots?: number; arms?: MachineArm[]; seed?: number } = {}):
  { allocation: Allocation; slots: Slot[] } {
  const named: Frame = { rows: frame.rows.map((r) => ({ ...r, prompt: assignmentFor(r.prompt, assignments).name })) };
  const allocation = allocate(named, opts.slots ?? SLOTS_PER_ARM, MIN_HUMAN_CELL);
  const arms = opts.arms ?? MACHINE_ARMS;
  return { allocation, slots: arms.flatMap((a) => slotsFor(a, allocation, assignments, opts.seed ?? SEED)) };
}

/**
 * The prompt a slot is given: the one place a prompt is built. The runner sends this, the record
 * commits this, and the test compares the committed record with this.
 */
export function promptFor(slot: Slot): string {
  const arm = armById.get(slot.arm);
  if (!arm) throw new Error(`unknown arm ${slot.arm}`);
  // the assignment is substituted through a function, not as a string: a replacement string expands
  // $&, $` and $1, so an assignment carrying a dollar sign would reach the model mangled, and the
  // record and the test would agree with each other about the mangled version
  return TEMPLATES[arm.template].replace('{grade}', String(slot.grade)).replace('{assignment}', () => slot.assignment);
}

// ---- 4. a returned essay, checked

/** what a runner writes to out/gen/essays/<slot>.json as it goes */
export interface SlotFile {
  slot: string;
  arm: string;
  text: string;
  model?: string;
  harness?: string;
  generated_at?: string;
  context_id?: string;
  /** the prompt the runner actually sent, when it records it: it must equal promptFor(slot) */
  prompt?: string;
  prompt_sha256?: string;
  text_sha256?: string;
  settings?: unknown;
  seconds?: number;
  eval_count?: number;
  done_reason?: string;
  /** set when the runner gave up: an empty answer, a refusal, or an error it could not get past */
  error?: string;
  attempts?: number;
}

/** the committed record of one essay */
export interface EssayRecord {
  slot: string;
  arm: string;
  prompt_name: string;
  grade: number;
  prompt_text: string;
  prompt_sha256: string;
  protocol_version: string;
  model: string;
  harness: string;
  generated_at: string;
  settings: unknown;
  context_id: string;
  text: string;
  words: number;
  text_sha256: string;
  /** the longest run of the assignment the essay carries, when it reaches ECHO_SPAN; measured, not judged */
  assignment_echo?: Echo;
  seconds?: number;
  eval_count?: number;
  done_reason?: string;
}

/** whitespace folded and case dropped, so a copied sentence is recognised however it was laid out */
const folded = (s: string): string => s.toLowerCase().replace(/\s+/g, ' ').trim();

/** the longest run of characters an essay shares with its assignment, once it reaches `span` */
export interface Echo { longest: number; snippet: string }

/**
 * How much of the assignment the essay is carrying. Whitespace and case are folded first, so a
 * copied sentence is found however it was laid out. Runs are measured from the longest: once a run
 * has been extended as far as it goes, a run starting inside it is shorter and is skipped.
 */
export function assignmentEcho(text: string, assignment: string, span: number = ECHO_SPAN): Echo | null {
  const a = folded(text), b = folded(assignment);
  if (a.length < span || b.length < span) return null;
  let longest = 0, at = -1;
  for (let i = 0; i + span <= a.length; i++) {
    if (!b.includes(a.slice(i, i + span))) continue;
    let run = span;
    while (i + run < a.length && b.includes(a.slice(i, i + run + 1))) run++;
    if (run > longest) { longest = run; at = i; }
    i += run - span;
  }
  return longest ? { longest, snippet: a.slice(at, at + Math.min(longest, 120)) } : null;
}

export interface Rejection { slot: string; reasons: string[] }

/**
 * Everything wrong with a returned slot, as a list rather than the first thing found: a run that
 * fixes one problem should not discover the next one on the following pass.
 */
export function problemsWith(slot: Slot, file: SlotFile, opts: { strictEcho?: boolean } = {}): string[] {
  const out: string[] = [];
  const arm = armById.get(slot.arm)!;
  const prompt = promptFor(slot);
  if (file.slot !== slot.id) out.push(`the file names slot ${file.slot}`);
  if (file.arm !== slot.arm) out.push(`the file names arm ${file.arm}, not ${slot.arm}`);
  if (file.error) out.push(`the runner recorded an error: ${file.error}`);
  if (file.prompt !== undefined && file.prompt !== prompt) out.push('the prompt sent is not the template for this slot');
  if (file.prompt_sha256 !== undefined && file.prompt_sha256 !== sha256(prompt)) out.push('the prompt hash is not the hash of this slot\'s prompt');
  const text = typeof file.text === 'string' ? file.text.trim() : '';
  const n = words(text).length;
  if (!text) out.push('the text is empty');
  else if (n < MIN_ESSAY_WORDS) out.push(`the text is ${n} words: too short to be an essay`);
  if (file.text_sha256 !== undefined && file.text_sha256 !== sha256(text)) out.push('the committed hash is not the hash of the text');
  if (file.model !== undefined && file.model !== arm.model) out.push(`the file names model ${file.model}, not ${arm.model}`);
  if (!file.generated_at) out.push('no generated_at: when the essay was written cannot be invented here');
  if (!file.context_id) out.push('no context_id: one essay per context is part of the protocol');
  if (text) {
    const echo = assignmentEcho(text, slot.assignment);
    const limit = opts.strictEcho ? ECHO_SPAN : ECHO_COPIED;
    if (echo && echo.longest >= limit) out.push(`${echo.longest} characters of the assignment are in the essay: "${echo.snippet}"`);
  }
  return out;
}

/** a checked slot as it is committed; the prompt and the hashes are computed here, never taken on trust */
export function recordFor(slot: Slot, file: SlotFile): EssayRecord {
  const arm = armById.get(slot.arm)!;
  const prompt = promptFor(slot);
  const text = file.text.trim();
  const echo = assignmentEcho(text, slot.assignment);
  return {
    slot: slot.id,
    arm: slot.arm,
    prompt_name: slot.prompt,
    grade: slot.grade,
    prompt_text: prompt,
    prompt_sha256: sha256(prompt),
    protocol_version: PROTOCOL_VERSION,
    model: file.model ?? arm.model,
    harness: file.harness ?? arm.harness,
    generated_at: String(file.generated_at),
    settings: file.settings ?? 'not exposed by the harness',
    context_id: String(file.context_id),
    text,
    words: words(text).length,
    text_sha256: sha256(text),
    ...(echo ? { assignment_echo: echo } : {}),
    ...(file.seconds !== undefined ? { seconds: file.seconds } : {}),
    ...(file.eval_count !== undefined ? { eval_count: file.eval_count } : {}),
    ...(file.done_reason !== undefined ? { done_reason: file.done_reason } : {}),
  };
}

// ---- 5. the memorisation check, and the merged files

/**
 * The people's essays as the memorisation check needs them: the set of their five-word sequences,
 * and how many essays went into it. The text itself is read here and dropped here; nothing else in
 * this file sees it, and nothing it says reaches a prompt or a committed file except the numbers.
 */
export interface HumanCorpus { essays: number; five_grams: number; grams: Set<string>; baseline: Baseline }

/**
 * What the check reads as "nothing remembered". Nine thousand essays answering seven assignments
 * share a great deal of ordinary phrasing: a sentence written here for a test, about phones at lunch,
 * already has half its five-word sequences somewhere in this corpus. An absolute threshold would
 * therefore call every writer a copier, so the people are measured against themselves first and the
 * machine arms are read against that number.
 */
export interface Baseline { essays: number; mean: number; max: number; above_20_percent: number; note: string }

/** how many of the people's essays are held out to measure that baseline */
export const BASELINE_SAMPLE = 200;

const round = (x: number): number => Math.round(x * 10000) / 10000;

/**
 * The corpus, and the people's own baseline, in one pass and one set. The held-out essays are left
 * out of the set while they are measured against it -- an essay is otherwise contained in itself and
 * the baseline is 1 -- and are added to it afterwards, so the machine arms are measured against every
 * essay the people wrote.
 */
export function humanCorpusFrom(texts: string[], opts: { sample?: number; seed?: number } = {}): HumanCorpus {
  const size = Math.min(opts.sample ?? BASELINE_SAMPLE, Math.floor(texts.length / 2));
  const held = new Set(seededShuffle(texts.map((_, i) => i), opts.seed ?? SEED).slice(0, size));
  const grams = new Set<string>();
  texts.forEach((t, i) => { if (!held.has(i)) for (const g of fiveGrams(t)) grams.add(g); });
  const scores = [...held].map((i) => {
    const mine = fiveGrams(texts[i]!);
    if (!mine.size) return 0;
    let hit = 0;
    for (const g of mine) if (grams.has(g)) hit++;
    return hit / mine.size;
  });
  for (const i of held) for (const g of fiveGrams(texts[i]!)) grams.add(g);
  return {
    essays: texts.length,
    five_grams: grams.size,
    grams,
    baseline: {
      essays: scores.length,
      mean: scores.length ? round(scores.reduce((a, b) => a + b, 0) / scores.length) : 0,
      max: round(scores.reduce((a, b) => Math.max(a, b), 0)),
      above_20_percent: scores.filter((s) => s > 0.2).length,
      note: `${scores.length} of the people's own essays, each measured against the others the same way. `
        + 'A machine arm near this number is writing like the people; well above it is repeating them.',
    },
  };
}

/** out/essays-human.json (git-ignored) as the human side writes it: one row per essay */
export function loadHumanCorpus(file: string): HumanCorpus {
  const parsed: unknown = JSON.parse(readFileSync(file, 'utf8'));
  const rows = (Array.isArray(parsed) ? parsed : (parsed as { rows?: unknown[]; texts?: unknown[] }).rows ?? (parsed as { texts?: unknown[] }).texts) as { text?: string }[] | undefined;
  if (!Array.isArray(rows)) throw new Error(`${file}: expected [{ id, text }]`);
  return humanCorpusFrom(rows.map((r) => String(r.text ?? '')));
}

/** the share of an essay's five-word sequences that also occur somewhere in the people's essays */
export function containedInCorpus(text: string, corpus: HumanCorpus): number {
  const grams = fiveGrams(text);
  if (!grams.size) return 0;
  let hit = 0;
  for (const g of grams) if (corpus.grams.has(g)) hit++;
  return hit / grams.size;
}

export interface Memorisation {
  essays: number;
  mean: number;
  max: number;
  /** essays sharing more than a fifth of their five-word sequences with the people's essays */
  above_20_percent: number;
  worst: { slot: string; containment: number }[];
}

/**
 * Per arm, how much of each generated essay already exists in the people's essays. PERSUADE is a
 * public Kaggle corpus and prime training data, so this is published rather than assumed away. The
 * comparison is against the whole human sample and not against one document, because these pairs
 * are an assignment in common and not a document in common. What counts as a high number is the
 * corpus's own baseline (humanCorpusFrom), not zero: on the real corpus the people themselves score
 * 0.16 on average and 0.41 at most, so an arm is read against that and not against an idea of
 * originality.
 */
export function memorisationOf(records: EssayRecord[], corpus: HumanCorpus): Record<string, Memorisation> {
  const out: Record<string, Memorisation> = {};
  for (const arm of new Set(records.map((r) => r.arm))) {
    const scored = records.filter((r) => r.arm === arm)
      .map((r) => ({ slot: r.slot, containment: containedInCorpus(r.text, corpus) }));
    out[arm] = {
      essays: scored.length,
      mean: scored.length ? round(scored.reduce((a, b) => a + b.containment, 0) / scored.length) : 0,
      max: round(scored.reduce((a, b) => Math.max(a, b.containment), 0)),
      above_20_percent: scored.filter((s) => s.containment > 0.2).length,
      worst: [...scored].sort((a, b) => b.containment - a.containment).slice(0, 3).map((s) => ({ slot: s.slot, containment: round(s.containment) })),
    };
  }
  return out;
}

/** one committed file: every arm's essays for one assignment */
export interface GeneratedFile {
  genre: 'essays';
  prompt_name: string;
  prompt_slug: string;
  protocol_version: string;
  assignment: string;
  assignment_sha256: string;
  licence: string;
  summary: {
    arms: Record<string, { asked: number; written: number; median_words: number; echoing_the_assignment: number }>;
    memorisation: { measured_against: { essays: number; five_grams: number } | null; person_baseline: Baseline | null; note: string; arms: Record<string, Memorisation> };
    rejected: Rejection[];
  };
  essays: EssayRecord[];
}

export interface MergeReport {
  /** slots with no essay anywhere yet, in generation order */
  missing: string[];
  rejected: Rejection[];
  /** slots taken from out/gen/essays this time */
  merged: number;
  /** records that were already committed and were left exactly as they were */
  kept: number;
  /** slots whose runner file says something different from the committed record */
  conflicts: string[];
  /** essays of one arm written in one context: against the protocol, see sharedContexts */
  sharedContexts: ContextClash[];
}

export interface ContextClash { arm: string; context: string; slots: string[] }

/**
 * Slots of one arm that name the same context. One essay per context is part of the protocol: ten
 * essays written in one conversation have each read the nine before them, so they are one sample and
 * not ten. `context_id` is the only record of that, and until now nothing read it beyond checking it
 * was not empty, so a runner that stamped one id on a whole batch would have reached data/generated/
 * unremarked. It is checked across the arm rather than per slot, which is the only place it can be seen.
 */
export function sharedContexts(records: EssayRecord[]): ContextClash[] {
  const seen = new Map<string, ContextClash>();
  for (const r of records) {
    // a separator no arm id or context id can hold, so two of them cannot collide by writing the
    // join themselves. It is written as an escape and never as the byte: a raw NUL makes this file
    // binary to grep, git diff and every other text tool, and a source file nobody can diff is worse
    // than a longer key.
    const key = `${r.arm}\u0000${r.context_id}`;
    const held = seen.get(key) ?? { arm: r.arm, context: r.context_id, slots: [] };
    held.slots.push(r.slot);
    seen.set(key, held);
  }
  return [...seen.values()].filter((c) => c.slots.length > 1).map((c) => ({ ...c, slots: [...c.slots].sort() }));
}

const MEMO_NOTE = 'The share of each essay\'s five-word sequences that also occur in the people\'s essays for this genre, '
  + 'measured against the whole human sample. Read it against person_baseline, not against zero: thousands of essays answering '
  + 'the same seven assignments share a great deal of ordinary phrasing, and a sentence invented for a test already matches about '
  + 'half the time. Well above the baseline is a model repeating writing it has seen.';

/**
 * The merge, as a function of what is on disk rather than of the order things happened in. A record
 * already committed is kept byte for byte, so running this twice writes the same files; a slot whose
 * runner file disagrees with the committed record is reported and the committed record stands, unless
 * `replace` says the new one wins.
 */
export function mergeArms(opts: {
  arms: MachineArm[];
  slots: Slot[];
  existing: Map<string, GeneratedFile>;
  slotFiles: Map<string, SlotFile>;
  corpus?: HumanCorpus | null;
  replace?: boolean;
  strictEcho?: boolean;
}): { files: Map<string, GeneratedFile>; report: MergeReport } {
  const armIds = new Set(opts.arms.map((a) => a.id));
  const slots = opts.slots.filter((s) => armIds.has(s.arm));
  const bySlot = new Map(slots.map((s) => [s.id, s]));
  const committed = new Map<string, EssayRecord>();
  for (const file of opts.existing.values()) for (const r of file.essays ?? []) committed.set(r.slot, r);

  const report: MergeReport = { missing: [], rejected: [], merged: 0, kept: 0, conflicts: [], sharedContexts: [] };
  const records = new Map<string, EssayRecord>();
  /** the slots this run took from the runner: the ones a cross-slot check may still throw out */
  const fresh = new Set<string>();
  for (const slot of slots) {
    const old = committed.get(slot.id);
    const file = opts.slotFiles.get(slot.id);
    if (old && (!file || !opts.replace)) {
      records.set(slot.id, old);
      report.kept++;
      // a slot file that recorded a failure carries no text at all, and a committed slot must not be
      // read as a conflict, or crash the merge, because a later run could not write it again
      if (file && String(file.text ?? '').trim() !== old.text) report.conflicts.push(slot.id);
      continue;
    }
    if (!file) { report.missing.push(slot.id); continue; }
    const problems = problemsWith(slot, file, opts.strictEcho === undefined ? {} : { strictEcho: opts.strictEcho });
    if (problems.length) { report.rejected.push({ slot: slot.id, reasons: problems }); continue; }
    records.set(slot.id, recordFor(slot, file));
    fresh.add(slot.id);
    report.merged++;
  }
  // a committed record whose slot the work list no longer has: kept, and its arm keeps counting it
  for (const [id, r] of committed) if (!records.has(id) && !bySlot.has(id)) records.set(id, r);

  /**
   * One essay per context, checked across the arm. A slot taken from the runner this run is thrown out
   * when it shares a context with another, so a batch written in one conversation never reaches
   * data/generated/; a clash between records that are already committed cannot be undone here, so it is
   * reported instead and the caller fails the run over it.
   */
  for (const clash of sharedContexts([...records.values()])) {
    report.sharedContexts.push(clash);
    for (const id of clash.slots.filter((s) => fresh.has(s))) {
      records.delete(id);
      report.merged--;
      report.rejected.push({
        slot: id,
        reasons: [`context ${JSON.stringify(clash.context)} is also used by ${clash.slots.filter((s) => s !== id).join(', ')}: one essay per context is part of the protocol`],
      });
    }
  }

  const files = new Map<string, GeneratedFile>();
  const slugs = new Map<string, { prompt: string; assignment: string }>();
  const slugOfName = new Map<string, string>();
  for (const s of slots) {
    slugs.set(s.slug, { prompt: s.prompt, assignment: s.assignment });
    slugOfName.set(s.prompt, s.slug);
  }
  const slugOf = (name: string): string => slugOfName.get(name) ?? slugify(name);
  for (const [slug, { prompt, assignment }] of [...slugs].sort((a, b) => a[0].localeCompare(b[0]))) {
    const mine = [...records.values()].filter((r) => slugOf(r.prompt_name) === slug).sort((a, b) => a.slot.localeCompare(b.slot));
    const asked = slots.filter((s) => s.slug === slug);
    const arms: GeneratedFile['summary']['arms'] = {};
    /**
     * Every arm the file holds essays for, not only the arms of this run: two arms share a directory,
     * so merging one of them alone would otherwise rewrite the file with a summary that says nothing
     * about the other while its essays are still in the same file. An arm this run did not ask for
     * keeps the number the run that asked for it recorded.
     */
    const inFile = [...new Set([...opts.arms.map((a) => a.id), ...mine.map((r) => r.arm)])];
    for (const id of inFile) {
      const written = mine.filter((r) => r.arm === id);
      const lengths = written.map((r) => r.words).sort((x, y) => x - y);
      const before = opts.existing.get(slug)?.summary?.arms?.[id]?.asked;
      arms[id] = {
        asked: opts.arms.some((a) => a.id === id) ? asked.filter((s) => s.arm === id).length : before ?? written.length,
        written: written.length,
        median_words: lengths.length ? lengths[Math.floor(lengths.length / 2)]! : 0,
        // measured and published, not a reason to drop an essay: see ECHO_SPAN
        echoing_the_assignment: written.filter((r) => r.assignment_echo).length,
      };
    }
    files.set(slug, {
      genre: 'essays',
      prompt_name: prompt,
      prompt_slug: slug,
      protocol_version: PROTOCOL_VERSION,
      assignment,
      assignment_sha256: sha256(assignment),
      licence: ASSIGNMENT_LICENCE,
      summary: {
        arms,
        memorisation: {
          measured_against: opts.corpus ? { essays: opts.corpus.essays, five_grams: opts.corpus.five_grams } : null,
          person_baseline: opts.corpus ? opts.corpus.baseline : null,
          note: opts.corpus ? MEMO_NOTE : 'Not measured on this run: the people\'s essays were not on this machine (out/essays-human.json).',
          arms: opts.corpus ? memorisationOf(mine, opts.corpus) : {},
        },
        rejected: report.rejected.filter((r) => bySlot.get(r.slot)?.slug === slug),
      },
      essays: mine,
    });
  }
  return { files, report };
}

/** the manifest beside the merged files: the templates once, the arms, and the totals */
export function manifestFor(arms: MachineArm[], files: Map<string, GeneratedFile>, corpus: HumanCorpus | null): Record<string, unknown> {
  const all = [...files.values()].flatMap((f) => f.essays);
  // the arms the files hold, as well as the arms of this run: see the same argument in mergeArms
  const listed = [...arms, ...[...new Set(all.map((r) => r.arm))].filter((id) => !arms.some((a) => a.id === id))
    .map((id) => armById.get(id)).filter((a): a is MachineArm => a !== undefined)];
  return {
    genre: 'essays',
    protocol_version: PROTOCOL_VERSION,
    one_call_per_essay: true,
    nothing_discarded: 'every essay a writer returned is here; the checks are reported, not applied',
    prompts_built_by: 'scripts/generate-essays.ts, promptFor()',
    no_human_text: 'No essay a person wrote enters a prompt. The only corpus text in a prompt is the assignment, which is the teacher\'s words.',
    licence: ASSIGNMENT_LICENCE,
    templates: TEMPLATES,
    arms: listed.map((a) => ({
      id: a.id, writer: a.writer, template: a.template, model: a.model, harness: a.harness,
      essays: all.filter((r) => r.arm === a.id).length,
    })),
    files: [...files.values()].map((f) => ({ prompt_name: f.prompt_name, file: `${f.prompt_slug}.json`, essays: f.essays.length })),
    memorisation: {
      measured_against: corpus ? { essays: corpus.essays, five_grams: corpus.five_grams } : null,
      person_baseline: corpus ? corpus.baseline : null,
      note: corpus ? MEMO_NOTE : 'Not measured on this run.',
      arms: corpus ? memorisationOf(all, corpus) : {},
    },
  };
}

// ---- disk

const body = (x: unknown): string => `${JSON.stringify(x, null, 1)}\n`;

/** written through a temporary name, so a run that is killed mid-write leaves no half a JSON file */
export function writeAtomic(file: string, text: string): void {
  mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, text);
  renameSync(tmp, file);
}

export const readJson = <T>(file: string): T => JSON.parse(readFileSync(file, 'utf8')) as T;

/** every slot file a runner has written so far */
export function readSlotFiles(dir: string): Map<string, SlotFile> {
  const out = new Map<string, SlotFile>();
  if (!existsSync(dir)) return out;
  for (const name of readdirSync(dir).sort()) {
    if (!name.endsWith('.json') || name.endsWith('.tmp')) continue;
    const file = readJson<SlotFile>(path.join(dir, name));
    out.set(String(file.slot ?? name.replace(/\.json$/, '')), file);
  }
  return out;
}

export function readGenerated(dir: string): Map<string, GeneratedFile> {
  const out = new Map<string, GeneratedFile>();
  if (!existsSync(dir)) return out;
  for (const name of readdirSync(dir).sort()) {
    if (!name.endsWith('.json') || name === 'manifest.json') continue;
    const file = readJson<GeneratedFile>(path.join(dir, name));
    out.set(file.prompt_slug ?? name.replace(/\.json$/, ''), file);
  }
  return out;
}

/**
 * The merge, on disk: one directory of merged files per group of arms that share one. Only the
 * files that changed are written, so a merge that finds nothing new leaves the tree untouched.
 */
export function mergeToDisk(opts: {
  arms: MachineArm[];
  slots: Slot[];
  root: string;
  slotDir: string;
  corpus?: HumanCorpus | null;
  replace?: boolean;
  strictEcho?: boolean;
  /** work out what would be written and write nothing: what --report needs */
  dryRun?: boolean;
}): { report: MergeReport; written: string[] } {
  const slotFiles = readSlotFiles(opts.slotDir);
  const written: string[] = [];
  const report: MergeReport = { missing: [], rejected: [], merged: 0, kept: 0, conflicts: [], sharedContexts: [] };
  const dirs = [...new Set(opts.arms.map((a) => a.generated))];
  for (const rel of dirs) {
    const dir = path.resolve(opts.root, rel);
    const arms = opts.arms.filter((a) => a.generated === rel);
    const { files, report: r } = mergeArms({
      arms, slots: opts.slots, existing: readGenerated(dir), slotFiles,
      corpus: opts.corpus ?? null,
      ...(opts.replace === undefined ? {} : { replace: opts.replace }),
      ...(opts.strictEcho === undefined ? {} : { strictEcho: opts.strictEcho }),
    });
    const changed = (target: string, text: string): void => {
      if (existsSync(target) && readFileSync(target, 'utf8') === text) return;
      if (!opts.dryRun) writeAtomic(target, text);
      written.push(target);
    };
    for (const [slug, file] of files) changed(path.join(dir, `${slug}.json`), body(file));
    changed(path.join(dir, 'manifest.json'), body(manifestFor(arms, files, opts.corpus ?? null)));
    report.missing.push(...r.missing);
    report.rejected.push(...r.rejected);
    report.conflicts.push(...r.conflicts);
    report.sharedContexts.push(...r.sharedContexts);
    report.merged += r.merged;
    report.kept += r.kept;
  }
  return { report, written };
}

/**
 * The work list the runners read. The committed copy carries no text at all: the slot, its arm, its
 * assignment's name and its grade. The copy in out/ carries the prompt each slot is given, so a
 * runner can be handed its slots without reading the frame or the corpus, and is never committed.
 */
export function worklistFiles(allocation: Allocation, slots: Slot[]): { listed: unknown; full: unknown } {
  const common = {
    genre: 'essays',
    protocol_version: PROTOCOL_VERSION,
    seed: SEED,
    slots_per_arm: allocation.slots_per_arm,
    min_human_cell: allocation.min_human_cell,
    human_frame: 'data/genres/essays/frame.json',
    allocation: allocation.cells,
    skipped_cells: allocation.skipped_cells,
    human_in_used_cells: allocation.human_in_used_cells,
    human_total: allocation.human_total,
  };
  return {
    listed: {
      ...common,
      note: 'No text. The prompt each slot was given is committed with its essay in data/generated/*/<assignment>.json.',
      slots: slots.map((s): ListedSlot => ({ id: s.id, arm: s.arm, prompt: s.prompt, grade: s.grade })),
    },
    full: {
      ...common,
      note: 'Not committed (out/ is git-ignored): this copy carries the assignment and the exact prompt for each slot.',
      templates: TEMPLATES,
      slots: slots.map((s) => ({
        id: s.id, arm: s.arm, prompt: s.prompt, grade: s.grade, index: s.index,
        prompt_sha256: sha256(promptFor(s)), prompt_text: promptFor(s),
      })),
    },
  };
}

// ---- the command line

/** where the human side of this genre writes what this script reads */
export const FRAME_FILE = 'genres/essays/frame.json';
export const ASSIGNMENTS_FILE = 'genres/essays/assignments.json';
export const WORKLIST_FILE = 'genres/essays/worklist.json';
export const SLOT_DIR = 'gen/essays';

/** the frame and the assignments, from data/ unless the flags point elsewhere */
export function inputs(argv: string[] = process.argv): { frame: Frame; assignments: Map<string, AssignmentEntry> } {
  const frameFile = path.resolve(flag('--frame', argv) ?? path.join(DATA, FRAME_FILE));
  const assignmentsFile = path.resolve(flag('--assignments', argv) ?? path.join(DATA, ASSIGNMENTS_FILE));
  for (const [what, file] of [['frame', frameFile], ['assignments', assignmentsFile]] as const) {
    if (!existsSync(file)) throw new Error(`the ${what} is missing at ${file}; the human side of this genre writes it`);
  }
  return { frame: readFrame(frameFile), assignments: readAssignments(assignmentsFile) };
}

/** the people's essays, when they are on this machine; the memorisation check is skipped when not */
export function corpusIfPresent(argv: string[] = process.argv): HumanCorpus | null {
  const named = flag('--human', argv);
  for (const file of named ? [named] : [path.join(OUT, 'essays-human.json'), path.join('cache', 'essays-human.json')]) {
    if (existsSync(path.resolve(file))) return loadHumanCorpus(path.resolve(file));
  }
  if (named) throw new Error(`no human essays at ${named}`);
  return null;
}

if (process.argv[1] && process.argv[1].endsWith('generate-essays.ts')) {
  const argv = process.argv;
  const has = (name: string): boolean => argv.includes(name);
  const only = flag('--arms')?.split(',').map((s) => s.trim()).filter(Boolean);
  const arms = MACHINE_ARMS.filter((a) => !only || only.includes(a.id));
  if (!arms.length) { console.error(`no arms named ${only?.join(', ')}; the arms are ${MACHINE_ARMS.map((a) => a.id).join(', ')}`); process.exit(1); }
  const slotDir = path.resolve(flag('--slot-dir') ?? path.join(OUT, SLOT_DIR));
  const { frame, assignments } = inputs();
  const { allocation, slots } = worklistFor(frame, assignments, {
    ...(flag('--slots') ? { slots: Number(flag('--slots')) } : {}),
    arms,
  });

  if (has('--worklist')) {
    const { listed, full } = worklistFiles(allocation, slots);
    const listedFile = path.join(DATA, WORKLIST_FILE);
    const fullFile = path.join(OUT, 'essays-worklist.json');
    writeAtomic(listedFile, body(listed));
    writeAtomic(fullFile, body(full));
    console.log(`${slots.length} slots for ${arms.length} arm(s), ${allocation.cells.length} cells used, ${allocation.skipped_cells.length} skipped`);
    for (const c of allocation.cells) console.log(`  ${c.prompt.padEnd(38)} grade ${String(c.grade).padStart(2)}  ${String(c.human).padStart(5)} human  ${(100 * c.share).toFixed(1).padStart(5)}%  ${String(c.slots).padStart(4)} slots per arm`);
    for (const c of allocation.skipped_cells) console.log(`  ${c.prompt.padEnd(38)} grade ${String(c.grade).padStart(2)}  ${String(c.human).padStart(5)} human  skipped (fewer than ${allocation.min_human_cell})`);
    console.log(`wrote ${listedFile} and ${fullFile}`);
    process.exit(0);
  }

  const corpus = corpusIfPresent();
  const { report, written } = mergeToDisk({
    arms, slots, root: DATA, slotDir, corpus,
    ...(has('--replace') ? { replace: true } : {}),
    ...(has('--strict-echo') ? { strictEcho: true } : {}),
    // a report says what is missing; it does not quietly commit whatever happens to be on disk
    ...(has('--report') ? { dryRun: true } : {}),
  });

  if (has('--report')) {
    // the file a driver reads: every slot still to write, with the prompt to send, so nothing is joined by hand
    const missingFile = path.join(OUT, 'essays-missing.json');
    const bySlot = new Map(slots.map((s) => [s.id, s]));
    writeAtomic(missingFile, body({
      genre: 'essays',
      note: 'Not committed. One entry per slot with no essay yet: send prompt_text, write the answer to out/gen/essays/<slot>.json, then merge.',
      slots: report.missing.map((id) => {
        const s = bySlot.get(id)!;
        return { id: s.id, arm: s.arm, prompt: s.prompt, grade: s.grade, prompt_sha256: sha256(promptFor(s)), prompt_text: promptFor(s) };
      }),
      rejected: report.rejected,
    }));
    console.log(`${report.missing.length} slots to write, ${report.kept + report.merged} written, ${report.rejected.length} rejected`);
    for (const id of report.missing.slice(0, 40)) console.log(`  missing ${id}`);
    if (report.missing.length > 40) console.log(`  ... and ${report.missing.length - 40} more, all of them in ${missingFile}`);
    for (const r of report.rejected) console.log(`  rejected ${r.slot}: ${r.reasons.join('; ')}`);
    process.exit(0);
  }

  console.log(`merged ${report.merged}, already committed ${report.kept}, missing ${report.missing.length}, rejected ${report.rejected.length}`);
  for (const r of report.rejected) console.error(`  rejected ${r.slot}: ${r.reasons.join('; ')}`);
  for (const id of report.conflicts) console.error(`  ${id}: the file in ${path.relative(process.cwd(), slotDir)} is not the committed essay; the committed one stands (--replace to take the new one)`);
  for (const c of report.sharedContexts) console.error(`  ${c.arm}: ${c.slots.join(', ')} were written in one context (${c.context}); the protocol is one essay per context`);
  if (!corpus) console.error('  the memorisation check did not run: out/essays-human.json is not on this machine');
  for (const f of written) console.log(`wrote ${path.relative(process.cwd(), f).split(path.sep).join('/')}`);
  if (report.rejected.length || report.sharedContexts.length) process.exit(1);
}
