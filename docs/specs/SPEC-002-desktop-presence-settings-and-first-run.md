# SPEC-002: Desktop Presence, Settings and First Run

## Metadata

| Field | Value |
|-------|-------|
| **Status** | Accepted — 2026-10-28 together with [ADR-002](../decisions/002-give-the-bot-a-desktop-presence-in-the-electron-shell.md) |
| **Owner** | Claude |
| **Reviewer** | Owner |
| **Related decision** | ADR-002 |
| **Related plan** | [PLAN-002](../plans/PLAN-002-desktop-presence.md) |

## Summary

安裝好的 Cats Bot 第一次開就能設定並使用：首次啟動頁選名字、agent CLI 與 model；設定視窗可以改
provider、model、個性、權限、生活節奏、Telegram 與開機啟動，並管理所有便箋；一隻浮動的貓在最上層
顯示 bot 的狀態；每張便箋可以放在一般、最上層、桌面或桌布層。core 的行為仍由 SPEC-001 定義，
本文件只定義殼與它新增的 `BotHostApi` 命令。

## Functional Requirements

1. FR-1：沒有 profile 的 bot 啟動時開首次啟動頁（名字、agent CLI、model、選填個性）；送出後建立 bot
   並開啟 core 與 home 便箋；關掉頁面就結束程式，不留下半套 bot。輸入在主程序再驗證一次。
2. FR-2：設定頁的每個變更都走 `updateProfile`；provider、model、個性與權限的變更依 SPEC-001 FR-27
   讓既有對話在下一回合換新 session（含承接摘要），頁面告訴主人這件事；換 provider 時 runtime 在進行中的
   回合結束後才重啟。
3. FR-3：`listProviders` 列出 cats-runtime 0.6.1 支援的 CLI provider、各自的預設指令（例如
   antigravity 是 `agy`）與該指令是否在 PATH 上；`listModels(provider)` 對 bot 目前的 provider 問執行中的
   runtime，其他情況讀 runtime 套件附的 catalog；永遠可以留空（provider 預設）或輸入其他 model id。
   產生的 `providers.yaml` 使用 provider 的預設指令，不再把 provider 名稱當指令。
4. FR-4：設定視窗一個 bot 一個，從 tray（「Settings…」「Manage notes…」）與便箋標題列的 ⚙ 開啟；分頁為
   Bot、Notes、Life、Telegram、App。
5. FR-5：Notes 分頁列出所有對話（home 在前，其餘依最後活動排序），顯示未讀與 session 狀態；可以開啟、
   新增、改名（`renameConversation`，不得為空）與刪除（非 home，需要第二次確認；刪除時關掉它的便箋視窗）。
6. FR-6：Telegram 分頁可以存入或移除 token（`setTelegramToken`，token 不回傳給頁面）、開關 polling，並顯示
   保護方式、polling 狀態與 owner chat。
7. FR-7：浮動 bot：透明、無邊框、最上層、不出現在工作列的貓；顯示醒著／思考中／睡著／未讀數；可拖曳且
   記住位置；點一下開 home 便箋；右鍵與 tray 相同的選單；有新回覆時顯示簡短泡泡；可從 tray 與設定隱藏。
   記住的位置只在貓本體（不是整個透明視窗）至少一半落在某個螢幕上時沿用，否則回到主螢幕右下角；螢幕
   增減或縮放改變時同樣檢查。未讀數跟著焦點：桌面、桌布層或被其他視窗擋住的便箋開著但沒有焦點時，新回覆
   照樣算未讀，聚焦時才標為已讀。
8. FR-8：每張便箋的層：`normal`、`top`、`desktop`、`wallpaper`，存在 `shell-state.json`；Windows 上
   `desktop` 與 `wallpaper` 掛到 Explorer 的桌面視窗下（尋找規則同 desktop-work-fleet
   `NativeShellLayers`），Explorer 重啟後重新掛載，找不到時退回 `normal` 並記錄原因，有便箋需要該層時
   最多每 10 秒再找一次（Explorer 可能晚一點才建立容器）；其他平台只提供
   `normal` 與 `top`。拖曳在各層都可用；桌布層不收輸入。桌面層的便箋被點到時暫時成為一般視窗以便
   打字（含輸入法），失去焦點後回到原層。主人從 tray、設定或浮動 bot 開啟桌面或桌布層的便箋時同樣
   抬起並取得焦點，不論它當時是否掛著、這次執行是否已建立過視窗；只有啟動還原與 Explorer 重啟後的
   重開直接放回原層、不搶焦點。舊的
   `shell-state.json` 沒有 `layer` 時以 `alwaysOnTop` 推得（`top` 或 `normal`），寫入時仍保留
   `alwaysOnTop`，讓尚未支援層的版本照舊把 `top` 便箋浮在最上層。
9. FR-9：CI 在 main 更新時建置 Windows NSIS 安裝檔與免安裝檔並上傳為 artifact；安裝後的捷徑啟動即進入
   FR-1 或既有的 bot。

## Acceptance

- A1：全新資料夾啟動打包版：出現首次啟動頁，送出後 home 便箋開啟且可以對話（fixture CLI 與真的 CLI 各一次）。
- A2：設定頁改 model 後下一回合用新 model；Notes 分頁新增、改名、刪除都反映在 tray 與便箋視窗。
- A3：浮動 bot 在其他應用程式之上、可拖曳、重開後位置不變；回合進行中顯示思考中。
- A4：Windows 上一張便箋切到桌面層後按 Win+D 仍在、仍可輸入；切到桌布層後在圖示之下；重啟 Explorer 後
  回到原層。

## Non-Goals

- macOS 與 Linux 的桌面層與桌布層。
- 程式碼簽章、自動更新與 GitHub Release 發佈（依 release SOP 另外授權）。
