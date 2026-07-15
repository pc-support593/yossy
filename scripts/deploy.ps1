<#
  Deploy local changes to the VPS (220.158.29.105).
  Usage (run from project root):
    powershell -ExecutionPolicy Bypass -File scripts\deploy.ps1
#>

$ErrorActionPreference = "Stop"

$PemPath = "C:\Users\y-honda\Desktop\claude\Yoshimuraichi.pem"
$ServerIp = "220.158.29.105"
$RemoteDir = "/opt/expense-report-system"
$ProjectRoot = Split-Path -Parent $PSScriptRoot
$TarPath = Join-Path $env:TEMP "expense-deploy.tar.gz"

Write-Host "1/5 Packing local changes into tar.gz..." -ForegroundColor Cyan
Push-Location $ProjectRoot
tar --exclude="node_modules" --exclude="data" --exclude=".git" --exclude=".env" -czf $TarPath .
Pop-Location

Write-Host "2/5 Uploading to VPS..." -ForegroundColor Cyan
scp -i $PemPath $TarPath "root@${ServerIp}:${RemoteDir}/expense-deploy.tar.gz"

Write-Host "3/5 Extracting and installing dependencies on VPS..." -ForegroundColor Cyan
ssh -i $PemPath "root@$ServerIp" "cd $RemoteDir && tar -xzf expense-deploy.tar.gz && rm expense-deploy.tar.gz && npm install --omit=dev"

Write-Host "4/5 Restarting server..." -ForegroundColor Cyan
ssh -i $PemPath "root@$ServerIp" "pm2 restart expense-report"

Write-Host "5/5 Checking server is up..." -ForegroundColor Cyan
Start-Sleep -Seconds 2
try {
  $res = Invoke-WebRequest -Uri "http://${ServerIp}/login" -UseBasicParsing -TimeoutSec 10
  Write-Host "OK: status $($res.StatusCode)" -ForegroundColor Green
} catch {
  Write-Host "WARNING: health check failed. Check logs with: ssh -i `"$PemPath`" root@$ServerIp 'pm2 logs expense-report --lines 50'" -ForegroundColor Yellow
}

Remove-Item $TarPath -ErrorAction SilentlyContinue
Write-Host "Deploy complete" -ForegroundColor Green
