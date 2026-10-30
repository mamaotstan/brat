'use strict';
/**
 * SentencePiece unigram tokenizer (Viterbi segmentation by piece scores).
 * Matches the segmentation the zipformer model was trained with, so forced
 * alignment uses the same token sequences the model emits itself.
 */
class UnigramTokenizer {
    /** @param {{ pieces: Array<[string, number, number]> }} json  [piece, score, type] in id order */
    constructor(json) {
        this.pieces = json.pieces.map((p) => p[0]);
        this.map = new Map();
        this.maxLen = 1;
        json.pieces.forEach(([piece, score, type], id) => {
            if (type !== 1) return; // only normal pieces take part in segmentation
            this.map.set(piece, { id, score });
            if (piece.length > this.maxLen) this.maxLen = piece.length;
        });
        this.unk = this.pieces.indexOf('<unk>');
    }

    /** Token ids for one word, encoded the way SentencePiece encodes "▁word". */
    encodeWord(word) {
        const s = '▁' + word;
        const n = s.length;
        const best = new Float64Array(n + 1).fill(-Infinity);
        const back = new Array(n + 1).fill(null);
        best[0] = 0;
        for (let i = 0; i < n; i++) {
            if (best[i] === -Infinity) continue;
            const lim = Math.min(n, i + this.maxLen);
            for (let j = i + 1; j <= lim; j++) {
                const hit = this.map.get(s.slice(i, j));
                if (hit && best[i] + hit.score > best[j]) { best[j] = best[i] + hit.score; back[j] = [i, hit.id]; }
            }
            // character outside the vocabulary: emit <unk> and continue
            if (back[i + 1] === null && best[i + 1] === -Infinity) { best[i + 1] = best[i] - 20; back[i + 1] = [i, this.unk]; }
        }
        const ids = [];
        for (let j = n; j > 0;) { const [i, id] = back[j]; ids.push(id); j = i; }
        return ids.reverse();
    }
}

module.exports = { UnigramTokenizer };
