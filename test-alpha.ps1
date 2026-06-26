param(
    [string]$ApiKey
)

if (-not $ApiKey) {
    $devVars = Join-Path $PSScriptRoot ".dev.vars"
    if (Test-Path $devVars) {
        $line = Get-Content $devVars | Where-Object { $_ -match '^WORKER_API_KEY=' } | Select-Object -First 1
        if ($line) { $ApiKey = $line.Split('=', 2)[1].Trim() }
    }
}
if (-not $ApiKey) { Write-Error "No WORKER_API_KEY. Pass -ApiKey or add WORKER_API_KEY=... to .dev.vars"; exit 1 }

$payload = @{
    project      = "FinnSetchell/MoogsNetherStructures2"
    tag          = "3.0.0-alpha.1-1.21.x"
    branch       = "1.21-datapack"
    configPack   = "curseforge"
    javaVersion  = "21"
    modName      = "MoogsNetherStructures"
    version      = "3.0.0-alpha.1"
    mcVersion    = "1.21"
    mcStart      = "1.21"
    mcEnd        = "1.21.11"
    mcExtra      = @("26.1", "26.1.1", "26.1.2", "26.2")
    releaseType  = "alpha"
    discordPing  = $false
    cfSlug       = "mns-moogs-nether-structures"
    mrSlug       = "mns-moogs-nether-structures"
    bannerUrl    = "https://www.bisecthosting.com/images/CF/Moogs_Nether_Structures/BH_MNS_header.webp"
    avatarUrl    = "https://media.forgecdn.net/avatars/thumbnails/939/604/64/64/638419616560253774.png"
    thumbnailUrl = "https://media.forgecdn.net/avatars/thumbnails/939/604/64/64/638419616560253774.png"
    color        = "#c20045"
    displayPrefix = "MNS"
    displaySuffix = "[UNIVERSAL]"
    changelog    = "- Initial alpha test build`n- New mega fortress upper sections`n- Experimental spawner changes"
    imageUrls    = @()
    dryRun       = $true
} | ConvertTo-Json -Depth 5

$response = Invoke-RestMethod `
    -Uri "https://moogsmods-bot.finndog176.workers.dev/release" `
    -Method Post `
    -Headers @{ "X-API-Key" = $ApiKey; "Content-Type" = "application/json" } `
    -Body $payload

Write-Host "Alpha dry-run posted! releaseId: $($response.releaseId)"
