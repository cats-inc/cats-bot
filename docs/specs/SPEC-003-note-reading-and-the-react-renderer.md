# SPEC-003: Note Reading and the React Renderer

## Metadata

| Field | Value |
|-------|-------|
| **Status** | Accepted — 2026-10-28 together with [ADR-003](../decisions/003-build-the-renderer-with-react-and-vite-like-cats-desktop.md) |
| **Owner** | Claude |
| **Reviewer** | Owner |
| **Related decision** | ADR-003 |
| **Related plan** | [PLAN-003](../plans/PLAN-003-react-renderer.md) |

## Summary

便箋把 bot 的回覆當 markdown 顯示，工具呼叫是可展開的卡片，需要主人決定的事有按鈕；設定與首次啟動頁
功能不變但改以 React 實作。頁面的行為仍由 SPEC-001 FR-33 與 SPEC-002 定義，本文件只補充閱讀與互動。

## Functional Requirements

1. FR-1：建置。renderer 由 `src/renderer` 以 Vite 建置到 `dist/renderer`，頁面名稱與查詢字串不變；
   CSP 維持 `script-src 'self'`、`style-src 'self'`；建置產生 `THIRD-PARTY-NOTICES.txt`。
2. FR-2：markdown。bot 的回覆（含串流中的回覆）以 GFM 渲染：段落、粗體與斜體、清單、引言、表格、
   程式碼與程式碼區塊、刪除線；單一換行保留為換行。原始 HTML 以文字顯示。程式碼區塊與表格在便箋寬度內
   自己橫向捲動，便箋本身不出現橫向捲軸。主人自己的訊息維持純文字。
3. FR-3：連結與圖片。http(s) 連結以系統瀏覽器開啟，便箋不換頁；其他連結不可點，滑過時以 title 顯示
   目標；遠端圖片不載入，顯示為指向該圖片的連結。殼拒絕任何頁面開新視窗或換到別的網址。
4. FR-4：工具卡片。同一次工具呼叫（`tool_use` 與其 `tool_result`，以 `toolId` 對應）顯示為一張卡片：
   預設收合，顯示工具名稱、一行摘要與狀態（執行中、完成、錯誤）；展開後看到輸入與結果全文。
   沒有 `toolId` 的項目各自成卡。
5. FR-5：主人的決定。對應到 `awaiting_owner` 工作項的系統訊息顯示「Approve」與「Deny」按鈕，按下後呼叫
   `resolveApproval`；已決定、已過期或已不在等待的項目只顯示結果，沒有按鈕。
6. FR-6：設定與首次啟動頁以 React 重寫，功能與 SPEC-002 FR-1–FR-6 相同，並保留這些既有行為：
   model 清單只採用最新一次請求、載入中不能存檔、查詢失敗時仍可留空或輸入 model id、切回已存的
   provider 時預選已存的 model、Notes 分頁在視窗取得焦點時更新、改名進行中不被事件重繪打斷。

## Acceptance

- A1：一段含標題、清單、表格、程式碼區塊與連結的回覆在 340 px 寬的便箋裡正確顯示，便箋沒有橫向捲軸。
- A2：點回覆裡的 https 連結，預設瀏覽器開啟該網址，便箋仍在原頁；點本機路徑的連結沒有反應。
- A3：一個會用工具的回合在便箋上顯示收合的工具卡片，展開後看到輸入與結果。
- A4：`ask_owner` 的問題在便箋上有按鈕，按 Approve 後工作項完成、按鈕消失。
- A5：既有的驗收腳本（設定頁 model 競態與存檔、桌面層便箋的抬起、背景便箋的未讀）在新頁面上照樣通過。
- A6：打包後的安裝檔第一次開啟出現首次啟動頁，建立 bot 後 home 便箋可以對話。

## Non-Goals

- 與 Cats Desktop 共用元件或套件（ADR-003 §1）。
- 主人訊息的 markdown、編輯或重送訊息、附件。
- 浮動貓改用 React。
