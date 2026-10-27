# ADR-001: Build a Resident Bot Core on cats-runtime with Disposable Presentation

## Status

Accepted — 2026-10-27 由 Claude 融合兩份獨立研究文件撰寫；同日 owner 指示依 PLAN-001 開始實作，視為核准。
核准只代表方向與分段被接受；實作進度見 PLAN-001。
同日依 Codex 的審閱修訂：§1 的 discovery 隔離改為對準 runtime 的每條通道（不改 session 目錄），
§5 的對帳改為依 runtime 的 session 狀態分類，`initializing` 與 `busy` 受保護。
規格見 [SPEC-001](../specs/SPEC-001-resident-bot-core-and-global-execution.md)，
實作見 [PLAN-001](../plans/PLAN-001-resident-bot-core-foundation.md)。

## Context

### owner 的方向

- 一個執行檔就是一隻 bot，背後包著一個 agent CLI。
- bot 要「活著」：不論靠 heartbeat、scheduler 或 event driven，隨時可以被喚醒回話或做事；
  這是第一優先，桌面層與拖曳其次。
- 有 tray icon；對話是便箋，可以有多張；整隻 bot 只有一組全域 provider/model，不按對話設定。
- 不確定新成員該直接依賴 cats-runtime，還是依賴 cats-platform。

### 兩份研究，互不參照

2026-10-27 有兩份針對同一題目、刻意互不閱讀的研究：

- [Standalone Living Bot Feasibility](../research/2026-10-27-standalone-living-bot-feasibility.md)（Claude）：
  釐清 Catlas 是 Guide Cat、「活著」的機制在 companion 的 life loop（platform ADR-127）；盤點 runtime
  的受管啟動與 wakeup 原語；列出依賴方向 A–D 四個選項並傾向直接依賴 runtime；提出候選拓樸、
  殼分兩階段，並留下便箋與 session 對應、殼的選型、多 bot 成本等開放問題。
- [Resident Bot Architecture Assessment](../research/2026-10-27-resident-bot-architecture-assessment.md)（Codex）：
  主張架構優先序是「工作能在殼關閉或重建後存活的常駐核心」；指出一隻 bot 不等於一個 PID；給出
  bot profile / conversation / note view / work item / run 的概念邊界；把活著拆成事件、排程、
  深思心跳三條輸入路徑加一個不呼叫模型的健康對帳迴圈；列出最小復原設計、量測項目與交付切片。

兩份文件獨立得出相同結論的部分，本 ADR 直接採納：

- 直接依賴 cats-runtime，走 process + loopback HTTP 契約；不 import cats-platform；不做 .catsapp。
- platform 的 life loop、心跳、turn gate、Telegram polling 與 desktop/host 模式是可抄的設計參考，
  不是可依賴的套件（`exports` 只有 `.` 與 `./app-sdk`）。
- runtime 的 wakeup 只會重新接回 worker、從不送 prompt，不是排程器也不是心跳系統（runtime SPEC-012）。
- desktop-work-fleet 提供已驗證的原生殼與兩個教訓（隱藏 WebView 計時器被節流；桌面視窗沒有
  redirection surface），但它的「非視覺常駐核心」只是提案（fleet ADR-058），不能假設抄殼就得到核心。
- 桌面層、角色形象與跨平台原生宿主需要各自的原生驗收證據，不屬於第一個可用的 bot。

兩份文件互補或分歧的部分，本 ADR 的取捨如下：

- 便箋與 session 的對應：Claude 留為開放問題；Codex 主張每個對話各自有 session attachment、
  延遲建立、bot 範圍序列化佇列、背景觸發必須有明確目的地。採 Codex 的對話模型，並加上
  一個「主對話（home）」作為 life loop 唯一保溫的 session 與心跳目的地（§4）。
- 生命週期保證的強度：Claude 提議第一階段用 Electron、關窗仍活著；Codex 要求第一份 ADR 明示
  「隱藏視窗運作」與「核心不依賴圖形初始化」之間的取捨。本 ADR 把 bot core 定義為可無頭執行、
  不依賴 Electron 的模組，第一階段在 Electron 主程序內掛載，並寫明邊界與改為獨立程序的觸發條件（§2）。
- 排程：Claude 提議用 runtime wakeup 當 cron 計時器；Codex 指出 wakeup 只針對 runtime session、
  沒有 retry、也不是耐久的 bot 身分。採 Codex：bot 自己的 journal 才是排程真相來源（§5）。
- 心跳：Claude 直接沿用 ADR-127 的間隔常數；Codex 強調安靜的心跳也是真回合、要有預算。採兩者：
  預設沿用 ADR-127 的形狀，但每隻 bot 可關閉並須量測（§5）。
- 權限：Codex 補上「沒有視窗開著時收到核准請求」的處理；Claude 的盤點指出 companion 以全自動
  權限執行。採 Codex：背景回合與互動回合使用同一組可強制的 runtime 權限，核准請求在 inbox 等待（§7）。

### 2026-10-27 核對過的事實

- cats-runtime main 為 0.6.2（`5212fa59`），npm `latest` 為 0.6.1；套件 `type: module`，
  `bin.cats-runtime` 指向 `build/runtime/index.js`；`CATS_RUNTIME_MAX_SESSIONS` 預設 50。
- 受管啟動：`--startup-mode app-managed --managed-by <name> --ready-output json --host --port`，
  stdout 送 `runtime.ready` / `runtime.startup_error` / `runtime.stopping` / `runtime.stopped`，
  關閉子程序 stdin 即可攜式地結束它
  （[api.md](../../../cats-runtime/docs/api.md)「App-Managed Lifecycle Events」）。
- session 端點：`POST /sessions`（可帶 `instructions`、`workspaceKind`、`workspaceAccess`、
  `mcpServers`、`sessionKey`）、`POST /sessions/{id}/messages`（SSE 或 NDJSON；忙碌 409 且沒有佇列、
  無 worker 404、worker 已退出 410；guardrail 403/429）、`resume`、`cancel`、`close`、`observe`、`history`。
- wakeup：`target.kind` 只有 `session`，cron 只接受 UTC，沒有 retry/backoff，觸發只做 `ensureSessionAwake`。
- session 狀態只有 `initializing | ready | busy | closing | closed`（runtime `src/core/types.ts`）；
  FileWatcher 把前三者當成活著的 session（`src/backends/cli/discovery/FileWatcher.ts`）；platform 的
  companion loop 刻意讓 `initializing` 的 session 由第一次心跳帶到 ready（`companion/life/loop.ts`）。
- session discovery 有四條通道：file-backed FileWatcher（provider 的 session 目錄，同一目錄也供
  `history` 與 pi resume 讀取）、背景 native `listSessions()` 掃描與 agent discovery（同受
  `CATS_RUNTIME_NATIVE_DISCOVERY_INTERVAL_MS` 控制，預設 5000，`0` 關閉；`src/server.ts`）、WSL／Docker
  policy（`always | if_running | manual_only`；`src/backends/cli/config.ts`）、明確的 `/sessions/discover`
  端點。沒有 worker 的 discovered session 不計入 `maxSessions`（`WorkerPool` 只數活著的 worker）。
- cats-platform 對 runtime 沒有 npm 依賴（HTTP、釘 SHA）；companion life loop 的常數：60 秒 tick、
  閒置 15 分鐘入睡、心跳醒後 2–10 分鐘、之後 30–120 分鐘、主人 10 分鐘內講過話就延後、busy 4 分鐘重試、
  失敗 30 分鐘重試、承接包 12,000 字元上限（ADR-127、SPEC-124）。
- platform 的 2026-10-26 修正（PR #319、#321、#327）定義了三個必須保住的行為：首回合可由心跳執行、
  睡醒 resume 與 retarget 區分且 retarget 不 resume 舊 provider、回覆分段依序送達。

## Decision

### 1. 只依賴 cats-runtime，走 process + HTTP 契約

- `@cats-inc/cats-bots` 的唯一執行依賴是 `@cats-inc/cats-runtime`，在 `package.json` 釘**精確版本**
  （撰寫時 npm 上是 0.6.1；0.6.2 尚未發布）。升級 runtime 是一個獨立、要跑契約測試的變更。
- bot 以 app-managed 子程序啟動 runtime：`--startup-mode app-managed --managed-by cats-bots
  --ready-output json --host 127.0.0.1 --port <port>`，port 由 core 啟動前預留（0.6.1 拒絕 `--port 0`，
  PLAN-001 Phase 1 實測），從 `runtime.ready` 取得實際 port，再以 `GET /health` 確認；私有 `CATS_RUNTIME_DIR` 在 bot 的資料根目錄下；`CATS_RUNTIME_API_KEY` 由 bot 產生；
  關閉時先關 stdin，逾時再 SIGTERM。
- 隔離外部 session 要對準 runtime 的每一條 discovery 通道，不能只處理一條：
  - 背景的 native CLI `listSessions()` 掃描與 agent（ACP）discovery 同受
    `CATS_RUNTIME_NATIVE_DISCOVERY_INTERVAL_MS` 控制，bot 設為 `0` 關閉；`CATS_RUNTIME_WSL_DISCOVERY_POLICY`
    與 `CATS_RUNTIME_DOCKER_DISCOVERY_POLICY` 設為 `manual_only`；bot 永不呼叫任何 `/sessions/discover`
    類端點。
  - file-backed discovery（runtime 對 claude、codex、copilot、pi 等 provider 的 session 目錄掛
    FileWatcher）**不用改目錄來關**：同一個目錄也是 runtime 讀 `history` 與 pi resume 的來源，指向
    空資料夾會弄壞 bot 自己的 session。bot 接受這些 `origin: 'discovered'` 項目存在——它們沒有 worker、
    不計入 `CATS_RUNTIME_MAX_SESSIONS`——在所有列表中忽略，並只以自己的 attachment 記錄辨識自己的
    session，從不靠掃描 `GET /sessions` 認親。
  - 若量測顯示監看使用者整個 session 目錄的成本不可接受，向 runtime 提「關閉 file-backed discovery
    但保留 `history` 讀取」的旗標，不在本 repo 繞路。
- 不 source import runtime（`createRuntimeServer` 是 tests/dev embedding，runtime ADR-009）。
  若日後程序開銷證明有問題，in-process 嵌入才成為另一份 ADR 的題目。
- cats-platform 只是設計參考。抄 life loop、心跳 prompt 形狀、session turn gate、Telegram long polling、
  desktop/host 的 tray 與單一實例模式時，在檔頭註明來源檔與 revision；兩個 repo 皆為 MIT。
  永不 import `@cats-inc/cats-platform`，也不做 .catsapp、不做 platform server 的薄客戶端。
- 每隻 bot 擁有自己的 runtime 實例。多 bot 共用 runtime 留待多 bot 真的存在後量測再議。

### 2. 常駐核心擁有一切耐久狀態，殼是可拋棄的

- **bot core** 是 TypeScript/Node 模組，不得 import Electron、DOM 或任何 renderer 程式碼，
  可以無頭執行（`cats-bot` CLI 入口，供開發、CI 與未來的服務模式）。它擁有 bot profile、對話、
  工作佇列與 journal、runtime 監督，以及**所有計時器**。fleet 的教訓：隱藏 WebView 的計時器會被
  節流到約一分鐘一次，所以計時器永遠不在 renderer。
- **殼**（tray、便箋視窗、未來的角色形象）只是 core 的客戶端，經由一個窄的命令／事件介面
  （SPEC-001 的 `BotHostApi`）開關視圖、送主人訊息、取消、讀未讀與進度；拿不到 runtime 的
  URL 與 API key。
- 第一階段的生命週期保證是「**隱藏視窗運作**」：所有視窗關閉時 bot 仍在跑，直到 OS 睡眠、登出、
  明確 Quit 或 core 致命錯誤為止。這與 platform ADR-127 的邊界相同；喚醒睡著的電腦與未登入
  執行是另一個 OS 整合決策。
- 第一階段把 core **在 Electron 主程序內掛載**（一棵程序樹：Electron main + runtime + CLI 子程序，
  便箋開著時才有 renderer）。理由：Electron 主程序在任何視窗之前啟動，GPU 或 renderer 失敗不會
  帶走它，而獨立程序與本機 IPC 的成本不該在無頭 core 存在之前先付。
- 改為獨立程序的觸發條件寫死在這裡：一旦有證據顯示殼的失敗（fleet ADR-058 記錄的登入時圖形裝置
  初始化失敗一類）會殺掉 core，就把 core 移到獨立的子程序或根程序。`BotHostApi` 的設計必須讓
  這是封裝層的改動，不是 core 的改動。
- 「一個 exe 一隻 bot」的意思是一個獨立受管的實例：自己的身分、資料根目錄、tray、單一實例鎖。
  它不是一個 PID：CLI 是子程序，Electron 與 WebView2 本身都是多程序。

### 3. 一隻 bot、一個身分、一組全域 execution target

- 每個 bot 實例有一份 `BotProfile`：穩定 id、名字、人設 instructions、`executionTarget { provider, model }`、
  權限政策、心跳政策、資料根目錄。
- `executionTarget` 是整隻 bot**唯一**的 provider/model 設定（形狀同 platform 的 `GuideCatRecord`）。
  對話沒有覆寫。每個回合在被接納（admission）時讀取當下的 target。
- 全域變更時，進行中的回合在它被接納時的設定下跑完或被明確取消；之後的回合用新設定。
  在另一個 provider 下建立的 session attachment 一律標為 stale、不 resume，只因 id 還在不是
  繼續用的理由（PR #321 的教訓）。每個 run 記錄實際用到的 provider/model 作為歷史證據，不是第二個設定。

### 4. 對話、便箋與 session

- **對話**擁有自己的 transcript（bot 自己存，與 provider 無關）、有上限的承接脈絡，以及至多一個
  runtime session attachment；attachment 延遲建立或 resume，不會因為開了三張便箋就預留三個熱的 CLI worker。
- **便箋**是對話的視圖（位置、大小、可見、層）。多張便箋可以顯示不同對話；關便箋、刪對話、
  結束 bot 是三件不同的事。
- 每隻 bot 恰有一個**主對話（home）**，也就是 inbox：life loop 只替它保溫 session；心跳與一般性的
  主動訊息只送到這裡；與某件工作相關的觸發送回它的原對話。目的地永遠明確，絕不隱含地選
  「最近聚焦的便箋」，也不把每張便箋的私有脈絡注入每次心跳。
- 非 home 的對話套閒置政策：閒置後關 worker、保留 session id，下次需要時原生 resume。
- 跨對話共用的 bot 記憶是「經挑選的事實與未了承諾」，與各對話的原始 transcript 分開；v1 只做每個
  對話自己的承接包（12,000 字元上限，短對話原文、長對話 digest 加近期內容），共用記憶延後。
- 否決「一隻 bot 只有一個 session、便箋都是它的視圖」：便箋脈絡會互相混入，而且每張便箋的回合
  都得在同一個 provider session 上排隊。home 設計保留了「只有一個 session 保溫」的好處。

### 5. 「活著」的定義：三條輸入路徑、一條管線、一個不呼叫模型的對帳迴圈

- 三條輸入路徑都走同一個接納與執行管線，產生同一種**工作項**（work item）：
  - **事件**：主人訊息（便箋，之後是 Telegram）、工作完成、明確設定的外部輸入。事件驅動
    提供即時性而不需要週期性模型呼叫。
  - **排程**：一次性與週期性工作，持久化在 bot 自己的 journal，有觸發 id、目的地對話、接納狀態、
    錯過政策（skip / coalesce / run once）與有界重試。「三十分鐘後提醒我」必須經由 host 操作建立
    一筆真的排程並回傳收據；模型口頭答應不算。runtime wakeup **不是**排程真相來源：它只針對
    runtime session、UTC cron、沒有 retry、從不送 prompt。
  - **深思心跳**：以隨機間隔送進 home 對話的隱藏回合，附本地時間、醒了多久、主人上次說話距今多久
    與承接包，不想說就回 `[quiet]` 由 core 丟棄。預設沿用 ADR-127 的形狀（醒後 2–10 分鐘、之後
    30–120 分鐘、主人 10 分鐘內講過話就延後、busy 4 分鐘重試、失敗 30 分鐘重試）。即使安靜也是
    真的 provider 回合、消耗額度；每隻 bot 可關閉，且 SPEC-001 要求量測。
- **對帳 tick**（每 60 秒，啟動後 5 秒第一次，不重疊，不呼叫模型）：檢查 runtime 健康與自己擁有的
  子程序，runtime 意外退出就帶退避重啟；以 runtime 回報的 session 狀態對帳 home 的 attachment——
  `initializing`、`ready`、`busy` 都是活著：`initializing` 由下一個回合（含心跳）帶到 ready，與 platform
  的 loop 相同；`busy` 是進行中的回合，對帳絕不 resume、重建或取消它；只有 `closing`／`closed`，或
  runtime 回 404 不認得這個 session，才 resume 或重建（失敗退避 5 分鐘並記原因）；觀測失敗（連不上、
  逾時、5xx）視為「未知」，不做任何動作——然後掃描 journal 的到期排程與重啟前殘留的 `running`
  工作項。runtime 重啟後 home 在一個 tick 內自己醒回來。
- v1 的佇列是 bot 範圍序列化：同一時間只跑一個回合。主人訊息優先於背景工作；進行中的回合不被
  隱含打斷，取消一定是明確的動作。core 持有以 runtime session 為鍵的 gate，不讓自己的並發撞出
  409（runtime 沒有佇列）。

### 6. 耐久性與復原

- 每隻 bot 一個資料根目錄（預設 `~/.cats/bots/<bot-id>/`，可用環境變數覆寫），單一寫入者；
  寫入一律暫存檔加 rename，讀取絕不順手寫回（platform `FileChatStore` 與 `FileCompanionBoxStore`
  的既有 bug 都是這樣來的）；每個檔案帶 `schemaVersion`。
- journal 記錄工作項的 queued、running、awaiting_owner、completed、failed、cancelled、interrupted
  （結果不確定）七種狀態，以及結果與通知投遞狀態；重開視窗從 journal 重建真相，不需要原始事件流。
- journal 不能承諾外部效果的 exactly-once。CLI 做完動作、結果尚未落盤時當機是不確定的：重啟時
  以證據（runtime 的 `history` / `observe`）對帳，或標為 `awaiting_owner` 請主人決定；絕不盲目
  重播所有被中斷的工作，也不重播無上限的積壓。
- 發布前不承諾資料遷移；一旦發布，cats-inc 的版本與升級政策（有測試的升級路徑、備份、原子替換、
  失敗復原）適用。

### 7. 權限與核准

- 背景回合與互動回合使用同一組可強制的 runtime session 設定（`workspaceAccess`、`permissionMode`、
  `allowedTools`、`cwd`），由 bot profile 的權限政策決定；抄 companion 的 prompt 或它的全自動模式
  不等於這隻 bot 的權限政策。
- 模型在沒有視窗開著時提出的核准請求，成為 `awaiting_owner` 工作項，顯示在 tray 與 home 對話；
  永不自動核准；逾時以原因收尾。
- 永不讀取任何 CLI 的憑證檔；額度只從 runtime 轉發的 CLI 訊號取得。

### 8. 殼的路線

- 第一階段（Windows 優先）用 Electron：tray、無邊框便箋視窗、可選 always-on-top、螢幕內拖曳、
  關閉即藏到 tray、明確 Quit、可選開機啟動、每個 bot id 一把單一實例鎖；沿用 platform
  `desktop/host` 的 tray 與 candidate profile 模式。
- 桌面層／桌布層、角色形象、macOS 與 Linux 原生宿主留給**另一份 ADR**，前提是每個宣稱的平台都有
  DPI、焦點／IME、Explorer 與顯示器遺失復原的原生驗收。候選是「Electron 加原生 helper 移植 fleet
  的 WorkerW / `SHELLDLL_DefView` 掛載法」與「採用 fleet 的 C#/WPF/WebView2 宿主、core 作子程序」。
- 在 SPEC-001 的量測表填完之前，不對任何殼宣稱記憶體或啟動時間優勢；較小的 renderer 或單一
  執行檔本身不是較低總工作集的證據。

### 9. 讓第一個切片能開工的 repo 工具鏈

- TypeScript、Node 24、ESM（`"type": "module"`、`NodeNext`），與 runtime 一致；`tsc` 負責型別檢查與建置。
- 測試用 `node:test`，以 Node 24 原生的 type stripping 直接跑 `.test.ts`；因此原始碼只用可擦除的
  TypeScript 語法（不用 enum、namespace、parameter properties）。不採用 bootstrap 樣板的 jest / eslint
  工具鏈；prettier 可留。
- 打開 CI 的 Node job：`npm ci`、typecheck、test、build。
- 加一個架構邊界測試：core 不得 import `electron` 或任何 `cats-platform` 路徑；殼不得直接持有
  runtime client。

### 10. 現在明確不做

- 多 bot 共用 runtime；作息（就寢／起床）——v1 只有閒置政策；生圖與相簿；行動端；OS 層級從睡眠喚醒
  或未登入執行；Telegram webhook ingress（加入時只做 long polling）；桌面層。

## Consequences

### Positive

- 不需要 Cats Desktop、platform server 與它的產品儲存就能跑；直接重用 runtime 的 16 個 CLI adapter、
  resume、串流、取消與 session MCP。
- 無頭的 core 可以在沒有 UI 的情況下測試與驗收，並可換殼；計時器免疫於 renderer 節流。
- 對話脈絡不混；只有一個設定要管；真相在關窗與重啟後都還在。
- 滿足 platform ADR-110 第 7 點的耐久邊界：獨立的發行週期與版本化的 runtime 契約。

### Negative

- 每隻 bot 常駐 Node core、runtime 與 CLI（有殼時再加 Chromium），成本隨 bot 數線性放大；
  心跳即使安靜也用額度。
- runtime 仍是 0.x，契約會漂移；只能靠釘版本與契約測試，升級是刻意的工作。
- 第一階段的隱藏視窗保證弱於完全隔離的 core：殼當掉時 bot 跟著停，直到開機啟動或主人重開。
- 重做承接、gate 與 polling 這些 platform 已修過的行為有退步風險；PR #319、#321、#327 的行為成為
  SPEC-001 的驗收項。

### Neutral

- 「結果不確定」是第一級狀態；journal 不假裝 exactly-once。
- 工作管理員會看到好幾個程序；「一個 exe」是一棵程序樹。
- 第一階段選 Electron 不是對桌面層階段的承諾；殼的技術在第五階段重新評估。
- 從 platform 抄來的模式以 MIT 與來源註記保存；尚未抽出共用套件，ADR-110 第 4、6 點日後可能改變這點。
- 使用者自己的 CLI session 會以 discovered 項目出現在 bot 私有 runtime 的登錄裡（§1）；bot 忽略它們，
  成本在第三階段量測。

## Alternatives Considered

### Alternative 1: 依賴 cats-platform

- **Pros**：重用最多（companion、dispatch、Telegram、承接包都在那裡）。
- **Cons**：`exports` 沒有這些介面；邏輯綁在 ChatState 單一 JSON 快照與程序內 gate；要先做
  ADR-110 第 4、6 點的套件抽取。
- **Why rejected**：現在不存在可依賴的邊界。platform 若發布 transport / client 套件再評估。

### Alternative 2: 做成 .catsapp

- **Pros**：在 Cats Desktop 內即可分發。
- **Cons**：不能擁有視窗、tray、開機項；Cats 關掉就死；`jobs.schedule` 只有 manifest 驗證、沒有執行者。
- **Why rejected**：與「獨立 process、大幅輕量化」相反。

### Alternative 3: platform server 的薄客戶端（像 Mobile）

- **Pros**：幾乎不用寫執行邏輯。
- **Cons**：不是 standalone，仍需要 Desktop 或無頭 platform 常駐。
- **Why rejected**：不符合核心訴求。

### Alternative 4: 用 runtime wakeup 當 bot 的排程器

- **Pros**：runtime 已有 1 秒 tick、cron recurrence 與重啟後重播。
- **Cons**：SPEC-012 明文不是排程器與心跳系統；只針對 session、不送 prompt、UTC only、沒有 retry。
- **Why rejected**：排程需要綁 bot 與對話身分、錯過政策與重試；由 core 的 journal 擁有。

### Alternative 5: Electron 主程序就是 core，不設無頭入口

- **Pros**：原型最快。
- **Cons**：core 與殼綁死，換殼或拆程序等於重寫；殼的失敗一定帶走 core。
- **Why rejected**：作為**邊界**被否決，作為第一階段的**掛載方式**被接受（§2）。

### Alternative 6: 以 fleet 的 C#/WPF/WebView2 宿主當第一個殼

- **Pros**：三層桌面層、tray、單一實例、MSIX 已在真機驗證。
- **Cons**：多一套 .NET 工具鏈；它的常駐核心拆分未實作（fleet ADR-058）；第一個價值是無頭 core。
- **Why rejected**：延後到第五階段再比較，不是否決。

### Alternative 7: 所有 bot 共用一個 runtime

- **Pros**：少幾個程序與重複基礎設施。
- **Cons**：共用容量、設定、關閉擁有權與可用性都要協調。
- **Why rejected**：延後到多 bot 真的存在後量測。

### Alternative 8: 一隻 bot 一個 session、便箋只是視圖

- **Pros**：永遠只有一個熱 worker、一個目的地。
- **Cons**：便箋脈絡互混；所有便箋回合在同一個 provider session 上序列化。
- **Why rejected**：§4 的 home 對話保留了單一保溫 session 的好處而不犧牲隔離。

## References

- [Standalone Living Bot Feasibility](../research/2026-10-27-standalone-living-bot-feasibility.md)（Claude）
- [Resident Bot Architecture Assessment](../research/2026-10-27-resident-bot-architecture-assessment.md)（Codex）
- [SPEC-001](../specs/SPEC-001-resident-bot-core-and-global-execution.md)、
  [PLAN-001](../plans/PLAN-001-resident-bot-core-foundation.md)
- cats-runtime：[docs/api.md](../../../cats-runtime/docs/api.md)、
  [ADR-009](../../../cats-runtime/docs/decisions/009-keep-cats-runtime-separately-packageable-with-app-managed-local-startup.md)、
  [SPEC-012](../../../cats-runtime/docs/specs/SPEC-012-scheduled-wakeup-substrate.md)
- cats-platform：[ADR-003](../../../cats-platform/docs/decisions/003-electron-host-manages-local-services.md)、
  [ADR-110](../../../cats-platform/docs/decisions/110-keep-platform-clients-in-one-repository-with-explicit-package-boundaries.md)、
  [ADR-127](../../../cats-platform/docs/decisions/127-keep-companion-cats-alive-with-a-platform-owned-life-loop.md)、
  [SPEC-124](../../../cats-platform/docs/specs/SPEC-124-alive-companion-life-loop.md)、
  [PLAN-117](../../../cats-platform/docs/plans/PLAN-117-alive-companion-life-loop.md)
- desktop-work-fleet：[ADR-017](../../../../sammykenny2/desktop-work-fleet/docs/decisions/017-windows-composition-surface-and-input.md)、
  [ADR-030](../../../../sammykenny2/desktop-work-fleet/docs/decisions/030-windows-explorer-wallpaper-layer.md)、
  [ADR-058](../../../../sammykenny2/desktop-work-fleet/docs/decisions/058-desktop-presentation-lifecycle-and-core-isolation.md)
- cats-inc 版本與升級政策：[cats-one release guide](../../../cats-one/docs/release-guide.md)
- 相對路徑以 cats-inc 開發者工作區的並排 checkout 為準；fleet 位於 `../sammykenny2/desktop-work-fleet`。

---

*Decision made: 2026-10-27 (accepted)*
*Decision makers: Product owner (approved by authorizing PLAN-001 on 2026-10-27), Claude (author; fuses the Claude and Codex research)*
