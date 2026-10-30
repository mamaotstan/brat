"""Test helper: serves onnxruntime (Python) sessions over stdin/stdout so the
JS aligner can be exercised without the native onnxruntime-node addon."""
import sys, json, struct
import numpy as np, onnxruntime as ort

DT = {'float32': np.float32, 'int64': np.int64, 'int32': np.int32}
inp, out = sys.stdin.buffer, sys.stdout.buffer
sessions = {}

def read_exact(n):
    b = b''
    while len(b) < n:
        c = inp.read(n - len(b))
        if not c: sys.exit(0)
        b += c
    return b

def send(header, blobs=()):
    h = json.dumps(header).encode()
    out.write(struct.pack('<I', len(h)) + h)
    for b in blobs: out.write(b)
    out.flush()

while True:
    (hl,) = struct.unpack('<I', read_exact(4))
    msg = json.loads(read_exact(hl))
    try:
        if msg['cmd'] == 'load':
            o = ort.SessionOptions(); o.intra_op_num_threads = msg.get('threads', 1); o.inter_op_num_threads = 1
            s = ort.InferenceSession(msg['path'], sess_options=o, providers=['CPUExecutionProvider'])
            sessions[msg['id']] = s
            send({'ok': True, 'inputNames': [i.name for i in s.get_inputs()], 'outputNames': [o.name for o in s.get_outputs()]})
        elif msg['cmd'] == 'run':
            feeds = {}
            for i in msg['inputs']:
                a = np.frombuffer(read_exact(i['nbytes']), dtype=DT[i['dtype']]).reshape(i['dims'])
                feeds[i['name']] = a
            s = sessions[msg['id']]
            res = s.run(None, feeds)
            hdr = []; blobs = []
            for o, r in zip(s.get_outputs(), res):
                r = np.ascontiguousarray(r)
                dt = 'float32' if r.dtype == np.float32 else 'int64'
                r = r.astype(DT[dt]); b = r.tobytes()
                hdr.append({'name': o.name, 'dtype': dt, 'dims': list(r.shape), 'nbytes': len(b)}); blobs.append(b)
            send({'ok': True, 'outputs': hdr}, blobs)
    except Exception as e:
        send({'ok': False, 'error': str(e)})
