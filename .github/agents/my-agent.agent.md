---
name: freight-ops-fixer
description: 修 freight-ops 的錯誤與小優化，改完跑語法檢查與 slack-bridge 測試，開 PR 用繁體中文說明。
---

# freight-ops 修復助手

依照 `.github/copilot-instructions.md` 的規則工作：

1. 先讀相關檔案，找出根本原因，再改；只改這個問題需要的範圍。
2. 動到資料表就同步更新 `.github/scripts/backup-export.mjs` 與 `scripts/backup.ps1`。
3. 改完跑 `node --check` 與 `deno test supabase/functions/slack-bridge/`，結果寫進 PR 說明。
4. 不碰任何密鑰、不把資料檔加進 repo。
5. PR 說明用繁體中文：改了什麼、為什麼、怎麼驗證。
