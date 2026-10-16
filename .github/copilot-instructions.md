# Copilot 在 freight-ops 的工作說明

## 回覆
- 一律用繁體中文白話；程式碼、檔名、路徑、API 名稱保留原文。
- 審 PR 時先講會壞掉的問題，再講可優化的；沒問題就說沒問題，不湊數。

## 專案結構
- `index.html` + `css/` + `js/`：純前端（無打包工具），直接連 Supabase。
- `supabase/`：資料表 schema 與 migrations（`schema-v*.sql`）、Edge Function `functions/slack-bridge`（Deno）。
- `.github/scripts/backup-export.mjs` 與 `scripts/backup.ps1`：雲端／本機備份，**資料表清單兩邊要同步**。
- `docs/`：說明文件。

## 審查重點
- 新增資料表時：`backup-export.mjs`、`backup.ps1` 的 TABLES 與 SCHEMA_VERSION 都要更新。
- 任何密鑰（service_role key、Slack／OpenAI／Anthropic token）都不能進 repo；只有 anon key 可以出現在前端。
- 新資料表一定要有 RLS。
- 備份產物不能放進 repo 或公開位置（`backups/` 已在 .gitignore）。

## 驗證
- `node --check js/*.js .github/scripts/*.mjs`
- `deno test supabase/functions/slack-bridge/`
