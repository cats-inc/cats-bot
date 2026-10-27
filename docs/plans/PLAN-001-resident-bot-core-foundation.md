# PLAN-001: Resident Bot Core Foundation

## Metadata

| Field | Value |
|-------|-------|
| **Status** | In progress — owner 於 2026-10-27 指示開始實作；Phase 0 到 3 已完成，Phase 4 進行中 |
| **Owner** | Claude |
| **Assigned To** | Claude |
| **Reviewer** | Owner |
| **Related decision** | [ADR-001](../decisions/001-build-a-resident-bot-core-on-cats-runtime-with-disposable-presentation.md) |

## Related Spec

[SPEC-001: Resident Bot Core and Global Execution Contract](../specs/SPEC-001-resident-bot-core-and-global-execution.md)

## Overview

一個工具鏈前置階段加五個可各自展示的階段。順序遵守兩份研究文件共同的優先序：先有無頭的
常駐 core，再讓它活著，然後才加殼；多便箋與全域變更在殼之後；桌面層與角色形象需要新的 ADR，
本計畫只保留位置。每個階段的 exit 對應 SPEC-001 的 Acceptance（A1–A6）。本計畫不選定發行版本，
也不授權發布。

## Implementation Phases

### Phase 0: 工具鏈與邊界（ADR-001 §9）

- [x] Task 0.1：`tsconfig.json` 改為 ESM（`module: NodeNext`、`moduleResolution: NodeNext`、
      `target: ES2022`、`erasableSyntaxOnly: true`、輸出 `dist/`），`package.json` 加 `"type": "module"`。
- [x] Task 0.2：`package.json` scripts 改為 `build`（tsc）、`typecheck`（tsc --noEmit）、
      `test`（`node --test "tests/**/*.test.ts"`）、`bot`（`node dist/cli/main.js`）；移除 jest、ts-jest、
      ts-node、eslint 樣板依賴；保留 prettier；`dependencies` 加 `@cats-inc/cats-runtime` 精確版本 0.6.1。
- [x] Task 0.3：打開 `.github/workflows/ci.yaml` 的 Node job：Node 24、ubuntu 與 windows、
      `npm ci`、typecheck、test、build。
- [x] Task 0.4：`tests/architecture-boundaries.test.ts`：`src/core/**` 與 `src/cli/**` 不得 import
      `electron`、任何 `cats-platform` 路徑或兄弟 checkout 的相對路徑；`src/shell/**` 不得 import
      `src/core/runtime/client`。
- [x] Task 0.5：`docs/services.md` 記下 runtime 子程序以 `--port 0` 動態綁 loopback，本 repo 沒有固定
      listener；`docs/setup-guide.md` 與 `docs/testing.md` 填入實際命令。
- [x] Task 0.6：`src/index.ts` 佔位改為匯出 core 的公開型別；`.gitkeep` 依 mbf 規則清理。

**Deliverables**：乾淨 checkout 與 CI 上 `npm ci && npm run typecheck && npm test && npm run build`
全部通過；邊界測試存在且通過。

### Phase 1: 無頭 core（SPEC-001 FR-1–FR-19；驗收 A1、A6）

- [x] Task 1.1：`src/core/profile/`：`BotProfile` 型別、預設值、逐欄補值、`configRevision`。
- [x] Task 1.2：`src/core/store/`：資料根目錄配置、鎖檔與單一實例交接、暫存檔加 rename 的原子寫入、
      journal 追加與啟動時重建。
- [x] Task 1.3：`src/core/runtime/supervisor.ts`：以釘定套件的 bin 啟動 app-managed runtime、解析
      `runtime.ready`、`GET /health` 確認、退避重啟、關閉順序、以環境變數關閉背景 discovery
      （`CATS_RUNTIME_NATIVE_DISCOVERY_INTERVAL_MS=0`、WSL／Docker policy `manual_only`；不改 provider
      的 session 目錄）。
- [x] Task 1.4：`src/core/runtime/client.ts`：sessions 的 create / resume / close / delete / cancel /
      observe / history、`messages` 的 NDJSON 串流解析、health；Bearer API key。
- [x] Task 1.5：`src/core/conversations/`：對話與 transcript、home 對話建立、attachment 狀態機、
      承接包（12,000 字元；短原文、長 digest 加近期）、閒置政策。
- [x] Task 1.6：`src/core/queue/`：工作項、接納（記 `configRevision`）、序列化執行、session gate、
      404 / 409 / 410 / 403 / 429 的處理與回覆依序附加。
- [x] Task 1.7：`src/cli/main.ts`：`cats-bot init`、`run`、`say <conversation> <text>`、`status`、
      `conversations`；`run` 在前景跑 core 並把事件印到 stdout。
- [x] Task 1.8：測試：假 runtime client 與假時鐘的單元測試（狀態機、gate、重試、承接包截斷）；
      暫存目錄裡真的 runtime 程序加腳本化 fixture provider 的整合測試（建立、串流、取消、resume、
      重啟 core 後狀態一致；登錄裡有 discovered 項目時列表不受影響且 `history` 可讀）。

**Deliverables**：A1 通過；`cats-bot run` 配合真的 CLI 能對話、取消、resume；重啟不重跑
`interrupted` 的工作項。

### Phase 2: 活著（SPEC-001 FR-20–FR-31；驗收 A2）

- [x] Task 2.1：`src/core/life/reconcile.ts`：60 秒對帳 tick（啟動後 5 秒第一次、不重疊、不呼叫模型）、
      runtime 重啟、runtime 狀態分類（活著／已關閉／不存在／未知）與 `busy` 保護、home 的 resume / 重建
      與 5 分鐘退避、`presence` 紀錄、殘留 `running` 轉 `interrupted`。
- [x] Task 2.2：`src/core/life/schedules.ts`：一次性與 cron（IANA 時區由 core 換算）、到期轉工作項、
      coalesce、錯過政策與 grace。
- [x] Task 2.3：`src/core/tools/`：bot 的 session MCP server（`schedule_create`、`schedule_list`、
      `schedule_cancel`、`ask_owner`），以 `mcpServers` 掛到每個 session；收據寫入對話。
- [x] Task 2.4：`src/core/life/heartbeat.ts`：隨機間隔、`wake` 與 `regular`、延後條件、prompt、
      `[quiet]` 判斷、busy 與失敗重試、只記 kind 與結果的日誌。
- [x] Task 2.5：啟動時的復原（以 `history` / `observe` 對帳、`awaiting_owner`）與通知投遞狀態。
- [x] Task 2.6：CLI 加 `schedule add | list | cancel`、`approve <workItem> <decision>`、
      `heartbeat pause | resume`。
- [x] Task 2.7：測試：無視圖下到期排程執行；重複輸入合併；殺掉 runtime 後 home 在 60 秒內
      `ready`；session `busy` 時 tick 不 resume、重建或取消；`initializing` 的 session 由心跳帶到
      ready；安靜心跳不產生訊息但有日誌；busy 4 分鐘重試；`interrupted` 不重播；三種錯過政策；
      OS 恢復後最多補一次心跳；模型口頭答應而未呼叫工具時沒有排程。

**Deliverables**：A2 的無頭示範留下日誌證據：在對話裡建立排程、關掉所有視圖、到點執行、
結果保留、通知事件發出。

### Phase 3: 最小 Electron 殼（SPEC-001 FR-32–FR-34；驗收 A3 與量測）

- [x] Task 3.1：`src/shell/electron/main.ts` 在主程序掛載 core；`preload.ts` 以 contextBridge 暴露
      `BotHostApi`；所有計時器留在主程序。
- [x] Task 3.2：tray 與選單、每個 bot id 一把單一實例鎖、可選開機啟動；抄 platform `desktop/host`
      的 `tray.ts`、`trayMenu.ts`、`candidateProfile.ts` 模式並在檔頭註明來源與 revision。
- [x] Task 3.3：一張便箋視窗：串流輸出、輸入框、歷史、取消、未讀、螢幕內拖曳、always-on-top 切換、
      關閉即藏到 tray、明確 Quit 並清掉子程序。
- [x] Task 3.4：封裝：Windows 安裝檔與免安裝檔；runtime 套件與 Node 的取得方式沿用 platform 的
      `ELECTRON_RUN_AS_NODE=1` 做法；啟動與關閉在乾淨機器驗證沒有孤兒程序。
- [x] Task 3.5：填 SPEC-001 的量測表並把數字定為預算；用 `desktop-ui-automation` skill 做 Windows 驗收。

**Deliverables**：A3 通過；量測表有數字；殼當掉時的行為有紀錄，作為 ADR-001 §2 觸發條件的證據。

### Phase 4: 多便箋、全域變更與 Telegram（驗收 A4、A5）

- [ ] Task 4.1：多張便箋對應多個對話；新建與刪除對話；非 home 的閒置入睡與原生 resume。
- [ ] Task 4.2：全域 `executionTarget` 變更：`configRevision`、stale attachment 不 resume、對話內告知、
      暗號隔離測試（一張便箋的暗號另一張問不到；換模型後舊 session 不被 resume）。
- [ ] Task 4.3：可選的 Telegram long polling：bot 自己的 token、單一 `getUpdates` 消費者、入站成為
      home 的主人訊息、回覆鏡像且分段依序；token 儲存依 SPEC-001 Open Questions 的決定。

**Deliverables**：A4 通過；啟用 Telegram 時 A5 通過。

### Phase 5: 桌面存在感（需要新的 ADR，本計畫不排程）

- [ ] Task 5.1：實驗兩條路：Electron 加原生 helper 移植 fleet 的 WorkerW / `SHELLDLL_DefView` 掛載，
      或 fleet 的 C#/WPF/WebView2 宿主加 core 子程序；各自做 DPI、焦點／IME、顯示器遺失復原的驗收。
- [ ] Task 5.2：角色形象與桌面任意拖曳。

**Deliverables**：一份新 ADR 的證據，不是功能。

## Files to Create/Modify

| File | Action | Description |
|------|--------|-------------|
| `package.json`、`tsconfig.json` | Modify | ESM、scripts、釘定的 runtime 依賴 |
| `.github/workflows/ci.yaml` | Modify | 打開 Node job |
| `src/core/profile/*.ts` | Create | BotProfile 與預設值 |
| `src/core/store/*.ts` | Create | 原子寫入、鎖檔、journal |
| `src/core/runtime/supervisor.ts`、`client.ts` | Create | runtime 子程序與 HTTP client |
| `src/core/conversations/*.ts` | Create | 對話、transcript、attachment、承接包 |
| `src/core/queue/*.ts` | Create | 工作項、接納、gate、回合執行 |
| `src/core/life/reconcile.ts`、`schedules.ts`、`heartbeat.ts`、`recovery.ts` | Create | 活著的機制 |
| `src/core/tools/*.ts` | Create | bot 的 session MCP server |
| `src/core/host-api/*.ts` | Create | `BotHostApi` 型別與事件 |
| `src/cli/main.ts` | Create | 無頭入口 `cats-bot` |
| `src/shell/electron/main.ts`、`preload.ts`、`renderer/` | Create | 第三階段的殼 |
| `tests/architecture-boundaries.test.ts` | Create | 邊界測試 |
| `tests/core/*.test.ts`、`tests/integration/*.test.ts` | Create | 單元與整合測試 |
| `docs/services.md`、`docs/setup-guide.md`、`docs/testing.md`、`docs/architecture.md` | Modify | 由樣板改為實際內容（第一階段後） |

## Technical Decisions

- ESM 加 `NodeNext`，與 runtime（`type: module`）一致；測試用 `node:test` 直接跑 `.test.ts`，
  靠 Node 24 原生 type stripping，所以原始碼限制為可擦除語法（`erasableSyntaxOnly`）；不引入 jest。
- `@cats-inc/cats-runtime` 釘精確版本 0.6.1（撰寫時的 npm `latest`）；升級是獨立 PR，必須跑整合
  測試；開發時用主機 Node 啟動套件的 bin，封裝後用 Electron 的 Node（`ELECTRON_RUN_AS_NODE=1`），
  與 platform `processSupervisor` 相同。
- core 在第一階段於 Electron 主程序內掛載（ADR-001 §2）；`BotHostApi` 定義為可序列化的
  JSON 命令與事件，不綁 Electron IPC 的型別，讓日後改成 loopback 或 named pipe 不動 core。
- bot 的 MCP server 走 Streamable HTTP（loopback、bearer token）：runtime 的 `mcpServers` 只接受
  `transport: http`，`stdio` 會被 400 拒絕（runtime api.md「Session MCP servers」）；第二階段自寫
  最小的 JSON-RPC over HTTP，不引入 SDK。
- 整合測試的 fixture provider 是一支腳本化 CLI，講 runtime 某個 adapter 期待的 stream-json，
  透過暫存 runtime 的 `providers.yaml` 註冊；真的 provider 只在手動驗收使用。
- Windows 優先；core 內所有路徑經 `node:path`，不寫平台假設。

## Testing Strategy

- **Unit Tests**：假 runtime client 與假時鐘；attachment 與工作項狀態機、gate、重試與退避、承接包
  截斷、排程到期與錯過政策、心跳延後與 `[quiet]` 判斷、profile 補值。
- **Integration Tests**：暫存目錄裡的真 runtime 程序加 fixture provider：啟動與 ready、串流、取消、
  resume、殺掉 runtime 後 60 秒內醒回、重啟 core 後 journal 一致；每個測試清掉自己的子程序。
- **Manual Testing**：真的 CLI 在 Windows 上跑 A1–A4；第三階段以 `desktop-ui-automation` 做
  tray 與便箋驗收；量測表的每個情境留下數字與擷取方式。
- **State hygiene**：所有測試只用暫存目錄；永不碰 `~/.cats`；測試不讀任何憑證檔。

## Risks & Mitigations

| Risk | Impact | Mitigation |
|------|--------|------------|
| 重做承接、gate 與 polling 時退步到 platform 已修過的 bug（PR #319、#321、#327） | High | 這三個行為寫進 SPEC-001 FR-11、FR-17、FR-19、FR-27 與 A2 / A4 的測試 |
| runtime 0.x 契約漂移 | High | 釘精確版本；升級 PR 必跑整合測試；client 只用 api.md 記載的端點 |
| 計時器被 renderer 節流 | Medium | 計時器只在 core；邊界測試與 Electron 主程序掛載 |
| 第一階段殼當掉帶走 core | Medium | 開機啟動與單一實例重啟；記錄事件作為 ADR-001 §2 的觸發證據 |
| 心跳額度 | Medium | 每隻 bot 可關閉；日誌計次；量測表定預算 |
| exactly-once 做不到 | Medium | `interrupted` 與 `awaiting_owner` 為一級狀態；以 runtime 證據對帳；不自動重跑 |
| 每隻 bot 的常駐成本 | Medium | 第三階段量測後再談多 bot 與共用 runtime |
| Explorer 非公開協定與原生驗收 | Low（第五階段） | 另立 ADR；不在本計畫內實作 |
| 憑證與 token 處理 | High | 永不讀 CLI 憑證檔；Telegram token 優先 OS 憑證庫；日誌不含憑證 |

## Progress Log

| Date | Update |
|------|--------|
| 2026-10-27 | PLAN-001 與 ADR-001、SPEC-001 一起建立；兩份研究文件融合；沒有任何程式碼 |
| 2026-10-27 | 依 Codex 審閱修訂：discovery 隔離改為 runtime 旗標而非改目錄（ADR-001 §1、SPEC-001 FR-5）；對帳依 session 狀態分類並保護 `initializing` 與 `busy`（ADR-001 §5、SPEC-001 FR-20）；分支清理腳本改為驗證已落地才刪除；CI 的 YAML 驗證改為會失敗 |
| 2026-10-27 | Phase 0 完成：ESM 工具鏈（`NodeNext`、`erasableSyntaxOnly`、`rewriteRelativeImportExtensions`）、`node:test` 直接跑 `.ts`、CI Node job（ubuntu 與 windows）、釘定 `@cats-inc/cats-runtime` 0.6.1、架構邊界測試、`src/core/types.ts` 契約型別、services／setup／testing 文件；修正：bot 的 MCP server 必須走 Streamable HTTP（runtime 拒絕 stdio） |
| 2026-10-27 | Phase 1 完成：`src/core`（profile、store、runtime supervisor 與 client、conversations 與承接包、queue 與 turn runner、`BotCore`）、`src/cli/main.ts`（`init`、`run`、`say`、`status`、`conversations`）；測試 30 個：單元、假 runtime 的 core 端對端、真 runtime 0.6.1 加 fixture CLI 的整合測試（建立、串流、取消、resume、history、discovered 項目不影響列表）。實測修正：runtime 0.6.1 拒絕 `--port 0`，core 改為啟動前自己預留 loopback port（SPEC-001 FR-5）；runtime 意外退出的退避重啟已先在 core 內實作（原列於 Task 2.1），對帳 tick 到 Phase 2 再接上；FR-28 以 `history`／`observe` 對帳證據留給 Task 2.5，Phase 1 只把殘留的 `running` 標為 `interrupted` 且不重跑 |
| 2026-10-27 | Phase 2 完成：`src/core/life`（`loop.ts` 對帳 tick、`schedules.ts` 與 `cron.ts` 的 IANA 時區 cron、`heartbeat.ts`、`recovery.ts`）、`src/core/tools`（Streamable HTTP 的 session MCP server 與 `schedule_create`／`schedule_list`／`schedule_cancel`／`ask_owner`）、`src/core/conversations/binder.ts`（turn runner 與 tick 共用的 session 綁定）、CLI 加 `schedule add|list|cancel`、`approve`、`heartbeat pause|resume`、`tick`；測試：cron、schedules、heartbeat、recovery、tools 單元測試，假 runtime 的 life 測試（tick 建立與復活 home、busy 保護、安靜與開口的心跳、暫停、到期排程與 coalesce、停機後的錯過政策與一次補心跳、ask_owner 與逾時、便箋閒置入睡），真 runtime 的 fixture CLI 經 `--mcp-config` 呼叫 bot 工具伺服器建立排程並到點執行、`ask_owner`、心跳 `[quiet]`。設計說明：承接包只在建立或替換 session 時以 instructions 送入，心跳 prompt 本身只帶時間事實與 `[quiet]` 規則；session `busy` 時的心跳由 loop 四分鐘後重排，而不是留在佇列 |
| 2026-10-27 | Phase 3 完成：`src/shell/electron`（`main.ts` 在主程序掛載 core、每個 bot id 一把單一實例鎖（以 per-bot userData 區分）、`assets/preload.cjs` 以 contextBridge 暴露 `BotHostApi` 命令與事件、`windows.ts` 無邊框便箋視窗（關閉即藏、位置與 always-on-top 存 `shell-state.json`）、`tray.ts`／`trayMenu.ts`（開 home、列便箋、新便箋、暫停心跳、開機啟動、Quit）、`assets/renderer/` 便箋頁面）；CLI 加 `open`、`quit`（handoff 給執行中的殼）；electron-builder 設定（`asar: false`，Windows NSIS 與 portable）；量測表填入 fixture provider 的實測數字（見 SPEC-001）。未做：乾淨機器上的安裝驗證（本機只跑過 `--dir` 與 installer 的建置與啟動）、顯示器遺失情境；Electron 綁 41.2.0（與 platform 相同，本機已有快取） |

---

*Created: 2026-10-27*
*Author: Claude*
