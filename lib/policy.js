/*
 * Command risk classification, for POSIX shells and for PowerShell.
 *
 * The host may be on macOS, Linux or Windows, and every hazard has a completely
 * different spelling on each. A classifier that only understood `rm -rf` would
 * be silently blind on a Windows host, which is worse than having none at all.
 *
 * A shared terminal has two distinct hazards, and they are not the same problem:
 *
 *   destructive - the command could wreck the host machine.
 *   sensitive   - the command is fine for the machine but would print secrets
 *                 into a stream that several other people are watching. Reading
 *                 your own SSH key is harmless alone and a disaster in a room.
 *
 * This is a SPEED BUMP, not a sandbox. Any determined person with run access can
 * trivially evade it (base64, a shell variable, a script file). It exists to
 * catch the accident and the thoughtless paste, and to make the host stop and
 * look. The real security boundary is who you grant run access to.
 */

'use strict';

const DESTRUCTIVE = [
  [/\brm\s+(-[a-zA-Z]*\s+)*-?[a-zA-Z]*[rR][a-zA-Z]*f|rm\s+(-[a-zA-Z]*\s+)*-?[a-zA-Z]*f[a-zA-Z]*[rR]/, 'recursive force delete'],
  [/\brm\b[^|;&]*\s(\/|~|\$HOME)(\s|$)/, 'delete targeting / or the home directory'],
  [/\bmkfs(\.\w+)?\b/, 'filesystem format'],
  [/\bdd\b[^|;&]*\bof=\/dev\//, 'raw write to a block device'],
  [/>\s*\/dev\/(disk|sd[a-z]|nvme|rdisk)/, 'redirect over a block device'],
  [/\bdiskutil\s+(eraseDisk|eraseVolume|partitionDisk)/, 'disk erase'],
  [/\b(shutdown|reboot|halt|poweroff)\b/, 'power state change'],
  [/:\s*\(\s*\)\s*\{.*\|.*&.*\}\s*;\s*:/, 'fork bomb'],
  [/\bchmod\s+(-[a-zA-Z]+\s+)*777\s+\/(\s|$)/, 'world-writable root'],
  [/\bchown\s+-[a-zA-Z]*R[a-zA-Z]*\s+[^\s]+\s+\/(\s|$)/, 'recursive ownership change on /'],
  [/\bkill(all)?\s+-9\s+(-1|\*)/, 'kill every process'],
  [/\b(curl|wget)\b[^|]*\|\s*(sudo\s+)?(ba)?sh\b/, 'piping a download straight into a shell'],
  [/\bgit\s+clean\s+(-[a-zA-Z]*\s*)*-[a-zA-Z]*[xX]/, 'git clean removing ignored files'],
  [/\bgit\s+reset\s+--hard\b/, 'discards uncommitted work'],
  [/>\s*\/etc\//, 'overwriting system configuration'],
  [/\bsudo\b/, 'privilege escalation'],
  [/\bdoas\b/, 'privilege escalation'],

  // Windows / PowerShell. A host on Windows runs PowerShell, where every one of
  // the hazards above has a completely different spelling.
  [/\b(Remove-Item|ri|rm|del|erase)\b[^|;]*-(Recurse|r)\b[^|;]*-(Force|f)\b/i, 'recursive force delete'],
  [/\b(Remove-Item|ri)\b[^|;]*-(Force|f)\b[^|;]*-(Recurse|r)\b/i, 'recursive force delete'],
  [/\brd\s+\/s\b|\brmdir\s+\/s\b/i, 'recursive directory delete'],
  [/\bdel\s+\/[a-z]*s\b/i, 'recursive delete'],
  [/\b(Format-Volume|Clear-Disk|Initialize-Disk|Remove-Partition)\b/i, 'disk format or wipe'],
  [/\bformat\s+[a-z]:/i, 'drive format'],
  [/\b(Stop-Computer|Restart-Computer)\b/i, 'power state change'],
  [/\bshutdown\s+\/[rs]\b/i, 'power state change'],
  [/\bSet-ExecutionPolicy\b/i, 'weakens PowerShell script protection'],
  [/\breg\s+delete\b/i, 'registry deletion'],
  [/\b(Remove-ItemProperty|Remove-Item)\b[^|;]*\bHK(LM|CU|CR):/i, 'registry deletion'],
  [/\btakeown\b[^|;]*\/r\b/i, 'recursive ownership seizure'],
  [/\bicacls\b[^|;]*\/grant\b[^|;]*:(F|M)\b/i, 'grants full control'],
  [/\bvssadmin\b[^|;]*\bdelete\b[^|;]*\bshadows\b/i, 'deletes volume shadow copies'],
  [/\bbcdedit\b/i, 'boot configuration change'],
  [/\bcipher\s+\/w/i, 'wipes free space'],
  [/\b(Invoke-WebRequest|iwr|curl|wget|Invoke-RestMethod|irm)\b[^|]*\|\s*(iex|Invoke-Expression)\b/i,
    'piping a download straight into a shell'],
  [/\b(iex|Invoke-Expression)\s*\(\s*(New-Object\s+Net\.WebClient|.*DownloadString)/i,
    'executing downloaded code'],
  [/\bStart-Process\b[^|;]*-Verb\s+RunAs\b/i, 'privilege escalation'],
  [/\bStop-Process\b[^|;]*-(Force|f)\b[^|;]*-(Name|Id)\s*\*/i, 'kills every process'],
];

const SENSITIVE = [
  [/\.ssh\/(id_|identity)/, 'SSH private key'],
  [/\bssh-add\s+-L?\b/, 'SSH agent key listing'],
  [/\.aws\/credentials/, 'AWS credentials'],
  [/\.config\/gcloud/, 'Google Cloud credentials'],
  [/\.kube\/config/, 'Kubernetes credentials'],
  [/\.(netrc|npmrc|pypirc|docker\/config\.json)/, 'stored registry credentials'],
  [/(^|[\s;|&])(env|printenv)(\s|$|;|\|)/, 'prints the whole environment, tokens included'],
  [/\bsecurity\s+(find-generic-password|find-internet-password|dump-keychain)/, 'macOS keychain read'],
  [/\bgh\s+auth\s+(token|status)/, 'GitHub token'],
  [/\bgit\s+config\s+(--global\s+)?(-l|--list)/, 'git config may contain tokens'],
  [/\b(cat|less|more|bat|head|tail|open|code)\b[^|;&]*\.env(\.|\s|$)/, 'environment file'],
  [/\b(cat|less|more|bat|head|tail)\b[^|;&]*\.(pem|key|p12|pfx|jks)(\s|$)/, 'private key file'],
  [/\bhistory\b/, 'shell history may contain secrets'],
  [/BEGIN\s+(RSA|OPENSSH|EC|PGP)\s+PRIVATE/, 'private key material'],

  // Windows / PowerShell equivalents.
  [/\.ssh\\(id_|identity)/i, 'SSH private key'],
  [/(^|[\s;|(])(dir|ls|gci|Get-ChildItem|Get-Item)\s+env:/i, 'prints the whole environment, tokens included'],
  [/\bGet-ChildItem\b[^|;]*\bEnv:/i, 'prints the whole environment, tokens included'],
  [/\bGet-Credential\b/i, 'credential prompt capture'],
  [/\bcmdkey\s+\/list\b/i, 'stored Windows credentials'],
  [/\bExport-PfxCertificate\b/i, 'exports a private certificate'],
  [/\b(Get-Content|gc|type|cat)\b[^|;&]*\.(pem|key|p12|pfx|jks|ppk)(\s|$)/i, 'private key file'],
  [/\b(Get-Content|gc|type|cat)\b[^|;&]*\.env(\.|\s|$)/i, 'environment file'],
  [/\b(Get-Content|gc|type)\b[^|;&]*(_history|ConsoleHost_history)/i, 'shell history may contain secrets'],
  [/\bGet-Secret\b|\bGet-AzKeyVaultSecret\b/i, 'secret store read'],
  [/AppData[\\\/][^\s]*(Login Data|Cookies|Local State)/i, 'browser credential store'],
];

function classify(command) {
  const cmd = String(command || '');
  const reasons = [];
  let level = 'ok';

  for (const [pattern, why] of DESTRUCTIVE) {
    if (pattern.test(cmd)) { level = 'destructive'; reasons.push(why); }
  }
  if (level !== 'destructive') {
    for (const [pattern, why] of SENSITIVE) {
      if (pattern.test(cmd)) { level = 'sensitive'; reasons.push(why); }
    }
  } else {
    for (const [pattern, why] of SENSITIVE) {
      if (pattern.test(cmd)) reasons.push(why);
    }
  }

  return { level, reasons: [...new Set(reasons)] };
}

// Who may do what. The host is authoritative; guests hold only what they are given.
const ROLES = {
  host:    { canRun: true,  canGrant: true,  canKick: true,  canKill: true },
  runner:  { canRun: true,  canGrant: false, canKick: false, canKill: true },
  watcher: { canRun: false, canGrant: false, canKick: false, canKill: false },
};

function abilities(role) {
  return ROLES[role] || ROLES.watcher;
}

module.exports = { classify, abilities, ROLES, DESTRUCTIVE, SENSITIVE };
