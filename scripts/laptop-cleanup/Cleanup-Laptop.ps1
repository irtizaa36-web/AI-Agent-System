<#
.SYNOPSIS
    Safely clears junk from a Windows laptop to free up space and improve performance.

.DESCRIPTION
    Removes only well-known, regenerable junk:
      - Current user's Temp folder and the system Temp folder
      - Browser caches for Chrome, Edge, and Firefox (cache only — not history,
        passwords, bookmarks, saved logins, or extensions)
      - Old Windows Update download leftovers (SoftwareDistribution\Download)
        and component-store cleanup via DISM
      - Windows thumbnail cache
      - The Recycle Bin

    It never touches Documents, Desktop, Pictures, Downloads, or any other
    user file content — only the specific cache/junk locations listed above.

    Run with -WhatIf first to see what would be removed without deleting anything.

.PARAMETER WhatIf
    Preview mode. Reports what would be cleaned and how much space would be
    freed, without deleting anything.

.EXAMPLE
    .\Cleanup-Laptop.ps1 -WhatIf
    Preview what would be cleaned.

.EXAMPLE
    .\Cleanup-Laptop.ps1
    Actually clean the junk described above. Some steps (Windows Update
    cleanup) require an elevated (Run as Administrator) PowerShell session
    and are skipped with a warning if not elevated.
#>

[CmdletBinding(SupportsShouldProcess = $true)]
param()

$ErrorActionPreference = 'Continue'
$totalBytesFreed = 0
$log = [System.Collections.Generic.List[string]]::new()

function Write-Section($title) {
    Write-Host ""
    Write-Host "== $title ==" -ForegroundColor Cyan
}

function Get-FolderSize($path) {
    if (-not (Test-Path $path)) { return 0 }
    try {
        return (Get-ChildItem -Path $path -Recurse -Force -ErrorAction SilentlyContinue |
            Measure-Object -Property Length -Sum -ErrorAction SilentlyContinue).Sum
    } catch {
        return 0
    }
}

function Clear-FolderContents($path, $label) {
    if (-not (Test-Path $path)) {
        Write-Host "  Skipping $label (not found: $path)" -ForegroundColor DarkGray
        return
    }

    $sizeBefore = Get-FolderSize $path
    $items = Get-ChildItem -Path $path -Force -ErrorAction SilentlyContinue

    if (-not $items) {
        Write-Host "  $label is already empty." -ForegroundColor DarkGray
        return
    }

    foreach ($item in $items) {
        if ($PSCmdlet.ShouldProcess($item.FullName, "Delete")) {
            try {
                Remove-Item -Path $item.FullName -Recurse -Force -ErrorAction Stop
            } catch {
                # Files in active use (locked) are skipped rather than forced —
                # forcing them can crash a running browser or app.
                Write-Host "    (in use, skipped) $($item.Name)" -ForegroundColor DarkGray
            }
        }
    }

    $sizeAfter = Get-FolderSize $path
    $freed = [math]::Max(0, $sizeBefore - $sizeAfter)
    $script:totalBytesFreed += $freed
    $mb = [math]::Round($freed / 1MB, 1)
    Write-Host "  $label : freed $mb MB" -ForegroundColor Green
    $script:log.Add("$label : freed $mb MB")
}

function Format-Bytes($bytes) {
    if ($bytes -ge 1GB) { return "{0:N2} GB" -f ($bytes / 1GB) }
    return "{0:N1} MB" -f ($bytes / 1MB)
}

$isElevated = ([Security.Principal.WindowsPrincipal] `
    [Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole( `
    [Security.Principal.WindowsBuiltInRole]::Administrator)

if ($WhatIfPreference) {
    Write-Host "Running in PREVIEW mode (-WhatIf). Nothing will be deleted." -ForegroundColor Yellow
} elseif (-not $isElevated) {
    Write-Host "Note: not running as Administrator. Windows Update cleanup will be skipped." -ForegroundColor Yellow
}

# 1. Temp folders
Write-Section "Temp files"
Clear-FolderContents "$env:TEMP" "User Temp"
Clear-FolderContents "$env:WINDIR\Temp" "System Temp"

# 2. Browser caches (cache only, never profile/history/passwords/bookmarks)
Write-Section "Browser caches"
Clear-FolderContents "$env:LOCALAPPDATA\Google\Chrome\User Data\Default\Cache" "Chrome cache"
Clear-FolderContents "$env:LOCALAPPDATA\Google\Chrome\User Data\Default\Code Cache" "Chrome code cache"
Clear-FolderContents "$env:LOCALAPPDATA\Microsoft\Edge\User Data\Default\Cache" "Edge cache"
Clear-FolderContents "$env:LOCALAPPDATA\Microsoft\Edge\User Data\Default\Code Cache" "Edge code cache"

$ffProfiles = "$env:APPDATA\Mozilla\Firefox\Profiles"
if (Test-Path $ffProfiles) {
    Get-ChildItem -Path $ffProfiles -Directory -ErrorAction SilentlyContinue | ForEach-Object {
        Clear-FolderContents (Join-Path $_.FullName "cache2") "Firefox cache ($($_.Name))"
    }
}

# 3. Windows thumbnail cache
Write-Section "Thumbnail cache"
Clear-FolderContents "$env:LOCALAPPDATA\Microsoft\Windows\Explorer" "Explorer thumbnail cache"

# 4. Windows Update leftovers (requires elevation)
Write-Section "Windows Update leftovers"
if ($isElevated) {
    Clear-FolderContents "$env:WINDIR\SoftwareDistribution\Download" "Windows Update download cache"

    if ($PSCmdlet.ShouldProcess("Windows component store", "DISM /StartComponentCleanup")) {
        Write-Host "  Running DISM component cleanup (this can take a few minutes)..." -ForegroundColor DarkGray
        try {
            & dism.exe /Online /Cleanup-Image /StartComponentCleanup /Quiet | Out-Null
            Write-Host "  DISM component cleanup complete." -ForegroundColor Green
        } catch {
            Write-Host "  DISM cleanup failed or unavailable: $_" -ForegroundColor DarkGray
        }
    }
} else {
    Write-Host "  Skipped (requires Run as Administrator)." -ForegroundColor Yellow
}

# 5. Recycle Bin
Write-Section "Recycle Bin"
if ($PSCmdlet.ShouldProcess("Recycle Bin", "Empty")) {
    try {
        Clear-RecycleBin -Force -ErrorAction Stop
        Write-Host "  Recycle Bin emptied." -ForegroundColor Green
    } catch {
        Write-Host "  Could not empty Recycle Bin (may already be empty): $_" -ForegroundColor DarkGray
    }
}

Write-Section "Summary"
if ($WhatIfPreference) {
    Write-Host "Preview complete. Re-run without -WhatIf to actually clean." -ForegroundColor Yellow
} else {
    Write-Host "Total space freed: $(Format-Bytes $totalBytesFreed)" -ForegroundColor Green
    if (-not $isElevated) {
        Write-Host "Tip: re-run this script 'As Administrator' to also clean Windows Update leftovers." -ForegroundColor Yellow
    }
}
