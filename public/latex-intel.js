// LaTeX "intelligence": project index (labels, citations, commands),
// autocomplete provider and document outline. No DOM access here.

// ---------- parsing helpers ----------

// Removes a LaTeX comment (unescaped %) from a line.
export function stripComment(line) {
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === '\\') i++;
    else if (c === '%') return line.slice(0, i);
  }
  return line;
}

// Reads a {...} group starting at text[i] === '{'. Returns { content, end } (end is after '}').
function readGroup(text, i) {
  if (text[i] !== '{') return null;
  let depth = 0;
  for (let j = i; j < text.length; j++) {
    const c = text[j];
    if (c === '\\') j++;
    else if (c === '{') depth++;
    else if (c === '}' && --depth === 0) return { content: text.slice(i + 1, j), end: j + 1 };
  }
  return { content: text.slice(i + 1), end: text.length };
}

// Turns a LaTeX title into readable plain text.
export function plainTitle(tex) {
  return tex
    .replace(/\\(?:label|index|footnote|cite\w*|ref|eqref)\*?\s*\{[^{}]*\}/g, '')
    .replace(/\\(?:emph|text[a-z]*|math[a-z]*|mbox|underline|ensuremath|boldsymbol)(?![a-zA-Z])\s*/g, '')
    .replace(/(?<!\\)[{}$]/g, '') // groups and math delimiters
    .replace(/(?<!\\)~/g, ' ')
    .replace(/\\(?:quad|qquad|[,;! ])/g, ' ')
    .replace(/\\([&%_#${}~])/g, '$1')
    .replace(/\\([a-zA-Z@]+)\*?/g, '$1') // \TeX -> TeX, \R -> R
    .replace(/\s+/g, ' ')
    .trim();
}

function bibField(body, name) {
  const re = new RegExp(`(?:^|[,\\s])${name}\\s*=\\s*`, 'i');
  const m = re.exec(body);
  if (!m) return '';
  let i = m.index + m[0].length;
  let value;
  if (body[i] === '{') value = readGroup(body, i).content;
  else if (body[i] === '"') {
    const end = body.indexOf('"', i + 1);
    value = body.slice(i + 1, end < 0 ? undefined : end);
  } else value = /^[^,}\s]*/.exec(body.slice(i))[0];
  return plainTitle(value);
}

const isTex = (p) => /\.(tex|ltx|tikz)$/i.test(p);
const isSty = (p) => /\.(sty|cls)$/i.test(p);

// Builds the project index from [{ path, content }].
export function buildIndex(files) {
  const labels = [];
  const cites = [];
  const commands = new Map();
  const envs = new Set();
  for (const { path, content } of files) {
    if (/\.bib$/i.test(path)) {
      const entry = /@(\w+)\s*[{(]\s*([^,\s{}()]+)\s*,/g;
      let m;
      while ((m = entry.exec(content))) {
        const type = m[1].toLowerCase();
        if (['string', 'comment', 'preamble'].includes(type)) continue;
        const next = content.indexOf('\n@', entry.lastIndex);
        const body = content.slice(entry.lastIndex, next < 0 ? undefined : next);
        cites.push({
          key: m[2],
          type,
          title: bibField(body, 'title'),
          author: bibField(body, 'author'),
          year: bibField(body, 'year') || bibField(body, 'date').slice(0, 4),
          file: path,
        });
      }
      continue;
    }
    if (!isTex(path) && !isSty(path)) continue;
    const lines = content.split('\n');
    lines.forEach((raw, idx) => {
      const line = stripComment(raw);
      if (!line.includes('\\')) return;
      let m;
      const labelRe = /\\label\{([^{}]+)\}/g;
      while ((m = labelRe.exec(line))) {
        labels.push({ name: m[1], file: path, line: idx + 1, context: raw.trim() });
      }
      const bibitemRe = /\\bibitem(?:\[[^\]]*\])?\{([^{}]+)\}/g;
      while ((m = bibitemRe.exec(line))) cites.push({ key: m[1], type: 'bibitem', title: '', author: '', year: '', file: path });
      const cmdRe = /\\(?:re)?newcommand\*?\s*\{?\\([a-zA-Z@]+)\}?\s*(?:\[(\d)\])?|\\(?:DeclareMathOperator|DeclareRobustCommand|providecommand)\*?\s*\{?\\([a-zA-Z@]+)\}?\s*(?:\[(\d)\])?|\\def\\([a-zA-Z@]+)/g;
      while ((m = cmdRe.exec(line))) {
        const name = m[1] || m[3] || m[5];
        const args = Number(m[2] || m[4] || 0);
        commands.set(name, { name, args, file: path, line: idx + 1 });
      }
      const envRe = /\\(?:re)?newenvironment\*?\{([^{}]+)\}|\\newtheorem\*?\{([^{}]+)\}/g;
      while ((m = envRe.exec(line))) envs.add(m[1] || m[2]);
    });
  }
  return { labels, cites, commands, envs };
}

// ---------- outline ----------

const SECTION_LEVELS = { part: 0, chapter: 1, section: 2, subsection: 3, subsubsection: 4, paragraph: 5 };

// Resolves \input{x} the way LaTeX does: relative to the main file's folder, ".tex" optional.
function resolveInclude(name, mainDir, exists) {
  const clean = name.trim().replace(/^\.\//, '');
  const base = mainDir ? `${mainDir}/${clean}` : clean;
  for (const cand of [base, `${base}.tex`, clean, `${clean}.tex`]) {
    const norm = normalizePath(cand);
    if (norm && exists(norm)) return norm;
  }
  return null;
}

function normalizePath(p) {
  const out = [];
  for (const seg of p.split('/')) {
    if (!seg || seg === '.') continue;
    if (seg === '..') {
      if (!out.length) return null;
      out.pop();
    } else out.push(seg);
  }
  return out.join('/');
}

// Returns [{ level, title, file, line, star }] following \input / \include from the main file.
export function buildOutline(main, getText, exists) {
  const items = [];
  const mainDir = main.includes('/') ? main.slice(0, main.lastIndexOf('/')) : '';
  const visited = new Set();
  const walk = (file, depth) => {
    if (depth > 12 || visited.has(file)) return;
    visited.add(file);
    const text = getText(file);
    if (text == null) return;
    const lines = text.split('\n');
    for (let i = 0; i < lines.length; i++) {
      const line = stripComment(lines[i]);
      if (!line.includes('\\')) continue;
      const re = /\\(part|chapter|section|subsection|subsubsection|paragraph)(\*?)\s*(?:\[[^\]]*\])?\s*(?=\{)|\\(input|include|subfile|import)\s*\{([^{}]+)\}(?:\{([^{}]+)\})?/g;
      let m;
      while ((m = re.exec(line))) {
        if (m[1]) {
          // The title may continue on the next lines.
          const rest = [line.slice(re.lastIndex), ...lines.slice(i + 1, i + 4).map(stripComment)].join('\n');
          const g = readGroup(rest, 0);
          items.push({ level: SECTION_LEVELS[m[1]], title: plainTitle(g?.content || '') || '(untitled)', file, line: i + 1, star: !!m[2] });
        } else {
          const target = m[3] === 'import' ? `${m[4]}/${m[5] || ''}` : m[4];
          const resolved = resolveInclude(target, mainDir, exists);
          if (resolved) walk(resolved, depth + 1);
        }
      }
    }
  };
  walk(main, 0);
  return items;
}

// ---------- autocomplete ----------

// [name, snippet (after the backslash), documentation]
const COMMANDS = [
  ['section', 'section{$1}', 'Section heading'],
  ['section*', 'section*{$1}', 'Unnumbered section'],
  ['subsection', 'subsection{$1}', 'Subsection heading'],
  ['subsubsection', 'subsubsection{$1}', 'Subsubsection heading'],
  ['chapter', 'chapter{$1}', 'Chapter heading (book/report)'],
  ['paragraph', 'paragraph{$1}', 'Paragraph heading'],
  ['label', 'label{$1}', 'Label for cross-references'],
  ['ref', 'ref{$1}', 'Reference to a label'],
  ['eqref', 'eqref{$1}', 'Reference to an equation (amsmath)'],
  ['autoref', 'autoref{$1}', 'Reference with automatic name (hyperref)'],
  ['cref', 'cref{$1}', 'Clever reference (cleveref)'],
  ['pageref', 'pageref{$1}', 'Page of a label'],
  ['cite', 'cite{$1}', 'Citation'],
  ['citep', 'citep{$1}', 'Parenthetical citation (natbib)'],
  ['citet', 'citet{$1}', 'Textual citation (natbib)'],
  ['parencite', 'parencite{$1}', 'Parenthetical citation (biblatex)'],
  ['textcite', 'textcite{$1}', 'Textual citation (biblatex)'],
  ['footnote', 'footnote{$1}', 'Footnote'],
  ['emph', 'emph{$1}', 'Emphasis'],
  ['textbf', 'textbf{$1}', 'Bold text'],
  ['textit', 'textit{$1}', 'Italic text'],
  ['texttt', 'texttt{$1}', 'Monospace text'],
  ['underline', 'underline{$1}', 'Underline'],
  ['url', 'url{$1}', 'URL (hyperref/url)'],
  ['href', 'href{$1}{$2}', 'Hyperlink'],
  ['includegraphics', 'includegraphics[width=${1:0.8}\\linewidth]{$2}', 'Insert an image (graphicx)'],
  ['input', 'input{$1}', 'Insert another .tex file'],
  ['include', 'include{$1}', 'Include a chapter file (new page)'],
  ['usepackage', 'usepackage{$1}', 'Load a package'],
  ['documentclass', 'documentclass{${1:article}}', 'Document class'],
  ['begin', 'begin{$1}\n\t$0\n\\end{$1}', 'Begin an environment'],
  ['item', 'item ', 'List item'],
  ['caption', 'caption{$1}', 'Caption of a figure or table'],
  ['centering', 'centering', 'Center the content'],
  ['title', 'title{$1}', 'Document title'],
  ['author', 'author{$1}', 'Document author'],
  ['date', 'date{$1}', 'Document date'],
  ['maketitle', 'maketitle', 'Print the title block'],
  ['tableofcontents', 'tableofcontents', 'Table of contents'],
  ['bibliography', 'bibliography{$1}', 'BibTeX bibliography file'],
  ['bibliographystyle', 'bibliographystyle{${1:plain}}', 'BibTeX style'],
  ['addbibresource', 'addbibresource{$1}', 'biblatex bibliography file'],
  ['printbibliography', 'printbibliography', 'Print the biblatex bibliography'],
  ['newcommand', 'newcommand{\\\\$1}{$2}', 'Define a command'],
  ['newpage', 'newpage', 'New page'],
  ['clearpage', 'clearpage', 'New page, flushing floats'],
  ['hline', 'hline', 'Horizontal line in a table'],
  ['toprule', 'toprule', 'Top rule (booktabs)'],
  ['midrule', 'midrule', 'Middle rule (booktabs)'],
  ['bottomrule', 'bottomrule', 'Bottom rule (booktabs)'],
  ['multicolumn', 'multicolumn{${1:2}}{${2:c}}{$3}', 'Cell spanning columns'],
  ['vspace', 'vspace{${1:1em}}', 'Vertical space'],
  ['hspace', 'hspace{${1:1em}}', 'Horizontal space'],
  ['noindent', 'noindent', 'No paragraph indent'],
  ['frac', 'frac{$1}{$2}', 'Fraction'],
  ['dfrac', 'dfrac{$1}{$2}', 'Display-style fraction'],
  ['sqrt', 'sqrt{$1}', 'Square root'],
  ['sum', 'sum_{${1:i=1}}^{${2:n}}', 'Sum'],
  ['prod', 'prod_{${1:i=1}}^{${2:n}}', 'Product'],
  ['int', 'int_{${1:a}}^{${2:b}}', 'Integral'],
  ['lim', 'lim_{${1:n \\to \\infty}}', 'Limit'],
  ['left(', 'left( $1 \\right)', 'Auto-sized parentheses'],
  ['left[', 'left[ $1 \\right]', 'Auto-sized brackets'],
  ['mathbb', 'mathbb{$1}', 'Blackboard bold (amssymb)'],
  ['mathcal', 'mathcal{$1}', 'Calligraphic letter'],
  ['mathbf', 'mathbf{$1}', 'Bold math'],
  ['mathrm', 'mathrm{$1}', 'Upright math'],
  ['text', 'text{$1}', 'Text inside math (amsmath)'],
  ['operatorname', 'operatorname{$1}', 'Operator name'],
  ['hat', 'hat{$1}', 'Hat accent'],
  ['bar', 'bar{$1}', 'Bar accent'],
  ['tilde', 'tilde{$1}', 'Tilde accent'],
  ['vec', 'vec{$1}', 'Vector arrow'],
  ['overline', 'overline{$1}', 'Overline'],
  ['partial', 'partial', '∂'],
  ['nabla', 'nabla', '∇'],
  ['infty', 'infty', '∞'],
  ['cdot', 'cdot', '·'],
  ['cdots', 'cdots', '⋯'],
  ['ldots', 'ldots', '…'],
  ['times', 'times', '×'],
  ['leq', 'leq', '≤'],
  ['geq', 'geq', '≥'],
  ['neq', 'neq', '≠'],
  ['approx', 'approx', '≈'],
  ['in', 'in', '∈'],
  ['subset', 'subset', '⊂'],
  ['subseteq', 'subseteq', '⊆'],
  ['forall', 'forall', '∀'],
  ['exists', 'exists', '∃'],
  ['rightarrow', 'rightarrow', '→'],
  ['Rightarrow', 'Rightarrow', '⇒'],
  ['mapsto', 'mapsto', '↦'],
  ['to', 'to', '→'],
  ...'alpha beta gamma delta epsilon varepsilon zeta eta theta vartheta iota kappa lambda mu nu xi pi rho sigma tau phi varphi chi psi omega Gamma Delta Theta Lambda Xi Pi Sigma Phi Psi Omega'
    .split(' ')
    .map((g) => [g, g, 'Greek letter']),
];

const ENVIRONMENTS = {
  figure: 'figure}[${1:htbp}]\n\t\\centering\n\t\\includegraphics[width=${2:0.8}\\linewidth]{$3}\n\t\\caption{$4}\n\t\\label{fig:$5}\n\\end{figure}',
  table: 'table}[${1:htbp}]\n\t\\centering\n\t\\caption{$2}\n\t\\label{tab:$3}\n\t\\begin{tabular}{${4:lc}}\n\t\t$0\n\t\\end{tabular}\n\\end{table}',
  tabular: 'tabular}{${1:lc}}\n\t$0\n\\end{tabular}',
  itemize: 'itemize}\n\t\\item $0\n\\end{itemize}',
  enumerate: 'enumerate}\n\t\\item $0\n\\end{enumerate}',
  description: 'description}\n\t\\item[$1] $0\n\\end{description}',
  equation: 'equation}\n\t$0\n\t\\label{eq:$1}\n\\end{equation}',
  'equation*': 'equation*}\n\t$0\n\\end{equation*}',
  align: 'align}\n\t$0\n\\end{align}',
  'align*': 'align*}\n\t$0\n\\end{align*}',
  gather: 'gather}\n\t$0\n\\end{gather}',
  cases: 'cases}\n\t$1 & \\text{if } $2 \\\\\\\\\n\t$3 & \\text{otherwise}\n\\end{cases}',
  matrix: 'matrix}\n\t$0\n\\end{matrix}',
  pmatrix: 'pmatrix}\n\t$0\n\\end{pmatrix}',
  bmatrix: 'bmatrix}\n\t$0\n\\end{bmatrix}',
  abstract: 'abstract}\n\t$0\n\\end{abstract}',
  document: 'document}\n\t$0\n\\end{document}',
  center: 'center}\n\t$0\n\\end{center}',
  quote: 'quote}\n\t$0\n\\end{quote}',
  verbatim: 'verbatim}\n$0\n\\end{verbatim}',
  minipage: 'minipage}{${1:0.48}\\linewidth}\n\t$0\n\\end{minipage}',
  theorem: 'theorem}\n\t$0\n\\end{theorem}',
  lemma: 'lemma}\n\t$0\n\\end{lemma}',
  proof: 'proof}\n\t$0\n\\end{proof}',
  definition: 'definition}\n\t$0\n\\end{definition}',
  frame: 'frame}{$1}\n\t$0\n\\end{frame}',
  tikzpicture: 'tikzpicture}\n\t$0\n\\end{tikzpicture}',
  algorithm: 'algorithm}\n\t\\caption{$1}\n\t$0\n\\end{algorithm}',
  lstlisting: 'lstlisting}\n$0\n\\end{lstlisting}',
  subfigure: 'subfigure}{${1:0.48}\\linewidth}\n\t\\centering\n\t\\includegraphics[width=\\linewidth]{$2}\n\t\\caption{$3}\n\\end{subfigure}',
};

const PACKAGES = (
  'amsmath amssymb amsthm mathtools graphicx hyperref cleveref xcolor geometry booktabs tabularx multirow ' +
  'siunitx natbib biblatex babel csquotes enumitem caption subcaption float tikz pgfplots listings minted ' +
  'algorithm algpseudocode algorithm2e fontenc inputenc lmodern microtype url xspace todonotes fancyhdr ' +
  'setspace titlesec appendix bm physics mathrsfs dsfont soul ulem lipsum'
).split(' ');

const REF_CMDS = /^(?:ref|eqref|autoref|cref|Cref|pageref|nameref|vref|labelcref|subref)$/;
const CITE_CMDS = /^(?:cite|citep|citet|citealp|citealt|citeauthor|citeyear|parencite|textcite|autocite|footcite|fullcite|smartcite|supercite|nocite|Cite|Citep|Citet|Parencite|Textcite|Autocite)$/;
const IMAGE_EXT = /\.(png|jpe?g|pdf|eps|svg)$/i;

// Snippet text needs "$", "}" and "\" escaped when inserted literally.
const snippetEscape = (s) => s.replace(/[\\$}]/g, '\\$&');

// Finds which \begin{...} is still open at the given offset.
function openEnvironment(text) {
  const stack = [];
  const re = /\\(begin|end)\s*\{([^{}]+)\}/g;
  let m;
  for (const raw of text.split('\n')) {
    const line = stripComment(raw);
    re.lastIndex = 0;
    while ((m = re.exec(line))) {
      if (m[1] === 'begin') stack.push(m[2]);
      else {
        const i = stack.lastIndexOf(m[2]);
        if (i >= 0) stack.length = i;
      }
    }
  }
  return stack.at(-1) || null;
}

// ctx: { files(): [{path,type}], sources(): [{path, content, version}], currentPath(): string }
export function registerLatexCompletion(monaco, ctx) {
  const K = monaco.languages.CompletionItemKind;
  const SNIPPET = monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet;

  let cache = { key: null, index: null };
  const getIndex = () => {
    const srcs = ctx.sources();
    // Rebuilt whenever any source changes (ctx supplies a version per file).
    const key = srcs.map((s) => `${s.path}:${s.version ?? s.content.length}`).join('|');
    if (cache.key !== key || !cache.index) cache = { key, index: buildIndex(srcs) };
    return cache.index;
  };

  const provider = {
    triggerCharacters: ['\\', '{', ','],
    provideCompletionItems(model, position) {
      const lineText = model.getLineContent(position.lineNumber);
      const before = lineText.slice(0, position.column - 1);
      const after = lineText.slice(position.column - 1);
      const ln = position.lineNumber;
      const suggestions = [];

      // Inside an argument: \cmd[...]{partial
      const arg = /\\([a-zA-Z]+)\*?(?:\s*\[[^\]]*\])*\s*\{([^{}]*)$/.exec(before);
      if (arg) {
        const [, cmd, typed] = arg;
        const multi = CITE_CMDS.test(cmd) || /^(?:cref|Cref|usepackage|bibliography|addbibresource)$/.test(cmd);
        const part = multi ? typed.slice(typed.lastIndexOf(',') + 1).replace(/^\s+/, '') : typed;
        const tailLen = /^[^{},\s]*/.exec(after)[0].length;
        const range = new monaco.Range(ln, position.column - part.length, ln, position.column + tailLen);
        const closeBrace = after[tailLen] === '}';
        const rangeWithBrace = new monaco.Range(ln, range.startColumn, ln, range.endColumn + (closeBrace ? 1 : 0));
        const index = () => getIndex();

        if (REF_CMDS.test(cmd)) {
          for (const l of index().labels) {
            suggestions.push({
              label: l.name,
              kind: K.Reference,
              detail: `${l.file}:${l.line}`,
              documentation: l.context,
              insertText: l.name,
              range,
            });
          }
        } else if (CITE_CMDS.test(cmd)) {
          for (const c of index().cites) {
            suggestions.push({
              label: { label: c.key, description: c.year },
              kind: K.Value,
              detail: c.title || c.type,
              documentation: [c.author, c.title, c.year].filter(Boolean).join(' — ') || c.file,
              filterText: `${c.key} ${c.title} ${c.author}`,
              insertText: c.key,
              range,
            });
          }
        } else if (cmd === 'begin') {
          const envs = new Set([...Object.keys(ENVIRONMENTS), ...index().envs]);
          for (const name of envs) {
            const body = ENVIRONMENTS[name] || `${snippetEscape(name)}}\n\t$0\n\\end{${snippetEscape(name)}}`;
            suggestions.push({
              label: name,
              kind: K.Module,
              detail: 'environment',
              insertText: body,
              insertTextRules: SNIPPET,
              range: rangeWithBrace,
            });
          }
        } else if (cmd === 'end') {
          const offset = model.getOffsetAt({ lineNumber: ln, column: range.startColumn });
          const open = openEnvironment(model.getValue().slice(0, Math.max(0, offset - 5)));
          const envs = new Set([...(open ? [open] : []), ...Object.keys(ENVIRONMENTS), ...index().envs]);
          for (const name of envs) {
            suggestions.push({
              label: name,
              kind: K.Module,
              detail: name === open ? 'closes the open environment' : 'environment',
              insertText: `${name}}`,
              range: rangeWithBrace,
              sortText: name === open ? '0' : `1${name}`,
              preselect: name === open,
            });
          }
        } else if (/^(?:includegraphics|input|include|subfile|bibliography|addbibresource|lstinputlisting)$/.test(cmd)) {
          const files = ctx.files().filter((f) => f.type === 'file');
          const want = {
            includegraphics: (p) => IMAGE_EXT.test(p),
            input: (p) => /\.(tex|tikz)$/i.test(p),
            include: (p) => /\.tex$/i.test(p),
            subfile: (p) => /\.tex$/i.test(p),
            bibliography: (p) => /\.bib$/i.test(p),
            addbibresource: (p) => /\.bib$/i.test(p),
            lstinputlisting: () => true,
          }[cmd];
          const current = ctx.currentPath() || '';
          for (const f of files) {
            if (!want(f.path) || f.path === current) continue;
            let text = f.path;
            if (cmd === 'include' || cmd === 'bibliography') text = text.replace(/\.(tex|bib)$/i, '');
            suggestions.push({ label: text, kind: K.File, insertText: text, range });
          }
        } else if (cmd === 'usepackage' || cmd === 'RequirePackage') {
          for (const p of PACKAGES) suggestions.push({ label: p, kind: K.Module, insertText: p, range });
        } else {
          return { suggestions: [] };
        }
        return { suggestions };
      }

      // A command name: \partial
      const cmdMatch = /\\([a-zA-Z@]*)$/.exec(before);
      if (cmdMatch) {
        const start = position.column - cmdMatch[0].length;
        const tailLen = /^[a-zA-Z@]*/.exec(after)[0].length;
        const range = new monaco.Range(ln, start, ln, position.column + tailLen);
        const seen = new Set();
        for (const [name, snippet, doc] of COMMANDS) {
          seen.add(name);
          suggestions.push({
            label: `\\${name}`,
            kind: K.Function,
            documentation: doc,
            insertText: `\\${snippet}`,
            insertTextRules: SNIPPET,
            range,
          });
        }
        for (const c of getIndex().commands.values()) {
          if (seen.has(c.name)) continue;
          const args = Array.from({ length: c.args }, (_, i) => `{$${i + 1}}`).join('');
          suggestions.push({
            label: `\\${c.name}`,
            kind: K.Variable,
            detail: `defined in ${c.file}:${c.line}`,
            insertText: `\\${c.name}${args}`,
            insertTextRules: SNIPPET,
            range,
          });
        }
        return { suggestions };
      }
      return { suggestions: [] };
    },
  };
  return monaco.languages.registerCompletionItemProvider('latex', provider);
}
