; Keep install/update per-user, including the assisted installer mode page.
; Adapted from cats-platform assets/build/installer.nsh at f09c2901 (MIT).
!macro customInstallMode
  StrCpy $isForceCurrentInstall "1"
!macroend
