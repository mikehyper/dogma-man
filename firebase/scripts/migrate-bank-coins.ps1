# Одноразовая миграция bankCoins для всех профилей без поля в Firestore.
# Перед запуском задайте секрет в Firebase:
#   firebase functions:config:set migration.secret="ВАШ_СЛУЧАЙНЫЙ_СЕКРЕТ"
#   firebase deploy --only functions:adminMigrateBankCoins
#
# Пробный прогон (без записи):
#   .\migrate-bank-coins.ps1 -Secret "ВАШ_СЛУЧАЙНЫЙ_СЕКРЕТ" -DryRun
#
# Боевой прогон:
#   .\migrate-bank-coins.ps1 -Secret "ВАШ_СЛУЧАЙНЫЙ_СЕКРЕТ"

param(
    [Parameter(Mandatory = $true)]
    [string]$Secret,

    [switch]$DryRun
)

$projectId = "dogmamangame"
$region = "us-central1"
$baseUrl = "https://$region-$projectId.cloudfunctions.net/adminMigrateBankCoins"
$query = if ($DryRun) { "?dryRun=1" } else { "" }
$uri = "$baseUrl$query"

$response = Invoke-RestMethod -Method Get -Uri $uri -Headers @{
    "x-migration-secret" = $Secret
}

$response | ConvertTo-Json -Depth 5
