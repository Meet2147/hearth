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

  try {
    # 2>&1 folds the error stream into output so ordering matches a real console.
    Invoke-Expression $command 2>&1 | ForEach-Object {
      if ($_ -is [System.Management.Automation.ErrorRecord]) {
        [Console]::Out.WriteLine($_.ToString())
      } else {
        $text = ($_ | Out-String).TrimEnd([char]13, [char]10)
        [Console]::Out.WriteLine($text)
      }
      [Console]::Out.Flush()
    }
    $succeeded = $?
    if ($null -ne $global:LASTEXITCODE) { $code = $global:LASTEXITCODE }
    elseif (-not $succeeded) { $code = 1 }
  } catch {
    [Console]::Out.WriteLine($_.Exception.Message)
    $code = 1
  }

  # PowerShell's location and the process working directory are separate things;
  # native executables use the latter, so keep them in step after every command.
  $here = (Get-Location).Path
  try { [Environment]::CurrentDirectory = $here } catch {}

  [Console]::Out.Write($RS + $token + $RS + $code + $RS + $here + $RS + "`n")
  [Console]::Out.Flush()
}
