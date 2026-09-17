/**
 * The kinds of writing, in one place.
 *
 * Every script and the page read this registry instead of naming arms themselves, so adding a kind
 * of writing is an entry here rather than a search through the code for "raid-". Each kind is a set
 * of documents that a person wrote and that four models (RAID, MIT) were asked to write from the
 * same title, plus the comparison columns every kind shares.
 *
 * What an entry decides, and why it is decided here rather than in the script that uses it:
 *  - which arm is the person and which model the verdict is decided against (GPT-4, as the page has
 *    always had it), and which models the "k of 4" count runs over;
 *  - whether the person's text may be quoted. arXiv abstracts are CC0. Reddit posts are other
 *    people's words under Reddit's and Pushshift's terms, so they are published as ids and numbers
 *    only, and a document's title (which the poster wrote) is not shown either;
 *  - where the person's text comes from and why it predates ChatGPT, with a link a reader can check.
 *
 * Release 1 has two kinds. Email, chat, product reviews and other social platforms are not covered,
 * and the page says so (NOT_COVERED) rather than letting two kinds stand for all writing.
 */

/** the four RAID models every kind of writing has, by RAID's own model names */
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
  /** who wrote it: the person, a RAID model, or the Claude arm generated for this repository */
  writer: 'human' | Model | 'claude';
  /** the corpus file in out/ as it is first written, without ".json"; the measured file adds "-clean" */
  raw: string;
  label: string;
  short: string;
  /** whether this arm's own text may be quoted on the page and in data/ */
  quotable: boolean;
  /** counted in "k of 4": one of the four RAID models */
  tested: boolean;
}

export interface Genre {
  id: 'abstracts' | 'posts';
  /** the name on the genre switch and in the headline grid */
  label: string;
  /** the same name inside a sentence */
  inText: string;
  /** how the page words a document of this kind */
  noun: { one: string; many: string };
  /** what each writer was given, in the page's words */
  prompt: string;
  /** RAID's `domain` column */
  raidDomain: 'abstracts' | 'reddit';
  /** the arm id of the person */
  reference: string;
  /** the arm id the headline verdict is decided against */
  decider: string;
  /** the person first, then the models, then any descriptive arm */
  writers: Writer[];
  /**
   * Markers this kind of writing cannot show on either side, with the reason the page gives. They are
   * published as "not recorded", kept out of the correction and out of "k of 4": a marker that no text
   * can carry would otherwise read as a measured "no signal".
   */
  notRecorded?: Record<string, string>;
  humanQuotable: boolean;
  /** whether a document's title may be shown: a paper's title is a name, a Reddit title is a person's words */
  titles: 'show' | 'hide';
  /** where the person's text comes from, and the evidence that it predates ChatGPT */
  source: { human: string; humanUrl: string; dates: string; datesUrl: string; licence: string; licenceUrl: string; people: string };
  /**
   * The documents the "one document, every writer" panel draws from: the ones the Claude arm covers,
   * or, where there is no Claude arm, the ones all four models cover.
   */
  documents: 'claude' | 'models';
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

/** what the page says it does not cover, so two kinds of writing are not read as all of writing */
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
