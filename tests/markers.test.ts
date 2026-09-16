import test from 'node:test';
import assert from 'node:assert/strict';
import { byId, sentences, sentenceLengthCv, readable } from '../src/markers.js';

// Sentences marked RAID are quoted from the RAID arms (MIT). Hacker News, Stack Exchange and HC3
// cannot be quoted, so the cases the audit found there are written here in other words.

const is = (id: string, text: string): boolean => byId.get(id)!.test(text);
const count = (id: string, text: string): number => byId.get(id)!.count!(text);

const counts = (id: string, yes: string[], no: string[]): void => {
  for (const t of yes) assert.ok(count(id, t) > 0, `${id} should match: ${t}`);
  for (const t of no) assert.equal(count(id, t), 0, `${id} should not match: ${t}`);
};

test('first person: "I" is a capital letter, and an enumeration or "i.e." is not a person', () => {
  for (const t of ['I think so.', "I'm not sure.", 'This is my code.', 'Give it to me.', 'We did it; I checked.']) {
    assert.equal(is('no_first_person', t), false, `should find first person in: ${t}`);
  }
  for (const t of [
    'Our contributions are: (i) a benchmark and (ii) a model.',
    'small objects, i.e., lesions',
    'We control the Type I error rate.',
    'the results of Phase I trials',
    'three stages: (I) detection, (II) tracking',
    'We propose a method.',
  ]) {
    assert.equal(is('no_first_person', t), true, `should not find first person in: ${t}`);
  }
});

test('first person: a Roman numeral, a variable, a citation key or an initial is not the writer', () => {
  for (const t of [
    // RAID
    'implement it as a CMPC-I (Image) module and a CMPC-V (Video) module',
    'when $\\mathcal{C}$ is a maximal $n$-orthogonal subcategory, see \\cite{I}. In this case we show',
    'all SK solar data (SK-I, SK-II, SK III and SKIV) measures this angle',
    'a list of generators for an ideal I in R. We show how to find an additive basis',
    'assess the error probabilities of Types I and II, i.e., false alarm and mis-detection',
    'at the sequence of transitions: SS-F-NO with increasing temperature for J/I=0.3, U/I0 = 0.69',
    'the analytical apparatus of the thermodynamics of I. Prigozhin\'s structure',
    'potentials such as the generalized Poschl Teller (GPT), o Scarf-I and P T symmetric Scarf-II',
    'This paper investigates the hydrogen I (HI) content of extremely metal-deficient blue compact dwarf galaxies',
    'shown to have better performance in terms of controlling the type I error rate',
    'This paper introduces the concept of the global Fukaya category I, which is a mathematical framework',
    'The abstract of the academic paper "Troisième groupe de cohomologie non ramifiée des torseurs universels"',
    // written for the test, as the web arms have them
    'Intel ME runs below the operating system.',
    'The ME spelling is older than the modern one.',
  ]) {
    assert.equal(is('no_first_person', t), true, `should not find first person in: ${t}`);
  }
  for (const t of [
    // RAID: the only real first person in the reference side of the GPT-4 pairing looks like this
    'Here, I describe (without going too much into mathematical details) the theoretical model I developed',
    // an aside in brackets is still the writer
    'The answer is yes (I think the docs agree).',
    "It works now (I'm on the latest version).",
    '[I am using the British spelling here.]',
    // a sentence-final "I" after a verb, and a dash typed as "--" before it
    'Everyone was tired, and so was I.',
    'It took a while--I think--to load.',
    'The café gave me a discount.',
  ]) {
    assert.equal(is('no_first_person', t), false, `should find first person in: ${t}`);
  }
});

test('contractions: a possessive is not a contraction, a curly apostrophe still is', () => {
  for (const t of ["It doesn't work.", "It’s fine.", "We're done.", "They'd agree.", "Let's go.", "I'll check.", "that's it"]) {
    assert.equal(is('no_contraction', t), false, `should find a contraction in: ${t}`);
  }
  for (const t of ["The model's accuracy", "the network’s output", "Kendall's tau and Pearson's r", "the authors' method", 'No apostrophes here.']) {
    assert.equal(is('no_contraction', t), true, `should not find a contraction in: ${t}`);
  }
});

test('contractions: the name particle in "van\'t Hoff" is not one', () => {
  // RAID, the only "contraction" the GPT-4 arm had
  assert.equal(is('no_contraction', 'a newly derived "Osmosis Law & Theory" that improves upon the van\'t Hoff osmotic pressure equation'), true);
  assert.equal(is('no_contraction', 'Van’t Hoff factor'), true);
  assert.equal(is('no_contraction', "The van't Hoff factor can't explain it."), false);
});

test('personal detail: a year is not one', () => {
  for (const t of [
    // RAID
    'The notion of Lagrangian $H$-umbilical submanifolds was introduced by B. Y. Chen in 1997, and these submanifolds have appeared',
    'The actual sum is about 22.92068. In 1916, Irwin proved, among other things, that the sum',
  ]) {
    assert.equal(is('no_personal_detail', t), true, `should not find personal detail in: ${t}`);
  }
  for (const t of ['My wife uses it every day.', 'Last week the build broke twice.', 'When I was a student this was harder.']) {
    assert.equal(is('no_personal_detail', t), false, `should find personal detail in: ${t}`);
  }
});

test('a dash counts however it was typed, and a TeX name join does not', () => {
  const m = byId.get('em_dash')!;
  assert.equal(m.count!('a — b'), 1);
  assert.equal(m.count!('segmentation and tagging---are useful'), 1);
  assert.equal(m.count!('masks -- the existing datasets'), 1);
  assert.equal(m.count!('from days to minutes -- with our method -- and more'), 2);
  assert.equal(m.count!('Calabi--Yau manifolds and pages 10--20'), 0);
  assert.equal(m.count!('a - b'), 0);
});

test('a dash: a spaced hyphen or en dash between words counts, math, Morse and table rules do not', () => {
  counts('em_dash', [
    // RAID, GPT-4
    'the collective behavior of these quantum dots under specific conditions, focusing on their spontaneous emission - a fundamental quantum process',
    'the deadline – a real one – moved again',
    'the fix (a small one) - and it held',
  ], [
    // RAID
    'there exists a vertex $w$ in $G$ such that $G - w$ is non-hamiltonian',
    'the letter H - dot dot dot dot',
    'pages 10 – 20',
    '| words | count |-------+-------| total | 42 |',
    '|---|---|',
    '+---+---+',
  ]);
  assert.equal(count('em_dash', 'the fourth dimension - time'), 1);
  assert.equal(count('em_dash', '|------------|------------|'), 0);
  assert.equal(count('em_dash', 'one --- two'), 1);
  assert.equal(is('em_dash_heavy', '|------------|------------|------------|'), false, 'one table rule is not a string of dashes');
  assert.equal(is('em_dash_heavy', 'the deadline – a real one – moved'), true);
});

test('the dash tests are not stateful across calls', () => {
  // a global regex used with .test() remembers where it stopped; the same text must give the same answer twice
  for (let i = 0; i < 3; i++) {
    assert.equal(is('em_dash', 'x — y'), true);
    assert.equal(is('em_dash_heavy', 'x — y — z'), true);
    assert.equal(is('em_dash_heavy', 'x — y'), false);
    assert.equal(is('em_dash', 'the noise - and the signal'), true);
  }
});

test('"leverage": a noun after have, gain, a possessive or an adjective is left alone, the verb forms never are', () => {
  counts('leverage', [
    // RAID
    'We propose a supervised local contrastive loss that leverages limited pixel-wise annotation',
    'Specifically, we leverage Dice similarity coefficient to deter model parameters',
    'a firm that has leveraged its brand',
    'their leveraging of public data',
    'what we gained by leveraging priors',
    'they have to leverage the cache',
  ], [
    'They have leverage over the supplier.',
    'The union gained leverage in the talks.',
    'Nobody has leverage here.',
    'its leverage over the market',
    'Our leverage is limited.',
    'points with high leverage',
    'statistical leverage scores',
    'a fund with low leverage',
  ]);
});

test('"it is important to note": an adverb or a modal in between is the same formula', () => {
  counts('important_to_note', [
    "It's also important to note that the numbers vary.",
    'It is also worth noting that the file is cached.',
    'It may be worth noting that nobody asked.',
    'It is perhaps also worth noting that the rule is old.',
    'It’s worth noting the date.',
    // RAID
    'It is worth to note that without UDA, a model trained on CT for hip joint bone segmentation is non-transferable',
  ], [
    'It is hardly worth noting.',
    'It is not important to note every change.',
    'It is important to notify the owner.',
  ]);
  assert.equal(count('important_to_note', "It's also important to note this, and it is important to note that."), 2);
});

test('"in conclusion": a wrap-up counts, arithmetic and the ordinary verb do not', () => {
  counts('in_conclusion', [
    // RAID
    'To sum up, the network of regions is constructed adaptively to avoid many small regions in the image',
    'So, to sum it up, the plan works.',
    'To summarize: the tests pass.',
    'To conclude, the method is fast.',
    'In conclusion, it holds.',
    'In summary the approach is sound.',
  ], [
    // RAID
    'message passing in a suitable factor graph at a linear convergence rate, without having to sum up over all the configurations of the factor',
    'No generic approach is available, however, to summarize the resulting variable-dimensional samples',
    'Conclusion: the method works.',
  ]);
});

test('"not only ... but also": an abbreviation or a decimal in between, a long gap, and "but it also"', () => {
  counts('not_only_but_also', [
    // RAID
    'the student model not only learns from labeled target data (e.g., CT), but also explores unlabeled target data',
    'The proposed approach not only reduces Hausdorff95 (HD95) by 33.9% and Average Surface Distance (ASD) by 42.1% compared with the state-of-the-art method, but it also achieves excellent results',
    "are not only able to improve the best-fit respect to the $\\Lambda$CDM model accounting well for the `features' observed in the CMB angular power spectrum, but also suggesting a possible origin",
    'Without this, not only one lacks quality assurance but one also does not know where to put any additional imaging',
    'depends not only on an individual capability of knowledge absorption but it can be also influenced by various group interactions',
  ], [
    'We could answer not only yes or no. But also, consider this.',
    'It covers not only this etc. But also that.',
    'It is not only the model, no. But it also matters.',
    'not only the first but, to be fair, a good many of the others also',
  ]);
});

test('"it\'s not X, it\'s Y": "this" and "that", a semicolon, a colon and any dash', () => {
  counts('not_x_its_y', [
    'It is not a bug; it is a feature.',
    'This is not a limitation, this is the design.',
    "This isn't a rule - this is a habit.",
    "It's not a bug- it's a feature.",
    'It is not a flaw---it is a choice.',
    'It is not like a dry rain: it is, in some sense, impossible.',
    'It’s not the tool — it’s the habit.',
  ], [
    'Take a set that is not closed, that is, one whose boundary is missing.',
    "It's not the tool. It's the habit.",
    'It is not only fast but also cheap.',
  ]);
});

test('a three-item list: "or", a multi-word item before a serial comma, and not an adverb, a year or a clause', () => {
  counts('rule_of_three', [
    // RAID, GPT-4
    'This research has potential implications for a wide range of applications, including medical imaging, remote sensing, and computer vision.',
    // RAID: numbers that are not years are list items
    'the intraclass correlation coefficient (ICC) is 98, 95, and 80 % (95 %)',
    'Pick red, green, or blue.',
    'We sell apples, pears and plums.',
  ], [
    // RAID
    'via backward propagation. However, forward and backward propagation was originally designed for whole-image classification.',
    'In 1989, Godreche and Luck introduced the concept of local mixtures of primitive substitution rules',
    'The Internet page was initiated on March 7, 2015, and has been last updated on January 31, 2023.',
    'based on the deep voxelwise residual network, namely VoxResNet, and obtain excellent improvement over single modality',
    'An original image can be, for example, a photograph, and a style image can be a painting',
    'It can be generalized to a higher number of classes, with or without further relations of containment.',
    'Fix it, whether or not it matters.',
    'Test it once, and then run it again.',
  ]);
});

test('sentences: an abbreviation, an initial or a decimal does not end one', () => {
  for (const t of [
    // RAID
    'a trainable version of the Frangi filter yields a performance at the level of U-Net (AUC 0.974 vs. 0.972) with a tremendous reduction in parameters.',
    'This model extends and modifies the reaction-diffusion-delay model by Graham et al. 2012 for the spread of a lesion.',
    'The formulation is agnostic to the underlying segmentation model (e.g. CRF, CNN, etc.) and optimization algorithm.',
    'This paper presents a novel approach to the motility analysis of Caenorhabditis Elegans (C. Elegans), a model organism.',
    'The notion was introduced by B. Y. Chen in 1997.',
    'The effect is shown in Fig. 3 and follows from Eq. 2, cf. the appendix, i.e. the proof.',
    'The score rose from 0.5 to 0.75 in the second run.',
  ]) {
    assert.equal(sentences(t).length, 1, `one sentence, not ${JSON.stringify(sentences(t))}`);
  }
  assert.deepEqual(sentences('The method works. It is fast! Is it right? Yes.'), ['The method works.', 'It is fast!', 'Is it right?', 'Yes.']);
  assert.deepEqual(sentences('The model is from the U.S. It works.'), ['The model is from the U.S.', 'It works.']);
  // RAID: a capital that ends a sentence is not an initial
  assert.equal(sentences('a domain of characteristic 0 which is finitely generated over Z. We consider Thue equations').length, 2);
  assert.equal(sentences('and let a,b,c be non-zero elements of A. It follows from work of Siegel, Mahler, Parry and Lang').length, 2);
  assert.equal(sentences('a transition into an antiferromagnetic state at T$_{\\textrm{N}}$ = 98 K. The transition is field independent up to 9 T. An increase of the resistivity').length, 3);
  assert.equal(sentences('based on the Conditional Generative Adversarial Network (Conditional GAN) image-to-image translation technique of Isola et al. We consider two specific applications').length, 2);
  assert.equal(sentences("Over the past years, C. elegans' motility has been studied across a wide range of environments").length, 1);
});

test('sentences: with line breaks kept, a blank line or a list item ends one, a wrapped line and a heading do not', () => {
  assert.deepEqual(sentences('Some options\n- use the cache\n- restart the server'), ['Some options', '- use the cache', '- restart the server']);
  assert.deepEqual(sentences('A paragraph with no stop\n\nThe next one.'), ['A paragraph with no stop', 'The next one.']);
  assert.deepEqual(sentences('## Results\n\nIt works. It is fast.'), ['It works.', 'It is fast.']);
  assert.deepEqual(sentences('The method is fast\nand it is cheap.'), ['The method is fast\nand it is cheap.']);
  assert.deepEqual(sentences('Two steps, e.g.\n1. build it\n2. run it'), ['Two steps, e.g.', '1. build it', '2. run it']);
});

test('a dash: a list item or a rule on its own line is not one', () => {
  counts('em_dash', ['the result\n- and this is a dash - holds', 'a word --\nand the rest'], [
    'the options include\n- apples\n- pears',
    'first part\n---\nsecond part',
    'first part\n  ---  \nsecond part',
    'the notes\n-- signed',
    '| left | right |\n|:---|---:|',
  ]);
  assert.equal(count('em_dash', 'the options include\n- apples - and pears'), 1);
  assert.equal(count('em_dash', 'this---and that\n---\nend'), 1);
});

test('Title Case headings: a heading is one line', () => {
  assert.equal(is('title_case_headings', 'Intro text.\n\n## Getting Started'), true, 'a heading that ends the text');
  assert.equal(is('title_case_headings', '## Free Indirect Speech\n\nText follows.'), true);
  assert.equal(is('title_case_headings', '## Troubleshooter\n\nMost of the words are fine.'), false, 'a one-word heading does not run into the paragraph');
  assert.equal(is('title_case_headings', '## Getting started\n\nText.'), false);
});

test('the belief markers read the writer\'s own words, not a quotation', () => {
  // written for the test, as Stack Exchange and HC3 answers quote emails, dialogue and news
  assert.equal(is('no_first_person', 'The template reads "I am writing to ask about the position" and nothing more.'), true);
  assert.equal(is('no_contraction', 'The sign says “Don’t enter” in red.'), true);
  assert.equal(is('no_personal_detail', 'The article quoted "my wife uses it daily" from a reader.'), true);
  assert.equal(is('no_first_person', 'I would write "Dear Sir" at the top.'), false, 'the writer outside the quotation still counts');
  assert.equal(is('no_contraction', 'It\'s fine to write "yes" here.'), false);
  assert.equal(is('no_first_person', 'She said "hello. Then I left and ' + 'x'.repeat(400) + '" later.'), false, 'a quotation longer than 300 characters is not taken');
  assert.equal(is('no_first_person', 'Nothing to "quote here. But I checked it myself.'), false, 'an unclosed quotation removes nothing');
});

test('uniform sentences: a text too short to judge is not eligible, rather than not uniform', () => {
  const m = byId.get('uniform_sentences')!;
  assert.ok(m.eligible, 'uniform_sentences must say which texts it can judge');
  const four = 'The first one is here now. The second one is here now. The third one is here now. The fourth one is here now.';
  assert.equal(m.eligible!(four), false);
  assert.equal(m.test(four), false);
  const five = four + ' The fifth one is here now.';
  assert.equal(m.eligible!(five), true);
  assert.equal(m.test(five), true);
  // seven stops, but three of them end "et al." and "e.g.": four sentences, too few to judge
  const abbreviated = 'Smith et al. showed this first. Jones et al. did it again. It holds for many e.g. small cases. It is known.';
  assert.equal(sentences(abbreviated).length, 4);
  assert.equal(sentenceLengthCv(abbreviated), null);
  assert.equal(m.eligible!(abbreviated), false);
  for (const id of ['em_dash', 'no_first_person', 'delve']) assert.equal(byId.get(id)!.eligible, undefined, `${id} can judge every text`);
});

test('bold written back as "**" hides no dash, list or writer, and the bulleted-list marker still sees it', () => {
  // written for the test, as Stack Exchange answers format them
  assert.equal(count('em_dash', '**Proper** - how it should be done'), 1);
  assert.equal(count('rule_of_three', 'Use **apples**, **pears** and **plums**.'), 1);
  assert.equal(is('no_first_person', '**I** think so.'), false);
  assert.equal(is('em_dash_heavy', '**One** - a thing. **Two** - another.'), true);
  assert.equal(is('title_case_headings', '## **Getting Started**\n\nText.'), true);
  assert.equal(is('bulleted_bold', '- **Speed:** fast'), true);
  assert.equal(readable('- **Speed:** fast'), '- Speed: fast');
});

test('sentences: "w.r.t.", "i.i.d.", "(resp." and "No." before a number do not end one', () => {
  for (const t of [
    'The loss is convex w.r.t. the weights and the samples are i.i.d. draws from the prior.',
    'The maps are injective (resp. surjective) on every chart.',
    'The proof is in Theorem No. 3 of the appendix.',
  ]) {
    assert.equal(sentences(t).length, 1, `one sentence, not ${JSON.stringify(sentences(t))}`);
  }
  assert.equal(sentences('The answer is No. We checked it twice.').length, 2);
});

test('the belief markers: a TeX accent is not a quotation mark, and a lower-case "i" can be the writer', () => {
  // written for the test, as the TeX abstracts escape their accents
  assert.equal(is('no_first_person', 'We extend the Nystr\\"om method. I show that the Nystr\\"om scheme converges.'), false);
  assert.equal(is('no_contraction', 'The K\\"ahler form isn\'t closed, and the B\\"uchi automaton is.'), false);
  // written for the test, as casual writing types it
  for (const t of ['honestly i think it works', "i'm not sure about that", 'that i know of, nobody does', "However i wouldn't expect it", 'i cannot say']) {
    assert.equal(is('no_first_person', t), false, `should find first person in: ${t}`);
  }
  for (const t of ['for each index i in the set', 'the terms (i) and (ii)', 'with $i$ fixed', 'the i-th component, i.e. the last']) {
    assert.equal(is('no_first_person', t), true, `should not find first person in: ${t}`);
  }
});
