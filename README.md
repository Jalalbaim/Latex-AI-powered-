# latex-ai

A local, Overleaf-style LaTeX editor with live PDF preview and an AI writing
assistant powered by [Ollama](https://ollama.com). Everything runs on your own
machine: no account, no cloud, no API keys.

## Features

- **Monaco editor** (the editor from VS Code) with LaTeX/BibTeX highlighting and auto-save
- **Compile** with `latexmk` (Ctrl+S) and preview the PDF (rendered with PDF.js)
- **Clickable errors and warnings** that jump to the offending line
- **Assistant** tab: chat about the current file, optionally including your selection
- **AI rewrite** (Ctrl+Alt+E or right-click): rewrite the selection (or current
  paragraph) by instruction, review the change as a diff, then accept or reject
- **Fix with AI** on each compile error: the model proposes a minimal fix, shown as a diff
- Multiple projects, file upload (images, `.bib`, `.sty`, ...)

---

## Requirements

| Component | Version | Why it is needed |
|---|---|---|
| **Node.js** | 20 or newer (tested with 24) | Runs the web server (`server.js`) |
| **npm** | comes with Node.js | Installs JavaScript dependencies |
| **TeX Live** + **latexmk** | any recent | Compiles `.tex` to PDF |
| **biber** / BibTeX | optional | Only if your documents use a bibliography |
| **Ollama** | any recent | Runs the local AI model |
| An Ollama **model** | e.g. `qwen2.5:3b` | The model that answers / rewrites |
| **Git** | any | To clone the repository |

Hardware: any machine works for LaTeX. For the AI, a 3B model runs on CPU with
~4 GB of free RAM; larger models (7B+) are much faster with a GPU.

The instructions below are for **Ubuntu / Debian**. Notes for macOS and Windows follow.

---

## Installation (step by step)

### 1. Install Git and Node.js

```bash
sudo apt update
sudo apt install -y git curl

# Node.js 20+ (the version in Ubuntu's own repositories may be too old).
# Option A: NodeSource
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt install -y nodejs

# Option B: nvm (no sudo needed)
# curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.1/install.sh | bash
# source ~/.bashrc && nvm install 22

node -v    # must print v20 or higher
npm -v
```

### 2. Install LaTeX (TeX Live + latexmk)

Recommended set of packages (~1 GB):

```bash
sudo apt install -y texlive-latex-recommended texlive-latex-extra \
                    texlive-fonts-recommended texlive-bibtex-extra \
                    latexmk biber
```

Optional extras:

```bash
sudo apt install -y texlive-xetex texlive-luatex   # if you want xelatex / lualatex
sudo apt install -y texlive-science                # siunitx, algorithm2e, ...
sudo apt install -y texlive-lang-french            # or other texlive-lang-* packages
# Or everything (~5 GB):  sudo apt install -y texlive-full
```

Check: `latexmk -v` and `pdflatex --version` should both print a version.

### 3. Install Ollama and download a model

```bash
curl -fsSL https://ollama.com/install.sh | sh
ollama pull qwen2.5:3b        # default model (~2 GB), fine on CPU
```

Other models you can try (pick one in the UI or with `OLLAMA_MODEL`):

| Model | Size | Notes |
|---|---|---|
| `qwen2.5:3b` | ~2 GB | Default, good balance on CPU |
| `llama3.2:3b` | ~2 GB | Alternative small model |
| `qwen2.5:7b` | ~4.7 GB | Better quality, needs more RAM / a GPU |

Check that Ollama is running: `curl http://127.0.0.1:11434/api/tags`
(on Linux the installer starts it as a service; otherwise run `ollama serve`).

### 4. Get the code and install dependencies

```bash
git clone https://github.com/Jalalbaim/Latex-AI-powered-.git latex-ai
cd latex-ai
npm install
```

`npm install` downloads the three dependencies listed in `package.json`:
`express` (web server), `monaco-editor` (editor) and `pdfjs-dist` (PDF viewer).
The `node_modules/` folder is not in the repository, so this step is required.

### 5. Run

```bash
npm start
```

Open **http://localhost:4321** in your browser. An `example` project is included
to get started.

---

## Usage

| Action | How |
|---|---|
| Compile | Ctrl+S (also saves) or the Compile button |
| AI rewrite | Select text, then Ctrl+Alt+E or right-click → AI rewrite |
| Chat | Assistant tab (tick "include selection" to send the selected text) |
| Fix an error | Click **Fix with AI** next to a compile error |

Projects live in `projects/<name>/` (inside the repo folder by default). Build
output (PDF, logs, aux files) goes to `projects/<name>/.build/`. You can copy
existing LaTeX projects into `projects/` and they will show up in the UI.
The main file is `main.tex`.

Only `projects/example/` is tracked by Git; your other projects stay local.

---

## Settings (environment variables)

| Variable | Default | Meaning |
|---|---|---|
| `PORT` | `4321` | Web UI port |
| `HOST` | `127.0.0.1` | Listen address (keep it local) |
| `OLLAMA_MODEL` | `qwen2.5:3b` | Default model (you can also pick one in the UI) |
| `OLLAMA_URL` | `http://127.0.0.1:11434` | Ollama server |
| `OLLAMA_NUM_CTX` | `8192` | Context window sent to the model |
| `LATEX_ENGINE` | `pdf` | `pdf`, `xelatex` or `lualatex` |
| `COMPILE_TIMEOUT_MS` | `120000` | Compile time limit (ms) |
| `LATEXAI_WORKSPACE` | `./projects` | Where projects are stored |

Example:

```bash
OLLAMA_MODEL=llama3.2:3b LATEX_ENGINE=xelatex npm start
```

---

## Other operating systems

- **macOS**: `brew install node git ollama` and `brew install --cask mactex-no-gui`
  (MacTeX includes `latexmk` and `biber`). Then `ollama serve` / `ollama pull qwen2.5:3b`.
- **Windows**: easiest is WSL2 (Ubuntu) and follow the Linux steps. Natively:
  install Node.js from nodejs.org, [MiKTeX](https://miktex.org) or TeX Live
  (MiKTeX needs Perl, e.g. Strawberry Perl, for `latexmk`), and Ollama from ollama.com.

---

## Troubleshooting

| Problem | Fix |
|---|---|
| `latexmk was not found` | Install step 2; check `which latexmk` |
| `File 'xxx.sty' not found` | Install the missing TeX package (`texlive-latex-extra`, `texlive-science`, ...) or `texlive-full` |
| AI says it cannot reach Ollama | Start it: `ollama serve` (or `sudo systemctl start ollama`) |
| Model not found | `ollama pull <model>`; list installed models with `ollama list` |
| AI is very slow | Use a smaller model (`qwen2.5:3b`), or lower `OLLAMA_NUM_CTX` |
| Port already in use | `PORT=5000 npm start` |
| Blank editor / PDF viewer | Run `npm install` (the editor is served from `node_modules`) |
| `Forbidden host` | Open the app via `http://localhost:4321`, not via an IP address |

---

## Project structure

```
latex-ai/
├── server.js          # Express server: files API, latexmk compile, Ollama proxy
├── package.json       # Dependencies and `npm start` script
├── public/
│   ├── index.html     # UI layout
│   ├── app.js         # Editor, PDF viewer, AI features (front-end)
│   └── style.css
└── projects/
    └── example/
        └── main.tex   # Sample project
```

## Security notes

- The server only listens on 127.0.0.1, accepts only `localhost` Host headers
  (blocks DNS rebinding) and requires a custom header on state-changing requests
  (blocks cross-site requests).
- LaTeX runs with TeX Live's default restricted shell-escape. Only compile
  documents you trust.
