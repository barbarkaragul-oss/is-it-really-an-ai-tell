import test from 'node:test';
import assert from 'node:assert/strict';
import { toText, plainText, decodeEntities, joinWraps, proseLength } from '../collector/fetch.js';
import { generationText } from '../collector/fetch-raid.js';
import { byId, words } from '../src/markers.js';
import { containment, fiveGrams } from '../scripts/contamination.js';

const is = (id: string, text: string): boolean => byId.get(id)!.test(text);
const count = (id: string, text: string): number => byId.get(id)!.count!(text);

test('blockquotes go, nested ones included, and the text around them keeps its paragraphs', () => {
  const html = '<p>Before.</p><blockquote><p>Outer start.</p><blockquote><p>Inner.</p></blockquote>'
    + '<p>Outer tail, which I did not write.</p></blockquote><p>After.</p>';
  assert.equal(toText(html), 'Before.\n\nAfter.');
  // a lazy match would stop at the inner closing tag and keep this
  assert.ok(!toText(html).includes('Outer tail'));
  assert.equal(toText('<p>Mine.</p><BLOCKQUOTE class="spoiler"><p>Theirs.</p></BLOCKQUOTE>'), 'Mine.');
});

test('code blocks and inline code are not prose', () => {
  const html = '<p>Run this:</p><pre><code>&gt; not a quote\n|-----+-----|\n| a --- b |\n</code></pre>'
    + '<p>Then use <code>git log --oneline</code> to check.</p>';
  const text = toText(html);
  assert.equal(text, 'Run this:\n\nThen use to check.');
  assert.equal(is('em_dash', text), false, 'an ASCII table rule is not a dash');
});

test('Hacker News: a line quoted with ">" goes, the reply after it stays', () => {
  const html = 'I disagree with the parent.<p>&gt; The parent said this, quoted\nMy reply, on the next line.'
    + '<p>&gt;Another quote<p><i>&gt; a quote in italics</i><p>Last paragraph.';
  assert.equal(toText(html), 'I disagree with the parent.\n\nMy reply, on the next line.\n\nLast paragraph.');
  // a ">" that is only in the middle of a line is the writer's own
  assert.equal(toText('<p>Latency went from 20 to &gt;90 ms.'), 'Latency went from 20 to >90 ms.');
  // code can open a line with ">"; it goes because it is code, and the prose after it stays
  assert.equal(toText('<p><pre><code>  &gt; quoted in code\n</code></pre>\nYes, and more.'), 'Yes, and more.');
});

test('entities: named and numeric, decoded once', () => {
  assert.equal(
    decodeEntities('a&#x2F;b &#39;c&#x27; &#8212; &mdash; &amp;lt; &hellip; &#151; &bogus; &#0;'),
    "a/b 'c' — — &lt; … — &bogus; \ufffd",
  );
  const text = toText('<p>Paths like src&#x2F;lib&#x2F;x and it&#x27;s&nbsp;fine.</p>');
  assert.equal(text, "Paths like src/lib/x and it's fine.");
  assert.deepEqual(words(text), ['paths', 'like', 'src', 'lib', 'x', 'and', "it's", 'fine']);
  // the decoded "<" is text: it must not be read as a tag afterwards
  assert.equal(toText('<p>if a &lt;b&gt; c</p>'), 'if a <b> c');
});

test('headings, bullets and bold survive as Markdown, so the markers for them can fire', () => {
  const html = '<h2>Getting Started Quickly</h2>\n<p>Body text here.</p>\n<ul>\n'
    + '<li><strong>Speed:</strong> fast</li>\n<li><strong>Cost:</strong> low</li>\n</ul>';
  const text = toText(html);
  assert.equal(text, '## Getting Started Quickly\n\nBody text here.\n\n- **Speed:** fast\n- **Cost:** low');
  assert.equal(is('title_case_headings', text), true);
  assert.equal(is('bulleted_bold', text), true);
  // squeezed onto one line, neither can
  const flat = text.replace(/\s+/g, ' ');
  assert.equal(is('title_case_headings', flat.slice(flat.indexOf('Body'))), false);
  assert.equal(is('bulleted_bold', flat), false);
  // a loose list item keeps its number on the same line as its text
  assert.equal(toText('<ol><li><p><b>First</b> step</p></li><li><p>Second</p></li></ol>'), '1. **First** step\n\n2. Second');
});

test('a numbered list stays numbered, and a list inside it keeps its own kind', () => {
  const nested = toText('<ol><li>Pick one<ul><li><strong>Fast:</strong> cheap</li><li>Slow</li></ul></li><li>Then run it</li></ol>');
  assert.equal(nested, '1. Pick one\n\n- **Fast:** cheap\n- Slow\n\n2. Then run it');
  assert.equal(is('bulleted_bold', nested), true);
  // written for the test, as English Stack Exchange numbers its example sentences
  const examples = toText('<ol><li><strong>Did you go there?</strong></li><li><strong>Have you been there?</strong></li></ol>');
  assert.equal(examples, '1. **Did you go there?**\n2. **Have you been there?**');
  assert.equal(is('bulleted_bold', examples), false, 'a numbered list is not a bulleted one, in any arm');
});

test('Hacker News: a quote that wraps onto indented lines goes whole', () => {
  assert.equal(toText('<p>&gt; You say the rules of this world\n  do not hold anywhere at\n  all.\nThey do hold.'), 'They do hold.');
  // an indented line that follows the writer's own line is the writer's
  assert.equal(toText('<p>My list:\n  first thing\n  second thing'), 'My list: first thing second thing');
});

test('an unspaced "--" between words is a dash in the web arms; a flag or a range is not', () => {
  const text = toText('<p>He called him--he won anyway.</p>');
  assert.equal(text, 'He called him—he won anyway.');
  assert.equal(is('em_dash', text), true);
  assert.equal(toText('<p>We went back and forth--I gave up.</p>'), 'We went back and forth—I gave up.');
  assert.equal(is('no_first_person', 'We went back and forth—I gave up.'), false);
  assert.equal(toText('<p>Pass --verbose for pages 10--20.</p>'), 'Pass --verbose for pages 10--20.');
});

test('the 400-character gate counts prose, not the Markdown written back', () => {
  const body = 'word '.repeat(78).trim();
  const text = toText(`<p>${body}</p><ul><li><b>x</b></li><li><b>y</b></li></ul>`);
  assert.ok(text.length >= 400, 'with its markup the text is long enough');
  assert.ok(proseLength(text) < 400, `its prose is not: ${proseLength(text)}`);
  assert.equal(proseLength('## A heading\n\n1. one\n- two **three**'), 'A heading one two three'.length);
});

test('a source wrapped at 79 columns reads as the same text on one line', () => {
  // RAID, joined into one paragraph
  const oneLine = [
    'This research has potential implications for a wide range of applications, including medical imaging, remote sensing, and computer vision.',
    'The student model not only learns from labeled target data (e.g., CT), but also explores unlabeled target data.',
    'It is worth to note that without UDA, a model trained on CT for hip joint bone segmentation is non-transferable.',
    'To sum up, the network of regions is constructed adaptively to avoid many small regions in the image.',
    'We focus on their spontaneous emission - a fundamental quantum process.',
    'The intraclass correlation coefficient (ICC) is 98, 95, and 80 % (95 %).',
  ].join(' ');
  const wrap = (s: string, width: number): string => {
    const lines: string[] = [];
    let line = '';
    for (const w of s.split(' ')) {
      if (line && line.length + 1 + w.length > width) { lines.push(line); line = w; } else line = line ? `${line} ${w}` : w;
    }
    return [...lines, line].join('\n');
  };
  let lost = 0;
  for (let width = 20; width <= 79; width++) {
    const wrapped = wrap(oneLine, width);
    assert.equal(generationText({ generation: wrapped }), oneLine, `wrapped at ${width}`);
    lost += count('rule_of_three', oneLine) - count('rule_of_three', plainText(wrapped));
  }
  assert.ok(lost > 0, 'keeping the wraps must have hidden a list somewhere, or this test shows nothing');
  assert.equal(count('rule_of_three', generationText({ generation: 'We study detection,\nsegmentation,\nand diagnosis.' })), 1);
});

test('joining wraps keeps paragraphs, headings and lists', () => {
  for (const t of [
    'Three steps:\n- build it\n- run it\n\nDone.',
    'Steps\n1. build it\n2. run it',
    '## Results\nIt works.\n\nMore.',
    'It works.\n## Why It Works\nBecause.',
  ]) {
    assert.equal(joinWraps(t), t);
  }
  assert.equal(joinWraps('- a first item that\nwraps\n- a second'), '- a first item that wraps\n- a second');
  // a "- " that a wrap put first on a line, and a number that ends a line
  assert.equal(joinWraps('a trade-off between speed\n- and accuracy, and more'), 'a trade-off between speed - and accuracy, and more');
  assert.equal(joinWraps('as shown in Section\n2. The rest'), 'as shown in Section 2. The rest');
});

test('whitespace: runs collapse, paragraphs and line breaks do not', () => {
  const html = '<p>one   two\n three\t four</p>\n\n\n<p></p><p></p><p>five<br>six<br/>seven</p>';
  assert.equal(toText(html), 'one two three four\n\nfive\nsix\nseven');
  // inline tags leave no space behind, so a list does not read "a , b"
  assert.equal(toText('<p><em>apples</em>, <em>pears</em>, and <em>plums</em>.</p>'), 'apples, pears, and plums.');
  assert.equal(toText('<table><tr><td>a</td><td>b</td></tr><tr><td>c</td></tr></table>'), 'a b\n\nc');
});

test('RAID generations are plain text: structural line breaks kept, TeX left alone', () => {
  const raw = 'We find $p<0.05$ for $n>2$.\r\n\r\n\r\n\r\nSecond\t\tparagraph  here.  \r\n## Results And Discussion\r\nMore.';
  const text = generationText({ generation: raw });
  assert.equal(text, 'We find $p<0.05$ for $n>2$.\n\nSecond paragraph here.\n## Results And Discussion\nMore.');
  assert.equal(is('title_case_headings', text), true);
  assert.equal(plainText('  a &amp; b\n\n\n\nc  '), 'a & b\n\nc');
});

test('contamination: line breaks do not change the five-word sequences', () => {
  const html = '<h2>Method Overview</h2><p>We propose a method for segmenting medical images</p>'
    + '<ul><li><strong>with</strong> very few labels</li><li>and show that it beats every baseline.</li></ul>';
  const text = toText(html);
  assert.ok(text.includes('\n'));
  const flat = text.replace(/[#*\-]/g, ' ').replace(/\s+/g, ' ');
  assert.deepEqual([...fiveGrams(text)], [...fiveGrams(flat)]);
  assert.equal(containment(text, flat), 1);
});
