# ADR-003: Build the Renderer with React and Vite, Like Cats Desktop

## Status

Accepted — 2026-10-28。owner 問便箋裡的畫面是否與 Cats Desktop 對話畫面同一套技術（React），得到
「不是」的答覆後，同意整合並要求切 slice 實作。規格見
[SPEC-003](../specs/SPEC-003-note-reading-and-the-react-renderer.md)，實作見
[PLAN-003](../plans/PLAN-003-react-renderer.md)。

## Context

- PLAN-001 與 PLAN-002 的頁面（便箋、設定與首次啟動、浮動貓）是 `assets/renderer/` 下的純 HTML、CSS
  與無型別的 JS，由 Electron 直接載入，沒有建置步驟。
- 便箋以 `textContent` 顯示訊息：agent CLI 的回覆幾乎都是 markdown，粗體、清單、表格與程式碼區塊都以
  原始字元出現；工具呼叫只有一行「⚙ 名稱 參數」。
- renderer 讀的資料型別（`BotHostEvent`、`ConversationRecord` 等）在 core 有定義，但 JS 頁面看不到；
  core 改了欄位，頁面不會報錯。renderer 也沒有任何自動測試：2026-10-28 Codex 審閱的設定頁 model
  選單競態就是在這裡漏掉的。`settings.js` 已 573 行命令式 DOM 程式。
- Cats Desktop（cats-platform）的對話畫面是 React 18.3.1 + Vite 7，訊息以 `react-markdown` 10 加
  `remark-gfm`、`remark-breaks` 渲染，連結與圖片的處理規則在 `MessageBodyMarkdown.tsx`。
- ADR-001 規定 bot 只透過 HTTP 依賴 cats-runtime，不依賴 cats-platform；Desktop 的元件也綁著
  react-router、貓的 mention 解析與 platform API。

## Decision

### 1. 同一套技術，自己的實作

renderer 改用 React 18.3.1 + Vite 7 + TypeScript，版本與 Desktop 相同；markdown 用 `react-markdown`
10、`remark-gfm` 4、`remark-breaks` 4。不 import cats-platform 的任何程式或套件；Desktop 的規則
（例如連結與圖片的處理）照著移植並註明出處。日後若要跨 repo 共用 UI，另寫 ADR 拆成共用套件。

### 2. 建置與載入

- 原始碼在 `src/renderer/`，Vite 多頁建置到 `dist/renderer/`（`base: './'`），殼以 file:// 載入。
  頁面名稱（`note.html`、`settings.html`、`floating.html`）與查詢字串（`?conversation=`、
  `?mode=setup`、`?tab=`）不變，是殼與頁面之間的契約。
- preload 仍是 `assets/preload.cjs`（sandbox 的 preload 不能是 ES module），圖示仍在 `assets/`。
- `npm run build` 依序跑 `tsc` 與 `vite build`；Package workflow 與 CI 不必改。
- 2026-10-28 實測：Vite 輸出的 `<script type="module" crossorigin>` 在 Electron 41 以 file:// 載入正常，
  頁面的 CSP（`script-src 'self'`、`style-src 'self'`）不必放寬。

### 3. 型別與邊界

- renderer 在執行期只透過 `window.catsBot`；它的型別寫在 `src/renderer/bridge.ts`。
- renderer 只能從 core 取型別，而且只能 `import type` 自 `src/core/types.ts`（被抹除、不進 bundle）。
  殼要給頁面看的命令結果型別（`BotStatus`、`ProviderInfo`、`ModelCatalog`、`TelegramStatus` 等）
  因此搬進 `types.ts`，原模組改為轉出。不 import `electron` 或 `node:*`。架構邊界測試檢查這些規則，
  另一個測試比對 bridge 的命令與層清單和殼的 `HOST_COMMANDS`、`NOTE_LAYERS`，以及 preload 是否實作
  bridge 的每個方法。
- `tsc -p tsconfig.renderer.json`（DOM、JSX）檢查 renderer；Node 端的設定排除 `src/renderer`。

### 4. 哪些頁面用 React

便箋與設定（含首次啟動）用 React。浮動貓維持不用框架的 TypeScript：它很小，又依賴每次滑鼠移動的
命中測試，多一層框架沒有好處。

### 5. 可測試的邏輯

不碰 DOM 的邏輯（連結規則、逐字稿整理成卡片、model 清單的請求序號等）寫成獨立的 `.ts` 模組，以
`node:test` 測試；Node 的 type stripping 不支援 JSX，所以元件本身以 CDP 在真的殼裡驗收。

### 6. 第三方授權

React 等套件被打包進 `dist/renderer`，列為 devDependencies，不經 node_modules 出貨。建置時產生
`dist/renderer/THIRD-PARTY-NOTICES.txt`，列出每個被打包的套件、版本、授權與其授權檔全文。

### 7. 內容安全

- 不渲染 agent 回覆裡的原始 HTML（以文字顯示）；`react-markdown` 預設會丟掉不安全的 URL 協定。
- http(s) 連結交給系統瀏覽器，其他連結（本機檔案、錨點）不可點並以 title 顯示目標；遠端圖片不自動
  載入，只顯示為連結。殼拒絕頁面開新視窗與換頁。
- 不使用 inline style（CSP 的 `style-src 'self'` 會擋），一律用 class。

## Consequences

- 便箋可以讀 markdown、看工具卡片、按 approval；設定頁的邏輯有型別與測試。
- 多一個建置步驟與兩份 tsconfig；改頁面要重跑 `npm run build`（或 `npm run build:renderer`）。
- 安裝檔多出 React 與 markdown 套件約數百 KB，相對 Electron 本體可忽略。

## Alternatives Considered

- **維持純 JS，只加一個 markdown 函式庫（例如 marked + DOMPurify）**：能解決 markdown，但型別、測試與
  設定頁的維護問題不變，也與 Desktop 分歧。
- **直接 import Desktop 的元件**：會讓 bot 依賴 cats-platform，違反 ADR-001。
- **浮動貓也改 React**：沒有收益，反而要重新驗證滑鼠命中與拖曳。
