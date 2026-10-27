# Standalone Living Bot Feasibility

Date: 2026-10-27
Scope: 唯讀的原始碼與文件盤點，對象是 cats-inc 現有成員與 `../sammykenny2/desktop-work-fleet`。
本輪沒有執行任何程式、沒有建立 Runtime session、沒有呼叫 provider、沒有寫入任何既有 repo。
這是研究紀錄，不是 ADR：下列「候選拓樸」與「建議」都是待決議的提案，沒有任何一項已被採納。

Baseline（皆為各 checkout 的 `main`）：

| Repo | Version | HEAD |
| --- | --- | --- |
| cats-runtime | 0.6.2 | `5212fa59` |
| cats-platform | Desktop 0.11.1 preview | `0edaffe5` |
| cats-apps | Ask 0.1.0 | `ffddcb7` |
| cats-one | 0.5.0 | `17641cd` |
| cats-plugins | 0.1.0 | `8b62785` |
| desktop-work-fleet | previews 0.4.2 | `fcaa942` |

## User direction

owner 想在 cats-inc 下新開一個成員（暫名 `cats-bots` 或 `cats-agents`），目標是：

- 一個 process（一個 exe）就是一隻 bot，背後包著一個 agent CLI。
- bot 要「活著」：不論靠 heartbeat、scheduler 或 event driven，隨時可以被喚醒回話或做事。
- 有 tray icon 可以 dock；能在桌面上被拖來拖去；最好能嵌在桌布層、桌面層或最上層至少其一，做不到就一般視窗。
- 對話介面大幅輕量化：一個 conversation 像一張便箋，可有多張；只有一組全域 provider/model，代表這隻 bot 背後的 agent，不按 conversation 儲存。
- 不確定新成員應該像 cats-platform 一樣直接依賴 cats-runtime，還是依賴 cats-platform。
- 優先順序：先要一個活著的、包著 CLI 的 bot；桌面層與拖曳是其次。

## Terminology: Catlas is not the companion

owner 以「Catlas 類似的 Bot」描述需求，但在 cats-platform 的程式碼裡這是兩個不同的東西：

- **Catlas = Guide Cat**。`GUIDE_CAT_SYSTEM_NAME = 'Catlas'`
  （[guideCatIdentity.ts](../../../cats-platform/src/shared/guideCatIdentity.ts)）。它是平台層唯一一筆
  `core.guideCat: GuideCatRecord { executionTarget, modelSelection, status }`，也就是**全平台唯一一組全域
  provider/model 綁定**。它的推論走 [inference.ts](../../../cats-platform/src/platform/catlas/inference.ts)：
  每次問答開一個 `sharingMode: 'isolated'`、`workspaceAccess: 'read_only'` 的一次性 session，要求嚴格 JSON
  輸出，用完即關。沒有 DM lane、沒有 Telegram、沒有心跳。視窗內可拖動的 pill 是
  [GuideCatSidecar.tsx](../../../cats-platform/src/design/components/GuideCatSidecar.tsx)，放置模型在 ADR-070。
- **活著的是 companion role 的 Cat**（ADR-124）。它的生命單位是「該 Cat 私訊 lane 上的那一個 Runtime session」，
  由 platform 伺服器程序裡的 life loop 維持，並經 Telegram bridge 共用同一個 lane（ADR-127、SPEC-124、PLAN-117）。
- owner 要的 bot 是兩者合體：Catlas 的形狀（一組全域綁定、可拖動的存在感），加上 companion 的生命機制。

## Local baseline

### cats-runtime 0.6.2

嵌入與消費契約：

- loopback HTTP 服務（預設 `127.0.0.1:3110`，可選 Bearer `CATS_RUNTIME_API_KEY`），路由註冊在
  [http/app.ts](../../../cats-runtime/src/http/app.ts)，完整介面在 [docs/api.md](../../../cats-runtime/docs/api.md)。
- 受管啟動：`--startup-mode app-managed --managed-by <name> --ready-output json`，`--port 0` 由 OS 選 port，
  實際 port 從 stdout 的 `runtime.ready` 事件取得；關閉走 SIGINT/SIGTERM 或關掉子程序 stdin。
- [runtime ADR-009](../../../cats-runtime/docs/decisions/009-keep-cats-runtime-separately-packageable-with-app-managed-local-startup.md)
  要求 host 走 process + HTTP 邊界，不走 source import。`src/index.ts` 雖然匯出
  `loadConfig`、`createRuntimeServer`、`createRuntimeApp`，測試以 `app.request()` in-process 嵌入，但文件把它定位為
  tests/dev embedding，不是產品契約。
- Desktop 的先例：[processSupervisor.ts](../../../cats-platform/desktop/host/processSupervisor.ts) 用 Electron
  自己的執行檔加 `ELECTRON_RUN_AS_NODE=1` 啟動 runtime bundle，並設定 `CATS_RUNTIME_DIR`、
  `CATS_RUNTIME_PACKAGE_ROOT`、host 與 port。
- MCP（`POST /mcp`，約 85 個工具）與 ACP（`POST /acp`）是附加門面；`cats-runtime mcp|acp` stdio 子命令只是代理到
  已在執行的 runtime。

Provider 執行：

- `KNOWN_PROVIDERS` 共 16 個 CLI：claude、codex、antigravity、cursor、copilot、opencode、kilo、goose、pi、auggie、
  junie、kiro、grok、cline、devin、muse（[providers/types.ts](../../../cats-runtime/src/backends/cli/providers/types.ts)）。
  Gemini CLI 已由 Antigravity 取代（runtime ADR-032），Gemini 模型只剩 API backend。
- claude（`-p --input-format stream-json --output-format stream-json`，`--resume`/`--fork-session`）、
  codex（`app-server` JSON-RPC，`thread/start|resume|fork`）與 pi（`--mode rpc`）是每個 session 一個常駐子程序；
  其餘 13 個是 `ephemeral`，每回合重新 spawn 並帶回 `resumeSessionId`。
- 回合契約：`POST /sessions/{id}/messages`，回應預設 SSE，`Accept: application/x-ndjson` 改為 NDJSON；
  事件種類 init/text/tool_use/tool_result/result/error/raw/progress/workspace_activity。
  session 忙碌回 409 且**沒有佇列**；沒有 active worker 回 404「Resume the session first」；worker 已退出回 410。
- 每個 session 可注入 `mcpServers`；MCP server set 變更時 worker 在下一回合邊界被回收。
- 連續性：CLI backend 由 CLI 保存原生 transcript，runtime 只存 `providerSessionId`；API/local backend 由 runtime
  重播自己的 JSONL。`instructions` 與 skills 每回合前置。

活性原語，這是本題最關鍵的限制：

- [RuntimeWakeupService](../../../cats-runtime/src/core/wakeup/RuntimeWakeupService.ts)：1 秒 tick、每 tick 最多
  處理 8 筆、持久化於 `data/wakeups.json`，支援 coalesceKey、一次性 `scheduleAt` 與五欄 cron，**timezone 只接受 UTC**，
  目標只能是 `{kind:'session'}`，沒有 retry/backoff。
- 觸發時只呼叫 `ensureSessionAwake`（[sessionWakeup.ts](../../../cats-runtime/src/core/runtime/sessionWakeup.ts)）：
  用 `--resume` 重新接回 worker，**不送任何訊息**，`metadata` 也不會交給 agent。
  [SPEC-012](../../../cats-runtime/docs/specs/SPEC-012-scheduled-wakeup-substrate.md) 明文「not a general scheduler,
  heartbeat system, or product workflow engine」。
- NDJSON 串流每 30 秒靜默送一個 `progress kind:"heartbeat"`，那是 keep-alive，不是產品心跳。
- runtime 內沒有 webhook、event bus、Telegram、idle reclaim；唯一的事件訂閱是 `GET /sessions/{id}/stream`。
- 其他計時器（CLI transcript 目錄的 FileWatcher、每 5 秒的 native/agent discovery、browser/worktree TTL）都是內務，
  不是 agent 的觸發來源。

程序、儲存與封裝：

- `WorkerPool` 每個 runtime session 一個 `WorkerProcess`，上限由 `CATS_RUNTIME_MAX_SESSIONS` 控制
  （ADR-127 盤點時預設 10，runtime release guide 記錄後來調高為 50；本輪未重新驗證數字）。
  取消為 SIGTERM 後 5 秒 SIGKILL；常駐型 CLI 被取消後 session 變 `closed`，需要 resume。閒置 worker 不會被回收。
- 所有狀態是 `~/.cats/runtime`（`CATS_RUNTIME_DIR`）下的 JSON/JSONL：`config/providers.yaml`、`management.yaml`、
  `data/sessions.json`、`data/wakeups.json`、`sessions/history/<id>.jsonl` 等，沒有資料庫。
  runtime 擁有 session id、resume id、每 session transcript 與 wakeup；conversation、room、task、companion memory、
  presence 都在 platform。
- [bundle-runtime.mjs](../../../cats-runtime/scripts/bundle-runtime.mjs) 以 esbuild 產出單一 ESM 檔，但仍需要
  `node_modules/yaml`、`runtime-skills/`、`config/*.example` 與 catalog JSON，由 `CATS_RUNTIME_PACKAGE_ROOT` 定位。
  沒有需要編譯的原生依賴；Node `>=22.12.0`。
- 遙測只有 `progress` 事件、in-memory metering、`/diagnostics/*` 與被動的 `/usage/snapshot`；
  `POST /usage/refresh` 走各 CLI 自己的控制協定，不讀取任何憑證檔。

### cats-platform 0.11.1

Companion life loop（owner 要的「活著」在這裡）：

- 入口 `startCompanionLifeLoop`（[life/loop.ts](../../../cats-platform/src/products/chat/companion/life/loop.ts)）
  由正式入口 `src/index.ts` 依 `CATS_COMPANION_LIFE_LOOP` 開啟，測試用的 `createServer` 預設不啟動；
  啟動後 5 秒跑第一次，之後每 60 秒 tick 一次且不重疊。
- 每次 tick 對每隻有 DM lane 的 companion Cat：由 `CompanionBox.life` 作息（`rhythm.ts`、`profile.ts`，預設就寢
  23:00、起床窗 07:00 到 09:00）算出期望狀態，向 runtime 查 session 是否存活，該醒而不在就走既有的 channel activation
  路徑喚醒，該睡且 lane 閒置就 deactivate。
- `loop.ts` 的常數：閒置 15 分鐘入睡、`Max sessions` 時退避 5 分鐘、主人 10 分鐘內講過話就延後心跳、
  心跳撞上 busy 4 分鐘後重試、失敗 30 分鐘後重試、剛醒 3 小時內算 greetable。
- 心跳（[heartbeat.ts](../../../cats-platform/src/products/chat/companion/life/heartbeat.ts)、
  [companionLifeLoop.ts](../../../cats-platform/src/products/chat/api/companionLifeLoop.ts)）：剛醒後 2 到 10 分鐘、
  之後每 30 到 120 分鐘隨機一次，送一個不顯示給使用者的回合進**同一個** DM runtime session；回 `[quiet]` 就丟棄，
  其他內容以 Cat 一般訊息寫入 DM lane 並鏡像到 Telegram。持有以 runtime session 為鍵的程序內 gate
  （[sessionTurnGate.ts](../../../cats-platform/src/products/chat/state/runtime-dispatch/sessionTurnGate.ts)），
  讓主人訊息排隊而不是吃到 409。
- 睡眠只關 worker、保留 DM lease 的 session id；醒來且 execution target 相容時經 Runtime resume 接回同一個
  provider-native session；retarget 不 resume 舊 provider。2026-10-26 起每個主動回合都帶同一 DM 的對話承接包
  （12,000 字元上限）、角色、回覆語言、checkpoint 與篩選後的記憶（PR #319、#321）。
- 明文的非目標：沒有 OS 層級背景啟動，Cats 沒開或電腦睡著時貓不會醒（ADR-127 Negative）。

Telegram / DM：

- platform 伺服器程序擁有。預設 long polling（[polling.ts](../../../cats-platform/src/platform/transports/telegram/polling.ts)，
  ADR-029），webhook 可選，經 Desktop 管理的 ngrok/Funnel ingress（ADR-139）。
- 入站經 `bridge.ts` 解析 bound Cat、重用或建立該 Cat 的 DM lane，再進 chat adapter 與
  `runtime-dispatch/routing.ts`（約 7.7K 行）做 ensure/wake/resume 與受監督的 runtime send；
  回覆依序送出、4000 字元切段、照片走 `sendPhoto`，心跳與 Web 起源訊息經 transport fanout 鏡像。
- `TelegramRoomBridge<TState>` 是泛型 port，但唯一實作綁 ChatState；fanout 與 adapter import chat product 程式碼；
  token 以明文存在 core state。Telegram 一個 token 只允許一個 `getUpdates` 消費者。

Desktop host（`desktop/host/`）：

- `main.ts` 約 2.9K 行；主視窗是一般有框視窗，關閉即藏到 tray。可重用的模組：`tray.ts`、`trayMenu.ts`、
  `desktopStartup.ts`（預設開機啟動、不開視窗、留 tray）、`windowPlacement.ts`、`candidateProfile.ts`（單一實例鎖，
  candidate profile 已能隔離 home、userData、port 與 AppUserModelId）、`processSupervisor.ts`（先 runtime 後 platform，
  預期外退出標 `failed` 不自動重啟）、`updateManager.ts`。
- 沒有任何 widget、寵物或桌面層的嘗試。唯一 frameless/transparent 的視窗是 screenshot overlay
  （[screenshotOverlayWindows.ts](../../../cats-platform/desktop/host/screenshotOverlayWindows.ts)：`screen-saver`
  等級 always-on-top、skipTaskbar）與更新對話框的 1×1 隱藏 owner。
- 程序拓樸依 ADR-003：Electron main 監督 runtime 與 platform 兩個 sidecar，renderer 只跟 platform 講話，platform 只跟
  runtime 走 loopback HTTP。

套件與依賴事實：

- platform 對 runtime **沒有 npm 依賴**，只經 `CatsRuntimeClient`（`src/runtime/client.ts`）走 HTTP；Desktop 每次發行以
  SHA 釘 runtime（0.11.1 釘 `5212fa59`）。
- `@cats-inc/cats-platform` 的 `exports` 只有 `.`（Electron main）與 `./app-sdk`；companion、dispatch、Telegram 邏輯
  沒有對外介面。
- conversation 是 Chat channel，與 `CatsCoreState` 一起存成單一 JSON 快照（`chat-state.local.json`），
  `FileChatStore` 在程序內佇列後整檔原子覆寫；provider/model 是每個 conversation 每個 participant 各自設定（ADR-131），
  Catlas 是唯一的全域綁定。
- ADR-110 第 7 點：新 repo 需要至少一個耐久邊界（獨立擁有權、真正獨立的發行週期、穩定的版本化依賴契約，
  或可量測的協調成本下降）；單憑產物格式不足。

App SDK / .catsapp：

- 可以：sandboxed iframe renderer、最多 8 個 frontend、Node service 與 background worker（ADR-125/SPEC-122，仍是 candidate）。
- 不可以：擁有視窗、tray、always-on-top、login item；Cats 關閉後繼續執行；收 Telegram 或驅動 conversation/session；
  `jobs.schedule` 只在 manifest 驗證（`catsAppValidation.ts`），沒有排程執行者；第三方不能跑可執行元件。
- 結論：不適合「一個 exe 一個 bot」。

Catlas 相關文件：ADR-054、061、066、070、SPEC-071（視窗內 floating/docked pill）、ADR-140、SPEC-131、PLAN-123（curated
assist 與 titles）。ROADMAP 開放項：排程或喚醒驅動的 Guide Cat refresh、companion surfaces、missions 與 schedules。
全部文件裡**沒有**桌面 widget、獨立 companion exe 或 bot-as-process 的紀錄。

### desktop-work-fleet 0.4.2

- 它不是 agent fleet。它是 owner 的便箋產品「Work Fleet」：一事一卡、九群 formation、每裝置版面、Google Drive
  appDataFolder 同步。`src/` 沒有任何 `child_process`，沒有 claude/codex/gemini 的呼叫、session resume 或輸出解析。
  Claude Code 的「FleetView」只是撞名。
- 它給的是**已在真機驗證的原生殼**：
  - Windows（.NET 10 WPF + WebView2，`src/native/windows/`）：三層 wallpaper/desktop/floating。desktop 層掛在擁有
    `SHELLDLL_DefView` 的 Explorer host 之下、圖示之上；wallpaper 層掛在 `WorkerW`，沒有現成 host 時以 `0x052C`
    向 Explorer 要求建立（[NativeShellLayers.cs](../../../../sammykenny2/desktop-work-fleet/src/native/windows/app/NativeShellLayers.cs)，
    ADR-030）。floating 層是 per-pixel 透明、只有便箋區域收輸入的 layered window
    （[DesktopSurface.cs](../../../../sammykenny2/desktop-work-fleet/src/native/windows/app/DesktopSurface.cs)，ADR-017）。
  - tray（`Shell_NotifyIcon` v4 + WPF Fluent 選單，`NativeTray.cs`、`core/TrayMenu.cs`，ADR-019）、全域快捷鍵不搶焦點、
    named-pipe 單一實例（`SingleInstance.cs`）、開機啟動與 close-to-tray（ADR-043）、GitHub release feed 更新器
    （`NativeUpdater.cs`，ADR-044）、MSIX 自含封裝（ADR-036）、CrashGuard 先脫離 Explorer 再回報（ADR-045）。
  - macOS AppKit + WKWebView 與 Linux GTK + layer-shell 各有對應宿主（ADR-023、025、031）。
- 兩個直接影響 bot 設計的教訓：
  - 隱藏 WebView 的計時器會被節流到約一分鐘一次，fleet 因此在原生主程序加了 20 秒的 `host-tick`
    （`FleetWindow.cs`）。**bot 的 life loop 與排程必須在主程序，不能放 renderer。**
  - ADR-049：Explorer 桌面視窗沒有 redirection surface，WPF 自繪的內容掛上去後不會上屏，最後靠 windowed WebView2 走
    DirectComposition 才成功。Chromium/Electron 在同一條件下的行為沒有先例。
- ADR-058 + SPEC-009 + PLAN-009（2026-10-20，Proposed，未實作）：把資料權威移到「非視覺常駐 core」，presentation 改為
  可拋棄的子程序、經驗證的本機 IPC、持續的 readiness/recovery 狀態機。這正是 bot 該有的形狀；PLAN-009 Phase 0.3
  還在選非視覺 JS host。

## Dependency direction options

| 選項 | 內容 | 評估 |
| --- | --- | --- |
| A. 直接依賴 cats-runtime | 新成員像 platform 一樣走 process + HTTP 契約，釘 runtime 版本；自己擁有 life loop、事件入口、便箋存檔 | 符合 runtime ADR-009 與 platform 現況；runtime 已是公開 npm 套件；ADR-110 第 7 點的耐久邊界成立（獨立發行週期、版本化契約） |
| B. 依賴 cats-platform | import platform 的 companion/Telegram/dispatch | platform `exports` 沒有這些介面；邏輯綁 ChatState 單一 JSON store 與程序內 gate；要先做 ADR-110 第 4、6 點的 package 抽取才可能 |
| C. 做成 .catsapp | 在 Cats Desktop 內以 App 形式提供便箋 | 不能擁有視窗/tray/開機項，Cats 關掉就死，沒有排程執行者與 session SDK；與「大幅輕量化、獨立 process」相反 |
| D. 薄 presence client | 像 Mobile 一樣只做 platform server 的客戶端 | 重用最多，但不是 standalone，仍需 Desktop 或 headless platform 常駐 |

本輪傾向 A，B 列為未來若 platform 抽出 transport/client packages 時的再評估項，C 與 D 不符合 owner 的核心訴求。
這是研究判斷，決策留給 ADR。

## Candidate topology and alive mechanisms

以下為研究層級的候選，不是已採納的設計。

```text
bot.exe             殼：tray、便箋視窗、單一實例、updater
  └─ bot core       Node：life loop、事件入口、全域 provider/model、便箋存檔
       └─ cats-runtime   app-managed 子程序，--port 0，私有 CATS_RUNTIME_DIR
            └─ provider CLI   claude/codex/pi 常駐；其他每回合 spawn 並 resume
```

- 「一個 exe 一個 bot」在 OS 上是三到四個程序，這由 runtime 的 process + HTTP 契約決定。
- 每隻 bot 一個 runtime 實例比共用簡單：runtime 的 session 上限與 per-resource singleton 只在單一程序內協調。
  代價是每隻 bot 一份 Node 與 CLI 的常駐記憶體。
- 每隻 bot 需要私有 `CATS_RUNTIME_DIR`，並把 discovery 目錄指向空資料夾，否則 FileWatcher 會匯入使用者所有 CLI session。
- 活著的機制可直接沿用 ADR-127 的形狀：
  - 每分鐘 tick：session 不是 ready 就 resume 或重建；runtime 重啟後一分鐘內自己醒回。
  - 心跳：隨機間隔送隱藏回合進同一個 session，`[quiet]` 丟棄；主人剛講過話就延後；409 以 gate 排隊。
  - 事件：Telegram long polling、檔案監看、本機 webhook、OS 喚醒／登入事件。
  - 排程：以 runtime wakeup 當 cron 計時器（UTC），到點由 bot core 自己送訊息進 session。
  - 睡眠：關 worker、保留 session id，醒來 resume 同一個 provider session。
- 成本：醒著的 bot 常駐一個 CLI 程序與一個 runtime session 名額；每次心跳即使 `[quiet]` 也是真回合，消耗額度。
- 全域 provider/model：只存一組 `{ provider, model }`，形狀同 `GuideCatRecord`；修改即 retarget 全部 session。
- 殼分兩階段：第一階段 Electron，沿用 platform desktop/host 模式，便箋為 frameless 小視窗、可選 alwaysOnTop，
  沒有未知數；第二階段桌面層，在「Electron + 原生 helper 移植 fleet 掛載法」與「採用 fleet 的 C#/WPF/WebView2 殼、
  Node core 作子程序」之間選擇。

## Open questions for the ADR

1. 便箋與 session 的對應：一隻 bot 只有一個活著的主 session、便箋是它的視圖；或每張便箋一個 session、只有主便箋保持醒著。
   心跳與事件必須有唯一的目標 session。
2. 殼的技術選型：Electron（與 Desktop 同棧、可直接抄 `desktop/host`）或 fleet 式原生殼（三層已驗證、WebView2 輕量、
   多一套 .NET 工具鏈）。桌面層在 Electron 上需要實驗證據。
3. 多隻 bot 是否共用 runtime，以及每隻 bot 的記憶體與額度預算。
4. Telegram 綁定：bot 與 Desktop 不能共用 token；是否需要自己的 bot binding 設定與 token 儲存方式。
5. 命名：`cats-bots` 與 `cats-agents` 皆會與既有詞彙部分重疊（Cat 即 agent；ADR-028 的 bot binding）。
   「一個程序一個 bot」的語意較接近 `cats-bots`。
6. 與 Cats Desktop 的關係：同一台機器同時跑 Desktop 與 bot 時的 data root、runtime 實例與 CLI 登入隔離。
7. OS 睡眠與未登入狀態：與 ADR-127 相同，電腦睡著不會醒；是否接受此邊界。

## Risks

- 重寫 continuity 可能退步：PR #319（initializing session 首回合由心跳執行）、#321（sleep 後 resume 與 retarget 區分、
  承接包、篩選記憶）、#327（回覆分段依序送達）都埋在 chat state 裡。這三個行為應成為 bot core 的驗收項。
- 單程序假設：platform 的 store 與 session gate 以「兩個寫入者都在 platform 程序內」為前提；bot 不能與 Desktop
  共用 data root、runtime session 或 Telegram token。
- runtime 0.x 契約漂移：需像 Desktop 一樣釘 SHA 或版本，升級時跑契約測試。
- 桌面層依賴 Explorer 非公開協定（`0x052C`、WorkerW），fleet 為此累積了 ADR-045、049、050 等多次崩潰修正；
  Electron 路徑沒有先例。
- 每隻 bot 的常駐成本（Node + CLI + 可能的 Chromium）與心跳額度，在多 bot 情境下會線性放大。

## Suggested next steps

1. 以本文件為輸入寫第一份 ADR：決定依賴方向（候選 A）、便箋與 session 的對應、殼的第一階段技術選型。
2. 在 cats-one 的 `config/developer-workspace.json` 與 `templates/workspace/AGENTS.md.template` 登記新成員，重跑
   workspace sync；補 `AGENTS.md` 的 Project Metadata、`package.json`、`README.md`、LICENSE 持有人（目前仍是 bootstrap
   placeholder）。
3. 先做無 UI 的 bot core，驗三件事：runtime 重啟後自動醒回、心跳會回 `[quiet]`、Telegram 來訊會回覆。
4. 之後才加 tray 與便箋視窗；桌面層另立實驗與證據門檻。

## References

- cats-runtime：[docs/api.md](../../../cats-runtime/docs/api.md)、
  [SPEC-012](../../../cats-runtime/docs/specs/SPEC-012-scheduled-wakeup-substrate.md)、
  [ADR-009](../../../cats-runtime/docs/decisions/009-keep-cats-runtime-separately-packageable-with-app-managed-local-startup.md)、
  [ADR-032](../../../cats-runtime/docs/decisions/032-replace-gemini-cli-with-antigravity-cli.md)、
  [bundle-runtime.mjs](../../../cats-runtime/scripts/bundle-runtime.mjs)。
- cats-platform：[ADR-003](../../../cats-platform/docs/decisions/003-electron-host-manages-local-services.md)、
  [ADR-035](../../../cats-platform/docs/decisions/035-invert-platform-dependency-and-extract-shared-design-layer.md)、
  [ADR-054](../../../cats-platform/docs/decisions/054-use-a-platform-level-guide-sidecar-for-day-0-assist.md)、
  [ADR-070](../../../cats-platform/docs/decisions/070-use-a-surface-safe-floating-and-shared-chrome-docked-guide-cat-placement-model.md)、
  [ADR-090](../../../cats-platform/docs/decisions/090-adopt-generic-schedule-rules-for-mission-triggers.md)、
  [ADR-110](../../../cats-platform/docs/decisions/110-keep-platform-clients-in-one-repository-with-explicit-package-boundaries.md)、
  [ADR-124](../../../cats-platform/docs/decisions/124-model-companion-as-a-cat-role-not-a-skill-profile.md)、
  [ADR-127](../../../cats-platform/docs/decisions/127-keep-companion-cats-alive-with-a-platform-owned-life-loop.md)、
  [SPEC-124](../../../cats-platform/docs/specs/SPEC-124-alive-companion-life-loop.md)、
  [PLAN-117](../../../cats-platform/docs/plans/PLAN-117-alive-companion-life-loop.md)、
  [ADR-139](../../../cats-platform/docs/decisions/139-manage-one-desktop-remote-ingress.md)。
- desktop-work-fleet：[ADR-007](../../../../sammykenny2/desktop-work-fleet/docs/decisions/007-desktop-scene-and-platform-host.md)、
  [ADR-017](../../../../sammykenny2/desktop-work-fleet/docs/decisions/017-windows-composition-surface-and-input.md)、
  [ADR-019](../../../../sammykenny2/desktop-work-fleet/docs/decisions/019-windows-shortcuts-and-tray.md)、
  [ADR-030](../../../../sammykenny2/desktop-work-fleet/docs/decisions/030-windows-explorer-wallpaper-layer.md)、
  [ADR-058](../../../../sammykenny2/desktop-work-fleet/docs/decisions/058-desktop-presentation-lifecycle-and-core-isolation.md)、
  [平台能力研究](../../../../sammykenny2/desktop-work-fleet/docs/research/2026-10-04-desktop-interaction-platform-feasibility.md)。
- 相對路徑以 cats-inc 開發者工作區的並排 checkout 為準；fleet 位於 `../sammykenny2/desktop-work-fleet`。

*Last updated: 2026-10-27*
