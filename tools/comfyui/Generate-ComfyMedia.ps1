param(
    [Parameter(Mandatory = $true)]
    [ValidateSet('Image', 'Video')]
    [string]$Mode,

    [Parameter(Mandatory = $true)]
    [ValidateNotNullOrEmpty()]
    [string]$Prompt,

    [string]$OutputDirectory = 'X:\tmp',

    [ValidateSet(512, 768, 1024)]
    [int]$Width = 512,

    [ValidateSet(512, 768, 1024)]
    [int]$Height = 512,

    [ValidateRange(1, 20)]
    [int]$Steps = 20,

    [ValidateRange(5, 121)]
    [int]$Frames = 49,

    [ValidateRange(1, 120)]
    [int]$FPS = 24,

    [long]$Seed = -1,

    [string]$StartImagePath
)

$ErrorActionPreference = 'Stop'
$api = 'http://127.0.0.1:8188'
$portableRoot = Join-Path $env:LOCALAPPDATA 'ComfyUI\portable\ComfyUI_windows_portable'
$comfyRoot = Join-Path $portableRoot 'ComfyUI'
$defaultOutput = 'X:\tmp'
$startScript = Join-Path $env:LOCALAPPDATA 'Helm\tools\comfyui\Start-ComfyUI.ps1'
$modelKey = 'huihui-qwen3.8-27b-abliterated'
$lock = [System.Threading.Mutex]::new($false, 'Local\HelmComfyMediaGeneration')
$lockTaken = $false
$inputCopy = $null
$lmsExe = $null
$wasQwenLoaded = $false
$restoreIdentifier = 'claude-sonnet-5'
$generationError = $null
$restoreError = $null
$resultPath = $null

try {
    try {
        $lockTaken = $lock.WaitOne()
    } catch [System.Threading.AbandonedMutexException] {
        $lockTaken = $true
    }
    if (-not $lockTaken) {
        throw 'Another media job is still running; could not acquire the GPU.'
    }

    New-Item -ItemType Directory -Force -Path $OutputDirectory, $defaultOutput | Out-Null

    $lmsCommand = Get-Command lms -ErrorAction SilentlyContinue
    if ($null -eq $lmsCommand) {
        throw 'LM Studio CLI was not found, so GPU usage cannot be coordinated safely.'
    }
    $lmsExe = $lmsCommand.Source
    $rawModels = & $lmsExe ps --json 2>$null
    if ($LASTEXITCODE -ne 0) {
        throw 'Could not read LM Studio loaded models, so GPU usage cannot be coordinated safely.'
    }
    $modelsJson = ($rawModels -join [Environment]::NewLine).Trim()
    $models = @()
    if (-not [string]::IsNullOrWhiteSpace($modelsJson)) {
        $models = @(ConvertFrom-Json -InputObject $modelsJson)
    }

    if ($models.Count -gt 0) {
        if ($models.Count -ne 1 -or $models[0].modelKey -ne $modelKey) {
            $keys = ($models | ForEach-Object { $_.modelKey }) -join ', '
            throw "Media generation needs the RX 7800 XT. Close other LM Studio models first; found: $keys"
        }
        $restoreIdentifier = [string]$models[0].identifier
        if ([string]::IsNullOrWhiteSpace($restoreIdentifier)) {
            $restoreIdentifier = 'claude-sonnet-5'
        }
        & $lmsExe unload $restoreIdentifier | Out-Null
        if ($LASTEXITCODE -ne 0) {
            throw 'Could not temporarily unload the local Qwen model from LM Studio.'
        }
        $wasQwenLoaded = $true

        $unloaded = $false
        for ($attempt = 0; $attempt -lt 60; $attempt++) {
            $remainingRaw = & $lmsExe ps --json 2>$null
            if ($LASTEXITCODE -ne 0) {
                throw 'Could not confirm that LM Studio released GPU memory.'
            }
            $remaining = @()
            $remainingJson = ($remainingRaw -join [Environment]::NewLine).Trim()
            if (-not [string]::IsNullOrWhiteSpace($remainingJson)) {
                $remaining = @(ConvertFrom-Json -InputObject $remainingJson)
            }
            if (-not ($remaining | Where-Object { $_.modelKey -eq $modelKey })) {
                $unloaded = $true
                break
            }
            Start-Sleep -Seconds 1
        }
        if (-not $unloaded) {
            throw 'LM Studio did not release Qwen VRAM in time.'
        }
    }

    if ($Mode -eq 'Image') {
        $imageModel = Join-Path $comfyRoot 'models\checkpoints\sd_xl_turbo_1.0_fp16.safetensors'
        if (-not (Test-Path -LiteralPath $imageModel)) {
            throw "The SDXL Turbo image model is missing: $imageModel"
        }
    } else {
        if ((($Frames - 1) % 4) -ne 0) {
            throw 'Wan video frame count must be 4n+1, such as 49 or 81.'
        }
        $videoModels = @(
            (Join-Path $comfyRoot 'models\diffusion_models\wan2.2_ti2v_5B_fp16.safetensors'),
            (Join-Path $comfyRoot 'models\text_encoders\umt5_xxl_fp8_e4m3fn_scaled.safetensors'),
            (Join-Path $comfyRoot 'models\vae\wan2.2_vae.safetensors')
        )
        foreach ($model in $videoModels) {
            if (-not (Test-Path -LiteralPath $model)) {
                throw "A Wan 2.2 video model component is missing: $model"
            }
        }
        if (-not [string]::IsNullOrWhiteSpace($StartImagePath)) {
            $sourceImage = Get-Item -LiteralPath $StartImagePath -ErrorAction Stop
            if ($sourceImage.Extension.ToLowerInvariant() -notin @('.png', '.jpg', '.jpeg', '.webp')) {
                throw 'The video start image must be PNG, JPEG, or WebP.'
            }
            $inputDirectory = Join-Path $comfyRoot 'input'
            New-Item -ItemType Directory -Force -Path $inputDirectory | Out-Null
            $inputCopy = Join-Path $inputDirectory ('Helm_' + [guid]::NewGuid().ToString('N') + $sourceImage.Extension.ToLowerInvariant())
            Copy-Item -LiteralPath $sourceImage.FullName -Destination $inputCopy
        }
    }

    & $startScript
    $ready = $false
    for ($attempt = 0; $attempt -lt 90; $attempt++) {
        try {
            $null = Invoke-RestMethod -Uri "$api/system_stats" -TimeoutSec 3
            $ready = $true
            break
        } catch {
            Start-Sleep -Seconds 2
        }
    }
    if (-not $ready) {
        throw 'ComfyUI did not become ready at http://127.0.0.1:8188. Check the ComfyUI logs.'
    }

    if ($Seed -lt 0) {
        $Seed = [long](([DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds() * 997 + (Get-Random -Maximum 997)) % 9007199254740991)
    }

    if ($Mode -eq 'Image') {
        $workflow = @{
            '1' = @{
                class_type = 'CheckpointLoaderSimple'
                inputs = @{ ckpt_name = 'sd_xl_turbo_1.0_fp16.safetensors' }
            }
            '2' = @{
                class_type = 'CLIPTextEncode'
                inputs = @{ text = $Prompt; clip = @('1', 1) }
            }
            '3' = @{
                class_type = 'EmptyLatentImage'
                inputs = @{ width = $Width; height = $Height; batch_size = 1 }
            }
            '4' = @{
                class_type = 'KSampler'
                inputs = @{
                    seed = $Seed
                    steps = 4
                    cfg = 1.0
                    sampler_name = 'euler_ancestral'
                    scheduler = 'sgm_uniform'
                    denoise = 1.0
                    model = @('1', 0)
                    positive = @('2', 0)
                    negative = @('5', 0)
                    latent_image = @('3', 0)
                }
            }
            '5' = @{
                class_type = 'CLIPTextEncode'
                inputs = @{ text = ''; clip = @('1', 1) }
            }
            '6' = @{
                class_type = 'VAEDecode'
                inputs = @{ samples = @('4', 0); vae = @('1', 2) }
            }
            '7' = @{
                class_type = 'SaveImage'
                inputs = @{ filename_prefix = 'Helm'; images = @('6', 0) }
            }
        }
        $outputNode = '7'
    } else {
        $latentInputs = @{
            vae = @('3', 0)
            width = 832
            height = 480
            length = $Frames
            batch_size = 1
        }
        if (-not [string]::IsNullOrWhiteSpace($StartImagePath)) {
            $inputName = [IO.Path]::GetFileName($inputCopy)
            $latentInputs.start_image = @('12', 0)
        }
        $workflow = @{
            '1' = @{
                class_type = 'UNETLoader'
                inputs = @{ unet_name = 'wan2.2_ti2v_5B_fp16.safetensors'; weight_dtype = 'default' }
            }
            '2' = @{
                class_type = 'CLIPLoader'
                inputs = @{ clip_name = 'umt5_xxl_fp8_e4m3fn_scaled.safetensors'; type = 'wan'; device = 'default' }
            }
            '3' = @{
                class_type = 'VAELoader'
                inputs = @{ vae_name = 'wan2.2_vae.safetensors' }
            }
            '4' = @{
                class_type = 'ModelSamplingSD3'
                inputs = @{ model = @('1', 0); shift = 8 }
            }
            '5' = @{
                class_type = 'CLIPTextEncode'
                inputs = @{ text = $Prompt; clip = @('2', 0) }
            }
            '6' = @{
                class_type = 'CLIPTextEncode'
                inputs = @{ text = '色调艳丽，过曝，静态，细节模糊不清，字幕，风格，作品，画作，画面，静止，整体发灰，最差质量，低质量，JPEG压缩残留，丑陋的，残缺的，多余的手指，画得不好的手部，画得不好的脸部，畸形的，毁容的，形态畸形的肢体，手指融合，静止不动的画面，杂乱的背景，三条腿，背景人很多，倒着走'; clip = @('2', 0) }
            }
            '7' = @{
                class_type = 'Wan22ImageToVideoLatent'
                inputs = $latentInputs
            }
            '8' = @{
                class_type = 'KSampler'
                inputs = @{
                    seed = $Seed
                    steps = $Steps
                    cfg = 5.0
                    sampler_name = 'uni_pc'
                    scheduler = 'simple'
                    denoise = 1.0
                    model = @('4', 0)
                    positive = @('5', 0)
                    negative = @('6', 0)
                    latent_image = @('7', 0)
                }
            }
            '9' = @{
                class_type = 'VAEDecode'
                inputs = @{ samples = @('8', 0); vae = @('3', 0) }
            }
            '10' = @{
                class_type = 'CreateVideo'
                inputs = @{ images = @('9', 0); fps = $FPS }
            }
            '11' = @{
                class_type = 'SaveVideo'
                inputs = @{
                    video = @('10', 0)
                    filename_prefix = 'HelmVideo'
                    format = 'auto'
                    'format.codec' = 'auto'
                }
            }
        }
        if (-not [string]::IsNullOrWhiteSpace($StartImagePath)) {
            $workflow['12'] = @{
                class_type = 'LoadImage'
                inputs = @{ image = $inputName; upload = 'image' }
            }
        }
        $outputNode = '11'
    }

    $request = @{
        prompt = $workflow
        client_id = [guid]::NewGuid().ToString()
    } | ConvertTo-Json -Depth 24
    $queued = Invoke-RestMethod -Method Post -Uri "$api/prompt" -ContentType 'application/json' -Body $request -TimeoutSec 30
    if ([string]::IsNullOrWhiteSpace([string]$queued.prompt_id)) {
        throw "ComfyUI did not accept the workflow: $($queued | ConvertTo-Json -Compress -Depth 8)"
    }
    $promptId = [string]$queued.prompt_id

    $savedMetadata = $null
    while ($true) {
        Start-Sleep -Seconds 1
        try {
            $history = Invoke-RestMethod -Uri "$api/history/$promptId" -TimeoutSec 5
        } catch {
            continue
        }
        $recordProperty = $history.PSObject.Properties[$promptId]
        if ($null -eq $recordProperty) {
            continue
        }
        $record = $recordProperty.Value
        if ($record.status -and $record.status.status_str -eq 'error') {
            throw "ComfyUI workflow failed: $($record.status.messages | ConvertTo-Json -Compress -Depth 8)"
        }
        $nodeProperty = $record.outputs.PSObject.Properties[$outputNode]
        if ($null -ne $nodeProperty) {
            $output = $nodeProperty.Value
            if ($Mode -eq 'Image') {
                if ($output.images.Count -gt 0) {
                    $savedMetadata = $output.images[0]
                    break
                }
            } else {
                foreach ($field in @('videos', 'video', 'gifs', 'images')) {
                    $media = $output.PSObject.Properties[$field]
                    if ($null -ne $media -and $media.Value.Count -gt 0) {
                        $savedMetadata = $media.Value[0]
                        break
                    }
                }
                if ($null -ne $savedMetadata) {
                    break
                }
            }
        }
    }
    if ($null -eq $savedMetadata) {
        throw "ComfyUI completed the $Mode job without returning an output (job $promptId)."
    }

    $sourcePath = Join-Path $defaultOutput ([string]$savedMetadata.filename)
    if (-not [string]::IsNullOrWhiteSpace([string]$savedMetadata.subfolder)) {
        $sourcePath = Join-Path $defaultOutput (Join-Path ([string]$savedMetadata.subfolder) ([string]$savedMetadata.filename))
    }
    for ($attempt = 0; $attempt -lt 20 -and -not (Test-Path -LiteralPath $sourcePath); $attempt++) {
        Start-Sleep -Milliseconds 250
    }
    if (-not (Test-Path -LiteralPath $sourcePath)) {
        throw "ComfyUI reported media but the output file is missing: $sourcePath"
    }

    $targetDirectory = [IO.Path]::GetFullPath($OutputDirectory)
    $sourceFullPath = [IO.Path]::GetFullPath($sourcePath)
    $targetPath = Join-Path $targetDirectory ([IO.Path]::GetFileName($sourceFullPath))
    if (-not [string]::Equals($sourceFullPath, [IO.Path]::GetFullPath($targetPath), [StringComparison]::OrdinalIgnoreCase)) {
        if (Test-Path -LiteralPath $targetPath) {
            $stem = [IO.Path]::GetFileNameWithoutExtension($targetPath)
            $ext = [IO.Path]::GetExtension($targetPath)
            $targetPath = Join-Path $targetDirectory ($stem + '_' + [DateTime]::Now.ToString('yyyyMMdd-HHmmss') + $ext)
        }
        Copy-Item -LiteralPath $sourceFullPath -Destination $targetPath
    }
    $resultPath = $targetPath
} catch {
    $generationError = $_
} finally {
    if (-not [string]::IsNullOrWhiteSpace($api)) {
        try {
            $null = Invoke-RestMethod -Method Post -Uri "$api/free" -ContentType 'application/json' -Body '{"unload_models":true,"free_memory":true}' -TimeoutSec 10
        } catch {
            # Best-effort ComfyUI cleanup.
        }
    }
    if ($wasQwenLoaded) {
        try {
            $restoreOutput = @(& $lmsExe load --gpu 0.35 --context-length 131072 --identifier $restoreIdentifier $modelKey --yes 2>&1)
            $restoreExitCode = $LASTEXITCODE
            $restoreModels = @()
            try {
                $restoreJson = (& $lmsExe ps --json 2>$null | Out-String).Trim()
                if (-not [string]::IsNullOrWhiteSpace($restoreJson)) {
                    $restoreModels = @(ConvertFrom-Json -InputObject $restoreJson)
                }
            } catch {
                # The next check reports the load output if LM Studio status is unavailable.
            }
            $restored = @($restoreModels | Where-Object {
                $_.modelKey -eq $modelKey -and $_.identifier -eq $restoreIdentifier
            }).Count -gt 0
            if (-not $restored) {
                $detail = ($restoreOutput -join ' ').Trim()
                if ([string]::IsNullOrWhiteSpace($detail)) {
                    $detail = "lms load exited $restoreExitCode and the model is absent from lms ps."
                }
                throw "LM Studio could not restore Qwen: $detail"
            }
        } catch {
            $restoreError = $_
        }
    }
    if ($null -ne $inputCopy) {
        try {
            Remove-Item -LiteralPath $inputCopy -Force -ErrorAction SilentlyContinue
        } catch {
            # Best-effort removal of the temporary ComfyUI input.
        }
    }
    if ($lockTaken) {
        $lock.ReleaseMutex()
    }
    $lock.Dispose()
}

if ($null -ne $generationError) {
    throw $generationError
}
if ($null -ne $restoreError) {
    throw "Media saved to $resultPath, but LM Studio could not restore Qwen: $restoreError"
}
Write-Output $resultPath
