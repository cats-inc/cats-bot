# SPEC-004: Provider Interactions and Tool Visibility

## Metadata

| Field | Value |
| --- | --- |
| Status | Implemented；驗收範圍與上游 helper 限制見 PLAN-004 |
| Owner | Bot core、headless CLI、Electron shell |
| Reviewer | Product owner、Runtime maintainers |
| Baseline | Bots `7951c28`；Runtime 套件 pin 0.6.1；2026-10-28 |
| Decision | [ADR-001](../decisions/001-build-a-resident-bot-core-on-cats-runtime-with-disposable-presentation.md)；Runtime ADR-048（已接受） |
| Plan | [PLAN-004](../plans/PLAN-004-provider-interactions-and-tool-visibility.md) |

## Summary

讓 standalone Bot 透過 cats-runtime 回答 provider 的原生批准、問題及 MCP 表單，
並看見這隻 bot 的 session 實際工具和有效權限。Bot core 擁有等待／回覆／復原狀態，
CLI、便箋與 tray 只是同一個 host API 的呈現，不依賴 cats-platform。

共用契約以 `cats-runtime/docs/specs/SPEC-039-provider-session-capabilities-and-interactions.md`
為準；對應 Runtime PLAN-049，Platform SPEC-132／PLAN-124 是另一個獨立消費者。
契約文件已合併；目前精確採用 Runtime source `50ef02b4686c1fff6b60819d292acc5b2e1ef773`
的 0.6.2 candidate artifact，digest 見 vendor/README，尚未發布新版套件。
本案沿用 ADR-001 的獨立常駐核心，不重複建立 Bot 架構 ADR。

## Goals and User Stories

- 主人能從 headless CLI 或便箋回答同一個等待中的 provider 請求，不需重跑原回合。
- 沒有便箋開著時，背景工作安全等待；tray／通知可以帶主人回到正確對話。
- 能診斷與 Terminal 的 MCP／工具／權限差異，並分別驗證 Chrome 與桌面工具。
- 一隻 bot 的全域 provider/model、每對話隔離與 bot 範圍序列化維持有效。

## Non-Goals

- import Platform、繞過 Runtime 直接 spawn Codex，或自行處理 app-server JSON-RPC。
- 把既有 `ask_owner`、中斷重跑批准與原生工具批准合成同一種布林答案。
- 改成多個回合同時執行、搬動使用者 Codex home／憑證或建立通用插件安裝器。
- 本期提供 Telegram 原生表單／批准回覆；Telegram 可送通知，回覆使用本機 CLI／殼。

## Before implementation

Bot 已有 `awaiting_owner`、`ask_owner`、中斷復原與 `approve` 操作，但 Runtime 目前不會把
Codex 原生問題／MCP elicitation 交給這條管線。原生 callback 尚未接通。
當時 Bot 權限與 cwd 由 profile 提供，Runtime 套件固定為 0.6.1；不是因為有 tray 或使用
spawn 就自動具有 Terminal 的全部能力。此文件不改動任何既有 bot 的 provider 或設定。

## Requirements

### B1. Bot core 的互動邊界

Runtime client 消費 SPEC-039 capability、snapshot/events 與 typed response。
core 只宣告 CLI／殼真正支援的互動類別；所選 Runtime 或 provider 不支援時明確回報。
`BotHostApi` 增加列出／觀測／回答／取消原生互動的方法，殼不得取得 Runtime URL/key。

每筆互動綁定 bot、conversation、work item、runtime session、worker generation、
execution 與 interaction ID。跨 bot／跨便箋／舊 generation 的回覆一律不能生效。
`ask_owner`、recovery rerun 與 `provider_interaction` 以明確種類區分，
既有 `approve` 命令的語意不偷偷改成回答任意原生問題。

### B2. 序列化佇列與背景工作

工作項可投影為 `awaiting_owner`，但原 provider turn 仍在執行中，原本的 bot 範圍
turn gate 必須保留。其他回合排隊；不因等待就釋放 slot 並平行跑新模型回合。
回答與取消走獨立控制路徑，不能排在被等待中的工作後方，避免自我死鎖。

reconcile tick 繼續做不呼叫模型的健康對帳，辨識活躍／等待中的 session，
不得關掉它、當作孤兒重建或重送原 prompt。heartbeat 在等待期間合併／延後；
到期排程依既有 journal 與 coalescing 保留，不能製造無上限的重試或通知。
互動與背景回合使用同一組接納政策，沒有視窗不是擴權理由。

### B3. Journal、關窗與復原

journal 保存必要的種類、關聯、期限與去敏感狀態；原生 callback 只存在 Runtime。
便箋全部關閉、renderer 重建或 CLI 暫時離線，不影響仍存活的原生請求。
重連用權威 snapshot/revision 對帳，不憑 journal 的 pending 欄位重送答案。

core／Runtime／worker 重啟時，先確認原執行是否仍存活且身分相同；不能證實就標中斷。
舊 id 不可套到 resume 後的新 worker。若主人選擇重試，必須明確說明是新的執行，
不能宣稱延續已遺失的批准，也不能自動重播有外部效果的工作。
expiry、provider resolve、取消與重複回覆按 Runtime 的終態收斂。

### B4. 全域 retarget 與刪除

provider/model/instructions/permissions/cwd 變更遵守 SPEC-001 的 configRevision 邊界。
等待中的回合仍屬活躍回合，保留舊 target／政策；設定套用保持 pending，
或由主人先取消該回合。不得為了套用新設定提前重啟其 Runtime。
對話刪除、quit、cancel 必須終止相應 live 請求並撤銷卡片回覆能力，
同時維持既有排程取消與 journal 規則。

### B5. CLI、便箋與通知

headless CLI 先提供原生互動列表與 typed response 操作，支援自動化可讀的結果。
敏感表單內容可透過 stdin／受控輸入送出，不要求放在命令列 argv 或 log。
Electron 便箋顯示來源、問題／動作、授權範圍與期限，允許選項、自由文字、
受支援的表單／外部 URL 流程。不得把外部頁面開啟當成完成授權。

tray／浮動貓通知可以定位原對話；以 interaction ID/revision 去重。
失效請求不再提供可按的批准鈕。未讀訊息數與待回覆數分別定義，
不得因通知更新把同一請求重複計成多則訊息。
Telegram 通知不包含秘密或表單答案，普通聊天文字不被解析成原生批准。

### B6. 權限與工具診斷

設定頁與 CLI 顯示請求政策及 Runtime 回報的有效 approval／access 範圍。
沿用 provider 設定與 explicit policy 以明確選擇啟用；舊 profile 的 default/skip
效果保留，不能自動升級為 full access。全域 policy 變更受 configRevision 管理。
一般 Bot 設定不推論成所有 provider／OS 的相同權限。

工具診斷以所選 conversation 的真實 session 為準，列出 provider MCP、Bot 注入 MCP、
內建／dynamic tools 的來源、觀測時間、部分清單與連線限制。
沒有 worker 就顯示尚未觀測；診斷刷新不能送 prompt 或開始 heartbeat。
沿用使用者的 provider config，Bot MCP 只是增量注入；名稱碰撞不得覆蓋使用者 server。

Computer use／Chrome 的 helper、瀏覽器擴充及 OS 權限顯示實際觀測結果與修復方向。
可能依賴上游 Desktop-only host；不能因 Bot 自帶 Electron 就宣稱能取代它。
Runtime 的 private data dir 不代表必須換掉 provider home；不搬移登入資料來達成清單一致。

### B8. Claude Code

Runtime SPEC-039 R8 讓 Claude Code 成為第二個原生 target，Bot 依 provider 回報的能力自動啟用。
新增 `tool_approval`：MCP、Claude in Chrome 等不是指令、也不是檔案修改的工具呼叫，
在便箋上沿用通用卡片顯示工具名稱、MCP server 與輸入摘要。Claude Code 沒有 `permission_grant`。

Claude Code 在原生 Windows 沒有 sandbox，只能接受「完整存取＋網路」這個上限。
設定頁會說明這點；Runtime ready 時，儲存較窄上限會先被拒絕，不會等到下一個 session 才失敗。
想逐一核准動作，選「Ask when requested by the agent」。

Bot 設定可為 Claude bot 開啟 Claude in Chrome：runtime 以 `--chrome` 重新啟動 CLI，
並把它視同 provider 變更（configRevision 前進、等目前回合結束後才重啟）。
這個欄位存在 `executionTarget.claudeInChrome`，沒有就是關閉，所以舊 profile 的啟動方式不變。
瀏覽器實際是否可用要等工具真的執行才知道；computer use 不在 Claude Code 無頭模式內。

### B7. 升級與資料保護

精確更新 Runtime dependency 的工作在實作階段處理；能力讀取失敗時不能假設新 API 存在。
若 profile/journal 增加欄位或狀態，先做舊資料驗證、備份、原子替換及失敗復原；
新版本不識別的資料必須保護性停止，不能抹除。回覆本體／秘密不進 transcript 或 journal。
在既有 minor line 維持舊 CLI/config 語意；breaking change 需要下一 minor，
版本與發布依後續授權，不是本文件工作的附帶動作。

## Acceptance Criteria

| ID | 驗收 |
| --- | --- |
| A1 | 只有 Bot core + Runtime、沒有 Platform／Electron 時，可用 CLI 回答 live 原生請求 |
| A2 | 多便箋、跨 bot 與不同 generation 不串回答；重複回答不重送 provider |
| A3 | 全部關窗仍可等待；reconcile 不重建 busy session，heartbeat 不重疊，回答不被 queue 卡住 |
| A4 | renderer 重連恢復請求；worker/core 重啟、逾時、cancel 與 retarget 正確失效／延後 |
| A5 | 原 ask_owner／recovery approve、排程、全域 retarget 與既有 profile 權限通過回歸 |
| A6 | 清單來源／部分資料／helper 離線清楚；分別完成受控 Chrome 與桌面工具實測 |
| A7 | schema upgrade/failure recovery 通過；沒有秘密回覆或 Runtime key 暴露到殼與歷史 |

## Dependencies and Open Questions

- Runtime SPEC-039 / PLAN-049 的協定、policy mapping 與 inventory；Bot 不提供替代 adapter。
- 本機安全的 URL-flow completion 和支援的表單 schema 跟隨 Runtime P0 的驗證結果。
- Native Windows 先驗收；macOS/Linux 的 helper／OS 權限與包裝另列待驗。
- Telegram 原生回覆需要另一個有權限、身分與重放保護的設計，本期不推測其語意。

## References

- [Resident core contract](SPEC-001-resident-bot-core-and-global-execution.md)
- [Desktop settings and shell](SPEC-002-desktop-presence-settings-and-first-run.md)
- Runtime ADR-048 / SPEC-039 / PLAN-049 and research `2026-10-28-codex-host-capability-gaps`.

*Created / last updated: 2026-10-28*
