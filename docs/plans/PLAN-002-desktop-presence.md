# PLAN-002: Desktop Presence

## Metadata

| Field | Value |
|-------|-------|
| **Status** | In progress — owner 於 2026-10-28 要求補齊 |
| **Owner** | Claude |
| **Related spec** | [SPEC-002](../specs/SPEC-002-desktop-presence-settings-and-first-run.md) |
| **Related decision** | [ADR-002](../decisions/002-give-the-bot-a-desktop-presence-in-the-electron-shell.md) |

## Overview

每個 slice 一個 PR，CI 綠燈後自動合併。順序依「owner 能不能拿來試」排：先讓安裝後能設定與使用，
再加浮動 bot，然後交出安裝包，最後是需要原生呼叫的桌面層。

## Implementation Phases

### Slice 1：設定與首次啟動（SPEC-002 FR-1–FR-6）

- [x] core：`listProviders`、`listModels`、`renameConversation`；runtime client 的 `providerModels`；
      `providers.yaml` 使用 provider 的預設指令。
- [x] 殼：首次啟動頁、設定視窗（Bot、Notes、Life、Telegram、App）、tray 的「Manage notes…」與「Settings…」、
      便箋標題列的 ⚙。
- [x] 測試：provider 與 catalog、PATH 偵測、runtime 回答與退回、改名、首次輸入驗證、tray 選單。

### Slice 2：浮動 bot（FR-7）

- [x] 透明最上層視窗、狀態、拖曳與位置、點擊與右鍵、泡泡、顯示／隱藏（tray 的「Show floating cat」與設定的 App 分頁）。

### Slice 3：安裝包（FR-9）

- [ ] 應用程式圖示；CI 建置 Windows 安裝檔與免安裝檔並上傳 artifact；本機建置交給 owner。

### Slice 4：便箋的層（FR-8）

- [ ] Windows：FFI 呼叫 user32，移植 fleet 的 WorkerW／DefView 尋找、掛載與 Explorer 重啟復原；
      便箋標題列與設定的層選單；其他平台只有一般與最上層。

## Testing Strategy

- core 與殼的無 Electron 部分用 `node:test`。
- 殼以 `--remote-debugging-port` 啟動，經 CDP 操作頁面並截圖（docs/testing.md 的手動驗收）；桌面層另外用
  desktop-ui-automation 在 Windows 真機檢查。

## Progress Log

| Date | Update |
|------|--------|
| 2026-10-28 | Slice 2：浮動的貓在 Windows 真機（3840×2160、150%）以注入的滑鼠事件驗收：透明視窗疊在其他視窗上、回合中顯示思考中、home 便箋沒有焦點時回覆以泡泡顯示並出現未讀數、拖曳後位置寫入 `shell-state.json` 且重開後不變、點一下開 home 便箋、右鍵是 tray 選單、透明處的點擊穿透到下面。修正：Electron 的 `setPosition` 在 150% 縮放下每次把視窗撐大一個像素，改用固定大小的 `setBounds`；切換忽略滑鼠時 Chromium 立刻回報 mouseleave，所以改以每次滑鼠移動的命中測試決定是否接收輸入；`SetCursorPos` 不經過 Electron 轉送滑鼠移動所用的 low-level hook，驗收要用注入的移動 |
| 2026-10-28 | Slice 1：首次啟動頁與設定視窗在真的殼裡以 fixture CLI 走過：建立 bot、home 便箋可對話、改 model 存檔後對話標為下一回合換 session、新增／改名／刪除便箋（刪除同時關掉視窗）、Life／Telegram／App 分頁。修正：antigravity、cursor、kiro 的指令名稱與 provider 名稱不同，`providers.yaml` 之前會叫錯指令 |
