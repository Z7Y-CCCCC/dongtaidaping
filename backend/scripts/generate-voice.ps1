param(
    [switch]$ListVoices,
    [string]$TextBase64 = '',
    [string]$OutputPath = '',
    [string]$VoiceName = '',
    [ValidateRange(-10, 10)]
    [int]$Rate = 0,
    [ValidateRange(0, 100)]
    [int]$Volume = 100
)

$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
Add-Type -AssemblyName System.Speech

$synthesizer = New-Object System.Speech.Synthesis.SpeechSynthesizer
try {
    if ($ListVoices) {
        $voices = @($synthesizer.GetInstalledVoices() |
            Where-Object { $_.Enabled } |
            ForEach-Object {
                $info = $_.VoiceInfo
                [pscustomobject]@{
                    name = $info.Name
                    culture = $info.Culture.Name
                    gender = [string]$info.Gender
                    age = [string]$info.Age
                    description = $info.Description
                }
            })
        [Console]::Write((ConvertTo-Json -InputObject $voices -Compress))
        exit 0
    }

    if ([string]::IsNullOrWhiteSpace($TextBase64)) {
        throw '播报文字不能为空'
    }
    if ([string]::IsNullOrWhiteSpace($OutputPath)) {
        throw '输出文件路径不能为空'
    }

    $textBytes = [Convert]::FromBase64String($TextBase64)
    $text = [Text.Encoding]::UTF8.GetString($textBytes)
    if ([string]::IsNullOrWhiteSpace($text)) {
        throw '播报文字不能为空'
    }

    $parent = Split-Path -Parent $OutputPath
    if (-not [string]::IsNullOrWhiteSpace($parent)) {
        [IO.Directory]::CreateDirectory($parent) | Out-Null
    }
    if (-not [string]::IsNullOrWhiteSpace($VoiceName)) {
        $synthesizer.SelectVoice($VoiceName)
    }
    $synthesizer.Rate = $Rate
    $synthesizer.Volume = $Volume
    $synthesizer.SetOutputToWaveFile($OutputPath)
    $synthesizer.Speak($text)
    $synthesizer.SetOutputToNull()
} finally {
    $synthesizer.Dispose()
}
