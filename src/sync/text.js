'use strict';
/**
 * Lyrics parsing and normalisation for alignment.
 *
 * The user's text is kept untouched for display. For alignment every word gets
 * a "spoken" form in lowercase Russian letters: digits become words, Latin
 * words are transliterated, punctuation is dropped. Tokens with nothing to
 * pronounce (dashes, emoji, "!!!") are glued to a neighbouring word so they
 * appear together with it.
 */

const ONES = ['ноль', 'один', 'два', 'три', 'четыре', 'пять', 'шесть', 'семь', 'восемь', 'девять',
    'десять', 'одиннадцать', 'двенадцать', 'тринадцать', 'четырнадцать', 'пятнадцать', 'шестнадцать',
    'семнадцать', 'восемнадцать', 'девятнадцать'];
const TENS = ['', '', 'двадцать', 'тридцать', 'сорок', 'пятьдесят', 'шестьдесят', 'семьдесят', 'восемьдесят', 'девяносто'];
const HUNDREDS = ['', 'сто', 'двести', 'триста', 'четыреста', 'пятьсот', 'шестьсот', 'семьсот', 'восемьсот', 'девятьсот'];

function below1000(n, feminine) {
    const parts = [];
    if (n >= 100) { parts.push(HUNDREDS[Math.floor(n / 100)]); n %= 100; }
    if (n >= 20) { parts.push(TENS[Math.floor(n / 10)]); n %= 10; if (n) parts.push(unit(n, feminine)); }
    else if (n > 0 || parts.length === 0) parts.push(unit(n, feminine));
    return parts;
}
function unit(n, feminine) {
    if (feminine && n === 1) return 'одна';
    if (feminine && n === 2) return 'две';
    return ONES[n];
}

/** Integer to Russian words (0 .. 999 999 999). Longer numbers are read digit by digit. */
function numberToWords(str) {
    if (str.length > 9) return str.split('').map((d) => ONES[+d]);
    let n = parseInt(str, 10);
    if (n === 0) return ['ноль'];
    const words = [];
    const millions = Math.floor(n / 1e6); n %= 1e6;
    const thousands = Math.floor(n / 1e3); n %= 1e3;
    if (millions) {
        words.push(...below1000(millions, false));
        const l = millions % 10, t = millions % 100;
        words.push(t >= 11 && t <= 14 ? 'миллионов' : l === 1 ? 'миллион' : l >= 2 && l <= 4 ? 'миллиона' : 'миллионов');
    }
    if (thousands) {
        words.push(...below1000(thousands, true));
        const l = thousands % 10, t = thousands % 100;
        words.push(t >= 11 && t <= 14 ? 'тысяч' : l === 1 ? 'тысяча' : l >= 2 && l <= 4 ? 'тысячи' : 'тысяч');
    }
    if (n) words.push(...below1000(n, false));
    return words;
}

// Frequent English words in Russian lyrics, as they are usually pronounced.
const EN_DICT = {
    yeah: 'е', yea: 'е', yo: 'йоу', oh: 'о', ooh: 'у', ah: 'а', uh: 'а', hey: 'хэй', wow: 'вау', ok: 'окей', okay: 'окей',
    baby: 'бэйби', babe: 'бэйб', money: 'мани', love: 'лав', i: 'ай', you: 'ю', me: 'ми', my: 'май', the: 'зе', a: 'э',
    no: 'ноу', go: 'гоу', lets: 'летс', "let's": 'летс', what: 'вот', why: 'вай', how: 'хау', bitch: 'бич', fuck: 'фак',
    shit: 'щит', nigga: 'нига', swag: 'свэг', flow: 'флоу', cash: 'кэш', drip: 'дрип', ice: 'айс', boy: 'бой', girl: 'гёрл',
    bro: 'бро', party: 'пати', night: 'найт', life: 'лайф', real: 'рил', back: 'бэк', down: 'даун', up: 'ап', out: 'аут',
    one: 'уан', two: 'ту', three: 'фри', four: 'фор', five: 'файв', and: 'энд', is: 'из', it: 'ит', in: 'ин', on: 'он',
    do: 'ду', don: 'дон', dont: 'донт', "don't": 'донт', all: 'ол', we: 'ви', so: 'соу', just: 'джаст', like: 'лайк',
    dance: 'дэнс', feel: 'фил', good: 'гуд', time: 'тайм', top: 'топ', star: 'стар', rock: 'рок', rap: 'рэп', hip: 'хип', hop: 'хоп',
};
const EN_RULES = [
    ['sch', 'ск'], ['tch', 'ч'], ['sh', 'ш'], ['ch', 'ч'], ['th', 'з'], ['ph', 'ф'], ['wh', 'у'], ['ck', 'к'], ['qu', 'кв'],
    ['ee', 'и'], ['ea', 'и'], ['oo', 'у'], ['ou', 'ау'], ['ow', 'оу'], ['ay', 'эй'], ['ey', 'эй'], ['ai', 'эй'], ['oy', 'ой'],
    ['igh', 'ай'], ['ng', 'нг'], ['kn', 'н'], ['wr', 'р'], ['ce', 'се'], ['ci', 'си'], ['cy', 'си'], ['ge', 'дже'], ['gi', 'джи'],
    ['a', 'а'], ['b', 'б'], ['c', 'к'], ['d', 'д'], ['e', 'е'], ['f', 'ф'], ['g', 'г'], ['h', 'х'], ['i', 'и'], ['j', 'дж'],
    ['k', 'к'], ['l', 'л'], ['m', 'м'], ['n', 'н'], ['o', 'о'], ['p', 'п'], ['q', 'к'], ['r', 'р'], ['s', 'с'], ['t', 'т'],
    ['u', 'у'], ['v', 'в'], ['w', 'у'], ['x', 'кс'], ['y', 'й'], ['z', 'з'],
];

function translitLatin(word) {
    if (EN_DICT[word] !== undefined) return EN_DICT[word];
    let out = '';
    for (let i = 0; i < word.length;) {
        let hit = false;
        for (const [a, b] of EN_RULES) {
            if (word.startsWith(a, i)) { out += b; i += a.length; hit = true; break; }
        }
        if (!hit) i++;
    }
    // silent final "e" (love, dance, time)
    if (/[^aeiou]e$/.test(word) && out.endsWith('е') && out.length > 2) out = out.slice(0, -1);
    return out.replace(/й$/, 'и');
}

/**
 * Spoken form of one whitespace-separated token: array of Russian words
 * (usually one; numbers may expand to several; empty if nothing to say).
 */
function spokenForm(token) {
    const t = token.toLowerCase().replace(/[’`]/g, "'");
    const pieces = t.match(/[а-яё]+|[a-z']+|\d+/g) || [];
    const out = [];
    for (const p of pieces) {
        if (/^\d+$/.test(p)) out.push(...numberToWords(p));
        else if (/^[a-z']+$/.test(p)) { const r = translitLatin(p.replace(/'/g, '')); if (r) out.push(r); }
        else out.push(p);
    }
    return out;
}

/**
 * Splits lyrics into lines and words.
 * Empty lines are dropped. Words that have nothing to pronounce are attached
 * to the previous word (or the next one, at the start of a line).
 *
 * @param {string} text
 * @returns {Array<{ text: string, words: Array<{ text: string, spoken: string[] }> }>}
 */
function parseLyrics(text) {
    const lines = [];
    for (const rawLine of String(text || '').replace(/\r/g, '').split('\n')) {
        const lineText = rawLine.trim();
        if (!lineText) continue;
        const tokens = lineText.split(/\s+/);
        const words = [];
        let pending = '';
        for (const tok of tokens) {
            const spoken = spokenForm(tok);
            if (spoken.length === 0) {
                if (words.length) words[words.length - 1].text += ' ' + tok;
                else pending += (pending ? ' ' : '') + tok;
                continue;
            }
            words.push({ text: pending ? pending + ' ' + tok : tok, spoken });
            pending = '';
        }
        if (words.length === 0) {
            // A line with nothing to sing (e.g. "***"): keep it, it gets timing from neighbours.
            lines.push({ text: lineText, words: [{ text: lineText, spoken: [] }] });
            continue;
        }
        if (pending) words[words.length - 1].text += ' ' + pending;
        lines.push({ text: lineText, words });
    }
    return lines;
}

module.exports = { parseLyrics, spokenForm, numberToWords, translitLatin };
