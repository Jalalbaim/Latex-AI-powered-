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
- **Windows**: see the next section.

---

## Running on Windows

There are two ways. **Option A (WSL2) is recommended**: it is the same Linux
setup the tool was built and tested on. Option B runs natively but is less tested.

### Option A — WSL2 (recommended)

WSL2 runs a real Ubuntu inside Windows. The server runs in Ubuntu and you use it
from your normal Windows browser (WSL2 forwards `localhost` automatically).

1. **Install WSL2 + Ubuntu.** Open **PowerShell as Administrator** and run:
   ```powershell
   wsl --install -d Ubuntu
   ```
   Restart when asked, then open **Ubuntu** from the Start menu and create a
   Linux username and password.

2. **Install Ollama on Windows** (not inside Ubuntu, so it can use your GPU):
   download the installer from https://ollama.com/download/windows, run it, then
   in PowerShell:
   ```powershell
   ollama pull qwen2.5:3b
   ```
   Ollama starts automatically in the system tray.

3. **Inside the Ubuntu terminal**, follow steps 1, 2 and 4 of the
   [Installation](#installation-step-by-step) section above (Node.js, TeX Live,
   clone + `npm install`). Skip step 3 (Ollama), it is already installed on Windows.
   Clone into your Linux home (`~/latex-ai`), not under `/mnt/c/...`: compiling
   is much faster on the Linux file system.

4. **Let Ubuntu reach the Windows Ollama.** By default Ollama on Windows only
   listens on Windows' own `localhost`. Pick one:

   - **Easiest (Windows 11 22H2+): mirrored networking.** Create the file
     `C:\Users\<you>\.wslconfig` with:
     ```ini
     [wsl2]
     networkingMode=mirrored
     ```
     then run `wsl --shutdown` in PowerShell and reopen Ubuntu. Now
     `http://127.0.0.1:11434` works from Ubuntu with no further settings.

   - **Otherwise:** in Windows, set the user environment variable
     `OLLAMA_HOST` to `0.0.0.0` (Settings → System → About → Advanced system
     settings → Environment Variables), quit and restart Ollama from the tray,
     and allow it through the Windows Firewall if asked. Then start latex-ai
     pointing at the Windows host:
     ```bash
     OLLAMA_URL="http://$(ip route show default | awk '{print $3}'):11434" npm start
     ```

   - **Alternative:** install Ollama *inside* Ubuntu instead
     (`curl -fsSL https://ollama.com/install.sh | sh`) and skip this step.
     Simpler networking, but GPU use inside WSL needs up-to-date NVIDIA drivers.

   Check from Ubuntu: `curl http://127.0.0.1:11434/api/tags` (or the URL you set)
   should print your models.

5. **Run** in the Ubuntu terminal:
   ```bash
   cd ~/latex-ai
   npm start
   ```
   and open **http://localhost:4321** in Edge / Chrome / Firefox on Windows.

Tips:
- Your projects are in `\\wsl$\Ubuntu\home\<linux-user>\latex-ai\projects` —
  paste that into File Explorer to copy files in and out.
- You can also open the folder in VS Code with `code .` from Ubuntu
  (needs the "WSL" extension).

### Option B — native Windows

1. **Node.js 20+**: install the LTS version from https://nodejs.org
   (keep "Add to PATH" ticked).
2. **Git**: install from https://git-scm.com/download/win.
3. **LaTeX**, choose one:
   - **TeX Live** (https://tug.org/texlive/windows.html, run `install-tl-windows.exe`).
     Includes `latexmk`, `biber` and Perl. Recommended.
   - **MiKTeX** (https://miktex.org/download). `latexmk` additionally needs Perl:
     install [Strawberry Perl](https://strawberryperl.com). In the MiKTeX Console,
     enable *"Install missing packages on the fly: Always"*, otherwise compiles
     hang waiting on a hidden dialog.
4. **Ollama**: install from https://ollama.com/download/windows, then
   `ollama pull qwen2.5:3b` in PowerShell.
5. **Open a new PowerShell** (so the updated PATH is picked up) and check:
   ```powershell
   node -v; latexmk -v; ollama list
   ```
6. **Get the code and run:**
   ```powershell
   git clone https://github.com/Jalalbaim/Latex-AI-powered-.git latex-ai
   cd latex-ai
   npm install
   npm start
   ```
   Open **http://localhost:4321**.

Setting environment variables on Windows (the `VAR=value npm start` syntax is Linux/macOS only):

```powershell
# PowerShell
$env:OLLAMA_MODEL="llama3.2:3b"; $env:LATEX_ENGINE="xelatex"; npm start
```
```bat
:: Command Prompt (cmd.exe)
set OLLAMA_MODEL=llama3.2:3b
set LATEX_ENGINE=xelatex
npm start
```

Known limitations of native Windows:
- If a compile exceeds the time limit, the main `latexmk` process is stopped but
  a child `pdflatex.exe` may keep running; end it in Task Manager if needed.
- A console window may briefly flash while compiling.
- If `latexmk` is "not found" although it is installed, the terminal was opened
  before the install: close it and open a new one (or log out and back in).

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
