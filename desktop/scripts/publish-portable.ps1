param(
  [switch]$SkipBuild
)

$ErrorActionPreference = "Stop"

function Get-Sha256Hex([string]$Path) {
  $sha256 = [System.Security.Cryptography.SHA256]::Create()
  $stream = [System.IO.File]::OpenRead($Path)
  try {
    return ([System.BitConverter]::ToString($sha256.ComputeHash($stream))).Replace("-", "")
  }
  finally {
    $stream.Dispose()
    $sha256.Dispose()
  }
}

$desktopProject = Split-Path -Parent $PSScriptRoot
$packagePath = Join-Path $desktopProject "package.json"
$tauriConfigPath = Join-Path $desktopProject "src-tauri\tauri.conf.json"
$utf8 = New-Object System.Text.UTF8Encoding($false, $true)
$package = [System.IO.File]::ReadAllText($packagePath, $utf8) | ConvertFrom-Json
$tauriConfig = [System.IO.File]::ReadAllText($tauriConfigPath, $utf8) | ConvertFrom-Json
$version = [string]$package.version

if ([string]::IsNullOrWhiteSpace($version)) {
  throw "package.json does not contain a version."
}

if ([string]$tauriConfig.version -ne $version) {
  throw "Version mismatch: package.json is $version but tauri.conf.json is $($tauriConfig.version)."
}

if (-not $SkipBuild) {
  Push-Location $desktopProject
  try {
    & npm.cmd run tauri -- build --no-bundle
    if ($LASTEXITCODE -ne 0) {
      throw "Portable build failed with exit code $LASTEXITCODE."
    }
  }
  finally {
    Pop-Location
  }
}

$releaseDirectory = Join-Path $desktopProject "src-tauri\target\release"
$sourceExecutable = Join-Path $releaseDirectory "lingocast-studio.exe"
$portableDirectory = Join-Path $releaseDirectory "bundle"
$portableExecutable = Join-Path $portableDirectory "LingoCast Studio_${version}_portable.exe"

if (-not (Test-Path -LiteralPath $sourceExecutable -PathType Leaf)) {
  throw "The release executable was not found: $sourceExecutable"
}

New-Item -ItemType Directory -Path $portableDirectory -Force | Out-Null

$sourceHash = Get-Sha256Hex $sourceExecutable
$copyRequired = -not (Test-Path -LiteralPath $portableExecutable -PathType Leaf)
if (-not $copyRequired) {
  $portableHash = Get-Sha256Hex $portableExecutable
  $copyRequired = $sourceHash -ne $portableHash
}

if ($copyRequired) {
  try {
    Copy-Item -LiteralPath $sourceExecutable -Destination $portableExecutable -Force
  }
  catch [System.IO.IOException] {
    # Explorer or antivirus can briefly lock the previous portable executable.
    # Keep the desktop shortcut current by publishing this build under a content-addressed name.
    $portableExecutable = Join-Path $portableDirectory "LingoCast Studio_${version}_portable_$($sourceHash.Substring(0, 8)).exe"
    Copy-Item -LiteralPath $sourceExecutable -Destination $portableExecutable -Force
    Write-Warning "The previous portable executable is locked. The shortcut now targets the new build: $portableExecutable"
  }
}

$desktopDirectory = [Environment]::GetFolderPath([Environment+SpecialFolder]::DesktopDirectory)
if ([string]::IsNullOrWhiteSpace($desktopDirectory)) {
  throw "Windows Desktop directory could not be resolved."
}

$shortcutPath = Join-Path $desktopDirectory "LingoCast Studio.lnk"
$shell = New-Object -ComObject WScript.Shell
$shortcut = $shell.CreateShortcut($shortcutPath)
$shortcut.TargetPath = $portableExecutable
$shortcut.WorkingDirectory = $portableDirectory
$shortcut.IconLocation = "$portableExecutable,0"
$shortcut.Description = "LingoCast Studio $version portable"
$shortcut.WindowStyle = 1
$shortcut.Save()

$savedShortcut = $shell.CreateShortcut($shortcutPath)
if ($savedShortcut.TargetPath -ne $portableExecutable) {
  throw "Shortcut verification failed. Expected '$portableExecutable', got '$($savedShortcut.TargetPath)'."
}

if ((Get-Sha256Hex $portableExecutable) -ne $sourceHash) {
  throw "Published executable hash does not match the build."
}
$manifest = @{
  version = $version
  file = [System.IO.Path]::GetFileName($portableExecutable)
  sha256 = $sourceHash.ToLowerInvariant()
  publishedAt = [DateTime]::UtcNow.ToString("o")
} | ConvertTo-Json
[System.IO.File]::WriteAllText((Join-Path $portableDirectory "latest.json"), $manifest, $utf8)
Copy-Item -LiteralPath (Join-Path $PSScriptRoot "agent.mjs") -Destination (Join-Path $portableDirectory "agent.mjs") -Force
Copy-Item -LiteralPath (Join-Path $desktopProject "AUTOMATION.md") -Destination (Join-Path $portableDirectory "AUTOMATION.md") -Force

Write-Host "Portable release: $portableExecutable"
Write-Host "Desktop shortcut: $shortcutPath"
Write-Host "Shortcut target: $($savedShortcut.TargetPath)"
