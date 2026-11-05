// latex-ai front end: Monaco editor + PDF.js preview + Ollama assistant.
import * as pdfjsLib from '/vendor/pdfjs/build/pdf.min.mjs';
import { buildOutline, registerLatexCompletion } from '/latex-intel.js';

pdfjsLib.GlobalWorkerOptions.workerSrc = '/vendor/pdfjs/build/pdf.worker.min.mjs';

const $ = (id) => document.getElementById(id);

const store = {
  get(key, fallback) {
    try {
      return localStorage.getItem(key) ?? fallback;
    } catch {
      return fallback;
    }
  },
  set(key, value) {
    try {
      localStorage.setItem(key, value);
    } catch {
      // storage unavailable: preferences just won't persist
    }
  },
};

const state = {
  project: null,
  files: [],
  current: null,
  main: 'main.tex',
  models: new Map(), // path -> monaco model
  viewStates: new Map(),
  dirty: new Set(),
  saveTimers: new Map(),
  compiling: false,
  compileAgain: false,
  lastErrors: [],
  chat: [],
  chatAbort: null,
  sources: new Map(), // path -> content on disk (.tex/.bib/...), for autocomplete & outline
  sourcesGen: 0,
  collapsed: new Set(), // collapsed folders in the file tree
  outline: [],
};

const SOURCE_RE = /\.(tex|bib|sty|cls|ltx|tikz)$/i;
const enc = encodeURIComponent;

let monaco;
let editor;

// ---------- API helpers ----------

async function api(method, url, body, { raw = false, signal } = {}) {
  const opts = { method, headers: {}, signal };
  if (method !== 'GET') opts.headers['X-Latex-AI'] = '1';
  if (body !== undefined) {
    if (typeof body === 'string') {
      opts.body = body;
      opts.headers['content-type'] = 'text/plain; charset=utf-8';
    } else if (body instanceof Blob) {
      opts.body = body;
      opts.headers['content-type'] = 'application/octet-stream';
    } else {
      opts.body = JSON.stringify(body);
      opts.headers['content-type'] = 'application/json';
    }
  }
  const res = await fetch(url, opts);
  if (!res.ok) {
    let msg = `${res.status} ${res.statusText}`;
    try {
      msg = (await res.json()).error || msg;
    } catch {
      // not JSON
    }
    throw new Error(msg);
  }
  if (raw) return res;
  const type = res.headers.get('content-type') || '';
  return type.includes('json') ? res.json() : res.text();
}

const P = () => `/api/projects/${encodeURIComponent(state.project)}`;
const qp = (p) => `path=${encodeURIComponent(p)}`;

async function streamText(url, body, signal, onChunk) {
  const res = await api('POST', url, body, { raw: true, signal });
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    onChunk(decoder.decode(value, { stream: true }));
  }
}

function escapeHtml(s) {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

function setStatus(id, text, kind = '') {
  const el = $(id);
  el.textContent = text;
  el.className = `status ${kind}`;
  el.title = text;
}

const currentModelName = () => $('modelSelect').value || undefined;

// ---------- Monaco setup ----------

function registerLanguages() {
  monaco.languages.register({ id: 'latex', extensions: ['.tex', '.sty', '.cls', '.ltx', '.tikz'] });
  monaco.languages.setMonarchTokensProvider('latex', {
    tokenizer: {
      root: [
        [/%.*$/, 'comment'],
        [/(\\(?:begin|end))(\s*)(\{)([^}]*)(\})/, ['keyword', '', 'delimiter.curly', 'type', 'delimiter.curly']],
        [/\\(?:section|subsection|subsubsection|chapter|part|paragraph)\*?/, 'keyword.control'],
        [/\\[a-zA-Z@]+\*?/, 'keyword'],
        [/\\./, 'keyword'],
        [/\$\$/, { token: 'string', next: '@displaymath' }],
        [/\$/, { token: 'string', next: '@math' }],
        [/\\\[/, { token: 'string', next: '@bracketmath' }],
        [/[{}]/, 'delimiter.curly'],
        [/[[\]]/, 'delimiter.square'],
        [/[&~^_]/, 'operator'],
      ],
      math: [
        [/\\\$/, 'string'],
        [/\$/, { token: 'string', next: '@pop' }],
        [/%.*$/, 'comment'],
        [/\\[a-zA-Z@]+/, 'string.escape'],
        [/[^\\$%]+/, 'string'],
        [/./, 'string'],
      ],
      displaymath: [
        [/\$\$/, { token: 'string', next: '@pop' }],
        [/\\[a-zA-Z@]+/, 'string.escape'],
        [/[^\\$]+/, 'string'],
        [/./, 'string'],
      ],
      bracketmath: [
        [/\\\]/, { token: 'string', next: '@pop' }],
        [/\\[a-zA-Z@]+/, 'string.escape'],
        [/[^\\]+/, 'string'],
        [/./, 'string'],
      ],
    },
  });
  monaco.languages.setLanguageConfiguration('latex', {
    comments: { lineComment: '%' },
    brackets: [['{', '}'], ['[', ']'], ['(', ')']],
    autoClosingPairs: [
      { open: '{', close: '}' },
      { open: '[', close: ']' },
      { open: '(', close: ')' },
    ],
    surroundingPairs: [
      { open: '{', close: '}' },
      { open: '[', close: ']' },
      { open: '(', close: ')' },
      { open: '$', close: '$' },
    ],
  });

  monaco.languages.register({ id: 'bibtex', extensions: ['.bib'] });
  monaco.languages.setMonarchTokensProvider('bibtex', {
    tokenizer: {
      root: [
        [/%.*$/, 'comment'],
        [/@\w+/, 'keyword'],
        [/\w+(?=\s*=)/, 'attribute.name'],
        [/[{}]/, 'delimiter.curly'],
        [/"[^"]*"/, 'string'],
      ],
    },
  });
}

function languageFor(path) {
  const ext = path.slice(path.lastIndexOf('.')).toLowerCase();
  if (['.tex', '.sty', '.cls', '.ltx', '.tikz'].includes(ext)) return 'latex';
  if (ext === '.bib') return 'bibtex';
  if (ext === '.md') return 'markdown';
  return 'plaintext';
}

const darkQuery = window.matchMedia('(prefers-color-scheme: dark)');
const themeName = () => (darkQuery.matches ? 'vs-dark' : 'vs');

function createEditor() {
  editor = monaco.editor.create($('editor'), {
    model: null,
    theme: themeName(),
    automaticLayout: true,
    wordWrap: 'on',
    minimap: { enabled: false },
    fontSize: 14,
    scrollBeyondLastLine: false,
    unicodeHighlight: { ambiguousCharacters: false, invisibleCharacters: false },
  });
  darkQuery.addEventListener('change', () => monaco.editor.setTheme(themeName()));

  editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => compile());
  editor.addAction({
    id: 'latexai.rewrite',
    label: 'AI: Rewrite selection…',
    keybindings: [monaco.KeyMod.CtrlCmd | monaco.KeyMod.Alt | monaco.KeyCode.KeyE],
    contextMenuGroupId: '0_ai',
    contextMenuOrder: 1,
    run: () => openRewritePrompt(),
  });
  editor.addAction({
    id: 'latexai.syncToPdf',
    label: 'Show in PDF (SyncTeX)',
    keybindings: [monaco.KeyMod.CtrlCmd | monaco.KeyMod.Alt | monaco.KeyCode.KeyJ],
    contextMenuGroupId: '1_sync',
    contextMenuOrder: 1,
    run: () => syncToPdf(),
  });
  editor.addAction({
    id: 'latexai.ask',
    label: 'AI: Ask the assistant about this',
    contextMenuGroupId: '0_ai',
    contextMenuOrder: 2,
    run: () => {
      switchTab('chat');
      $('includeDoc').checked = true;
      const input = $('chatInput');
      if (!input.value) input.value = editor.getSelection().isEmpty() ? '' : 'Explain the selected text.';
      input.focus();
    },
  });

  registerLatexCompletion(monaco, {
    files: () => state.files,
    sources: sourceEntries,
    currentPath: () => state.current,
  });
  let cursorTimer;
  editor.onDidChangeCursorPosition(() => {
    clearTimeout(cursorTimer);
    cursorTimer = setTimeout(updateOutlineActive, 150);
  });
}

// ---------- project sources (autocomplete + outline) ----------

function sourceEntries() {
  const out = [];
  for (const [path, model] of state.models) {
    if (SOURCE_RE.test(path)) out.push({ path, content: model.getValue(), version: `m${state.sourcesGen}.${model.getVersionId()}` });
  }
  for (const [path, content] of state.sources) {
    if (!state.models.has(path)) out.push({ path, content, version: `d${state.sourcesGen}` });
  }
  return out;
}

function sourceText(path) {
  const model = state.models.get(path);
  return model ? model.getValue() : (state.sources.get(path) ?? null);
}

async function loadSources() {
  try {
    const { files } = await api('GET', `${P()}/sources`);
    state.sources = new Map(files.map((f) => [f.path, f.content]));
  } catch {
    state.sources = new Map();
  }
  state.sourcesGen++;
  renderOutline();
}

// ---------- outline ----------

let outlineTimer;
function scheduleOutline() {
  clearTimeout(outlineTimer);
  outlineTimer = setTimeout(renderOutline, 400);
}

function renderOutline() {
  const ul = $('outline');
  if (!state.project) return ul.replaceChildren();
  const items = buildOutline(state.main, sourceText, (p) => state.models.has(p) || state.sources.has(p));
  state.outline = items;
  if (!items.length) {
    const li = document.createElement('li');
    li.className = 'empty-note';
    li.textContent = `No sections in ${state.main}`;
    return ul.replaceChildren(li);
  }
  const minLevel = Math.min(...items.map((i) => i.level));
  const counters = [];
  const nodes = items.map((item) => {
    const rel = item.level - minLevel;
    const li = document.createElement('li');
    li.className = `lvl-${item.level}`;
    li.style.paddingLeft = `${10 + rel * 12}px`;
    li.title = `${item.file}:${item.line}`;
    // Numbering like LaTeX's defaults: parts and paragraphs are not numbered here.
    if (!item.star && item.level > 0 && item.level < 5) {
      counters[rel] = (counters[rel] || 0) + 1;
      counters.length = rel + 1;
      for (let k = 0; k < rel; k++) counters[k] ||= 0;
      const num = document.createElement('span');
      num.className = 'num';
      num.textContent = counters.join('.');
      li.append(num);
    }
    li.append(item.title);
    li.addEventListener('click', () => goTo(item.file, item.line).catch((e) => alert(e.message)));
    return li;
  });
  ul.replaceChildren(...nodes);
  updateOutlineActive();
}

function updateOutlineActive() {
  const pos = editor?.getPosition();
  let active = -1;
  if (pos && state.current) {
    state.outline.forEach((item, i) => {
      if (item.file === state.current && item.line <= pos.lineNumber) active = i;
    });
  }
  const nodes = $('outline').children;
  for (let i = 0; i < nodes.length; i++) nodes[i].classList.toggle('active', i === active);
}

// ---------- projects & files ----------

async function loadProjects(select) {
  const { projects } = await api('GET', '/api/projects');
  if (!projects.length) {
    await api('POST', '/api/projects', { name: 'example' });
    projects.push('example');
  }
  const sel = $('projectSelect');
  sel.replaceChildren(...projects.map((p) => new Option(p, p)));
  const wanted = select || store.get('latexai.project');
  const name = projects.includes(wanted) ? wanted : projects[0];
  sel.value = name;
  await openProject(name);
}

async function openProject(name) {
  if (state.project) await saveAll().catch(() => {});
  for (const model of state.models.values()) model.dispose();
  state.models.clear();
  state.viewStates.clear();
  state.dirty.clear();
  state.current = null;
  state.lastErrors = [];
  state.collapsed.clear();
  state.sources = new Map();
  state.outline = [];
  editor.setModel(null);
  $('currentFile').textContent = 'No file open';
  state.project = name;
  store.set('latexai.project', name);
  state.chat = [];
  renderChat();
  $('problems').classList.add('hidden');
  setStatus('compileStatus', '');
  clearPdf();

  await refreshFiles();
  const texFiles = state.files.filter((f) => f.type === 'file' && f.path.endsWith('.tex'));
  const savedMain = store.get(`latexai.main.${name}`);
  state.main = texFiles.some((f) => f.path === savedMain)
    ? savedMain
    : texFiles.some((f) => f.path === 'main.tex')
      ? 'main.tex'
      : texFiles[0]?.path || 'main.tex';
  renderMainSelect();
  renderOutline();
  if (texFiles.length) {
    await openFile(state.main);
    renderPdf();
  }
}

async function refreshFiles() {
  const { files } = await api('GET', `${P()}/files`);
  state.files = files;
  renderTree();
  renderMainSelect();
  await loadSources();
}

function renderMainSelect() {
  const sel = $('mainSelect');
  const tex = state.files.filter((f) => f.type === 'file' && f.path.endsWith('.tex')).map((f) => f.path);
  sel.replaceChildren(...tex.map((p) => new Option(p, p)));
  if (!tex.includes(state.main) && tex.length) state.main = tex.includes('main.tex') ? 'main.tex' : tex[0];
  if (tex.includes(state.main)) sel.value = state.main;
}

const parentDir = (p) => (p.includes('/') ? p.slice(0, p.lastIndexOf('/')) : '');
const isUnder = (p, dir) => p === dir || p.startsWith(`${dir}/`);

function renderTree() {
  const ul = $('fileTree');
  const items = [];
  for (const f of state.files) {
    if ([...state.collapsed].some((c) => isInside(f.path, c))) continue;
    const li = document.createElement('li');
    const depth = f.path.split('/').length - 1;
    li.style.paddingLeft = `${6 + depth * 14}px`;
    li.dataset.path = f.path;
    li.draggable = true;
    li.title = f.path;
    const caret = document.createElement('span');
    caret.className = 'caret';
    const name = document.createElement('span');
    name.className = 'name';
    const base = f.path.split('/').pop();
    const actions = document.createElement('span');
    actions.className = 'row-actions';
    const action = (label, title, fn) => {
      const b = document.createElement('button');
      b.textContent = label;
      b.title = title;
      b.addEventListener('click', (ev) => {
        ev.stopPropagation();
        fn();
      });
      actions.append(b);
    };

    if (f.type === 'dir') {
      li.classList.add('dir');
      const collapsed = state.collapsed.has(f.path);
      caret.textContent = collapsed ? '▸' : '▾';
      name.textContent = `${base}/`;
      li.addEventListener('click', () => {
        if (collapsed) state.collapsed.delete(f.path);
        else state.collapsed.add(f.path);
        renderTree();
      });
      action('+', `New file in ${f.path}/`, () => newFile(f.path));
    } else {
      name.textContent = base;
      if (state.dirty.has(f.path)) name.classList.add('dirty');
      if (!f.text) li.classList.add('binary');
      if (f.path === state.current) li.classList.add('active');
      li.addEventListener('click', () => {
        if (f.text) openFile(f.path).catch((e) => alert(e.message));
        else alert(`"${f.path}" is not a text file. It's available to LaTeX (e.g. \\includegraphics{${f.path}}).`);
      });
    }
    action('✎', `Rename or move ${f.path}`, () => renameEntry(f));
    action('×', `Delete ${f.path}`, () => deleteFile(f.path, f.type === 'dir'));
    li.addEventListener('dragstart', (e) => {
      e.dataTransfer.setData('application/x-latexai-path', f.path);
      e.dataTransfer.effectAllowed = 'move';
    });
    li.append(caret, name, actions);
    items.push(li);
  }
  ul.replaceChildren(...items);
}

// True when p is strictly inside folder dir.
function isInside(p, dir) {
  return p.startsWith(`${dir}/`);
}

async function openFile(path) {
  if (state.current === path && editor.getModel()) return;
  let model = state.models.get(path);
  if (!model) {
    const text = await api('GET', `${P()}/file?${qp(path)}`);
    model = monaco.editor.createModel(
      text,
      languageFor(path),
      monaco.Uri.from({ scheme: 'file', path: `/${state.project}/${path}` }),
    );
    model.onDidChangeContent(() => markDirty(path));
    state.models.set(path, model);
    applyMarkers(path, model);
  }
  if (state.current) state.viewStates.set(state.current, editor.saveViewState());
  editor.setModel(model);
  const vs = state.viewStates.get(path);
  if (vs) editor.restoreViewState(vs);
  state.current = path;
  $('currentFile').textContent = path;
  renderTree();
  editor.focus();
}

function markDirty(path) {
  const wasDirty = state.dirty.has(path);
  state.dirty.add(path);
  setStatus('saveStatus', 'Unsaved changes');
  if (!wasDirty) renderTree();
  if (SOURCE_RE.test(path)) scheduleOutline();
  clearTimeout(state.saveTimers.get(path));
  state.saveTimers.set(
    path,
    setTimeout(() => saveFile(path).catch(() => {}), 1000),
  );
}

async function saveFile(path) {
  clearTimeout(state.saveTimers.get(path));
  state.saveTimers.delete(path);
  const model = state.models.get(path);
  if (!model || !state.dirty.has(path)) return;
  state.dirty.delete(path);
  try {
    await api('PUT', `${P()}/file?${qp(path)}`, model.getValue());
    setStatus('saveStatus', state.dirty.size ? 'Unsaved changes' : 'Saved', state.dirty.size ? '' : 'ok');
  } catch (e) {
    state.dirty.add(path);
    setStatus('saveStatus', `Save failed: ${e.message}`, 'error');
    throw e;
  } finally {
    renderTree();
  }
}

async function saveAll() {
  for (const path of [...state.dirty]) await saveFile(path);
}

async function newFile(dir = '') {
  const input = prompt('New file name (e.g. sections/intro.tex or refs.bib):', dir ? `${dir}/` : '');
  const path = input?.trim();
  if (!path || path.endsWith('/')) return;
  if (state.files.some((f) => f.path === path)) return alert(`"${path}" already exists.`);
  try {
    await api('PUT', `${P()}/file?${qp(path)}`, '');
    state.collapsed.delete(parentDir(path));
    await refreshFiles();
    await openFile(path);
  } catch (e) {
    alert(e.message);
  }
}

async function newFolder() {
  const path = prompt('New folder name (e.g. figures or chapters/part1):')?.trim().replace(/\/+$/, '');
  if (!path) return;
  try {
    await api('POST', `${P()}/folder`, { path });
    await refreshFiles();
  } catch (e) {
    alert(e.message);
  }
}

async function uploadFiles(fileList, dir = '') {
  for (const file of fileList) {
    const path = dir ? `${dir}/${file.name}` : file.name;
    try {
      await api('POST', `${P()}/upload?${qp(path)}`, file);
    } catch (e) {
      alert(`${file.name}: ${e.message}`);
    }
  }
  if (dir) state.collapsed.delete(dir);
  await refreshFiles();
}

// Drops the editor models of a file, or of everything inside a folder.
function forgetModels(path) {
  for (const [p, model] of [...state.models]) {
    if (!isUnder(p, path)) continue;
    if (editor.getModel() === model) editor.setModel(null);
    model.dispose();
    state.models.delete(p);
    state.viewStates.delete(p);
    state.dirty.delete(p);
    clearTimeout(state.saveTimers.get(p));
    state.saveTimers.delete(p);
    if (state.current === p) {
      state.current = null;
      $('currentFile').textContent = 'No file open';
    }
  }
}

async function deleteFile(path, isDir = false) {
  const what = isDir ? `the folder "${path}" and everything in it` : `"${path}"`;
  if (!confirm(`Delete ${what}? This cannot be undone.`)) return;
  try {
    await api('DELETE', `${P()}/file?${qp(path)}`);
    forgetModels(path);
    state.collapsed.delete(path);
    await refreshFiles();
  } catch (e) {
    alert(e.message);
  }
}

async function renameEntry(f) {
  const to = prompt(`Rename or move "${f.path}" to (use / for folders):`, f.path)?.trim().replace(/\/+$/, '');
  if (!to || to === f.path) return;
  await movePath(f.path, to).catch((e) => alert(e.message));
}

// Renames/moves a file or folder and keeps open editors, main file and folds in sync.
async function movePath(from, to) {
  if (to === from || isUnder(to, from)) return;
  await saveAll();
  await api('POST', `${P()}/move`, { from, to });
  const remap = (p) => (isUnder(p, from) ? to + p.slice(from.length) : null);
  let reopen = null;
  for (const [p, model] of [...state.models]) {
    const np = remap(p);
    if (!np) continue;
    const view = state.current === p ? editor.saveViewState() : state.viewStates.get(p);
    if (state.current === p) {
      reopen = np;
      state.current = null;
    }
    if (editor.getModel() === model) editor.setModel(null);
    model.dispose();
    state.models.delete(p);
    state.viewStates.delete(p);
    if (view) state.viewStates.set(np, view);
  }
  if (remap(state.main)) {
    state.main = remap(state.main);
    store.set(`latexai.main.${state.project}`, state.main);
    clearPdf();
  }
  state.collapsed = new Set([...state.collapsed].map((c) => remap(c) || c));
  state.collapsed.delete(parentDir(to));
  await refreshFiles();
  if (reopen) await openFile(reopen);
  else if (!state.current) $('currentFile').textContent = 'No file open';
  if (!pdf.doc) renderPdf();
}

async function newProject() {
  const name = prompt('Project name (letters, digits, ".", "_" or "-"):');
  if (!name) return;
  try {
    await api('POST', '/api/projects', { name: name.trim() });
    await loadProjects(name.trim());
  } catch (e) {
    alert(e.message);
  }
}

async function renameProject() {
  const old = state.project;
  const name = prompt(`Rename project "${old}" to:`, old)?.trim();
  if (!name || name === old) return;
  try {
    await saveAll();
    await api('PATCH', `/api/projects/${enc(old)}`, { name });
    const main = store.get(`latexai.main.${old}`);
    if (main) store.set(`latexai.main.${name}`, main);
    state.project = null; // nothing left to save in the old location
    await loadProjects(name);
  } catch (e) {
    alert(e.message);
  }
}

async function deleteProject() {
  const name = state.project;
  const typed = prompt(
    `Delete the project "${name}" and ALL its files? This cannot be undone.\n\nType the project name to confirm:`,
  );
  if (typed === null) return;
  if (typed.trim() !== name) return alert('The name did not match. Nothing was deleted.');
  try {
    for (const t of state.saveTimers.values()) clearTimeout(t);
    state.saveTimers.clear();
    state.dirty.clear();
    await api('DELETE', `/api/projects/${enc(name)}`);
    state.project = null;
    store.set('latexai.project', '');
    await loadProjects();
  } catch (e) {
    alert(e.message);
  }
}

async function downloadZip() {
  await saveAll().catch(() => {});
  const a = document.createElement('a');
  a.href = `${P()}/download`;
  a.download = `${state.project}.zip`;
  a.click();
}

// ---------- compile & problems ----------

async function compile() {
  if (!state.project) return;
  if (state.compiling) {
    state.compileAgain = true;
    return;
  }
  state.compiling = true;
  $('compileBtn').disabled = true;
  setStatus('compileStatus', 'Compiling…');
  try {
    await saveAll();
    const r = await api('POST', `${P()}/compile`, { main: state.main });
    showProblems(r);
    if (r.pdf) await renderPdf();
    const secs = (r.durationMs / 1000).toFixed(1);
    const warn = r.warnings.length ? ` · ${r.warnings.length} warning${r.warnings.length === 1 ? '' : 's'}` : '';
    if (r.timedOut) setStatus('compileStatus', 'Compile timed out', 'error');
    else if (r.errors.length) {
      setStatus('compileStatus', `${r.errors.length} error${r.errors.length === 1 ? '' : 's'}${warn}`, 'error');
    } else if (!r.ok) setStatus('compileStatus', 'Compile failed (see log)', 'error');
    else setStatus('compileStatus', `Compiled in ${secs}s${warn}`, 'ok');
  } catch (e) {
    setStatus('compileStatus', e.message, 'error');
  } finally {
    state.compiling = false;
    $('compileBtn').disabled = false;
    if (state.compileAgain) {
      state.compileAgain = false;
      compile();
    }
  }
}

function applyMarkers(path, model) {
  const markers = state.lastErrors
    .filter((e) => (e.file || state.main) === path && e.line)
    .map((e) => ({
      severity: monaco.MarkerSeverity.Error,
      message: e.message,
      startLineNumber: e.line,
      endLineNumber: e.line,
      startColumn: 1,
      endColumn: model.getLineMaxColumn(Math.min(e.line, model.getLineCount())),
    }));
  monaco.editor.setModelMarkers(model, 'latex', markers);
}

function showProblems(r) {
  state.lastErrors = r.errors;
  for (const [path, model] of state.models) applyMarkers(path, model);

  const list = $('problemList');
  const textFiles = new Set(state.files.filter((f) => f.text).map((f) => f.path));
  const items = [];

  for (const err of r.errors) {
    const file = err.file || state.main;
    const li = document.createElement('li');
    li.className = 'error';
    const loc = document.createElement('span');
    loc.className = 'loc';
    loc.textContent = err.line ? `${file}:${err.line}` : file;
    if (textFiles.has(file) && err.line) loc.addEventListener('click', () => goTo(file, err.line));
    const msg = document.createElement('div');
    msg.className = 'msg';
    msg.textContent = err.message;
    if (err.context) {
      const pre = document.createElement('pre');
      pre.textContent = err.context;
      msg.append(pre);
    }
    li.append(loc, msg);
    if (textFiles.has(file) && err.line) {
      const fix = document.createElement('button');
      fix.textContent = 'Fix with AI';
      fix.addEventListener('click', () => fixError({ ...err, file }));
      li.append(fix);
    }
    items.push(li);
  }

  if (!r.ok && !r.errors.length && r.output) {
    const li = document.createElement('li');
    li.className = 'error';
    const msg = document.createElement('div');
    msg.className = 'msg';
    msg.textContent = r.timedOut ? 'Compilation timed out. Last output:' : 'Compilation failed. Last output:';
    const pre = document.createElement('pre');
    pre.textContent = r.output;
    msg.append(pre);
    li.append(msg);
    items.push(li);
  }

  for (const w of r.warnings.slice(0, 40)) {
    const li = document.createElement('li');
    li.className = 'warning';
    const loc = document.createElement('span');
    loc.className = 'loc';
    loc.textContent = w.line ? `line ${w.line}` : w.source;
    const msg = document.createElement('div');
    msg.className = 'msg';
    msg.textContent = w.message;
    li.append(loc, msg);
    items.push(li);
  }

  list.replaceChildren(...items);
  $('problemsTitle').textContent =
    `Problems: ${r.errors.length} error${r.errors.length === 1 ? '' : 's'}, ` +
    `${r.warnings.length} warning${r.warnings.length === 1 ? '' : 's'}`;
  const hasErrors = r.errors.length || !r.ok;
  $('problems').classList.toggle('hidden', !items.length || (!hasErrors && $('problems').dataset.closed === '1'));
  if (hasErrors) delete $('problems').dataset.closed;
}

async function goTo(path, line) {
  await openFile(path);
  editor.revealLineInCenter(line);
  editor.setPosition({ lineNumber: line, column: 1 });
  editor.focus();
}

// ---------- PDF preview ----------

const pdf = {
  doc: null,
  fit: store.get('latexai.zoomFit', '1') === '1',
  scale: Number(store.get('latexai.zoom', '1.2')) || 1.2,
  seq: 0,
};

function clearPdf() {
  pdf.seq++;
  if (pdf.doc) pdf.doc.destroy();
  pdf.doc = null;
  $('pdfContainer').innerHTML = '<p class="empty">Compile to see the PDF.</p>';
  $('downloadPdfBtn').classList.add('hidden');
}

async function renderPdf() {
  const base = `${P()}/pdf?main=${enc(state.main)}`;
  const url = `${base}&t=${Date.now()}`;
  let doc;
  try {
    doc = await pdfjsLib.getDocument({ url, isEvalSupported: false }).promise;
  } catch {
    return; // no PDF yet
  }
  const old = pdf.doc;
  pdf.doc = doc;
  const link = $('downloadPdfBtn');
  link.href = base;
  link.download = `${state.main.split('/').pop().replace(/\.tex$/i, '')}.pdf`;
  link.classList.remove('hidden');
  await drawPdf();
  if (old) old.destroy();
}

async function drawPdf() {
  const doc = pdf.doc;
  if (!doc) return;
  const seq = ++pdf.seq;
  const container = $('pdfContainer');
  const wrap = document.createElement('div');
  const dpr = window.devicePixelRatio || 1;
  const first = await doc.getPage(1);
  const baseWidth = first.getViewport({ scale: 1 }).width;
  const scale = pdf.fit ? Math.max(0.3, (container.clientWidth - 30) / baseWidth) : pdf.scale;
  for (let i = 1; i <= doc.numPages; i++) {
    const page = i === 1 ? first : await doc.getPage(i);
    const vp = page.getViewport({ scale });
    const canvas = document.createElement('canvas');
    canvas.width = Math.floor(vp.width * dpr);
    canvas.height = Math.floor(vp.height * dpr);
    canvas.style.width = `${vp.width}px`;
    canvas.style.height = `${vp.height}px`;
    const pageEl = document.createElement('div');
    pageEl.className = 'page';
    pageEl.dataset.page = String(i);
    pageEl.style.width = `${vp.width}px`;
    pageEl.style.height = `${vp.height}px`;
    pageEl.append(canvas);
    wrap.append(pageEl);
    await page.render({
      canvasContext: canvas.getContext('2d'),
      viewport: vp,
      transform: dpr !== 1 ? [dpr, 0, 0, dpr, 0, 0] : null,
    }).promise;
    if (seq !== pdf.seq) return; // a newer render started
  }
  const top = container.scrollTop;
  container.replaceChildren(wrap);
  container.scrollTop = top;
  pdf.scale = scale;
  pdf.shownScale = scale; // scale of the pages currently on screen (for SyncTeX)
}

// ---------- SyncTeX ----------

// Editor cursor -> highlighted spot in the PDF.
async function syncToPdf() {
  if (!editor.getModel() || !state.current) return;
  if (!pdf.doc) return setStatus('compileStatus', 'Compile first to use "Show in PDF"', 'error');
  const pos = editor.getPosition();
  let boxes;
  try {
    ({ boxes } = await api(
      'GET',
      `${P()}/synctex/view?main=${enc(state.main)}&file=${enc(state.current)}&line=${pos.lineNumber}&column=${pos.column}`,
    ));
  } catch (e) {
    return setStatus('compileStatus', e.message, 'error');
  }
  if (!boxes.length) {
    return setStatus('compileStatus', 'This line is not in the PDF (try recompiling)', 'error');
  }
  if ($('pdfPane').classList.contains('hidden')) {
    switchTab('pdf');
    await drawPdf();
  }
  const pageNo = boxes[0].page;
  const container = $('pdfContainer');
  const pageEl = container.querySelector(`.page[data-page="${pageNo}"]`);
  if (!pageEl) return;
  const s = pdf.shownScale;
  const onPage = boxes.filter((b) => b.page === pageNo);
  for (const b of onPage) {
    const mark = document.createElement('div');
    mark.className = 'sync-mark';
    mark.style.left = `${b.h * s}px`;
    mark.style.top = `${(b.v - b.height) * s}px`;
    mark.style.width = `${Math.max(b.width * s, 8)}px`;
    mark.style.height = `${Math.max(b.height * s, 6)}px`;
    pageEl.append(mark);
    setTimeout(() => mark.remove(), 2600);
  }
  const top = Math.min(...onPage.map((b) => b.v - b.height)) * s;
  const pageTop = pageEl.getBoundingClientRect().top - container.getBoundingClientRect().top + container.scrollTop;
  container.scrollTo({ top: Math.max(0, pageTop + top - container.clientHeight / 3), behavior: 'smooth' });
}

// Double-click in the PDF -> matching source line.
async function syncFromPdf(e) {
  const pageEl = e.target.closest('.page');
  if (!pageEl || !pdf.doc) return;
  const r = pageEl.getBoundingClientRect();
  const x = (e.clientX - r.left) / pdf.shownScale;
  const y = (e.clientY - r.top) / pdf.shownScale;
  try {
    const res = await api(
      'GET',
      `${P()}/synctex/edit?main=${enc(state.main)}&page=${pageEl.dataset.page}&x=${x.toFixed(2)}&y=${y.toFixed(2)}`,
    );
    const f = res.file && state.files.find((ff) => ff.path === res.file);
    if (!f?.text) return setStatus('compileStatus', 'No source line found for that spot', 'error');
    await goTo(res.file, res.line);
    const deco = editor.createDecorationsCollection([
      { range: new monaco.Range(res.line, 1, res.line, 1), options: { isWholeLine: true, className: 'sync-line' } },
    ]);
    setTimeout(() => deco.clear(), 1500);
  } catch (err) {
    setStatus('compileStatus', err.message, 'error');
  }
}

function zoom(kind) {
  if (kind === 'fit') pdf.fit = true;
  else {
    pdf.fit = false;
    pdf.scale = Math.min(4, Math.max(0.3, pdf.scale * (kind === 'in' ? 1.15 : 1 / 1.15)));
  }
  store.set('latexai.zoomFit', pdf.fit ? '1' : '0');
  store.set('latexai.zoom', String(pdf.scale));
  drawPdf();
}

// ---------- tabs ----------

function switchTab(name) {
  for (const b of document.querySelectorAll('.tabs > button[data-tab]')) {
    b.classList.toggle('active', b.dataset.tab === name);
  }
  $('pdfPane').classList.toggle('hidden', name !== 'pdf');
  $('chatPane').classList.toggle('hidden', name !== 'chat');
  $('pdfControls').classList.toggle('hidden', name !== 'pdf');
  if (name === 'pdf' && pdf.fit) drawPdf();
}

// ---------- models ----------

let modelRetry = null;

async function loadModels() {
  const sel = $('modelSelect');
  clearTimeout(modelRetry);
  try {
    const { models, defaultModel } = await api('GET', '/api/ai/models');
    if (!models.length) {
      sel.replaceChildren(new Option(`No models (run: ollama pull ${defaultModel})`, ''));
      modelRetry = setTimeout(loadModels, 15000);
      return;
    }
    sel.replaceChildren(...models.map((m) => new Option(m, m)));
    const saved = store.get('latexai.model');
    const match = (name) => models.find((m) => m === name || m === `${name}:latest`);
    sel.value = match(saved) || match(defaultModel) || models[0];
    sel.title = '';
  } catch (e) {
    sel.replaceChildren(new Option('Ollama not running', ''));
    sel.title = e.message;
    modelRetry = setTimeout(loadModels, 15000);
  }
}

// ---------- diff review dialog ----------

const diff = { editor: null, original: null, modified: null, onAccept: null, abort: null, pending: null };

function openDiff({ title, info = '', original = '', modified = '', status = '' }) {
  if (!diff.editor) {
    diff.editor = monaco.editor.createDiffEditor($('diffEditor'), {
      automaticLayout: true,
      wordWrap: 'on',
      diffWordWrap: 'on',
      originalEditable: false,
      minimap: { enabled: false },
      scrollBeyondLastLine: false,
      renderOverviewRuler: false,
    });
  }
  diff.original?.dispose();
  diff.modified?.dispose();
  diff.original = monaco.editor.createModel(original, 'latex');
  diff.modified = monaco.editor.createModel(modified, 'latex');
  diff.editor.setModel({ original: diff.original, modified: diff.modified });
  diff.onAccept = null;
  $('diffTitle').textContent = title;
  $('diffInfo').textContent = info;
  setStatus('diffStatus', status);
  $('diffAccept').disabled = true;
  $('diffOverlay').classList.remove('hidden');
}

function setDiffModified(text) {
  diff.pending = text;
  requestAnimationFrame(() => {
    if (diff.pending !== null && diff.modified) {
      diff.modified.setValue(diff.pending);
      diff.pending = null;
    }
  });
}

function closeDiff() {
  diff.abort?.abort();
  diff.abort = null;
  diff.onAccept = null;
  $('diffOverlay').classList.add('hidden');
  editor.focus();
}

function applyEdit(model, range, text) {
  if (editor.getModel() === model) {
    editor.pushUndoStop();
    editor.executeEdits('latex-ai', [{ range, text, forceMoveMarkers: true }]);
    editor.pushUndoStop();
  } else {
    model.pushStackElement();
    model.pushEditOperations([], [{ range, text }], () => null);
    model.pushStackElement();
  }
}

// ---------- AI: rewrite selection ----------

let rewriteTarget = null;

function paragraphRange(model, line) {
  let start = line;
  let end = line;
  while (start > 1 && model.getLineContent(start - 1).trim() !== '') start--;
  while (end < model.getLineCount() && model.getLineContent(end + 1).trim() !== '') end++;
  return new monaco.Range(start, 1, end, model.getLineMaxColumn(end));
}

function openRewritePrompt() {
  const model = editor.getModel();
  if (!model) return;
  let range = editor.getSelection();
  if (range.isEmpty()) range = paragraphRange(model, range.startLineNumber);
  if (!model.getValueInRange(range).trim()) {
    alert('Select some text to rewrite first.');
    return;
  }
  editor.setSelection(range);
  rewriteTarget = { model, range };
  $('promptInput').value = '';
  $('promptOverlay').classList.remove('hidden');
  $('promptInput').focus();
}

function cleanModelOutput(text) {
  return text
    .replace(/^\s*```[\w-]*\s*\n/, '')
    .replace(/\n?```\s*$/, '')
    .replace(/^<<<\s*\n?/, '')
    .replace(/\n?>>>\s*$/, '');
}

async function runRewrite(instruction) {
  const { model, range } = rewriteTarget;
  const selection = model.getValueInRange(range);
  const full = model.getValue();
  const startOff = model.getOffsetAt(range.getStartPosition());
  const endOff = model.getOffsetAt(range.getEndPosition());
  openDiff({ title: `Rewrite: ${instruction}`, original: selection, status: 'Generating…' });
  const ac = new AbortController();
  diff.abort = ac;
  let out = '';
  try {
    await streamText(
      '/api/ai/rewrite',
      {
        model: currentModelName(),
        instruction,
        selection,
        before: full.slice(Math.max(0, startOff - 1500), startOff),
        after: full.slice(endOff, endOff + 1500),
      },
      ac.signal,
      (chunk) => {
        out += chunk;
        setDiffModified(cleanModelOutput(out));
      },
    );
    // Keep the original's leading/trailing whitespace so paragraphs stay separated.
    const lead = selection.match(/^\s*/)[0];
    const trail = selection.match(/\s*$/)[0];
    const result = lead + cleanModelOutput(out).trim() + trail;
    diff.pending = null;
    diff.modified.setValue(result);
    diff.abort = null;
    diff.onAccept = (text) => applyEdit(model, range, text);
    $('diffAccept').disabled = false;
    setStatus('diffStatus', 'Review the change', 'ok');
  } catch (e) {
    if (e.name === 'AbortError') return;
    setStatus('diffStatus', e.message, 'error');
  }
}

// ---------- AI: fix compile error ----------

async function fixError(err) {
  await openFile(err.file);
  const model = state.models.get(err.file);
  openDiff({
    title: `Fix: ${err.message}`,
    info: `Asking the model about ${err.file}:${err.line}… (this can take a while on CPU)`,
    status: 'Thinking…',
  });
  const ac = new AbortController();
  diff.abort = ac;
  const version = model.getAlternativeVersionId();
  try {
    const fix = await api(
      'POST',
      '/api/ai/fix',
      { model: currentModelName(), file: err.file, error: err, content: model.getValue() },
      { signal: ac.signal },
    );
    diff.abort = null;
    diff.original.setValue(fix.original);
    diff.modified.setValue(fix.replacement);
    $('diffInfo').textContent = `${fix.explanation}  (lines ${fix.start_line}–${fix.end_line})`;
    diff.onAccept = (text) => {
      if (model.getAlternativeVersionId() !== version) {
        alert('The file changed while the fix was being generated. Please run "Fix with AI" again.');
        return;
      }
      const range = new monaco.Range(fix.start_line, 1, fix.end_line, model.getLineMaxColumn(fix.end_line));
      applyEdit(model, range, text);
      compile();
    };
    $('diffAccept').disabled = false;
    setStatus('diffStatus', 'Review the fix', 'ok');
  } catch (e) {
    if (e.name === 'AbortError') return;
    setStatus('diffStatus', e.message, 'error');
    $('diffInfo').textContent = '';
  }
}

// ---------- AI: chat ----------

let chatRenderQueued = false;

function scheduleChatRender() {
  if (chatRenderQueued) return;
  chatRenderQueued = true;
  requestAnimationFrame(() => {
    chatRenderQueued = false;
    renderChat();
  });
}

function renderInline(text) {
  return escapeHtml(text)
    .replace(/`([^`\n]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>');
}

function renderMarkdownInto(el, text) {
  const fence = /```([\w-]*)[ \t]*\n?([\s\S]*?)(?:```|$)/g;
  let last = 0;
  let m;
  const addText = (t) => {
    for (const para of t.split(/\n{2,}/)) {
      if (!para.trim()) continue;
      const p = document.createElement('p');
      p.innerHTML = renderInline(para.trim()).replace(/\n/g, '<br>');
      el.append(p);
    }
  };
  while ((m = fence.exec(text))) {
    addText(text.slice(last, m.index));
    const code = m[2].replace(/\n$/, '');
    const block = document.createElement('div');
    block.className = 'codeblock';
    const pre = document.createElement('pre');
    const codeEl = document.createElement('code');
    codeEl.textContent = code;
    pre.append(codeEl);
    const actions = document.createElement('div');
    actions.className = 'code-actions';
    const insert = document.createElement('button');
    insert.textContent = 'Insert at cursor';
    insert.addEventListener('click', () => {
      if (!editor.getModel()) return;
      editor.pushUndoStop();
      editor.executeEdits('latex-ai', [{ range: editor.getSelection(), text: code, forceMoveMarkers: true }]);
      editor.pushUndoStop();
      editor.focus();
    });
    const copy = document.createElement('button');
    copy.textContent = 'Copy';
    copy.addEventListener('click', async () => {
      try {
        await navigator.clipboard.writeText(code);
        copy.textContent = 'Copied';
        setTimeout(() => (copy.textContent = 'Copy'), 1200);
      } catch {
        copy.textContent = 'Copy failed';
      }
    });
    actions.append(insert, copy);
    block.append(pre, actions);
    el.append(block);
    last = fence.lastIndex;
    if (m[0].length === 0) break;
  }
  addText(text.slice(last));
}

function renderChat() {
  const box = $('chatMessages');
  const nearBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 60;
  if (!state.chat.length) {
    box.innerHTML =
      '<p class="empty">Ask about your document: “Suggest a better title”, “Explain this equation”, ' +
      '“Write an outline for the related-work section”…</p>';
    return;
  }
  const nodes = state.chat.map((msg) => {
    const div = document.createElement('div');
    div.className = `msg ${msg.role}${msg.error ? ' error' : ''}`;
    if (msg.role === 'user' || msg.error) div.textContent = msg.content;
    else renderMarkdownInto(div, msg.content);
    if (msg.pending) div.classList.add('cursor-blink');
    return div;
  });
  box.replaceChildren(...nodes);
  if (nearBottom) box.scrollTop = box.scrollHeight;
}

async function sendChat(text) {
  const model = editor.getModel();
  let context = null;
  if ($('includeDoc').checked && model) {
    const sel = editor.getSelection();
    context = {
      file: state.current,
      content: model.getValue(),
      cursorOffset: model.getOffsetAt(editor.getPosition()),
      selection: sel && !sel.isEmpty() ? model.getValueInRange(sel) : '',
    };
  }
  state.chat.push({ role: 'user', content: text });
  const messages = state.chat.filter((m) => !m.error).map(({ role, content }) => ({ role, content }));
  const reply = { role: 'assistant', content: '', pending: true };
  state.chat.push(reply);
  renderChat();
  $('chatMessages').scrollTop = $('chatMessages').scrollHeight;

  const ac = new AbortController();
  state.chatAbort = ac;
  $('stopBtn').hidden = false;
  $('sendBtn').disabled = true;
  try {
    await streamText('/api/ai/chat', { model: currentModelName(), messages, context }, ac.signal, (chunk) => {
      reply.content += chunk;
      scheduleChatRender();
    });
  } catch (e) {
    if (e.name !== 'AbortError') {
      reply.error = true;
      reply.content = reply.content ? `${reply.content}\n\n[${e.message}]` : e.message;
    }
  } finally {
    reply.pending = false;
    if (!reply.content) reply.content = '(stopped)';
    state.chatAbort = null;
    $('stopBtn').hidden = true;
    $('sendBtn').disabled = false;
    renderChat();
  }
}

// ---------- wiring ----------

function bindUI() {
  $('projectSelect').addEventListener('change', (e) => openProject(e.target.value).catch((err) => alert(err.message)));
  $('newProjectBtn').addEventListener('click', newProject);
  $('renameProjectBtn').addEventListener('click', renameProject);
  $('deleteProjectBtn').addEventListener('click', deleteProject);
  $('mainSelect').addEventListener('change', (e) => {
    state.main = e.target.value;
    store.set(`latexai.main.${state.project}`, state.main);
    clearPdf();
    renderPdf();
    renderOutline();
  });
  $('newFolderBtn').addEventListener('click', newFolder);
  $('downloadZipBtn').addEventListener('click', downloadZip);
  $('syncBtn').addEventListener('click', syncToPdf);
  $('pdfContainer').addEventListener('dblclick', syncFromPdf);

  // file tree drag & drop: move files between folders, or upload from the computer
  const tree = $('fileTree');
  let dropEl = null;
  const setDrop = (el) => {
    if (dropEl === el) return;
    dropEl?.classList.remove('drop-target');
    dropEl = el;
    el?.classList.add('drop-target');
  };
  const dropDir = (e) => {
    const li = e.target.closest?.('li[data-path]');
    if (!li) return '';
    const f = state.files.find((x) => x.path === li.dataset.path);
    return !f ? '' : f.type === 'dir' ? f.path : parentDir(f.path);
  };
  const ours = (e) => e.dataTransfer.types.includes('application/x-latexai-path');
  tree.addEventListener('dragover', (e) => {
    if (!ours(e) && !e.dataTransfer.types.includes('Files')) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = ours(e) ? 'move' : 'copy';
    const dir = dropDir(e);
    setDrop(dir ? tree.querySelector(`li[data-path="${CSS.escape(dir)}"]`) : tree);
  });
  tree.addEventListener('dragleave', (e) => {
    if (!tree.contains(e.relatedTarget)) setDrop(null);
  });
  tree.addEventListener('drop', async (e) => {
    e.preventDefault();
    setDrop(null);
    const dir = dropDir(e);
    const from = e.dataTransfer.getData('application/x-latexai-path');
    if (from) {
      const to = dir ? `${dir}/${from.split('/').pop()}` : from.split('/').pop();
      if (to !== from && !isUnder(dir, from)) await movePath(from, to).catch((err) => alert(err.message));
    } else if (e.dataTransfer.files.length) {
      await uploadFiles([...e.dataTransfer.files], dir);
    }
  });
  // Files dropped anywhere else must not make the browser navigate away.
  window.addEventListener('dragover', (e) => e.dataTransfer.types.includes('Files') && e.preventDefault());
  window.addEventListener('drop', (e) => e.dataTransfer.types.includes('Files') && e.preventDefault());
  $('compileBtn').addEventListener('click', compile);
  $('rewriteBtn').addEventListener('click', openRewritePrompt);
  $('modelSelect').addEventListener('change', (e) => store.set('latexai.model', e.target.value));
  $('newFileBtn').addEventListener('click', newFile);
  $('uploadBtn').addEventListener('click', () => $('uploadInput').click());
  $('uploadInput').addEventListener('change', (e) => {
    uploadFiles([...e.target.files]);
    e.target.value = '';
  });
  $('problemsClose').addEventListener('click', () => {
    $('problems').classList.add('hidden');
    $('problems').dataset.closed = '1';
  });

  for (const b of document.querySelectorAll('.tabs > button[data-tab]')) {
    b.addEventListener('click', () => switchTab(b.dataset.tab));
  }
  $('zoomIn').addEventListener('click', () => zoom('in'));
  $('zoomOut').addEventListener('click', () => zoom('out'));
  $('zoomFit').addEventListener('click', () => zoom('fit'));
  let resizeTimer;
  new ResizeObserver(() => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => pdf.fit && !$('pdfPane').classList.contains('hidden') && drawPdf(), 200);
  }).observe($('pdfContainer'));

  // rewrite prompt
  $('promptForm').addEventListener('submit', (e) => {
    e.preventDefault();
    const instr = $('promptInput').value.trim();
    if (!instr) return;
    $('promptOverlay').classList.add('hidden');
    runRewrite(instr);
  });
  for (const chip of document.querySelectorAll('.chips button')) {
    chip.addEventListener('click', () => {
      $('promptOverlay').classList.add('hidden');
      runRewrite(chip.dataset.instr);
    });
  }
  $('promptCancel').addEventListener('click', () => {
    $('promptOverlay').classList.add('hidden');
    editor.focus();
  });

  // diff dialog
  $('diffAccept').addEventListener('click', () => {
    const accept = diff.onAccept;
    const text = diff.modified.getValue();
    closeDiff();
    accept?.(text);
  });
  $('diffReject').addEventListener('click', closeDiff);

  // chat
  $('chatForm').addEventListener('submit', (e) => {
    e.preventDefault();
    const text = $('chatInput').value.trim();
    if (!text || state.chatAbort) return;
    $('chatInput').value = '';
    sendChat(text);
  });
  $('chatInput').addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      $('chatForm').requestSubmit();
    }
  });
  $('stopBtn').addEventListener('click', () => state.chatAbort?.abort());
  $('clearChat').addEventListener('click', () => {
    state.chatAbort?.abort();
    state.chat = [];
    renderChat();
  });

  window.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
      e.preventDefault();
      compile();
    }
    if (e.key === 'Escape') {
      if (!$('promptOverlay').classList.contains('hidden')) $('promptOverlay').classList.add('hidden');
      else if (!$('diffOverlay').classList.contains('hidden')) closeDiff();
    }
  });
  window.addEventListener('beforeunload', (e) => {
    if (state.dirty.size) {
      saveAll().catch(() => {});
      e.preventDefault();
    }
  });
}

async function init() {
  registerLanguages();
  createEditor();
  bindUI();
  loadModels();
  await loadProjects();
}

// Monaco cancels internal timers when switching files; those rejections are harmless.
window.addEventListener('unhandledrejection', (e) => {
  if (e.reason?.name === 'Canceled' || e.reason?.message === 'Canceled') e.preventDefault();
});

window.require.config({ paths: { vs: '/vendor/monaco/vs' } });
window.require(['vs/editor/editor.main'], () => {
  monaco = window.monaco;
  init().catch((e) => {
    console.error(e);
    alert(`Failed to start: ${e.message}`);
  });
});
