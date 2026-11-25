# TuneCord helper: reads Windows "System Media Transport Controls" (the media
# flyout that Spotify, Apple Music, TIDAL, browsers, etc. publish to) and prints
# one JSON line per second. Commands arrive as JSON lines on stdin.
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
[Console]::InputEncoding  = [System.Text.Encoding]::UTF8

Add-Type -AssemblyName System.Runtime.WindowsRuntime
$asTaskGeneric = ([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object {
    $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and
    $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1' })[0]

function Await($op, [Type]$type) {
    $t = $asTaskGeneric.MakeGenericMethod($type).Invoke($null, @($op))
    [void]$t.Wait(5000)
    return $t.Result
}

[void][Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager, Windows.Media.Control, ContentType = WindowsRuntime]
[void][Windows.Storage.Streams.IRandomAccessStreamWithContentType, Windows.Storage.Streams, ContentType = WindowsRuntime]

$MgrType   = [Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager]
$PropsType = [Windows.Media.Control.GlobalSystemMediaTransportControlsSessionMediaProperties]
$StreamType = [Windows.Storage.Streams.IRandomAccessStreamWithContentType]

$manager = Await ($MgrType::RequestAsync()) $MgrType
$artCache = @{}
$sentArt = @{}
$artTries = @{}
$lastSessions = @()

function Get-Art($session, $props, $key) {
    if ($artCache.ContainsKey($key)) { return $artCache[$key] }
    $data = $null
    try {
        if ($props.Thumbnail) {
            $ras = Await ($props.Thumbnail.OpenReadAsync()) $StreamType
            if ($ras.Size -lt 2MB) {
                $net = [System.IO.WindowsRuntimeStreamExtensions]::AsStreamForRead($ras)
                $ms = New-Object System.IO.MemoryStream
                $net.CopyTo($ms)
                $mime = if ($ras.ContentType) { $ras.ContentType } else { 'image/png' }
                $data = "data:$mime;base64," + [Convert]::ToBase64String($ms.ToArray())
                $ms.Dispose(); $net.Dispose()
            }
            $ras.Dispose()
        }
    } catch { $data = $null }
    if ($data) {
        if ($artCache.Count -gt 20) { $artCache.Clear() }
        $artCache[$key] = $data
    }
    return $data
}

function Read-Sessions {
    $out = New-Object System.Collections.ArrayList
    $sessions = @($manager.GetSessions())
    $script:lastSessions = $sessions
    $i = 0
    foreach ($s in $sessions) {
        try {
            $p = Await ($s.TryGetMediaPropertiesAsync()) $PropsType
            $info = $s.GetPlaybackInfo()
            $tl = $s.GetTimelineProperties()
            $status = $info.PlaybackStatus.ToString()
            $pos = $tl.Position.TotalSeconds
            if ($status -eq 'Playing' -and $tl.LastUpdatedTime.Year -gt 2000) {
                $pos += ([DateTimeOffset]::Now - $tl.LastUpdatedTime).TotalSeconds
            }
            $dur = $tl.EndTime.TotalSeconds
            if ($dur -gt 0 -and $pos -gt $dur) { $pos = $dur }
            $key = "$($s.SourceAppUserModelId)|$($p.Artist)|$($p.Title)"
            $id = "$($s.SourceAppUserModelId)#$i"
            $art = $null
            if ($sentArt[$id] -ne $key) {
                $art = Get-Art $s $p $key
                $tries = 1 + [int]$artTries[$key]
                $artTries[$key] = $tries
                if ($art -or $tries -ge 5) { $sentArt[$id] = $key }
                if ($artTries.Count -gt 200) { $artTries.Clear() }
            }
            [void]$out.Add([ordered]@{
                id       = $id
                aumid    = $s.SourceAppUserModelId
                title    = $p.Title
                artist   = $p.Artist
                album    = $p.AlbumTitle
                status   = $status
                position = [Math]::Round($pos, 2)
                duration = [Math]::Round($dur, 2)
                artKey   = $key
                art      = $art
            })
        } catch { }
        $i++
    }
    return ,$out
}

function Invoke-MediaCommand($cmd) {
    $idx = [int]($cmd.id -split '#')[-1]
    $s = $script:lastSessions[$idx]
    if (-not $s) { return }
    switch ($cmd.action) {
        'playpause' { [void](Await ($s.TryTogglePlayPauseAsync()) ([bool])) }
        'play'      { [void](Await ($s.TryPlayAsync()) ([bool])) }
        'pause'     { [void](Await ($s.TryPauseAsync()) ([bool])) }
        'next'      { [void](Await ($s.TrySkipNextAsync()) ([bool])) }
        'previous'  { [void](Await ($s.TrySkipPreviousAsync()) ([bool])) }
        'seek'      { [void](Await ($s.TryChangePlaybackPositionAsync([long]([double]$cmd.arg * 10000000))) ([bool])) }
    }
}

$stdin = [Console]::In
$pending = $stdin.ReadLineAsync()
$nextPoll = [DateTime]::MinValue

while ($true) {
    if ($pending.IsCompleted) {
        $line = $pending.Result
        if ($null -eq $line) { break }   # parent closed stdin -> exit
        try { Invoke-MediaCommand ($line | ConvertFrom-Json); $nextPoll = [DateTime]::MinValue } catch { }
        $pending = $stdin.ReadLineAsync()
    }
    if ([DateTime]::Now -ge $nextPoll) {
        try {
            $sessions = Read-Sessions
            [Console]::Out.WriteLine((ConvertTo-Json -InputObject @($sessions) -Compress -Depth 4))
            [Console]::Out.Flush()
        } catch {
            [Console]::Out.WriteLine('{"error":' + (ConvertTo-Json -InputObject "$_" -Compress) + '}')
        }
        $nextPoll = [DateTime]::Now.AddMilliseconds(1000)
    }
    Start-Sleep -Milliseconds 100
}
