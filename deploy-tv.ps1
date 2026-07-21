param(
  [string]$Device = "192.168.1.201:26101",
  [string]$Profile = "LivingRoomTV",
  [string]$ProjectPath = "$PSScriptRoot\tizen-hello-test\HelloTV",
  [string]$PackageName = "MovieServerTV.wgt",
  [string]$PackageId = "4NhLsB4hhb",
  [string]$AppId = "4NhLsB4hhb.HelloTV",
  [switch]$Run,
  [switch]$UninstallFirst
)

$ErrorActionPreference = "Stop"

function Resolve-Tool {
  param(
    [string]$Name,
    [string[]]$Candidates
  )

  foreach ($candidate in $Candidates) {
    if (Test-Path -LiteralPath $candidate) {
      return (Resolve-Path -LiteralPath $candidate).Path
    }
  }

  $cmd = Get-Command $Name -ErrorAction SilentlyContinue
  if ($cmd) {
    return $cmd.Source
  }

  throw "Could not find $Name. Install Tizen Studio or add it to PATH."
}

$tizen = Resolve-Tool "tizen" @(
  "C:\tizen-studio\tools\ide\bin\tizen.bat"
)
$sdb = Resolve-Tool "sdb" @(
  "C:\tizen-studio\tools\sdb.exe",
  "C:\tizen-studio\tools\ide\bin\sdb.exe"
)

$project = (Resolve-Path -LiteralPath $ProjectPath).Path
$buildResult = Join-Path $project ".buildResult"
$packagePath = Join-Path $buildResult $PackageName

Write-Host "Connecting to TV $Device..."
& $sdb connect $Device
if ($LASTEXITCODE -ne 0) { throw "sdb connect failed." }

Write-Host "Building Tizen web project..."
& $tizen build-web -- $project
if ($LASTEXITCODE -ne 0) { throw "tizen build-web failed." }

Write-Host "Packaging with profile '$Profile'..."
& $tizen package -t wgt -s $Profile -- $buildResult
if ($LASTEXITCODE -ne 0) { throw "tizen package failed." }
if (!(Test-Path -LiteralPath $packagePath)) { throw "Expected package not found: $packagePath" }

if ($UninstallFirst) {
  Write-Host "Uninstalling existing app package $PackageId..."
  & $tizen uninstall -p $PackageId -s $Device
}

Write-Host "Installing $PackageName to $Device..."
& $tizen install -n $PackageName -s $Device -- $buildResult
if ($LASTEXITCODE -ne 0) { throw "tizen install failed." }

if ($Run) {
  Write-Host "Launching $AppId..."
  & $tizen run -p $AppId -s $Device
  if ($LASTEXITCODE -ne 0) { throw "tizen run failed." }
}

Write-Host "TV deploy complete: $packagePath"
