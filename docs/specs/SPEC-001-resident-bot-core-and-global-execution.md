# SPEC-001: Resident Bot Core and Global Execution Contract

## Metadata

| Field | Value |
|-------|-------|
| **Status** | Accepted — 2026-10-27 together with [ADR-001](../decisions/001-build-a-resident-bot-core-on-cats-runtime-with-disposable-presentation.md); implemented by PLAN-001 |
| **Owner** | Claude |
| **Reviewer** | Owner |
| **Related decision** | ADR-001 |
| **Related plan** | [PLAN-001](../plans/PLAN-001-resident-bot-core-foundation.md) |

## Summary

一隻 cats-bot 是一個獨立受管的常駐實例：一個 bot core 擁有 bot profile、對話、工作 journal 與
計時器，以 app-managed 子程序啟動私有的 cats-runtime，透過 loopback HTTP 讓選定的 provider CLI
執行回合。主人從便箋視窗或（之後）Telegram 跟它說話；它靠事件、耐久排程與深思心跳保持活著，
並用一個不呼叫模型的對帳 tick 維持 runtime 與 home 對話的 session。整隻 bot 只有一組全域
provider/model。殼（tray、便箋）是可拋棄的客戶端；所有視窗關閉時 bot 仍在跑。
決策與取捨見 ADR-001；本文件定義可驗收的行為，不是儲存格式的凍結。

## Goals

- 沒有 Cats Desktop 與 platform server 也能跑：一個 bot 實例、一個私有 runtime、一個 CLI。
- 所有視窗關閉時，主人訊息、到期排程與心跳仍會執行，結果保留，重開視窗能重建進度。
- runtime 重啟或 session 被關掉後，home 對話的 session 在一個對帳 tick 內自己醒回來。
- 各對話脈絡不混；全域 provider/model 變更只影響之後的回合，舊 attachment 不會偷偷沿用舊模型。
- core 可無頭執行與測試；殼只透過窄介面操作 core。

## Non-Goals

- 桌面層／桌布層、角色形象、macOS 與 Linux 原生宿主（另一份 ADR）。
- 多 bot 共用 runtime；作息（就寢／起床）；共用 bot 記憶的挑選；生圖與相簿。
- OS 層級從睡眠喚醒、未登入執行、Telegram webhook ingress。
- 承諾外部效果的 exactly-once。
- 發布前的資料遷移；發布後依 cats-inc 版本與升級政策。
- import `@cats-inc/cats-platform`、做成 .catsapp、讀取任何 CLI 憑證檔。

## Definitions

- **bot 實例**：一個資料根目錄、一個 `BotProfile`、一個私有 runtime 子程序、一把單一實例鎖。
- **bot core**：擁有 profile、對話、journal、runtime 監督與所有計時器的 Node 模組；不依賴 Electron。
- **殼**：tray、便箋視窗等呈現層；只是 core 的客戶端。
- **對話**：bot 自己持有 transcript 與承接脈絡的單位；至多一個 runtime session attachment。
- **home 對話**：每隻 bot 恰有一個；life loop 唯一保溫的 session；心跳與一般主動訊息的目的地；也是 inbox。
- **便箋**：對話的一個視圖（位置、大小、可見、層）。
- **attachment**：對話與 runtime session 的對應，含 `sessionId`、建立時的 provider/model、
  `providerSessionId`、狀態 `none | initializing | ready | sleeping | closed | stale | failed`。
- **工作項**：接納管線的單位，來源為主人訊息、排程、事件或心跳；狀態 `queued | running |
  awaiting_owner | completed | failed | cancelled | interrupted`。
- **configRevision**：`executionTarget`、`instructions` 或 `permissions`（含 `cwd`）每次實際變更遞增的序號；工作項在接納時記下它，attachment 記下建立時的值。
- **session 活著**：runtime `GET /sessions/{id}`（或 `observe`）回報的 `status` 為 `initializing`、
  `ready` 或 `busy`；runtime 的 `SessionStatus` 只有這三者加 `closing` 與 `closed`。`closing`／`closed`
  是「已關閉」；404 是「不存在」；連不上、逾時或 5xx 是「未知」，與已關閉不同。attachment 側對應：
  `ready` 與帶 session id 的 `initializing` 是活著的候選；`busy` 不是 attachment 狀態，而是 runtime
  對進行中回合的回報。

## Requirements

### Bot profile 與資料根目錄

1. FR-1：`BotProfile` 欄位：`schemaVersion`、`id`（首次建立時產生，之後不變）、`name`、
   `instructions`（人設，每個 session 的 bootstrap instructions）、`executionTarget: { provider, model | null }`、
   `configRevision`、`permissions: { workspaceAccess, permissionMode, allowedTools?, cwd }`、
   `heartbeat: { enabled, wakeMinMinutes, wakeMaxMinutes, regularMinMinutes, regularMaxMinutes }`
   （預設 `true`、2、10、30、120）、`idleSleepMinutes`（預設 15）、`updatedAt`。
2. FR-2：資料根目錄預設 `~/.cats/bots/<id>/`，可由 `CATS_BOTS_HOME` 覆寫。配置：`profile.json`、
   `conversations/<conversationId>.json`（對話中繼資料與 attachment）、
   `transcripts/<conversationId>.jsonl`、`journal.jsonl`（工作項、排程與狀態轉移）、
   `runtime/`（作為 `CATS_RUNTIME_DIR`）、`logs/`；另有 core 的 `life.json`（上次 tick 時間）、`instance.lock.json`、
   `handoff/`、`secrets.json`（Telegram token 等，見 Open Questions）、`telegram-state.json`（上次接納的
   `update_id`，非機密），以及殼自己的 `shell-state.json`（便箋位置、大小、
   always-on-top、開機啟動）。
3. FR-3：同一資料根目錄同一時間只有一個寫入者，以鎖檔保證；第二個同 id 實例把啟動參數交給
   第一個並退出。所有寫入以暫存檔加 rename 完成；讀取絕不寫回。
4. FR-4：讀取時缺少或不合法的欄位逐欄套預設值，不改寫既有檔案；檔案損壞時回報錯誤並保留原檔，
   不以空內容覆蓋。

### Runtime 監督

5. FR-5：core 以釘定版本的 `@cats-inc/cats-runtime` 套件的 `cats-runtime` bin 啟動子程序：
   `--startup-mode app-managed --managed-by cats-bots --ready-output json --host 127.0.0.1 --port <port>`，
   其中 `<port>` 是 core 啟動前自己預留的空閒 loopback port（runtime 0.6.1 拒絕 `--port 0`）；
   環境變數 `CATS_RUNTIME_DIR=<root>/runtime`、`CATS_RUNTIME_API_KEY=<core 產生的隨機值>`、
   `CATS_RUNTIME_NATIVE_DISCOVERY_INTERVAL_MS=0`（關閉背景 native 與 agent discovery）、
   `CATS_RUNTIME_WSL_DISCOVERY_POLICY=manual_only`、`CATS_RUNTIME_DOCKER_DISCOVERY_POLICY=manual_only`。
   不改任何 provider 的 session 目錄設定，因為同一目錄也是 `history` 與 resume 的讀取來源；core 永不
   呼叫 `/sessions/discover` 類端點；runtime 以 FileWatcher 匯入的 `origin: 'discovered'` session 沒有
   worker，core 在所有列表中忽略它們，並只以 attachment 記錄辨識自己的 session，不掃描 `GET /sessions`。
   從 stdout 的 `runtime.ready` 取得 `healthUrl`，`GET /health` 成功才算 ready；逾時（預設 60 秒）
   標 `failed` 並記原因。
6. FR-6：runtime 意外退出時，core 把 runtime 標為 `failed`、所有 attachment 標為 `closed`，由對帳 tick
   帶退避重啟（5 秒、30 秒、2 分鐘、5 分鐘，之後固定 5 分鐘），每次重啟記入 journal。
   這與 platform `processSupervisor` 只標 `failed` 不重啟的行為不同，因為 bot 的承諾是活著。
7. FR-7：關閉順序：取消進行中的回合、關閉子程序 stdin、等待 `runtime.stopping` / `runtime.stopped`
   或逾時（10 秒），再 SIGTERM；core 退出後不得留下 runtime 或 CLI 孤兒程序。
8. FR-8：runtime 連不上時一律視為「未知」：不改 attachment 狀態、不入睡、不重建、不重播。

### 對話與 session

9. FR-9：對話記錄欄位：`id`、`role: 'home' | 'note'`、`title`、`createdAt`、`updatedAt`、`attachment`、
   `unreadCount`、`lastOwnerMessageAt`、`lastBotMessageAt`、承接 checkpoint。
10. FR-10：每隻 bot 恰有一個 home 對話，首次啟動時建立；可清空、不可刪除。
11. FR-11：attachment 延遲建立：工作項被接納而 attachment 為 `none` / `closed` / `stale` 時
    `POST /sessions`，帶 `executionTarget`、`instructions`（人設加承接包）、`permissions` 對應欄位與
    `mcpServers`（FR-24 的 bot 工具伺服器）；為 `sleeping` 時 `POST /sessions/{id}/resume`。
    resume 失敗保留 attachment、標 `failed` 並把錯誤寫進對話，絕不靜默換成空白 session。
    同一對話同時只有一次綁定：對帳 tick 與回合同時綁定時共用同一個結果，不會各建一個 session
    互相覆寫 attachment；承接包不含仍在 `queued` / `running` 的主人訊息，它們以訊息送入。
12. FR-12：承接脈絡：CLI provider 的原生 transcript 由 CLI 保存；core 另外保存自己的 transcript，
    並在建立或替換 session 時以 instructions 送入承接包：12,000 字元上限，短對話原文、長對話
    digest 加近期內容。digest 是有損的，不宣稱無損召回。
13. FR-13：閒置政策：非 home 對話的 attachment 在 `idleSleepMinutes` 內沒有回合時關 worker
    （`POST /sessions/{id}/close`），狀態改 `sleeping`、保留 session id。home 對話不套用閒置政策。
14. FR-14：刪除對話：先 `close` 再 `DELETE /sessions/{id}`，確認後移除 transcript 與視圖；
    關閉便箋視圖永不刪除對話；結束 bot 永不刪除任何對話。

### 接納、佇列與回合

15. FR-15：每個回合都是工作項：`id`、`kind: owner_message | heartbeat | schedule | event`、`source`、
    `conversationId`（目的地，必填）、`createdAt`、`admittedAt`、`configRevision`、`state`、`attempts`、
    `coalesceKey?`、`result?`、`notification?`。
16. FR-16：佇列為 bot 範圍序列化，同一時間只有一個 `running`。主人訊息插到所有背景工作項之前；
    `running` 的背景工作項不被搶占；取消只由主人的明確動作觸發（`POST /sessions/{id}/cancel`）。
17. FR-17：core 持有以 runtime session 為鍵的 gate，確保自己的並發不會撞出 409。仍收到 409 時：
    背景工作項 4 分鐘後重試一次，主人訊息留在佇列並在對話裡顯示「等待中」。
18. FR-18：回合執行走 `POST /sessions/{id}/messages`、`Accept: application/x-ndjson`；`text`、`tool_use`、
    `tool_result`、`progress`、`error`、`result` 事件即時附加到 transcript 與視圖；收到 `result` 標
    `completed`；串流在沒有 `result` 的情況下結束標 `interrupted`；404「no active worker」先 resume 再
    重試一次；410 把 attachment 標 `closed` 並在下次接納時重建；403 / 429 guardrail 以 runtime 的
    原因標 `failed`，並尊重 `cooldownUntil`。
19. FR-19：bot 的回覆依序附加到目的地對話；之後接上 transport 時，分段（Telegram 4,000 字元）
    必須保持順序。

### 活著：對帳、排程、心跳、事件

20. FR-20：對帳 tick 每 60 秒一次，啟動後 5 秒第一次，不重疊，不呼叫模型：
    - 檢查 runtime 健康，`failed` 時依 FR-6 重啟。
    - 以 Definitions 的分類對帳 home 對話的 attachment：
      - 活著（`initializing`／`ready`／`busy`）：不動。`initializing` 由下一個回合（含心跳，同 platform
        `companion/life/loop.ts`）帶到 ready；session 為 `busy` 或該 attachment 有 `running` 工作項時，
        tick 絕不 resume、重建或取消。
      - 已關閉（`closing`／`closed`）或不存在（404）：attachment 為 `sleeping` 就
        `POST /sessions/{id}/resume`，否則依 FR-11 重建；失敗退避 5 分鐘，原因記為 `no_capacity`
        （`Max sessions (N) reached`）、`wake_failed` 或 `runtime_unavailable`，同一段失敗只記一次。
      - 未知（連不上、逾時、5xx）：依 FR-8 不做任何動作，下個 tick 再看。
    - 把重啟前殘留的 `running` 工作項標為 `interrupted` 並交給 FR-27 處理。
    - 把到期排程轉為工作項（FR-21）。
    - 狀態轉移時各寫一筆 `presence` 紀錄（`awake` / `sleeping` / `failed`），session 本來就活著時不寫。
21. FR-21：排程記錄：`id`、`conversationId`、`kind: once | cron`、`at`（ISO）或 `cron` 加 IANA `timezone`
    （預設主機本地時區，時區換算由 core 負責，不依賴 runtime 的 UTC cron）、`prompt`、
    `missedPolicy: skip | coalesce | run_once`（預設 `once` 為 `run_once`、`cron` 為 `coalesce`）、
    `graceMinutes`（預設 1,440）、`createdBy: owner | agent`、`receipt`。到期時建立工作項，
    `coalesceKey` 為排程 id；同一排程仍有 `queued` 工作項（含正在等待重試延遲的）時不重複建立。
    取消排程時，它已觸發、仍在佇列或重試延遲中的工作項一併標 `cancelled`；重試計時到期時先重讀
    工作項，已不是 `queued` 就不再執行。
22. FR-22：停機期間錯過的排程依 `missedPolicy` 處理：`skip` 記一筆略過通知；`coalesce` 合併為一次；
    `run_once` 在 `graceMinutes` 內執行一次、超過則略過並通知。絕不重播無上限的積壓。
23. FR-23：OS 睡眠後恢復時立即跑一次對帳 tick；睡眠期間視為停機套用 FR-22；心跳最多補一次。
24. FR-24：core 以 session MCP server（`mcpServers`）提供 bot 工具：`schedule_create`、`schedule_list`、
    `schedule_cancel`、`ask_owner`。排程只在 journal 寫入成功後存在，工具回傳含 `receipt` 的結果，
    core 把收據寫進對話；模型只在回覆裡口頭答應而未呼叫工具時，不存在任何排程。`schedule_list` 與
    `schedule_cancel` 只看得到呼叫者所在對話的排程；其他對話的排程 id 與不存在的 id 回同樣的錯誤，
    不洩漏內容也不允許取消。
25. FR-25：心跳只在 `heartbeat.enabled`、home attachment 活著時排程，計時器存在記憶體、重啟後重抽：
    - 醒來後第一次在 2–10 分鐘內，`kind: wake`；若醒來後 3 小時內已有 `wake` 心跳，改為一般心跳。
    - 之後每 30–120 分鐘隨機一次，`kind: regular`。
    - 主人 10 分鐘內講過話則延後到那則訊息後 10 分鐘再重抽；session 正在處理回合時延後 4 分鐘。
    - prompt 含本地時間、醒了多久、主人上次說話距今多久與「不想說就只回 `[quiet]`」；承接包不重複塞進每次
      心跳，它在建立或替換 session 時已經以 instructions 送入（FR-11、FR-12）。
    - 回覆為 `[quiet]`（忽略大小寫與前後空白）時丟棄；否則以 bot 訊息（`origin: heartbeat`）寫入
      home 對話、`unreadCount` 加一並發通知事件。
    - busy 時 4 分鐘後重試同一次心跳；失敗 30 分鐘後重試。每次心跳記錄 `kind` 與
      `spoke | quiet | busy | failed`，不記錄 prompt 與回覆內容。
26. FR-26：事件來源：便箋送出的主人訊息；工作項完成（產生通知，不自動產生新回合）；之後的
    Telegram long polling 以 bot 自己的 token、單一 `getUpdates` 消費者，入站訊息成為 home 對話的
    主人訊息工作項，bot 回覆鏡像回 Telegram；檔案監看與本機 webhook 必須明確設定，預設關閉。
    update 在耐久接納後（主人訊息工作項已寫入 journal，或確定不需處理）才推進 `offset`；處理失敗時
    不確認、退避後重新取回同一則；連續失敗 5 次的 update 記錄 id（不含內容）後略過，不讓一則壞訊息卡住
    polling。上次接納的 `update_id` 依 bot id 持久化，重啟後先確認它，重送的已接納 update 不重複處理；
    工作項另記 `sourceRef`（`telegram:<chat>:<message>`），即使當機發生在工作項寫入 journal 之後、
    `update_id` 保存之前，重送的同一則訊息也不會建立第二個工作項。

### 全域 provider/model 變更

27. FR-27：變更 `executionTarget`、`instructions` 或 `permissions`（含 `cwd`）時 `configRevision`
    遞增並持久化；`running` 的工作項在它記下的 revision 下跑完或被取消；`queued` 的工作項在接納時
    重新讀取；在較舊 revision 下建立的 attachment 標為 `stale`、不 resume，下次接納以承接包重建
    session，並在對話裡告知主人；被取代的 session 在其中沒有回合執行時關閉（`close`），不留下
    不受閒置政策管理的 worker。值都相同時為 no-op；名稱、心跳、閒置與 Telegram 設定不影響 session。
    換 provider 需要重啟私有 runtime：有回合在跑時先讓它在原設定下跑完，期間佇列暫停接納、tick 不碰
    runtime；回合結束後才重啟 runtime，再接納後續工作。每個 run 記錄實際 provider/model。

### 復原與通知

28. FR-28：送出 prompt 前先把 run（provider、model、session id、`startedAt`、`historyBaseline`：
    送出前 history 的訊息數，新 session 為 0，讀不到為 null）寫進 journal。啟動時載入 journal，把
    `running` 改為 `interrupted`；對每個 `interrupted` 工作項以 `GET /sessions/{id}/history` 對帳。
    runtime 的 history 沒有回合結束標記，所以完成必須有證據：prompt 是這次 run 的（位於
    `historyBaseline` 之後；沒有 baseline 時以不早於 `startedAt` 的時間戳辨識）、其後有回覆、core 自己
    記下的這個回合的工具呼叫都有結果，且最後一則回覆在最後一個工具結果之後。全部成立才標
    `completed` 並以這段回覆補結果；否則標 `awaiting_owner` 並附證據摘要。永不自動重跑。
29. FR-29：通知投遞狀態（`deliveredAt`、`seenAt`）與結果一起持久化；重開便箋時從 store 重建
    `unreadCount` 與進度，不需要原始事件流。

### 權限與核准

30. FR-30：所有 session 以 profile 的 `permissions` 建立，背景回合與互動回合相同。模型呼叫
    `ask_owner` 時建立 `awaiting_owner` 工作項，顯示在 tray 與 home 對話；沒有視窗開著時原地等待；
    永不自動核准；逾時（預設 24 小時）以原因標 `failed`。
31. FR-31：core 永不讀取 provider 憑證檔；額度與用量只經 runtime 的 `/usage/snapshot` 取得。

### 呈現契約（`BotHostApi`）

32. FR-32：命令：`getProfile`、`updateProfile`（含 `executionTarget`、`heartbeat`）、
    `listConversations`、`createConversation`、`deleteConversation`、`openView` / `closeView`（只改視圖）、
    `sendOwnerMessage(conversationId, text)`、`cancelTurn(conversationId)`、`markSeen(conversationId)`、
    `listSchedules`、`cancelSchedule`、`resolveApproval(workItemId, decision)`、`quit`。
    事件：`conversation.updated`、`turn.delta`、`turn.completed`、`work.awaitingOwner`、
    `presence.changed`、`runtime.status`。renderer 永遠拿不到 runtime 的 URL 與 API key。
33. FR-33：便箋視圖：串流輸出、輸入框、歷史、取消、未讀標記、螢幕內拖曳、可選 always-on-top。
    tray：開啟 home 便箋、列出對話、新便箋、暫停心跳、結束。關便箋、刪對話、結束 bot 三者分離。
34. FR-34：第一階段在 Electron 主程序內掛載 core，經 contextBridge / IPC 暴露 `BotHostApi`；
    所有計時器在主程序；renderer 不持有任何需要落盤的狀態。

### Non-Functional Requirements

- **成本**：預設心跳間隔下，整天醒著的 bot 每天約 12–48 次隱藏回合；可關閉；每次安靜的心跳
  也算在 provider 額度裡，並可在 `logs/` 看到次數。
- **容量**：私有 runtime 預設上限 50 個 session；bot 用 1 個 home 加開著的便箋數；ephemeral
  provider 每回合 spawn 一次；FileWatcher 匯入的 discovered 項目沒有 worker，不計入上限。
- **量測**（第三階段 2026-10-27 於 Windows 11、Electron 41.2.0、runtime 0.6.1 以 fixture provider 實測；
  數字即預算，真的 CLI 另加它自己的成本）：

  | 情境 | 2026-10-27 實測（fixture provider） |
  | --- | --- |
  | 只有 tray、閒置（便箋藏起但 renderer 仍在） | 7 個程序（Electron 5、runtime node 1、conhost 1）、working set 468 MB、private 312 MB、10 秒內 CPU 0.03% |
  | 開 1 張與 3 張便箋 | 1 張：7 個程序、working set 470 MB、private 314 MB；3 張：11 個程序（含 provider worker）、working set 725 MB、private 403 MB、CPU 0.21%；每張便箋約 +100–130 MB working set |
  | 第一次與 resume 後的 CLI 回合 | 新便箋第一回合（建 session 加 spawn fixture）首字 175 ms、完成 184 ms；暖 session 第二回合首字 34 ms、完成 42 ms（只含 bot 與 runtime 的開銷） |
  | 視窗全關、排程執行 | 三張便箋全藏起後以 CLI 加 1 分鐘後的排程：到期後的下一個 tick 執行（加入後 119 秒），結果寫入 journal 與 transcript，home `unreadCount` 變 1 |
  | 同時 2 隻 bot | 各自一個 runtime：第一隻（3 張藏起的便箋）working set 726 MB，第二隻（1 張）660 MB，合計約 1.4 GB、18 個程序；閒置 CPU 0.03–0.13%；provider 容量未競爭（fixture） |
  | 顯示器遺失與恢復 | 尚未量測（需要實體顯示器變更）；視窗位置在開啟時夾回可見工作區 |

  預算含意：藏起的便箋不釋放 renderer，若要壓低 tray 閒置成本，日後可在藏起一段時間後銷毀視窗再重建。

- **安全**：runtime 只綁 loopback；API key 每隻 bot 隨機產生；Telegram token 優先存 OS 憑證庫，
  退回檔案時限制權限並明示風險（不照抄 platform 的明文存法）；日誌不含 prompt、回覆與憑證。
- **狀態衛生**：測試只用暫存目錄與假的 runtime client；整合測試的 runtime 用暫存 `CATS_RUNTIME_DIR`；
  永不碰真的 `~/.cats`。
- **可攜性**：第一階段只驗收 Windows；core 本身不得含平台專屬路徑假設。

## Acceptance

對應 PLAN-001 的各階段；每一條都要有可重跑的測試或留下證據的手動驗收。

- A1 無頭 core：以真的選定 CLI（或 runtime 的腳本化 fixture provider）建立對話、串流回覆、取消、
  resume；重啟 core 後 profile、對話與 journal 一致，`interrupted` 的工作項不被重跑；私有 runtime
  的登錄裡有 discovered 項目時，bot 的對話列表不受影響，且自己 session 的 `history` 可讀。
- A2 活著：在對話裡用工具建立「30 分鐘後」的排程，關閉所有視窗，到點執行、結果保留、
  通知事件發出；殺掉 runtime 程序後 home 的 session 在 60 秒內回到 `ready`；長回合進行中（`busy`）
  跑過的 tick 不留下任何 resume、重建或取消紀錄，回合正常完成；`initializing` 的 session 由心跳帶到
  ready；心跳回 `[quiet]` 時對話沒有新訊息但日誌有紀錄；重複輸入合併；provider busy 或不可用時的
  狀態與訊息真實。
- A3 殼：關掉便箋，執行繼續；重開便箋，歷史與進度重建；Quit 後沒有 runtime 與 CLI 孤兒。
- A4 多便箋與全域變更：在一張便箋寫入暗號，另一張便箋問不到；變更 provider/model 後，進行中的
  回合用舊設定收尾、下一個回合用新設定；舊 attachment 不被 resume。
- A5 Telegram（可選階段）：私訊進來由 home 對話回覆，同一 token 只有一個 polling 消費者。
- A6 邊界：架構邊界測試證明 core 沒有 import `electron` 與任何 `cats-platform` 路徑。

## Design Overview

- `src/core/profile/`：`BotProfile` 讀寫與預設值。
- `src/core/store/`：原子寫入、鎖檔、journal 追加與重建。
- `src/core/runtime/`：子程序監督（啟動、ready、退避重啟、關閉）與 HTTP client（sessions、messages、
  resume、cancel、observe、health）。
- `src/core/conversations/`：對話、transcript、attachment、承接包。
- `src/core/queue/`：工作項、接納、序列化佇列、session gate、回合執行與事件解析。
- `src/core/life/`：對帳 tick、排程、心跳、復原。
- `src/core/tools/`：bot 的 session MCP server（排程與 `ask_owner`）。
- `src/core/host-api/`：`BotHostApi` 的型別與事件匯流排。
- `src/cli/`：無頭入口 `cats-bot`（`init`、`run`、`say`、`status`、`schedule`）。
- `src/shell/electron/`：第三階段的 tray、便箋視窗與 IPC 橋接。

```text
tray / note windows (Electron renderer)
        │  BotHostApi (IPC; commands + events)
bot core (Node, in the Electron main for Phase 1; headless via `cats-bot run`)
        │  loopback HTTP + API key
cats-runtime (app-managed child, --port 0, private CATS_RUNTIME_DIR)
        │
provider CLI (claude / codex / pi resident; others spawned per turn and resumed)
```

## Dependencies

- `@cats-inc/cats-runtime`，精確版本（npm `latest` 為 0.6.1；main 上的 0.6.2 尚未發布）。
- Node.js 24；TypeScript 5（可擦除語法）；`node:test`。
- Electron（第三階段）。
- 一個最小的 MCP Streamable HTTP server 實作（第二階段；runtime 的 `mcpServers` 只接受 `transport: http`，
  自寫、不引入 SDK，決定記在 PLAN-001）。
- 設計參考：platform `src/products/chat/companion/life/`、`sessionTurnGate.ts`、
  `platform/transports/telegram/polling.ts`、`desktop/host/tray.ts` 與 `candidateProfile.ts`。

## Open Questions

- [x] Telegram token 的儲存（2026-10-27）：存在資料根目錄的 `secrets.json`；Electron 殼以 `safeStorage`（Windows DPAPI、
      macOS Keychain、Linux secret service）加密後存入，無頭 CLI 退回明文檔案（POSIX 設 0600）並在指令輸出明示；
      有加密能力的殼在啟動時、以及收到 CLI 換 token 的交接時，把明文項目重新加密存入；狀態回報的是實際存放的
      保護方式，不是 host 的能力。以一種方式存入的值另一種 host 讀不到時回報，不猜。
- [ ] 作息：是否沿用 ADR-127 的 bedtime / wake window，還是只有閒置政策與手動暫停。
- [ ] 共用 bot 記憶的挑選與呈現（事實、承諾、open loops）。
- [ ] 同一 provider 換 model 時是否能不換 session（取決於各 CLI 是否支援每回合指定 model）。
- [x] home 對話預設鏡像到 Telegram（2026-10-27）：啟用時 home 的每則完成回覆（含心跳開口與排程結果）依序送到 owner 的
      chat；便箋對話不鏡像。
- [ ] 多 bot 共用 runtime 的評估門檻。
- [ ] 第五階段的殼：Electron 加原生 helper，或 fleet 的宿主加 core 子程序。
- [ ] file-backed discovery 的成本：若監看使用者整個 session 目錄不可接受，向 runtime 提「關閉
      file-backed discovery 但保留 `history` 讀取」的旗標。

## References

- [ADR-001](../decisions/001-build-a-resident-bot-core-on-cats-runtime-with-disposable-presentation.md)
- [PLAN-001](../plans/PLAN-001-resident-bot-core-foundation.md)
- [Standalone Living Bot Feasibility](../research/2026-10-27-standalone-living-bot-feasibility.md)、
  [Resident Bot Architecture Assessment](../research/2026-10-27-resident-bot-architecture-assessment.md)
- cats-runtime [docs/api.md](../../../cats-runtime/docs/api.md)、
  [SPEC-012](../../../cats-runtime/docs/specs/SPEC-012-scheduled-wakeup-substrate.md)
- cats-platform [SPEC-124](../../../cats-platform/docs/specs/SPEC-124-alive-companion-life-loop.md)

---

*Created: 2026-10-27*
*Author: Claude*
*Related Plan: [PLAN-001](../plans/PLAN-001-resident-bot-core-foundation.md)*
