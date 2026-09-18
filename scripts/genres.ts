/**
 * The kinds of writing, in one place.
 *
 * Every script and the page read this registry instead of naming arms themselves, so adding a kind
 * of writing is an entry here rather than a search through the code for "raid-". Two of the kinds are
 * a set of documents that a person wrote and that four models (RAID, MIT) were asked to write from
 * the same title. The third is a class and two models answering one assignment, which is not the same
 * document and is paired and published as what it is. Every kind also carries the comparison columns
 * they share.
 *
 * What an entry decides, and why it is decided here rather than in the script that uses it:
 *  - which arm is the person and which writer the verdict is decided against (GPT-4 in the two RAID
 *    kinds, as the page has always had it), and which writers the count across writers runs over. The
 *    count is over the writers the kind has, not over a fixed four: "k of 4" where RAID's four models
 *    wrote, "k of 2" in the essays, which have two;
 *  - whether the person's text may be quoted. arXiv abstracts are CC0. Reddit posts are other
 *    people's words under Reddit's and Pushshift's terms, so they are published as ids and numbers
 *    only, and a document's title (which the poster wrote) is not shown either. A student's essay is
 *    never published here at all, which is tighter than its licence asks;
 *  - how a machine arm is paired with the person where the ids cannot say it, and how much of the
 *    person the placebo splits (pairing, placebo);
 *  - where the person's text comes from and why it predates ChatGPT, with a link a reader can check.
 *
 * Three kinds. Email, chat, product reviews and other social platforms are not covered, and the page
 * says so (NOT_COVERED) rather than letting three kinds stand for all writing.
 */

/** the four RAID models the two RAID kinds of writing have, by RAID's own model names */
export type Model = 'chatgpt' | 'gpt4' | 'llama-chat' | 'mistral-chat';
export const MODELS: Model[] = ['chatgpt', 'gpt4', 'llama-chat', 'mistral-chat'];

/** what a column is called on the page, and the checkpoint behind it (RAID, Table 10 and App. E.2) */
export const MODEL_INFO: Record<Model, { short: string; snapshot: string }> = {
  chatgpt: { short: 'GPT-3.5', snapshot: 'gpt-3.5-turbo-0613' },
  gpt4: { short: 'GPT-4', snapshot: 'gpt-4-0613' },
  'llama-chat': { short: 'Llama', snapshot: 'Llama-2-70b-chat-hf' },
  'mistral-chat': { short: 'Mistral', snapshot: 'Mistral-7B-Instruct-v0.1' },
};

/** how RAID's rows were chosen: the collector filters on these columns, it does not rely on file order */
export const DECODING = 'greedy decoding, no repetition penalty';

export interface Writer {
  /** the arm id in data/ and on the page */
  id: string;
  /**
   * Who wrote it: the person, a RAID model, or a model this repository ran itself. `claude` is the
   * Claude arm generated here, through Claude Code. `llama3` is Llama 3 8B run locally through an
   * Ollama server: an open-weight model, not one of RAID's four, and the one writer in the essays
   * that is not the assistant this project was written with.
   */
  writer: 'human' | Model | 'claude' | 'llama3';
  /** the corpus file in out/ as it is first written, without ".json"; the measured file adds "-clean" */
  raw: string;
  label: string;
  short: string;
  /** whether this arm's own text may be quoted on the page and in data/ */
  quotable: boolean;
  /**
   * Counted in "k of n": one of the writers this kind of writing measures against the person, each by
   * the same rules as the headline verdict. A kind counts over the writers it has, never over a fixed
   * four: the abstracts and the posts have RAID's four models and say "k of 4", the essays have two
   * (Claude told it is a student, Llama 3 told the same) and must say "k of 2" and never "k of 4". An
   * arm that is there to describe rather than to be counted -- the Claude arm of the abstracts, the
   * plain arm of the essays -- is false here: it stays out of the correction and out of the count, and
   * is published beside them.
   */
  tested: boolean;
  /**
   * Where this arm's text lives in the repository, for an arm written here rather than downloaded: the
   * directory of generated records (one file per assignment, every essay with the prompt it was given,
   * the model and the hashes). Nobody can re-download such an arm, so the records are the only copy and
   * the measured file in out/ is written out from them on every run, which is how the weekly job
   * measures it like any other arm. The Claude arm of the abstracts predates this field and is still
   * named by the genre's own `generated`.
   */
  generated?: string;
}

export interface Genre {
  id: 'abstracts' | 'posts' | 'essays';
  /** the name on the genre switch and in the headline grid */
  label: string;
  /** the same name inside a sentence */
  inText: string;
  /** how the page words a document of this kind */
  noun: { one: string; many: string };
  /** what each writer was given, in the page's words */
  prompt: string;
  /** RAID's `domain` column, where the kind comes from RAID; a kind collected elsewhere has none */
  raidDomain?: 'abstracts' | 'reddit';
  /** the arm id of the person */
  reference: string;
  /** the arm id the headline verdict is decided against */
  decider: string;
  /** the person first, then the models, then any descriptive arm */
  writers: Writer[];
  /**
   * How a machine arm of this kind is paired with the person where the ids cannot say it
   * (src/measure.ts). Left out, an arm written from the person's own documents is paired document by
   * document and everything else by length, which is what the RAID kinds want. `prompt` is for a kind
   * where a person and a machine answered one assignment rather than one document: the pair is drawn
   * inside that assignment and one length band, and the published `pairing` field says `prompt`, so a
   * reader is never told two texts are the same document when they are two answers to one assignment.
   */
  pairing?: 'prompt';
  /**
   * How much of the person the placebo splits (src/measure.ts). Left out, the whole arm is cut in
   * half, which is what the two RAID kinds published before the option existed, so their numbers do
   * not move. `matched` cuts both halves to the size of the machine arm's own pairing, cell by cell,
   * and a kind whose person has far more texts than its machine arms needs it: the essays' 5,867
   * people's essays split about 2,900 against 2,900 would be a much larger experiment than the
   * 200-essay comparison standing beside it, and its ties would be about the 2,900.
   */
  placebo?: 'whole-reference' | 'matched';
  /**
   * Markers this kind of writing cannot show on either side, with the reason the page gives. They are
   * published as "not recorded", kept out of the correction and out of the count across writers: a
   * marker that no text can carry would otherwise read as a measured "no signal". The test is whether
   * the texts can carry it at all, not whether they happen to: a marker nobody used is rare, and lands
   * in "too few" like any other rare marker.
   */
  notRecorded?: Record<string, string>;
  humanQuotable: boolean;
  /**
   * Whether a document's title may be shown: a paper's title is a name, a Reddit title is a person's
   * words. `hide` also covers a kind whose documents have no titles at all, as the essays do not: the
   * page then prints none, which is what it should do when there is nothing to print.
   */
  titles: 'show' | 'hide';
  /** where the person's text comes from, and the evidence that it predates ChatGPT */
  source: { human: string; humanUrl: string; dates: string; datesUrl: string; licence: string; licenceUrl: string; people: string };
  /**
   * What the "one document, every writer" panel draws from: the documents the Claude arm covers, or,
   * where there is no Claude arm, the ones all four models cover.
   *
   * `assignment` is for a kind of writing where there is no shared document to open with. The essays'
   * writers answered one assignment, and the person's essay may never be shown, so the panel takes one
   * assignment (the teacher's words, published verbatim: see `assignments`), shows each machine
   * writer's essay to it in full, and gives the person's side as counts alone -- the same counts the
   * table rests on -- rather than as a blank column. The assignment is what the writers share, so it is
   * what the panel is about; it is not a title, and `titles` stays 'hide'.
   */
  documents: 'claude' | 'models' | 'assignment';
  /**
   * The assignments a kind of writing was written to, verbatim, as a path in the repository. Committed
   * because it is the only text of that corpus this project reproduces: the panel and the generation
   * record both quote it, and a reader cannot check the comparison without it. Only a kind whose panel
   * opens with an assignment has one.
   */
  assignments?: string;
  /**
   * The footnote every column of this kind that was written here rather than downloaded carries, with
   * "{columns}" where the page fills in which columns they are and how much each wrote, and
   * "{caveats}" where it links `url`, the section of the README that carries the full account. A kind
   * whose machine side comes from a published corpus has none.
   *
   * It lives here because it names writers, and neither the page nor the build may name a writer. What
   * it has to say is the same in every such kind: what wrote it and through what, when, what it was
   * given, whether the run can be repeated word for word, and that the assistant that wrote these arms
   * also wrote the page. The abstracts' sentence is the one the page carried before this field existed,
   * word for word, so moving it here changed nothing a reader of that kind sees.
   */
  writtenHere?: { note: string; url: string };
  /**
   * How the page describes the columns of this kind's table, where they are not one set of documents
   * written again by each model (the RAID sentence the page uses otherwise). Plain text; the page adds
   * the link to the person's source itself.
   */
  pairs?: string;
  /**
   * A sentence the page adds after "Not covered", for a kind of writing that was added although no
   * published set could supply its machine side, so a reader of that line knows the kind is covered and
   * where its machine side came from instead.
   */
  covered?: string;
  /** abstracts only: the arXiv version dates that decide which documents are left out (in data/) */
  datesFile?: string;
  /** abstracts only: the generated Claude arm (in the repository, since nobody can re-download it) */
  generated?: string;
  /** the collector's file of RAID titles and prompts per source_id (in out/), where it writes one */
  prompts?: string;
  /**
   * Where the titles are the person's words and hidden: the collector's file of titles per source_id
   * (in out/, never committed). The evidence reads it only to keep a model's text that repeats a
   * title off the page.
   */
  hiddenTitles?: string;
}

const raidWriters = (prefix: string, genre: string, quotableHuman: boolean): Writer[] => [
  { id: `${prefix}-human`, writer: 'human', raw: `${prefix}-human`, label: `human (RAID ${genre}: the documents every model was given)`, short: 'Person', quotable: quotableHuman, tested: false },
  ...MODELS.map((m): Writer => ({
    id: `${prefix}-${m}`, writer: m, raw: `${prefix}-${m}`,
    label: `${MODEL_INFO[m].short} (${MODEL_INFO[m].snapshot}, same documents)`, short: MODEL_INFO[m].short, quotable: true, tested: true,
  })),
];

export const GENRES: Genre[] = [
  {
    id: 'abstracts',
    label: 'Research abstracts',
    inText: 'research abstracts',
    noun: { one: 'abstract', many: 'abstracts' },
    prompt: 'the title of a real paper',
    raidDomain: 'abstracts',
    reference: 'raid-human',
    decider: 'raid-gpt4',
    writers: [
      ...raidWriters('raid', 'abstracts', true),
      // generated for this project rather than taken from a published corpus; see the README
      { id: 'raid-claude', writer: 'claude', raw: 'raid-claude', label: 'Claude Opus 5 via Claude Code (same documents, generated here)', short: 'Claude*', quotable: true, tested: false },
    ],
    humanQuotable: true,
    titles: 'show',
    source: {
      human: 'arXiv abstracts, via RAID',
      humanUrl: 'https://github.com/liamdugan/raid',
      // what was actually dated, and when the papers were first posted, comes from the lookup (cleaning.json)
      people: 'arXiv papers',
      dates: 'A paper with any arXiv version posted between 2022-11-30 and 2024-06-04 (the date of RAID’s file) is left out, since its text may have been revised after ChatGPT.',
      datesUrl: 'https://github.com/barbarkaragul-oss/is-it-really-an-ai-tell/blob/main/data/abstracts-dates.json',
      licence: 'arXiv metadata, abstracts included, is CC0',
      licenceUrl: 'https://info.arxiv.org/help/api/tou.html',
    },
    documents: 'claude',
    writtenHere: {
      note: 'Claude was generated for this project ({columns}, reached through Claude Code) and the same system wrote this page; {caveats} matter.',
      url: 'https://github.com/barbarkaragul-oss/is-it-really-an-ai-tell#a-claude-arm-generated-here',
    },
    datesFile: 'abstracts-dates.json',
    generated: 'data/generated/claude-abstracts.json',
    prompts: 'raid-prompts',
  },
  {
    id: 'posts',
    label: 'Reddit posts',
    inText: 'Reddit posts',
    noun: { one: 'post', many: 'posts' },
    prompt: 'the title of a real Reddit post',
    raidDomain: 'reddit',
    reference: 'posts-human',
    decider: 'posts-gpt4',
    writers: raidWriters('posts', 'Reddit posts', false),
    // The people's posts carry no line breaks at all, so every writer's post is read as flat text
    // (collector/fetch-raid.ts, flatText): list marks, heading marks and "**" are gone before counting.
    notRecorded: Object.fromEntries(['bulleted_bold', 'title_case_headings'].map((m) => [m,
      'Not recorded for Reddit posts: the people’s posts come without line breaks, so every post is compared as flat text, and a list or a heading cannot be seen in anyone’s.'])),
    humanQuotable: false,
    titles: 'hide',
    source: {
      human: 'Reddit posts from the 2021 file of sentence-transformers/reddit-title-body, via RAID',
      humanUrl: 'https://huggingface.co/datasets/sentence-transformers/reddit-title-body',
      people: 'Reddit, posted before mid-2021',
      dates: 'RAID took the 2021 file of a Pushshift-based dataset whose posts end in June 2021. That file is not filtered for bots or spam, so a post is pre-ChatGPT but not certainly a person’s.',
      datesUrl: 'https://github.com/liamdugan/raid/blob/main/generation/sources/README.md',
      licence: 'Reddit’s and Pushshift’s terms',
      licenceUrl: 'https://huggingface.co/datasets/sentence-transformers/reddit-title-body',
    },
    documents: 'models',
    hiddenTitles: 'posts-titles',
  },
  /**
   * School essays. The only kind here that is not from RAID, and the only one whose machine side was
   * written for this repository: a class answered an assignment, and Claude and Llama 3 were given the
   * same assignment, so a pair is two answers to one assignment rather than one document written
   * twice (pairing: 'prompt'). Two writers are counted, so this kind says "k of 2".
   *
   * One of the two is this project's own assistant, and the page and the README have to say so: both
   * Claude columns carry "*", and so does the Llama 3 column, which was written here too. Llama 3 is
   * an open-weight model run locally, the one writer here that is not this project's own assistant.
   */
  {
    id: 'essays',
    label: 'School essays',
    inText: 'school essays',
    noun: { one: 'essay', many: 'essays' },
    prompt: 'the assignment a class was given',
    reference: 'essays-human',
    decider: 'essays-claude-student',
    writers: [
      { id: 'essays-human', writer: 'human', raw: 'essays-human', label: 'school students (PERSUADE 2.0: the assignments every writer answered)', short: 'Person', quotable: false, tested: false },
      { id: 'essays-claude-student', writer: 'claude', raw: 'essays-claude-student', generated: 'data/generated/claude-essays', label: 'Claude Opus 5 via Claude Code, told it is a student in that grade (written here)', short: 'Claude*', quotable: true, tested: true },
      { id: 'essays-llama3-student', writer: 'llama3', raw: 'essays-llama3-student', generated: 'data/generated/llama3-essays', label: 'Llama 3 8B via Ollama, told it is a student in that grade (written here)', short: 'Llama 3*', quotable: true, tested: true },
      // descriptive, outside the correction and outside the count, as raid-claude is: the same
      // assignment with the student framing taken away, so the page can show what the framing moves
      { id: 'essays-claude-plain', writer: 'claude', raw: 'essays-claude-plain', generated: 'data/generated/claude-essays', label: 'Claude Opus 5 via Claude Code, given the assignment alone (written here)', short: 'Claude plain*', quotable: true, tested: false },
    ],
    pairing: 'prompt',
    placebo: 'matched',
    // No marker is not recorded here. The census over the 5,867 eligible essays
    // (data/genres/essays/census.json) is the place that decides it, and nothing qualifies: the essays
    // keep their line breaks, so a list, a heading and a dash can all be typed by either side. The dash
    // is the one to be careful about -- the corpus holds no "—" at all, but this project's marker counts
    // a dash however it is typed, and the people type 25 of them in 13 essays. A marker at a flat zero
    // there (bulleted_bold, title_case_headings, "leverage", "tapestry", "underscores") is still
    // recorded: the test is whether these texts could carry it, not whether anyone did, and a marker
    // nobody used lands in "too few" like any other rare one.
    humanQuotable: false,
    // these essays have no titles: nothing was collected and nothing is invented
    titles: 'hide',
    source: {
      // lower case: the page puts this inside a sentence ("the people’s texts are ...")
      human: 'school essays written for class by students in US schools, from the PERSUADE 2.0 corpus',
      humanUrl: 'https://github.com/scrosseye/persuade_corpus_2.0',
      people: 'US school students in grades 8 to 12, most of them in grade 8 or grade 11, writing to seven assignments; three of the seven ask for a letter',
      // what is committed is the release list itself, keyed by a hash of each essay's text and not by
      // its id: a spreadsheet damaged some ids on the way into the copy measured here, so the ids are
      // the one thing that cannot be joined on (data/genres/essays/frame.json, dating.joined_by)
      dates: 'Every essay measured here was released in the Kaggle Feedback Prize competition of December 2021, about eleven months before ChatGPT. That release list is committed, keyed by a hash of each essay’s text rather than by its id, so the date is evidence about each essay rather than about the corpus it came from.',
      datesUrl: 'https://github.com/barbarkaragul-oss/is-it-really-an-ai-tell/blob/main/data/genres/essays/kaggle-2021.json',
      licence: 'PERSUADE 2.0 (Crossley et al. 2024), CC BY-NC-SA 4.0; the students’ essays are counted here and never published',
      licenceUrl: 'https://github.com/scrosseye/persuade_corpus_2.0',
    },
    documents: 'assignment',
    assignments: 'data/genres/essays/assignments.json',
    writtenHere: {
      // what a reader needs before weighing these columns: written here, when, from what, that the run
      // cannot be replayed word for word and why, and that the assistant behind the Claude columns wrote
      // the page
      note: 'These columns were written for this project in September 2026, not taken from a published corpus: {columns}. Claude Opus 5 (through Claude Code) and Llama 3 8B (run locally through Ollama) were given the assignment alone: no student’s essay, and nothing about length. The essays cannot be written again word for word. Ollama’s seed did not give back the same essay when the same prompt was sent twice, and Claude Code exposes no sampling settings at all. What can be repeated is the measurement, from the essays as committed, each with the prompt it was given. The same assistant that wrote the Claude columns also wrote this page; {caveats} matter.',
      url: 'https://github.com/barbarkaragul-oss/is-it-really-an-ai-tell#school-essays',
    },
    pairs: 'Here no model was given a document to rewrite. The students and the models answered the same assignment, and a model’s essay is compared with a student’s essay written to the same assignment and of about the same length. In the other kinds of writing each model rewrites the very document the person wrote, so the pairs there are tighter than these.',
    covered: 'Student essays are covered, with the machine side written for this project rather than taken from a published set; the note under that kind’s table says by what and when.',
  },
];

export interface Comparison { id: string; label: string; short: string; long: string; kind: 'human' | 'machine'; raw: string; quotable: false }

/**
 * The comparison columns every kind of writing shares. They are other kinds of text, so they are
 * matched by length, never by document, and they decide only whether a marker is about register.
 */
export const COMPARISON: Comparison[] = [
  { id: 'casual-human', label: 'casual writing: online comments from before ChatGPT (Hacker News)', short: 'Casual writing', long: 'Casual writing: everyday online comments posted before ChatGPT existed (source: Hacker News)', kind: 'human', raw: 'casual-human', quotable: false },
  { id: 'careful-human', label: 'careful writing: edited Q&A answers from the same period (Stack Exchange)', short: 'Careful writing', long: 'Careful writing: edited question-and-answer posts from the same period (source: Stack Exchange)', kind: 'human', raw: 'careful-human', quotable: false },
  { id: 'hc3-gpt35', label: 'GPT-3.5 answering questions (HC3, a different genre)', short: 'GPT-3.5 Q&A', long: 'GPT-3.5 answering questions: a different task, kept for contrast (source: HC3)', kind: 'machine', raw: 'machine-2023', quotable: false },
];
export const CASUAL = 'casual-human';

/** what the page says it does not cover, so three kinds of writing are not read as all of writing */
export const NOT_COVERED = 'email, chat, product reviews, and social platforms other than Reddit, such as X, Facebook and LinkedIn';

export const genreById = new Map(GENRES.map((g) => [g.id, g]));

/** the genre a writer belongs to, and the writer; comparison arms belong to none */
export function writerById(id: string): { genre: Genre; writer: Writer } | null {
  for (const genre of GENRES) {
    const writer = genre.writers.find((w) => w.id === id);
    if (writer) return { genre, writer };
  }
  return null;
}

/** the arm of a genre written by a given RAID model */
export const modelArm = (g: Genre, m: Model): Writer | undefined => g.writers.find((w) => w.writer === m);

/**
 * The writers a kind of writing counts across. "k of n" runs over these and nobody else, so n is 4
 * where RAID's four models wrote the same documents and 2 in the essays, and no script may assume a
 * fixed four again. A descriptive arm (the Claude arm of the abstracts, the plain arm of the essays)
 * is not here, which is what keeps it out of the count and out of the correction.
 */
export const testedWriters = (g: Genre): Writer[] => g.writers.filter((w) => w.tested);

/** the checkpoint behind a writer, where a published corpus names one; an arm written here has none */
export const snapshotOf = (w: Writer): string | null =>
  MODELS.includes(w.writer as Model) ? MODEL_INFO[w.writer as Model].snapshot : null;

/**
 * How a kind of writing's machine arms were decoded, where one setting covers every writer of that
 * kind: RAID fixed it for all four of its models, so the page can say it once under the column. An arm
 * written here records its own settings beside the text it wrote (data/generated), which is not one
 * line about the kind, so such a kind says nothing here rather than something vague.
 */
export const decodingOf = (g: Genre): string | null => (g.raidDomain ? DECODING : null);
