# PLAN-003: React Renderer

## Metadata

| Field | Value |
|-------|-------|
| **Status** | In progress — owner 於 2026-10-28 要求切 slice 實作並交付安裝包 |
| **Owner** | Claude |
| **Related spec** | [SPEC-003](../specs/SPEC-003-note-reading-and-the-react-renderer.md) |
| **Related decision** | [ADR-003](../decisions/003-build-the-renderer-with-react-and-vite-like-cats-desktop.md) |

## Overview

每個 slice 一個 PR，CI 綠燈後自動合併。先單獨換掉建置流程（畫面與行為不變），確認 file:// 載入、CSP 與
打包都沒問題，再逐頁改寫：先便箋（使用者每天看的），再工具卡片與決定按鈕，最後設定頁。全部合併後
從 main 建一包安裝檔交給 owner。

## Implementation Phases

### Slice 1：Vite 與 TypeScript 建置（SPEC-003 FR-1）

- [x] 頁面搬到 `src/renderer/`，Vite 多頁建置到 `dist/renderer/`；殼改從那裡載入，圖示路徑改為明確傳入。
- [x] `bridge.ts` 定義 `window.catsBot` 的型別；命令結果型別搬進 `core/types.ts`；浮動貓改為 TypeScript。
- [x] `THIRD-PARTY-NOTICES.txt`；`tsconfig.renderer.json`；架構邊界與 bridge 契約測試。
- [x] 驗收：既有腳本在 Vite 建置上重跑，打包版首次啟動頁正常。

### Slice 2：便箋改用 React 並渲染 markdown（FR-2、FR-3）

- [x] 便箋頁面以 React 重寫，保留 IME 的 Enter 判斷、只在有焦點時標為已讀、抬起後把焦點還給輸入框、
      串流中的回覆以 `workItemId` 對應、回合結束後重新讀逐字稿。
- [x] `react-markdown` + `remark-gfm` + `remark-breaks`；連結與圖片規則；殼拒絕開新視窗與換頁，
      http(s) 交給系統瀏覽器。
- [x] 測試：連結規則、逐字稿整理。

### Slice 3：工具卡片與主人的決定（FR-4、FR-5）

- [x] 工具卡片（以 `toolId` 合併、收合與展開、錯誤狀態）；core 把 runtime 只以 `toolArgs` 給的工具輸入存成 JSON。
- [x] `awaiting_owner` 的 Approve／Deny 按鈕，`work.updated` 後更新。
- [x] 測試：卡片分組與決定狀態。

### Slice 4：設定與首次啟動改用 React（FR-6）

- [x] Bot、Notes、Life、Telegram、App 分頁與首次啟動頁以 React 重寫，行為同 SPEC-002。
- [x] model 清單的請求序號邏輯抽成可測試的模組並補測試（`settingsLogic.ts`）。
- [ ] 驗收後從 main 建安裝檔交給 owner。

## Testing Strategy

- 不碰 DOM 的邏輯以 `node:test` 測試；元件在真的殼裡以 CDP 驗收（docs/testing.md）。
- 每個 slice 重跑既有的驗收腳本：設定頁 model 競態與存檔、桌面層便箋的抬起、背景便箋的未讀。

## Progress Log

| Date | Update |
|------|--------|
| 2026-10-28 | Slice 4：設定與首次啟動頁改用 React，邏輯集中在 `settingsLogic.ts`（7 個測試）。真機驗收：model 選單快速切換 8/8 停在 Codex 的清單、存檔保留 `claude · haiku`；Notes 分頁新增、改名（Enter）、改層（toast 與 `shell-state.json` 都是 top）、刪除要按兩次；Life 分頁存閒置分鐘數後還原，填 0 時表單驗證擋下、設定不變；Telegram 分頁顯示狀態、沒有 token 時 Remove 不能按；App 分頁關掉再打開浮動貓；從便箋的 ⚙ 開到指定分頁；全新 bot id 的首次啟動頁快速切換 5/5 正確，建立 `Setup Cat · claude · haiku` 後 home 便箋開啟、回覆以 markdown 顯示。改寫時發現：React 的更新在 microtask 才套用，所以 model 選單另以「目錄屬於目前 provider」判斷是否可存，不依賴 effect 何時執行 |
| 2026-10-28 | Slice 3：工具卡片與主人的決定。真機（fixture CLI 經真的 runtime）：`tool` 回合顯示一張收合的 Read 卡片（摘要 `file.txt`、✓），展開看到輸入 `{"path": "file.txt"}` 與結果；`ask:` 問題顯示 Approve／Deny，按 Approve 後卡片變成 Approved、按鈕消失、bot 收到「approved」的訊息，另一題按 Deny 變成 Denied。發現：runtime 的 Claude 工具事件只以 `toolArgs` 帶輸入，core 原本只存 `text`（空字串），卡片看不到輸入；core 改為把 `toolArgs` 存成縮排 JSON，長度上限與結果相同 |
| 2026-10-28 | Slice 2：便箋改用 React，bot 回覆以 `react-markdown` + GFM 顯示。真機驗收（fixture CLI 原樣回傳 markdown）：標題、粗體、斜體、刪除線、清單、引言、表格、程式碼區塊、單一換行都正確；外部連結帶 `target=_blank`、本機路徑是不可點的文字、原始 HTML 以文字顯示、遠端圖片變成連結；340 px 寬的便箋沒有橫向捲軸，程式碼區塊與過寬的表格在自己裡面捲動（表格原本繼承便箋的 `word-break` 而逐字斷行，已修正）。`window.open` 與換頁都被殼擋下，頁面仍在 `note.html`。回合進行中主人的訊息立即出現（舊版要等回合結束）、顯示 thinking…、Cancel 可按。重跑桌面層抬起（抬起後焦點回到輸入框）與背景未讀腳本都通過。未實測：點 https 連結真的開啟瀏覽器（避免在 owner 桌面開分頁；規則有單元測試）、輸入法 |
| 2026-10-28 | Slice 1：Vite 7.3.6 建置三個頁面；Electron 41 以 file:// 載入 `type="module"` 的輸出正常，CSP 不必放寬。重跑驗收腳本：model 選單快速切換 8/8 正確、存檔保留 `claude · haiku`、桌面層便箋隱藏後再開 7 秒後仍抬起、背景便箋未讀 1 且浮動貓顯示 1、開啟後歸零；`dist:dir` 打包版以新的 bot id 開出首次啟動頁，provider 15 個、model 清單載入。esbuild 的 postinstall 被 npm 擋下仍可用（與 koffi 相同） |
