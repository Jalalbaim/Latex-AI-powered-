# Starts latex-ai in the background (no console window) and opens it in the browser.
# Launched by "LaTeX AI.vbs" / the desktop shortcut. Safe to run when it is already running.

$ErrorActionPreference = 'Stop'
$Root    = Split-Path -Parent $PSScriptRoot
$Port    = if ($env:PORT) { $env:PORT } else { 4321 }
$Url     = "http://localhost:$Port"
$Health  = "http://127.0.0.1:$Port/api/config"   # localhost may try IPv6 first and be slow
$LogDir  = Join-Path $PSScriptRoot 'logs'
New-Item -ItemType Directory -Force $LogDir | Out-Null

Add-Type -AssemblyName System.Windows.Forms
function Fail($msg) {
    [System.Windows.Forms.MessageBox]::Show($msg, 'LaTeX AI', 'OK', 'Error') | Out-Null
    exit 1
}
function Test-Url($u) {
    try { Invoke-WebRequest -UseBasicParsing -TimeoutSec 2 $u | Out-Null; $true } catch { $false }
}

# 1. Already running? Just open the browser.
if (Test-Url $Health) { Start-Process $Url; exit 0 }

# 2. Make sure Ollama is up (don't wait for it: the editor works without it).
if (-not (Test-Url 'http://127.0.0.1:11434/api/tags')) {
    $ollamaApp = Join-Path $env:LOCALAPPDATA 'Programs\Ollama\ollama app.exe'
    if (Test-Path $ollamaApp) {
        Start-Process $ollamaApp
    } elseif (Get-Command ollama -ErrorAction SilentlyContinue) {
        Start-Process ollama -ArgumentList 'serve' -WindowStyle Hidden
    }
}

# 3. Find Node and install dependencies on first run.
$node = (Get-Command node -ErrorAction SilentlyContinue).Source
if (-not $node) { Fail "Node.js was not found. Install it from https://nodejs.org and try again." }

if (-not (Test-Path (Join-Path $Root 'node_modules'))) {
    $npm = (Get-Command npm.cmd -ErrorAction SilentlyContinue).Source
    if (-not $npm) { Fail "npm was not found (it comes with Node.js)." }
    $p = Start-Process $npm -ArgumentList 'install' -WorkingDirectory $Root -WindowStyle Hidden -Wait -PassThru `
         -RedirectStandardOutput (Join-Path $LogDir 'npm-install.log') -RedirectStandardError (Join-Path $LogDir 'npm-install.err.log')
    if ($p.ExitCode -ne 0) { Fail "npm install failed. See $LogDir\npm-install.err.log" }
}

# 4. Start the server hidden, logging to launcher\logs. It exits by itself
#    once the last browser tab is closed.
$env:LATEXAI_EXIT_WHEN_IDLE = '1'
Start-Process $node -ArgumentList 'server.js' -WorkingDirectory $Root -WindowStyle Hidden `
    -RedirectStandardOutput (Join-Path $LogDir 'server.log') -RedirectStandardError (Join-Path $LogDir 'server.err.log')

# 5. Wait until it answers (max ~30 s), then open the browser.
for ($i = 0; $i -lt 60; $i++) {
    if (Test-Url $Health) { Start-Process $Url; exit 0 }
    Start-Sleep -Milliseconds 500
}
Fail "The server did not start. See $LogDir\server.err.log"
