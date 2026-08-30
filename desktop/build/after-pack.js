/*
 * Fallback code signing.
 *
 * When real Developer ID credentials are present (CSC_LINK / APPLE_ID),
 * electron-builder signs and notarizes on its own and this hook stands aside.
 *
 * When they are NOT — every build today — electron-builder leaves only Electron's
 * per-binary linker signature, which fails `codesign --verify` for the bundle as
 * a whole. On Apple Silicon a quarantined app with an invalid signature shows
 * "'Hearth' is damaged and can't be opened", with no way in but the Terminal.
 *
 * A *valid* ad-hoc signature does not make Gatekeeper trust the app — only
 * notarization does that — but it changes the download experience from
 * "damaged, move to Bin" to the ordinary "unidentified developer" that a
 * right-click -> Open clears. That is the difference between unusable and usable
 * for the people testing this before there is an Apple account behind it.
 */
'use strict';

const path = require('path');
const { execFileSync } = require('child_process');

exports.default = async function afterPack(context) {
  if (context.electronPlatformName !== 'darwin') return;
  if (process.env.CSC_LINK || process.env.APPLE_ID || process.env.CSC_NAME || process.env.HEARTH_DEVELOPER_ID) {
    console.log('  after-pack: real signing credentials present, leaving it to electron-builder');
    return;
  }
  const app = path.join(context.appOutDir,
    context.packager.appInfo.productFilename + '.app');
  console.log('  after-pack: applying a valid ad-hoc signature to ' + app);
  // --deep is deprecated but correct for an ad-hoc test signature, and it is
  // what makes the whole bundle verify rather than just the main binary.
  execFileSync('codesign', ['--force', '--deep', '--sign', '-', app], { stdio: 'inherit' });
  execFileSync('codesign', ['--verify', '--deep', '--strict', app], { stdio: 'inherit' });
  console.log('  after-pack: ad-hoc signature verified');
};
