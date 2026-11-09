# Creates the app icon and the "LaTeX AI" shortcut on the Desktop and in the Start menu.
# Run once:  powershell -ExecutionPolicy Bypass -File launcher\install-shortcut.ps1

$ErrorActionPreference = 'Stop'
$Dir  = $PSScriptRoot
$Ico  = Join-Path $Dir 'latex-ai.ico'

# ---- 1. Draw the icon (multi-size .ico with PNG frames) ----
Add-Type -AssemblyName System.Drawing
function New-Frame([int]$s) {
    $bmp = New-Object System.Drawing.Bitmap $s, $s
    $g = [System.Drawing.Graphics]::FromImage($bmp)
    $g.SmoothingMode = 'AntiAlias'; $g.TextRenderingHint = 'AntiAliasGridFit'
    $r = [math]::Max(2, [int]($s * 0.2)); $m = [math]::Max(0, [int]($s * 0.03)); $w = $s - 2 * $m
    $path = New-Object System.Drawing.Drawing2D.GraphicsPath
    $path.AddArc($m, $m, $r, $r, 180, 90); $path.AddArc($m + $w - $r, $m, $r, $r, 270, 90)
    $path.AddArc($m + $w - $r, $m + $w - $r, $r, $r, 0, 90); $path.AddArc($m, $m + $w - $r, $r, $r, 90, 90)
    $path.CloseFigure()
    $g.FillPath((New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb(22, 96, 122))), $path)
    $fmt = New-Object System.Drawing.StringFormat; $fmt.Alignment = 'Center'; $fmt.LineAlignment = 'Center'
    $font = New-Object System.Drawing.Font 'Georgia', ([single]($s * 0.36)), ([System.Drawing.FontStyle]::Bold), ([System.Drawing.GraphicsUnit]::Pixel)
    $g.DrawString('TeX', $font, [System.Drawing.Brushes]::White, (New-Object System.Drawing.RectangleF 0, (-$s * 0.06), $s, $s), $fmt)
    if ($s -ge 32) {   # red "AI" spark under the text
        $f2 = New-Object System.Drawing.Font 'Segoe UI', ([single]($s * 0.2)), ([System.Drawing.FontStyle]::Bold), ([System.Drawing.GraphicsUnit]::Pixel)
        $g.DrawString('AI', $f2, (New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb(255, 140, 110))), (New-Object System.Drawing.RectangleF 0, ($s * 0.25), $s, $s), $fmt)
    }
    $g.Dispose()
    $ms = New-Object System.IO.MemoryStream; $bmp.Save($ms, [System.Drawing.Imaging.ImageFormat]::Png); $bmp.Dispose()
    , $ms.ToArray()
}
$sizes  = 16, 32, 48, 256
$frames = $sizes | ForEach-Object { , (New-Frame $_) }
$fs = [System.IO.File]::Create($Ico); $bw = New-Object System.IO.BinaryWriter $fs
$bw.Write([uint16]0); $bw.Write([uint16]1); $bw.Write([uint16]$sizes.Count)
$offset = 6 + 16 * $sizes.Count
for ($i = 0; $i -lt $sizes.Count; $i++) {
    $d = if ($sizes[$i] -ge 256) { 0 } else { $sizes[$i] }
    $bw.Write([byte]$d); $bw.Write([byte]$d); $bw.Write([byte]0); $bw.Write([byte]0)
    $bw.Write([uint16]1); $bw.Write([uint16]32); $bw.Write([uint32]$frames[$i].Length); $bw.Write([uint32]$offset)
    $offset += $frames[$i].Length
}
foreach ($f in $frames) { $bw.Write($f) }
$bw.Close()

# ---- 2. Shortcut ----
$shell   = New-Object -ComObject WScript.Shell
$targets = @([Environment]::GetFolderPath('Desktop'), [Environment]::GetFolderPath('Programs'))
foreach ($t in $targets) {
    Remove-Item (Join-Path $t 'Stop LaTeX AI.lnk') -ErrorAction SilentlyContinue   # from older versions
    $lnk = $shell.CreateShortcut((Join-Path $t 'LaTeX AI.lnk'))
    $lnk.TargetPath       = "$env:WINDIR\System32\wscript.exe"
    $lnk.Arguments        = '"' + (Join-Path $Dir 'run-hidden.vbs') + '"'
    $lnk.WorkingDirectory = $Dir
    $lnk.IconLocation     = "$Ico,0"
    $lnk.Description      = 'Open LaTeX AI (stops by itself when you close the tab)'
    $lnk.Save()
}
Write-Host "Icon: $Ico"
Write-Host "Shortcut 'LaTeX AI' created on the Desktop and in the Start menu."
