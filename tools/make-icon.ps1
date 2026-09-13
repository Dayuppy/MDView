# Generates assets\app.ico — a flat rounded-square "M↓" markdown mark —
# using only System.Drawing (no external tools). PNG-compressed ICO entries.
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing

$root = Split-Path -Parent $PSScriptRoot
$out = Join-Path $root 'assets\app.ico'
$sizes = 16, 24, 32, 48, 64, 128, 256

function New-IconPng([int]$size) {
    $bmp = New-Object System.Drawing.Bitmap($size, $size)
    $g = [System.Drawing.Graphics]::FromImage($bmp)
    $g.SmoothingMode = 'AntiAlias'
    $g.TextRenderingHint = 'AntiAliasGridFit'
    $g.Clear([System.Drawing.Color]::Transparent)

    # rounded-rect background
    $r = [Math]::Max(2, [int]($size * 0.21))
    $rect = New-Object System.Drawing.Rectangle(0, 0, $size, $size)
    $path = New-Object System.Drawing.Drawing2D.GraphicsPath
    $d = $r * 2
    $path.AddArc($rect.X, $rect.Y, $d, $d, 180, 90)
    $path.AddArc($rect.Right - $d, $rect.Y, $d, $d, 270, 90)
    $path.AddArc($rect.Right - $d, $rect.Bottom - $d, $d, $d, 0, 90)
    $path.AddArc($rect.X, $rect.Bottom - $d, $d, $d, 90, 90)
    $path.CloseFigure()
    $bgBrush = New-Object System.Drawing.Drawing2D.LinearGradientBrush(
        $rect, [System.Drawing.Color]::FromArgb(255, 37, 99, 235),
        [System.Drawing.Color]::FromArgb(255, 23, 64, 158), 55)
    $g.FillPath($bgBrush, $path)

    # "M" glyph + down arrow, drawn as geometry so it stays crisp at 16px
    $white = [System.Drawing.Brushes]::White
    $s = $size / 32.0
    # M: stroke polyline (7,22)->(7,10)->(12,16)->(17,10)->(17,22)
    $penW = [Math]::Max(1.6, 3.4 * $s)
    $pen = New-Object System.Drawing.Pen([System.Drawing.Color]::White, $penW)
    $pen.LineJoin = 'Round'; $pen.StartCap = 'Round'; $pen.EndCap = 'Round'
    $pts = @(
        (New-Object System.Drawing.PointF((7 * $s), (22 * $s))),
        (New-Object System.Drawing.PointF((7 * $s), (10 * $s))),
        (New-Object System.Drawing.PointF((12 * $s), (16 * $s))),
        (New-Object System.Drawing.PointF((17 * $s), (10 * $s))),
        (New-Object System.Drawing.PointF((17 * $s), (22 * $s)))
    )
    $g.DrawLines($pen, $pts)
    # down arrow: shaft (24,10)-(24,18), head triangle
    $g.DrawLine($pen, (24 * $s), (10 * $s), (24 * $s), (17.5 * $s))
    $tri = @(
        (New-Object System.Drawing.PointF((20.5 * $s), (16.5 * $s))),
        (New-Object System.Drawing.PointF((27.5 * $s), (16.5 * $s))),
        (New-Object System.Drawing.PointF((24 * $s), (22.5 * $s)))
    )
    $g.FillPolygon($white, $tri)

    $g.Dispose()
    $ms = New-Object System.IO.MemoryStream
    $bmp.Save($ms, [System.Drawing.Imaging.ImageFormat]::Png)
    $bmp.Dispose()
    return , [byte[]]$ms.ToArray()
}

$pngs = @{}
foreach ($s in $sizes) { $pngs[$s] = New-IconPng $s }

# assemble ICO (PNG entries)
$ms = New-Object System.IO.MemoryStream
$bw = New-Object System.IO.BinaryWriter($ms)
$bw.Write([uint16]0); $bw.Write([uint16]1); $bw.Write([uint16]$sizes.Count)
$offset = 6 + 16 * $sizes.Count
foreach ($s in $sizes) {
    [byte[]]$data = $pngs[$s]
    $bw.Write([byte]($(if ($s -ge 256) { 0 } else { $s })))
    $bw.Write([byte]($(if ($s -ge 256) { 0 } else { $s })))
    $bw.Write([byte]0); $bw.Write([byte]0)
    $bw.Write([uint16]1); $bw.Write([uint16]32)
    $bw.Write([uint32]$data.Length)
    $bw.Write([uint32]$offset)
    $offset += $data.Length
}
foreach ($s in $sizes) { [byte[]]$d = $pngs[$s]; $bw.Write($d, 0, $d.Length) }
$bw.Flush()
[System.IO.File]::WriteAllBytes($out, $ms.ToArray())
$bw.Dispose()
Write-Host "wrote $out ($([Math]::Round((Get-Item $out).Length / 1KB, 1)) KB)"
