'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { buildSchedule, blockAt, prefixByLetters } = require('../src/sync/draw');

const lines = [
    { words: [{ text: 'снова', start: 1.0, end: 1.4 }, { text: 'я', start: 1.5 }, { text: 'не', start: 1.7 }] },
    { words: [{ text: 'высыпаюсь', start: 2.2, end: 3.0 }] },
    { words: [{ text: 'никогда', start: 9.0 }] },
];

test('one lyrics line = one screen, shown from its first word', () => {
    const s = buildSchedule(lines, { duration: 12 });
    assert.strictEqual(s.blocks.length, 3);
    assert.strictEqual(blockAt(s, 0.5), -1);
    assert.strictEqual(blockAt(s, 1.0), 0);
    assert.strictEqual(blockAt(s, 2.19), 0);
    assert.strictEqual(blockAt(s, 2.2), 1);
    // a long pause clears the screen, the last line stays to the end of the clip
    assert.strictEqual(blockAt(s, 6), -1);
    assert.strictEqual(blockAt(s, 11.9), 2);
});

test('letters of a word are typed while it is sung, never before it starts', () => {
    const s = buildSchedule(lines, { duration: 12 });
    const b = s.blocks[1];
    assert.strictEqual(b.nsTimes.length, 'высыпаюсь'.length);
    assert.strictEqual(b.nsTimes[0], 2.2);
    for (let i = 1; i < b.nsTimes.length; i++) assert.ok(b.nsTimes[i] > b.nsTimes[i - 1]);
    assert.ok(b.nsTimes[b.nsTimes.length - 1] < 3.0);
});

test('global offset shifts everything; out-of-order words are kept in order', () => {
    const s = buildSchedule([{ words: [{ text: 'а', start: 2 }, { text: 'б', start: 1 }] }], { offset: -0.5 });
    assert.strictEqual(s.blocks[0].start, 1.5);
    assert.ok(s.blocks[0].nsTimes[1] > s.blocks[0].nsTimes[0]);
});

test('prefixByLetters skips spaces', () => {
    assert.strictEqual(prefixByLetters('я не сплю', 3), 'я не');
    assert.strictEqual(prefixByLetters('я не сплю', 0), '');
});
