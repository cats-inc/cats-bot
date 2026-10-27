# ADR-002: Give the Bot a Desktop Presence in the Electron Shell

## Status

Accepted — 2026-10-28。owner 試用 PLAN-001 的成果後指出：只有一張能聊天的便箋，沒有設定頁可選
model、沒有首次啟動、沒有浮動 bot、沒有便箋管理、沒有桌布／桌面／最上層，安裝包也無法直接使用；
並要求把這些做完。這份 ADR 取代 PLAN-001 Phase 5「需要新的 ADR、本計畫不排程」的安排。
規格見 [SPEC-002](../specs/SPEC-002-desktop-presence-settings-and-first-run.md)，
實作見 [PLAN-002](../plans/PLAN-002-desktop-presence.md)。

## Context

- ADR-001 把桌面層、角色形象與跨平台原生宿主留給另一份 ADR，理由是每個宣稱的平台都要有原生驗收證據。
- PLAN-001 交付的殼只有 tray、便箋與 CLI；`updateProfile` 有 IPC，但沒有任何畫面呼叫它。打包出來的
  安裝檔沒有首次設定，不帶 `--provider` 啟動只會跳錯誤。
- desktop-work-fleet 已在 Windows 真機證明三層：桌布（Explorer 的 WorkerW，圖示之下）、桌面
  （`SHELLDLL_DefView` 所在的桌面視窗之上、一般視窗之下）、浮動（topmost）。它也記錄了兩個教訓：
  掛進 Explorer 桌面視窗的子視窗必須自己畫（WPF 與透明 layered 視窗不會出現在畫面上，Chromium 的
  windowed 視窗可以）；桌布層在圖示之下，不會收到點擊。
- cats-runtime 0.6.1 的 `GET /providers/{provider}/models` 只回答 `providers.yaml` 已設定的
  provider；未設定的回 400 `provider_not_configured`。runtime 套件本身附有整理過的 model catalog
  （`config/curated-model-catalogs.generated.json`）。

## Decision

### 1. 殼仍是 Electron，桌面存在感在殼裡做

設定、首次啟動、浮動 bot 與便箋管理都是一般 Electron 視窗，不需要原生程式碼。桌布層與桌面層在
Windows 上以 FFI 呼叫 user32，把便箋視窗掛到 Explorer 的桌面視窗下（移植 desktop-work-fleet
`NativeShellLayers.cs` 的尋找規則）；macOS 與 Linux 只提供「一般」與「最上層」，不宣稱桌面層。
不改用 fleet 的 C#/WPF 宿主：那會讓 bot 多一個要建置與簽章的原生程式，而 Chromium 的視窗已被
fleet 證明能在 Explorer 的桌面視窗裡正常繪製。

### 2. 設定頁經 `BotHostApi`，不碰 runtime

設定頁的 provider 清單、model 清單、改名與 Telegram token 都是 core 的命令（SPEC-002 FR-3–FR-6）；
殼仍然不持有 runtime client（架構邊界測試照舊）。model 清單的來源：bot 目前的 provider 由執行中的
runtime 回答（含本機覆寫）；其他 provider 與尚未啟動時讀 runtime 套件附的 catalog 檔案，當成資料讀，
不 import runtime 的程式碼。

### 3. 首次啟動在殼裡完成

沒有 profile 的 bot 啟動時開設定頁的首次模式（名字、agent CLI、model、個性），送出後才建立 bot、
開 core。命令列的 `--provider` 保留給開發與腳本。

### 4. 浮動 bot 是最上層的一隻貓

一個透明、無邊框、topmost、不出現在工作列的小視窗，顯示 bot 的狀態（醒著、思考中、睡著、有未讀），
可拖曳，點一下開 home 便箋，右鍵是與 tray 相同的選單；有新回覆時冒一個泡泡。可以在 tray 與設定裡
隱藏。

### 5. 每張便箋自己選層

層是便箋的視圖狀態（與位置、大小同一處，存在 `shell-state.json`）：`normal`、`top`、`desktop`、
`wallpaper`。Explorer 的桌面視窗不會因為點擊其子視窗而成為前景，鍵盤因此不會到掛在它底下的便箋；
所以桌面層的便箋一被點到就暫時抬成一般視窗（可打字、可用輸入法），點到別處後放回原層，與
desktop-work-fleet ADR-030 把操作中的 scene 投射到 floating 的作法相同。桌布層的便箋不收輸入
（在圖示之下），從 tray 或設定開啟時同樣先抬起來，用完放回。拖曳在掛載狀態下由 Windows 對子視窗的
標題列拖曳處理，不必抬起。

2026-10-28 實測補充：Electron 41 的視窗是 per-monitor v1（DPI awareness context 0x12），Explorer 的
桌面視窗是 per-monitor v2（0x22）；fleet 要求兩者 context 相同，這裡改為只比較 awareness 等級
（兩者都是 per-monitor），在 3840×2160、150% 縮放下顯示、輸入與拖曳都正確。

### 6. 安裝包

Windows NSIS 安裝檔與免安裝檔由 CI 在每次 main 更新時建置並上傳為 Actions artifact；發佈 GitHub
Release 仍依 release SOP 與 owner 授權。

## Consequences

- 安裝後第一次開就能用：設定頁、首次啟動與 tray 都在。
- 桌面層依賴 Explorer 的私有行為（`0x052C` 訊息與 WorkerW 結構）；Explorer 重啟或結構改變時要重新
  尋找並重新掛載，找不到時便箋退回一般層並記錄原因，而不是消失。
- FFI 套件是第一個原生相依；它只在 Windows 的殼裡載入，core 與 CLI 不受影響（架構邊界測試照舊）。

## Alternatives Considered

- **fleet 的 C#/WPF/WebView2 宿主加 core 子程序**：三層都已驗證，但多一個原生程式與建置鏈；
  Chromium 視窗本身就能掛載，收益不足。
- **只用 `setAlwaysOnTop` 與置底**：做不出圖示之下的桌布層，也撐不過「顯示桌面」（Win+D）。
- **為了 model 清單把所有 provider 都寫進 `providers.yaml`**：runtime 的範例設定說明列出的 CLI
  會在 setup、診斷與 execution priming 時做相容性探測，也會讓沒裝的 CLI 出現在診斷裡；
  讀套件附的 catalog 就夠了。
