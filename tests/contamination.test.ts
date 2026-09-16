import test from 'node:test';
import assert from 'node:assert/strict';
import { containment, checkArm } from '../scripts/contamination.js';

const paper = 'We propose a method for segmenting medical images with very few labels and show that it beats every baseline on three public datasets.';

test('containment: a copy is 1, an unrelated text is 0', () => {
  assert.equal(containment(paper, paper), 1);
  assert.equal(containment('An entirely different sentence about the weather in spring and autumn.', paper), 0);
  assert.equal(containment('too short', paper), 0);
});

test('checkArm drops what it remembered and what it could not check, and says which', () => {
  const human = new Map([['doc1', paper], ['doc2', 'A human abstract about graphs, trees and the colouring of both of them in linear time.']]);
  const rows = [
    { id: 'raid:gpt4:doc1', text: paper },
    { id: 'raid:gpt4:doc2', text: 'This paper delves into graph colouring and leverages a novel approach for trees and forests alike.' },
    { id: 'raid:gpt4:doc3', text: 'A text whose human document is not in the corpus at all, so nothing can be said about it.' },
  ];
  const { report, clean } = checkArm(rows, human, 'raid-gpt4');
  assert.deepEqual(report.remembered, ['doc1']);
  assert.equal(report.unchecked, 1, 'a text with no human document must not be passed as clean');
  assert.equal(report.compared, 2);
  assert.deepEqual(clean.map((r) => r.id), ['raid:gpt4:doc2']);
});

test('bare ids, as in the generated Claude arm, are matched too', () => {
  const { report } = checkArm([{ id: 'doc1', text: paper }], new Map([['doc1', paper]]), 'raid-claude');
  assert.deepEqual(report.remembered, ['doc1']);
});
