// 讀 SUPABASE_URL / SUPABASE_SERVICE_KEY 環境變數（由 workflow 從 GitHub Secrets 帶入），
// 把下面 TABLES 每張表匯出成 backup-out/<table>.json，並產生 manifest.json。
// 這份表清單跟本機的 scripts/backup.ps1 分開維護（那份是本機備份，這份是雲端排程備份），
// 之後在 supabase/*.sql 新增資料表時，記得兩邊都要同步加（見 docs/known-issues.md 待處理項）。
import { mkdir, writeFile } from 'node:fs/promises';

const url = process.env.SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_KEY;
if (!url || !key) {
  console.error('缺少 SUPABASE_URL 或 SUPABASE_SERVICE_KEY 環境變數');
  process.exit(1);
}

const TABLES = [
  'profiles', 'departments',
  'vehicles', 'drivers', 'customers',
  'trips', 'maint', 'petty', 'billing', 'insurance', 'docs',
  'workflows', 'tasks', 'task_events', 'notifications', 'uploads', 'agent_alerts',
  'import_batches', 'raw_records', 'field_mappings',
  'slack_threads', 'slack_events'
];
const SCHEMA_VERSION = 'v6（supabase/schema-v2.sql + schema-v3.sql + supabase/migrations/schema-v4-raw-layer.sql + schema-v5-slack.sql + schema-v6-slack-bridge-hardening.sql）';

const outDir = 'backup-out';
await mkdir(outDir, { recursive: true });

const counts = {};
const failed = [];

for (const t of TABLES) {
  try {
    const r = await fetch(`${url}/rest/v1/${t}?select=*`, {
      headers: { apikey: key, Authorization: `Bearer ${key}` }
    });
    if (!r.ok) throw new Error(`${r.status} ${(await r.text()).slice(0, 300)}`);
    const rows = await r.json();
    await writeFile(`${outDir}/${t}.json`, JSON.stringify(rows));
    counts[t] = Array.isArray(rows) ? rows.length : (rows ? 1 : 0);
    console.log(`[${t}] ${counts[t]} 筆`);
  } catch (e) {
    counts[t] = null;
    failed.push(t);
    console.warn(`[${t}] 匯出失敗：${e.message}`);
  }
}

let storageCount = 0;
try {
  const r = await fetch(`${url}/storage/v1/object/list/scans`, {
    method: 'POST',
    headers: { apikey: key, Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ prefix: '', limit: 1000, offset: 0 })
  });
  if (!r.ok) throw new Error(`${r.status}`);
  const objs = await r.json();
  storageCount = Array.isArray(objs) ? objs.filter(o => o.id).length : -1;
} catch (e) {
  storageCount = -1;
  console.warn('Storage 檔案數量查詢失敗：' + e.message);
}

const manifest = {
  exported_at: new Date().toISOString(),
  schema_version: SCHEMA_VERSION,
  tables: counts,
  storage_files: storageCount,
  failed_tables: failed
};
await writeFile(`${outDir}/manifest.json`, JSON.stringify(manifest, null, 2));

if (failed.length) {
  console.warn(`有 ${failed.length} 張表匯出失敗：${failed.join(', ')}，其餘表已正常備份。`);
}
