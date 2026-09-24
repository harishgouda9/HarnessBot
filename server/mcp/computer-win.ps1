param(
  [Parameter(Mandatory = $true)][string]$ActionPath
)

# One desktop action. The node driver writes the action as JSON and reads one JSON
# object back. Nothing in that file is executed as code.
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

function Emit($obj) {
  $obj | ConvertTo-Json -Compress
}

try {
  Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class HbDesk {
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] public static extern void mouse_event(uint flags, uint dx, uint dy, uint data, UIntPtr extra);
}
'@
  [void][HbDesk]::SetProcessDPIAware()
  $a = Get-Content -Raw -LiteralPath $ActionPath | ConvertFrom-Json

  switch ($a.op) {
    'screenshot' {
      Add-Type -AssemblyName System.Windows.Forms
      Add-Type -AssemblyName System.Drawing
      $b = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds
      $bmp = New-Object System.Drawing.Bitmap $b.Width, $b.Height
      $g = [System.Drawing.Graphics]::FromImage($bmp)
      $g.CopyFromScreen($b.X, $b.Y, 0, 0, $bmp.Size)
      $g.Dispose()
      $img = $bmp
      $max = 1280
      if ($bmp.Width -gt $max) {
        $nh = [int][Math]::Max(1, [Math]::Round($bmp.Height * $max / $bmp.Width))
        $img = New-Object System.Drawing.Bitmap $max, $nh
        $sg = [System.Drawing.Graphics]::FromImage($img)
        $sg.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
        $sg.DrawImage($bmp, 0, 0, $max, $nh)
        $sg.Dispose()
        $bmp.Dispose()
      }
      $ms = New-Object System.IO.MemoryStream
      $mime = 'image/png'
      $enc = [System.Drawing.Imaging.ImageCodecInfo]::GetImageEncoders() | Where-Object { $_.MimeType -eq 'image/jpeg' } | Select-Object -First 1
      if ($enc) {
        $ep = New-Object System.Drawing.Imaging.EncoderParameters 1
        $ep.Param[0] = New-Object System.Drawing.Imaging.EncoderParameter ([System.Drawing.Imaging.Encoder]::Quality, [long]60)
        $img.Save($ms, $enc, $ep)
        $mime = 'image/jpeg'
      } else {
        $img.Save($ms, [System.Drawing.Imaging.ImageFormat]::Png)
      }
      $b64 = [Convert]::ToBase64String($ms.ToArray())
      Emit @{
        ok = $true
        width = $img.Width
        height = $img.Height
        screenWidth = $b.Width
        screenHeight = $b.Height
        originX = $b.X
        originY = $b.Y
        mime = $mime
        data = $b64
      }
      $img.Dispose()
      $ms.Dispose()
    }
    'move' {
      [void][HbDesk]::SetCursorPos([int]$a.x, [int]$a.y)
      Emit @{ ok = $true }
    }
    'click' {
      [void][HbDesk]::SetCursorPos([int]$a.x, [int]$a.y)
      $down = 2
      $up = 4
      if ($a.button -eq 'right') { $down = 8; $up = 16 }
      elseif ($a.button -eq 'middle') { $down = 32; $up = 64 }
      $n = 1
      if ($a.clicks -eq 2) { $n = 2 }
      for ($i = 0; $i -lt $n; $i++) {
        [HbDesk]::mouse_event([uint32]$down, 0, 0, 0, [UIntPtr]::Zero)
        [HbDesk]::mouse_event([uint32]$up, 0, 0, 0, [UIntPtr]::Zero)
        Start-Sleep -Milliseconds 40
      }
      Emit @{ ok = $true }
    }
    'scroll' {
      [void][HbDesk]::SetCursorPos([int]$a.x, [int]$a.y)
      $delta = [int]$a.delta
      if ($delta -lt 0) { $delta = [uint32](4294967296 + $delta) } else { $delta = [uint32]$delta }
      [HbDesk]::mouse_event([uint32]2048, 0, 0, [uint32]$delta, [UIntPtr]::Zero)
      Emit @{ ok = $true }
    }
    'keys' {
      Add-Type -AssemblyName System.Windows.Forms
      [System.Windows.Forms.SendKeys]::SendWait([string]$a.keys)
      Emit @{ ok = $true }
    }
    'open' {
      Start-Process ([string]$a.target)
      Emit @{ ok = $true }
    }
    default {
      Emit @{ ok = $false; error = "unknown desktop action" }
    }
  }
} catch {
  Emit @{ ok = $false; error = $_.Exception.Message }
}
