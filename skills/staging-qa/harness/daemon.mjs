// Long-lived browser holder: keeps every account's context open between steps.
// POST a JS async function body to http://127.0.0.1:$QA_PORT/ (see run.sh). In scope: S (S.ctx, S.p), get(who, opts), L (lib), fs.
// It runs code it is sent, so it only answers run.sh: a per-start token in $QA_HOME/daemon.token, no browser origins.
import http from 'http'; import fs from 'fs'; import path from 'path'; import crypto from 'crypto';
import * as L from './lib.mjs';
const S = { ctx: {}, p: {} };
async function get(who, opts) {
  if (!S.ctx[who]) { const { ctx, p } = await L.open(who, opts); S.ctx[who] = ctx; S.p[who] = p; ctx.on('close', () => { delete S.ctx[who]; delete S.p[who]; }); }
  return S.p[who];
}
const AsyncFn = Object.getPrototypeOf(async () => {}).constructor;
const port = Number(process.env.QA_PORT || 7788);
const token = crypto.randomBytes(24).toString('hex');
const tokenFile = path.join(L.HOME, 'daemon.token');
fs.mkdirSync(L.HOME, { recursive: true }); fs.writeFileSync(tokenFile, token, { mode: 0o600 });
// a script that forgets an await must not take every lane down
process.on('unhandledRejection', e => console.error('unhandled', e));
process.on('uncaughtException', e => console.error('uncaught', e));
const send = (res, code, text) => { res.writeHead(code, { 'content-type': 'text/plain; charset=utf-8', 'x-content-type-options': 'nosniff' }); res.end(text); };
http.createServer((req, res) => {
  const given = Buffer.from(String(req.headers['x-qa-token'] || ''));
  const ok = req.method === 'POST' && !req.headers.origin && given.length === token.length && crypto.timingSafeEqual(given, Buffer.from(token));
  if (!ok) { req.resume(); return send(res, 403, 'forbidden'); }
  let b = ''; req.on('data', d => b += d); req.on('end', async () => {
    try { const out = await new AsyncFn('S', 'get', 'L', 'fs', b)(S, get, L, fs); send(res, 200, typeof out === 'string' ? out : JSON.stringify(out, null, 1)); }
    catch (e) { send(res, 500, 'ERR ' + (e.stack || e).toString().slice(0, 1500)); }
  });
}).listen(port, '127.0.0.1', () => console.log(`daemon up on ${port}, shots -> ${L.SHOTS}`));
