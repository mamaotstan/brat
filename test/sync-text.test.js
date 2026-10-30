'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { parseLyrics, spokenForm, numberToWords } = require('../src/sync/text');

test('lines and words keep the original text for display', () => {
    const lines = parseLyrics('Снова я не высыпаюсь, мои глаза слипаются\n\n  Никогда-а не вернусь  \r\n');
    assert.strictEqual(lines.length, 2);
    assert.deepStrictEqual(lines[0].words.map((w) => w.text), ['Снова', 'я', 'не', 'высыпаюсь,', 'мои', 'глаза', 'слипаются']);
    assert.deepStrictEqual(lines[1].words.map((w) => w.text), ['Никогда-а', 'не', 'вернусь']);
});

test('spoken forms: case, punctuation, hyphenated singing', () => {
    assert.deepStrictEqual(spokenForm('высыпаюсь,'), ['высыпаюсь']);
    assert.deepStrictEqual(spokenForm('Никогда-а'), ['никогда', 'а']);
    assert.deepStrictEqual(spokenForm('«Ёлка»!'), ['ёлка']);
});

test('numbers are read out in Russian', () => {
    assert.deepStrictEqual(numberToWords('21'), ['двадцать', 'один']);
    assert.deepStrictEqual(numberToWords('2002'), ['две', 'тысячи', 'два']);
    assert.deepStrictEqual(numberToWords('1000000'), ['один', 'миллион']);
    assert.deepStrictEqual(spokenForm('24/7'), ['двадцать', 'четыре', 'семь']);
});

test('latin words are transliterated (common ones from a dictionary)', () => {
    assert.deepStrictEqual(spokenForm('Baby'), ['бэйби']);
    assert.deepStrictEqual(spokenForm('yeah!'), ['е']);
    assert.ok(spokenForm('superstar')[0].length > 3);
});

test('tokens with nothing to sing are glued to a neighbour', () => {
    const [line] = parseLyrics('— я тут — !!! 🙂');
    assert.deepStrictEqual(line.words.map((w) => w.text), ['— я', 'тут — !!! 🙂']);
    const [only] = parseLyrics('***');
    assert.strictEqual(only.words.length, 1);
    assert.deepStrictEqual(only.words[0].spoken, []);
});
