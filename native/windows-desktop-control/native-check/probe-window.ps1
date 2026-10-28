param([string]$Title, [string]$Color, [int]$X, [int]$Y, [int]$W, [int]$H, [switch]$Controls, [switch]$TopMost)
# A throwaway DPI-aware window for the desktop control helper's native checks. Closes itself after 60 s.
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
Add-Type 'using System.Runtime.InteropServices; public static class ProbeDpi { [DllImport("user32.dll")] public static extern bool SetProcessDpiAwarenessContext(System.IntPtr v); }'
[void][ProbeDpi]::SetProcessDpiAwarenessContext([IntPtr]::new(-4))
$form = New-Object System.Windows.Forms.Form
$form.Text = $Title
$form.StartPosition = 'Manual'
$form.Location = New-Object System.Drawing.Point($X, $Y)
$form.Size = New-Object System.Drawing.Size($W, $H)
$form.BackColor = [System.Drawing.Color]::FromName($Color)
$form.TopMost = [bool]$TopMost
$form.ShowInTaskbar = $true
if ($Controls) {
  $button = New-Object System.Windows.Forms.Button
  $button.Text = 'Probe button'; $button.Location = New-Object System.Drawing.Point(20, 20); $button.Size = New-Object System.Drawing.Size(160, 40)
  $text = New-Object System.Windows.Forms.TextBox
  $text.Text = 'visible text'; $text.Location = New-Object System.Drawing.Point(20, 80); $text.Width = 200
  $secret = New-Object System.Windows.Forms.TextBox
  $secret.Text = 'hunter2-secret'; $secret.UseSystemPasswordChar = $true; $secret.Location = New-Object System.Drawing.Point(20, 120); $secret.Width = 200
  $form.Controls.AddRange(@($button, $text, $secret))
}
$timer = New-Object System.Windows.Forms.Timer
$timer.Interval = 60000
$timer.Add_Tick({ $form.Close() })
$timer.Start()
[System.Windows.Forms.Application]::Run($form)
