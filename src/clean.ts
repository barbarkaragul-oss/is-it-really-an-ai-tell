/**
 * Two checks on a model's text before any marker is counted on it: did it finish, and is it the text
 * it was asked for at all. Both are pure functions of the text, used by scripts/contamination.ts on
 * every RAID model arm of every kind of writing, and never on the person's text: a person's post may
 * end without a full stop, and that is data.
 *
 * Cut off. RAID capped every generation at 512 tokens: `max_tokens: 512` for the OpenAI models, and
 * `max_length: 512` for the Hugging Face ones, where the prompt counts too
 * (https://github.com/liamdugan/raid/tree/main/generation/models). A text that reached the cap stops
 * wherever the cap fell, often mid-word, and loses its ending and every marker that lives there (203
 * of 1,499 Llama chat abstracts ended that way). Reddit posts show why "no full stop" alone is not the
 * test: below the cap, the models' posts that end without one end on an emoji, hashtags, a sign-off
 * with a name or a "[Your Name]" slot, or a CJK stop, and those are finished. So a text is cut off
 * when it ends in a loop of repeated words (which only the cap ends), or when its ending is not one
 * of those finished forms and either
 *  - it ends inside a clause (a comma, colon, semicolon, dash, opening bracket or quote, or half a
 *    contraction), which no finished text does at any length, or
 *  - it is long enough to have reached the model's cap. Length is estimated, since RAID's tokenizers
 *    are not here; the thresholds sit below the shortest text seen stopping at the cap, and a shorter
 *    text that simply ends without a stop ("Any advice would be appreciated") is kept, since leaving
 *    those out would drop the most casual machine texts and flatter the machine arm's style.
 *
 * Not the text asked for. A refusal, an answer or a lecture addressed to whoever asked ("I'm sorry to
 * hear your PC won't boot", "I understand that you want me to write ..."), a preamble ("Sure, here's a
 * possible Reddit post:", 'The abstract for the academic paper titled "..." is as follows:'), a
 * description of the text instead of the text ("The abstract would likely describe ..."), a label
 * ("Body:", "Title:", "Abstract:"), a note to the requester, or a slot left for them to fill ("[Your
 * Name]") is the model talking about the task. Such a text is dropped whole, a slot in a sign-off
 * included: what remains after cutting the preamble or the slot off would still be one the model
 * framed as a draft for someone else. Each pattern needs the assistant's voice or the task's words,
 * because the same verbs are ordinary post text ("I can't help but feel", "I can't provide for my
 * kids").
 */

// ---- cut off

/** a sentence end, with anything that may close after it: quotes, brackets, emphasis */
const STOPPED = /[.!?…。！？‼⁉](?:["'”’»)\]}*_]|\s)*$/u;

/**
 * Endings that finish a text without a stop: an emoji (with its modifiers), an emoticon, hashtags, a
 * bracketed slot or stage direction ("[Your Name]", "[End of post]"), a link, a rule line.
 */
const FINISHED = [
  /\p{Extended_Pictographic}[\u{FE0E}\u{FE0F}\u{1F3FB}-\u{1F3FF}\u{200D}\u{20E3}]*["'”’)\]]*\s*$/u,
  /(?:^|\s)(?:[:;=8xX]-?[)(DPpOo3\]\[|/\\]+|<3+|\^_?\^|[Tt]_[Tt])\s*$/,
  /(?:^|\s)#[\p{L}\p{N}_]+\s*$/u,
  /[\])}]\s*$/,
  /https?:\/\/\S+\s*$/,
  /(?:^|\s)(?:-{3,}|\*{3,}|_{3,})\s*$/,
];

/**
 * A signature after the last sentence, as a flattened post shows it: a sign-off and a comma, then at
 * most four words ("Best, Sam", "Thanks for reading, A fellow redditor"), or one to three capitalised
 * words alone ("The Mod Team"). The last of those words must be able to end a name: "... as always.
 * The" is a cut, not a signature.
 */
const SIGN_OFF = /(?:^|[.!?…]["'”’)]*\s+)(?:thanks|thank you|many thanks|cheers|best|best wishes|regards|best regards|kind regards|warm regards|sincerely|yours|yours truly|love|peace|take care|stay safe|all the best|xoxo|hugs)(?:\s+[^\s,.!?]+){0,4}\s*,\s*(?:[^\s.!?,]+\s+){0,3}([^\s.!?,]+)$/iu;
const SIGNATURE = /[.!?…]["'”’)]*\s+(?:[A-Z][\p{L}'’-]*\s+){0,2}([A-Z][\p{L}'’-]*)$/u;
const NOT_A_NAME = /^(?:A|An|The|And|Or|But|Of|To|In|On|At|For|With|From|By|As|If|So|My|Your|Our|Their|His|Her|Its|This|That|These|Those|I|We|You|They|He|She|It|There|Here|When|While|Because|Although|Every|Each|Some|Any|No|Not|Is|Are|Was|Were|Be|Have|Has|Had|Do|Does|Did|Can|Could|Will|Would|Should|May|Might|Must|Also|Then|Than|Just|Even|Still|After|Before|Since|Until|Unless|Whether|What|Which|Who|Where|How|Why)$/;

/** a comma, colon, semicolon, dash, joining symbol, opening bracket or quote, or "can'" */
const INSIDE_A_CLAUSE = /(?:[,;:(\[{“‘\-–—/&+=]|\p{L}['’])\s*$/u;

/**
 * About how many tokens a text is, on a scale of its own. ASCII letters are taken in runs of at most
 * four, which is near what the tokenizers do with English words and far closer than whole words for a
 * string of repeated letters; every other letter, digit, symbol and emoji counts alone, since the
 * tokenizers of 2023 spent a token or more on most of them. English prose comes out at about 1.25
 * times its GPT token count.
 */
export function approxTokens(text: string): number {
  return (text.match(/[A-Za-z]{1,4}|[^\sA-Za-z]/gu) ?? []).length;
}

/**
 * The length, in approxTokens, from which a text of this model may have met RAID's cap. Measured on
 * RAID's research abstracts and Reddit posts: the shortest English text that stopped mid-sentence
 * came at 653 for GPT-4 and 683 for GPT-3.5 (the OpenAI cap is 512 new tokens), and at 433 for Mistral
 * and 472 for Llama (the Hugging Face cap of 512 also counts the prompt, and their tokenizers split
 * words finer). Texts in Greek or Turkish stopped far shorter on this scale, because the tokenizers
 * spend more on them than the estimate does, so the thresholds sit well below the English ones; no
 * English text in that data ends unfinished between a threshold and the shortest cut. An unknown
 * model gets the lowest, so the check errs toward reporting a text.
 */
export const CAP_FROM: Record<string, number> = {
  chatgpt: 470,
  gpt4: 470,
  'llama-chat': 330,
  'mistral-chat': 330,
};
const CAP_UNKNOWN = Math.min(...Object.values(CAP_FROM));

/**
 * Whether the text ends in a loop: the same words over and over (at least three times and twelve
 * words), with the last copy possibly cut short. A model caught in a loop does not stop by itself,
 * so such a text ran until the cap stopped it, even when the cut fell after a full stop.
 */
export function endsInLoop(text: string): boolean {
  const w = text.toLowerCase().match(/[\p{L}\p{N}'’]+/gu) ?? [];
  for (let n = 1; n <= 12; n++) {
    const copies = Math.max(3, Math.ceil(12 / n));
    for (let cut = 0; cut < n; cut++) {
      const end = w.length - cut;
      if (end < n * copies) break;
      let same = true;
      for (let i = end - n * copies; i < end - n && same; i++) same = w[i] === w[i + n];
      if (same) return true;
    }
  }
  return false;
}

/** Why a text's ending is finished, or null when it is not one of the finished forms. */
export function finishedEnding(text: string): string | null {
  const t = text.trimEnd();
  if (!t) return null;
  if (STOPPED.test(t)) return 'stop';
  if (FINISHED.some((re) => re.test(t))) return 'symbol';
  if (INSIDE_A_CLAUSE.test(t)) return null;
  const signed = SIGN_OFF.exec(t) ?? SIGNATURE.exec(t);
  if (signed && !NOT_A_NAME.test(signed[1]!.replace(/^\p{L}/u, (c) => c.toUpperCase()))) return 'signature';
  return null;
}

/**
 * A list marker with nothing after it: the model had started the next item when the cap fell. On
 * its own line ("...\n2."), or, in a text whose lines were joined, as a sentence of its own after a
 * full stop ("Mixed the flour. 2."). "rated it a 10." is a sentence that ends in a number, not this.
 */
const BARE_LIST_MARKER = /(?:^|\n|[.!?]["'”’)\]]*[^\S\n]+)[^\S\n]*(?:\d{1,2}[.)]|[*•+])\s*$/;

/**
 * Whether the text ends inside a quotation or a bracket it opened: the last curly quote or bracket is
 * an opening one, or the straight quotes are odd in number and the last one opens (a space or an
 * opening bracket before it, a letter after it). A stray straight quote or an inch mark earlier in
 * the text is not this, and an emoticon's bracket (":(") is not a bracket. It is only asked of a text
 * long enough to have met the cap, where a writer's own unclosed quote is rare.
 */
export function endsInsideQuote(text: string): boolean {
  const t = text.trimEnd();
  if (t.lastIndexOf('“') > t.lastIndexOf('”')) return true;
  const last = (re: RegExp): number => Math.max(-1, ...[...t.matchAll(re)].map((m) => m.index));
  if (last(/\((?=[\p{L}\p{N}"“'‘])/gu) > last(/(?<!(?:^|\s)[:;=8xX]-?)\)/g)) return true;
  const quotes = [...t.matchAll(/"/g)].map((m) => m.index);
  if (quotes.length % 2 === 0) return false;
  const i = quotes[quotes.length - 1]!;
  return (i === 0 || /[\s(\[]/.test(t[i - 1]!)) && /[\p{L}\p{N}]/u.test(t[i + 1] ?? '');
}

/**
 * Whether a model's text stopped before it was finished. `model` is RAID's model name; see the file
 * comment for the rule. Two more cut-offs look finished and are caught here: a bare list marker at the
 * end, and, in a text long enough to have met the cap, a quotation or bracket left open ('saying, "I'm
 * not good enough for love.'), where the cap fell right after a full stop inside the quote.
 */
export function isTruncated(text: string, model?: string): boolean {
  const t = text.trimEnd();
  if (!t) return true;
  if (endsInLoop(t)) return true;
  if (BARE_LIST_MARKER.test(t)) return true;
  const cap = (model !== undefined ? CAP_FROM[model] : undefined) ?? CAP_UNKNOWN;
  const long = approxTokens(t) >= cap;
  if (finishedEnding(t)) return long && endsInsideQuote(t);
  if (INSIDE_A_CLAUSE.test(t)) return true;
  return long;
}

// ---- not in English

/** the commonest English words, which any English text is full of and other languages lack */
const FUNCTION_WORDS = new Set(['the', 'and', 'to', 'i', 'a', 'of', 'is', 'it', 'that', 'in', 'my', 'you', 'for', 'this', 'with', 'was', 'but', 'have', 'on', 'be', 'we', 'are', 'as', 'by', 'an', 'or', 'not', 'from', 'at', 'which']);

/**
 * Whether a text is in English, by the share of its words that are English function words: about a
 * third in English prose, a research abstract included, and a few in a text in Turkish, Russian,
 * Spanish or Chinese. The markers are English patterns, so a text in another language adds words to
 * its arm and nothing else. A text with no letters is not English.
 */
export function englishShare(text: string): number {
  const all = text.match(/\p{L}+/gu) ?? [];
  if (!all.length) return 0;
  return all.filter((w) => FUNCTION_WORDS.has(w.toLowerCase())).length / all.length;
}
export const ENGLISH_FROM = 0.12;
export const isEnglish = (text: string): boolean => englishShare(text) >= ENGLISH_FROM;

// ---- not the text asked for

export type MetaKind = 'refusal' | 'assistant' | 'preamble' | 'label' | 'description' | 'note' | 'placeholder';

const OPENING = 300;

/**
 * The rules. Each was checked against the model texts it drops, and 20 or more of the texts the
 * whole list keeps were read in every model arm of both kinds of writing before the list was frozen.
 * Every rule runs on both kinds of writing, since the models' voices are the same in both; the rules
 * written for abstracts drop no model's post.
 */
const META: { kind: MetaKind; where: 'start' | 'anywhere'; re: RegExp }[] = [
  // "I cannot provide a response that ...", "I'm sorry, but I cannot provide the body of a Reddit post",
  // "I'm sorry, but I can't assist with that." The refusal must be about the task or a policy.
  {
    kind: 'refusal', where: 'start',
    re: /\bI(?:['’]m| am)?\s*(?:cannot|can['’]?t|can not|will not|won['’]t|(?:am |['’]m )?(?:not able|unable) to)\s+(?:provide|fulfil+|create|generate|assist|comply|complete|write|answer|respond|help with|engage|produce|continue)\b[\s\S]{0,160}?(?:\b(?:request|prompt|body of|reddit post|this post|a response|appropriate|inappropriate|harmful|offensive|ethical|unethical|policy|policies|guidelines|programming|language model|guidance|information (?:or|on|about)|without (?:the|more|any|additional) (?:title|context|information|details))\b|\bAI\b|\b(?:with|fulfil+) (?:that|this)(?: request)?\s*[.!]?\s*$)/i,
  },
  { kind: 'refusal', where: 'start', re: /^\W*I apologi[sz]e,? but\b/i },
  // an assistant answering whoever asked, instead of writing the post
  { kind: 'assistant', where: 'anywhere', re: /\bI(?:['’]m| am) (?:just |only )?an? (?:AI|artificial intelligence|language model|chatbot|virtual assistant)\b|\bas an? (?:responsible )?(?:AI|artificial intelligence)(?: language model| assistant)?\s*,/i },
  { kind: 'assistant', where: 'start', re: /^\W*(?:I['’]m|I am) (?:so |very |really )?sorry to hear (?:that|about)\b/i },
  { kind: 'assistant', where: 'start', re: /^\W*(?:sure|certainly|of course|absolutely)\s*[,!.]?\s*(?:I can (?:help|write|create|provide|give)|I['’]d be (?:happy|glad) to|I (?:will|['’]ll) (?:write|create|provide|help)|let me (?:write|create|provide|help|explain))\b/i },
  // a lecture to whoever asked, instead of the post: "I understand that you want me to write ..., but",
  // "However, I must advise against using language that ..."
  { kind: 'assistant', where: 'start', re: /^\W*I understand (?:that )?you(?:['’]re| are| want| may| might| would| have)\b/i },
  // a post that opens by objecting to its own title: "I don't think it's appropriate or respectful to
  // suggest that there is a "best way" to ..."; later in a post, the same words are an opinion
  { kind: 'assistant', where: 'start', re: /^\W*(?:I (?:don['’]t|do not) think (?:it['’]?s|it is)|(?:it['’]?s|it is) not) (?:appropriate|respectful|accurate|fair)(?: or \w+)? to (?:suggest|say|assume|imply|ask|claim)\b/i },
  { kind: 'assistant', where: 'anywhere', re: /\bI must (?:remind you|advise against|caution (?:you|against))\b|\bI (?:would|['’]d) (?:like to )?(?:advise|caution) against\b/i },
  // "Sure, here's a possible Reddit post:"; without the "Sure", only a task word makes "Here's ...:"
  // a preamble, since "Here's the thing:" opens many posts
  { kind: 'preamble', where: 'start', re: /^\W*(?:sure|certainly|of course|absolutely|okay|ok|alright)\b[^\n]{0,40}?\bhere(?:['’]s| is| are)\b/i },
  { kind: 'preamble', where: 'start', re: /^\W*(?:I['’]m|I am|I['’]d be|I would be) (?:happy|glad) to help(?: you)?(?: with (?:that|this))?\s*[!.,]?\s+here(?:['’]s| is| are)\b/i },
  { kind: 'preamble', where: 'start', re: /^\W*here(?:['’]s| is| are)\s+(?:(?:a|an|the|my|your)\s+)?(?:possible |sample |potential |draft |revised |suggested )?(?:body|reddit post|post|abstract|response|version|draft)\b[^\n]{0,100}?:/i },
  { kind: 'preamble', where: 'anywhere', re: /\bhere(?:['’]s| is) (?:a |an |the |my )?(?:possible |sample |potential |draft |revised |suggested )?(?:body|reddit post|abstract)\b[^\n.]{0,100}:/i },
  // RAID asked for "the abstract for the academic paper titled ...", and Mistral and Llama often
  // answer about that abstract: 'The abstract for the academic paper titled "..." is as follows:',
  // "The abstract of an academic paper should provide ...", "Here is an example of an abstract:"
  { kind: 'preamble', where: 'start', re: /^\W*(?:the|an?|this)\s+(?:possible |sample |potential |hypothetical )?abstract\s+(?:for|of)\s+(?:the|an?|this)\s+(?:academic\s+|research\s+|scientific\s+)?(?:paper|article|study)\b/i },
  { kind: 'preamble', where: 'anywhere', re: /\bhere(?:['’]s| is) (?:an? )?(?:example|sample|possible \w+|draft) of (?:an? |the |what (?:the|an?) )?abstract\b/i },
  // A description of the abstract or of the paper instead of the abstract, in the prompt's own words:
  // "The abstract would likely describe ...", "<title> is an academic paper that presents ...", "In
  // the paper titled "..." the authors ...", 'The paper "<title>" presents ...'. No abstract calls its
  // own paper "an academic paper" or names it by its title in quotes, and the title written out again
  // is the paper's authors' words inside the model's text.
  { kind: 'description', where: 'anywhere', re: /\b(?:the|this|an?|its) abstract (?:would|will|should|could|might|may) (?:likely |probably |typically |also )?(?:describe|discuss|include|provide|present|focus|cover|summari[sz]e|highlight|outline|explain|begin|start|mention|detail)\b|\bthe (?:paper|article|study) would (?:likely|probably)\b/i },
  { kind: 'description', where: 'anywhere', re: /\bis an? academic (?:paper|article)\b|\b(?:the|this|an?) (?:academic )?(?:paper|article|study) (?:(?:titled|entitled)\s*)?["“]/i },
  // a label for the part being written: at the very start, on a line of its own, or, in a text whose
  // lines are joined (every Reddit post here), after the end of a sentence ("... as follows: Title:").
  // "Abstract:" is a label wherever it stands, often after the title written out again.
  { kind: 'label', where: 'start', re: /^[\W_]*(?:title|body|post|post body|subject|reddit post|abstract|headline)\s*[*_]*\s*:/i },
  { kind: 'label', where: 'anywhere', re: /(?:^|\n)[\W_]*(?:title|body)\s*[*_]*\s*:/i },
  { kind: 'label', where: 'anywhere', re: /[.!?;"”:]\s+(?:Title|Body)\s*:|\b(?:Abstract|ABSTRACT)\s*:/ },
  // a note to the requester; "Note: I'm on mobile" is a post's own
  { kind: 'note', where: 'anywhere', re: /\(\s*note\s*:|\bI hope (?:this|that|the) (?:post |response |draft |text |abstract )?(?:meets|fits|matches|is what you)\b|\blet me know if you(?:['’]d| would)? (?:like|want|need) (?:me to|any (?:changes|modifications|revisions|adjustments|edits)|anything else)\b|\bfeel free to (?:modify|adjust|edit|customi[sz]e|tweak|change) (?:it|this|the (?:post|text|draft))\b/i },
  // a slot left for someone else to fill; a Markdown link "[click here](...)" is not one
  { kind: 'placeholder', where: 'anywhere', re: /\[(?:your|insert|add|optional|end of|link|image|photo|screenshot|username|user name)\b[^\]\n]{0,80}\](?!\()|\[[^\]\n]{0,40}\b(?:name|username|link|insert|here)\](?!\()/i },
  // any other slot: a few lower-case words in brackets ("[substance]", "[popular game]"), which is not
  // how a post or an abstract writes; Reddit's own tags ("[deleted]", "[Serious]") and "[sic]" are not slots
  { kind: 'placeholder', where: 'anywhere', re: /\[(?!(?:deleted|removed|oc|serious|nsfw|spoiler|spoilers|update|edit|meta|discussion|question|help|advice|sic|ref|pc|ps4|ps5|xbox|us|uk|eu|na|long|rant|vent|request|original|repost|x|tw|cw)\])[a-z][a-z' ]{1,30}\](?!\()/ },
];

/** Which kind of task talk a model's text holds, or null when it is simply the text. */
export function metaKind(text: string): MetaKind | null {
  const t = text.trim();
  const opening = t.slice(0, OPENING);
  for (const m of META) {
    if (m.re.test(m.where === 'start' ? opening : t)) return m.kind;
  }
  return null;
}

/** Whether a model's text is about the task (a refusal, a preamble, a label, a note, a slot) rather than the text asked for. */
export const isMetaText = (text: string): boolean => metaKind(text) !== null;
