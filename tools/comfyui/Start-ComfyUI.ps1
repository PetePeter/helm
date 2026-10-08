$ErrorActionPreference = 'Stop'

$root = Join-Path $env:LOCALAPPDATA 'ComfyUI\portable\ComfyUI_windows_portable'
$python = Join-Path $root 'python_embeded\python.exe'
$defaultOutput = 'X:\tmp'
$logDir = Join-Path $env:LOCALAPPDATA 'Helm\logs'
$api = 'http://127.0.0.1:8188/system_stats'

if (-not (Test-Path -LiteralPath $python)) {
    throw "ComfyUI portable Python was not found: $python"
}
New-Item -ItemType Directory -Force -Path $defaultOutput, $logDir | Out-Null

try {
    $null = Invoke-RestMethod -Uri $api -TimeoutSec 2
    return
} catch {
    # Start the local API when it is not already listening.
}

$env:HIP_VISIBLE_DEVICES = '1'
$stdout = Join-Path $logDir 'comfyui-stdout.log'
$stderr = Join-Path $logDir 'comfyui-stderr.log'
$arguments = @(
    '-s',
    'ComfyUI\main.py',
    '--windows-standalone-build',
    # No --enable-dynamic-vram: forcing it on this AMD card corrupts every image after
    # the first whenever a model is reloaded (stale buffers, same garbage for any prompt).
    '--listen',
    '0.0.0.0',
    '--port',
    '8188',
    '--disable-auto-launch',
    '--use-split-cross-attention',
    '--cuda-device',
    '1',
    '--default-device',
    '1',
    '--output-directory',
    ('"' + $defaultOutput + '"')
)
$process = Start-Process -FilePath $python -WorkingDirectory $root -ArgumentList $arguments -WindowStyle Hidden -RedirectStandardOutput $stdout -RedirectStandardError $stderr -PassThru
Start-Sleep -Seconds 2
if ($process.HasExited) {
    throw "ComfyUI exited during startup. Check $stderr"
}
