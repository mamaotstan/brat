'use strict';
/**
 * Test double for `onnxruntime-node` with the same public API
 * (InferenceSession.create / run, Tensor), backed by Python onnxruntime.
 * Used only by tests in environments where the native addon is unavailable.
 */
const { spawn } = require('child_process');
const path = require('path');

let proc = null; let buf = Buffer.alloc(0); const waiters = [];
function server() {
    if (proc) return proc;
    proc = spawn('python3', ['-I', path.join(__dirname, 'ort_server.py')], { stdio: ['pipe', 'pipe', 'inherit'] });
    proc.stdout.on('data', (d) => { buf = Buffer.concat([buf, d]); pump(); });
    return proc;
}
function pump() {
    while (waiters.length && buf.length >= 4) {
        const hl = buf.readUInt32LE(0);
        if (buf.length < 4 + hl) return;
        const header = JSON.parse(buf.slice(4, 4 + hl).toString());
        const need = (header.outputs || []).reduce((a, o) => a + o.nbytes, 0);
        if (buf.length < 4 + hl + need) return;
        let off = 4 + hl; const blobs = [];
        for (const o of header.outputs || []) { blobs.push(Buffer.from(buf.slice(off, off + o.nbytes))); off += o.nbytes; }
        buf = buf.slice(off);
        waiters.shift()({ header, blobs });
    }
}
let chain = Promise.resolve();
function request(header, blobs = []) {
    const p = chain.then(() => new Promise((resolve) => {
        waiters.push(resolve);
        const h = Buffer.from(JSON.stringify(header));
        const len = Buffer.alloc(4); len.writeUInt32LE(h.length, 0);
        server().stdin.write(Buffer.concat([len, h, ...blobs]));
    }));
    chain = p.catch(() => { });
    return p;
}

class Tensor {
    constructor(type, data, dims) { this.type = type; this.data = data; this.dims = dims; }
}
let nextId = 1;
class InferenceSession {
    static async create(src, options = {}) {
        if (typeof src !== 'string') throw new Error('fake-ort: only file paths are supported');
        const s = new InferenceSession(); s.id = nextId++;
        const { header } = await request({ cmd: 'load', id: s.id, path: src, threads: options.intraOpNumThreads || 1 });
        if (!header.ok) throw new Error(header.error);
        s.inputNames = header.inputNames; s.outputNames = header.outputNames;
        return s;
    }
    async run(feeds) {
        const inputs = []; const blobs = [];
        for (const [name, t] of Object.entries(feeds)) {
            const b = Buffer.from(t.data.buffer, t.data.byteOffset, t.data.byteLength);
            inputs.push({ name, dtype: t.type, dims: t.dims, nbytes: b.length }); blobs.push(b);
        }
        const { header, blobs: outs } = await request({ cmd: 'run', id: this.id, inputs }, blobs);
        if (!header.ok) throw new Error(header.error);
        const res = {};
        header.outputs.forEach((o, i) => {
            const b = outs[i];
            const ab = b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength);
            res[o.name] = new Tensor(o.dtype, o.dtype === 'float32' ? new Float32Array(ab) : new BigInt64Array(ab), o.dims);
        });
        return res;
    }
    async release() { }
}
module.exports = { Tensor, InferenceSession };
