; Keep install/update per-user, including the assisted installer mode page.
; Adapted from cats-platform assets/build/installer.nsh at f09c2901 (MIT).
!macro customInstallMode
  StrCpy $isForceCurrentInstall "1"
!macroend

; SPEC-007 FR-9: an uninstall can remove all user data and removes Cats Bot's
; login entries. The page and its gate follow cats-platform
; assets/build/installer.nsh at 3cbcd5bc (MIT).
!include "LogicLib.nsh"
!include "nsDialogs.nsh"

; Start at login writes a Run value named after the AUMID (Electron's default
; for setLoginItemSettings): the appId for the hub, appId.<botId> before it.
!macro removeLoginEntries KEY
  Push $R0
  Push $R1
  Push $R2
  Push $R3
  StrLen $R3 "${APP_ID}."
  StrCpy $R0 0
  ${Do}
    ClearErrors
    EnumRegValue $R1 HKCU "${KEY}" $R0
    ${If} ${Errors}
    ${OrIf} $R1 == ""
      ${ExitDo}
    ${EndIf}
    StrCpy $R2 $R1 $R3
    ${If} $R1 == "${APP_ID}"
    ${OrIf} $R2 == "${APP_ID}."
      ; The next value moves into this index.
      DeleteRegValue HKCU "${KEY}" $R1
    ${Else}
      IntOp $R0 $R0 + 1
    ${EndIf}
  ${Loop}
  Pop $R3
  Pop $R2
  Pop $R1
  Pop $R0
!macroend

!ifdef BUILD_UNINSTALLER

Var RemoveUserDataCheckbox
Var RemoveUserDataState

UninstPage custom un.UserDataRemovalPage un.UserDataRemovalPageLeave

Function un.UserDataRemovalPage
  nsDialogs::Create 1018
  Pop $0
  ${If} $0 == error
    Abort
  ${EndIf}

  ${NSD_CreateLabel} 0 0 100% 48u "Cats Bot will be uninstalled. You may also remove all user data: every bot's profile, conversations, journal, secrets and default workspace under %USERPROFILE%\.catsbot, and window and installation state under %APPDATA%\Cats Bot. Folders outside these two are never touched."
  Pop $0

  ${NSD_CreateCheckbox} 0 64u 100% 16u "Remove all user data (%USERPROFILE%\.catsbot and %APPDATA%\Cats Bot)"
  Pop $RemoveUserDataCheckbox
  ${NSD_SetState} $RemoveUserDataCheckbox ${BST_UNCHECKED}

  nsDialogs::Show
FunctionEnd

Function un.UserDataRemovalPageLeave
  ${NSD_GetState} $RemoveUserDataCheckbox $RemoveUserDataState
FunctionEnd

!endif

!macro customUnInstall
  ; Installing over an existing copy, updates included, runs this uninstaller
  ; silently with --updated: the page never shows, so no data is removed and
  ; Start at login stays as the owner set it.
  ${IfNot} ${isUpdated}
    !insertmacro removeLoginEntries "Software\Microsoft\Windows\CurrentVersion\Run"
  ${EndIf}
  ${If} $RemoveUserDataState == ${BST_CHECKED}
    RMDir /r "$PROFILE\.catsbot"
    RMDir /r "$APPDATA\Cats Bot"
  ${EndIf}
!macroend
