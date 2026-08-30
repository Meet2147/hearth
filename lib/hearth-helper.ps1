# Hearth's Windows shell helper.
#
# Commands arrive base64-encoded over a private named pipe rather than on stdin,
# for two reasons: PowerShell cannot redirect a command's stdin, so leaving our
# own stdin closed is the only way to stop a native command that reads input from
# swallowing the next queued command; and base64 removes every PowerShell
# quoting and newline hazard from command text.
#
# After each command we print a record-separator marker carrying the session
# token, the exit code and the working directory. The token arrives over the pipe
# and is never on the command line, so a running command cannot discover it and
# fake a completion.

param([Parameter(Mandatory = $true)][string]$PipeName)

$ErrorActionPreference = 'Continue'
$RS = [char]30

# PowerShell writes to the console in the legacy OEM code page by default, which
# turns anything outside it - accents, emoji, CJK - into '?' before it ever
# reaches us. The daemon reads this stream as UTF-8, so say so on both sides.
try {
  $utf8 = New-Object System.Text.UTF8Encoding $false
  [Console]::OutputEncoding = $utf8
  $OutputEncoding = $utf8
} catch { }

# The driver passes a full \\.\pipe\NAME path; the client class wants bare NAME.
$name = $PipeName -replace '^\\\\\.\\pipe\\', ''

try {
  $pipe = New-Object System.IO.Pipes.NamedPipeClientStream('.', $name, [System.IO.Pipes.PipeDirection]::In)
  $pipe.Connect(15000)
} catch {
  [Console]::Error.WriteLine('hearth: could not connect to the command pipe: ' + $_.Exception.Message)
  exit 1
}

$reader = New-Object System.IO.StreamReader($pipe, [Text.Encoding]::UTF8)

$token = $reader.ReadLine()
if ([string]::IsNullOrEmpty($token)) {
  [Console]::Error.WriteLine('hearth: no session token received')
  exit 1
}

try { [Environment]::CurrentDirectory = (Get-Location).Path } catch {}

while ($true) {
  $line = $reader.ReadLine()
  if ($null -eq $line) { break }        # driver closed the pipe
  if ($line.Length -eq 0) { continue }

  try {
    $command = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($line))
  } catch {
    continue
  }

  $global:LASTEXITCODE = $null
  $code = 0
  $script:sawError = $false
  $script:printed = New-Object 'System.Collections.Generic.HashSet[int]'
  # $Error is appended to for every error, terminating or not, regardless of
  # redirection or pipeline scoping. It is the only signal here that does not
  # depend on semantics that vary between PowerShell versions.
  $errorsBefore = $Error.Count

  try {
    # A scriptblock rather than Invoke-Expression: its streams behave
    # predictably under redirection. 2>&1 folds errors into the output so the
    # ordering matches what a real console would show.
    $block = [ScriptBlock]::Create($command)
    & $block 2>&1 | ForEach-Object {
      if ($_ -is [System.Management.Automation.ErrorRecord]) {
        # $script: - an assignment inside the block would otherwise create a
        # local that vanishes when the block ends.
        $script:sawError = $true
        [void]$script:printed.Add($_.GetHashCode())
        [Console]::Out.WriteLine($_.ToString())
      } else {
        $text = ($_ | Out-String).TrimEnd([char]13, [char]10)
        [Console]::Out.WriteLine($text)
      }
      [Console]::Out.Flush()
    }
  } catch {
    [Console]::Out.WriteLine($_.Exception.Message)
    $code = 1
  }

  # Anything that never reached the pipeline still has to be shown - a silent
  # failure in a terminal several people are watching is the worst outcome.
  $newErrors = $Error.Count - $errorsBefore
  if ($newErrors -gt 0) {
    for ($i = $newErrors - 1; $i -ge 0; $i--) {
      $record = $Error[$i]
      if (-not $script:printed.Contains($record.GetHashCode())) {
        [Console]::Out.WriteLine($record.ToString())
      }
    }
    [Console]::Out.Flush()
  }

  # A native executable sets $LASTEXITCODE and is authoritative. A cmdlet does
  # not, so fall back to whether anything failed at all.
  if ($null -ne $global:LASTEXITCODE) { $code = $global:LASTEXITCODE }
  elseif ($script:sawError -or $newErrors -gt 0) { $code = 1 }

  # PowerShell's location and the process working directory are separate things;
  # native executables use the latter, so keep them in step after every command.
  $here = (Get-Location).Path
  try { [Environment]::CurrentDirectory = $here } catch {}

  [Console]::Out.Write($RS + $token + $RS + $code + $RS + $here + $RS + "`n")
  [Console]::Out.Flush()
}
