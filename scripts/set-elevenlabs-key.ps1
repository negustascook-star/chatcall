$ErrorActionPreference = "Stop"

$projectRoot = Split-Path -Parent $PSScriptRoot
$envPath = Join-Path $projectRoot ".env"

if (-not (Test-Path -Path $envPath)) {
    Write-Host "Nerastas .env failas: $envPath" -ForegroundColor Red
    exit 1
}

Write-Host ""
Write-Host "ElevenLabs API rakto irasymas" -ForegroundColor Cyan
Write-Host "Raktas bus irasytas i: $envPath"
Write-Host "Raktas nebus rodomas ekrane."
Write-Host ""

$secure = Read-Host "Iklijuokite ElevenLabs API rakta" -AsSecureString
$bstr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
try {
    $key = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($bstr)
}
finally {
    [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($bstr)
}

$key = $key.Trim()
if ([string]::IsNullOrWhiteSpace($key)) {
    Write-Host "Raktas tuscias - nieko nekeiteme." -ForegroundColor Red
    exit 1
}

$lines = Get-Content -Path $envPath | Where-Object { $_ -notmatch '^\s*ELEVENLABS_API_KEY\s*=' }
$lines += "ELEVENLABS_API_KEY=$key"

[IO.File]::WriteAllLines($envPath, $lines, [Text.UTF8Encoding]::new($false))

if (Select-String -Path $envPath -Pattern '^ELEVENLABS_API_KEY=.+' -Quiet) {
    Write-Host ""
    Write-Host "ISSaugOTA. Dabar paleiskite: npm run elevenlabs:audit" -ForegroundColor Green
}
else {
    Write-Host "Nepavyko issaugoti." -ForegroundColor Red
    exit 1
}
