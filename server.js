// latex-ai: local LaTeX editor server.
// Serves the web UI, manages project files, compiles with latexmk and
// proxies AI requests to a local Ollama instance.

import express from 'express';
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT || 4321);
const HOST = process.env.HOST || '127.0.0.1';
const WORKSPACE = path.resolve(process.env.LATEXAI_WORKSPACE || path.join(ROOT, 'projects'));
const OLLAMA_URL = (process.env.OLLAMA_URL || 'http://127.0.0.1:11434').replace(/\/$/, '');
const DEFAULT_MODEL = process.env.OLLAMA_MODEL || 'qwen2.5:3b';
const NUM_CTX = Number(process.env.OLLAMA_NUM_CTX || 8192);
const COMPILE_TIMEOUT_MS = Number(process.env.COMPILE_TIMEOUT_MS || 120000);
const LATEX_ENGINE = process.env.LATEX_ENGINE || 'pdf'; // pdf | xelatex | lualatex
const BUILD_DIR = '.build';

const TEXT_EXTENSIONS = new Set([
  '.tex', '.bib', '.sty', '.cls', '.bst', '.bbx', '.cbx', '.txt', '.md', '.cfg', '.csv', '.dat', '.tikz', '.ltx',
]);

const TEMPLATE = String.raw`\documentclass[11pt]{article}
\usepackage[T1]{fontenc}
\usepackage{amsmath,amssymb}
\usepackage{graphicx}
\usepackage{hyperref}

\title{Untitled}
\author{}
\date{\today}

\begin{document}
\maketitle

\section{Introduction}
Start writing here.

\end{document}
`;

// ---------- helpers ----------

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

function projectDir(name) {
  if (typeof name !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(name)) {
    throw new HttpError(400, 'Invalid project name (use letters, digits, ".", "_" or "-").');
  }
  return path.join(WORKSPACE, name);
}

async function resolveInProject(dir, rel) {
  if (typeof rel !== 'string' || rel.length === 0 || rel.length > 512) {
    throw new HttpError(400, 'Missing or invalid file path.');
  }
  const target = path.resolve(dir, rel);
  const relative = path.relative(dir, target);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new HttpError(400, 'Path is outside the project.');
  }
  if (relative.split(path.sep).some((seg) => seg.startsWith('.'))) {
    throw new HttpError(400, 'Hidden files and folders are not accessible.');
  }
  // Refuse symlinks that point outside the project.
  try {
    const real = await fs.realpath(target);
    const realDir = await fs.realpath(dir);
    if (real !== realDir && !real.startsWith(realDir + path.sep)) {
      throw new HttpError(400, 'Path is outside the project.');
    }
  } catch (err) {
    if (err instanceof HttpError) throw err;
    // Non-existent target is fine (e.g. creating a new file).
  }
  return target;
}

async function exists(p) {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

async function listFiles(dir) {
  const out = [];
  async function walk(abs, rel, depth) {
    if (depth > 8 || out.length > 2000) return;
    const entries = await fs.readdir(abs, { withFileTypes: true });
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const e of entries) {
      if (e.name.startsWith('.')) continue;
      const childRel = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) {
        out.push({ path: childRel, type: 'dir' });
        await walk(path.join(abs, e.name), childRel, depth + 1);
      } else if (e.isFile()) {
        const ext = path.extname(e.name).toLowerCase();
        out.push({ path: childRel, type: 'file', text: TEXT_EXTENSIONS.has(ext) });
      }
    }
  }
  await walk(dir, '', 0);
  return out;
}

// ---------- LaTeX compile ----------

const compileLocks = new Map();

function runProcess(cmd, args, opts, timeoutMs) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { ...opts, detached: true });
    let output = '';
    const collect = (d) => {
      output += d.toString();
      if (output.length > 400000) output = output.slice(-200000);
    };
    child.stdout.on('data', collect);
    child.stderr.on('data', collect);
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      try {
        process.kill(-child.pid, 'SIGKILL');
      } catch {
        child.kill('SIGKILL');
      }
    }, timeoutMs);
    child.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code, output, timedOut });
    });
  });
}

function parseLog(log, dir) {
  const lines = log.split(/\r?\n/);
  const errors = [];
  const warnings = [];
  const seen = new Set();
  const fileLine = /^(.*?\.(?:tex|sty|cls|bib|bbl|ltx|cfg|def|aux|toc)):(\d+): (.*)$/;

  const normFile = (f) => {
    let file = f.trim();
    if (file.startsWith('./')) file = file.slice(2);
    if (path.isAbsolute(file)) {
      const rel = path.relative(dir, file);
      if (!rel.startsWith('..')) file = rel;
    }
    return file;
  };

  // The few log lines after an error (e.g. "l.12 \foo"), stopping at the next message.
  const contextAfter = (i) => {
    const out = [];
    for (let j = i + 1; j < Math.min(lines.length, i + 6); j++) {
      const l = lines[j];
      if (!l.trim() || fileLine.test(l) || l.startsWith('! ') || /Warning:/.test(l)) break;
      out.push(l);
    }
    return out.join('\n');
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    let m = fileLine.exec(line);
    if (m) {
      const context = contextAfter(i);
      const entry = { file: normFile(m[1]), line: Number(m[2]), message: m[3].trim(), context };
      const key = `${entry.file}:${entry.line}:${entry.message}`;
      if (!seen.has(key)) {
        seen.add(key);
        errors.push(entry);
      }
      continue;
    }
    if (line.startsWith('! ')) {
      // Error without file:line prefix; look ahead for "l.<n>".
      let lineNo = null;
      for (let j = i + 1; j < Math.min(lines.length, i + 12); j++) {
        const lm = /^l\.(\d+)/.exec(lines[j]);
        if (lm) {
          lineNo = Number(lm[1]);
          break;
        }
      }
      const message = line.slice(2).trim();
      // "Emergency stop" just repeats that an earlier error was fatal.
      if (/^(Emergency stop|==> Fatal error)/.test(message) && errors.length) continue;
      const entry = { file: null, line: lineNo, message, context: contextAfter(i) };
      const key = `?:${entry.line}:${entry.message}`;
      if (!seen.has(key)) {
        seen.add(key);
        errors.push(entry);
      }
      continue;
    }
    m = /^((?:LaTeX|Package [\w-]+|Class [\w-]+|pdfTeX)) [Ww]arning: (.*)$/.exec(line);
    if (m) {
      let message = m[2];
      // Continuation lines of package warnings start with "(pkgname)".
      for (let j = i + 1; j < Math.min(lines.length, i + 6) && /^\([\w-]+\)\s/.test(lines[j]); j++) {
        message += ' ' + lines[j].replace(/^\([\w-]+\)\s+/, '');
      }
      const lm = /on input line (\d+)/.exec(message);
      warnings.push({ source: m[1], message: message.trim(), line: lm ? Number(lm[1]) : null });
    }
  }
  return { errors: errors.slice(0, 50), warnings: warnings.slice(0, 100) };
}

async function compileProject(dir, main) {
  const mainPath = await resolveInProject(dir, main);
  if (!(await exists(mainPath))) throw new HttpError(404, `Main file "${main}" not found.`);
  const outdir = path.join(dir, BUILD_DIR);
  await fs.mkdir(outdir, { recursive: true });

  const engineFlag = { pdf: '-pdf', xelatex: '-xelatex', lualatex: '-lualatex' }[LATEX_ENGINE] || '-pdf';
  const args = [engineFlag, '-interaction=nonstopmode', '-file-line-error', '-synctex=1', `-outdir=${BUILD_DIR}`, main];
  const env = {
    ...process.env,
    max_print_line: '10000', // stop TeX from wrapping log lines at 79 chars
    error_line: '254',
    half_error_line: '238',
    openout_any: 'p',
  };
  const started = Date.now();
  let result;
  try {
    result = await runProcess('latexmk', args, { cwd: dir, env }, COMPILE_TIMEOUT_MS);
  } catch (err) {
    if (err.code === 'ENOENT') {
      throw new HttpError(500, 'latexmk was not found. Install TeX Live: sudo apt install texlive-latex-extra latexmk');
    }
    throw err;
  }

  const base = main.replace(/\.tex$/i, '');
  const logPath = path.join(outdir, `${path.basename(base)}.log`);
  const pdfPath = path.join(outdir, `${path.basename(base)}.pdf`);
  let log = '';
  try {
    log = await fs.readFile(logPath, 'utf8');
  } catch {
    // no log produced
  }
  const { errors, warnings } = parseLog(log, dir);
  let pdfUpdated = false;
  try {
    const st = await fs.stat(pdfPath);
    pdfUpdated = st.mtimeMs >= started - 1000;
  } catch {
    // no pdf
  }
  const ok = result.code === 0 && !result.timedOut;
  return {
    ok,
    timedOut: result.timedOut,
    pdf: await exists(pdfPath),
    pdfUpdated,
    errors,
    warnings,
    output: ok && errors.length ? '' : result.output.split('\n').slice(-60).join('\n'),
    durationMs: Date.now() - started,
  };
}

// ---------- Ollama ----------

const SYSTEM_BASE =
  'You are an expert LaTeX and academic-writing assistant built into a local LaTeX editor. ' +
  'Be concise and accurate. When you show LaTeX code, put it in a ```latex fenced block. ' +
  'Never invent citations, references, data or results.';

function excerptAround(text, offset, maxChars) {
  if (typeof text !== 'string') return { text: '', truncated: false };
  if (text.length <= maxChars) return { text, truncated: false };
  const pos = Math.max(0, Math.min(text.length, Number(offset) || 0));
  let start = Math.max(0, pos - Math.floor(maxChars / 2));
  const end = Math.min(text.length, start + maxChars);
  start = Math.max(0, end - maxChars);
  return { text: text.slice(start, end), truncated: true };
}

function clip(s, n) {
  return typeof s === 'string' ? s.slice(0, n) : '';
}

async function ollamaFetch(pathname, body, signal) {
  let res;
  try {
    res = await fetch(`${OLLAMA_URL}${pathname}`, {
      method: body ? 'POST' : 'GET',
      headers: body ? { 'content-type': 'application/json' } : undefined,
      body: body ? JSON.stringify(body) : undefined,
      signal,
    });
  } catch (err) {
    if (err.name === 'AbortError') throw err;
    throw new HttpError(502, `Cannot reach Ollama at ${OLLAMA_URL}. Is it running? (ollama serve)`);
  }
  if (!res.ok) {
    let detail = await res.text().catch(() => '');
    try {
      detail = JSON.parse(detail).error || detail;
    } catch {
      // keep raw text
    }
    throw new HttpError(502, `Ollama error: ${detail || res.status}`);
  }
  return res;
}

// Streams the assistant's text to the client as plain text.
async function streamChat(req, res, model, messages, options = {}) {
  const ac = new AbortController();
  res.on('close', () => {
    if (!res.writableEnded) ac.abort();
  });
  const upstream = await ollamaFetch(
    '/api/chat',
    { model: model || DEFAULT_MODEL, messages, stream: true, options: { num_ctx: NUM_CTX, ...options } },
    ac.signal,
  );
  res.setHeader('content-type', 'text/plain; charset=utf-8');
  res.setHeader('cache-control', 'no-store');
  res.setHeader('x-accel-buffering', 'no');
  const decoder = new TextDecoder();
  let buf = '';
  try {
    for await (const chunk of upstream.body) {
      buf += decoder.decode(chunk, { stream: true });
      let nl;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line) continue;
        const obj = JSON.parse(line);
        if (obj.error) {
          res.write(`\n\n[Ollama error: ${obj.error}]`);
        } else if (obj.message?.content) {
          res.write(obj.message.content);
        }
      }
    }
  } catch (err) {
    if (err.name !== 'AbortError') res.write(`\n\n[stream error: ${err.message}]`);
  }
  res.end();
}

// ---------- app ----------

const app = express();
app.disable('x-powered-by');

// Only allow requests addressed to localhost (blocks DNS-rebinding attacks).
app.use((req, res, next) => {
  const host = (req.headers.host || '').replace(/:\d+$/, '');
  if (!['localhost', '127.0.0.1', '[::1]'].includes(host)) {
    return res.status(403).send('Forbidden host');
  }
  next();
});

// State-changing API calls must carry a custom header, which other websites
// cannot send cross-origin without a CORS preflight (that we never approve).
app.use('/api', (req, res, next) => {
  if (req.method !== 'GET' && req.headers['x-latex-ai'] !== '1') {
    return res.status(403).json({ error: 'Missing X-Latex-AI header' });
  }
  next();
});

app.use(express.static(path.join(ROOT, 'public')));
app.use('/vendor/monaco', express.static(path.join(ROOT, 'node_modules/monaco-editor/min')));
app.use('/vendor/pdfjs', express.static(path.join(ROOT, 'node_modules/pdfjs-dist')));

const json = express.json({ limit: '10mb' });

app.get('/api/config', (req, res) => {
  res.json({ defaultModel: DEFAULT_MODEL, ollamaUrl: OLLAMA_URL, engine: LATEX_ENGINE });
});

app.get(
  '/api/projects',
  wrap(async (req, res) => {
    await fs.mkdir(WORKSPACE, { recursive: true });
    const entries = await fs.readdir(WORKSPACE, { withFileTypes: true });
    res.json({
      projects: entries
        .filter((e) => e.isDirectory() && !e.name.startsWith('.'))
        .map((e) => e.name)
        .sort(),
    });
  }),
);

app.post(
  '/api/projects',
  json,
  wrap(async (req, res) => {
    const dir = projectDir(req.body?.name);
    if (await exists(dir)) throw new HttpError(409, 'A project with that name already exists.');
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, 'main.tex'), TEMPLATE);
    res.json({ ok: true });
  }),
);

app.get(
  '/api/projects/:project/files',
  wrap(async (req, res) => {
    const dir = projectDir(req.params.project);
    if (!(await exists(dir))) throw new HttpError(404, 'Project not found.');
    res.json({ files: await listFiles(dir) });
  }),
);

app.get(
  '/api/projects/:project/file',
  wrap(async (req, res) => {
    const dir = projectDir(req.params.project);
    const p = await resolveInProject(dir, req.query.path);
    if (!TEXT_EXTENSIONS.has(path.extname(p).toLowerCase())) {
      throw new HttpError(415, 'Only text files can be opened in the editor.');
    }
    try {
      res.type('text/plain').send(await fs.readFile(p, 'utf8'));
    } catch (err) {
      if (err.code === 'ENOENT') throw new HttpError(404, 'File not found.');
      throw err;
    }
  }),
);

app.put(
  '/api/projects/:project/file',
  express.text({ limit: '10mb', type: '*/*' }),
  wrap(async (req, res) => {
    const dir = projectDir(req.params.project);
    const p = await resolveInProject(dir, req.query.path);
    if (!TEXT_EXTENSIONS.has(path.extname(p).toLowerCase())) {
      throw new HttpError(415, `Unsupported text file type. Allowed: ${[...TEXT_EXTENSIONS].join(' ')}`);
    }
    await fs.mkdir(path.dirname(p), { recursive: true });
    await fs.writeFile(p, typeof req.body === 'string' ? req.body : '');
    res.json({ ok: true });
  }),
);

app.post(
  '/api/projects/:project/upload',
  express.raw({ limit: '50mb', type: '*/*' }),
  wrap(async (req, res) => {
    const dir = projectDir(req.params.project);
    const p = await resolveInProject(dir, req.query.path);
    await fs.mkdir(path.dirname(p), { recursive: true });
    await fs.writeFile(p, Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0));
    res.json({ ok: true });
  }),
);

app.delete(
  '/api/projects/:project/file',
  wrap(async (req, res) => {
    const dir = projectDir(req.params.project);
    const p = await resolveInProject(dir, req.query.path);
    const st = await fs.stat(p).catch(() => null);
    if (!st) throw new HttpError(404, 'File not found.');
    if (st.isDirectory()) await fs.rm(p, { recursive: true });
    else await fs.unlink(p);
    res.json({ ok: true });
  }),
);

app.post(
  '/api/projects/:project/compile',
  json,
  wrap(async (req, res) => {
    const name = req.params.project;
    const dir = projectDir(name);
    const main = req.body?.main || 'main.tex';
    // One compile per project at a time; later requests wait for the running one.
    while (compileLocks.has(name)) await compileLocks.get(name).catch(() => {});
    const job = compileProject(dir, main);
    compileLocks.set(name, job);
    try {
      res.json(await job);
    } finally {
      compileLocks.delete(name);
    }
  }),
);

app.get(
  '/api/projects/:project/pdf',
  wrap(async (req, res) => {
    const dir = projectDir(req.params.project);
    const main = typeof req.query.main === 'string' ? req.query.main : 'main.tex';
    await resolveInProject(dir, main);
    const pdf = path.join(dir, BUILD_DIR, `${path.basename(main.replace(/\.tex$/i, ''))}.pdf`);
    if (!(await exists(pdf))) throw new HttpError(404, 'No PDF yet. Compile first.');
    res.setHeader('cache-control', 'no-store');
    res.sendFile(pdf, { dotfiles: 'allow' }); // the PDF lives in the hidden .build folder
  }),
);

app.get(
  '/api/ai/models',
  wrap(async (req, res) => {
    const r = await ollamaFetch('/api/tags');
    const data = await r.json();
    res.json({ models: (data.models || []).map((m) => m.name), defaultModel: DEFAULT_MODEL });
  }),
);

// Free-form chat about the document.
app.post(
  '/api/ai/chat',
  json,
  wrap(async (req, res) => {
    const { model, messages = [], context } = req.body || {};
    let system = SYSTEM_BASE;
    if (context && typeof context.content === 'string') {
      const ex = excerptAround(context.content, context.cursorOffset, 12000);
      system +=
        `\n\nThe user is editing the file "${clip(context.file, 200)}"` +
        (ex.truncated ? ' (only an excerpt around the cursor is shown)' : '') +
        `:\n<<<FILE\n${ex.text}\nFILE>>>`;
      if (context.selection) {
        system += `\n\nThe user has selected this text:\n<<<SELECTION\n${clip(context.selection, 6000)}\nSELECTION>>>`;
      }
    }
    const history = (Array.isArray(messages) ? messages : [])
      .filter((m) => m && (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string')
      .slice(-12)
      .map((m) => ({ role: m.role, content: clip(m.content, 8000) }));
    if (!history.length) throw new HttpError(400, 'No message to send.');
    await streamChat(req, res, model, [{ role: 'system', content: system }, ...history]);
  }),
);

// Rewrite a selected passage according to an instruction.
app.post(
  '/api/ai/rewrite',
  json,
  wrap(async (req, res) => {
    const { model, instruction, selection, before = '', after = '' } = req.body || {};
    if (!selection || !instruction) throw new HttpError(400, 'Selection and instruction are required.');
    const system =
      'You rewrite one passage of a LaTeX document according to the user\'s instruction. ' +
      'Output ONLY the rewritten passage: no explanation, no preamble, no quotes, no code fences. ' +
      'Keep all LaTeX commands, math, \\label, \\ref and \\cite exactly as they are unless the instruction says otherwise. ' +
      'Keep the original language unless asked to translate. Never invent citations or facts.';
    const user =
      `Instruction: ${clip(instruction, 1000)}\n\n` +
      `Text just before the passage (context only, do not output it):\n<<<\n${clip(before, 1500)}\n>>>\n\n` +
      `PASSAGE TO REWRITE:\n<<<\n${clip(selection, 12000)}\n>>>\n\n` +
      `Text just after the passage (context only, do not output it):\n<<<\n${clip(after, 1500)}\n>>>\n\n` +
      'Now output only the rewritten passage.';
    await streamChat(
      req,
      res,
      model,
      [
        { role: 'system', content: system },
        { role: 'user', content: user },
      ],
      { temperature: 0.4 },
    );
  }),
);

// Small models often write LaTeX in JSON with single backslashes, so "\textbf"
// decodes as TAB + "extbf" and "\noindent" as NEWLINE + "oindent". Turn such
// control characters back into backslash commands when that is clearly meant.
const CONTROL_LETTER = { '\t': 't', '\n': 'n', '\r': 'r', '\f': 'f', '\b': 'b' };
const COMMON_COMMANDS = new Set(
  ('textbf textit texttt textsc textrm textsf textwidth textheight textcolor text tau theta times to today title ' +
    'tableofcontents tabular table thanks tilde tiny top tfrac tag the thispagestyle tikzpicture tikz ' +
    'noindent newline newpage newcommand newenvironment newtheorem nabla neq ne nu not notin nocite normalsize ' +
    'nolimits numberwithin node nonumber norm newblock ' +
    'begin bibliography bibliographystyle bibitem beta bf bigskip bm boldsymbol bar binom big bigg bullet ' +
    'frac footnote footnotesize flushleft forall figure fbox fontsize ' +
    'ref rho right rightarrow raggedright renewcommand rule rm rangle')
    .split(' '),
);

function repairLatexEscapes(text, documentText) {
  return text.replace(/([\t\n\r\f\b])([A-Za-z]+)/g, (match, ctrl, word) => {
    const command = CONTROL_LETTER[ctrl] + word;
    const always = ctrl === '\f' || ctrl === '\b' || ctrl === '\r'; // never legitimate before letters
    const known = COMMON_COMMANDS.has(command) || documentText.includes(`\\${command}`);
    return always || known ? `\\${command}` : match;
  });
}

// Suggest a fix for one compile error. Returns a line-range replacement.
app.post(
  '/api/ai/fix',
  json,
  wrap(async (req, res) => {
    const { model, error, content, file } = req.body || {};
    if (!error || typeof content !== 'string') throw new HttpError(400, 'Error and file content are required.');
    const lines = content.split('\n');
    const errLine = Math.min(Math.max(1, Number(error.line) || 1), lines.length);

    // Show the preamble (packages are a common fix) plus a window around the error.
    const docStart = lines.findIndex((l) => /\\begin\{document\}/.test(l));
    const preambleEnd = docStart >= 0 ? Math.min(docStart + 1, 80) : 0;
    const winStart = Math.max(1, errLine - 25);
    const winEnd = Math.min(lines.length, errLine + 15);
    const shown = new Set();
    for (let i = 1; i <= preambleEnd; i++) shown.add(i);
    for (let i = winStart; i <= winEnd; i++) shown.add(i);
    let snippet = '';
    let prev = 0;
    for (const n of [...shown].sort((a, b) => a - b)) {
      if (prev && n !== prev + 1) snippet += '...\n';
      snippet += `${n}: ${lines[n - 1]}\n`;
      prev = n;
    }

    const prompt =
      `A LaTeX compile failed in file "${clip(file, 200)}".\n` +
      `Error at line ${errLine}: ${clip(error.message, 500)}\n` +
      (error.context ? `Log context:\n${clip(error.context, 800)}\n` : '') +
      `\nNumbered lines of the file:\n${snippet}\n` +
      'Find the cause (it may be on an earlier line than reported, or a missing \\usepackage in the preamble). ' +
      'Reply as JSON with: "explanation" (one or two plain sentences), "start_line" and "end_line" ' +
      '(1-based, inclusive range of existing lines to replace), and "replacement" (the corrected text for exactly ' +
      'those lines, without line numbers). Change as little as possible. ' +
      'This is JSON: write every LaTeX backslash as a double backslash (\\\\textbf, not \\textbf).';

    const r = await ollamaFetch('/api/chat', {
      model: model || DEFAULT_MODEL,
      stream: false,
      format: {
        type: 'object',
        properties: {
          explanation: { type: 'string' },
          start_line: { type: 'integer' },
          end_line: { type: 'integer' },
          replacement: { type: 'string' },
        },
        required: ['explanation', 'start_line', 'end_line', 'replacement'],
      },
      options: { num_ctx: NUM_CTX, temperature: 0.1 },
      messages: [
        { role: 'system', content: SYSTEM_BASE },
        { role: 'user', content: prompt },
      ],
    });
    const data = await r.json();
    let fix;
    try {
      fix = JSON.parse(data.message?.content || '');
    } catch {
      throw new HttpError(502, 'The model did not return a valid fix. Try again or use a larger model.');
    }
    let start = Number(fix.start_line);
    let end = Number(fix.end_line);
    if (!Number.isInteger(start) || !Number.isInteger(end)) throw new HttpError(502, 'The model returned an invalid line range.');
    start = Math.min(Math.max(1, start), lines.length);
    end = Math.min(Math.max(start, end), lines.length);
    res.json({
      explanation: repairLatexEscapes(String(fix.explanation || ''), content),
      start_line: start,
      end_line: end,
      original: lines.slice(start - 1, end).join('\n'),
      replacement: repairLatexEscapes(String(fix.replacement ?? ''), content).replace(/\n$/, ''),
    });
  }),
);

app.use('/api', (req, res) => res.status(404).json({ error: 'Not found' }));

app.use((err, req, res, next) => {
  if (res.headersSent) return res.end();
  const status = err.status || (err.type === 'entity.too.large' ? 413 : 500);
  if (status >= 500 && !(err instanceof HttpError)) console.error(err);
  res.status(status).json({ error: err.message || 'Server error' });
});

await fs.mkdir(WORKSPACE, { recursive: true });
app.listen(PORT, HOST, () => {
  console.log(`latex-ai running at http://localhost:${PORT}`);
  console.log(`  projects: ${WORKSPACE}`);
  console.log(`  ollama:   ${OLLAMA_URL} (default model ${DEFAULT_MODEL})`);
});
