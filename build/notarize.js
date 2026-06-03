// build/notarize.js — Apple Notarization (electron-builder afterSign hook)
// Called by electron-builder after the .app is signed, before DMG packaging.
//
// Auth priority: App Store Connect API key → Apple ID + app-specific password → skip
//   API key env vars:  APPLE_API_KEY, APPLE_API_KEY_ID, APPLE_API_ISSUER
//   Apple ID env vars: APPLE_ID, APPLE_APP_SPECIFIC_PASSWORD, APPLE_TEAM_ID

const path = require('path')

exports.default = async function notarizing(context) {
  const { electronPlatformName, appOutDir } = context
  if (electronPlatformName !== 'darwin') return

  const appName = context.packager.appInfo.productFilename
  const appPath = path.join(appOutDir, `${appName}.app`)

  console.log('[notarize] Starting notarization for:', appPath)

  // Dynamic import — @electron/notarize v3 is ESM-only
  const { notarize } = await import('@electron/notarize')

  // Determine which auth method to use (API key preferred — no expiry, no 2FA)
  const apiKey = process.env.APPLE_API_KEY
  const apiKeyId = process.env.APPLE_API_KEY_ID
  const apiIssuer = process.env.APPLE_API_ISSUER

  const appleId = process.env.APPLE_ID
  const appleIdPassword = process.env.APPLE_APP_SPECIFIC_PASSWORD
  const teamId = process.env.APPLE_TEAM_ID

  if (apiKey && apiKeyId && apiIssuer) {
    console.log('[notarize] Using App Store Connect API key for auth')
    await notarize({
      appPath,
      appleApiKey: apiKey,
      appleApiKeyId: apiKeyId,
      appleApiIssuer: apiIssuer,
    })
  } else if (appleId && appleIdPassword && teamId) {
    console.log('[notarize] Using Apple ID + app-specific password for auth')
    await notarize({
      appPath,
      appleId,
      appleIdPassword,
      teamId,
    })
  } else {
    console.log('[notarize] Skipping notarization — incomplete credentials')
    console.log('[notarize]   API key present:', !!apiKey, !!apiKeyId, !!apiIssuer)
    console.log('[notarize]   Apple ID present:', !!appleId, 'password:', !!appleIdPassword, 'teamId:', !!teamId)
    return
  }

  console.log('[notarize] Notarization submitted successfully')
}
