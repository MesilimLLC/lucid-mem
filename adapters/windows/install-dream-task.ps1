# Registers scheduled tasks for Agent Memory Harness dreaming.
# Run:  powershell -File install-dream-task.ps1            (mechanical only, free)
#       powershell -File install-dream-task.ps1 -WithAgent (also weekly Devin session)
#
# Tasks installed:
#   AgentMemoryDream-Mechanical  weekly Sun 03:00   lucid dream --fix --compact
#   AgentMemoryDream-Idle        on ~5min OS idle   lucid dream --if-stale 1 --fix --compact
#   AgentMemoryDream-Agent       weekly Sun 04:00   devin -p DREAMER.md  (-WithAgent only)
#
# -WithAgent runs `devin -p` with the DREAMER.md playbook once a week.
# That spends Devin usage on a schedule and runs with --permission-mode smart;
# only enable it if you're comfortable with that.

param([switch]$WithAgent, [string]$RepoRoot)

# Default repo root = two levels up from this script (adapters/windows/).
# Pass -RepoRoot if the clone lives somewhere else.
if (-not $RepoRoot) { $RepoRoot = Split-Path (Split-Path $PSScriptRoot -Parent) -Parent }
$AmrJs   = Join-Path $RepoRoot "cli\amr.mjs"
$Dreamer = Join-Path $RepoRoot "dreams\DREAMER.md"
$MemRepo = Join-Path $env:USERPROFILE "agent-memory"
$Node    = (Get-Command node).Source
$Pwsh    = "$PSHOME\powershell.exe"
$Devin   = (Get-Command devin).Source

# 1. Mechanical pass — weekly, free, deterministic. Safe to always install.
schtasks /Create /TN "AgentMemoryDream-Mechanical" /SC WEEKLY /D SUN /ST 03:00 /F `
  /TR "`"$Node`" `"$AmrJs`" dream --fix --compact"
Write-Output "installed: AgentMemoryDream-Mechanical (weekly Sun 03:00, dream --fix --compact)"

# 2. Idle pass — ~5 min after the machine goes idle, at most daily.
#    schtasks can't quote the nested hidden-powershell wrapper, so create
#    with a plain node action first, then swap the action to the wrapper
#    via Set-ScheduledTask (verified working without elevation).
schtasks /Create /TN "AgentMemoryDream-Idle" /SC ONIDLE /I 5 /F `
  /TR "`"$Node`" `"$AmrJs`" dream --if-stale 1 --fix --compact" | Out-Null
$IdleArgs   = "-WindowStyle Hidden -NoProfile -Command `"& `"$Node`" `"$AmrJs`" dream --if-stale 1 --fix --compact`""
$IdleAction = New-ScheduledTaskAction -Execute $Pwsh -Argument $IdleArgs
Set-ScheduledTask -TaskName "AgentMemoryDream-Idle" -Action $IdleAction | Out-Null
Write-Output "installed: AgentMemoryDream-Idle (on ~5min idle, dream --if-stale 1 --fix --compact, hidden)"

# 3. Semantic pass — weekly Devin session on the local repo.
if ($WithAgent) {
  schtasks /Create /TN "AgentMemoryDream-Agent" /SC WEEKLY /D SUN /ST 04:00 /F `
    /TR "cmd /c cd /d `"$MemRepo`" && `"$Devin`" -p --permission-mode smart --prompt-file `"$Dreamer`""
  Write-Output "installed: AgentMemoryDream-Agent (weekly Sun 04:00, devin -p DREAMER.md)"
} else {
  Write-Output "skipped:   AgentMemoryDream-Agent (re-run with -WithAgent to enable)"
}

Write-Output ""
Write-Output "inspect: schtasks /Query /TN AgentMemoryDream-Mechanical"
Write-Output "remove:  schtasks /Delete /TN AgentMemoryDream-Mechanical /F; schtasks /Delete /TN AgentMemoryDream-Idle /F"
