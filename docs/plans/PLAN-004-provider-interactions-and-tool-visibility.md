# PLAN-004: Provider Interactions and Tool Visibility

## Metadata

| Field | Value |
| --- | --- |
| Status | In progress；headless 控制、政策與復原已實作，renderer／原生操作驗收進行中 |
| Owner | Bot core、CLI、Electron shell |
| Assigned To | Unassigned |
| Reviewer | Product owner、Runtime maintainers |
| Related spec | [SPEC-004](../specs/SPEC-004-provider-interactions-and-tool-visibility.md) |

## Overview

Owner 於 2026-10-28 授權文件 PR 自動合併後，拉最新程式碼切片實作並陸續提交。
本授權不包含版本發布。
沿用 PLAN-001 的 headless-first 順序，先證明 core 能回答，再接上便箋／tray。
Runtime PLAN-049 是共同前置，Platform PLAN-124 不構成 Bot 的執行依賴。

## Implementation Phases

### P0 — 契約、相容性與資料升級設計

- [ ] 對齊 Runtime P0 的 interaction、reply、policy、inventory fixtures 與版本化 capability。
- [ ] 明確區分 ask_owner、recovery rerun 與 provider interaction，定義 configRevision
  邊界、等待時仍佔住的 turn gate、reply 控制路徑與 restart 判定。
- [ ] 設計 profile/journal 的最小新增資料及受保護 upgrade；定義舊 CLI 命令語意。

**Exit:** 支援的 Runtime 身分與協定已固定，舊資料不因新權限選項而變寬。

### P1 — Headless core 與 CLI

- [ ] 消費 Runtime P1/P2，以精確套件／候選 artifact 驗證，不從兄弟 repo source import。
- [ ] 加入 core 互動 registry、journal projection、snapshot/event 對帳與 BotHostApi。
- [ ] CLI 增加列出與 typed response 操作；敏感答案由 stdin／受控輸入傳送。
- [ ] 保留全域 gate，回覆走控制路徑；整合 waiting、deadline、provider resolve 與 cancel。

**Exit:** 無 Electron／Platform 的整合測試通過 A1/A2；原生問題不轉成重新執行 prompt。

### P2 — Life loop、復原與 retarget

- [ ] 讓 reconcile／heartbeat／scheduler 辨識 pending interaction，保護 busy worker。
- [ ] 驗證 core／Runtime／worker 重啟、retarget、對話刪除、quit 與 reply race。
- [ ] 通過 journal/profile upgrade 的驗證、備份、原子替換及失敗復原測試。
- [ ] 回歸 ask_owner、中斷重試批准、多便箋隔離及不重疊 tick。

**Exit:** A3–A5/A7 的 core 部分通過；沒有等待造成的死鎖、自動重跑或擴權。

### P3 — 便箋／tray 與設定診斷

- [ ] 便箋加入有來源的問題／批准／表單／URL-flow 卡片及失效狀態。
- [ ] tray／浮動貓可定位 pending conversation；通知去重，未讀數與待回覆數分清。
- [ ] 消費 Runtime P3，設定及 CLI 顯示有效權限、工具來源、部分清單與 helper readiness。
- [ ] 殼全程經 BotHostApi；Telegram 本期僅通知，不把一般文字當作原生回覆。

**Exit:** 關閉／重建 renderer 不影響 core 的 live 請求；敏感輸入不留在歷史。

### P4 — 原生與包裝驗收

- [ ] 執行受影響的 core／integration／architecture-boundary 測試、typecheck 與 build。
- [ ] 以暫存 Bot data root 和受控測試目標完成 SPEC-004 A1–A7；不讀寫真實 `~/.cats`。
- [ ] 匹配 Terminal 的 CLI/account/config/cwd/trust/policy/helper 條件後，比較工具來源，
  分別驗證受控 Chrome 導航／讀取與測試視窗中的無害桌面操作。
- [ ] 驗證上游 helper 不在／停止時的失敗與恢復資訊；不以 catalog 成功當作操作成功。
- [ ] 用確切 Runtime pin 驗證 Windows packaged candidate；macOS/Linux 未驗保持待驗。

**Exit:** 有獨立於 Platform 的 Bot 操作證據。發布、版本與安裝到使用者既有 profile
皆不由本文件步驟自動授權。

## Files to Create/Modify

| Area | Intended change |
| --- | --- |
| `src/core/runtime/client.ts`、`src/core/conversations/binder.ts` | Negotiation、reply、inventory 與政策 |
| `src/core/bot.ts`、`src/core/queue`、`src/core/life` | 等待、gate、tick、retarget 與復原 |
| `src/core/store`、`src/core/profile` | 必要的去敏感狀態與受保護升級 |
| `src/core/host-api`、`src/cli/main.ts`、`src/shell` | 共同 API、CLI 與殼的呈現 |
| `tests/integration`、core tests | Scripted provider 請求及生命週期回歸 |

## Testing Strategy and Risks

先以 fake Runtime／clock，再用真的受管 Runtime 加 scripted provider 測 request/reply，
最後才做隔離原生操作驗收。重點是 gate 中的回覆不死鎖、等待不被 tick 回收、舊 request
不能在新 worker 生效，與既有 ask_owner 語意不混淆。
測試只使用暫存狀態，清理自己建立的程序／視窗；不把使用者的 bot 當測試 fixture。
這次文件只做連結、差異與契約一致性檢查，未執行應用或模型測試。

## Progress Log

| Date | Update |
| --- | --- |
| 2026-10-28 | 依 Bots `7951c28` 與 Runtime 0.6.1 現況建立草稿；P0–P4 尚未開始，套件／profile 未改。 |
| 2026-10-28 | 同時合併的 renderer 工作 `6598b9c` 已使用 SPEC-003／PLAN-003；本案編為 SPEC-004／PLAN-004。實作前整合該 renderer 基線。 |
| 2026-10-28 | P0–P2 headless slice：精確 pin Runtime b75da37b candidate（未發布），CLI stdin/local pipe 控制、same-turn 回覆、全域 gate、去敏感 receipts、schema 1→2 鎖內備份／原子升級、policy negotiation 與 session inventory。49 項 affected core/life/shell/boundary 測試與 build/typecheck 通過；packed Runtime + scripted Codex native input 整合通過。獨立審閱的 snapshot race、空 allowlist、升級 single-writer、未知 backup 與失敗 cleanup 缺口已修正並重驗。真正 Chrome／桌面操作、renderer／packaged candidate 驗收尚待完成。Schema 2 的正式發布需下一 Bot minor 0.2；本工作不 bump／publish。 |

*Created / last updated: 2026-10-28*
