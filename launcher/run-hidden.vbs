' Runs a PowerShell script from this folder without any console window.
' Usage: wscript run-hidden.vbs start.ps1
Set fso = CreateObject("Scripting.FileSystemObject")
dir = fso.GetParentFolderName(WScript.ScriptFullName)
script = "start.ps1"
If WScript.Arguments.Count > 0 Then script = WScript.Arguments(0)
CreateObject("WScript.Shell").Run "powershell.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File """ & dir & "\" & script & """", 0, False
