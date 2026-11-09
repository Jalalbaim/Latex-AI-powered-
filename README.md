# latex-ai

A local, Overleaf-style LaTeX editor with live PDF preview and an AI writing
assistant powered by [Ollama](https://ollama.com). Everything runs on your own
machine: no account, no cloud, no API keys.

## Features

- **Monaco editor** (the editor from VS Code) with LaTeX/BibTeX highlighting and auto-save
- **Compile** with `latexmk` (Ctrl+S) and preview the PDF (rendered with PDF.js)
- **Clickable errors and warnings** that jump to the offending line
- **SyncTeX**: double-click in the PDF to jump to the source line
- **Autocomplete**: commands and snippets after `\`, environments, labels in `\ref{}`, BibTeX keys in
  `\cite{}`, image and `.tex` paths, package names, and your own `\newcommand`s
- **Outline** of the document
- **File management**
- **Assistant** tab: chat about the current file, optionally including your selection
- **AI rewrite** (Ctrl+Alt+E or right-click): rewrite the selection (or current
  paragraph) by instruction, review the change as a diff, then accept or reject
- **Fix with AI** on each compile error: the model proposes a minimal fix, shown as a diff
- **AI suggestions while you type** (ghost text): pause at the end of a line and the
  model proposes how to continue; Tab accepts, Ctrl+→ accepts one word, Esc dismisses.
  Suggestions never include made-up `\cite`/`\ref` keys.
- **Version history**: a version is saved on every compile (when something changed),
  before every accepted AI edit and before every restore. Compare any version with
  your current files and restore one file or the whole project.
- Multiple projects, file upload (images, `.bib`, `.sty`, ...)
- **Windows desktop icon**: one click starts everything in the background and opens
  the editor. ([details](#one-click-launcher-desktop-icon))

---

## Requirements

| Component                  | Version                      | Why it is needed                          |
| -------------------------- | ---------------------------- | ----------------------------------------- |
| **Node.js**                | 20 or newer (tested with 24) | Runs the web server (`server.js`)         |
| **npm**                    | comes with Node.js           | Installs JavaScript dependencies          |
| **TeX Live** + **latexmk** | any recent                   | Compiles `.tex` to PDF                    |
| **biber** / BibTeX         | optional                     | Only if your documents use a bibliography |
| **Ollama**                 | any recent                   | Runs the local AI model                   |
| An Ollama **model**        | e.g. `qwen2.5:3b`            | The model that answers / rewrites         |
| **Git**                    | any                          | To clone the repository                   |

Hardware: any machine works for LaTeX. For the AI, a 3B model runs on CPU with
~4 GB of free RAM; larger models (7B+) are much faster with a GPU.

The instructions below are for **Ubuntu / Debian**. Notes for macOS and Windows follow.

---

## Installation (step by step)

### 1. Install Git and Node.js

```bash
sudo apt update
sudo apt install -y git curl

curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt install -y nodejs
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

| Model         | Size    | Notes                                  |
| ------------- | ------- | -------------------------------------- |
| `qwen2.5:3b`  | ~2 GB   | Default, good balance on CPU           |
| `llama3.2:3b` | ~2 GB   | Alternative small model                |
| `qwen2.5:7b`  | ~4.7 GB | Better quality, needs more RAM / a GPU |

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

| Action                   | How                                                                              |
| ------------------------ | -------------------------------------------------------------------------------- |
| Compile                  | Ctrl+S (also saves) or the Compile button                                        |
| PDF → source             | Double-click in the PDF                                                          |
| Source → PDF             | Ctrl+Alt+J, right-click → Show in PDF, or "⇥ Cursor" above the PDF               |
| Autocomplete             | Type `\`, `\ref{`, `\cite{`, `\begin{`, … (Ctrl+Space to open it manually)       |
| Rename / move            | Hover a file or folder → ✎, or drag it onto a folder (empty area = project root) |
| Upload                   | ⇪ button, or drag files from your computer onto a folder                         |
| Download                 | ⤓ in Files (project `.zip`), ⤓ above the PDF (PDF only)                          |
| Rename / delete project  | ✎ / 🗑 next to the project selector                                              |
| AI rewrite               | Select text, then Ctrl+Alt+E or right-click → AI rewrite                         |
| Chat                     | Assistant tab (tick "include selection" to send the selected text)               |
| Fix an error             | Click **Fix with AI** next to a compile error                                    |
| AI suggestions           | Toggle **Suggest** in the top bar; Tab accepts, Ctrl+→ one word, Esc dismisses   |
| Ask for a suggestion now | Alt+\ (works anywhere, even when Suggest is off)                                 |
| Version history          | **History** button: pick a version, click a file to compare, then restore        |
| Name a version           | History → **Save version…**, or ☆ on any version                                 |

---

## Running on Windows

### Using WSL

1. **Install WSL2 + Ubuntu.** Open **PowerShell as Administrator** and run:

   ```powershell
   wsl --install -d Ubuntu
   ```

2. **Install Ollama on Windows** (not inside Ubuntu, so it can use your GPU):
   download the installer from https://ollama.com/download/windows, run it, then
   in PowerShell:

   ```powershell
   ollama pull qwen2.5:3b
   ```

   Ollama starts automatically in the system tray.

3. **Inside the Ubuntu terminal**, follow steps 1, 2, 3, 4

### One-click launcher (desktop icon)

With native Windows (Option B) you don't need to open a terminal or type
`npm start` each time. Create a **LaTeX AI** icon once, then use it like any app.

**Install the icon** (once, from the `latex-ai` folder):

```powershell
powershell -ExecutionPolicy Bypass -File launcher\install-shortcut.ps1
```

This creates a **LaTeX AI** shortcut on the Desktop and in the Start menu.
Run it again if you move the `latex-ai` folder.

## Project structure

```
latex-ai/
├── server.js          # Express server: files API, latexmk compile, Ollama proxy
├── package.json       # Dependencies and `npm start` script
├── public/
│   ├── index.html     # UI layout
│   ├── app.js         # Editor, PDF viewer, SyncTeX, file tree, AI features (front-end)
│   ├── latex-intel.js # Autocomplete, outline and project index (labels, citations, commands)
│   └── style.css
├── launcher/          # Windows one-click launcher (desktop icon)
│   ├── install-shortcut.ps1  # Draws the icon and creates the Desktop / Start menu shortcut
│   ├── run-hidden.vbs        # What the shortcut runs: starts start.ps1 with no window
│   └── start.ps1             # Starts Ollama + server in the background, opens the browser
└── projects/
    └── example/
        └── main.tex   # Sample project
```
