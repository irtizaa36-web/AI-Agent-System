# Mac Mini Comprehensive Optimization Runbook

**Task ID**: a7f3e8c2-9d4c-4f2b-a1e9-3c6d8f7b4e2a  
**Machine**: Mac Mini (~1 year old)  
**Executor**: Max (macmini persona)  
**Duration**: ~2-3 hours (can be done in phases)

---

## PHASE 1: Baseline Assessment (15 min)

Before making any changes, capture the before-state.

### Step 1.1: Storage & Disk Health
```bash
# Full disk snapshot
diskutil info /Volumes/Macintosh\ HD

# Free space in human-readable format
df -h | grep Macintosh

# Identify largest files/folders (top 20)
du -sh ~/* 2>/dev/null | sort -rh | head -20

# Disk health check
diskutil secureStatus /Volumes/Macintosh\ HD

# SMART status
diskutil info /Volumes/Macintosh\ HD | grep "SMART Status"
```

**Record**: Total capacity, free space %, largest folders

### Step 1.2: Memory & CPU Baseline
```bash
# RAM pressure & memory stats
memory_pressure

# Currently running processes (top 10 CPU hogs)
ps aux --sort=-%cpu | head -11

# Currently running processes (top 10 memory hogs)
ps aux --sort=-%mem | head -11
```

**Record**: Free RAM %, which apps are heavy

### Step 1.3: Startup Items & Login Items
```bash
# System startup agents
ls -la ~/Library/LaunchAgents/ | grep -v "^total"

# System LaunchDaemons (requires admin)
ls -la /Library/LaunchDaemons/ | grep -v "^total"

# Login items via defaults (GUI equivalent)
defaults read com.apple.loginwindow AutoLaunchDelay
```

**Record**: Count of startup items, any recognizable bloat

### Step 1.4: System Health Check
```bash
# Uptime
uptime

# Last restart
log show --predicate 'process == "kernel" and message contains "Wake reason"' --last 24h

# Thermal status (if supported)
system_profiler SPPowerDataType | grep -i "condition"
```

---

## PHASE 2: Cache & Log Cleanup (30 min)

### Step 2.1: Clear System Caches (SAFE)
```bash
# Finder cache
rm -rf ~/Library/Caches/com.apple.finder/*

# Safari cache & browsing data (preserves bookmarks/passwords)
rm -rf ~/Library/Safari/History.db-journal
rm -rf ~/Library/Safari/TopSites.plist

# General application caches
du -sh ~/Library/Caches/ 2>/dev/null
# Then selectively clear old/unused app caches:
find ~/Library/Caches -type d -atime +30 -exec rm -rf {} \; 2>/dev/null

# Temporary system files
rm -rf /tmp/* ~/.Trash/* 2>/dev/null

# Old log files (keep recent 7 days)
find ~/Library/Logs -type f -mtime +7 -delete 2>/dev/null
```

**Safety**: These are all cache/temp files; system/apps regenerate them automatically.

### Step 2.2: Clear Application Support Cruft
```bash
# Find old/unused app support data
du -sh ~/Library/Application\ Support/* | sort -rh | head -10

# Manually review the above and remove known-unused apps' data
# Example: if you don't use Slack, safe to remove ~/Library/Application\ Support/Slack/

# XCode build artifacts (if you have Xcode installed)
rm -rf ~/Library/Developer/Xcode/DerivedData/* 2>/dev/null
```

**Report what you remove** in the update.

### Step 2.3: Clear Downloads Folder
```bash
# Age of files in Downloads
ls -lhT ~/Downloads/ | head -20

# Size of Downloads folder
du -sh ~/Downloads/

# Move old downloads to Archive folder (optional, don't delete)
mkdir -p ~/Downloads/Archive-$(date +%Y-%m-%d)
find ~/Downloads -maxdepth 1 -type f -mtime +60 -exec mv {} ~/Downloads/Archive-* \; 2>/dev/null
```

---

## PHASE 3: Settings Optimization (20 min)

### Step 3.1: Power & Sleep Settings
```bash
# Current power settings
pmset -g

# Set sensible defaults:
# - Computer sleep after 30 mins of inactivity (adjustable)
# - Display sleep after 10 mins (adjust as you prefer)
# - Wake for network access enabled (useful for remote work)
pmset -a sleep 30        # Computer sleep
pmset -a displaysleep 10 # Display sleep
pmset -a womp on         # Wake on network

# Disable sudden motion sensor (if using external USB/Thunderbolt drives)
pmset -a sms 0           # Disable for safety if needed
```

### Step 3.2: Spotlight Indexing (Faster Searches, Less CPU)
```bash
# Current excluded folders (check what's indexed)
defaults read com.apple.Spotlight orderedItems

# Exclude large, non-essential folders from indexing (faster startup + less CPU)
# Open System Settings > Siri & Spotlight > Exclude:
#   - ~/Downloads
#   - ~/Library (or parts of it)
#   - /Volumes/* (external drives)
#   - Application folders you don't search often

# Or via command:
mdutil -i off ~/Downloads  # Disable indexing on Downloads
```

### Step 3.3: Background App Refresh & Notifications
```bash
# Check which apps refresh in background
# System Settings > General > Login Items > Allow in the login window

# Disable unnecessary background refresh:
# System Settings > General > Background App Refresh > Toggle OFF for unused apps

# Review notification permissions:
# System Settings > Notifications > Toggle off for apps that don't need alerts
```

### Step 3.4: Trackpad & Keyboard Optimization (Cool Features!)
```bash
# Enable all trackpad gestures (already default, but verify):
# System Settings > Trackpad > Gestures > Enable:
#   - Tap to click (faster than clicking)
#   - Three-finger tap for lookup/search
#   - Four-finger swipe left/right for app switching
#   - Mission Control with trackpad swipe

# Keyboard shortcuts to know:
# - Cmd+Space: Open Spotlight instantly
# - Cmd+Shift+5: Screenshot/screen recording tool (built-in, no third-party needed)
# - Cmd+Shift+3: Full screen screenshot
# - Cmd+Shift+4: Selective screenshot
# - Cmd+Ctrl+D: Look up selected word in dictionary
# - Cmd+Option+D: Open/close Dock quickly
```

### Step 3.5: Disable Unnecessary Visual Effects (Faster Performance)
```bash
# Reduce motion (useful if you get motion sickness or want snappier UI):
defaults write com.apple.universalaccess reduceMotionEnabled -bool true

# Disable transparency (slightly faster, especially on older Macs):
defaults write com.apple.universalaccess reduceTransparency -bool true

# Speed up window resizing animations:
defaults write NSGlobalDomain NSWindowResizeTime -float 0.001
```

---

## PHASE 4: Advanced Performance Tuning (15 min)

### Step 4.1: Security Baseline Check
```bash
# Verify Gatekeeper is enabled (blocks unsigned/untrusted apps)
spctl -status

# Verify XProtect (built-in malware protection)
defaults read /Library/Apple/System/Library/CoreServices/XProtect.meta.plist

# Check FileVault status (disk encryption)
diskutil secureStatus /Volumes/Macintosh\ HD
```

**If any are OFF**: Re-enable via System Settings > Security & Privacy

### Step 4.2: Memory Pressure & Swap Management
```bash
# Check current memory pressure
memory_pressure

# If consistently high (orange/red), check largest memory hogs:
ps aux --sort=-%mem | head -11

# Restart heavy apps or reduce open browser tabs if needed
```

### Step 4.3: Disk I/O & Thermal Check (Optional, Advanced)
```bash
# Monitor disk reads/writes in real-time (press Ctrl+C to stop):
iostat -d 2

# Check thermal sensors (if supported):
sudo powermetrics --sample-count=1 2>/dev/null | grep "CPU" | head -5

# If thermal status shows high: Check Activity Monitor > Energy tab, close heavy apps
```

---

## PHASE 5: File Organization & Photos (15 min)

### Step 5.1: Organize Screenshots
```bash
# Capture current location
defaults read com.apple.screencapture location

# Create a Screenshots folder in Pictures
mkdir -p ~/Pictures/Screenshots

# Move existing screenshots to organized folder
# Set default screenshot location:
defaults write com.apple.screencapture location ~/Pictures/Screenshots
```

### Step 5.2: Photos & Duplicates
```bash
# Check Photos library size
du -sh ~/Pictures/Photos\ Library.photoslibrary

# Search for duplicate photos (manual review in Photos app):
# Photos app > View > All Photos > Select duplicates (Cmd-click)
# Photos menu > Remove Duplicates (if available in your macOS version)

# Alternative: Use built-in duplicate detection
# Open Photos, check for any greyed-out or marked duplicates
```

### Step 5.3: Organize Downloads
```bash
# Recap of what we did:
ls -lh ~/Downloads/Archive-* 2>/dev/null

# Create a proper archive system for old files:
mkdir -p ~/Archive/$(date +%Y-%m)
# Manually move old projects/files there, or let them sit in Archive folder
```

---

## PHASE 6: Cool macOS Hidden Features & Tips (20 min)

### Step 6.1: Spotlight Power Features
```bash
# Spotlight isn't just search — it's a launcher & calculator!

# Open Spotlight: Cmd+Space
# Then try:
#   - Type "converter" → Opens Unit Converter
#   - Type "calculator" → Opens Calculator
#   - Type "stocks" → Stock ticker
#   - Type an app name → Launch instantly
#   - Type a filename → Find it instantly
#   - Type math: "500 + 300" → Instant calculation

# Advanced: Type "define <word>" to look up in Dictionary
```

### Step 6.2: Quick Actions & Text Processing
```bash
# Quick Actions (Finder > right-click file):
# Try: Right-click file > Quick Actions > Open in Terminal / Create Archive / etc.

# Built-in text tools:
# - System Settings > Keyboard > Text Input > Setup hotkeys for text replacement
# - Example: Type ":email" → expands to your full email

# Screenshot/Recording without third-party apps:
# Cmd+Shift+5 → Built-in screenshot + video recording tool (modern macOS feature!)
```

### Step 6.3: Mission Control & Spaces
```bash
# Mission Control: F3 key (or Swipe up with 4 fingers)
# Lets you see all open windows, organized by app

# Spaces: Create multiple virtual desktops
# System Settings > Keyboard > Keyboard Shortcuts > Mission Control > Add Space
# Then: Swipe left/right with 4 fingers to switch spaces
# Or: Ctrl+← / Ctrl+→ to switch spaces

# Pro tip: Organize by work type
#   Space 1: Email & Chat
#   Space 2: Code & Terminal
#   Space 3: Browser & Research
```

### Step 6.4: Accessibility Features (Not Just for Accessibility!)
```bash
# Pointer Control → Makes Dock bigger on hover (useful for small Mac Mini screens)
# System Settings > Accessibility > Display > Increase contrast

# Text size: System Settings > Accessibility > Display > Larger text option

# Voice Control: Speak commands to control your Mac (cool demo feature)
# System Settings > Accessibility > Voice Control > Enable

# Dictation: Cmd+Dot (period) anywhere to dictate text (use in emails, docs, etc.)
```

### Step 6.5: Keyboard Shortcuts Master List
```bash
# Window Management (no third-party tool needed):
Cmd+Ctrl+F     → Toggle fullscreen current app
Cmd+M          → Minimize current window
Cmd+H          → Hide current app
Cmd+Q          → Quit current app
Cmd+Tab        → Switch between apps
Cmd+`          → Switch between windows of same app (Backtick key!)
Cmd+W          → Close current window
Cmd+Shift+W    → Close all windows of app

# System-wide:
Cmd+Space      → Spotlight
Cmd+Option+D   → Toggle Dock visibility
Cmd+Shift+5    → Screenshot/Screen Record (newer macOS)
Cmd+Ctrl+S     → Take screenshot & save to file
Cmd+Option+V   → "Move" (cut then paste) files in Finder

# Finder Pro Tips:
Cmd+F          → Search in current Finder window
Cmd+Option+V   → Move files (not copy)
Cmd+I          → Get file info (show file size, modify permissions, etc.)
Spacebar       → Quick preview of selected file (before opening)
```

### Step 6.6: Activity Monitor Power Tips
```bash
# Open Activity Monitor: Cmd+Space > "Activity Monitor"

# Memory tab:
# - Sort by "Memory" to see RAM hogs
# - Check "Real Memory" vs "Virtual Memory"
# - If Real Memory > 70%+ and VM is high, add RAM or close apps

# Energy tab:
# - Shows which apps drain most CPU/battery
# - Useful for finding background processes you don't need

# Disk tab:
# - See which apps read/write most to disk
# - High disk I/O = slow system, identify culprits here
```

---

## PHASE 7: Keychain & Password Audit (10 min)

### Step 7.1: Open Keychain
```bash
# Open Keychain Access:
# Cmd+Space > "Keychain Access"

# Or via terminal:
open /Applications/Utilities/Keychain\ Access.app
```

### Step 7.2: Review Stored Passwords
```bash
# In Keychain Access:
# 1. Select "Passwords" category on left
# 2. Look for any password entries you don't recognize
# 3. For each entry: Right-click > Get Info > Show Password (if needed)

# Check for weak passwords:
# - Look for entries > 1 year old with generic passwords (123456, password, etc.)
# - Flag these for manual update (don't change here, change at source service)

# Safe to delete (won't break anything):
# - Old service passwords you no longer use
# - Test accounts
# - Duplicate entries
```

**Report**: Total password entries, any unusually old ones, any obvious weak passwords

---

## PHASE 8: Final Cleanup & Restart (10 min)

### Step 8.1: Summary & Metrics
```bash
# Recapture after-state:
df -h | grep Macintosh  # Free space now
ps aux --sort=-%mem | head -11  # Memory hogs now

# Count remaining startup items:
ls ~/Library/LaunchAgents/ | wc -l
```

### Step 8.2: Restart Mac Mini
```bash
# Graceful restart (closes all apps safely):
sudo shutdown -r now

# Or use menu: Apple menu > Restart > Check "Reopen windows when logging back in"
```

**Why restart**: Clears temp caches, resets memory, ensures all settings take effect.

### Step 8.3: Post-Restart Verification
```bash
# After restart, run this once more:
memory_pressure  # Should be lower now
df -h | grep Macintosh  # Confirm disk space
```

---

## REPORTING CHECKLIST

When you complete these steps, post a `coworker update` with:

- **Before disk space**: X GB free → **After**: Y GB free (freed Z GB)
- **Before RAM baseline**: X GB free → **After**: Y GB free
- **Startup items**: Reduced from X → Y items
- **Caches cleared**: ~X MB freed (approximate)
- **Settings optimized**: (List which ones you changed)
- **Cool features enabled**: (Spotlight, Mission Control, keyboard shortcuts, etc.)
- **Keychain audit**: Total passwords, any flagged for weak password check
- **Any blockers**: (If you hit permission issues, list them here)

---

## SAFETY REMINDERS

✓ Everything in this runbook is reversible or safe.  
✓ Caches & temp files regenerate automatically.  
✓ You're not deleting user data (photos, documents, etc.), only system/app cruft.  
✓ If you get a permission error, flag it on issue #1 rather than forcing with `sudo`.  
✓ Don't touch: Registry, system core files, or anything in /System or /Library that you don't explicitly understand.

---

Enjoy your snappier, more organized Mac Mini! Post your update when done.
