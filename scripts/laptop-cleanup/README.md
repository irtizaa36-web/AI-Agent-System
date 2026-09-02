# Laptop cleanup script

A standalone Windows PowerShell script to free up space and speed up an
old/cluttered laptop. This has no connection to the AI-Agent-System engine
itself — it lives here only because this repo was the designated place to
hand it off. You run it directly on the laptop; nothing in this repo
executes it for you.

## What it does

- Clears the current user's and system `Temp` folders
- Clears browser caches for Chrome, Edge, and Firefox (cache only — never
  history, saved passwords, bookmarks, or extensions)
- Clears the Windows thumbnail cache
- Cleans old Windows Update download leftovers and runs a DISM component
  cleanup (only when run elevated)
- Empties the Recycle Bin

It never touches Documents, Desktop, Pictures, Downloads, or any other
personal file content — only the specific junk/cache locations above.

## How to run it

1. Open PowerShell.
2. Preview first, with nothing deleted:
   ```powershell
   .\Cleanup-Laptop.ps1 -WhatIf
   ```
3. If you're happy with what it plans to touch, run it for real:
   ```powershell
   .\Cleanup-Laptop.ps1
   ```
4. For the biggest win, right-click PowerShell and choose **Run as
   Administrator**, then run the script again — this unlocks the Windows
   Update cleanup step, which is usually the single largest chunk of
   reclaimable space on an old machine. Without elevation, that step is
   skipped with a warning and everything else still runs normally.

If PowerShell blocks the script from running, that's Windows' default
script-execution policy. Allow it for just this session with:

```powershell
Set-ExecutionPolicy -Scope Process -ExecutionPolicy Bypass
```

## Notes

- Files currently open/in use (e.g. a running browser's active cache
  files) are skipped rather than force-closed, so it's safe to run this
  with apps open — though closing your browser first lets it clear more.
- The script prints a running log and a total space-freed summary at the
  end.
- This is separate from moving files to Google Drive for transfer to the
  Mac Mini — run that transfer first (or let it finish) before cleaning,
  so nothing you still need gets caught up in temp/cache clearing.
