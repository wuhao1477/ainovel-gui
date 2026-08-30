#!/usr/bin/env node
/**
 * 生成 GitHub Release 说明
 *
 * 组成部分：
 *   1. download.json 的 release_notes（人工维护的更新内容）
 *   2. 按平台归类的产物下载表（从 release/ 实际文件生成）
 *   3. 安装提示（未签名应用在 macOS/Windows 上的放行方式）
 *
 * 用法:
 *   node scripts/build-release-notes.cjs --tag v0.6.4 --out release-notes.md
 */

const { readFileSync, writeFileSync, existsSync, readdirSync, statSync } = require('fs')
const { join, resolve } = require('path')

const ROOT = join(__dirname, '..')
const DOWNLOAD_JSON = join(ROOT, 'download.json')

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

const PLATFORM_LABEL = {
  mac: 'macOS',
  win: 'Windows',
  linux: 'Linux',
}

const ARCH_LABEL = {
  x64: 'x64',
  arm64: 'arm64',
  ia32: '32 位 (x86)',
}

// 下载表内的展示顺序：架构优先，其次是安装形态
const ARCH_ORDER = { x64: 0, arm64: 1, ia32: 2 }
const EXT_ORDER = { dmg: 0, exe: 0, AppImage: 0, deb: 1, rpm: 2, msi: 3, zip: 4, 'tar.gz': 5 }

// electron-builder 的 ${arch} 宏按扩展名产出不同架构名，统一归一
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

const FORMAT_HINT = {
  dmg: '安装镜像',
  exe: '安装程序',
  zip: '免安装压缩包',
  AppImage: '免安装（chmod +x 后直接运行）',
  deb: 'Debian / Ubuntu',
  rpm: 'Fedora / RHEL / openSUSE',
  'tar.gz': '通用压缩包',
  msi: 'MSI 安装包',
}

function describe(file) {
  const re = new RegExp(`-(mac|win|linux)-(${ARCH_PATTERN})(-portable)?\\.(dmg|zip|exe|msi|AppImage|deb|rpm|tar\\.gz)$`, 'i')
  const m = file.match(re)
  if (!m) return null

  const [, os, rawArch, portable, rawExt] = m
  const arch = ARCH_ALIASES[rawArch.toLowerCase()]
  // 扩展名大小写按 FORMAT_HINT 的键归一（AppImage 在文件名中保持驼峰）
  const ext = Object.keys(FORMAT_HINT).find(k => k.toLowerCase() === rawExt.toLowerCase()) || rawExt

  let hint = FORMAT_HINT[ext] || ext
  if (portable) hint = '单文件便携版'
  if (os === 'mac') {
    hint += arch === 'x64' ? '（Intel Mac）' : '（Apple Silicon）'
  }
  return { os: os.toLowerCase(), arch, ext, hint }
}

function main() {
  const tag = arg('tag') || ''
  const out = resolve(ROOT, arg('out', 'release-notes.md'))
  const dir = resolve(ROOT, arg('dir', 'release'))

  const lines = []

  // 1) 人工维护的更新内容
  if (existsSync(DOWNLOAD_JSON)) {
    const dd = JSON.parse(readFileSync(DOWNLOAD_JSON, 'utf8'))
    if (dd.release_notes) {
      lines.push(dd.release_notes.trim(), '')
    }
  }

  // 2) 产物下载表
  if (existsSync(dir)) {
    const grouped = { mac: [], win: [], linux: [] }

    for (const file of readdirSync(dir).sort()) {
      const full = join(dir, file)
      if (!statSync(full).isFile()) continue
      if (/\.(blockmap|ya?ml)$/i.test(file) || file === 'SHA256SUMS.txt') continue

      const info = describe(file)
      if (!info) continue

      const mb = (statSync(full).size / 1024 / 1024).toFixed(1)
      grouped[info.os].push({ file, ...info, mb })
    }

    const hasAny = Object.values(grouped).some(g => g.length > 0)
    if (hasAny) {
      lines.push('## 下载', '')

      for (const os of ['mac', 'win', 'linux']) {
        const items = grouped[os]
        if (items.length === 0) continue

        items.sort((a, b) =>
          (ARCH_ORDER[a.arch] ?? 9) - (ARCH_ORDER[b.arch] ?? 9) ||
          (EXT_ORDER[a.ext] ?? 9) - (EXT_ORDER[b.ext] ?? 9) ||
          a.file.localeCompare(b.file)
        )

        lines.push(`### ${PLATFORM_LABEL[os]}`, '')
        lines.push('| 架构 | 格式 | 文件 | 大小 |')
        lines.push('| --- | --- | --- | --- |')

        for (const it of items) {
          const url = tag
            ? `[${it.file}](https://github.com/${process.env.GITHUB_REPOSITORY || 'crazytreeChen/ainovel-gui'}/releases/download/${tag}/${encodeURIComponent(it.file)})`
            : it.file
          lines.push(`| ${ARCH_LABEL[it.arch] || it.arch} | ${it.hint} | ${url} | ${it.mb} MB |`)
        }
        lines.push('')
      }
    }
  }

  // 3) 安装提示
  lines.push(
    '## 安装说明',
    '',
    '本项目未配置代码签名证书，首次打开需手动放行：',
    '',
    '- **macOS**：若提示“已损坏”或无法打开，执行 `sudo xattr -dr com.apple.quarantine /Applications/AINovel.app`',
    '- **Windows**：SmartScreen 提示时选择“更多信息” → “仍要运行”',
    '- **Linux**：AppImage 需先 `chmod +x`；deb 用 `sudo dpkg -i`，rpm 用 `sudo rpm -i`',
    '',
    'AI 推理引擎 `ainovel-cli` 已按各平台架构随包分发，无需单独安装。',
    '',
    '产物校验和见随附的 `SHA256SUMS.txt`。',
    ''
  )

  writeFileSync(out, lines.join('\n'))
  console.log(`[notes] 已生成 ${out} (${lines.length} 行)`)
}

main()
