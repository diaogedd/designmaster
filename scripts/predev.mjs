/* eslint-disable @typescript-eslint/explicit-function-return-type */
import { rm, readFile, writeFile } from 'node:fs/promises'
import { execSync } from 'node:child_process'
import net from 'node:net'
import path from 'node:path'
import process from 'node:process'

const DEV_PORT = 5173
const PRODUCT_NAME = 'DesignMaster'

async function clearViteCache(projectDir) {
  const viteCacheDir = path.join(projectDir, 'node_modules', '.vite')
  await rm(viteCacheDir, { recursive: true, force: true })
}

async function ensurePortAvailable(port) {
  const hosts = ['127.0.0.1', '::1']

  for (const host of hosts) {
    await new Promise((resolve, reject) => {
      const server = net.createServer()

      server.once('error', (error) => {
        if (
          error &&
          typeof error === 'object' &&
          'code' in error &&
          (error.code === 'EAFNOSUPPORT' || error.code === 'EADDRNOTAVAIL')
        ) {
          resolve()
          return
        }

        server.close()
        reject(error)
      })

      server.once('listening', () => {
        server.close((closeError) => {
          if (closeError) {
            reject(closeError)
            return
          }
          resolve()
        })
      })

      server.listen(port, host)
    })
  }
}

/**
 * On macOS dev mode, patch Electron.app's Info.plist so the Dock shows the
 * custom product name instead of "Electron".
 *
 * Three keys matter for Dock display:
 *   CFBundleDisplayName  – primary display name (most important)
 *   CFBundleName         – short name fallback (some macOS versions use this)
 *   CFBundleIdentifier   – unique ID; changing this forces Launch Services to re-register
 */
async function patchElectronPlist(projectDir) {
  if (process.platform !== 'darwin') return

  const plistPath = path.join(
    projectDir,
    'node_modules',
    'electron',
    'dist',
    'Electron.app',
    'Contents',
    'Info.plist'
  )

  try {
    let xml = await readFile(plistPath, 'utf8')
    let changed = false

    // 1. Patch CFBundleDisplayName
    const displayMatch = xml.match(
      /<key>CFBundleDisplayName<\/key>\s*<string>([^<]*)<\/string>/
    )
    if (displayMatch && displayMatch[1] !== PRODUCT_NAME) {
      xml = xml.replace(
        /(<key>CFBundleDisplayName<\/key>\s*<string>)[^<]*(<\/string>)/,
        `$1${PRODUCT_NAME}$2`
      )
      console.log(`[predev] CFBundleDisplayName: "${displayMatch[1]}" → "${PRODUCT_NAME}"`)
      changed = true
    }

    // 2. Patch CFBundleName (some macOS versions fall back to this)
    const nameMatch = xml.match(/<key>CFBundleName<\/key>\s*<string>([^<]*)<\/string>/)
    if (nameMatch && nameMatch[1] !== PRODUCT_NAME) {
      xml = xml.replace(
        /(<key>CFBundleName<\/key>\s*<string>)[^<]*(<\/string>)/,
        `$1${PRODUCT_NAME}$2`
      )
      console.log(`[predev] CFBundleName: "${nameMatch[1]}" → "${PRODUCT_NAME}"`)
      changed = true
    }

    // 3. Change CFBundleIdentifier to force Launch Services re-registration
    const bundleIdMatch = xml.match(
      /<key>CFBundleIdentifier<\/key>\s*<string>([^<]*)<\/string>/
    )
    const customBundleId = 'com.DesignMaster.dev'
    if (bundleIdMatch && bundleIdMatch[1] !== customBundleId) {
      xml = xml.replace(
        /(<key>CFBundleIdentifier<\/key>\s*<string>)[^<]*(<\/string>)/,
        `$1${customBundleId}$2`
      )
      console.log(`[predev] CFBundleIdentifier: "${bundleIdMatch[1]}" → "${customBundleId}"`)
      changed = true
    }

    // 4. Register the designmaster:// URL scheme so OAuth callbacks reach the
    //    dev Electron instead of a previously installed production build.
    //    Without this, app.setAsDefaultProtocolClient at runtime may not
    //    persist correctly, and Launch Services will route designmaster://
    //    URLs to whichever app it cached previously.
    const hasUrlScheme = /<key>designmaster<\/key>/.test(xml)
    if (!hasUrlScheme) {
      const urlTypesBlock = [
        '\t<key>CFBundleURLTypes</key>',
        '\t<array>',
        '\t\t<dict>',
        '\t\t\t<key>CFBundleTypeRole</key>',
        '\t\t\t<string>Viewer</string>',
        '\t\t\t<key>CFBundleURLName</key>',
        `\t\t\t<string>${customBundleId}</string>`,
        '\t\t\t<key>CFBundleURLSchemes</key>',
        '\t\t\t<array>',
        '\t\t\t\t<string>designmaster</string>',
        '\t\t\t</array>',
        '\t\t</dict>',
        '\t</array>'
      ].join('\n')

      // Insert before the closing </dict> of the top-level plist dict
      xml = xml.replace(/(\n<\/dict>\n<\/plist>\n?)$/, `\n${urlTypesBlock}$1`)
      console.log('[predev] CFBundleURLTypes: added designmaster:// URL scheme')
      changed = true
    }

    if (!changed) {
      console.log(`[predev] Electron plist already fully patched`)
      return
    }

    await writeFile(plistPath, xml, 'utf8')

    // Touch the .app bundle and its parent to bust macOS caches
    const appPath = path.join(projectDir, 'node_modules', 'electron', 'dist', 'Electron.app')
    try {
      execSync(`touch "${appPath}"`)
      execSync(`touch "${path.dirname(appPath)}"`)
    } catch {
      // non-critical
    }

    // Print cache-clearing instructions when patch is fresh
    console.log('')
    console.log(`[predev] ⚠️  Electron plist was patched. macOS Launch Services caches old names.`)
    console.log(`[predev]    If Dock still shows "Electron" after restart, run:`)
    console.log(`[predev]    killall Dock && /System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister -kill -r -domain local -domain system -domain user`)
    console.log('')
  } catch (error) {
    console.warn('[predev] Could not patch Electron plist:', error.message)
  }
}

async function main() {
  const projectDir = process.cwd()
  await clearViteCache(projectDir)
  await patchElectronPlist(projectDir)

  try {
    await ensurePortAvailable(DEV_PORT)
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'EADDRINUSE') {
      console.error(
        `Port ${DEV_PORT} is already in use. Stop the existing dev server before running ` +
          '`npm run dev` so the app does not keep talking to stale renderer assets.'
      )
      process.exitCode = 1
      return
    }

    throw error
  }
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
