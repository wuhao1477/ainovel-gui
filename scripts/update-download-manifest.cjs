#!/usr/bin/env node
/**
 * 根据 release/ 目录下的实际产物刷新 download.json
 *
 * 写入每个产物的真实体积与 sha256，并按 tag 生成下载直链。
 * 由 .github/workflows/release.yml 的 publish 阶段调用。
 *
 * 用法:
 *   node scripts/update-download-manifest.cjs --tag v0.6.4
 *   node scripts/update-download-manifest.cjs --tag v0.6.4 --dir release
 */

const { createHash } = require('crypto')
const { readFileSync, writeFileSync, existsSync, readdirSync, statSync } = require('fs')
const { join, resolve } = require('path')

const ROOT = join(__dirname, '..')
const PACKAGE_JSON = join(ROOT, 'package.json')
const DOWNLOAD_JSON = join(ROOT, 'download.json')

const REPO = process.env.GITHUB_REPOSITORY || 'wuhao1477/ainovel-gui'

function arg(name, fallback = null) {
  const prefix = `--${name}=`
  const withEq = process.argv.find(a => a.startsWith(prefix))
  if (withEq) return withEq.slice(prefix.length)
  const idx = process.argv.indexOf(`--${name}`)
  if (idx !== -1 && process.argv[idx + 1] && !process.argv[idx + 1].startsWith('--')) {
    return process.argv[idx + 1]
  }
  return fallback
}

// electron-builder 的 ${arch} 宏按扩展名产出不同架构名
// （见 builder-util 的 getArtifactArchName）：
//   deb -> amd64/i386   rpm -> x86_64/aarch64/i686   AppImage -> x86_64/i386
// 这里统一归一为 x64 / arm64 / ia32。
const ARCH_ALIASES = {
  x64: 'x64',
  x86_64: 'x64',
  amd64: 'x64',
  arm64: 'arm64',
  aarch64: 'arm64',
  ia32: 'ia32',
  i386: 'ia32',
  i686: 'ia32',
}

const ARCH_PATTERN = Object.keys(ARCH_ALIASES).join('|')

/**
 * 从产物文件名推断下载条目的 key。
 * 命名由 package.json 的 artifactName 决定，例如：
 *   AINovel-0.6.4-mac-arm64.dmg          -> mac-arm64
 *   AINovel-0.6.4-mac-arm64.zip          -> mac-arm64-zip
 *   AINovel-0.6.4-win-x64.exe            -> win-x64
 *   AINovel-0.6.4-win-x64-portable.exe   -> win-x64-portable
 *   AINovel-0.6.4-linux-x86_64.AppImage  -> linux-x64-appimage
 *   AINovel-0.6.4-linux-amd64.deb        -> linux-x64-deb
 */
function classify(file) {
  const lower = file.toLowerCase()
  // 校验和与增量更新元数据不进入下载清单
  if (lower.endsWith('.blockmap') || lower.endsWith('.yml') || lower.endsWith('.yaml')) return null
  if (lower === 'sha256sums.txt') return null

  const re = new RegExp(`-(mac|win|linux)-(${ARCH_PATTERN})(-portable)?\\.(dmg|zip|exe|msi|appimage|deb|rpm|tar\\.gz)$`)
  const m = lower.match(re)
  if (!m) return null

  const [, os, rawArch, portable, ext] = m
  const arch = ARCH_ALIASES[rawArch]
  const base = `${os}-${arch}`

  if (portable) return `${base}-portable`

  switch (ext) {
    // 各平台的“主”安装形态用裸 key（mac=dmg / win=nsis / linux=AppImage），
    // electron/ipc/system.ts 的 check-update 按 `<os>-<arch>` 裸键取值
    case 'dmg':
      return base
    case 'exe':
      return base
    case 'appimage':
      return base
    case 'zip':
      return `${base}-zip`
    case 'deb':
      return `${base}-deb`
    case 'rpm':
      return `${base}-rpm`
    case 'msi':
      return `${base}-msi`
    case 'tar.gz':
      return `${base}-targz`
    default:
      return null
  }
}

function sha256(file) {
  return createHash('sha256').update(readFileSync(file)).digest('hex')
}

function main() {
  const tagArg = arg('tag')
  const dir = resolve(ROOT, arg('dir', 'release'))

  const pkg = JSON.parse(readFileSync(PACKAGE_JSON, 'utf8'))
  const tag = tagArg || `v${pkg.version}`
  const version = tag.replace(/^v/, '')

  if (!existsSync(dir)) {
    console.error(`[manifest] 产物目录不存在: ${dir}`)
    process.exit(1)
  }

  const manifest = existsSync(DOWNLOAD_JSON)
    ? JSON.parse(readFileSync(DOWNLOAD_JSON, 'utf8'))
    : {}

  const downloads = {}
  const skipped = []

  for (const file of readdirSync(dir).sort()) {
    const full = join(dir, file)
    if (!statSync(full).isFile()) continue

    const key = classify(file)
    if (!key) {
      skipped.push(file)
      continue
    }

    downloads[key] = {
      filename: file,
      url: `https://github.com/${REPO}/releases/download/${tag}/${encodeURIComponent(file)}`,
      size: statSync(full).size,
      sha256: sha256(full),
    }
  }

  if (Object.keys(downloads).length === 0) {
    console.error('[manifest] 未在产物目录中识别到任何可发布文件')
    process.exit(1)
  }

  manifest.version = version
  manifest.release_date = new Date().toISOString().slice(0, 10)
  manifest.downloads = downloads
  // release_notes 由 bump-version / sync-version 维护，这里保持原值

  writeFileSync(DOWNLOAD_JSON, JSON.stringify(manifest, null, 2) + '\n')

  console.log(`[manifest] download.json 已更新 (tag=${tag})`)
  for (const [key, v] of Object.entries(downloads)) {
    const mb = (v.size / 1024 / 1024).toFixed(1)
    console.log(`  ${key.padEnd(22)} ${String(mb).padStart(7)} MB  ${v.filename}`)
  }
  if (skipped.length > 0) {
    console.log(`[manifest] 已跳过 ${skipped.length} 个非分发文件: ${skipped.join(', ')}`)
  }
}

main()
