import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
const run = promisify(execFile)
const SCRIPT = `
$ErrorActionPreference='Stop'
[Console]::OutputEncoding=New-Object System.Text.UTF8Encoding($false)
$p=$env:ENSP_INCIDENT_QUERY|ConvertFrom-Json
try { $events=@(Get-WinEvent -FilterHashtable @{LogName='Application';Id=1000,1001;StartTime=[datetime]$p.from;EndTime=[datetime]$p.to} -MaxEvents ($p.limit+1)) }
catch { if($_.FullyQualifiedErrorId -like 'NoMatchingEventsFound*'){$events=@()}else{throw} }
$rows=@(foreach($e in $events){
 if($e.ProviderName -notin @('Application Error','Windows Error Reporting')){continue}
 $xml=[xml]$e.ToXml();$d=@{}
 foreach($n in $xml.Event.EventData.Data){$d[[string]$n.Name]=[string]$n.'#text'}
 $app=if($e.Id -eq 1000){$d.AppName}else{$d.P1}
 if($app -notmatch '^(eNSP_(Client|PCServer|VBoxServer)\\.exe|DeepSeek Harness\\.exe|dsh\\.exe)$'){continue}
 $safe=@{};foreach($k in @('AppName','AppPath','ModuleName','ModulePath','ExceptionCode','FaultingOffset','ProcessId','ProcessCreationTime','IntegratorReportId','ReportId','EventName','P1','P2','P3','P4','P5','P6','P7','P8')){if($d.ContainsKey($k)){$safe[$k]=$d[$k]}}
 @{id=$e.Id;channel='Application';provider=$e.ProviderName;recordId=$e.RecordId;time=$e.TimeCreated.ToUniversalTime().ToString('o');data=$safe}
})
@{rows=$rows;scanned=$events.Count;truncated=($events.Count -gt $p.limit)}|ConvertTo-Json -Depth 6 -Compress
`
export async function collectWindowsEvents({ from, to, limit = 2000, timeoutMs = 20000 } = {}) {
  if (process.platform !== 'win32') throw Object.assign(Error('Windows event collection unavailable'), { code: 'UNSUPPORTED_PLATFORM' })
  const { stdout } = await run('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', SCRIPT], {
    encoding: 'utf8', windowsHide: true, timeout: Math.max(1, Math.floor(timeoutMs)), maxBuffer: 4 * 1024 * 1024,
    env: { ...process.env, ENSP_INCIDENT_QUERY: JSON.stringify({ from, to, limit }) },
  })
  const result = JSON.parse(stdout.replace(/^\uFEFF/u, ''))
  return { ...result, rows: Array.isArray(result.rows) ? result.rows : result.rows ? [result.rows] : [] }
}
