// K1's page (M19b's sheet; C29, C38): one file per load, named by `?case=`, shown in a pane as the
// file tab will show it. A Markdown file is drawn by fat-g's own component as M19 built it — the
// lexer K3 settled, `marked`, and fat-g's renderer (src/renderer/src/markdown) — under fat-g's own
// tokens and fonts; a plain text is drawn in the monospace font, unwrapped (C53), as one text node
// (`pre`) and as one element a line (`lines`).
//
// Per way of drawing it measures: the parse; the time to show, from the update to the task after
// its first paint, three times from an empty pane; the longest task and the longest frame while it
// showed; what is drawn; a scroll through the whole of it, down and for a plain text sideways too;
// and coming to a line in its middle (C40).
//
// What it leaves in `window.__k1` is numbers and element counts, never a text.
import { StrictMode, useSyncExternalStore } from 'react';
import { flushSync } from 'react-dom';
import { createRoot } from 'react-dom/client';
import { MarkdownText } from '../../../../src/renderer/src/markdown/MarkdownText';
import { parse } from '../../../../src/renderer/src/markdown/parse';
import '../../../../src/renderer/src/styles/fonts.css';
import '../../../../src/renderer/src/styles/tokens.css';
import '../../../../src/renderer/src/styles/global.css';
import { ALL_CASES as CASES } from '../fixture.mjs';
import './page.css';

const params = new URLSearchParams(location.search);
const name = params.get('case') ?? 'md-100000';
/** A check of the spike itself: one mount and a short scroll. */
const quick = params.has('quick');

const violations = [];
document.addEventListener('securitypolicyviolation', (event) => violations.push({ directive: event.violatedDirective, blocked: String(event.blockedURI).slice(0, 80) }));
const errors = [];
window.addEventListener('error', (event) => errors.push(String(event.message).slice(0, 200)));
window.addEventListener('unhandledrejection', (event) => errors.push(String(event.reason?.message ?? event.reason).slice(0, 200)));

// ── What is drawn ──────────────────────────────────────────────────────────────────────────────
const store = { state: { way: null, text: null, mark: null }, listeners: new Set() };
function setState(patch) {
  store.state = { ...store.state, ...patch };
  for (const listener of store.listeners) listener();
}
const subscribe = (listener) => { store.listeners.add(listener); return () => store.listeners.delete(listener); };

const WAYS = {
  markdown: ({ text }) => <MarkdownText text={text} />,
  pre: ({ text }) => <pre className="plain">{text}</pre>,
  // Not C53's way: what wrapping would cost, for a line too long to lay out unwrapped.
  wrapped: ({ text }) => <pre className="plain wrapped">{text}</pre>,
  lines: ({ text, mark }) => <div className="plain">{text.split('\n').map((line, index) => <div key={index} className={index === mark ? 'line mark' : 'line'}>{line}</div>)}</div>,
  // C54's way as settled: unwrapped to 2,000 px, a longer line wrapped at that width. One text node, and an element a line.
  capped: ({ text }) => <pre className="plain capped">{text}</pre>,
  'lines-capped': ({ text, mark }) => <div className="plain capped">{text.split('\n').map((line, index) => <div key={index} className={index === mark ? 'line mark' : 'line'}>{line}</div>)}</div>,
  // C54's first form, a whole text wrapped at the pane's width: as one text node above and as an element a line here.
  'lines-wrapped': ({ text, mark }) => <div className="plain wrapped">{text.split('\n').map((line, index) => <div key={index} className={index === mark ? 'line mark' : 'line'}>{line}</div>)}</div>,
};

function App() {
  const { way, text, mark } = useSyncExternalStore(subscribe, () => store.state);
  const Body = way ? WAYS[way] : null;
  return (
    <div className="pane">
      <div className="head">spike/{name}</div>
      <div className="body" id="body">{Body && text !== null ? <Body text={text} mark={mark} /> : null}</div>
    </div>
  );
}

// ── Measuring ──────────────────────────────────────────────────────────────────────────────────
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
/** The next frame: when its callbacks ran, and when the task after its style, layout and paint ran. */
const nextFrame = () => new Promise((resolve) => {
  requestAnimationFrame(() => {
    const frameAt = performance.now();
    const channel = new MessageChannel();
    channel.port1.onmessage = () => resolve({ frameAt, paintedAt: performance.now() });
    channel.port2.postMessage(0);
  });
});

/** One update: the script's own time (parse, render, commit), its frame's (style, layout, paint), and the whole from the update to the task after the paint. */
async function timed(update) {
  const startedAt = performance.now();
  flushSync(update);
  const scriptMs = performance.now() - startedAt;
  const frame = await nextFrame();
  return { scriptMs, frameMs: frame.paintedAt - frame.frameAt, shownMs: frame.paintedAt - startedAt };
}

const round = (value) => Math.round(value * 10) / 10;
function summary(values) {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const at = (share) => sorted[Math.min(sorted.length - 1, Math.floor(share * sorted.length))];
  return { n: sorted.length, median: round(at(0.5)), p95: round(at(0.95)), max: round(sorted.at(-1)) };
}

function observe() {
  const got = { longtask: [], loaf: [] };
  const observers = [];
  for (const [type, key] of [['longtask', 'longtask'], ['long-animation-frame', 'loaf']]) {
    try {
      const observer = new PerformanceObserver((list) => { for (const entry of list.getEntries()) got[key].push(entry.duration); });
      observer.observe({ type });
      observers.push([observer, key]);
    } catch { /* the entry type is not this engine's */ }
  }
  return {
    stop() {
      for (const [observer, key] of observers) { for (const entry of observer.takeRecords()) got[key].push(entry.duration); observer.disconnect(); }
      const of = (list) => ({ count: list.length, maxMs: list.length ? round(Math.max(...list)) : 0, totalMs: round(list.reduce((sum, value) => sum + value, 0)) });
      return { longTasks: of(got.longtask), longFrames: of(got.loaf) };
    },
  };
}

/** The text put into an empty pane, `runs` times: each time to show, and the long tasks and frames of all of it, what follows the first paint included. */
async function shows(way, text, runs) {
  const samples = [];
  const observer = observe();
  for (let run = 0; run < runs; run += 1) {
    await timed(() => setState({ way, text: null, mark: null }));
    await sleep(100);
    samples.push(await timed(() => setState({ way, text })));
    // What a first paint leaves to do: the parts that scroll sideways measure themselves, and are drawn again as stops.
    await sleep(400);
  }
  const observed = observer.stop();
  const each = samples.map((s) => ({ scriptMs: round(s.scriptMs), frameMs: round(s.frameMs), shownMs: round(s.shownMs) }));
  return { each, shownMs: summary(samples.map((s) => s.shownMs)), scriptMs: summary(samples.map((s) => s.scriptMs)), frameMs: summary(samples.map((s) => s.frameMs)), ...observed };
}

/** The body scrolled through, 1,200 px a frame, along one axis. */
async function scrollCost(axis, most = 3_000) {
  const body = document.getElementById('body');
  const [place, size, view] = axis === 'down' ? ['scrollTop', 'scrollHeight', 'clientHeight'] : ['scrollLeft', 'scrollWidth', 'clientWidth'];
  body[place] = 0;
  await nextFrame();
  const end = body[size] - body[view];
  // 1,200 px a frame, or sixty steps where there is less than that to scroll: a text capped at 2,000 px.
  const step = Math.min(1_200, Math.max(20, Math.ceil(end / 60)));
  const gaps = [];
  const observer = observe();
  let last = null;
  await new Promise((resolve) => {
    const frame = (now) => {
      if (last !== null) gaps.push(now - last);
      last = now;
      if (body[place] >= end - 1 || gaps.length > (quick ? 30 : most)) { resolve(); return; }
      body[place] += step;
      requestAnimationFrame(frame);
    };
    requestAnimationFrame(frame);
  });
  const observed = observer.stop();
  body[place] = 0;
  await nextFrame();
  return { px: body[size], frames: gaps.length, gap: summary(gaps), over33: gaps.filter((g) => g > 33.4).length, over50: gaps.filter((g) => g > 50).length, over100: gaps.filter((g) => g > 100).length, ...observed };
}

/** Coming to a line in the middle (C40): the block that holds it, or the line's own element, brought into view. */
async function jump(way, text) {
  const body = document.getElementById('body');
  body.scrollTop = 0;
  await nextFrame();
  const startedAt = performance.now();
  if (way.startsWith('lines')) {
    const lines = text.split('\n').length;
    flushSync(() => setState({ mark: Math.floor(lines * 0.6) }));
    body.querySelector('.mark')?.scrollIntoView({ block: 'center' });
  } else if (way === 'markdown') {
    const blocks = body.firstElementChild?.children ?? [];
    blocks[Math.floor(blocks.length * 0.6)]?.scrollIntoView({ block: 'center' });
  } else {
    // One text node has no element for a line: its place is reckoned from the line's number.
    const lines = text.split('\n').length;
    body.scrollTop = (body.scrollHeight * Math.floor(lines * 0.6)) / lines;
  }
  const scriptMs = performance.now() - startedAt;
  const frame = await nextFrame();
  return { scriptMs: round(scriptMs), frameMs: round(frame.paintedAt - frame.frameAt), shownMs: round(frame.paintedAt - startedAt), cameTo: Math.round(body.scrollTop) };
}

const median = (values) => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];
function parseTime(text, runs = 5) {
  const times = [];
  let blocks = 0;
  for (let run = 0; run < runs; run += 1) { const startedAt = performance.now(); blocks = parse(text).blocks.length; times.push(performance.now() - startedAt); }
  return { median: round(median(times)), max: round(Math.max(...times)), blocks };
}

async function run() {
  const chosen = CASES[name];
  if (!chosen) throw new Error(`unknown case ${name}`);
  const text = chosen.text();
  const lines = text.split('\n');
  const root = createRoot(document.getElementById('root'));
  flushSync(() => root.render(<StrictMode><App /></StrictMode>));
  await document.fonts.ready;
  await nextFrame();
  const body = document.getElementById('body');
  const report = {
    case: name, kind: chosen.kind, development: import.meta.env.DEV, quick,
    text: { units: text.length, bytes: new Blob([text]).size, lines: lines.length, longestLine: lines.reduce((most, line) => Math.max(most, line.length), 0) },
    pane: { widthPx: body.clientWidth, heightPx: body.clientHeight, font: getComputedStyle(body).fontFamily.split(',')[0] },
    ways: {},
  };
  // What is done so far stays readable from outside: a page that never ends a stage still says which, and what came before it.
  const at = (stage) => { window.__k1 = { done: false, at: stage, partial: report }; };
  for (const way of chosen.ways) {
    const out = {};
    report.ways[way] = out;
    at(`${name}/${way}/show`);
    if (way === 'markdown') out.parse = parseTime(text);
    out.show = await shows(way, text, quick ? 1 : 3);
    out.drawn = { elements: body.querySelectorAll('*').length, heightPx: body.scrollHeight, widthPx: body.scrollWidth, heapMb: performance.memory ? Math.round(performance.memory.usedJSHeapSize / 1024 / 1024) : null };
    at(`${name}/${way}/scroll down`);
    out.scrollDown = await scrollCost('down', chosen.scrollFrames);
    if (chosen.kind === 'plain' && !way.endsWith('wrapped')) {
      at(`${name}/${way}/scroll sideways`);
      out.scrollSideways = await scrollCost('sideways', chosen.scrollFrames);
    }
    at(`${name}/${way}/coming to a line`);
    out.jump = await jump(way, text);
    await timed(() => setState({ way, text: null, mark: null }));
    await sleep(200);
  }
  return { ...report, violations, errors };
}

window.__k1 = { done: false, at: 'start' };
run().then((report) => { window.__k1 = { done: true, report }; }, (error) => { window.__k1 = { done: true, report: { case: name, failed: String(error?.stack ?? error).slice(0, 1_000), violations, errors } }; });
