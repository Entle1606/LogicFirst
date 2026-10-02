#!/usr/bin/env node
// LogicFirst challenge generator (Node 18+, no dependencies).
//   ANTHROPIC_API_KEY=... node scripts/generate.mjs --track backend --concept "pagination" --difficulty 2
//   node scripts/generate.mjs --approve <id>      move a reviewed draft to approved
//   node scripts/generate.mjs --build [--drafts]  write challenges.json (approved only, or + drafts for preview)
import fs from 'node:fs'; import path from 'node:path'; import vm from 'node:vm'; import { pathToFileURL } from 'node:url';

const MODEL = process.env.GEN_MODEL || 'claude-sonnet-5-5';
const DRAFTS = 'challenges/drafts', APPROVED = 'challenges/approved';
const BUILTIN = ['The Badge Counter', 'The Cart Total', 'The Password Check', 'The Duplicate Finder', 'The Order Pipeline'];
const TOPICS = ['pagination', 'string parsing', 'form validation', 'rate limiting', 'search and filtering', 'caching', 'sorting by a rule', 'state machines', 'grouping records', 'running totals'];
// Keep identical to PRE in index.html
const PRE = "const make=(n,c,r=0)=>Array.from({length:n},(_,i)=>({id:i,category:c,isRead:!!r}));const R=(k,v)=>v&&typeof v==='object'&&!Array.isArray(v)?Object.fromEntries(Object.entries(v).sort()):v;const eq=(a,b)=>JSON.stringify(a,R)===JSON.stringify(b,R);";

const EXAMPLE = {
  id: 'cart-total', t: 'The Cart Total', tr: 'Frontend', d: 'Sum a cart and apply a discount only when it earns one.', fn: 'cartTotal', a: 'items',
  bp: ['I receive {{0}}, each with a price and a qty. When the total passes {{1}}, I take {{2}} off. The function returns {{3}}.', ['an array of item objects', '100', '10', 'the final total as a number'], ['a single price', '50', 'one item', 'the discount only']],
  fl: [[1, 'start', 'Receive cart items'], [2, 'init', 'Set total to 0', '0'], [3, 'loop', 'For each item'], [4, 'action', 'Add price times quantity to total', 'quantity'], [5, 'cond', 'Total is greater than 100?', '100'], [6, 'action', 'Subtract 10 from total', '10'], [7, 'return', 'Return total', 'total']],
  ed: '1>2 2>3 3>4 4>3 3>5d 5>6y 5>7n 6>7', dc: ['1', '50', 'price', 'less'],
  cv: { i: [['30x2', 30, 2], ['20x1', 20, 1], ['40x2', 40, 2], ['check']], s: { total: 0 }, f: "(s,t)=>{if(t[0]=='check'){if(s.total>100)s.total-=10}else s.total+=t[1]*t[2];return s}" },
  ts: [[4, 'adds price times qty', 'cartTotal([{price:10,qty:3}])===30'], [5, 'exactly 100 is not discounted', 'cartTotal([{price:50,qty:2}])===100'], [6, 'over 100 takes 10 off', 'cartTotal([{price:60,qty:2}])===110'], [2, 'empty cart is 0', 'cartTotal([])===0']],
  ref: 'function cartTotal(items){let t=0;for(const x of items)t+=x.price*x.qty;if(t>100)t-=10;return t}'
};

const SYSTEM = `You write challenges for LogicFirst, an app that teaches computational thinking before syntax. Output ONE challenge as raw JSON (no markdown, no commentary) in exactly the shape of this example:
${JSON.stringify(EXAMPLE)}

RULES
- tr is Frontend (UI state, rendering logic, event handling, API data shaping), Backend (data processing, validation, algorithms, queries, routing) or Full-stack (client action -> validation -> data update -> UI sync).
- Language-agnostic phases: bp (blueprint), fl (flow), ed (edges), dc (script decoy words). Only fn/a/ts/ref are JavaScript.
- fl nodes are [id, type, label, keyword?]. Types: start, init, loop, cond, action, return. Ids are integers, first node is the start. Labels are short plain English; cond labels are questions. keyword (optional) must appear verbatim inside its label. Give at least 3 keywords.
- ed is space-separated edges "from>to" with optional suffix y (yes), n (no), d (done). Every cond has a y and an n edge. Every loop has a d edge. Return nodes have no outgoing edges. Every node is reachable from the start. Loop bodies connect back to their loop node.
- bp[0] uses {{0}}, {{1}}, ... in order; bp[1] holds the correct fill for each; bp[2] holds at least 3 plausible wrong chips.
- ts has at least 4 tests [flowNodeId, name, jsExpression]. Expressions may only use eq(a,b), ===, and your function. Cover edge cases: empty input, exact boundary. Tests must fail for an empty function.
- ref is a correct JavaScript reference solution that passes every test.
- cv is the simulation: i has 3 to 6 items [label, ...data]; s is the starting state; f is the source of an arrow function (s,t)=>{...; return s} that applies ONE item to the state. The FIRST key of s must be a number that changes at least once. Keys starting with _ are hidden helpers and may hold arrays.
- id is kebab-case. Keep it solvable by a beginner to intermediate in under 15 lines of code.`;

const bad = (E, ok, m) => { if (!ok) E.push(m); };

export function simulate(c) {
  const code = `(function(){const f=(${c.cv.f});let s=${JSON.stringify(c.cv.s)};const o=[s];for(const t of ${JSON.stringify(c.cv.i)}){s=f(JSON.parse(JSON.stringify(s)),JSON.parse(JSON.stringify(t)));o.push(s)}return JSON.stringify(o)})()`;
  return JSON.parse(vm.runInNewContext(code, {}, { timeout: 500 }));
}

export function validate(c) {
  const E = [], need = (ok, m) => bad(E, ok, m);
  for (const k of ['id', 't', 'tr', 'd', 'fn', 'a', 'bp', 'fl', 'ed', 'dc', 'cv', 'ts', 'ref']) need(c && c[k] !== undefined, 'missing field ' + k);
  if (E.length) return E;
  need(/^[a-z0-9-]+$/.test(c.id), 'id must be kebab-case');
  need(['Frontend', 'Backend', 'Full-stack'].includes(c.tr), 'tr must be Frontend, Backend or Full-stack');
  need(/^[A-Za-z_]\w*$/.test(c.fn), 'fn must be a valid identifier');
  const [tpl, ans, dec] = c.bp || [];
  need(typeof tpl === 'string' && Array.isArray(ans) && Array.isArray(dec), 'bp must be [template, answers, distractors]');
  if (E.length) return E;
  need(ans.length >= 3 && (tpl.match(/\{\{\d+\}\}/g) || []).length === ans.length && ans.every((_, i) => tpl.includes(`{{${i}}}`)), 'bp: placeholders {{0}}..{{n}} must match the answers (>=3)');
  need(dec.length >= 3, 'bp: need >=3 distractors');
  const ids = c.fl.map(n => n[0]);
  need(new Set(ids).size === ids.length && ids.every(Number.isInteger), 'fl: ids must be unique integers');
  need(c.fl[0] && c.fl[0][1] === 'start', 'fl: first node must be type start');
  need(c.fl.every(n => ['start', 'init', 'loop', 'cond', 'action', 'return'].includes(n[1]) && typeof n[2] === 'string'), 'fl: bad node shape or type');
  need(c.fl.filter(n => n[3]).length >= 3, 'fl: need >=3 keyword nodes');
  for (const n of c.fl) if (n[3] && !String(n[2]).includes(n[3])) E.push(`fl: keyword "${n[3]}" is not inside label "${n[2]}"`);
  need(c.dc.length >= 3, 'dc: need >=3 decoys');
  const m = String(c.ed).split(' ').map(e => e.match(/^(\d+)>(\d+)([ynd]?)$/));
  if (m.some(x => !x)) return [...E, 'ed: malformed edge'];
  const ed = m.map(x => ({ a: +x[1], b: +x[2], l: x[3] }));
  need(ed.every(e => ids.includes(e.a) && ids.includes(e.b)), 'ed: edge references an unknown node');
  need(new Set(c.ed.split(' ')).size === ed.length, 'ed: duplicate edge');
  for (const n of c.fl) {
    const out = ed.filter(e => e.a === n[0]).map(e => e.l);
    if (n[1] === 'cond') need(out.includes('y') && out.includes('n'), `fl: cond ${n[0]} needs yes and no edges`);
    if (n[1] === 'loop') need(out.includes('d'), `fl: loop ${n[0]} needs a done edge`);
    if (n[1] === 'return') need(!out.length, `fl: return ${n[0]} must have no outgoing edges`);
    else need(out.length > 0, `fl: node ${n[0]} has no outgoing edge`);
  }
  const seen = new Set([ids[0]]), q = [ids[0]];
  while (q.length) { const x = q.pop(); ed.filter(e => e.a === x).forEach(e => { if (!seen.has(e.b)) { seen.add(e.b); q.push(e.b); } }); }
  need(ids.every(i => seen.has(i)), 'fl: unreachable node(s)');
  need(Array.isArray(c.ts) && c.ts.length >= 4 && c.ts.every(t => ids.includes(t[0]) && typeof t[1] === 'string' && typeof t[2] === 'string'), 'ts: need >=4 tests [nodeId, name, expression] linked to real nodes');
  if (E.length) return E;
  need(new Set(c.ts.map(t => t[0])).size >= 2, 'ts: tests should cover at least 2 flow nodes');
  const run = code => c.ts.map(t => { try { return vm.runInNewContext(code + '\n' + PRE + '(' + t[2] + ')', {}, { timeout: 1000 }) === true; } catch { return false; } });
  const good = run(c.ref);
  need(good.every(Boolean), 'ref fails its own tests: ' + c.ts.filter((_, i) => !good[i]).map(t => t[1]).join(', '));
  need(!run(`function ${c.fn}(){}`).some(Boolean), 'an empty function passes a test, so the tests are too weak');
  need(Array.isArray(c.cv.i) && c.cv.i.length >= 3 && c.cv.i.length <= 6 && c.cv.i.every(t => Array.isArray(t) && typeof t[0] === 'string'), 'cv.i: 3 to 6 items, each [label, ...data]');
  need(c.cv.s && typeof c.cv.s === 'object' && typeof c.cv.f === 'string', 'cv: s must be an object and f a function source string');
  if (E.length) return E;
  try {
    const st = simulate(c), key = Object.keys(c.cv.s).find(k => k[0] !== '_');
    need(key && st.every(s => typeof s[key] === 'number'), 'cv: the first jar must stay a number');
    need(new Set(st.map(s => s[key])).size >= 2, 'cv: the first jar never changes');
  } catch (e) { E.push('cv.f failed: ' + e.message); }
  return E;
}

export const publish = c => ({ id: c.id, t: c.t, tr: c.tr, d: c.d, fn: c.fn, a: c.a, bp: c.bp, fl: c.fl, ed: c.ed, dc: c.dc, ts: c.ts, cv: { i: c.cv.i, s: c.cv.s, st: simulate(c) } });

const files = d => fs.existsSync(d) ? fs.readdirSync(d).filter(f => f.endsWith('.json')).map(f => path.join(d, f)) : [];
const read = f => JSON.parse(fs.readFileSync(f, 'utf8'));

async function claude(messages) {
  const r = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST', headers: { 'content-type': 'application/json', 'x-api-key': process.env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({ model: MODEL, max_tokens: 4000, system: SYSTEM, messages })
  });
  if (!r.ok) throw new Error('API ' + r.status + ' ' + await r.text());
  return (await r.json()).content.filter(b => b.type === 'text').map(b => b.text).join('').trim();
}

async function main() {
  const a = {}; const v = process.argv.slice(2);
  for (let i = 0; i < v.length; i++) if (v[i].startsWith('--')) a[v[i].slice(2)] = v[i + 1] && !v[i + 1].startsWith('--') ? v[++i] : true;
  if (a.build) {
    const list = [...files(APPROVED), ...(a.drafts ? files(DRAFTS) : [])].map(read);
    const out = list.filter(c => !validate(c).length).map(publish);
    fs.writeFileSync('challenges.json', JSON.stringify(out, null, 1));
    return console.log(`challenges.json: ${out.length} challenge(s)` + (list.length - out.length ? `, ${list.length - out.length} skipped (invalid)` : ''));
  }
  if (a.approve) {
    const f = path.join(DRAFTS, a.approve + '.json');
    if (!fs.existsSync(f)) return console.error('no such draft: ' + f);
    const c = read(f), E = validate(c);
    if (E.length) return console.error('still invalid:\n- ' + E.join('\n- '));
    fs.mkdirSync(APPROVED, { recursive: true });
    fs.writeFileSync(path.join(APPROVED, a.approve + '.json'), JSON.stringify({ ...c, status: 'approved' }, null, 1));
    fs.unlinkSync(f);
    return console.log('approved. Now run: node scripts/generate.mjs --build');
  }
  if (!process.env.ANTHROPIC_API_KEY) return console.error('Set ANTHROPIC_API_KEY first.');
  const track = a.track || 'frontend', concept = a.concept || TOPICS[Math.floor(Math.random() * TOPICS.length)], diff = a.difficulty || 2;
  const avoid = [...BUILTIN, ...[...files(DRAFTS), ...files(APPROVED)].map(f => read(f).t)];
  const msgs = [{ role: 'user', content: `Create one ${track} challenge about "${concept}", difficulty ${diff} out of 3. Do not reuse these titles or themes: ${avoid.join('; ')}.` }];
  for (let n = 1; n <= 3; n++) {
    const txt = await claude(msgs); let c, E;
    try { c = JSON.parse(txt.replace(/^```(?:json)?\s*|\s*```$/g, '')); E = validate(c); } catch { E = ['output was not valid JSON']; }
    if (!E.length) {
      fs.mkdirSync(DRAFTS, { recursive: true });
      fs.writeFileSync(path.join(DRAFTS, c.id + '.json'), JSON.stringify({ ...c, status: 'draft', model: MODEL, generatedAt: new Date().toISOString() }, null, 1));
      return console.log(`DRAFT saved (attempt ${n}): ${c.t} [${c.tr}]\nAll checks passed: schema, flow graph, reference solution vs tests, empty-stub fails, simulation.\nReview it: node scripts/generate.mjs --build --drafts, open the app, play it.\nThen: node scripts/generate.mjs --approve ${c.id}`);
    }
    console.log(`attempt ${n} rejected:\n- ` + E.join('\n- '));
    msgs.push({ role: 'assistant', content: txt }, { role: 'user', content: 'Rejected by the validator:\n- ' + E.join('\n- ') + '\nReturn the full corrected JSON only.' });
  }
  console.error('Gave up after 3 attempts. Nothing saved.');
}
if (import.meta.url === pathToFileURL(process.argv[1]).href) main().catch(e => { console.error(e.message); process.exit(1); });
