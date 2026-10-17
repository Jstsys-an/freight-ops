<#
用法：
  .\scripts\backup.ps1

會做的事：
  1. 讀 repo 根目錄的 .env，用 SUPABASE_SERVICE_KEY（service_role key，
     繞過 RLS，能讀到全部使用者的資料）把下面 $Tables 列出的每張表
     匯出成 backups\YYYY-MM-DD\<table>.json
  2. 一併查 Storage(scans bucket) 的檔案數量，寫進同一天資料夾的 manifest.json
     （manifest.json 內容：各表筆數、Storage 檔案數、匯出時間、schema 版本）
  3. 自動清掉 backups\ 底下超過 12 份的舊備份（依資料夾名稱日期排序，留最新 12 份）

backups\ 已加進 .gitignore，這些備份資料不會進 git，只留在本機。
建議搭配 Windows 工作排程器定期執行（例如每天一次）。
#>

$ErrorActionPreference = 'Stop'

$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$repoRoot = Split-Path -Parent $scriptDir
$envPath = Join-Path $repoRoot '.env'

if (-not (Test-Path $envPath)) {
  Write-Error ".env 不存在（應該在 $envPath）。請先建立並填好 SUPABASE_URL / SUPABASE_SERVICE_KEY。"
  exit 1
}

$envVars = @{}
Get-Content $envPath | ForEach-Object {
  if ($_ -match '^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$') {
    $envVars[$matches[1]] = $matches[2]
  }
}
$url = $envVars['SUPABASE_URL']
$key = $envVars['SUPABASE_SERVICE_KEY']

if ([string]::IsNullOrWhiteSpace($url) -or [string]::IsNullOrWhiteSpace($key)) {
  Write-Error "SUPABASE_URL 或 SUPABASE_SERVICE_KEY 是空的，請先檢查 .env。"
  exit 1
}

# 目前資料庫的全部資料表。跟 js/core.js 的 TABLES + js/maint.js 的 BACKUP_TABLES 對齊，
# 另外加上 profiles / notifications / agent_alerts（前端匯出故意不含這三張，
# 但這裡是伺服器端完整備份，用 service_role key 繞過 RLS，全部都要備份到）。
# 之後在 supabase/*.sql 新增資料表時，記得同步把表名加進這裡。
$Tables = @(
  'profiles','departments',
  'vehicles','drivers','customers',
  'trips','maint','petty','billing','insurance','docs',
  'workflows','tasks','task_events','notifications','uploads','agent_alerts',
  'import_batches','raw_records','field_mappings',
  'slack_threads','slack_events'
)

# 目前用的 schema 版本標記；supabase/*.sql 有結構變動時手動更新這行。
$SchemaVersion = 'v7（supabase/schema-v2.sql + schema-v3.sql + supabase/migrations/schema-v4-raw-layer.sql + schema-v5-slack.sql + schema-v6-slack-bridge-hardening.sql + schema-v7-slack-channel-isolation.sql）'

$headers = @{
  'apikey'        = $key
  'Authorization' = "Bearer $key"
  'Content-Type'  = 'application/json'
}

$dateDir = Get-Date -Format 'yyyy-MM-dd'
$outDir = Join-Path $repoRoot "backups\$dateDir"
New-Item -ItemType Directory -Force -Path $outDir | Out-Null

Write-Host "備份到 $outDir ..."

$counts = @{}
$failed = @()

foreach ($t in $Tables) {
  try {
    # Supabase 會擋看起來像瀏覽器的 secret key 請求，跟 notify.ps1 一樣要帶自訂 User-Agent。
    $rows = Invoke-RestMethod -Method Get -Uri "$url/rest/v1/$t`?select=*" -Headers $headers -UserAgent 'backup.ps1/1.0'
    $rows | ConvertTo-Json -Depth 20 -Compress | Set-Content -Path (Join-Path $outDir "$t.json") -Encoding utf8
    $n = if ($rows -is [array]) { $rows.Count } elseif ($null -eq $rows) { 0 } else { 1 }
    $counts[$t] = $n
    Write-Host "  [$t] $n 筆"
  } catch {
    $counts[$t] = $null
    $failed += $t
    Write-Warning "  [$t] 匯出失敗：$($_.Exception.Message)"
  }
}

# Storage(scans bucket) 檔案數量，best-effort，只列頂層 + 一層子資料夾（依上傳路徑慣例足夠估算）。
$storageCount = 0
try {
  $body = @{ prefix = ''; limit = 1000; offset = 0 } | ConvertTo-Json -Compress
  $objs = Invoke-RestMethod -Method Post -Uri "$url/storage/v1/object/list/scans" -Headers $headers -Body $body -UserAgent 'backup.ps1/1.0'
  $storageCount = ($objs | Where-Object { $_.id -ne $null }).Count
} catch {
  Write-Warning "  Storage 檔案數量查詢失敗：$($_.Exception.Message)（manifest 會記為 -1）"
  $storageCount = -1
}

$manifest = [ordered]@{
  exported_at    = (Get-Date).ToString('o')
  schema_version = $SchemaVersion
  tables         = $counts
  storage_files  = $storageCount
  failed_tables  = $failed
}
$manifest | ConvertTo-Json -Depth 10 | Set-Content -Path (Join-Path $outDir 'manifest.json') -Encoding utf8

if ($failed.Count -gt 0) {
  Write-Warning "有 $($failed.Count) 張表匯出失敗：$($failed -join ', ')，其餘表已正常備份。"
}

# 只保留最近 12 份備份（資料夾名稱是 yyyy-MM-dd，字串排序等於日期排序）。
$backupsRoot = Join-Path $repoRoot 'backups'
$allBackups = Get-ChildItem -Path $backupsRoot -Directory | Where-Object { $_.Name -match '^\d{4}-\d{2}-\d{2}$' } | Sort-Object Name -Descending
if ($allBackups.Count -gt 12) {
  $toDelete = $allBackups | Select-Object -Skip 12
  foreach ($d in $toDelete) {
    Remove-Item -Recurse -Force $d.FullName
    Write-Host "已刪除舊備份：$($d.Name)"
  }
}

Write-Host "備份完成：$outDir"
