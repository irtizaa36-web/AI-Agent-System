<#
.SYNOPSIS
    Read-only disk usage scan - finds what's actually using space on C:.

.DESCRIPTION
    Reports known large system items (hibernation file, pagefile, old Windows
    install leftovers, installer cache) plus the largest top-level folders
    inside your user profile and Program Files/ProgramData, so we can decide
    together what's actually safe to remove.

    This script does not delete, move, or modify anything.
#>

[CmdletBinding()]
param(
    [int]$Top = 20
)

function Format-Size($bytes) {
    if ($bytes -ge 1GB) { return "{0:N2} GB" -f ($bytes / 1GB) }
    return "{0:N1} MB" -f ($bytes / 1MB)
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

Write-Host "Scanning C:\ ... this can take a few minutes on a large, nearly-full drive." -ForegroundColor Yellow

# 1. Known large system items
Write-Host ""
Write-Host "== Known space users ==" -ForegroundColor Cyan
$known = @(
    "C:\hiberfil.sys",
    "C:\pagefile.sys",
    "C:\swapfile.sys",
    "C:\Windows.old",
    "C:\`$WINDOWS.~BT",
    "C:\`$Windows.~WS",
    "C:\Windows\Installer",
    "C:\Windows\SoftwareDistribution"
)
foreach ($p in $known) {
    if (Test-Path $p -ErrorAction SilentlyContinue) {
        $item = Get-Item $p -Force -ErrorAction SilentlyContinue
        $size = if ($item.PSIsContainer) { Get-FolderSize $p } else { $item.Length }
        "{0,-35} {1}" -f $p, (Format-Size $size)
    }
}

# 2. Largest top-level folders in the user profile
Write-Host ""
Write-Host "== Largest folders in your user profile ==" -ForegroundColor Cyan
Get-ChildItem -Path $HOME -Directory -Force -ErrorAction SilentlyContinue | ForEach-Object {
    [PSCustomObject]@{
        Folder = $_.FullName
        Size   = Get-FolderSize $_.FullName
    }
} | Sort-Object Size -Descending | Select-Object -First $Top | ForEach-Object {
    "{0,-65} {1}" -f $_.Folder, (Format-Size $_.Size)
}

# 3. Largest top-level folders in Program Files / ProgramData
Write-Host ""
Write-Host "== Largest folders in Program Files / ProgramData ==" -ForegroundColor Cyan
@("C:\Program Files", "C:\Program Files (x86)", "C:\ProgramData") | ForEach-Object {
    if (Test-Path $_) {
        Get-ChildItem -Path $_ -Directory -Force -ErrorAction SilentlyContinue
    }
} | ForEach-Object {
    [PSCustomObject]@{
        Folder = $_.FullName
        Size   = Get-FolderSize $_.FullName
    }
} | Sort-Object Size -Descending | Select-Object -First $Top | ForEach-Object {
    "{0,-65} {1}" -f $_.Folder, (Format-Size $_.Size)
}

Write-Host ""
Write-Host "Nothing was deleted or changed - this is a read-only report." -ForegroundColor Green
