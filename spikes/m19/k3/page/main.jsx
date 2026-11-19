// K3's page (M19, C25, C28, C51, C52, C61): one parser per load, named by `?lib=`. It draws the
// fixture as the chat will — a list of messages, each read as Markdown once and again only when its
// text changes — and measures, per way of drawing: the parse and the display of the two static
// messages, the newest page and the full window, each stream into a full window at a 50 ms and a
// 100 ms interval, and a scroll through the window. It then records how a few small texts draw.
//
// What it leaves in `window.__k3` is numbers and element names, and the spike's own probe texts.
import { StrictMode, memo, useLayoutEffect, useRef, useSyncExternalStore } from 'react';
import { flushSync } from 'react-dom';
import { createRoot } from 'react-dom/client';
import * as fixture from '../fixture.mjs';
import './page.css';

const params = new URLSearchParams(location.search);
const lib = params.get('lib') ?? 'rm';
const quick = params.has('quick');
/** Units a second a stream grows by: faster than either CLI writes, so that a run is minutes. The cost of an update is its text's size, not its rate. */
const RATE = quick ? 50_000 : 5_000;
const INTERVALS = [50, 100];
/** A page and a window, in items (src/shared/contracts/conversation.ts). */
const PAGE_ITEMS = 100;
const WINDOW_ITEMS = 500;

const violations = [];
document.addEventListener('securitypolicyviolation', (event) => violations.push({ directive: event.violatedDirective, blocked: String(event.blockedURI).slice(0, 80) }));
const errors = [];
window.addEventListener('error', (event) => errors.push(String(event.message).slice(0, 200)));
window.addEventListener('unhandledrejection', (event) => errors.push(String(event.reason?.message ?? event.reason).slice(0, 200)));

// ── What is drawn ──────────────────────────────────────────────────────────────────────────────
const store = { state: { items: [], mode: null }, listeners: new Set(), follow: true };
function setState(patch) {
  store.state = { ...store.state, ...patch };
  for (const listener of store.listeners) listener();
}
const subscribe = (listener) => { store.listeners.add(listener); return () => store.listeners.delete(listener); };

const Message = memo(function Message({ item, Body }) {
  return (
    <article data-role={item.role}>
      <p className="label">{item.role === 'user' ? 'You' : 'Model'}</p>
      {item.role === 'assistant' && Body ? <div className="md"><Body text={item.text} /></div> : <p className="text">{item.text}</p>}
    </article>
  );
});

function App({ modes }) {
  const { items, mode } = useSyncExternalStore(subscribe, () => store.state);
  const list = useRef(null);
  // The list keeps to its end, as the chat's does while the reader is there (C45): a measured layout at every update.
  useLayoutEffect(() => {
    if (store.follow && list.current) list.current.scrollTop = list.current.scrollHeight;
  });
  const Body = mode ? modes[mode] : null;
  return <div className="list" id="list" ref={list}>{items.map((item) => <Message key={item.id} item={item} Body={Body} />)}</div>;
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

/** One update: the script's own time (render, commit, the measured scroll), then its frame's (style, layout, paint). */
async function timed(update) {
  const startedAt = performance.now();
  flushSync(update);
  const scriptMs = performance.now() - startedAt;
  const frame = await nextFrame();
  const frameMs = frame.paintedAt - frame.frameAt;
  return { scriptMs, frameMs, workMs: scriptMs + frameMs };
}

const round = (value) => Math.round(value * 10) / 10;
function summary(values) {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const at = (share) => sorted[Math.min(sorted.length - 1, Math.floor(share * sorted.length))];
  return { n: sorted.length, median: round(at(0.5)), p95: round(at(0.95)), max: round(sorted.at(-1)) };
}
const three = (samples) => ({ script: summary(samples.map((s) => s.scriptMs)), frame: summary(samples.map((s) => s.frameMs)), work: summary(samples.map((s) => s.workMs)) });

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
      const of = (list) => ({ count: list.length, maxMs: list.length ? round(Math.max(...list)) : 0 });
      return { longTasks: of(got.longtask), longFrames: of(got.loaf) };
    },
  };
}

/** `items` put into an empty list, `runs` times. */
async function mounts(items, runs = 3) {
  const samples = [];
  for (let run = 0; run < runs; run += 1) {
    await timed(() => setState({ items: [] }));
    await sleep(50);
    samples.push(await timed(() => setState({ items })));
    await sleep(50);
  }
  return three(samples);
}

/** One stream into a full window: the text due at each interval, put in with one update. */
async function stream(kind, intervalMs, windowItems) {
  const full = fixture.streamText(kind);
  // The window is full with the streaming message in it.
  const held = windowItems.slice(-(WINDOW_ITEMS - 1));
  await timed(() => setState({ items: [...held, { id: `stream-${kind}-${intervalMs}`, role: 'assistant', text: '' }] }));
  await sleep(300);
  const id = `stream-${kind}-${intervalMs}`;
  const observer = observe();
  const samples = [];
  const startedAt = performance.now();
  let shown = 0;
  while (shown < full.length) {
    const tickAt = performance.now();
    // What has arrived by now: an update that overran its interval takes what gathered meanwhile.
    shown = Math.min(full.length, Math.max(shown + 1, Math.floor(((tickAt - startedAt + intervalMs) / 1000) * RATE)));
    const text = full.slice(0, shown);
    const sample = await timed(() => setState({ items: [...held, { id, role: 'assistant', text }] }));
    samples.push({ units: shown, ...sample });
    const wait = intervalMs - (performance.now() - tickAt);
    if (wait > 0) await sleep(wait);
  }
  const seconds = (performance.now() - startedAt) / 1000;
  await sleep(200);
  const observed = observer.stop();
  const quarter = (low, high) => {
    const part = samples.filter((s) => s.units > low && s.units <= high);
    return part.length ? { toUnits: high, scriptMax: round(Math.max(...part.map((s) => s.scriptMs))), frameMax: round(Math.max(...part.map((s) => s.frameMs))), workMedian: summary(part.map((s) => s.workMs)).median } : null;
  };
  const step = full.length / 4;
  const drawn = document.querySelector('#list article:last-child .md');
  return {
    units: full.length, updates: samples.length, seconds: round(seconds), ...three(samples),
    scriptOver50: samples.filter((s) => s.scriptMs > 50).length, workOver50: samples.filter((s) => s.workMs > 50).length,
    bySize: [quarter(0, step), quarter(step, 2 * step), quarter(2 * step, 3 * step), quarter(3 * step, full.length)].filter(Boolean),
    worst: [...samples].sort((a, b) => b.workMs - a.workMs).slice(0, 3).map((s) => ({ units: s.units, scriptMs: round(s.scriptMs), frameMs: round(s.frameMs) })),
    ...observed,
    drawnElements: drawn ? drawn.querySelectorAll('*').length : null,
  };
}

/** The full window scrolled from its end to its start, 1,200 px a frame. */
async function scrollCost(windowItems) {
  store.follow = false;
  await timed(() => setState({ items: windowItems }));
  const list = document.getElementById('list');
  list.scrollTop = list.scrollHeight;
  await nextFrame();
  const gaps = [];
  let last = null;
  await new Promise((resolve) => {
    const frame = (now) => {
      if (last !== null) gaps.push(now - last);
      last = now;
      if (list.scrollTop <= 0 || gaps.length > 2_000) { resolve(); return; }
      list.scrollTop -= 1_200;
      requestAnimationFrame(frame);
    };
    requestAnimationFrame(frame);
  });
  store.follow = true;
  return { heightPx: list.scrollHeight, frames: gaps.length, gap: summary(gaps), over33: gaps.filter((g) => g > 33.4).length, over50: gaps.filter((g) => g > 50).length };
}

// ── How small texts draw (C31 to C33, C61) ─────────────────────────────────────────────────────
function probes(Body) {
  const host = document.getElementById('probe');
  const root = createRoot(host);
  const draw = (text) => flushSync(() => root.render(<div className="md"><Body text={text} /></div>));
  const facts = () => ({
    html: host.firstElementChild.innerHTML.slice(0, 900),
    elements: [...new Set([...host.querySelectorAll('.md *')].map((element) => element.tagName.toLowerCase()))].sort(),
    anchors: host.querySelectorAll('a').length, images: host.querySelectorAll('img').length, scripts: host.querySelectorAll('script').length, inputs: host.querySelectorAll('input').length,
    handlers: [...host.querySelectorAll('.md *')].filter((element) => [...element.attributes].some((attribute) => /^on/i.test(attribute.name))).length,
    withAddress: [...host.querySelectorAll('.md *')].filter((element) => element.hasAttribute('href') || element.hasAttribute('src')).length,
  });
  const out = {};
  for (const [name, text] of Object.entries(fixture.PROBES)) {
    try { draw(text); out[name] = facts(); } catch (error) { out[name] = { threw: String(error?.message ?? error).slice(0, 200) }; }
  }
  // A definition that arrives late: which earlier paragraphs keep their nodes.
  try {
    draw(fixture.LATE.before);
    const before = { ...facts(), paragraphs: [...host.querySelectorAll('.md p')] };
    draw(fixture.LATE.before + fixture.LATE.after);
    const after = facts();
    const now = [...host.querySelectorAll('.md p')];
    out.lateDefinition = { before: { html: before.html, elements: before.elements }, after: { html: after.html, elements: after.elements }, paragraphNodesKept: before.paragraphs.map((node, index) => now[index] === node), changed: before.html !== after.html };
  } catch (error) { out.lateDefinition = { threw: String(error?.message ?? error).slice(0, 200) }; }
  flushSync(() => root.unmount());
  return out;
}

const median = (values) => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];
function parseTime(parseOnly, text, runs = 5) {
  const times = [];
  for (let run = 0; run < runs; run += 1) { const startedAt = performance.now(); parseOnly(text); times.push(performance.now() - startedAt); }
  return { median: round(median(times)), max: round(Math.max(...times)) };
}

async function run() {
  const loadedAt = performance.now();
  const module = lib === 'marked' ? await import('./marked.jsx') : await import('./rm.jsx');
  const moduleMs = round(performance.now() - loadedAt);
  const root = createRoot(document.getElementById('root'));
  flushSync(() => root.render(<StrictMode><App modes={module.MODES} /></StrictMode>));
  const windowItems = fixture.items(WINDOW_ITEMS / 2);
  const pageItems = windowItems.slice(-PAGE_ITEMS);
  const statics = { large: fixture.largeMessage(), nested: fixture.nestedMessage() };
  const only = params.get('modes')?.split(',') ?? Object.keys(module.MODES);
  const report = {
    lib, development: import.meta.env.DEV, quick, rateUnitsPerSecond: RATE, moduleLoadMs: moduleMs,
    window: { items: windowItems.length, units: windowItems.reduce((sum, item) => sum + item.text.length, 0) }, page: { items: pageItems.length, units: pageItems.reduce((sum, item) => sum + item.text.length, 0) },
    modes: {},
  };
  for (const mode of only) {
    const out = {};
    report.modes[mode] = out;
    window.__k3 = { done: false, at: `${lib}/${mode}` };
    setState({ mode, items: [] });
    await nextFrame();
    out.static = {};
    for (const [name, text] of Object.entries(statics)) out.static[name] = { units: text.length, parse: parseTime(module.parseOnly, text), display: await mounts([{ id: `static-${name}`, role: 'assistant', text }]) };
    out.display = { newestPage: await mounts(pageItems), fullWindow: await mounts(windowItems) };
    out.streams = {};
    for (const kind of fixture.STREAMS) {
      out.streams[kind] = {};
      for (const intervalMs of INTERVALS) {
        window.__k3 = { done: false, at: `${lib}/${mode}/${kind}/${intervalMs}` };
        out.streams[kind][intervalMs] = await stream(kind, intervalMs, windowItems);
      }
    }
    out.scroll = await scrollCost(windowItems);
    out.probes = probes(module.MODES[mode]);
  }
  setState({ items: [] });
  return { ...report, violations, errors };
}

window.__k3 = { done: false, at: 'start' };
run().then((report) => { window.__k3 = { done: true, report }; }, (error) => { window.__k3 = { done: true, report: { lib, failed: String(error?.stack ?? error).slice(0, 1_000), violations, errors } }; });
