# Publish a release to npm with an interactive one-time password.
#
# The npm account holder runs this; the OTP is read locally and is never
# written to disk or printed. Everything up to `npm publish` (version check,
# build, pack, install smoke) is non-destructive; the publish is the only
# irreversible step.
#
#   cd C:\Users\11403\Desktop\overwatch
#   .\scripts\publish-otp.ps1 -Version 1.0.1
#
# Prerequisites: `npm login` has been completed in this shell and the working
# tree is committed. The script refuses to overwrite an existing version.

param(
  [string]$Version = '1.0.1',
  [string]$Name = '@ailunsin/dsh-overwatch'
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$dist = Join-Path $root 'dist\ailunsin--dsh-overwatch'
Set-Location $root

if ($Version -notmatch '^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$') {
  throw "invalid version: $Version"
}

Write-Host "==> npm identity"
npm whoami
if ($LASTEXITCODE -ne 0) {
  throw 'npm is not logged in. Run `npm login` first (the account holder must complete the browser/OTP challenge), then re-run this script.'
}

Write-Host "==> existing versions of $Name"
$existing = (npm view $Name versions --json 2>$null | ConvertFrom-Json)
if ($existing -contains $Version) {
  throw "$Name@$Version already exists on npm; choose a new version."
}
Write-Host "    $Version is available"

if (Test-Path (Join-Path $root '.git')) {
  $dirty = git -C $root status --porcelain
  if ($dirty) {
    Write-Warning 'working tree is not clean:'
    $dirty | ForEach-Object { Write-Warning "  $_" }
    $answer = Read-Host 'Continue anyway? [y/N]'
    if ($answer -notin @('y', 'Y', 'yes', 'YES')) { throw 'aborted' }
  }
}

$current = (Get-Content (Join-Path $root 'package.json') -Raw | ConvertFrom-Json).version
if ($current -eq $Version) {
  Write-Host "==> package.json already at $Version"
} else {
  Write-Host "==> bump package.json $current -> $Version"
  npm version $Version --no-git-tag-version
  if ($LASTEXITCODE -ne 0) { throw 'npm version failed' }
}

Write-Host '==> build scoped release'
npm run build:release -- --version $Version
if ($LASTEXITCODE -ne 0) { throw 'build:release failed' }

Write-Host '==> npm pack --dry-run'
Push-Location $dist
try {
  npm pack --dry-run
  if ($LASTEXITCODE -ne 0) { throw 'npm pack --dry-run failed' }
} finally {
  Pop-Location
}

Write-Host '==> install smoke (directory package)'
node (Join-Path $root 'scripts\smoke-install.mjs') --package $dist
if ($LASTEXITCODE -ne 0) { throw 'smoke-install failed' }

Write-Host '==> publish'
$secure = Read-Host -AsSecureString 'npm 6-digit OTP'
$bstr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
try {
  $otp = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($bstr)
} finally {
  [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($bstr)
}
if ($otp -notmatch '^\d{6}$') { throw 'OTP must be 6 digits' }

Push-Location $dist
try {
  npm publish --access public --otp $otp
  if ($LASTEXITCODE -ne 0) { throw 'npm publish failed' }
} finally {
  Pop-Location
}

Write-Host '==> verify'
npm view $Name version
Write-Host ''
Write-Host "published $Name@$Version"
Write-Host 'Next: commit the version bump, tag it, push, and create the GitHub release:'
Write-Host "  git add package.json; git commit -m 'release: v$Version'"
Write-Host "  git tag -a v$Version -m 'v$Version'; git push origin main --tags"
