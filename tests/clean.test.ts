import test from 'node:test';
import assert from 'node:assert/strict';
import { isTruncated, isMetaText, metaKind, approxTokens, finishedEnding, endsInLoop, endsInsideQuote, CAP_FROM } from '../src/clean.js';

// Every text here is written for the test. Filler sentences make a text long enough to have reached a
// model's cap, and each distinct so no loop forms by accident.
const filler = (n: number): string =>
  Array.from({ length: n }, (_, i) => `Sentence number ${i} talks about a different part of the story.`).join(' ');
/** a text of at least `tokens` approxTokens, ending with `tail` */
const long = (tokens: number, tail: string): string => {
  let n = 1;
  while (approxTokens(`${filler(n)} ${tail}`) < tokens) n++;
  return `${filler(n)} ${tail}`;
};

test('approxTokens: ASCII letters in fours, everything else one by one', () => {
  assert.equal(approxTokens('the'), 1);
  assert.equal(approxTokens('internationalization'), 5);
  assert.equal(approxTokens('A'.repeat(40)), 10);
  assert.equal(approxTokens('in 2023, ok.'), 1 + 4 + 1 + 1 + 1);
  assert.equal(approxTokens('καλημέρα'), 8);
  assert.equal(approxTokens('nice 😊'), 2);
  assert.equal(approxTokens('   '), 0);
});

test('a finished ending is finished at any length', () => {
  const endings = [
    'That was the end.', 'Was it?!', 'He said "done."', 'It worked (mostly.)', 'And then…', 'Well...',
    '谢谢大家。', 'Anyone else? 😅', 'We did it! 🤦‍♂️😂"', 'See you soon :)', 'So happy <3',
    'Loving it #blessed #grateful', 'Thanks for reading! [Your Name]', 'More at https://example.com/page',
    'Thanks for your help!\n\n---', 'Any advice is welcome. Thanks, Sam', 'Any advice is welcome. Best regards, Sam Smith',
    'Thanks for reading, A fellow redditor', 'Happy posting! The Mod Team', 'See you all next week. Garfield',
  ];
  for (const e of endings) {
    assert.ok(finishedEnding(e), `finished: ${JSON.stringify(e)}`);
    for (const m of [undefined, ...Object.keys(CAP_FROM)]) {
      assert.equal(isTruncated(long(700, e), m), false, `${m}: ${JSON.stringify(e)}`);
    }
  }
});

test('a text that stops inside a clause is cut, however short', () => {
  for (const e of ['and then I thought,', 'the steps are as follows:', 'first; second;', 'the results in (', 'But can’', 'the ratio of apples to —', 'she called it “', 'salt &']) {
    assert.equal(finishedEnding(e), null, e);
    assert.equal(isTruncated(`A short post. ${e}`, 'gpt4'), true, e);
  }
});

// RAID's four models, whose caps these tests were written against; the arms written for this
// repository have caps of their own (none known for Claude, Ollama's num_predict for Llama 3) and
// are tested separately below
const RAID_CAPS = ['chatgpt', 'gpt4', 'llama-chat', 'mistral-chat'];

test('an unfinished ending is cut only at a length the model could have been stopped at', () => {
  const cut = 'The series does a good';
  for (const [model, cap] of Object.entries(CAP_FROM).filter(([m]) => RAID_CAPS.includes(m))) {
    assert.equal(isTruncated(long(cap, cut), model), true, `${model} at its cap`);
    // a shorter text that just ends without a stop is how people and models write casually
    assert.equal(isTruncated(`${filler(3)} Any advice would be appreciated`, model), false, `${model}, short`);
  }
  // between the two thresholds: Llama and Mistral would have been stopped there, GPT-4 not
  const middle = long(CAP_FROM['llama-chat']! + 20, cut);
  assert.ok(approxTokens(middle) < CAP_FROM.gpt4!);
  assert.equal(isTruncated(middle, 'llama-chat'), true);
  assert.equal(isTruncated(middle, 'mistral-chat'), true);
  assert.equal(isTruncated(middle, 'gpt4'), false);
  assert.equal(isTruncated(middle, 'chatgpt'), false);
  // a model the table does not know gets the lowest threshold
  assert.equal(isTruncated(middle), true);
  assert.equal(isTruncated(middle, 'some-new-model'), true);
  assert.equal(isTruncated('', 'gpt4'), true);
});

test('capitalised words after the last sentence are a signature only if they can end a name', () => {
  assert.equal(finishedEnding('Thanks for listening. John Smith'), 'signature');
  assert.equal(finishedEnding('That was the finale. The'), null);
  assert.equal(finishedEnding('That was the finale. In Our'), null);
  assert.equal(finishedEnding('That was the finale. so what'), null);
  assert.equal(finishedEnding('Thanks, and I'), null);
  assert.equal(isTruncated(long(700, 'We talked for hours. The'), 'gpt4'), true);
});

test('a text that ends in a loop ran until the cap stopped it, even after a full stop', () => {
  const loop = 'I just want to be free. '.repeat(6).trim();
  assert.equal(endsInLoop(loop), true);
  assert.equal(isTruncated(`${filler(2)} ${loop}`, 'gpt4'), true);
  // the last copy cut short
  assert.equal(endsInLoop(`${filler(2)} no way out, no way out, no way out, no way out, no way out, no way`), true);
  assert.equal(endsInLoop(`${filler(1)} ${'ha'.repeat(1)} ${'lol '.repeat(12).trim()}`), true);
  // repetition that the text moves on from, or too little of it, is not a loop
  assert.equal(endsInLoop('Never, never, never, never give up on what you love. It pays off in the end.'), false);
  assert.equal(endsInLoop('ha ha ha ha, that was funny'), false);
  assert.equal(endsInLoop(`${filler(3)} I miss you. I miss you.`), false);
  assert.equal(endsInLoop(filler(20)), false);
});

const kinds: [string, string | null][] = [
  // refusals: the task or a policy is named
  ["I'm sorry, but I can't assist with that.", 'refusal'],
  ["Sorry, but I can't assist with that.", 'refusal'],
  ['I cannot provide a response to that prompt as it promotes harmful stereotypes.', 'refusal'],
  ["I'm not able to fulfill this request. It is not appropriate to ...", 'refusal'],
  ['I cannot provide an abstract for the academic paper titled "X" as it goes against my programming rules.', 'refusal'],
  ["I'm sorry, but I cannot provide the body of a Reddit post without the title.", 'refusal'],
  ['I apologize, but writing about this topic is not something I can do.', 'refusal'],
  // the same verbs in a post
  ["I can't help but feel like I'm missing out on something big this year.", null],
  ["I can't provide for my family anymore since the layoffs, and I don't know where to turn.", null],
  ["I can't write anymore. Every time I open the document my mind goes blank.", null],
  ["I'm sorry if this post is a bit long, but I need to vent about my landlord.", null],
  // an assistant answering whoever asked
  ["I'm just an AI, I don't have personal opinions, but here are some thoughts.", 'assistant'],
  ['As an AI language model, I do not have feelings about this game.', 'assistant'],
  ['I am an AI language model and do not have personal experiences.', 'assistant'],
  ["I'm so sorry to hear that your laptop won't start. Here are some steps to try.", 'assistant'],
  ['Sure, I can help you with that! Here are some tips.', 'assistant'],
  ["Absolutely, I'd be happy to help! My apartment lights are too dim.", 'assistant'],
  ['As an AI researcher, I spend my days reading papers like this one.', null],
  ['Great, I will never shop at that store again after what happened.', null],
  ['Absolutely loved the new season, and I can say it beat my expectations.', null],
  // preambles
  ["Sure, here's a possible Reddit post:\n\nHey fellow Redditors, my cat learned to open doors.", 'preamble'],
  ['Okay, here is my attempt at the post. My cat learned to open doors.', 'preamble'],
  ['Here is the body of the Reddit post: my cat learned to open doors.', 'preamble'],
  ['The abstract should summarise the paper. Here\'s a possible abstract for the paper "Y": We study cats.', 'preamble'],
  // the abstracts' own preambles, as Mistral and Llama write them
  ['The abstract for the academic paper titled "Cats and Doors" is as follows: We study cats.', 'preamble'],
  ['The abstract of an academic paper should provide a brief summary of the research question.', 'preamble'],
  ['An abstract for the paper would read like this. We study cats.', 'preamble'],
  ['Deep learning has changed the field. Here is an example of an abstract: we study cats.', 'preamble'],
  ["The findings matter. Here's an example of what the abstract might look like: we study cats.", 'preamble'],
  ["I'm happy to help! Here's a possible response for the Reddit post: Hey all, my cat opens doors.", 'preamble'],
  ["I'm happy to help anyone who asks. Here's my story about cats.", null],
  ['This paper presents a new method for segmenting cats.', null],
  ['The abstract theory of categories is developed here, and we study cats.', null],
  // a description of the abstract or of the paper instead of it
  ['We study cats. The abstract would likely describe the methods used and the results.', 'description'],
  ['Overall, the abstract may also highlight the implications of the study.', 'description'],
  ['The paper would likely discuss how cats learn to open doors.', 'description'],
  ['Cat Segmentation Networks is an academic paper that presents a new method.', 'description'],
  ['The paper "Cat Segmentation Networks" presents a new method for cats.', 'description'],
  ['In the paper titled "Cats," the authors explore doors.', 'description'],
  ['This academic paper delves into the segmentation of cats.', null],
  ['We keep the paper trail for every cat we adopt.', null],
  // a lecture instead of the post
  ['I understand that you want me to write a Reddit post about this, but I have concerns.', 'assistant'],
  ['I understand you are frustrated. Here is some perspective on doors.', 'assistant'],
  ['My cat opens doors. However, I must advise against letting cats roam outside.', 'assistant'],
  ["I understand the frustration of waiting for a vet appointment.", null],
  ['I don\'t think it\'s appropriate or respectful to suggest that there is one best way to raise a child.', 'assistant'],
  ['It is not accurate to say that cats cause allergies in everyone.', 'assistant'],
  ['My cousin posted a rumour. It\'s not fair to assume she meant harm, but it hurt.', null],
  ['I don\'t think it\'s fair that my landlord keeps the deposit.', null],
  ['I understand that my landlord is busy, but the heating has been broken for weeks.', null],
  ['I must admit my cat is smarter than me.', null],
  ["Here's the thing: my cat learned to open doors and now nothing is safe.", null],
  ["Here's what happened: I left for work and came back to chaos.", null],
  ["So here's my question: how do I cat-proof a door?", null],
  // labels
  ['Body: I recently ran into an old friend at the station.', 'label'],
  ['Title: My cat opens doors\n\nShe learned it last week.', 'label'],
  ['**Title:** My cat opens doors. She learned it last week.', 'label'],
  ['Abstract: In this paper we study the segmentation of cats.', 'label'],
  ['My cat opens doors.\nBody: she learned it last week.', 'label'],
  // the same labels in a text whose lines were joined, as every Reddit post here is
  ['My cat is sick. Body: I have a question about her food.', 'label'],
  ['A title in quotes". Body: I have a question about her food.', 'label'],
  ['Cat Segmentation Networks Abstract: We study the segmentation of cats.', 'label'],
  ['The steps are as follows: Title: Cats and doors', 'label'],
  ['A title in quotes.; Body: I have a question about her food.', 'label'],
  ['The body: it heals itself.', null],
  ['My cat is sick. body: none of your business', null],
  ['Edit: fixed a typo. My cat opens doors.', null],
  ['Update: she can open the fridge now too.', null],
  ['TL;DR: my cat opens doors.', null],
  // notes to the requester
  ['My cat opens doors. (Note: this story is fictional.)', 'note'],
  ['My cat opens doors. I hope this post meets your requirements.', 'note'],
  ["My cat opens doors. Let me know if you'd like me to make any changes.", 'note'],
  ['My cat opens doors. Feel free to modify it as needed.', 'note'],
  ["Note: I'm on mobile, so sorry for the formatting. My cat opens doors.", null],
  ['My cat opens doors. I hope this helps someone out there.', null],
  ['My cat opens doors. Let me know what you think!', null],
  // slots left to fill
  ['Any advice would be appreciated. Thanks, [Your Name]', 'placeholder'],
  ['Here is the video: [insert link]. Enjoy!', 'placeholder'],
  ['Stay safe out there. [End of post]', 'placeholder'],
  ['Then [player name] missed the dunk completely.', 'placeholder'],
  ['Best, [Username]', 'placeholder'],
  ['I quit [substance] after a year of it.', 'placeholder'],
  ['The game in question is [popular game], and I love it.', 'placeholder'],
  ['He said it was [sic] fine, and the post was [deleted] later.', null],
  ['As shown before [ref], the bound holds; see [12] and [Smith 2019].', null],
  ['More on this [click here](https://example.com) if you are curious.', null],
  ['[OC] My cat opens doors. [Serious] replies only.', null],
  ['The comment was [deleted] before I could read it.', null],
];

test('what counts as talk about the task, and what is ordinary post text', () => {
  for (const [text, kind] of kinds) {
    assert.equal(metaKind(text), kind, JSON.stringify(text));
    assert.equal(isMetaText(text), kind !== null);
  }
});

test('refusals, preambles and opening labels are read at the start only', () => {
  const later = `${filler(8)} I cannot provide a response to that prompt. Sure, here's a possible post. I understand that you want more. The abstract for the paper follows.`;
  assert.ok(later.indexOf('I cannot') > 300);
  assert.equal(metaKind(later), null);
  assert.equal(metaKind(`I cannot provide a response to that prompt. ${filler(8)}`), 'refusal');
  // a label after a sentence end is a label wherever it stands
  assert.equal(metaKind(`${filler(8)} Sure, here's a possible post: Body: none.`), 'label');
});

test('a bare list marker at the end is a cut, a sentence that ends in a number is not', () => {
  for (const t of ['Here is what I did:\n\n1. Mixed the flour\n2.', 'Here is what I did: Mixed the flour. 2.', 'The steps are simple. Do this first.\n-', 'We finished the first part. *', 'Step one is done.\n3)']) {
    assert.equal(isTruncated(t, 'gpt4'), true, JSON.stringify(t));
  }
  for (const t of ['I would rate it a 10.', 'My score: 10.', 'I finished the race in 2.', 'We were born in 1992.', 'The answer is (2).']) {
    assert.equal(isTruncated(t, 'gpt4'), false, JSON.stringify(t));
  }
});

test('the arms written here: a signed letter is finished, and only a real cap cuts', () => {
  const letter = `${filler(40)}\n\nPlease make it required, and please make it fair.\n\nSincerely,\nJordan Whitfield, 8th grade`;
  const unsigned = `${filler(40)}\n\nThank you for your time and consideration.\n\nSincerely,\n[Your Name]`;
  // no cap is known for Claude through Claude Code, so length alone never makes a text cut
  assert.equal(CAP_FROM.claude, Infinity);
  assert.equal(isTruncated(letter, 'claude'), false);
  // with no cap, what still marks a cut is a clause left open; an ending that merely lacks a stop does not
  assert.equal(isTruncated(`${filler(40)} And so, in the end, the principal agreed,`, 'claude'), true, 'a clause left open is still a cut');
  assert.equal(isTruncated(`${filler(40)} And so the principal agreed`, 'claude'), false);
  // Llama 3 was run with num_predict 1200, which this scale puts at about 1,300
  assert.equal(isTruncated(letter, 'llama3'), false);
  assert.equal(isTruncated(long(CAP_FROM.llama3! + 20, 'The series does a good'), 'llama3'), true);
  // a letter's name slot is where the name goes, not a template left unfilled
  assert.equal(metaKind(unsigned), null);
  assert.equal(metaKind(`${filler(3)} My favourite game is [insert game here] and I play it daily.`), 'placeholder');
  // the exception reads only the end: a slot in the body of a signed letter is still a slot
  assert.equal(metaKind(`${filler(3)} We went to [your city] last year.\n\nSincerely,\n[Your Name]`), 'placeholder');
});

test('a long text that ends inside a quotation or a bracket it opened is a cut, even after a full stop', () => {
  // 700 is past every RAID cap, and short of the caps of the arms written here
  for (const m of RAID_CAPS) {
    assert.equal(isTruncated(long(700, 'It feels like I am saying, "I am not good enough for love.'), m), true, m);
    assert.equal(isTruncated(long(700, 'She called it “the best day ever.'), m), true, m);
    assert.equal(isTruncated(long(700, 'We looked at it again (see the part about the doors.'), m), true, m);
    // closed, a stray mark, an inch mark, an emoticon or a formula: finished
    assert.equal(isTruncated(long(700, 'It feels like I am saying, "I am not good enough."'), m), false, m);
    assert.equal(isTruncated(long(700, 'I bought a 5" screen for it. Thanks for reading.'), m), false, m);
    assert.equal(isTruncated(long(700, 'It did not work :( Thanks anyway.'), m), false, m);
    assert.equal(isTruncated(long(700, 'It grows like x / ln(x) for large x. The FCN-8) model agrees.'), m), false, m);
  }
  // a short text is not near the cap, so an open quote there is the writer's
  assert.equal(isTruncated('It feels like I am saying, "I am not good enough for love.', 'gpt4'), false);
  assert.equal(endsInsideQuote('He said "no" and left.'), false);
  assert.equal(endsInsideQuote('He said "no and left.'), true);
});
