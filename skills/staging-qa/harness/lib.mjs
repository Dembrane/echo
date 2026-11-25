// Shared helpers for the staging QA daemon. Config comes from env; nothing personal lives in the repo.
import fs from 'fs'; import os from 'os'; import path from 'path';
const here = path.dirname(new URL(import.meta.url).pathname);
const { chromium } = await import(path.resolve(here, '../../../dembrane/frontend/node_modules/@playwright/test/index.mjs'));

export const D = process.env.QA_DASHBOARD || 'https://dashboard.staging.dembrane.com';
export const P = process.env.QA_PORTAL || 'https://portal.staging.dembrane.com';
export const A = process.env.QA_API || 'https://api.staging.dembrane.com';
export const HOME = process.env.QA_HOME || path.join(os.homedir(), '.cache', 'dembrane-qa');
export const AUDIO = path.join(HOME, 'audio');
export const SHOTS = process.env.QA_SHOTS || path.join(HOME, 'runs', new Date().toISOString().slice(0, 10));
// role -> email, kept outside the repo in $QA_HOME/accounts.json
const accFile = path.join(HOME, 'accounts.json');
export const ACC = fs.existsSync(accFile) ? JSON.parse(fs.readFileSync(accFile, 'utf8')) : {};

const HIDE = '[data-agentation-root]{display:none!important}';
// one persistent browser profile per name, so sign-ins survive restarts
export async function open(who, { headless = true, args = [], viewport = { width: 1440, height: 900 } } = {}) {
  const ctx = await chromium.launchPersistentContext(path.join(HOME, 'profiles', who), { headless, viewport, args, permissions: ['microphone', 'clipboard-read', 'clipboard-write'] });
  await ctx.addInitScript(css => { const f = () => { const s = document.createElement('style'); s.textContent = css; (document.head || document.documentElement).appendChild(s); }; document.readyState === 'loading' ? document.addEventListener('DOMContentLoaded', f) : f(); }, HIDE);
  const p = ctx.pages()[0] || await ctx.newPage(); p.setDefaultTimeout(20000); return { ctx, p };
}
export async function shot(p, dir, name, full = false) { fs.mkdirSync(path.join(SHOTS, dir), { recursive: true }); await p.screenshot({ path: path.join(SHOTS, dir, name + '.png'), fullPage: full }); return name; }
export const wait = (p, ms = 2500) => p.waitForTimeout(ms);
export const audio = name => path.join(AUDIO, name);
export const fakeMic = wav => ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', '--use-file-for-fake-audio-capture=' + wav];
// fetch the API with the cookies of an open page
export const api = (p, method, url, body) => p.evaluate(async ([A, m, u, b]) => {
  const r = await fetch(A + u, { method: m, credentials: 'include', headers: b ? { 'content-type': 'application/json' } : {}, body: b ? JSON.stringify(b) : undefined });
  const t = await r.text(); let j; try { j = JSON.parse(t); } catch { j = t.slice(0, 2000); } return { s: r.status, j };
}, [A, method, url, body]);
