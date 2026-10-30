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
    assert.ok(b.nsTimes[b.nsTimes.length - 1] <= 3.0 + 1e-9);
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

test('a short word is typed over the gap to the next word, not popped in at once', () => {
    // the model often marks a one-token word as only 80 ms long
    const s = buildSchedule([{ words: [{ text: 'тебя', start: 1.0, end: 1.08 }, { text: 'люблю', start: 1.5 }] }], { duration: 3 });
    const t = s.blocks[0].nsTimes;
    assert.ok(t[3] - t[0] >= 0.25, `letters of "тебя" spread over ${((t[3] - t[0]) * 1000).toFixed(0)} ms`);
    assert.strictEqual(t[4], 1.5); // the next word still starts on its beat
});

test('the text changes at most every 0.1 s, like v1 at its default speed; fast words come in bigger steps', () => {
    const s = buildSchedule([{ words: [{ text: 'скороговорка', start: 1.0 }, { text: 'да', start: 1.1 }, { text: 'ну', start: 1.6 }] }], { duration: 3 });
    const b = s.blocks[0];
    const updates = [...new Set(b.nsTimes)];
    for (let i = 1; i < updates.length; i++) assert.ok(updates[i] - updates[i - 1] >= 0.1 - 1e-9);
    for (let i = 1; i < b.nsTimes.length; i++) assert.ok(b.nsTimes[i] >= b.nsTimes[i - 1]);
    assert.strictEqual(b.nsTimes[b.nsTimes.length - 2], 1.6); // a word is never shown before it is sung
    assert.ok(b.pop);
});

test('per-letter colours of a line are carried to the screen', () => {
    const colors = [null, null, '#ff3366', '#ff3366'];
    const s = buildSchedule([{ colors, words: [{ text: 'ab', start: 1 }, { text: 'cd', start: 1.5 }] }]);
    assert.deepStrictEqual(s.blocks[0].colors, colors);
    const wrong = buildSchedule([{ colors: ['#fff'], words: [{ text: 'ab', start: 1 }] }]);
    assert.strictEqual(wrong.blocks[0].colors, null);
});
