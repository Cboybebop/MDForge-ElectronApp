; Custom NSIS hooks for electron-builder (wired in via `nsis.include` in
; electron-builder.yml). electron-builder inserts these two macros by name:
;
;   customInstall   -- installSection.nsh, at the END of the install section,
;                      after file-association registration and shortcut creation
;   customUnInstall -- uninstaller.nsh, early in the uninstall section
;
; WHY THIS EXISTS: the v1.1.0 installed exe embeds the new icon correctly, yet
; the Windows taskbar and Start menu kept showing the OLD Electron icon.
; Windows caches shell icons, and electron-builder's file-association macro
; (APP_ASSOCIATE) never calls SHChangeNotify, so Windows is never told that
; anything changed. electron-builder ships an UPDATEFILEASSOC macro that would
; do it, but never invokes it (10-RESEARCH.md Pitfall 6).
;
; SHCNE_ASSOCCHANGED (0x08000000) tells Explorer to rebuild its icon and
; file-association caches. SHCNF_FLUSH (0x1000) makes the call wait until the
; shell has processed it. The System::Call signature is the one
; electron-builder uses itself (templates/nsis/uninstaller.nsh).
;
; This does NOT fix an already-pinned taskbar shortcut: a pin keeps its own
; copy of the icon from when it was created, and must be unpinned and re-pinned.

!macro customInstall
  System::Call 'shell32::SHChangeNotify(i, i, i, i) v (0x08000000, 0x1000, 0, 0)'
!macroend

!macro customUnInstall
  System::Call 'shell32::SHChangeNotify(i, i, i, i) v (0x08000000, 0x1000, 0, 0)'
!macroend
