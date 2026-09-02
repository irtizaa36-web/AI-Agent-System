<#
.SYNOPSIS
    Non-destructive performance tuning for an older Windows laptop.

.DESCRIPTION
    - Switches to the High Performance power plan
    - Sets visual effects to "Best performance"
    - Runs storage optimization matched to disk type: TRIM for an SSD, defrag for a
      spinning HDD (auto-detected)
    - Turns off Xbox Game Bar's background game recording (safe, reversible, pure overhead
      on a laptop that isn't used for gaming)
    - Lists current startup programs for you to review - NOT auto-disabled. Some may be
      device-specific drivers/utilities (e.g. Surface firmware tools) that are risky to
      guess about from a script; disable anything you don't need yourself via
      Task Manager > Startup apps.

    Nothing here uninstalls software, deletes files, or touches user data.
    Run as Administrator for the power-plan and storage steps to take effect.
#>

[CmdletBinding()]
param()

function Write-Section($title) {
    Write-Host ""
    Write-Host "== $title ==" -ForegroundColor Cyan
}

$isElevated = ([Security.Principal.WindowsPrincipal] `
    [Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole( `
    [Security.Principal.WindowsBuiltInRole]::Administrator)

if (-not $isElevated) {
    Write-Host "Not running as Administrator - power plan and storage steps will be skipped." -ForegroundColor Yellow
}

# 1. Power plan
Write-Section "Power plan"
if ($isElevated) {
    try {
        powercfg /setactive SCHEME_MIN | Out-Null
        Write-Host "  Switched to High Performance power plan." -ForegroundColor Green
    } catch {
        Write-Host "  Could not change power plan: $_" -ForegroundColor DarkGray
    }
} else {
    Write-Host "  Skipped (requires Administrator)." -ForegroundColor Yellow
}

# 2. Visual effects -> best performance
Write-Section "Visual effects"
try {
    $vfxPath = "HKCU:\Software\Microsoft\Windows\CurrentVersion\Explorer\VisualEffects"
    if (-not (Test-Path $vfxPath)) { New-Item -Path $vfxPath -Force | Out-Null }
    Set-ItemProperty -Path $vfxPath -Name "VisualFXSetting" -Value 2 -Type DWord
    Write-Host "  Set to 'Best performance'. Restarting Explorer to apply..." -ForegroundColor Green
    Stop-Process -Name explorer -Force -ErrorAction SilentlyContinue
    Start-Sleep -Seconds 1
    Start-Process explorer
} catch {
    Write-Host "  Could not update visual effects: $_" -ForegroundColor DarkGray
}

# 3. Storage optimization (matched to disk type)
Write-Section "Storage optimization"
if ($isElevated) {
    try {
        $media = (Get-PhysicalDisk -ErrorAction Stop | Select-Object -First 1).MediaType
        if ($media -eq 'SSD') {
            Write-Host "  SSD detected - running TRIM on C: (this is quick)..." -ForegroundColor DarkGray
            Optimize-Volume -DriveLetter C -ReTrim -Verbose -ErrorAction Stop
        } else {
            Write-Host "  Spinning HDD detected - running defrag on C: (this can take a while)..." -ForegroundColor DarkGray
            Optimize-Volume -DriveLetter C -Defrag -Verbose -ErrorAction Stop
        }
        Write-Host "  Storage optimization complete." -ForegroundColor Green
    } catch {
        Write-Host "  Storage optimization failed or unsupported on this drive: $_" -ForegroundColor DarkGray
    }
} else {
    Write-Host "  Skipped (requires Administrator)." -ForegroundColor Yellow
}

# 4. Xbox Game Bar background recording
Write-Section "Background game recording"
try {
    $gameDvrPath = "HKCU:\System\GameConfigStore"
    if (-not (Test-Path $gameDvrPath)) { New-Item -Path $gameDvrPath -Force | Out-Null }
    Set-ItemProperty -Path $gameDvrPath -Name "GameDVR_Enabled" -Value 0 -Type DWord
    Write-Host "  Disabled." -ForegroundColor Green
} catch {
    Write-Host "  Could not disable: $_" -ForegroundColor DarkGray
}

# 5. Startup programs - listed only, not touched
Write-Section "Startup programs (for you to review - nothing here was changed)"
try {
    Get-CimInstance Win32_StartupCommand -ErrorAction Stop |
        Select-Object Name, Command, Location |
        Format-Table -AutoSize |
        Out-String |
        Write-Host
    Write-Host "To turn any of these off: Task Manager (Ctrl+Shift+Esc) > Startup apps tab." -ForegroundColor DarkGray
} catch {
    Write-Host "  Could not list startup programs: $_" -ForegroundColor DarkGray
}

Write-Section "Done"
Write-Host "A restart will make the power-plan and visual-effects changes fully take hold." -ForegroundColor Yellow
