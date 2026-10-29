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

!define CATS_BOT_RUN_KEY "Software\Microsoft\Windows\CurrentVersion\Run"
!define CATS_BOT_APPROVED_KEY "Software\Microsoft\Windows\CurrentVersion\Explorer\StartupApproved\Run"

; Start at login writes a Run value named after the AUMID (Electron's default
; for setLoginItemSettings): the appId for the hub, appId.<botId> before it.
; Only values that start this installation go, each with the StartupApproved
; value Task Manager keeps under the same name.
!macro removeLoginEntries RUN_KEY APPROVED_KEY
  Push $R0
  Push $R1
  Push $R2
  Push $R3
  Push $R4
  Push $R5
  StrLen $R3 "${APP_ID}."
  StrLen $R4 '"$INSTDIR\'
  StrCpy $R0 0
  ${Do}
    ClearErrors
    EnumRegValue $R1 HKCU "${RUN_KEY}" $R0
    ${If} ${Errors}
      ${ExitDo}
    ${EndIf}
    StrCpy $R5 ""
    StrCpy $R2 $R1 $R3
    ${If} $R1 == "${APP_ID}"
    ${OrIf} $R2 == "${APP_ID}."
      ReadRegStr $R2 HKCU "${RUN_KEY}" $R1
      StrCpy $R2 $R2 $R4
      ${If} $R2 == '"$INSTDIR\'
        ClearErrors
        DeleteRegValue HKCU "${RUN_KEY}" $R1
        ${IfNot} ${Errors}
          DeleteRegValue HKCU "${APPROVED_KEY}" $R1
          StrCpy $R5 "deleted"
        ${EndIf}
      ${EndIf}
    ${EndIf}
    ; A deleted value's successor moves into this index. Anything else,
    ; the unnamed default value or one that cannot be deleted included,
    ; is stepped over.
    ${If} $R5 == ""
      IntOp $R0 $R0 + 1
    ${EndIf}
  ${Loop}
  Pop $R5
  Pop $R4
  Pop $R3
  Pop $R2
  Pop $R1
  Pop $R0
!macroend

; NSIS's RMDir /r enters junctions and directory symlinks and empties their
; targets. cmd's rd /s removes such links without entering them, and a root
; that is itself a link loses only the link.
!macro removeDataRoot DIR
  Push $R0
  System::Call 'kernel32::GetFileAttributesW(w "${DIR}") i .R0'
  ${If} $R0 != -1
    IntOp $R0 $R0 & 0x400
    ${If} $R0 != 0
      RMDir "${DIR}"
    ${Else}
      ; The path reaches cmd through a variable, so % and ! in it stay literal.
      System::Call 'kernel32::SetEnvironmentVariableW(w "CATS_REMOVE_ROOT", w "${DIR}") i .R0'
      nsExec::Exec '"$SYSDIR\cmd.exe" /d /v:off /c rd /s /q "%CATS_REMOVE_ROOT%"'
      Pop $R0
      System::Call 'kernel32::SetEnvironmentVariableW(w "CATS_REMOVE_ROOT", i 0) i .R0'
    ${EndIf}
  ${EndIf}
  Pop $R0
!macroend

!ifdef BUILD_UNINSTALLER

Var RemoveUserDataCheckbox
Var RemoveUserDataState
Var RemoveUserDataLeft
Var RemoveUserDataPerUser

; Runs after initMultiUser. A per-machine install would remove another
; account's data, so its uninstall skips the page.
!macro customUnInit
  StrCpy $RemoveUserDataPerUser "1"
  ${If} $installMode == "all"
    StrCpy $RemoveUserDataPerUser ""
  ${EndIf}
!macroend

UninstPage custom un.UserDataRemovalPage un.UserDataRemovalPageLeave

Function un.UserDataRemovalPage
  ${If} $RemoveUserDataPerUser != "1"
    Abort
  ${EndIf}
  nsDialogs::Create 1018
  Pop $0
  ${If} $0 == error
    Abort
  ${EndIf}

  ${NSD_CreateLabel} 0 0 100% 56u "Cats Bot will be uninstalled. You may also remove all user data: every bot's profile, conversations, journal, secrets and default workspace under %USERPROFILE%\.catsbot, window and installation state under %APPDATA%\Cats Bot, and downloaded updates under %LOCALAPPDATA%\cats-bot-updater. Links inside them are removed, never followed, so the folders they point to are kept."
  Pop $0

  ${NSD_CreateCheckbox} 0 72u 100% 16u "Remove all user data (%USERPROFILE%\.catsbot, %APPDATA%\Cats Bot and downloaded updates)"
  Pop $RemoveUserDataCheckbox
  ${NSD_SetState} $RemoveUserDataCheckbox ${BST_UNCHECKED}

  nsDialogs::Show
FunctionEnd

Function un.UserDataRemovalPageLeave
  ${NSD_GetState} $RemoveUserDataCheckbox $RemoveUserDataState
FunctionEnd

!macro noteDataRootLeft DIR
  ${If} ${FileExists} "${DIR}\*.*"
    StrCpy $RemoveUserDataLeft "$RemoveUserDataLeft$\r$\n${DIR}"
  ${EndIf}
!macroend

!endif

!macro customUnInstall
  ; Installing over a copy, updates included, runs this uninstaller silently
  ; with --updated: the page never shows, so no data is removed and Start at
  ; login stays as the owner set it. A per-machine install would reach another
  ; account's profile and registry, so it removes neither.
  ${IfNot} ${isUpdated}
  ${AndIf} $installMode != "all"
    !insertmacro removeLoginEntries "${CATS_BOT_RUN_KEY}" "${CATS_BOT_APPROVED_KEY}"
    ${If} $RemoveUserDataState == ${BST_CHECKED}
      !insertmacro removeDataRoot "$PROFILE\.catsbot"
      !insertmacro removeDataRoot "$APPDATA\Cats Bot"
      !insertmacro removeDataRoot "$LOCALAPPDATA\cats-bot-updater"
      StrCpy $RemoveUserDataLeft ""
      !insertmacro noteDataRootLeft "$PROFILE\.catsbot"
      !insertmacro noteDataRootLeft "$APPDATA\Cats Bot"
      !insertmacro noteDataRootLeft "$LOCALAPPDATA\cats-bot-updater"
      ${If} $RemoveUserDataLeft != ""
        MessageBox MB_OK|MB_ICONEXCLAMATION "Cats Bot could not remove all of these folders:$RemoveUserDataLeft$\r$\n$\r$\nDelete them by hand, for example after closing programs that use them." /SD IDOK
      ${EndIf}
    ${EndIf}
  ${EndIf}
!macroend
