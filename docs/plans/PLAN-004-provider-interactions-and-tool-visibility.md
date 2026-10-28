# PLAN-004: Provider Interactions and Tool Visibility

## Metadata

| Field | Value |
| --- | --- |
| Status | Implementation complete；headless／renderer／Windows fixture 通過，原生工具已呼叫；成功 Chrome／桌面操作受上游 helper 限制 |
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

- [x] 對齊 Runtime P0 的 interaction、reply、policy、inventory fixtures 與版本化 capability。
- [x] 明確區分 ask_owner、recovery rerun 與 provider interaction，定義 configRevision
  邊界、等待時仍佔住的 turn gate、reply 控制路徑與 restart 判定。
- [x] 設計 profile/journal 的最小新增資料及受保護 upgrade；定義舊 CLI 命令語意。

**Exit:** 支援的 Runtime 身分與協定已固定，舊資料不因新權限選項而變寬。

### P1 — Headless core 與 CLI

- [x] 消費 Runtime P1/P2，以精確套件／候選 artifact 驗證，不從兄弟 repo source import。
- [x] 加入 core 互動 registry、journal projection、snapshot/event 對帳與 BotHostApi。
- [x] CLI 增加列出與 typed response 操作；敏感答案由 stdin／受控輸入傳送。
- [x] 保留全域 gate，回覆走控制路徑；整合 waiting、deadline、provider resolve 與 cancel。

**Exit:** 無 Electron／Platform 的整合測試通過 A1/A2；原生問題不轉成重新執行 prompt。

### P2 — Life loop、復原與 retarget

- [x] 讓 reconcile／heartbeat／scheduler 辨識 pending interaction，保護 busy worker。
- [x] 驗證 core／Runtime／worker 重啟、retarget、對話刪除、quit 與 reply race。
- [x] 通過 journal/profile upgrade 的驗證、備份、原子替換及失敗復原測試。
- [x] 回歸 ask_owner、中斷重試批准、多便箋隔離及不重疊 tick。

**Exit:** A3–A5/A7 的 core 部分通過；沒有等待造成的死鎖、自動重跑或擴權。

### P3 — 便箋／tray 與設定診斷

- [x] 便箋加入有來源的問題／批准／表單／URL-flow 卡片及失效狀態。
- [x] tray／浮動貓可定位 pending conversation；通知去重，未讀數與待回覆數分清。
- [x] 消費 Runtime P3，設定及 CLI 顯示有效權限、工具來源、部分清單；helper 無直接證據時顯示 unknown。
- [x] 殼全程經 BotHostApi；Telegram 本期僅通知，不把一般文字當作原生回覆。

**Exit:** 關閉／重建 renderer 不影響 core 的 live 請求；敏感輸入不留在歷史。

### P4 — 原生與包裝驗收

- [x] 執行受影響的 core／integration／architecture-boundary 測試、typecheck 與 build。
- [x] 以暫存 Bot data root 完成 A1–A5/A7 的 fixture 驗收；不讀寫真實 `~/.cats`。
- [ ] 匹配 Terminal 的 CLI/account/config/cwd/trust/policy/helper 條件後，比較工具來源，
  分別驗證受控 Chrome 導航／讀取與測試視窗中的無害桌面操作。
- [x] 記錄目前 helper 不可用時的實際失敗與設定方向；重啟 helper 後的恢復仍未驗證。
- [x] 用確切 Runtime pin 建置 Windows unpacked candidate；b75da37b 的 UI 驗收與
  50ef02b4 的重新包裝／headless 整合分開記錄，macOS/Linux 未驗保持待驗。

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
原始文件 PR 未執行模型；實作階段的 fixture、candidate 與真實模型工具呼叫見下列紀錄。

## Progress Log

| Date | Update |
| --- | --- |
| 2026-10-28 | 依 Bots `7951c28` 與 Runtime 0.6.1 現況建立草稿；P0–P4 尚未開始，套件／profile 未改。 |
| 2026-10-28 | 同時合併的 renderer 工作 `6598b9c` 已使用 SPEC-003／PLAN-003；本案編為 SPEC-004／PLAN-004。實作前整合該 renderer 基線。 |
| 2026-10-28 | P0–P2 headless slice：精確 pin Runtime b75da37b candidate（未發布），CLI stdin/local pipe 控制、same-turn 回覆、全域 gate、去敏感 receipts、schema 1→2 鎖內備份／原子升級、policy negotiation 與 session inventory。49 項 affected core/life/shell/boundary 測試與 build/typecheck 通過；packed Runtime + scripted Codex native input 整合通過。獨立審閱的 snapshot race、空 allowlist、升級 single-writer、未知 backup 與失敗 cleanup 缺口已修正並重驗。真正 Chrome／桌面操作、renderer／packaged candidate 驗收尚待完成。Schema 2 的正式發布需下一 Bot minor 0.2；本工作不 bump／publish。 |
| 2026-10-28 | P3 slice：便箋六種原生互動、受控 URL、tray 定位及去敏感通知；設定頁分離 policy 與 legacy 控制並顯示 session inventory。獨立 UI/IPC review 已收斂；9 項 focused tests、typecheck/build 通過。隔離 Electron 與 Windows unpacked candidate（Runtime b75da37b）完成 renderer reload → same-turn reply；長歷史＋4 terminal receipts 仍定位新請求，required 空字串／空陣列／optional 空 enum 回覆成功。尚未宣稱真正 Chrome／桌面工具操作、macOS/Linux 或發布通過。 |
| 2026-10-28 | P4 native 比較：Codex 0.164.0，同一 Windows 使用者／config／測試 cwd、explicit workspace-write/offline/on-request/reviewer=user。真實 Bot core（Runtime b75da37b）與 Terminal 均實際呼叫 Chrome 建 tab，得到 Browser is not available: chrome；受控 WinForms 目標的 native listing 均得到 missing native pipe（OS error 2），沒有 tab 或按鈕操作成功。Bot 的 policy verified，configured MCP 為 279/3/4，另有 4 個 Bot 注入工具。工具呼叫路徑已接通，A6 的成功操作與 helper 恢復仍待環境可用後驗收。 |
| 2026-10-28 | Follow-up slice：pin Runtime 50ef02b4686c1fff6b60819d292acc5b2e1ef773，修正同 cwd 的舊 Codex thread 被錯認及失敗 admission 刪除 transcript；精確 tgz digest 見 vendor/README。整數表單將小數上下限轉為 ceil/floor，4 個實際 DOM validity 案例經獨立檢查。新 pin 的 12 項 focused tests（含真實 packed Runtime + scripted provider）、typecheck/build 通過，Electron 41.2.0 Windows unpacked 重新建置並核對含修正的 Runtime。沒有重新宣稱原生工具成功，亦未發布。 |

*Created / last updated: 2026-10-28*
