'use strict';
/* SparkBench viewer. Reads the published snapshot (data.json, summary.json, workloads.json); never contacts a model server. */

// ---------------------------------------------------------------- utilities
const $ = (s, root = document) => root.querySelector(s);
const $$ = (s, root = document) => [...root.querySelectorAll(s)];
const esc = v => String(v ?? '').replace(/[&<>"']/g, c => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'}[c]));
const isNum = v => typeof v === 'number' && Number.isFinite(v);
const fmt = (v, d = 1) => isNum(v) ? v.toLocaleString('en', {minimumFractionDigits: d, maximumFractionDigits: d}) : '—';
const fmtInt = v => isNum(v) ? Math.round(v).toLocaleString('en') : '—';
const val = (v, unit = '', d = 1) => v == null ? 'Not recorded' : `${fmt(v, d)}${unit ? ' ' + unit : ''}`;
const cap = s => s ? s[0].toUpperCase() + s.slice(1) : '';
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
// "11 October 2026", or with month: 'short' "11 Oct"; built by hand so every browser prints the same thing.
const dayLabel = (iso, opts = {day: 'numeric', month: 'long', year: 'numeric'}) => {
  if (!iso) return '';
  const d = new Date(iso.length === 10 ? iso + 'T12:00:00Z' : iso), month = MONTHS[d.getUTCMonth()];
  return [opts.day ? d.getUTCDate() : '', opts.month === 'short' ? month.slice(0, 3) : month, opts.year ? d.getUTCFullYear() : ''].filter(Boolean).join(' ');
};

// ---------------------------------------------------------------- constants and state
const WORKLOADS = ['writing', 'coding', 'chat'];
const METRICS = {
  decode_tps: {label: 'Output speed', unit: 'tok/s', digits: 1, low: false},
  ttft_s: {label: 'First token', unit: 's', digits: 3, low: true},
  prefill_tps: {label: 'Prompt speed', unit: 'tok/s', digits: 0, low: false},
  end_to_end_tps: {label: 'End-to-end speed', unit: 'tok/s', digits: 1, low: false},
};
const metricKeys = Object.keys(METRICS);
const COOKIE = 'sparkbench_preferences_v1';
const ENGINE_SLOT = {TensorFold: 1, Ollama: 2, vLLM: 3};
const STUDY_PROTOCOL = 'tensorfold-quant-study-20261011';
const SOURCE_LABELS = {
  'sparkbench-workloads-v1': '30 Sep suite',
  'tensorfold-supplementary-20260929': '29 Sep archive',
  [STUDY_PROTOCOL]: '11 Oct study',
};
const TAPE_TOKENS = 512;
const RACE_DEFAULTS = [
  ['qwen3:0.6b-q4_K_M', 'Ollama'], ['Qwen3.8-Flash-Next', 'TensorFold'], ['Qwen3.8-27B-NVFP4', 'TensorFold'],
  ['gemma4:26b', 'Ollama'], ['gpt-oss:120b-a5.1b-mxfp4', 'Ollama'],
  ['nvidia_NVIDIA-Nemotron-3-Super-120B-A12B-NVFP4', 'vLLM'], ['Qwen3.8-27B-BF16', 'vLLM'],
];
const GB10_BANDWIDTH = 273e9; // bytes per second, NVIDIA's published DGX Spark memory bandwidth

const defaultState = () => ({
  workload: 'writing', query: '', engine: 'all', format: 'all', quant: '', sort: 'speed', group: true, view: 'all',
  scope: 'all', metric: 'decode_tps', showLatency: true, minParams: '', maxParams: '', maxActive: '', maxDisk: '',
  includeUnmeasured: true, includeUnknown: true, remember: true, theme: 'system', axis: 'disk',
});
let DATA, SUM, WORK, models = [], state = defaultState(), selected = new Set(), toastTimer, preferencesRestored = false;
const openPanels = new Map();

// ---------------------------------------------------------------- DOM morphing keeps focus, scroll and open panels across re-renders
function nodeKey(n) {
  if (n.nodeType !== 1) return null;
  if (n.id) return 'id:' + n.id;
  if (n.dataset.row) return 'row:' + n.dataset.row;
  if (n.tagName === 'DETAILS') return 'details:' + (n.closest('[data-row]')?.dataset.row || 'page') + ':' + n.querySelector('summary')?.textContent;
  return null;
}
function morphNode(old, fresh) {
  if (old.nodeType !== fresh.nodeType || old.nodeName !== fresh.nodeName) { old.replaceWith(fresh); return fresh; }
  if (old.nodeType !== 1) { if (old.nodeValue !== fresh.nodeValue) old.nodeValue = fresh.nodeValue; return old; }
  if (old.id === 'results' && !fresh.childNodes.length) return old;
  const freshValue = fresh.value, isDetails = old.tagName === 'DETAILS', isCanvas = old.tagName === 'CANVAS';
  for (const a of [...old.attributes]) if (!fresh.hasAttribute(a.name) && !(isDetails && a.name === 'open') && !(isCanvas && (a.name === 'width' || a.name === 'height'))) old.removeAttribute(a.name);
  for (const a of [...fresh.attributes]) if (!(isDetails && a.name === 'open') && old.getAttribute(a.name) !== a.value) old.setAttribute(a.name, a.value);
  if (old.tagName === 'INPUT') { if (old !== document.activeElement && old.value !== fresh.value) old.value = fresh.value; old.checked = fresh.checked; }
  if (old.tagName === 'OPTION') old.selected = fresh.selected;
  if (isCanvas) return old;
  const originals = [...old.childNodes], used = new Set();
  const keyed = new Map(originals.map(n => [nodeKey(n), n]).filter(([k]) => k));
  let cursor = old.firstChild;
  for (const wanted of [...fresh.childNodes]) {
    const key = nodeKey(wanted);
    let match = key ? keyed.get(key) : null;
    if (match && used.has(match)) match = null;
    if (!match) match = originals.find(n => !used.has(n) && !nodeKey(n) && n.nodeName === wanted.nodeName && n.nodeType === wanted.nodeType);
    if (match) {
      used.add(match);
      if (match !== cursor) old.insertBefore(match, cursor);
      match = morphNode(match, wanted);
      cursor = match.nextSibling;
    } else {
      old.insertBefore(wanted, cursor);
      if (wanted.nodeType === 1 && wanted.tagName === 'DETAILS' && openPanels.has(nodeKey(wanted))) wanted.open = openPanels.get(nodeKey(wanted));
    }
  }
  for (const n of originals) if (!used.has(n) && n.parentNode === old) old.removeChild(n);
  if (old.tagName === 'SELECT' && old !== document.activeElement) old.value = freshValue;
  return old;
}
function patch(selector, html) {
  const el = $(selector);
  if (!el) return;
  el.querySelectorAll('details').forEach(d => openPanels.set(nodeKey(d), d.open));
  const temp = el.cloneNode(false);
  temp.innerHTML = html;
  morphNode(el, temp);
  el.querySelectorAll('details').forEach(d => { if (openPanels.has(nodeKey(d))) d.open = openPanels.get(nodeKey(d)); });
}
function content(html) { patch('#content', html); }

// ---------------------------------------------------------------- preferences (first-party cookie, opt-out)
function persistPreferences() {
  const secure = location.protocol === 'https:' ? '; Secure' : '';
  if (!state.remember) { document.cookie = COOKIE + '=; Max-Age=0; Path=/; SameSite=Lax' + secure; return; }
  const saved = {v: 1, state: {...state}, selected: [...selected].slice(0, 8)};
  let encoded = encodeURIComponent(JSON.stringify(saved));
  while (encoded.length > 3600 && (saved.state.query.length || saved.state.quant.length)) {
    const k = saved.state.query.length >= saved.state.quant.length ? 'query' : 'quant';
    const chars = Array.from(saved.state[k]);
    saved.state[k] = chars.slice(0, Math.floor(chars.length * .8)).join('');
    encoded = encodeURIComponent(JSON.stringify(saved));
  }
  document.cookie = COOKIE + '=' + encoded + '; Max-Age=15552000; Path=/; SameSite=Lax' + secure;
}
function restorePreferences() {
  if (preferencesRestored) return;
  preferencesRestored = true;
  try {
    const entry = document.cookie.split('; ').find(c => c.startsWith(COOKIE + '='));
    if (!entry) return;
    const saved = JSON.parse(decodeURIComponent(entry.slice(COOKIE.length + 1)));
    if (saved.v !== 1 || !saved.state || saved.state.remember !== true) return;
    const stored = saved.state, base = defaultState();
    for (const k of Object.keys(base)) {
      if (typeof base[k] === 'boolean') { if (typeof stored[k] === 'boolean') state[k] = stored[k]; }
      else if (typeof stored[k] === 'string' && stored[k].length < 250) state[k] = stored[k];
    }
    const allowed = {
      workload: WORKLOADS, view: ['all', 'single'], scope: ['all', 'selected'], metric: metricKeys,
      sort: ['speed', 'ttft', 'memory', 'name', 'params', 'active', 'disk'], theme: ['system', 'light', 'dark'], axis: ['disk', 'params'],
      engine: ['all', ...new Set(models.map(m => m.engine))], format: ['all', ...new Set(models.map(formatOf))],
    };
    for (const [k, values] of Object.entries(allowed)) if (!values.includes(state[k])) state[k] = base[k];
    for (const k of ['minParams', 'maxParams', 'maxActive', 'maxDisk']) if (state[k] !== '' && (!Number.isFinite(Number(state[k])) || Number(state[k]) < 0)) state[k] = '';
    selected = new Set([...new Set((Array.isArray(saved.selected) ? saved.selected : []).filter(id => models.some(m => m.id === id)))].slice(0, 8));
  } catch {
    state = defaultState();
    selected.clear();
    document.cookie = COOKIE + '=; Max-Age=0; Path=/; SameSite=Lax';
  }
}
function currentPath() { return (location.hash.slice(1) || 'models').split('?')[0]; }
function replaceURL() {
  const path = currentPath(), q = new URLSearchParams();
  q.set('workload', state.workload);
  if (path === 'models') { q.set('view', state.view); q.set('scope', state.scope); }
  if (path === 'compare') q.set('models', [...selected].join(','));
  history.replaceState(null, '', '#' + path + '?' + q);
}
function updateInPlace() {
  const x = window.scrollX, y = window.scrollY;
  render(true);
  replaceURL();
  persistPreferences();
  window.scrollTo(x, y);
}

// ---------------------------------------------------------------- theme
function applyTheme() {
  const root = document.documentElement;
  if (state.theme === 'system') delete root.dataset.theme; else root.dataset.theme = state.theme;
  const button = $('#theme-toggle');
  const icons = {
    system: '<circle cx="10" cy="10" r="6.5"/><path d="M10 3.5a6.5 6.5 0 0 1 0 13z" class="fill"/>',
    light: '<circle cx="10" cy="10" r="3.6"/><path d="M10 1.8v2.4M10 15.8v2.4M1.8 10h2.4M15.8 10h2.4M4.2 4.2l1.7 1.7M14.1 14.1l1.7 1.7M4.2 15.8l1.7-1.7M14.1 5.9l1.7-1.7"/>',
    dark: '<path d="M15.5 12.6A6.5 6.5 0 0 1 7.4 4.5a6.5 6.5 0 1 0 8.1 8.1z" class="fill"/>',
  };
  button.innerHTML = `<svg viewBox="0 0 20 20" aria-hidden="true">${icons[state.theme]}</svg>`;
  const next = {system: 'light', light: 'dark', dark: 'system'}[state.theme];
  button.setAttribute('aria-label', `Colour theme: ${state.theme}. Switch to ${next}`);
  button.title = `Theme: ${cap(state.theme)}`;
  Race.recolor();
}

// ---------------------------------------------------------------- data model
function notify(s) { $('#toast').textContent = s; $('#toast').hidden = false; clearTimeout(toastTimer); toastTimer = setTimeout(() => $('#toast').hidden = true, 3600); }
function rawModel(s) { return DATA.runs.flatMap(r => r.models || []).find(m => m.name === s.model && m.engine === s.engine); }
function median(a) { if (!a.length) return null; const b = a.slice().sort((x, y) => x - y); return b.length % 2 ? b[(b.length - 1) / 2] : (b[b.length / 2 - 1] + b[b.length / 2]) / 2; }
function numberB(v) {
  if (typeof v === 'number') return Number.isFinite(v) ? (v >= 1e6 ? v / 1e9 : v) : null;
  const match = String(v ?? '').trim().match(/^([0-9,.]+)\s*([BMK])?$/i);
  if (!match) return null;
  const n = Number(match[1].replaceAll(',', '')), unit = match[2]?.toUpperCase();
  return Number.isFinite(n) ? n * (unit === 'M' ? .001 : unit === 'K' ? .000001 : unit === 'B' ? 1 : n >= 1e6 ? 1e-9 : 1) : null;
}
function displayParameters(v) { const n = Number(v); return Number.isFinite(n) && n >= 1e6 ? `${fmt(n / (n >= 1e9 ? 1e9 : 1e6), 2)}${n >= 1e9 ? 'B' : 'M'}` : v; }
function validNumber(v) { return isNum(v) ? v : null; }
function formatOf(m) { return m.format || m.raw?.format || 'Unknown'; }
function engineSlot(engine) { return ENGINE_SLOT[engine] || 0; }
function groupKey(m) { return `${m.engine}:${m.raw?.digest || m.manifest_digest || m.config?.checkpoint?.revision || m.id}`; }
function representative(list) { return list.find(m => !m.model.includes(':') || !['default', 'coder', 'vision', 'reasoning', 'fast', 'agent'].includes(m.model.split(':')[0])) || list[0]; }
function normalise(m) {
  const raw = m.raw;
  return {
    ...m, kind: m.kind || raw?.kind || 'generation', quant: m.quantization_metadata || raw?.quantization || 'Unknown',
    params: displayParameters(m.parameter_size || raw?.parameters || 'Unknown'), active: displayParameters(m.active_parameters || raw?.active_parameters || null),
    totalB: numberB(m.parameter_size || raw?.parameters), activeB: numberB(m.active_parameters || raw?.active_parameters), diskGiB: validNumber(m.tag_disk_gib),
    name: m.display_name || m.model,
  };
}
function buildModels() {
  const base = SUM.models.map((m, i) => { const raw = rawModel(m); return normalise({...m, id: raw?.id || String(i), raw}); });
  const added = (WORK.configurations || []).map(c => normalise({...c, raw: null, config: c}));
  models = [...base, ...added.filter(c => !base.some(b => b.id === c.id))];
}
function profileFor(m) {
  if (m.config) return {};
  const p = SUM.protocol.engine_profiles || {};
  if (m.status === 'unavailable') return {version: m.raw?.metadata?.compatibility?.version || (m.engine === 'TensorFold' ? p.TensorFold?.version : p.additional_vLLM_and_Qwen_BF16?.version)};
  if (m.engine === 'TensorFold') return p.TensorFold || {};
  if (m.engine === 'Ollama') return p.Ollama || {};
  if (m.model === 'Qwen3.8-27B-Uncensored') return p.existing_FP8_vLLM || {};
  return p.additional_vLLM_and_Qwen_BF16 || {};
}
function latestAttempt(m, w = state.workload) {
  return (WORK.results || []).filter(r => r.workload === w && (r.model_id === m.id || r.model_name === m.model) && r.engine === m.engine)
    .sort((a, b) => String(b.provenance?.measured_at || '').localeCompare(String(a.provenance?.measured_at || '')))[0];
}
function writingMeasurement(m) {
  const base = SUM.protocol || {}, profile = profileFor(m), server = m.raw?.metadata?.server || {};
  const observed = (m.raw?.history || []).filter(h => h.status === 'ok').sort((a, b) => String(b.observed_utc || '').localeCompare(String(a.observed_utc || '')))[0]?.observed_utc;
  return {
    workload: 'writing', trial_count: m.trial_count, metrics: Object.fromEntries(metricKeys.map(k => [k, m[k] || {median: null}])),
    protocol: {
      id: 'sparkbench-essay-v1', prompt_family: 'Shared essay prompt',
      sampling: 'Temperature ' + (server.temperature ?? base.temperature) + '; thinking requested ' + ((server.thinking ?? base.thinking) === false ? 'off' : 'on') + '; concurrency ' + (server.request_concurrency ?? base.concurrency),
      context_tokens: server.context_tokens ?? profile.maximum_context ?? profile.requested_context ?? base.context_tokens,
      temperature: server.temperature ?? base.temperature, seed: server.seed_sent ?? base.seed, thinking: server.thinking ?? base.thinking,
      concurrency: server.request_concurrency ?? base.concurrency, timing_basis: m.decode_measurement, notes: [],
    },
    provenance: {source: 'SparkBench three-trial baseline', measured_at: observed},
  };
}
function measurements(m, w = state.workload) {
  if (w === 'writing') return m.status === 'ok' && m.kind === 'generation' && m.writing_baseline !== false ? [writingMeasurement(m)] : [];
  return (WORK.results || []).filter(r => r.status === 'ok' && r.workload === w && (r.model_id === m.id || r.model_name === m.model) && (!r.engine || r.engine === m.engine));
}
function measurement(m, w = state.workload) {
  return measurements(m, w).slice().sort((a, b) => Number(b.preferred === true) - Number(a.preferred === true) || String(b.provenance?.measured_at || '').localeCompare(String(a.provenance?.measured_at || '')))[0] || null;
}
function metricOf(m, w = state.workload, k = state.metric) { return measurement(m, w)?.metrics?.[k]?.median ?? null; }
function hasMetric(m, w) { return metricOf(m, w) != null; }
function sourceLabel(r, w) {
  if (!r) return 'Not measured';
  if (w === 'writing') return 'Writing baseline';
  return SOURCE_LABELS[r.protocol?.id] || (r.preferred ? 'Dedicated run' : 'Archived run');
}
function selectedGroup(m) { return (m.aliases || [m]).some(a => selected.has(a.id)); }
function visibleWorkloads() { return state.view === 'all' ? WORKLOADS : [state.workload]; }
function matchesQuery(m) { const q = state.query.trim().toLowerCase(); return !q || `${m.model} ${m.name} ${m.engine} ${m.quant} ${m.params}`.toLowerCase().includes(q); }
function groups() {
  const arr = models.filter(m => m.kind === 'generation' && (state.scope !== 'selected' || selected.has(m.id)));
  if (!state.group) return arr.map(m => ({...m, aliases: [m]}));
  const map = new Map();
  for (const m of arr) { const key = groupKey(m); if (!map.has(key)) map.set(key, []); map.get(key).push(m); }
  return [...map.values()].map(a => {
    const matched = a.filter(matchesQuery), measured = matched.filter(m => state.includeUnmeasured || visibleWorkloads().some(w => hasMetric(m, w)));
    const eligible = measured.length ? measured : matched.length ? matched : a;
    const exact = eligible.find(m => m.model.toLowerCase() === state.query.trim().toLowerCase());
    return {...(exact || representative(eligible)), aliases: a};
  });
}
function sizePass(value, min, max) {
  if (min === '' && max === '') return true;
  if (value == null) return state.includeUnknown;
  return (min === '' || value >= Number(min)) && (max === '' || value <= Number(max));
}
function filterModels() {
  const q = state.query.trim().toLowerCase(), quant = state.quant.toLowerCase();
  const a = groups().filter(m => (state.engine === 'all' || m.engine === state.engine) && (state.format === 'all' || formatOf(m) === state.format)
    && (!q || m.aliases.some(x => `${x.model} ${x.name} ${x.engine} ${x.quant} ${x.params}`.toLowerCase().includes(q)))
    && (!quant || m.quant.toLowerCase().includes(quant)) && (state.includeUnknown || (m.totalB != null && m.diskGiB != null))
    && sizePass(m.totalB, state.minParams, state.maxParams) && sizePass(m.activeB, '', state.maxActive) && sizePass(m.diskGiB, '', state.maxDisk)
    && (state.includeUnmeasured || visibleWorkloads().some(w => hasMetric(m, w))));
  const sortValue = m => state.sort === 'params' ? m.totalB : state.sort === 'active' ? m.activeB : state.sort === 'disk' ? m.diskGiB
    : state.sort === 'memory' ? validNumber(m.loaded_allocated_gib) : metricOf(m, state.workload, state.sort === 'ttft' ? 'ttft_s' : state.metric);
  const ascending = state.sort === 'ttft' || state.sort === 'memory' || (state.sort === 'speed' && METRICS[state.metric].low);
  return a.sort((x, y) => {
    if (state.sort === 'name') return x.model.localeCompare(y.model);
    const p = sortValue(x), q2 = sortValue(y);
    return (p == null) - (q2 == null) || (ascending ? (p ?? 0) - (q2 ?? 0) : (q2 ?? 0) - (p ?? 0)) || x.model.localeCompare(y.model);
  });
}
function modelURL(m, w = state.workload) { return `#model/${encodeURIComponent(m.id)}?workload=${w}`; }
function concurrencyFor(m) { return (WORK.concurrency || []).filter(c => c.model_id === m.id); }
function checksFor(m) { return (WORK.checks || []).filter(c => c.model_id === m.id); }
function longContextFor(m) { return (WORK.long_context || []).filter(r => r.model_id === m.id || (!r.model_id && r.model_name === m.model)); }
function studyById(id) { return (WORK.studies || []).find(s => s.id === id); }
function modelById(id) { return models.find(m => m.id === id); }
function engineLabel(m) { return `<span class="engine"><span class="engine-dot s${engineSlot(m.engine)}" aria-hidden="true"></span>${esc(m.engine)}</span>`; }
function sizeLine(m) { return `${esc(m.params)} total${m.active ? ', ' + esc(m.active) + ' active' : ''}, ${esc(m.quant)}`; }
function statusTag(m) {
  if (m.status === 'incomplete') return '<span class="tag warn">Incomplete</span>';
  if (m.status === 'unavailable') return '<span class="tag warn">Unavailable</span>';
  if (m.config) return `<span class="tag new">New ${esc(dayLabel(m.config.added_utc, {day: 'numeric', month: 'short'}))}</span>`;
  return '';
}

// ---------------------------------------------------------------- shared controls
function workloadSegments(id, includeAll) {
  const pressed = w => w === 'all' ? state.view === 'all' : (includeAll ? state.view === 'single' && state.workload === w : state.workload === w);
  const options = [...(includeAll ? [['all', 'All workloads']] : []), ...WORKLOADS.map(w => [w, cap(w)])];
  return `<div class="segmented" role="group" aria-label="Workload" id="${id}">${options.map(([k, label]) => `<button type="button" data-workload-pick="${k}" data-scope-all="${includeAll ? 1 : 0}" aria-pressed="${pressed(k)}">${label}</button>`).join('')}</div>`;
}
function bindWorkloadButtons() {
  $$('[data-workload-pick]').forEach(b => b.onclick = () => {
    const k = b.dataset.workloadPick;
    if (k === 'all') state.view = 'all';
    else { state.workload = k; if (b.dataset.scopeAll === '1') state.view = 'single'; }
    updateInPlace();
  });
}
function protocolNote() {
  return `<p class="small muted">Writing, coding and chat use different prompts and protocols, and engines time generation differently. Each number stands alone; there is no combined score. <a href="#method">How these are measured</a>.</p>`;
}

// ---------------------------------------------------------------- views: leaderboard
function raceLanes() {
  const w = state.workload, usable = m => m.kind === 'generation' && metricOf(m, w, 'decode_tps') != null;
  const picked = models.filter(m => selected.has(m.id) && usable(m));
  const lanes = picked.length >= 2 ? picked : RACE_DEFAULTS.map(([name, engine]) => models.find(m => m.model === name && m.engine === engine)).filter(m => m && usable(m));
  return {mine: picked.length >= 2, lanes: lanes.sort((a, b) => metricOf(b, w, 'decode_tps') - metricOf(a, w, 'decode_tps')).slice(0, 8)};
}
function heroHTML() {
  const w = state.workload, {mine, lanes} = raceLanes();
  const laneHTML = lanes.map((m, i) => {
    const r = measurement(m, w), tps = r.metrics.decode_tps.median, ttft = r.metrics.ttft_s?.median ?? 0, total = ttft + TAPE_TOKENS / tps;
    return `<div class="lane" data-row="lane-${esc(m.id)}" data-lane="${esc(m.id)}" data-tps="${tps}" data-ttft="${ttft}" data-seed="${i + 1}">
      <div class="lane-name"><a href="${modelURL(m)}">${esc(m.name)}</a><div class="lane-sub"><span class="engine-dot s${engineSlot(m.engine)}" aria-hidden="true"></span>${esc(m.engine)}, ${esc(m.quant.replace(/\s*\(.*\)$/, ''))}</div></div>
      <canvas class="tape" aria-hidden="true"></canvas>
      <div class="lane-read" aria-hidden="true"><b>${fmt(total, 1)} s</b><span>${fmt(tps, 1)} tok/s</span></div>
      <span class="sr-only">${esc(m.name)} on ${esc(m.engine)}: ${fmt(tps, 1)} tokens per second after a first token at ${fmt(ttft, 2)} seconds, so ${TAPE_TOKENS} tokens take about ${fmt(total, 1)} seconds.</span>
    </div>`;
  }).join('');
  return `<section class="hero" aria-labelledby="hero-title">
    <div class="hero-top">
      <div>
        <h1 class="display" id="hero-title">How fast does it type?</h1>
        <p class="lede">Local models on one NVIDIA DGX Spark, timed token by token. Each lane waits for its measured first token, then types a ${TAPE_TOKENS}-token answer at its median ${w} speed.</p>
      </div>
      <div class="hero-controls">${workloadSegments('hero-workload', false)}</div>
    </div>
    <div class="race" id="race" role="group" aria-label="${TAPE_TOKENS}-token answers typed at measured ${w} speed">${laneHTML || '<div class="empty"><p>No setup has a measured output speed for this workload.</p></div>'}</div>
    <div class="race-foot">
      <p>${mine ? 'Racing your selected setups. Clear the selection to see the default line-up.' : 'A fixed line-up from the smallest model to full BF16. Select setups in the leaderboard to race your own.'} Answers are drawn as redacted bars: SparkBench publishes timings and hashes, never response text.</p>
      <div class="actions"><span class="tabular" id="race-clock" aria-hidden="true"></span><button class="quiet" type="button" id="race-replay">Replay</button></div>
    </div>
    ${latestHTML()}
  </section>`;
}
function latestHTML() {
  const s = (WORK.studies || []).slice().sort((a, b) => b.date.localeCompare(a.date))[0];
  if (!s) return '';
  return `<div class="latest"><span class="latest-date">${esc(dayLabel(s.date, {day: 'numeric', month: 'long'}))}</span><p><strong>${esc(s.title)}.</strong> ${esc(s.answer)}</p><a class="button" href="#study/${esc(s.id)}">Read the study</a></div>`;
}
function cellMetric(m, w, max = 1) {
  const r = measurement(m, w), meta = METRICS[state.metric], v = r?.metrics?.[state.metric]?.median, attempt = latestAttempt(m, w);
  if (v == null) {
    const why = r ? 'Not recorded' : (attempt?.status === 'unavailable' || attempt?.status === 'error' || m.status === 'unavailable' || m.status === 'incomplete') ? 'Unavailable' : 'Not measured';
    return `<span class="cell-empty">${why}</span>`;
  }
  const notes = [];
  if (state.showLatency && state.metric !== 'ttft_s' && r.metrics?.ttft_s?.median != null) notes.push(`first token ${fmt(r.metrics.ttft_s.median, 2)} s`);
  notes.push(sourceLabel(r, w) + (r.trial_count ? `, ${r.trial_count} trials` : ''));
  return `<div class="speed">${fmt(v, meta.digits)}</div>${meta.low ? '' : `<div class="speed-bar" aria-hidden="true"><span style="width:${Math.max(2, v / max * 100)}%"></span></div>`}<div class="cell-note">${notes.join('<br>')}</div>`;
}
function row(m, maxima, index) {
  const n = m.aliases.length, sortedW = state.sort === 'speed' ? state.workload : null;
  return `<tr data-row="${esc(m.id)}">
    <td class="select"><input type="checkbox" data-select="${esc(m.id)}" aria-label="Select ${esc(m.name)} on ${esc(m.engine)}" ${selectedGroup(m) ? 'checked' : ''}></td>
    <td class="rank num">${index + 1}</td>
    <td class="model-cell"><a class="model-name" href="${modelURL(m)}">${esc(m.name)}</a> ${statusTag(m)}<div class="model-sub">${sizeLine(m)}</div>${n > 1 ? `<details class="aliases"><summary>${n} tags share these weights</summary><div>${m.aliases.map(a => `<a href="${modelURL(a)}">${esc(a.model)}</a>`).join('')}</div></details>` : ''}</td>
    <td class="engine-cell">${engineLabel(m)}<div class="model-sub">${esc(formatOf(m))}</div></td>
    ${visibleWorkloads().map((w, i, all) => `<td class="num workload-cell${w === sortedW ? ' sorted' : ''} ${all.length > 1 ? 'wcol-' + i : 'wcol-single'}" data-label="${cap(w)}">${cellMetric(m, w, maxima[w])}</td>`).join('')}
    <td class="right num weights-cell" data-label="GiB on disk">${m.diskGiB == null ? '<span class="cell-empty">Not recorded</span>' : fmt(m.diskGiB)}</td>
  </tr>`;
}
function renderResults() {
  const arr = filterModels(), ws = visibleWorkloads(), meta = METRICS[state.metric];
  const maxima = Object.fromEntries(ws.map(w => [w, Math.max(1, ...arr.map(m => metricOf(m, w) || 0))]));
  const head = w => `<th class="right workload-heading"><button type="button" class="th-sort${meta.low ? ' ascending' : ''}" data-sort-workload="${w}" aria-pressed="${state.sort === 'speed' && state.workload === w}"><span class="th-name">${cap(w)}</span><span class="th-unit">${meta.label}, ${meta.unit}</span></button></th>`;
  const emptyMine = state.scope === 'selected' && !selected.size;
  patch('#results', `<p class="coverage"><span><b>${arr.length}</b> ${state.group ? 'setups' : 'tags'} shown</span>${ws.map(w => `<span>${cap(w)} <b>${arr.filter(m => hasMetric(m, w)).length}</b> measured</span>`).join('')}</p>
    <div class="table-scroll" id="model-table-wrap"><table>
      <caption class="sr-only">Model measurements by workload, ${meta.label}</caption>
      <thead><tr><th aria-label="Select"></th><th aria-label="Position">#</th><th>Model</th><th>Engine</th>${ws.map(head).join('')}<th class="right">Weights<br><span class="th-unit">GiB on disk</span></th></tr></thead>
      <tbody>${arr.length ? arr.map((m, i) => row(m, maxima, i)).join('') : `<tr><td class="empty-cell" colspan="${5 + ws.length}"><div class="empty"><h3>${emptyMine ? 'Select setups to focus this table' : 'No setups match these filters'}</h3><p>${emptyMine ? 'Switch to all setups and tick the ones you want.' : 'Clear the size limits or pick another engine. Setups with unknown sizes stay visible while "Include unknown sizes" is on.'}</p><button class="quiet" type="button" id="reset-filters">${emptyMine ? 'Show all setups' : 'Reset filters'}</button></div></td></tr>`}</tbody>
    </table></div>
    <div class="table-foot"><span>${state.group ? 'Tags that share an engine and checkpoint are grouped; open a group to see each tag.' : 'Every tag is listed with its own measurements.'}</span><span>${state.sort === 'speed' || state.sort === 'ttft' ? `Sorted by ${state.workload} ${state.sort === 'ttft' ? 'first-token time' : meta.label.toLowerCase()}.` : ''} Unknown sizes stay unknown, never zero.</span></div>`);
  $$('[data-select]').forEach(b => b.onchange = () => {
    const m = arr.find(x => x.id === b.dataset.select);
    if (!b.checked && (m?.aliases?.length || 0) > 1) { m.aliases.forEach(a => selected.delete(a.id)); updateInPlace(); }
    else toggleSelection(b.dataset.select, b.checked);
  });
  $$('[data-sort-workload]').forEach(b => b.onclick = () => { state.workload = b.dataset.sortWorkload; state.sort = 'speed'; updateInPlace(); });
  const reset = $('#reset-filters');
  if (reset) reset.onclick = () => { resetFilters(); updateInPlace(); };
  updateTray();
}
function activeFilterCount() {
  return ['engine', 'format'].filter(k => state[k] !== 'all').length + ['quant', 'minParams', 'maxParams', 'maxActive', 'maxDisk'].filter(k => state[k] !== '').length
    + Number(!state.includeUnmeasured) + Number(!state.includeUnknown);
}
function resetFilters() {
  for (const k of ['query', 'engine', 'format', 'quant', 'minParams', 'maxParams', 'maxActive', 'maxDisk', 'includeUnmeasured', 'includeUnknown']) state[k] = defaultState()[k];
  state.scope = 'all';
}
function embeddingTable() {
  const a = models.filter(m => m.kind === 'embedding');
  return `<p class="small muted">Embedding throughput counts input tokens per wall-clock second. It says nothing about text generation or retrieval quality.</p><div class="table-scroll"><table><thead><tr><th>Model</th><th>Engine</th><th class="right">Input tok/s</th><th class="right">Wall time</th><th class="right">Dimensions</th></tr></thead><tbody>${a.map(m => `<tr><td><a href="${modelURL(m)}">${esc(m.model)}</a></td><td>${engineLabel(m)}</td><td class="right num">${fmt(m.input_tps_wall?.median)}</td><td class="right num">${fmt(m.wall_s?.median, 3)} s</td><td class="right">${esc(m.dimensions?.join(', ') || '—')}</td></tr>`).join('')}</tbody></table></div>`;
}
function renderModels() {
  const engines = [...new Set(models.map(m => m.engine))], formats = [...new Set(models.map(formatOf))];
  const generation = models.filter(m => m.kind === 'generation');
  const sorts = [['speed', 'Selected workload column'], ['ttft', 'Fastest first token'], ['params', 'Most total parameters'], ['active', 'Most active parameters'], ['disk', 'Largest weights'], ['memory', 'Smallest loaded allocation'], ['name', 'Name']];
  content(`${heroHTML()}
  <section class="section" aria-labelledby="board-title">
    <div class="section-head"><div><h2 id="board-title">Leaderboard</h2><p>${generation.length} engine setups across ${engines.join(', ').replace(/, ([^,]*)$/, ' and $1')}. Click a workload heading to sort by it.</p></div>
      <div class="actions"><button class="quiet" type="button" id="download-csv">Export CSV</button><button class="quiet" type="button" id="reload">Reload data</button></div></div>
    <div class="toolbar">
      <label class="field">Search<input id="search" type="search" value="${esc(state.query)}" placeholder="Name, quantization or size" autocomplete="off"></label>
      <div class="field"><span>Workloads</span>${workloadSegments('board-workload', true)}</div>
      <label class="field">Show<select id="metric-choice">${metricKeys.map(k => `<option value="${k}" ${state.metric === k ? 'selected' : ''}>${METRICS[k].label} (${METRICS[k].unit})</option>`).join('')}</select></label>
      <div class="field"><span>Setups</span><div class="segmented" role="group" aria-label="Which setups"><button type="button" data-scope="all" aria-pressed="${state.scope === 'all'}">All</button><button type="button" data-scope="selected" aria-pressed="${state.scope === 'selected'}">Selected <span id="selected-count">(${selected.size})</span></button></div></div>
    </div>
    <details class="drawer" id="advanced-filters"><summary>Filters and sorting <span id="filter-count" class="muted small">${activeFilterCount() ? '(' + activeFilterCount() + ' active)' : ''}</span></summary><div class="drawer-body">
      <div class="filter-grid">
        <label class="field">Engine<select id="engine"><option value="all">All engines</option>${engines.map(e => `<option value="${esc(e)}" ${state.engine === e ? 'selected' : ''}>${esc(e)}</option>`).join('')}</select></label>
        <label class="field">Weight format<select id="format"><option value="all">All formats</option>${formats.map(f => `<option value="${esc(f)}" ${state.format === f ? 'selected' : ''}>${esc(f)}</option>`).join('')}</select></label>
        <label class="field">Quantization contains<input id="quant" type="search" value="${esc(state.quant)}" placeholder="Q4, BF16, NVFP4"></label>
        <label class="field">Sort by<select id="sort">${sorts.map(([k, v]) => `<option value="${k}" ${state.sort === k ? 'selected' : ''}>${v}</option>`).join('')}</select></label>
        <label class="field">Total parameters, at least (B)<input id="minParams" type="number" min="0" step="any" value="${esc(state.minParams)}" placeholder="No minimum"></label>
        <label class="field">Total parameters, at most (B)<input id="maxParams" type="number" min="0" step="any" value="${esc(state.maxParams)}" placeholder="No maximum"></label>
        <label class="field">Active parameters, at most (B)<input id="maxActive" type="number" min="0" step="any" value="${esc(state.maxActive)}" placeholder="No maximum"></label>
        <label class="field">Weights on disk, at most (GiB)<input id="maxDisk" type="number" min="0" step="any" value="${esc(state.maxDisk)}" placeholder="No maximum"></label>
      </div>
      <div class="filter-options">
        <label class="check"><input id="group" type="checkbox" ${state.group ? 'checked' : ''}>Group tags that share weights</label>
        <label class="check"><input id="includeUnmeasured" type="checkbox" ${state.includeUnmeasured ? 'checked' : ''}>Include unmeasured setups</label>
        <label class="check"><input id="includeUnknown" type="checkbox" ${state.includeUnknown ? 'checked' : ''}>Include unknown sizes</label>
        <label class="check"><input id="show-latency" type="checkbox" ${state.showLatency ? 'checked' : ''}>Show first-token time</label>
        <button class="quiet" type="button" id="reset-advanced">Reset filters</button>
      </div>
      <div class="preferences"><label class="check"><input id="remember" type="checkbox" ${state.remember ? 'checked' : ''}>Remember my view</label><span>Stored in a first-party cookie for 180 days.</span><button class="linklike" type="button" id="forget">Forget saved view</button></div>
    </div></details>
    <div id="results"></div>
    <div class="panels">
      <details class="panel"><summary>Embedding models (${models.filter(m => m.kind === 'embedding').length})</summary><div>${embeddingTable()}</div></details>
      <details class="panel"><summary>Reading these numbers</summary><div class="prose"><p>Output speed is tokens generated per second after the prompt is processed. First token adds prompt processing and request overhead. Prompt speed is how fast the prompt itself is read.</p><p>Parameter counts describe the model; GiB is the size of its weight files. A small, fast model is not automatically a better one: none of these numbers score answer quality or code correctness.</p>${WORK.suite ? `<p>The 30 September coding and chat suite ${WORK.suite.status === 'complete' ? 'is complete' : 'is in progress'}: ${WORK.suite.successful_workload_profiles} measured profiles, ${WORK.suite.failed_workload_profiles} failed, ${WORK.suite.unavailable_workload_profiles} unavailable across ${WORK.suite.mapped_model_configurations} mapped configurations.</p>` : ''}<p><a href="#method">Full protocol and limits</a></p></div></details>
    </div>
  </section>`);
  for (const k of ['query', 'quant', 'minParams', 'maxParams', 'maxActive', 'maxDisk']) {
    $(k === 'query' ? '#search' : '#' + k).oninput = e => {
      state[k] = e.target.value; renderResults(); replaceURL(); persistPreferences();
      const count = $('#filter-count'); if (count) count.textContent = activeFilterCount() ? '(' + activeFilterCount() + ' active)' : '';
    };
  }
  for (const k of ['engine', 'format', 'sort']) $('#' + k).onchange = e => { state[k] = e.target.value; updateInPlace(); };
  for (const k of ['group', 'includeUnmeasured', 'includeUnknown']) $('#' + k).onchange = e => { state[k] = e.target.checked; updateInPlace(); };
  $('#show-latency').onchange = e => { state.showLatency = e.target.checked; updateInPlace(); };
  $('#metric-choice').onchange = e => { state.metric = e.target.value; updateInPlace(); };
  $$('[data-scope]').forEach(b => b.onclick = () => { state.scope = b.dataset.scope; updateInPlace(); });
  $('#reset-advanced').onclick = () => { resetFilters(); updateInPlace(); };
  $('#remember').onchange = e => { state.remember = e.target.checked; persistPreferences(); notify(state.remember ? 'Your view will be remembered' : 'Saved view cookie removed'); };
  $('#forget').onclick = () => { state = defaultState(); state.remember = false; selected.clear(); persistPreferences(); applyTheme(); updateInPlace(); notify('Saved view forgotten and reset'); };
  $('#reload').onclick = () => load(true);
  $('#download-csv').onclick = exportCSV;
  $('#race-replay').onclick = () => Race.restart(true);
  bindWorkloadButtons();
  renderResults();
}

// ---------------------------------------------------------------- the token tape
const Race = {
  sig: '', lanes: [], elapsed: 0, last: 0, raf: 0, visible: true, colors: null, observer: null, resize: null,
  reduced: () => window.matchMedia('(prefers-reduced-motion: reduce)').matches,
  sync() {
    const root = $('#race');
    if (!root) { this.stop(); this.sig = ''; this.lanes = []; return; }
    const lanes = $$('[data-lane]', root).map(el => ({el, canvas: $('canvas', el), read: $('.lane-read', el), tps: Number(el.dataset.tps), ttft: Number(el.dataset.ttft) || 0, seed: Number(el.dataset.seed), heights: null, drawn: -1}));
    const sig = state.workload + '|' + lanes.map(l => l.el.dataset.lane + ':' + l.tps).join('|');
    lanes.forEach(l => { l.heights = tokenHeights(l.seed * 7919 + Math.round(l.tps * 10)); });
    this.lanes = lanes;
    this.watch(root);
    if (sig !== this.sig) { this.sig = sig; this.restart(); return; }
    this.layout(); this.draw(true);
    if (!this.finished() && !this.raf && this.visible) this.loop();
  },
  watch(root) {
    if (this.watched === root) return;
    this.observer?.disconnect(); this.resize?.disconnect();
    this.observer = new IntersectionObserver(([entry]) => { this.visible = entry.isIntersecting; if (this.visible && !this.finished()) this.loop(); else this.pause(); });
    this.watched = root;
    this.observer.observe(root);
    this.resize = new ResizeObserver(() => { this.layout(); this.draw(true); });
    this.resize.observe(root);
  },
  restart(fromButton = false) {
    this.stop();
    this.elapsed = this.reduced() ? Infinity : 0;
    this.recolor(false);
    this.layout(); this.draw(true);
    if (fromButton && this.reduced()) notify('Animation is off because your system asks for reduced motion');
    if (!this.finished() && this.visible && !document.hidden) this.loop();
  },
  finished() { return this.lanes.every(l => this.elapsed >= l.ttft + TAPE_TOKENS / l.tps); },
  loop() {
    if (this.raf) return;
    this.last = performance.now();
    const tick = now => {
      this.elapsed += Math.min(.1, (now - this.last) / 1000);
      this.last = now;
      this.draw(false);
      if (this.finished()) { this.raf = 0; this.draw(true); return; }
      this.raf = requestAnimationFrame(tick);
    };
    this.raf = requestAnimationFrame(tick);
  },
  pause() { if (this.raf) cancelAnimationFrame(this.raf); this.raf = 0; },
  stop() { this.pause(); },
  recolor(redraw = true) {
    const cs = getComputedStyle(document.documentElement);
    this.colors = {ink: cs.getPropertyValue('--ink-2').trim(), rule: cs.getPropertyValue('--rule-2').trim(), gold: cs.getPropertyValue('--gold').trim()};
    if (redraw && this.lanes.length) { this.lanes.forEach(l => l.drawn = -1); this.draw(true); }
  },
  layout() {
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    for (const l of this.lanes) {
      const w = Math.max(1, Math.round(l.canvas.clientWidth * dpr)), h = Math.max(1, Math.round(l.canvas.clientHeight * dpr));
      if (l.canvas.width !== w || l.canvas.height !== h) { l.canvas.width = w; l.canvas.height = h; }
      l.drawn = -1;
    }
  },
  draw(force) {
    if (!this.colors) this.recolor(false);
    for (const l of this.lanes) {
      const typing = Math.max(0, this.elapsed - l.ttft), n = Math.min(TAPE_TOKENS, Math.floor(typing * l.tps));
      const done = this.elapsed >= l.ttft + TAPE_TOKENS / l.tps;
      if (!force && n === l.drawn) continue;
      l.drawn = n;
      drawTape(l.canvas, l.heights, n, done, this.colors);
      const b = $('b', l.read), span = $('span', l.read);
      if (done) { b.textContent = fmt(l.ttft + TAPE_TOKENS / l.tps, 1) + ' s'; span.textContent = fmt(l.tps, 1) + ' tok/s'; }
      else if (this.elapsed < l.ttft) { b.textContent = '0'; span.textContent = `first token at ${fmt(l.ttft, 2)} s`; }
      else { b.textContent = fmtInt(n); span.textContent = `of ${TAPE_TOKENS} tokens`; }
    }
    const clock = $('#race-clock');
    if (clock) clock.textContent = Number.isFinite(this.elapsed) && !this.finished() ? fmt(this.elapsed, 1) + ' s' : '';
  },
};
function tokenHeights(seed) {
  let s = seed >>> 0 || 1;
  const rand = () => { s ^= s << 13; s >>>= 0; s ^= s >> 17; s ^= s << 5; s >>>= 0; return s / 4294967296; };
  const out = new Float32Array(TAPE_TOKENS);
  for (let i = 0; i < TAPE_TOKENS; i++) {
    const r = rand();
    out[i] = r < .1 ? .16 : r < .78 ? .34 + rand() * .36 : .74 + rand() * .26; // spaces and punctuation, ordinary tokens, long words
  }
  return out;
}
function drawTape(canvas, heights, n, done, colors) {
  const ctx = canvas.getContext('2d'), w = canvas.width, h = canvas.height, mid = h / 2;
  if (!w || !h) return;
  const pitch = w / TAPE_TOKENS, bar = Math.max(1, pitch * .62);
  ctx.clearRect(0, 0, w, h);
  ctx.fillStyle = colors.rule;
  ctx.fillRect(0, Math.round(mid), w, Math.max(1, Math.round(h / 34)));
  ctx.fillStyle = colors.ink;
  const fresh = done ? n : Math.max(0, n - 10);
  for (let i = 0; i < fresh; i++) { const bh = heights[i] * h; ctx.fillRect(i * pitch, mid - bh / 2, bar, bh); }
  ctx.fillStyle = colors.gold;
  for (let i = fresh; i < n; i++) { const bh = heights[i] * h; ctx.fillRect(i * pitch, mid - bh / 2, bar, bh); }
  if (!done && n > 0) ctx.fillRect(Math.min(w - 2, n * pitch + 1), 0, Math.max(1.5, pitch), h);
}

// ---------------------------------------------------------------- charts
function logScale(d0, d1, r0, r1) { const a = Math.log10(d0), b = Math.log10(d1); return v => r0 + (Math.log10(v) - a) / (b - a) * (r1 - r0); }
function linScale(d0, d1, r0, r1) { return v => r0 + (v - d0) / (d1 - d0) * (r1 - r0); }
function logTicks(d0, d1) {
  const all = [];
  for (let e = Math.floor(Math.log10(d0)); e <= Math.ceil(Math.log10(d1)); e++) for (const k of [1, 2, 5]) { const v = +(k * 10 ** e).toPrecision(3); if (v >= d0 * .999 && v <= d1 * 1.001) all.push(v); }
  return all.length > 9 ? all.filter(v => /^[15]/.test(v.toPrecision(1))) : all;
}
function linTicks(max, count = 5) {
  const raw = max / count, p = 10 ** Math.floor(Math.log10(raw)), step = [1, 2, 2.5, 5, 10].map(k => k * p).find(s => s >= raw);
  const out = [];
  for (let v = 0; v <= max + step * .001; v += step) out.push(+v.toFixed(6));
  return out;
}
const tickText = v => v >= 1e6 ? fmt(v / 1e6, 0) + 'M' : v >= 1000 ? (v / 1000).toLocaleString('en', {maximumFractionDigits: 1}) + 'k' : v.toLocaleString('en', {maximumFractionDigits: 2});
const tip = lines => esc(lines.filter(Boolean).join('\n'));
function textWidth(s, size = 12.5) { return s.length * size * .56; }
function placeLabels(points, obstacles, width, height) {
  const boxes = [], out = [];
  for (const p of points) {
    const w = textWidth(p.text), candidates = [[p.x + 9, p.y + 4, 'start'], [p.x - 9, p.y + 4, 'end'], [p.x - w / 2, p.y - 11, 'start'], [p.x - w / 2, p.y + 19, 'start']];
    for (const [x, y, anchor] of candidates) {
      const left = anchor === 'end' ? x - w : x, box = [left - 2, y - 11, left + w + 2, y + 3];
      if (box[0] < 0 || box[2] > width || box[1] < 0 || box[3] > height) continue;
      if (boxes.some(b => !(box[2] < b[0] || box[0] > b[2] || box[3] < b[1] || box[1] > b[3]))) continue;
      if (obstacles.some(o => (o.x !== p.x || o.y !== p.y) && o.x > box[0] - 6 && o.x < box[2] + 6 && o.y > box[1] - 6 && o.y < box[3] + 6)) continue;
      boxes.push(box); out.push({...p, lx: x, ly: y, anchor}); break;
    }
  }
  return out;
}
function legendHTML(items) {
  return `<ul class="legend">${items.map(([slot, label, kind = 'dot']) => `<li>${kind === 'dot' ? `<svg viewBox="0 0 12 12" aria-hidden="true"><circle cx="6" cy="6" r="5" class="s${slot}"/></svg>` : `<span class="key-line ${slot === 'ceiling' ? 'ceiling' : 's' + slot}" aria-hidden="true"></span>`}${esc(label)}</li>`).join('')}</ul>`;
}

// scatter: output speed against size, coloured by engine
function speedMapSVG(points, axis) {
  const W = 1000, H = 560, m = {l: 58, r: 18, t: 18, b: 50}, iw = W - m.l - m.r, ih = H - m.t - m.b;
  const xs = points.map(p => p.x), ys = points.map(p => p.y);
  const x0 = Math.min(...xs) / 1.6, x1 = Math.max(...xs) * 1.6, y0 = Math.min(...ys) / 1.6, y1 = Math.max(...ys) * 1.7;
  const X = logScale(x0, x1, m.l, m.l + iw), Y = logScale(y0, y1, m.t + ih, m.t);
  const xt = logTicks(x0, x1), yt = logTicks(y0, y1);
  let ceiling = '';
  if (axis === 'disk') {
    const seg = [];
    for (let i = 0; i <= 60; i++) { const gib = x0 * (x1 / x0) ** (i / 60), tps = GB10_BANDWIDTH / (gib * 2 ** 30); if (tps >= y0 && tps <= y1) seg.push(`${X(gib).toFixed(1)},${Y(tps).toFixed(1)}`); }
    if (seg.length > 1) {
      const lx = 1.15, labelGib = Math.max(x0 * 1.2, GB10_BANDWIDTH / (y1 / lx * 2 ** 30));
      ceiling = `<polyline class="ceiling" points="${seg.join(' ')}"/><text class="ceiling-label" x="${X(labelGib) + 8}" y="${Y(GB10_BANDWIDTH / (labelGib * 2 ** 30)) - 6}">Dense ceiling at 273 GB/s</text>`;
    }
  }
  const pts = points.map(p => ({...p, px: X(p.x), py: Y(p.y)}));
  const labelled = placeLabels(pts.filter(p => p.label).sort((a, b) => b.y - a.y).map(p => ({x: p.px, y: p.py, text: p.label})), pts.map(p => ({x: p.px, y: p.py})), W, H);
  return `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Output speed against ${axis === 'disk' ? 'weight size' : 'parameter count'}, log scales">
    <g class="grid">${yt.map(v => `<line x1="${m.l}" x2="${m.l + iw}" y1="${Y(v)}" y2="${Y(v)}"/>`).join('')}${xt.map(v => `<line y1="${m.t}" y2="${m.t + ih}" x1="${X(v)}" x2="${X(v)}"/>`).join('')}</g>
    <g class="axis"><line x1="${m.l}" x2="${m.l + iw}" y1="${m.t + ih}" y2="${m.t + ih}"/></g>
    ${yt.map(v => `<text x="${m.l - 8}" y="${Y(v) + 4}" text-anchor="end">${tickText(v)}</text>`).join('')}
    ${xt.map(v => `<text x="${X(v)}" y="${m.t + ih + 18}" text-anchor="middle">${tickText(v)}</text>`).join('')}
    <text class="axis-title" x="${m.l + iw}" y="${H - 6}" text-anchor="end">${axis === 'disk' ? 'Weights on disk, GiB (log scale)' : 'Total parameters, billions (log scale)'}</text>
    ${ceiling}
    ${pts.map(p => `<a href="${p.href}" class="hit-wrap" data-tip="${tip(p.tip)}" aria-label="${esc(p.tip.join(', '))}"><circle class="hit" cx="${p.px}" cy="${p.py}" r="13"/><circle class="dot s${p.slot}" cx="${p.px}" cy="${p.py}" r="${p.selected ? 7 : 5.5}"/></a>`).join('')}
    ${labelled.map(l => `<text class="${'label'}" x="${l.lx}" y="${l.ly}" text-anchor="${l.anchor}">${esc(l.text)}</text>`).join('')}
  </svg>`;
}
// lines: one panel per model family, x is prompt length
function prefillLinesSVG(series, xDomain, yMax) {
  const W = 600, H = 330, m = {l: 54, r: 16, t: 14, b: 44}, iw = W - m.l - m.r, ih = H - m.t - m.b;
  const X = logScale(xDomain[0], xDomain[1], m.l, m.l + iw), yt = linTicks(yMax, 4), Y = linScale(0, yt[yt.length - 1], m.t + ih, m.t);
  const xt = logTicks(xDomain[0], xDomain[1]);
  return `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Prompt processing speed by prompt length">
    <g class="grid">${yt.map(v => `<line x1="${m.l}" x2="${m.l + iw}" y1="${Y(v)}" y2="${Y(v)}"/>`).join('')}</g>
    <g class="axis"><line x1="${m.l}" x2="${m.l + iw}" y1="${m.t + ih}" y2="${m.t + ih}"/></g>
    ${yt.map(v => `<text x="${m.l - 8}" y="${Y(v) + 4}" text-anchor="end">${tickText(v)}</text>`).join('')}
    ${xt.map(v => `<text x="${X(v)}" y="${m.t + ih + 18}" text-anchor="middle">${tickText(v)}</text>`).join('')}
    <text class="axis-title" x="${m.l + iw}" y="${H - 6}" text-anchor="end">Prompt tokens (log scale)</text>
    ${series.map(s => `<polyline class="line s${s.slot}" points="${s.points.map(p => `${X(p.x).toFixed(1)},${Y(p.y).toFixed(1)}`).join(' ')}"/>`).join('')}
    ${series.map(s => s.points.map(p => `<g data-tip="${tip([s.label, `${fmtInt(p.y)} tok/s at ${fmtInt(p.x)} prompt tokens`, p.seconds != null ? `${fmt(p.seconds, 1)} s to read the prompt` : '', p.note])}" tabindex="0" role="img" aria-label="${esc(s.label)}: ${fmtInt(p.y)} tokens per second at ${fmtInt(p.x)} prompt tokens"><circle class="hit" cx="${X(p.x)}" cy="${Y(p.y)}" r="12"/><circle class="dot s${s.slot}" cx="${X(p.x)}" cy="${Y(p.y)}" r="4.5"/></g>`).join('')).join('')}
  </svg>`;
}
// horizontal bars: one measure, sorted
function hbarsSVG(rows, unit, digits = 0) {
  const W = 1000, rowH = 34, m = {l: 260, r: 90, t: 6, b: 6}, H = m.t + m.b + rows.length * rowH, iw = W - m.l - m.r;
  const max = Math.max(...rows.map(r => r.value)), X = linScale(0, max, 0, iw);
  return `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(rows.map(r => `${r.label} ${fmt(r.value, digits)} ${unit}`).join('; '))}">
    <line class="zero" x1="${m.l}" x2="${m.l}" y1="${m.t}" y2="${H - m.b}"/>
    ${rows.map((r, i) => { const y = m.t + i * rowH + 7, w = Math.max(2, X(r.value)), h = 20; return `<g data-tip="${tip([r.label, `${fmt(r.value, digits)} ${unit}`, r.note])}"><text class="label" x="${m.l - 12}" y="${y + 14}" text-anchor="end">${esc(r.label)}</text><path class="dot s${r.slot}" d="M${m.l},${y}h${w - 4}a4,4 0 0 1 4,4v${h - 8}a4,4 0 0 1 -4,4h${-(w - 4)}z" style="stroke:none"/><text class="label-strong" x="${m.l + w + 8}" y="${y + 14}">${fmt(r.value, digits)} ${esc(unit)}</text></g>`; }).join('')}
  </svg>`;
}
// diverging bars: relative change of one format against the other
function divergingSVG(rows, limit) {
  const W = 600, rowH = 36, m = {l: 160, r: 64, t: 26, b: 8}, H = m.t + m.b + rows.length * rowH, iw = W - m.l - m.r;
  const lim = limit || Math.max(25, ...rows.map(r => Math.abs(r.pct))) * 1.35, X = linScale(-lim, lim, m.l, m.l + iw), zero = X(0);
  return `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(rows.map(r => `${r.label}: ${r.pct > 0 ? '+' : ''}${fmt(r.pct, 0)}%`).join('; '))}">
    <text x="${zero - 6}" y="14" text-anchor="end">slower</text><text x="${zero + 6}" y="14">faster</text>
    ${rows.map((r, i) => {
      const y = m.t + i * rowH + 8, h = 20, w = Math.max(2, Math.abs(X(r.pct) - zero)), up = r.pct >= 0;
      const path = up ? `M${zero},${y}h${w - 4}a4,4 0 0 1 4,4v${h - 8}a4,4 0 0 1 -4,4h${-(w - 4)}z` : `M${zero},${y}h${-(w - 4)}a4,4 0 0 0 -4,4v${h - 8}a4,4 0 0 0 4,4h${w - 4}z`;
      const lx = up ? zero + w + 6 : zero - w - 6;
      return `<g data-tip="${tip([r.label, `${r.a} vs ${r.b}`, `${r.pct > 0 ? '+' : ''}${fmt(r.pct, 0)}%`])}"><text class="label" x="${m.l - 12}" y="${y + 14}" text-anchor="end">${esc(r.label)}</text><path class="${up ? 'bar-up' : 'bar-down'}" d="${path}"/><text class="label-strong" x="${lx}" y="${y + 14}" text-anchor="${up ? 'start' : 'end'}">${r.pct > 0 ? '+' : r.pct < 0 ? '−' : ''}${fmt(Math.abs(r.pct), 0)}%</text></g>`;
    }).join('')}
    <line class="zero" x1="${zero}" x2="${zero}" y1="${m.t}" y2="${H - m.b}"/>
  </svg>`;
}
// tooltips for any [data-tip], by pointer and keyboard
let tipFor = null;
function showTip(el, x, y) {
  const box = $('#chart-tip'), lines = el.dataset.tip.split('\n');
  box.innerHTML = `<b>${esc(lines[0])}</b>${lines.slice(1).map(l => `<span>${esc(l)}</span>`).join('<br>')}`;
  box.hidden = false;
  tipFor = el;
  moveTip(x, y);
}
function moveTip(x, y) {
  const box = $('#chart-tip'), r = box.getBoundingClientRect();
  box.style.left = Math.max(8, Math.min(window.innerWidth - r.width - 8, x + 14)) + 'px';
  box.style.top = Math.max(8, y - r.height - 12 < 8 ? y + 18 : y - r.height - 12) + 'px';
}
function hideTip() { $('#chart-tip').hidden = true; tipFor = null; }
document.addEventListener('pointerover', e => { const el = e.target.closest?.('[data-tip]'); if (el && el !== tipFor) showTip(el, e.clientX, e.clientY); });
document.addEventListener('pointermove', e => { if (tipFor) moveTip(e.clientX, e.clientY); });
document.addEventListener('pointerout', e => { if (tipFor && !tipFor.contains(e.relatedTarget)) hideTip(); });
document.addEventListener('focusin', e => { const el = e.target.closest?.('[data-tip]'); if (el) { const r = el.getBoundingClientRect(); showTip(el, r.left + r.width / 2, r.top); } });
document.addEventListener('focusout', hideTip);
window.addEventListener('scroll', () => { if (tipFor) hideTip(); }, {passive: true});

// ---------------------------------------------------------------- views: speed map
function renderMap() {
  const w = state.workload, axis = state.axis, curated = new Set(RACE_DEFAULTS.map(([n, e]) => n + '|' + e));
  const points = filterModels().map(m => {
    const r = measurement(m, w), y = r?.metrics?.decode_tps?.median, x = axis === 'disk' ? m.diskGiB : m.totalB;
    if (!isNum(x) || !isNum(y) || x <= 0 || y <= 0) return null;
    const isPicked = selectedGroup(m);
    return {m, x, y, slot: engineSlot(m.engine), selected: isPicked, href: modelURL(m),
      label: isPicked || curated.has(m.model + '|' + m.engine) ? m.name : '',
      tip: [m.name, `${m.engine}, ${m.quant}`, `${fmt(y, 1)} tok/s ${w}`, axis === 'disk' ? `${fmt(x, 1)} GiB of weights` : `${m.params} parameters`, r.metrics.ttft_s?.median != null ? `first token ${fmt(r.metrics.ttft_s.median, 2)} s` : '']};
  }).filter(Boolean);
  const engines = [...new Set(points.map(p => p.m.engine))].sort((a, b) => engineSlot(a) - engineSlot(b));
  const above = axis === 'disk' ? points.filter(p => p.y > GB10_BANDWIDTH / (p.x * 2 ** 30)) : [];
  content(`<div class="page-head"><div><h1 class="page-title">Speed against size.</h1><p class="lede">On the GB10, generating a token means reading the model's weights from memory, so bigger weights usually mean slower output. The points that escape that rule are the interesting ones.</p></div></div>
  <div class="map-controls">
    <div class="field"><span>Workload</span>${workloadSegments('map-workload', false)}</div>
    <div class="field"><span>Size measure</span><div class="segmented" role="group" aria-label="Size measure"><button type="button" data-axis="disk" aria-pressed="${axis === 'disk'}">Weights on disk</button><button type="button" data-axis="params" aria-pressed="${axis === 'params'}">Total parameters</button></div></div>
  </div>
  ${points.length ? `<figure class="chart-frame chart" style="margin:0">
    <p class="chart-title">${cap(w)} output speed, tokens per second (log scale)</p>
    <p class="chart-sub">${points.length} setups that follow the leaderboard filters. Select a point to open it.</p>
    ${legendHTML([...engines.map(e => [engineSlot(e), e]), ...(axis === 'disk' ? [['ceiling', 'Memory-bandwidth ceiling for a dense model', 'line']] : [])])}
    ${speedMapSVG(points, axis)}
  </figure>
  ${axis === 'disk' ? `<p class="map-note">The dashed line is a rule of thumb: 273 GB/s of memory bandwidth divided by the weight size gives the best a dense model can do if it reads every weight once per token. ${above.length} of ${points.length} setups beat it. They read fewer bytes per token than they store: mixture-of-experts models only touch their active experts, and speculative decoding (MTP or a drafter) accepts several tokens per pass.</p>` : `<p class="map-note">Parameter count ignores quantization, so two setups with the same count can differ several times in speed. Switch to weights on disk to see the memory-bandwidth ceiling.</p>`}
  <details class="panel" style="margin-top:22px"><summary>Show as a table</summary><div><div class="table-scroll"><table><thead><tr><th>Setup</th><th>Engine</th><th class="right">${axis === 'disk' ? 'Weights, GiB' : 'Parameters, B'}</th><th class="right">${cap(w)} tok/s</th>${axis === 'disk' ? '<th class="right">Dense ceiling tok/s</th>' : ''}</tr></thead><tbody>${points.slice().sort((a, b) => b.y - a.y).map(p => `<tr><td><a href="${p.href}">${esc(p.m.name)}</a></td><td>${engineLabel(p.m)}</td><td class="right num">${fmt(p.x, 1)}</td><td class="right num">${fmt(p.y, 1)}</td>${axis === 'disk' ? `<td class="right num">${fmt(GB10_BANDWIDTH / (p.x * 2 ** 30), 1)}</td>` : ''}</tr>`).join('')}</tbody></table></div></div></details>`
  : `<div class="empty"><h2>Nothing to plot</h2><p>No setup with a known size has a measured ${w} speed under the current leaderboard filters.</p><a class="button" href="#models">Adjust the leaderboard filters</a></div>`}`);
  $$('[data-axis]').forEach(b => b.onclick = () => { state.axis = b.dataset.axis; updateInPlace(); });
  bindWorkloadButtons();
}

// ---------------------------------------------------------------- views: long prompts
function contextSeries() {
  const rows = WORK.long_context || [], study = (WORK.studies || []).find(s => s.protocol_id === STUDY_PROTOCOL), byKey = new Map();
  for (const r of rows) {
    const proto = r.protocol?.id || 'unknown', key = r.model_id + '|' + proto;
    if (!byKey.has(key)) {
      const cfg = study?.configs.find(c => c.model_id === r.model_id), m = modelById(r.model_id);
      const studyRun = proto === STUDY_PROTOCOL && cfg;
      const family = /27B/i.test(r.model_name) ? 'Qwen3.8 27B (dense)' : /Flash/i.test(r.model_name) ? 'Qwen3.8 Flash Next (125B, 6B active)' : r.model_name;
      byKey.set(key, {
        key, family, model: m, proto, slot: studyRun ? (cfg.format_family === 'NVFP4' ? 1 : 2) : 3,
        label: studyRun ? `${cfg.format_family}, ${cfg.engine_version.split(' ')[0] === '0.3.6.3' ? 'TensorFold 0.3.6.3' : 'TensorFold 0.6.6'}` : `${m?.quant?.split(',')[0] || r.model_name}, ${dayLabel(r.provenance?.measured_at, {day: 'numeric', month: 'short'})} archive`,
        points: [],
      });
    }
    byKey.get(key).points.push({x: r.prompt_tokens, y: r.prefill_tps, seconds: r.prefill_s ?? r.ttft_s, ttft: r.ttft_s, note: proto === STUDY_PROTOCOL ? 'Cold prompt, one request' : 'Rounded archived value'});
  }
  const series = [...byKey.values()];
  series.forEach(s => s.points.sort((a, b) => a.x - b.x));
  return series.sort((a, b) => a.slot - b.slot);
}
function contextPanels(series) {
  const families = [...new Set(series.map(s => s.family))];
  const xs = series.flatMap(s => s.points.map(p => p.x)), ys = series.flatMap(s => s.points.map(p => p.y));
  const xDomain = [Math.min(...xs) / 1.3, Math.max(...xs) * 1.3], yMax = Math.max(...ys) * 1.08;
  return `<div class="small-multiples">${families.map(f => { const ss = series.filter(s => s.family === f); return `<figure class="chart-frame chart" style="margin:0"><p class="chart-title">${esc(f)}</p><p class="chart-sub">Prompt tokens read per second</p>${legendHTML(ss.map(s => [s.slot, s.label, 'line']))}${prefillLinesSVG(ss, xDomain, yMax)}</figure>`; }).join('')}</div>`;
}
function renderContext() {
  const series = contextSeries(), studyRows = (WORK.long_context || []).filter(r => r.protocol?.id === STUDY_PROTOCOL);
  const biggest = studyRows.filter(r => r.size_label === '128k'), study = (WORK.studies || []).find(s => s.protocol_id === STUDY_PROTOCOL);
  const label = r => study?.configs.find(c => c.model_id === r.model_id)?.label || r.model_name;
  const slot = r => study?.configs.find(c => c.model_id === r.model_id)?.format_family === 'NVFP4' ? 1 : 2;
  content(`<div class="page-head"><div><h1 class="page-title">The wait before the first word.</h1><p class="lede">Before a model writes anything it has to read the whole prompt. With an agent's long context, that reading time can outlast the answer.</p></div><a class="button" href="workloads.json" download>Download workload JSON</a></div>
  ${series.length ? `${biggest.length ? `<section aria-labelledby="ctx-wait"><h2 id="ctx-wait">Reading a ${fmtInt(Math.round(median(biggest.map(r => r.prompt_tokens)) / 1000))}k-token prompt</h2><p class="muted" style="max-width:66ch">Seconds of prompt processing before the first token, from the 11 October study. One cold request per setup.</p>
    <figure class="chart-frame chart" style="margin:16px 0 0">${legendHTML([[1, 'NVFP4 weights'], [2, 'MLX 4-bit weights']])}${hbarsSVG(biggest.slice().sort((a, b) => a.prefill_s - b.prefill_s).map(r => ({label: label(r), value: r.prefill_s, slot: slot(r), note: `${fmtInt(r.prompt_tokens)} prompt tokens at ${fmtInt(r.prefill_tps)} tok/s`})), 's', 1)}</figure></section>` : ''}
  <section class="section" aria-labelledby="ctx-speed"><h2 id="ctx-speed">Prompt speed as prompts grow</h2><p class="muted" style="max-width:66ch">The 27B's NVFP4 build reads prompts about twice as fast as MLX 4-bit at 8k tokens, and the gap narrows as prompts grow. Flash Next keeps its speed out to 128k.</p>${contextPanels(series)}</section>
  <details class="panel" style="margin-top:26px"><summary>Show as a table</summary><div><div class="table-scroll"><table><thead><tr><th>Setup</th><th>Run</th><th class="right">Prompt tokens</th><th class="right">Prompt tok/s</th><th class="right">Read time</th><th class="right">First token</th></tr></thead><tbody>${series.flatMap(s => s.points.map(p => `<tr><td>${s.model ? `<a href="${modelURL(s.model, 'coding')}">${esc(s.model.name)}</a>` : esc(s.family)}</td><td>${esc(s.label)}</td><td class="right num">${fmtInt(p.x)}</td><td class="right num">${fmtInt(p.y)}</td><td class="right num">${p.seconds != null ? fmt(p.seconds, 2) + ' s' : '—'}</td><td class="right num">${p.ttft != null ? fmt(p.ttft, 2) + ' s' : '—'}</td></tr>`)).join('')}</tbody></table></div></div></details>
  <div class="section prose"><h2>What this does and does not show</h2><p>Prompt speed is reading, not writing: it says nothing about how fast the answer is generated or whether the model actually uses what it read. All four setups in the study did recall a passphrase from the start of a ~104k-token prompt.</p><p>The 11 October prompts start with a unique line so no cached prefix is reused. The 29 September archive values are rounded and their cache settings were not recorded, so compare the shapes rather than single points.</p></div>`
  : '<div class="empty"><h2>No long-prompt results yet</h2><p>Each model page lists its configured context limit; this page shows actual measurements once they are published.</p><a class="button" href="#models">Browse setups</a></div>'}`);
}

// ---------------------------------------------------------------- views: studies
function renderStudies() {
  const items = (WORK.timeline || []).slice().sort((a, b) => b.date.localeCompare(a.date));
  content(`<div class="page-head"><div><h1 class="page-title">What was tested, and when.</h1><p class="lede">SparkBench grows one question at a time. Each entry links to the setups or study it added; earlier numbers are never overwritten.</p></div></div>
  <ol class="timeline" reversed>${items.map(t => `<li class="${t.study_id ? 'featured' : ''}"><time datetime="${esc(t.date)}">${esc(dayLabel(t.date, {day: 'numeric', month: 'short', year: 'numeric'}))}</time><div><h3><a href="${esc(t.link)}">${esc(t.title)}</a></h3><p>${esc(t.summary)}</p></div></li>`).join('')}</ol>`);
}
function studyMetricRows(a, b) {
  const res = (id, w) => (WORK.results || []).find(r => r.model_id === id && r.workload === w && r.protocol?.id === STUDY_PROTOCOL)?.metrics?.decode_tps?.median;
  const conc = id => (WORK.concurrency || []).find(c => c.model_id === id && c.protocol_id === STUDY_PROTOCOL)?.aggregate_tps;
  const pre = (id, s) => (WORK.long_context || []).find(r => r.model_id === id && r.protocol?.id === STUDY_PROTOCOL && r.size_label === s)?.prefill_tps;
  return [['Coding output', res(a, 'coding'), res(b, 'coding'), 'tok/s', 1], ['Chat output', res(a, 'chat'), res(b, 'chat'), 'tok/s', 1], ['Four streams', conc(a), conc(b), 'tok/s total', 1],
    ['Prompt, 8k', pre(a, '8k'), pre(b, '8k'), 'tok/s', 0], ['Prompt, 32k', pre(a, '32k'), pre(b, '32k'), 'tok/s', 0], ['Prompt, 128k', pre(a, '128k'), pre(b, '128k'), 'tok/s', 0]]
    .filter(r => isNum(r[1]) && isNum(r[2]));
}
function renderStudy(id) {
  const s = studyById(id);
  if (!s) { content('<div class="empty"><h1 class="page-title">Study not found</h1><p>This link may point to a study that has not been published.</p><a class="button" href="#studies">All studies</a></div>'); return; }
  const cfg = s.configs, setup = c => modelById(c.model_id);
  const pairRows = Object.fromEntries(s.pairs.map(p => { const a = cfg.find(c => c.pair === p.id && c.format_family === 'NVFP4'), b = cfg.find(c => c.pair === p.id && c.format_family !== 'NVFP4'); return [p.id, a && b ? studyMetricRows(a.model_id, b.model_id) : []]; }));
  const limit = Math.max(25, ...Object.values(pairRows).flat().map(([, x, y]) => Math.abs((x / y - 1) * 100))) * 1.35;
  const pairHTML = s.pairs.map(p => {
    const a = cfg.find(c => c.pair === p.id && c.format_family === 'NVFP4'), b = cfg.find(c => c.pair === p.id && c.format_family !== 'NVFP4');
    if (!a || !b) return '';
    const rows = pairRows[p.id];
    return `<figure class="chart-frame chart" style="margin:0"><p class="chart-title">${esc(p.label)}</p><p class="chart-sub">NVFP4 compared with ${esc(b.format_family)}, same prompts</p>
      ${divergingSVG(rows.map(([label, x, y, unit, d]) => ({label, pct: (x / y - 1) * 100, a: `${fmt(x, d)} ${unit}`, b: `${fmt(y, d)}`})), limit)}
      <div class="table-scroll" style="margin-top:8px"><table><thead><tr><th>Measure</th><th class="right">NVFP4</th><th class="right">${esc(b.format_family)}</th></tr></thead><tbody>${rows.map(([label, x, y, unit, d]) => `<tr><td>${label}<div class="model-sub">${unit}</div></td><td class="right num">${fmt(x, d)}</td><td class="right num">${fmt(y, d)}</td></tr>`).join('')}</tbody></table></div>
      <p class="small ${p.same_engine_version ? 'muted' : ''}" style="margin:12px 0 0">${p.same_engine_version ? '' : '<span class="tag warn">Engine versions differ</span> '}${esc(p.note)}</p></figure>`;
  }).join('');
  const checks = (WORK.checks || []).filter(c => c.study_id === s.id), series = contextSeries().filter(x => x.proto === s.protocol_id);
  const profile = (WORK.profiles || []).find(p => p.id === s.protocol_id);
  content(`<a class="back" href="#studies">All studies</a>
  <div class="page-head" style="padding-top:18px"><div><p class="muted" style="margin:0 0 8px">${esc(dayLabel(s.date))}</p><h1 class="page-title">${esc(s.title)}</h1><p class="lede">${esc(s.question)}</p></div><div class="actions"><a class="button" href="quant-study-20261011.csv" download>Download CSV</a></div></div>
  <p class="answer">${esc(s.answer)}</p>
  <section class="section" aria-labelledby="study-pairs"><h2 id="study-pairs">Format against format</h2><p class="muted" style="max-width:66ch">Bars show how much faster or slower the NVFP4 build is than the MLX 4-bit build of the same model. Blue is faster, red is slower.</p>
    <div class="pair-grid" style="margin-top:16px">${pairHTML}</div></section>
  <section class="section" aria-labelledby="study-findings"><h2 id="study-findings">Findings</h2><ul class="findings" style="margin-top:12px">${s.findings.map(f => `<li>${esc(f)}</li>`).join('')}</ul><p class="notice" style="max-width:74ch">${esc(s.outcome)}</p></section>
  ${series.length ? `<section class="section" aria-labelledby="study-prefill"><h2 id="study-prefill">Prompt speed by length</h2>${contextPanels(series)}</section>` : ''}
  <section class="section" aria-labelledby="study-setups"><h2 id="study-setups">The four setups</h2>
    <div class="table-scroll"><table><thead><tr><th>Setup</th><th>Checkpoint</th><th>TensorFold</th><th class="right">Weights</th><th>Speculative decoding</th><th class="right">Long recall</th><th class="right">Tool call</th></tr></thead><tbody>${cfg.map(c => { const m = setup(c), srv = m?.config?.server || {}, ch = checks.filter(x => x.model_id === c.model_id), ok = k => { const x = ch.find(y => y.check === k); return x == null ? '—' : x.passed ? '<span class="check-ok">Passed</span>' : '<span class="check-fail">Failed</span>'; }; const spec = (WORK.results || []).find(r => r.model_id === c.model_id && r.protocol?.id === s.protocol_id)?.protocol?.notes?.find(n => n.startsWith('Speculative')); return `<tr><td>${m ? `<a class="model-name" href="${modelURL(m, 'coding')}">${esc(c.label)}</a>` : esc(c.label)}</td><td class="small">${esc(c.checkpoint)}</td><td class="small">${esc(c.engine_version.split(' ')[0])}</td><td class="right num">${m?.diskGiB != null ? fmt(m.diskGiB, 1) + ' GiB' : '—'}</td><td class="small">${esc((srv.speculative_decoding || spec?.replace('Speculative decoding on: ', '') || '').replace(/\.$/, ''))}</td><td class="right">${ok('long_recall')}</td><td class="right">${ok('tool_call')}</td></tr>`; }).join('')}</tbody></table></div></section>
  <div class="two-col"><section><h2>Protocol</h2><p class="muted">${esc(profile?.description || '')}</p><p class="small muted">Prompt text is not published; each result carries the SHA-256 of its prompt. The weight sizes exclude the 3.6 GiB DFlash2 drafter used by both 27B setups.</p></section>
    <section><h2>Caveats</h2><ul class="findings">${s.caveats.map(c => `<li>${esc(c)}</li>`).join('')}</ul></section></div>`);
}

// ---------------------------------------------------------------- views: model detail
function specs(rows) { return `<dl class="specs">${rows.filter(([, v]) => v !== undefined).map(([l, v]) => `<dt>${esc(l)}</dt><dd>${esc(v ?? 'Not recorded')}</dd>`).join('')}</dl>`; }
function figuresHTML(m, r) {
  const metrics = r?.metrics || {};
  const items = m.kind === 'embedding'
    ? [['Input throughput', m.input_tps_wall?.median, 'tok/s', 1], ['Wall time', m.wall_s?.median, 's', 3], ['Load time', m.load_s, 's', 3], ['Loaded allocation', m.loaded_allocated_gib, 'GiB', 1]]
    : [['Output speed', metrics.decode_tps?.median, 'tok/s', 1], ['First token', metrics.ttft_s?.median, 's', 3], ['Prompt speed', metrics.prefill_tps?.median, 'tok/s', 0], ['End-to-end', metrics.end_to_end_tps?.median, 'tok/s', 1]];
  return `<div class="figures">${items.map(([label, v, unit, d]) => `<div class="figure"><div class="figure-label">${label}</div><div class="figure-value">${fmt(v, d)}${v == null ? '' : `<small>${unit}</small>`}</div><div class="figure-note">${v == null ? 'Not recorded for this workload' : 'Median' + (r?.trial_count ? ` of ${r.trial_count} trials` : '')}</div></div>`).join('')}</div>`;
}
function trialTable(m) {
  const a = m.raw?.trials || [];
  return `<p class="small muted">The warmup is excluded from medians. Prompt and response text are not published; their hashes are in the JSON archive.</p><div class="table-scroll"><table><thead><tr><th>Trial</th><th class="right">Input tokens</th><th class="right">Output tokens</th><th class="right">Output tok/s</th><th class="right">First token s</th><th class="right">Prompt tok/s</th><th class="right">Wall s</th></tr></thead><tbody>${a.map(t => `<tr><td>${t.phase === 'warmup' ? '<span class="muted">Warmup (excluded)</span>' : 'Trial ' + esc(t.trial)}</td><td class="right num">${fmt(t.input_tokens, 0)}</td><td class="right num">${fmt(t.output_tokens, 0)}</td><td class="right num">${fmt(t.decode_tps, 2)}</td><td class="right num">${fmt(t.ttft_s, 3)}</td><td class="right num">${fmt(t.prefill_tps, 0)}</td><td class="right num">${fmt(t.wall_s, 3)}</td></tr>`).join('')}</tbody></table></div>`;
}
function modelSpecs(m) {
  const raw = m.raw || {}, meta = raw.metadata || {}, cp = meta.checkpoint || {}, p = profileFor(m), server = meta.server || {}, srv = m.config?.server;
  if (srv) return specs([['Inference engine', `${m.engine} ${srv.tensorfold_version}`], ['Weight format', formatOf(m)], ['Quantization', m.quant], ['Total parameters', m.params], ['Active parameters', m.active || 'Dense (all)'],
    ['Checkpoint', m.config.checkpoint?.repo_id], ['Revision', m.config.checkpoint?.revision], ['Weight files on disk', val(m.diskGiB, 'GiB')], ['Weight size basis', m.weight_size_basis], ['Maximum context', fmtInt(srv.context_tokens) + ' tokens'],
    ['KV cache', srv.kv_dtype], ['Server streams', srv.parallel_slots], ['Precision', srv.precision], ['Speculative decoding', srv.speculative_decoding], ['Vision', srv.vision ? 'On' : 'Off']]);
  return specs([['Inference engine', m.engine + ' ' + (server.tensorfold_version || p.version || '')], ['Weight format', m.format || raw.format], ['Quantization', m.quant], ['Total parameters', m.params], ['Active parameters', m.active],
    ['Checkpoint', cp.repo_id || meta.inventory_audit?.parameters?.source || p.checkpoint], ['Revision or digest', cp.revision || meta.inventory_audit?.checkpoint_revision || m.manifest_digest || raw.digest], ['Weight files on disk', val(m.tag_disk_gib, 'GiB')],
    ['Weight size basis', m.weight_size_basis], ['Compatibility check', meta.compatibility?.status], ['Compatibility checked at', meta.compatibility?.checked_at], ['Accepted weight methods', meta.compatibility?.accepted_formats?.join(', ')],
    ['Accepted layer algorithms', meta.compatibility?.accepted_quant_algorithms?.join(', ')], ['Maximum context', (n => isNum(n) ? fmtInt(n) + ' tokens' : n)(server.context_tokens || p.maximum_context || p.requested_context)], ['KV cache', server.kv_dtype || p.kv_cache_dtype],
    ['Server slots', server.parallel_slots || p.server_parallel_slots || p.maximum_sequences], ['Benchmark concurrency', m.status === 'unavailable' ? null : server.request_concurrency || 1],
    ['MTP drafting', server.mtp_drafts || p.mtp_drafts ? `${server.mtp_drafts || p.mtp_drafts} drafts, confidence ${server.mtp_confidence || p.mtp_confidence}` : 'Not recorded or not configured'], ['Flash attention', p.flash_attention == null ? null : String(p.flash_attention)]]);
}
function resourceSpecs(m) {
  const srv = m.config?.server;
  if (srv) return specs([['Start-up memory estimate', val(srv.startup_estimate_gib, 'GiB', 2)], ['Engine load time', val(srv.engine_load_s, 's')], ['Ready after (launcher poll)', val(srv.ready_after_s, 's', 0)]]);
  const r = m.resources || {};
  return specs([['Loaded allocation', val(m.loaded_allocated_gib, 'GiB')], ['Loaded GPU allocation', val(m.loaded_gpu_allocated_gib, 'GiB')], ['Host peak unavailable', val(r.host_peak_unavailable_gib, 'GiB')], ['Peak GPU temperature', val(r.gpu_temperature_max_c, '°C', 0)],
    ['Mean GPU power', val(r.gpu_power_mean_w, 'W')], ['Peak GPU power', val(r.gpu_power_max_w, 'W')], ['Mean GPU utilization', val(r.gpu_util_mean_percent, '%')], ['Resource samples', r.sample_count], ['Engine load duration', val(m.load_s, 's', 3)],
    ['Start-up to ready', val(m.startup_to_ready_s || m.raw?.metadata?.result?.startup_to_ready_s, 's', 1)]]);
}
function rangeTable(r) {
  const rows = [['Output tok/s', 'decode_tps'], ...(r?.metrics?.decode_tps_server_log ? [['Output tok/s, server log', 'decode_tps_server_log']] : []), ['First token s', 'ttft_s'], ['Prompt tok/s', 'prefill_tps'], ['End-to-end tok/s', 'end_to_end_tps']];
  const note = r?.metrics?.decode_tps_server_log ? ' The first output row is the median the bench client recorded; the server-log row is each request\'s own rate, which TensorFold rounds slightly differently.' : '';
  return `<div class="table-scroll"><table><thead><tr><th>Metric</th><th class="right">Median</th><th class="right">Min</th><th class="right">Max</th><th class="right">Sample SD</th><th class="right">Variation %</th></tr></thead><tbody>${rows.map(([label, k]) => { const s = r?.metrics?.[k] || {}, d = k === 'ttft_s' ? 3 : 2; return `<tr><td>${label}</td><td class="right num">${fmt(s.median, d)}</td><td class="right num">${fmt(s.min, d)}</td><td class="right num">${fmt(s.max, d)}</td><td class="right num">${fmt(s.sample_sd, d)}</td><td class="right num">${fmt(s.cv_percent, 2)}</td></tr>`; }).join('')}</tbody></table></div><p class="small muted" style="margin-top:12px">Three short repetitions describe this sample. They do not establish a confidence interval or sustained thermal behaviour.${note}</p>`;
}
function protocolHTML(r, m) {
  const p = r?.protocol || {}, meta = m.raw?.metadata || {};
  return specs([['Workload', r?.workload || state.workload], ['Prompt family', p.prompt_family], ['Trial count', r?.trial_count], ['Output limit', p.output_limit], ['Sampling', typeof p.sampling === 'object' ? JSON.stringify(p.sampling) : p.sampling],
    ['Configured context', isNum(p.context_tokens) ? fmtInt(p.context_tokens) + ' tokens' : p.context_tokens], ['Temperature', p.temperature], ['Seed', p.seed], ['Thinking', p.thinking === false ? 'Requested off' : p.thinking], ['Concurrency', p.concurrency], ['Timing basis', p.timing_basis || m.decode_measurement],
    ['Engine version', r?.provenance?.engine_version], ['Source', r?.provenance?.source], ['Measured at', r?.provenance?.measured_at], ['Protocol match', state.workload === 'writing' ? meta.protocol_match : null],
    ['Notes', Array.isArray(p.notes) ? p.notes.join(' ') : p.notes]].filter(([, v]) => v != null && v !== ''));
}
function workloadTrialTable(r) {
  const a = [...(r.warmup ? [{...r.warmup, phase: 'warmup'}] : []), ...(r.trials || [])];
  const drafts = a.some(t => t.tensorfold?.drafted);
  return `<p class="small muted">Trials for the selected workload. A warmup, when present, is excluded from the median. Returned reasoning counts as output.</p><div class="table-scroll"><table><thead><tr><th>Trial</th><th class="right">Prompt tokens</th><th class="right">Output tokens</th><th class="right">Output tok/s</th><th class="right">First token s</th><th class="right">Prompt tok/s</th><th class="right">Wall s</th>${drafts ? '<th class="right">Drafts accepted</th>' : ''}</tr></thead><tbody>${a.map(t => `<tr><td>${t.phase === 'warmup' ? 'Warmup (excluded)' : 'Trial ' + esc(t.trial)}${t.note ? `<div class="model-sub">${esc(t.note)}</div>` : ''}</td><td class="right num">${fmt(t.prompt_tokens ?? t.input_tokens, 0)}</td><td class="right num">${fmt(t.output_tokens, 0)}</td><td class="right num">${fmt(t.decode_tps, 2)}</td><td class="right num">${fmt(t.ttft_s, 3)}</td><td class="right num">${fmt(t.prefill_tps, 0)}</td><td class="right num">${fmt(t.wall_s, 3)}</td>${drafts ? `<td class="right num">${t.tensorfold?.drafted ? `${fmtInt(t.tensorfold.accepted)} of ${fmtInt(t.tensorfold.drafted)}` : '—'}</td>` : ''}</tr>`).join('')}</tbody></table></div>`;
}
function workloadResources(r) {
  const a = (r.trials || []).map(t => t.resource_after).filter(Boolean);
  if (!a.length) return '';
  const values = k => a.map(x => x[k]).filter(Number.isFinite), maximum = k => values(k).length ? Math.max(...values(k)) : null, average = k => values(k).length ? values(k).reduce((s, x) => s + x, 0) / values(k).length : null, available = values('memory_available_kib');
  return `<details class="panel"><summary>Resource samples for this workload</summary><div>${specs([['Sample count', a.length], ['Maximum GPU temperature', val(maximum('gpu_temperature_c'), '°C', 0)], ['Mean sampled GPU power', val(average('gpu_power_w'), 'W')], ['Maximum sampled GPU power', val(maximum('gpu_power_w'), 'W')], ['Mean GPU utilization', val(average('gpu_utilization_percent'), '%')], ['Minimum available host memory', val(available.length ? Math.min(...available) / 1024 / 1024 : null, 'GiB')]])}<p class="small muted" style="margin-top:12px">Sampled right after each measured request. Host memory covers every process; board power is not wall power or energy.</p></div></details>`;
}
function startupObservationsHTML(m) {
  const observations = (WORK.startup_observations || []).filter(o => (o.model_id === m.id || o.model_name === m.model) && (!o.engine || o.engine === m.engine));
  if (!observations.length) return '';
  const known = new Set(['model_id', 'model_name', 'engine', 'server_startup_to_observed_ready_s', 'engine_weight_loading_s', 'engine_weight_allocation_gib', 'cold_warmup_native_load_s', 'notes', 'protocol', 'startup_memory_estimate_gib']);
  const measured = (v, u) => v == null ? 'Not measured' : val(v, u, 3);
  return `<details class="panel" id="suite-startup"><summary>Start-up and weight loading</summary><div><p class="small muted">Separate from generation speed. A missing value was not measured.</p>${observations.map((o, i) => `<h3 style="margin-top:14px">${o.protocol?.id === STUDY_PROTOCOL ? '11 October study' : observations.length > 1 ? 'Observation ' + (i + 1) : 'Workload suite'}</h3>${specs([['Server start-up to observed ready', measured(o.server_startup_to_observed_ready_s, 's')], ['Engine weight loading', measured(o.engine_weight_loading_s, 's')], ['Engine weight allocation', measured(o.engine_weight_allocation_gib, 'GiB')], ['Start-up memory estimate', o.startup_memory_estimate_gib == null ? undefined : val(o.startup_memory_estimate_gib, 'GiB', 2)], ['Cold warmup native load', measured(o.cold_warmup_native_load_s, 's')], ...Object.entries(o).filter(([k]) => !known.has(k)).map(([k, v]) => [cap(k.replaceAll('_', ' ')), v == null ? 'Not measured' : typeof v === 'object' ? JSON.stringify(v) : v])])}${o.notes ? `<p class="small muted" style="margin-top:12px">${esc(Array.isArray(o.notes) ? o.notes.join(' ') : o.notes)}</p>` : ''}`).join('')}</div></details>`;
}
function nativeTrialTimingHTML(r) {
  const trials = [...(r.warmup ? [{...r.warmup, phase: 'warmup'}] : []), ...(r.trials || [])].filter(t => t.native_timing?.duration_unit === 'ns');
  const definitions = [['total_duration', 'Total s', true], ['load_duration', 'Load s', true], ['prompt_eval_duration', 'Prompt eval s', true], ['eval_duration', 'Generation eval s', true], ['prompt_eval_count', 'Prompt tokens', false], ['eval_count', 'Generated tokens', false]];
  const fields = definitions.filter(([k]) => trials.some(t => isNum(t.native_timing[k])));
  if (!fields.length) return '';
  return `<details class="panel" id="native-trial-timings"><summary>Ollama native request timing</summary><div><p class="small muted">Engine durations converted from nanoseconds to seconds. Load duration belongs to each request and is separate from container start-up. The warmup is excluded from medians.</p><div class="table-scroll"><table><thead><tr><th>Trial</th>${fields.map(([, label]) => `<th class="right">${label}</th>`).join('')}</tr></thead><tbody>${trials.map(t => `<tr><td>${t.phase === 'warmup' ? 'Warmup (excluded)' : 'Trial ' + esc(t.trial)}</td>${fields.map(([k, , duration]) => { const v = t.native_timing[k]; return `<td class="right num">${isNum(v) ? fmt(duration ? v / 1e9 : v, duration ? 6 : 0) : '—'}</td>`; }).join('')}</tr>`).join('')}</tbody></table></div></div></details>`;
}
function extrasHTML(m) {
  const conc = concurrencyFor(m), checks = checksFor(m), lc = longContextFor(m).filter(r => r.protocol?.id === STUDY_PROTOCOL);
  if (!conc.length && !checks.length && !lc.length) return '';
  return `<section class="section" aria-labelledby="extras-title"><h2 id="extras-title">Serving checks, 11 October</h2><p class="muted" style="max-width:66ch">From the <a href="#study/${esc(conc[0]?.study_id || checks[0]?.study_id || '')}">NVFP4 or MLX 4-bit study</a>, run on TensorFold ${esc((conc[0] && (WORK.studies || []).flatMap(s => s.configs).find(c => c.model_id === m.id)?.engine_version.split(' ')[0]) || '')}.</p>
    <div class="figures" style="margin-top:14px">${conc.map(c => `<div class="figure"><div class="figure-label">${c.streams} streams at once</div><div class="figure-value">${fmt(c.aggregate_tps, 1)}<small>tok/s total</small></div><div class="figure-note">${c.per_request_decode_tps ? 'Per stream ' + c.per_request_decode_tps.map(v => fmt(v, 1)).join(', ') : 'Per-stream rates not logged'}</div></div>`).join('')}${lc.map(r => `<div class="figure"><div class="figure-label">Prompt of ${fmtInt(r.prompt_tokens)} tokens</div><div class="figure-value">${fmtInt(r.prefill_tps)}<small>tok/s</small></div><div class="figure-note">Read in ${fmt(r.prefill_s, 1)} s</div></div>`).join('')}</div>
    ${checks.length ? `<ul class="findings" style="margin-top:18px">${checks.map(c => `<li>${esc(c.label)}${c.prompt_tokens ? ` (${fmtInt(c.prompt_tokens)} tokens)` : ''}: ${c.passed ? '<span class="check-ok">passed</span>' : '<span class="check-fail">failed</span>'}</li>`).join('')}</ul>` : ''}</section>`;
}
function renderDetail(id) {
  const m = modelById(id);
  if (!m) { content('<div class="empty"><h1 class="page-title">Setup not found</h1><p>This link may point to an older snapshot.</p><a class="button" href="#models">Browse setups</a></div>'); return; }
  const r = measurement(m), aliases = models.filter(a => groupKey(a) === groupKey(m)), attempt = latestAttempt(m);
  let warning = '';
  if (m.status === 'incomplete') warning = `This entry is incomplete. ${esc(m.raw?.error || 'No successful generation measurement was published.')}`;
  else if (!r && m.kind === 'generation') warning = attempt?.status === 'error' || attempt?.status === 'unavailable' ? 'The workload test could not produce a valid result. ' + esc(attempt.error || (attempt.protocol?.notes || []).join(' ')) : m.status === 'unavailable' ? esc(m.raw?.error || 'No supported runtime measurement is available.') : `${cap(state.workload)} has not been measured for this setup. Pick another workload.`;
  const matrix = m.kind === 'generation' ? `<div class="matrix">${WORKLOADS.map(w => { const x = measurement(m, w), v = x?.metrics?.decode_tps?.median; return `<div class="${w === state.workload ? 'active-workload' : ''}"><div class="figure-label">${cap(w)}</div><div class="figure-value">${v == null ? '<span class="cell-empty">' + (latestAttempt(m, w)?.status === 'unavailable' || latestAttempt(m, w)?.status === 'error' || m.status !== 'ok' ? 'Unavailable' : 'Not measured') + '</span>' : fmt(v, 1) + '<small>tok/s</small>'}</div><div class="figure-note">${x ? sourceLabel(x, w) + (x.metrics?.ttft_s?.median != null ? `, first token ${fmt(x.metrics.ttft_s.median, 2)} s` : '') : ''}</div></div>`; }).join('')}</div>` : '';
  content(`<a class="back" href="#models?workload=${state.workload}">Leaderboard</a>
  <div class="page-head" style="padding-top:18px"><div><h1 class="detail-title">${esc(m.name)}</h1><p class="lede">${engineLabel(m)} &nbsp;${sizeLine(m)} ${statusTag(m)}</p></div><div class="actions"><button class="quiet" type="button" id="detail-select">${selected.has(m.id) ? 'Remove from comparison' : 'Add to comparison'}</button><button class="quiet" type="button" id="share">Copy link</button></div></div>
  ${matrix}
  ${m.kind === 'generation' ? `<div class="workload-switch"><span class="muted">Details for</span>${workloadSegments('detail-workload', false)}</div>` : ''}
  ${warning ? `<div class="notice warning">${warning}</div>` : ''}
  ${r || m.kind === 'embedding' ? figuresHTML(m, r) : ''}
  ${extrasHTML(m)}
  <div class="two-col"><section><h2>Weights and server</h2>${modelSpecs(m)}${m.raw?.metadata?.parameters_note ? `<p class="small muted" style="margin-top:12px">${esc(m.raw.metadata.parameters_note)}</p>` : ''}${aliases.length > 1 ? `<details class="panel" style="margin-top:16px"><summary>Tags sharing these weights (${aliases.length})</summary><div class="small">${aliases.map(a => `<a href="${modelURL(a)}">${esc(a.model)}</a>`).join('<br>')}<p class="muted" style="margin-top:12px">Same engine and recorded checkpoint or manifest digest. Each tag keeps its own trials.</p></div></details>` : ''}</section>
  <section><h2>${m.config ? 'Start-up' : 'Writing baseline resources'}</h2>${resourceSpecs(m)}<p class="small muted" style="margin-top:12px">${m.config ? 'TensorFold reports its own load time and start-up memory estimate; the first start after an install also builds CUDA extensions.' : esc(m.resources?.note || m.raw?.metadata?.resources_note || 'Host memory includes the OS and background services. Resource samples are observations, not isolated model memory or energy.')}</p></section></div>
  <div class="panels">
    ${startupObservationsHTML(m)}
    ${r ? `<details class="panel" open><summary>Statistics and range</summary><div>${rangeTable(r)}</div></details><details class="panel"><summary>Protocol for this measurement</summary><div>${protocolHTML(r, m)}</div></details>` : ''}
    ${r && measurements(m).length > 1 ? `<details class="panel"><summary>Every archived ${state.workload} measurement (${measurements(m).length})</summary><div>${measurements(m).map(a => `<h3 style="margin-top:14px">${esc(sourceLabel(a, state.workload))}${a === r ? ' (shown above)' : ''}: ${fmt(a.metrics?.decode_tps?.median)} tok/s</h3>${protocolHTML(a, m)}`).join('')}</div></details>` : ''}
    ${r && state.workload !== 'writing' && r.trials?.length ? `<details class="panel"><summary>Trials for this workload</summary><div>${workloadTrialTable(r)}</div></details>${workloadResources(r)}${nativeTrialTimingHTML(r)}` : ''}
    ${state.workload === 'writing' && m.raw?.trials?.length ? `<details class="panel"><summary>Individual trials and warmup</summary><div>${trialTable(m)}</div></details>` : ''}
  </div>
  <p class="small muted" style="margin-top:24px">Speed does not measure answer quality. <a href="#method">Protocol and limits</a>. <a href="data.json" download>Archive JSON</a>.</p>`);
  $('#detail-select').onclick = () => toggleSelection(m.id, !selected.has(m.id));
  $('#share').onclick = async () => { try { await navigator.clipboard.writeText(location.href); notify('Link copied'); } catch { notify('Copy the address from your browser bar'); } };
  bindWorkloadButtons();
}

// ---------------------------------------------------------------- views: compare
function toggleSelection(id, on) {
  if (on && !selected.has(id) && selected.size >= 8) { notify('Compare up to eight setups at once'); if ($('#results')) renderResults(); return; }
  on ? selected.add(id) : selected.delete(id);
  updateInPlace();
}
function updateTray() {
  const compare = currentPath() === 'compare';
  $('#tray').hidden = !selected.size || compare;
  $('#tray-count').textContent = `${selected.size} selected`;
  $('#compare-link').href = `#compare?workload=${state.workload}&models=${[...selected].join(',')}`;
  const count = $('#selected-count');
  if (count) count.textContent = '(' + selected.size + ')';
  const nav = $('#nav-count');
  nav.hidden = !selected.size;
  nav.textContent = selected.size;
}
function renderCompare() {
  const a = models.filter(m => selected.has(m.id)), ws = WORKLOADS;
  const rows = [['Engine', m => m.engine], ['Format', formatOf], ['Quantization', m => m.quant], ['Total parameters', m => m.params], ['Active parameters', m => m.active || (m.config ? 'Dense (all)' : 'Not recorded')], ['Weights on disk', m => val(m.diskGiB, 'GiB')],
    ['Four streams at once', m => { const c = concurrencyFor(m)[0]; return c ? `${fmt(c.aggregate_tps, 1)} tok/s total` : 'Not measured'; }],
    ['Loaded allocation', m => val(m.loaded_allocated_gib, 'GiB')], ['Host peak unavailable', m => val(m.resources?.host_peak_unavailable_gib, 'GiB')], ['GPU temperature max', m => val(m.resources?.gpu_temperature_max_c, '°C', 0)], ['GPU power mean', m => val(m.resources?.gpu_power_mean_w, 'W')],
    ['Load duration', m => m.config ? val(m.config.server.engine_load_s, 's') : val(m.load_s, 's', 3)], [`${cap(state.workload)} timing basis`, m => measurement(m)?.protocol?.timing_basis || m.decode_measurement], [`${cap(state.workload)} protocol`, m => measurement(m)?.protocol?.id || 'Not measured']];
  content(`<div class="page-head"><div><h1 class="page-title">Side by side.</h1><p class="lede">Up to eight setups, every workload, then the storage and runtime facts behind the numbers. Each measurement keeps its own protocol.</p></div><div class="actions"><a class="button" href="#models">Choose setups</a>${a.length ? '<button class="quiet" type="button" id="clear-compare">Clear comparison</button>' : ''}</div></div>
  ${a.length ? `<div class="field" style="margin-bottom:14px"><span>Show</span><select id="metric-choice" style="max-width:260px">${metricKeys.map(k => `<option value="${k}" ${state.metric === k ? 'selected' : ''}>${METRICS[k].label} (${METRICS[k].unit})</option>`).join('')}</select></div>
  <div class="table-scroll" id="compare-table-wrap"><table class="compare-table"><thead><tr><th>Measure</th>${a.map(m => `<th><a class="model-name" href="${modelURL(m)}">${esc(m.name)}</a><div><button class="linklike remove" type="button" data-remove="${esc(m.id)}">Remove</button></div></th>`).join('')}</tr></thead><tbody>
    ${ws.map(w => `<tr data-row="workload-${w}"><td>${cap(w)}<div class="model-sub">${METRICS[state.metric].label}, ${METRICS[state.metric].unit}</div></td>${a.map(m => `<td class="num workload-cell">${cellMetric(m, w, Math.max(1, ...a.map(x => metricOf(x, w) || 0)))}</td>`).join('')}</tr>`).join('')}
    ${rows.map(([l, f]) => `<tr data-row="spec-${esc(l)}"><td>${esc(l)}</td>${a.map(m => `<td>${esc(f(m) || 'Not recorded')}</td>`).join('')}</tr>`).join('')}
  </tbody></table></div><p class="small muted" style="margin-top:14px">Resource rows describe the writing baseline. Load and start-up use different timing windows; open a setup for details.</p>`
  : '<div class="empty"><h2>Pick setups to compare</h2><p>Tick up to eight setups in the leaderboard, or use "Add to comparison" on any setup page.</p><a class="button primary" href="#models">Open the leaderboard</a></div>'}`);
  const clear = $('#clear-compare');
  if (clear) clear.onclick = () => { selected.clear(); updateInPlace(); };
  const metric = $('#metric-choice');
  if (metric) metric.onchange = e => { state.metric = e.target.value; updateInPlace(); };
  $$('[data-remove]').forEach(b => b.onclick = () => { selected.delete(b.dataset.remove); updateInPlace(); });
}

// ---------------------------------------------------------------- views: method
function renderMethod() {
  const p = SUM.protocol || {}, study = (WORK.profiles || []).find(x => x.id === STUDY_PROTOCOL);
  const block = (title, body) => `<section class="two-col" style="grid-template-columns:minmax(0,260px) minmax(0,1fr);margin-top:0;padding:30px 0;border-top:1px solid var(--rule)"><h2>${title}</h2><div class="prose">${body}</div></section>`;
  content(`<div class="page-head"><div><h1 class="page-title">How the numbers are made.</h1><p class="lede">A reproducible speed snapshot with its limits in plain view: model identities, timing statistics, warmups and resource observations.</p></div><div class="actions"><a class="button" href="data.json" download>Archive JSON</a><a class="button" href="summary.json" download>Summary JSON</a><a class="button" href="workloads.json" download>Workloads JSON</a></div></div>
  ${block('Hardware', specs(Object.entries(SUM.hardware || {}).map(([k, v]) => [cap(k.replaceAll('_', ' ')), v]).concat([['TensorFold for the 11 October study', '0.6.6 (python-0.6 line); the live Flash Next server runs 0.3.6.3'], ['Memory bandwidth', '273 GB/s (NVIDIA specification), used for the speed-map ceiling']])))}
  ${block('Writing baseline', `<p>One warmup capped at ${esc(p.warmup_output_limit)} output tokens, then ${esc(p.measured_trials)} measured trials capped at ${esc(p.measured_output_limit)} tokens. The displayed number is the median of the measured trials.</p>${specs([['Temperature', p.temperature], ['Thinking', p.thinking === false ? 'Requested off' : p.thinking], ['Concurrency', p.concurrency], ['Seed', p.seed], ['Default requested context', p.context_tokens], ['Sample limits', p.sample_limits], ['Prompt caching', p.prompt_cache], ['Token counting', p.generated_tokens]])}`)}
  ${block('Engine timing', `${Object.entries(p.decode_basis || {}).map(([engine, basis]) => `<p><strong>${esc(engine)}.</strong> ${esc(basis)}</p>`).join('')}<p>${esc(p.configuration_caveat)}</p><details class="panel"><summary>Complete engine profiles</summary><div>${Object.entries(p.engine_profiles || {}).map(([name, profile]) => `<h3 style="margin-top:14px">${esc(cap(name.replaceAll('_', ' ')))}</h3>${specs(Object.entries(profile).map(([k, v]) => [cap(k.replaceAll('_', ' ')), typeof v === 'object' ? JSON.stringify(v) : v]))}`).join('')}</div></details>`)}
  ${block('Coding and chat', `<p>Dedicated workload results are stored apart from the writing baseline. Each records its model, engine, workload, metrics, protocol and source, and keeps its own prompts and sampling.</p><p>The 30 September suite used a 16-token warmup, then three measured requests capped at 256 tokens, temperature 0, thinking requested off and one request at a time. Tag names such as “coder” identify an installed tag, not a coding measurement.</p>${(WORK.profiles || []).filter(x => x.id !== STUDY_PROTOCOL).map(x => `<h3>${esc(x.label)}</h3><p>${esc(x.description)}</p>`).join('')}`)}
  ${study ? block('11 October study', `<p>${esc(study.description)}</p><p>Decode medians come from the bench client; per-request rates, first-token times and accepted drafts come from each server's log. Prompt text is published only as SHA-256 hashes. <a href="#study/nvfp4-vs-mlx-20261011">Read the study</a>.</p>`) : ''}
  ${block('Load and resources', `<p>Start-up observations separate server start-up to readiness, engine weight loading, weight allocation and the native load in a cold warmup request. A null value was not measured. Ollama native timing is shown separately, converted from nanoseconds.</p><p>${esc(p.warmup_basis)}</p><p>${esc(p.load_caveat)}</p><p>Loaded allocation and host peak memory have different scopes. Host values include the OS and background services. GPU power is sampled, not full-run energy.</p>`)}
  ${block('Limits', `<p>${esc(p.scope)}</p><p>Tokenizers count text differently. A small fast model is not automatically a better coding model, and the leaderboard order is not a quality ranking. Engine timing formulas are not interchangeable.</p><p>Matching digests are grouped within an engine for browsing; Ollama digests identify manifests, so tags with different manifests stay separate even when they share a weight blob. Every alias keeps its own trials.</p>`)}
  ${block('Data', `<p>A static GitHub Pages snapshot. Reload fetches the published files again; it never starts a benchmark or contacts the Spark. Prompt and answer text are left out of the public archive.</p><p><a href="BENCHMARK.md">Benchmark protocol</a>, <a href="WORKLOADS.md">workload schema</a>, <a href="all-models-side-by-side.csv" download>all models CSV</a>, <a href="controlled-workload-trials.csv" download>trial timings CSV</a>, <a href="workload-startup-observations.csv" download>start-up CSV</a>, <a href="quant-study-20261011.csv" download>11 October study CSV</a>, <a href="https://github.com/LexiLominite/sparkbench">repository history</a>.</p>`)}`);
}

// ---------------------------------------------------------------- routing
function decodeId(id) { try { return decodeURIComponent(id); } catch { return id; } }
function route() {
  const hash = location.hash.slice(1) || 'models', [path, search = ''] = hash.split('?'), params = new URLSearchParams(search);
  if (WORKLOADS.includes(params.get('workload'))) state.workload = params.get('workload');
  if (path === 'models') {
    if (['all', 'single'].includes(params.get('view'))) state.view = params.get('view');
    if (['all', 'selected'].includes(params.get('scope'))) state.scope = params.get('scope');
  }
  if (path === 'compare' && params.has('models')) selected = new Set([...new Set((params.get('models') || '').split(',').filter(id => models.some(m => m.id === id)))].slice(0, 8));
  return path;
}
const TITLES = {compare: 'Compare', context: 'Long prompts', method: 'Method', map: 'Speed map', studies: 'Studies'};
function render(inPlace = false) {
  const path = inPlace ? currentPath() : route();
  const section = path.startsWith('model/') ? 'models' : path.startsWith('study/') ? 'studies' : path;
  $$('[data-nav]').forEach(a => { if (a.dataset.nav === section) a.setAttribute('aria-current', 'page'); else a.removeAttribute('aria-current'); });
  if (path.startsWith('model/')) renderDetail(decodeId(path.slice(6)));
  else if (path.startsWith('study/')) renderStudy(decodeId(path.slice(6)));
  else if (path === 'compare') renderCompare();
  else if (path === 'context') renderContext();
  else if (path === 'map') renderMap();
  else if (path === 'studies') renderStudies();
  else if (path === 'method') renderMethod();
  else renderModels();
  const title = path.startsWith('model/') ? modelById(decodeId(path.slice(6)))?.name || 'Setup' : path.startsWith('study/') ? studyById(decodeId(path.slice(6)))?.title || 'Study' : TITLES[path];
  document.title = title ? `${title}, SparkBench` : 'SparkBench: model speed on a DGX Spark';
  updateTray();
  Race.sync();
}

// ---------------------------------------------------------------- export and load
function csvEscape(v) { return '"' + String(v ?? '').replaceAll('"', '""') + '"'; }
function exportCSV() {
  const header = ['model', 'engine', 'workload', 'quantization', 'format', 'total_parameters_B', 'active_parameters_B', 'weight_disk_GiB', 'model_status', 'workload_status', 'workload_note', 'trial_count', 'output_tps_median', 'ttft_s_median', 'prefill_tps_median', 'end_to_end_tps_median', 'timing_basis', 'protocol_id', 'source'];
  const rows = filterModels().flatMap(m => visibleWorkloads().map(w => {
    const r = measurement(m, w), attempt = latestAttempt(m, w), status = r ? 'ok' : attempt?.status || (m.status === 'unavailable' ? 'unavailable' : 'unmeasured');
    return [m.model, m.engine, w, m.quant, formatOf(m), m.totalB, m.activeB, m.diskGiB, m.status, status, r ? '' : attempt?.error || '', r?.trial_count, ...metricKeys.map(k => r?.metrics?.[k]?.median), r ? (r.protocol?.timing_basis || m.decode_measurement) : '', r?.protocol?.id, r?.provenance?.source];
  }));
  const blob = new Blob([[header, ...rows].map(a => a.map(csvEscape).join(',')).join('\r\n')], {type: 'text/csv;charset=utf-8'});
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `sparkbench-${state.view === 'all' ? 'all-workloads' : state.workload}.csv`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  notify('CSV exported for the visible setups');
}
async function load(reload = false) {
  try {
    const suffix = reload ? '?refresh=' + Date.now() : '';
    const responses = await Promise.all(['data.json', 'summary.json', 'workloads.json'].map(f => fetch(f + suffix, {cache: reload ? 'reload' : 'default'})));
    if (!responses[0].ok || !responses[1].ok) throw new Error('The published data files could not be loaded.');
    [DATA, SUM] = await Promise.all(responses.slice(0, 2).map(r => r.json()));
    WORK = responses[2].ok ? await responses[2].json() : {results: [], long_context: [], profiles: []};
    buildModels();
    restorePreferences();
    selected = new Set([...selected].filter(id => models.some(m => m.id === id)));
    applyTheme();
    const updated = WORK.updated_utc || DATA.archive_updated_utc;
    $('#header-meta').textContent = updated ? 'Updated ' + dayLabel(updated, {day: 'numeric', month: 'short', year: 'numeric'}) : 'Published snapshot';
    $('#footer-meta').textContent = `${models.length} model and engine setups measured on one NVIDIA DGX Spark. Speed does not measure answer quality.`;
    render();
    if (reload) notify('Published measurements reloaded');
  } catch (e) {
    content(`<div class="error"><h1 class="page-title">The measurements did not load.</h1><p class="muted">${esc(e.message)} Check your connection and try again.</p><button class="quiet" type="button" id="retry">Try again</button> <a href="https://github.com/LexiLominite/sparkbench">Open the source archive</a></div>`);
    $('#retry').onclick = () => load(true);
  }
}
$('#clear-selection').onclick = () => { selected.clear(); updateInPlace(); };
$('#theme-toggle').onclick = () => { state.theme = {system: 'light', light: 'dark', dark: 'system'}[state.theme]; applyTheme(); persistPreferences(); };
window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => Race.recolor());
document.addEventListener('visibilitychange', () => { if (document.hidden) Race.pause(); else if (Race.visible && Race.lanes.length && !Race.finished()) Race.loop(); });
window.addEventListener('hashchange', () => { if (DATA) { openPanels.clear(); hideTip(); render(); persistPreferences(); window.scrollTo({top: 0, behavior: 'instant'}); } });
load();
