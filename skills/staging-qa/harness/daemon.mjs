// Long-lived browser holder: keeps every account's context open between steps.
// POST a JS async function body to http://127.0.0.1:$QA_PORT/ (see run.sh). In scope: S (S.ctx, S.p), get(who, opts), L (lib), fs.
import http from 'http'; import fs from 'fs';
import * as L from './lib.mjs';
const S = { ctx: {}, p: {} };
async function get(who, opts) {
  if (!S.ctx[who]) { const { ctx, p } = await L.open(who, opts); S.ctx[who] = ctx; S.p[who] = p; ctx.on('close', () => { delete S.ctx[who]; delete S.p[who]; }); }
  return S.p[who];
}
const AsyncFn = Object.getPrototypeOf(async () => {}).constructor;
const port = Number(process.env.QA_PORT || 7788);
http.createServer((req, res) => {
  let b = ''; req.on('data', d => b += d); req.on('end', async () => {
    try { const out = await new AsyncFn('S', 'get', 'L', 'fs', b)(S, get, L, fs); res.end(typeof out === 'string' ? out : JSON.stringify(out, null, 1)); }
    catch (e) { res.statusCode = 500; res.end('ERR ' + (e.stack || e).toString().slice(0, 1500)); }
  });
}).listen(port, '127.0.0.1', () => console.log(`daemon up on ${port}, shots -> ${L.SHOTS}`));
