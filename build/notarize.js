// build/notarize.js — Apple Notarization (electron-builder afterSign hook)
// Called by electron-builder after the .app is signed, before DMG packaging.
// Requires: APPLE_ID, APPLE_TEAM_ID, APPLE_APP_SPECIFIC_PASSWORD env vars

const { notarize } = require('@electron/notarize')
const path = require('path')

exports.default = async function notarizing(context) {
  const { electronPlatformName, appOutDir } = context
  if (electronPlatformName !== 'darwin') return

  const appName = context.packager.appInfo.productFilename
  const appPath = path.join(appOutDir, `${appName}.app`)

  console.log('[notarize] Starting notarization for:', appPath)

  await notarize({
    appPath,
    appleId: process.env.APPLE_ID,
    appleIdPassword: process.env.APPLE_APP_SPECIFIC_PASSWORD,
    teamId: process.env.APPLE_TEAM_ID
  })

  console.log('[notarize] Notarization submitted successfully')
}
