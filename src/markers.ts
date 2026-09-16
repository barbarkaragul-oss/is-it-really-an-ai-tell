/**
 * The catalogue: every marker people read as a sign that a machine wrote the text.
 *
 * A marker is a function from a text to true or false. Nothing here asserts that a marker means
 * anything -- the rates in data/markers.json say what each one is worth, and several of them turn
 * out to be worth nothing, or to point the other way.
 *
 * `belief` marks the ones people are documented to rely on when they judge by hand (Jakesch et al.,
 * PNAS 2023): contractions, first-person, personal detail. Those are in the catalogue precisely so
 * their measured value can be published next to the rest.
 */

export type Family = 'word' | 'phrase' | 'shape' | 'surface';

export interface Marker {
  id: string;
  /** what a reader would call it */
  label: string;
  family: Family;
  /** where the claim comes from, so a reader can argue with the source rather than with me */
  source: string;
  /** true when this is something people believe distinguishes, rather than something measured */
  belief?: boolean;
  test: (text: string) => boolean;
  /**
   * How many times the marker occurs, for the markers where that means something. A word can be
   * counted and turned into a rate per thousand words, which does not care how long the text is;
   * "every sentence the same length" cannot, and those markers leave this undefined.
   */
  count?: (text: string) => number;
  /** the expression behind test and count, for the markers that are one; used to show what matched */
  pattern?: RegExp;
  /** the match carries the writer's own words ("not only X but also"), so it is text, not a form */
  openEnded?: boolean;
}

export const words = (t: string): string[] => t.toLowerCase().match(/[a-z']+/g) ?? [];
export const sentences = (t: string): string[] => t.split(/(?<=[.!?])\s+/).filter((s) => s.trim().length > 1);

/** coefficient of variation of sentence length; low means every sentence is the same size */
export function sentenceLengthCv(t: string): number | null {
  const ls = sentences(t).map((s) => words(s).length).filter((n) => n > 0);
  if (ls.length < 5) return null;
  const mean = ls.reduce((a, b) => a + b, 0) / ls.length;
  if (mean === 0) return null;
  const sd = Math.sqrt(ls.reduce((a, b) => a + (b - mean) ** 2, 0) / ls.length);
  return sd / mean;
}

const has = (re: RegExp) => (t: string): boolean => re.test(t);
/** a word or phrase: it can be tested for and it can be counted */
const counts = (re: RegExp): Pick<Marker, 'test' | 'count' | 'pattern'> => {
  const global = new RegExp(re.source, re.flags.includes('g') ? re.flags : re.flags + 'g');
  return { test: (t) => re.test(t), count: (t) => (t.match(global) ?? []).length, pattern: global };
};

export const MARKERS: Marker[] = [
  // ---- single words said to be the giveaways
  { id: 'delve', label: '“delve”', family: 'word', source: 'Kobak et al. 2025; the most-cited single tell', ...counts(/\bdelv(e|es|ing|ed)\b/i) },
  { id: 'tapestry', label: '“tapestry”', family: 'word', source: 'widely repeated word lists', ...counts(/\btapestr(y|ies)\b/i) },
  { id: 'moreover', label: '“moreover”', family: 'word', source: 'widely repeated word lists', ...counts(/\bmoreover\b/i) },
  { id: 'furthermore', label: '“furthermore”', family: 'word', source: 'widely repeated word lists', ...counts(/\bfurthermore\b/i) },
  { id: 'crucial', label: '“crucial”', family: 'word', source: 'Kobak et al. 2025 excess vocabulary', ...counts(/\bcrucial(ly)?\b/i) },
  { id: 'realm', label: '“realm”', family: 'word', source: 'widely repeated word lists', ...counts(/\brealms?\b/i) },
  { id: 'showcase', label: '“showcase”', family: 'word', source: 'Kobak et al. 2025 excess vocabulary', ...counts(/\bshowcas(e|es|ing|ed)\b/i) },
  { id: 'underscore', label: '“underscores”', family: 'word', source: 'Kobak et al. 2025 excess vocabulary', ...counts(/\bunderscor(e|es|ing|ed)\b/i) },
  // The bare noun ("as much leverage", "100x leverage") and the financial adjective ("leveraged
  // trades") are excluded; "the potential of leveraging data" is still the verb. In the matched RAID
  // arms every use is the verb, which data/evidence.json shows.
  { id: 'leverage', label: '“leverage” as a verb', family: 'word', source: 'widely repeated word lists', ...counts(/\b(?:(?<!\b(?:much|real|no|of|the|a|some|any|more|less|enough|financial|political|operating|\d+x)\s)leverage|leverag(?:es|ing|ed))\b(?!\s+(?:trades?|buyouts?|loans?|positions?|etfs?|ratios?)\b)/i) },

  // ---- phrases
  { id: 'important_to_note', label: '“it is important to note” / “worth noting”', family: 'phrase', source: 'hedging formula', ...counts(/\bit('s| is) (important|worth) (to )?not(e|ing)\b/i) },
  { id: 'in_todays', label: '“in today’s …”', family: 'phrase', source: 'opener cliche', ...counts(/\bin today's\b/i) },
  { id: 'not_only_but_also', openEnded: true, label: '“not only … but also”', family: 'phrase', source: 'balanced construction', ...counts(/\bnot only\b[^.!?]{0,80}\bbut also\b/i) },
  { id: 'not_x_its_y', openEnded: true, label: '“it’s not X, it’s Y”', family: 'phrase', source: 'the antithesis formula', ...counts(/\bit('s| is) not (just |only |merely )?[^.!?,;]{2,40}[,—-] it('s| is)\b/i) },
  { id: 'dive_into', label: '“dive into” / “let’s explore”', family: 'phrase', source: 'assistant register', ...counts(/\b(dive into|let('s| us) (explore|take a look|dive))\b/i) },
  { id: 'in_conclusion', label: '“in conclusion” / “in summary”', family: 'phrase', source: 'essay scaffolding', ...counts(/\b(in conclusion|in summary|to sum up)\b/i) },

  // ---- shape of the prose
  { id: 'uniform_sentences', label: 'every sentence the same length', family: 'shape', source: 'low variation in sentence length', test: (t) => { const cv = sentenceLengthCv(t); return cv !== null && cv < 0.40; } },
  { id: 'em_dash', label: 'an em dash', family: 'shape', source: 'the most-claimed punctuation tell', ...counts(/—/) },
  { id: 'em_dash_heavy', label: 'two or more em dashes', family: 'shape', source: 'the same claim, stronger form', test: (t) => (t.match(/—/g) ?? []).length >= 2 },
  { id: 'rule_of_three', openEnded: true, label: 'a three-item list in one sentence', family: 'shape', source: 'the tricolon habit', ...counts(/\b\w+, \w+,? and \w+\b/) },
  { id: 'bulleted_bold', label: 'a bulleted list with bold lead-ins', family: 'shape', source: 'answer formatting', test: has(/^\s*[-*•]\s+\*\*/m) },

  // ---- surface habits, including the ones people actually judge by
  { id: 'no_contraction', label: 'no contractions at all', family: 'surface', source: 'Jakesch et al. 2023: readers treat contractions as human', belief: true, test: (t) => !/\b\w+'(t|s|re|ve|ll|d|m)\b/i.test(t) },
  { id: 'no_first_person', label: 'no first person', family: 'surface', source: 'Jakesch et al. 2023: readers treat “I” as human', belief: true, test: (t) => !/\b(i|i'm|i've|i'd|i'll|my|me|myself)\b/i.test(t) },
  { id: 'no_personal_detail', label: 'no personal or concrete detail', family: 'surface', source: 'Jakesch et al. 2023: readers treat specifics as human', belief: true, test: (t) => !/\b(my (wife|husband|kid|son|daughter|dad|mum|mom|friend|boss|team)|last (year|week|night|summer)|when i was|in \d{4})\b/i.test(t) },
  { id: 'no_typo_markers', label: 'no informal spelling at all', family: 'surface', source: 'readers treat sloppiness as human', belief: true, test: (t) => !/\b(gonna|wanna|kinda|sorta|dunno|yeah|nope|lol|imo|iirc|afaik|tbh)\b/i.test(t) },
  { id: 'title_case_headings', label: 'Title Case headings', family: 'surface', source: 'answer formatting', test: has(/^#{1,6}\s+([A-Z][a-z]+\s+){2,}/m) },
];

export const byId = new Map(MARKERS.map((m) => [m.id, m]));
