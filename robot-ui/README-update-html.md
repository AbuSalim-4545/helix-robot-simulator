# Updating the Kiosk HTML over SSH

## What this does
Push a new `robot-ui.html` to the Surface Go 2 kiosk and hot-reload it in the running Edge instance — no reboot, no manual clicks.

## Target machine
- **IP:** `192.168.100.236`
- **User:** `User`
- **SSH key:** `C:\Users\oulla\.ssh\surface_go2`
- **Remote path:** `C:\tamra-kiosk\www\robot-ui.html`
- **HTTP port:** `8787`
- **CDP port:** `9222`

## One-shot command (run from your PC)

Replace `<LOCAL_FILE>` with the path to your new HTML:

```bat
scp -i C:\Users\oulla\.ssh\surface_go2 "<LOCAL_FILE>" User@192.168.100.236:"C:/tamra-kiosk/www/robot-ui.html"
```

Then trigger a reload in the running Edge via the server's `/control/reload` endpoint:

```bat
curl -s http://192.168.100.236:8787/control/reload
```

That's it. Edge will reload the page within ~1 second.

## Helper script

A ready-made `update-tamra-kiosk.bat` exists at `C:\Users\oulla\update-tamra-kiosk.bat`. Run it with the HTML path as an argument:

```bat
update-tamra-kiosk.bat "C:\path\to\new-robot-ui.html"
```

It does scp + curl reload in one step.

## Local project source

The "official" local copy lives here:

```
C:\Users\oulla\Desktop\SQU\competetions\sumo robot\fyp\tamra-amr-project\software\robot-ui.html
```

Push it with:

```bat
update-tamra-kiosk.bat "C:\Users\oulla\Desktop\SQU\competetions\sumo robot\fyp\tamra-amr-project\software\robot-ui.html"
```

## If the page doesn't reload

1. Check the server is up:
   ```bat
   curl -s http://192.168.100.236:8787/control/status
   ```
2. If no response, SSH in and restart the server:
   ```bat
   ssh -i C:\Users\oulla\.ssh\surface_go2 User@192.168.100.236 "powershell -File C:\tamra-kiosk\start-server.ps1"
   ```
   Wait 2 seconds, then hit `/control/reload` again.

3. If Edge itself is gone, SSH in and run the watchdog manually:
   ```bat
   ssh -i C:\Users\oulla\.ssh\surface_go2 User@192.168.100.236 "powershell -File C:\tamra-kiosk\kiosk-watchdog.ps1"
   ```
   (The watchdog loop will start Edge within ~5 seconds.)

## Notes for agents

- Use `scp` with the key path above — no password prompt.
- The `User` account is an admin on the Surface, so SSH commands can write to `C:\tamra-kiosk\`.
- The kiosk account is `kiosk` (no password) — it's the auto-logon account that runs Edge.
- Don't reboot the Surface unless necessary; the watchdog + scheduled task bring everything back up at next logon, but it's slower than a hot reload.
- The `restart-server` endpoint (`POST /control/restart-server`) kills the node process; the watchdog or `start-server.ps1` must bring it back. Prefer `/control/reload` for HTML-only updates.
- If the file path contains spaces, always wrap it in double quotes in both scp and the bat script.

## File map (Surface)

```
C:\tamra-kiosk\
  server.js              # HTTP server + CDP reload logic
  kiosk-shim.js          # served alongside robot-ui.html
  kiosk-panel.html       # admin control panel (served at /control)
  kiosk-watchdog.ps1     # 5s loop: ensures Edge kiosk + server running
  start-server.ps1       # one-shot: starts node server
  install.ps1            # full install: scheduled tasks, shortcuts, power config
  uninstall.ps1          # removes scheduled tasks + shortcuts
  switch-direct.bat      # tscon 1 /dest:console  (Back to Kiosk shortcut target)
  show-desktop.flag      # exists while show-desktop is active (pauses watchdog Edge-relaunch)
  server.log             # server stdout/stderr
  watchdog.log           # watchdog stdout/stderr
  www\
    robot-ui.html        # THE file you update
```
