param(
    [string]$ApiKey
)

# Fall back to .dev.vars if no key passed
if (-not $ApiKey) {
    $devVars = Join-Path $PSScriptRoot ".dev.vars"
    if (Test-Path $devVars) {
        $line = Get-Content $devVars | Where-Object { $_ -match '^WORKER_API_KEY=' } | Select-Object -First 1
        if ($line) { $ApiKey = $line.Split('=', 2)[1].Trim() }
    }
}
if (-not $ApiKey) { Write-Error "No WORKER_API_KEY. Pass -ApiKey or add WORKER_API_KEY=... to .dev.vars"; exit 1 }

# Registers all bot slash/context-menu commands with Discord via the Worker's
# /register-commands endpoint (bulk PUT — overwrites the full global command set).
# Includes the 6 public support commands: locate, configpack, mclog,
# compatibility, versions, datapack.

$response = Invoke-RestMethod `
    -Uri "https://moogsmods-bot.finndog176.workers.dev/register-commands" `
    -Method Post `
    -Headers @{ "X-API-Key" = $ApiKey }

Write-Host "register-commands: $response"
