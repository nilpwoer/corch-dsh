param([string]$Config = 'config.local.yaml')

$ErrorActionPreference = 'Stop'
Set-Location -LiteralPath $PSScriptRoot
if (-not (Test-Path -LiteralPath $Config)) {
  throw '请先复制 config.example.yaml 为 config.local.yaml，填写数据库、令牌、模型密钥，并开启 preview.enabled。'
}
go build -o teaching-worker.exe .
if ($LASTEXITCODE -ne 0) { throw 'Worker 编译失败。' }
& .\teaching-worker.exe serve -c $Config
exit $LASTEXITCODE
