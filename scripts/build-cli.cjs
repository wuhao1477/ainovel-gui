#!/usr/bin/env node
/**
 * ainovel-cli 引擎编译脚本
 *
 * 从 engine/ 编译 Go 二进制。engine 是纯 Go（无 CGO），可从任意主机交叉编译
 * 到全部目标架构，因此按 electron-builder 的架构名输出到独立目录：
 *
 *   build/ainovel-cli/x64/ainovel-cli      (GOARCH=amd64)
 *   build/ainovel-cli/arm64/ainovel-cli    (GOARCH=arm64)
 *   build/ainovel-cli/ia32/ainovel-cli.exe (GOARCH=386)
 *
 * package.json 的 extraResources 用 `build/ainovel-cli/${arch}/` 引用，
 * 使 electron-builder 单次多架构打包时每个架构都拿到自己的二进制。
 * 宿主架构的产物额外镜像到 build/ainovel-cli/bin/，供开发期
 * （electron/context.ts 的 devBin 路径）和 postinstall --check 使用。
 *
 * 编译完成后尝试 UPX 压缩（需安装 upx），可将 11MB → ~3MB
 *
 * 用法:
 *   node scripts/build-cli.cjs                    # 编译当前平台+当前架构
 *   node scripts/build-cli.cjs --arch=x64         # 指定架构
 *   node scripts/build-cli.cjs --arch=x64 --arch=arm64  # 多架构
 *   node scripts/build-cli.cjs --check            # 只检查是否需要编译
 *   node scripts/build-cli.cjs --no-upx           # 编译但不进行 UPX 压缩
 *   node scripts/build-cli.cjs --only-upx         # 只进行 UPX 压缩（已有二进制）
 */

const { execSync } = require('child_process')
const { existsSync, mkdirSync, statSync, copyFileSync } = require('fs')
const { join } = require('path')
const os = require('os')

const ROOT = join(__dirname, '..')
const ENGINE_DIR = join(ROOT, 'engine')
const CLI_ROOT = join(ROOT, 'build', 'ainovel-cli')
// 开发期 / postinstall 检查路径（宿主架构的镜像副本）
const LEGACY_DIR = join(CLI_ROOT, 'bin')
const BIN_NAME = os.platform() === 'win32' ? 'ainovel-cli.exe' : 'ainovel-cli'
const OUTPUT_BIN = join(LEGACY_DIR, BIN_NAME)

// electron-builder 架构名 → GOARCH
const ARCH_TO_GOARCH = {
  x64: 'amd64',
  arm64: 'arm64',
  ia32: '386',
  armv7l: 'arm',
}

// Node process.arch → electron-builder 架构名
const NODE_ARCH_TO_EB = {
  x64: 'x64',
  arm64: 'arm64',
  ia32: 'ia32',
  arm: 'armv7l',
}

const HOST_ARCH = NODE_ARCH_TO_EB[process.arch] || process.arch

/** 解析 --arch=<a> （可重复）；未指定则用宿主架构 */
function parseArchs() {
  const archs = process.argv
    .filter(a => a.startsWith('--arch='))
    .flatMap(a => a.slice('--arch='.length).split(','))
    .map(a => a.trim())
    .filter(Boolean)

  const list = archs.length > 0 ? archs : [HOST_ARCH]

  for (const a of list) {
    if (!ARCH_TO_GOARCH[a]) {
      throw new Error(`不支持的架构: ${a}（可选: ${Object.keys(ARCH_TO_GOARCH).join(', ')}）`)
    }
  }
  return [...new Set(list)]
}

const RED = '\x1b[31m'
const GREEN = '\x1b[32m'
const YELLOW = '\x1b[33m'
const CYAN = '\x1b[36m'
const RESET = '\x1b[0m'

function log(msg) { console.log(`${CYAN}[build-cli]${RESET} ${msg}`) }
function warn(msg) { console.log(`${YELLOW}[build-cli]${RESET} ${msg}`) }
function error(msg) { console.log(`${RED}[build-cli]${RESET} ${msg}`) }

const IS_CHECK = process.argv.includes('--check')

// 检查是否需要编译
function needsBuild() {
  if (IS_CHECK) {
    if (existsSync(OUTPUT_BIN)) {
      log('ainovel-cli binary already exists: ' + OUTPUT_BIN)
      process.exit(0)
    }
    warn('ainovel-cli binary not found, will build')
    return true
  }
  return true
}

function resolveGo() {
  const goBinary = existsSync('/usr/local/go/bin/go') ? '/usr/local/go/bin/go' : 'go'
  try {
    const version = execSync(`${goBinary} version 2>&1`, { encoding: 'utf8' }).trim()
    log('Go: ' + version)
    return goBinary
  } catch {
    return null
  }
}

/** 编译单个架构，输出到 build/ainovel-cli/<arch>/ */
function buildArch(goBinary, arch) {
  const goarch = ARCH_TO_GOARCH[arch]
  const outDir = join(CLI_ROOT, arch)
  const outBin = join(outDir, BIN_NAME)

  mkdirSync(outDir, { recursive: true })

  log(`Building ainovel-cli for ${arch} (GOARCH=${goarch})...`)

  try {
    execSync(
      `${goBinary} build -ldflags="-s -w" -o ${JSON.stringify(outBin)} ./cmd/ainovel-cli/`,
      {
        cwd: ENGINE_DIR,
        stdio: 'inherit',
        timeout: 300000,
        env: { ...process.env, GOARCH: goarch, CGO_ENABLED: '0' },
      }
    )

    // 设置执行权限（仅非 Windows 宿主）
    if (process.platform !== 'win32') {
      execSync(`chmod +x ${JSON.stringify(outBin)}`)
    }

    const size = (statSync(outBin).size / 1024 / 1024).toFixed(1)
    log(`${GREEN}✅ Built: ${outBin} (${size} MB)${RESET}`)

    // 宿主架构镜像到 bin/，供开发期与 postinstall --check
    if (arch === HOST_ARCH) {
      mkdirSync(LEGACY_DIR, { recursive: true })
      copyFileSync(outBin, OUTPUT_BIN)
      log(`Mirrored host arch to ${OUTPUT_BIN}`)
    }

    return outBin
  } catch (e) {
    error(`Build failed for ${arch}: ` + e.message)
    return null
  }
}

function build(archs) {
  if (!existsSync(ENGINE_DIR)) {
    warn('Engine not found at ' + ENGINE_DIR)
    warn('Run: npm run build:cli to compile the engine')
    return null
  }

  const goBinary = resolveGo()
  if (!goBinary) {
    error('Go is not installed. Please install Go (see engine/go.mod for the required version)')
    error('  brew install go')
    return null
  }

  const srcDir = join(ENGINE_DIR, 'cmd', 'ainovel-cli')
  if (!existsSync(srcDir)) {
    error('Source not found: ' + srcDir)
    return null
  }

  const built = []
  for (const arch of archs) {
    const outBin = buildArch(goBinary, arch)
    if (!outBin) return null
    built.push({ arch, bin: outBin })
  }
  return built
}

function upxCompress(target = OUTPUT_BIN, arch = HOST_ARCH) {
  if (process.argv.includes('--no-upx')) {
    log('Skipping UPX compression (--no-upx flag)')
    return true
  }
  if (!existsSync(target)) {
    warn('Binary not found, skipping UPX: ' + target)
    return false
  }

  // UPX 5.0+ 不再支持 macOS，直接跳过
  if (os.platform() === 'darwin') {
    warn('UPX no longer supports macOS. Skipping compression.')
    warn(`  Binary size: ${(statSync(target).size / 1024 / 1024).toFixed(1)} MB (uncompressed)`)
    return true
  }

  // 交叉编译产物与宿主架构不一致时 UPX 往往不支持，跳过以免破坏二进制
  if (arch !== HOST_ARCH) {
    warn(`Skipping UPX for cross-compiled ${arch} binary (host is ${HOST_ARCH})`)
    return true
  }

  // 检查 UPX 是否可用
  let hasUPX = false
  try {
    execSync('upx --version 2>&1', { encoding: 'utf8' })
    hasUPX = true
  } catch { try {
    execSync('/usr/local/bin/upx --version 2>&1', { encoding: 'utf8' })
    hasUPX = true
  } catch {} }

  if (!hasUPX) {
    warn('UPX not found (install with: brew install upx). Skipping compression.')
    warn('  Binary size: ' + (statSync(target).size / 1024 / 1024).toFixed(1) + ' MB (uncompressed)')
    return true
  }

  const beforeSize = statSync(target).size
  log(`Compressing with UPX: ${target}`)
  try {
    execSync(`upx --best --no-color ${JSON.stringify(target)}`, { stdio: 'inherit', timeout: 300000 })
    const afterSize = statSync(target).size
    const saved = ((beforeSize - afterSize) / 1024 / 1024).toFixed(1)
    log(`${GREEN}✅ UPX compressed: ${(beforeSize / 1024 / 1024).toFixed(1)} MB → ${(afterSize / 1024 / 1024).toFixed(1)} MB (saved ${saved} MB)${RESET}`)

    // 压缩后重新镜像，保持 bin/ 与 <arch>/ 一致
    if (arch === HOST_ARCH && target !== OUTPUT_BIN) {
      mkdirSync(LEGACY_DIR, { recursive: true })
      copyFileSync(target, OUTPUT_BIN)
    }
    return true
  } catch (e) {
    warn(`UPX compression failed: ${e.message}`)
    warn('  Binary remains uncompressed at ' + target)
    return false
  }
}

function main() {
  // --only-upx 模式：只压缩已有二进制
  if (process.argv.includes('--only-upx')) {
    console.log(`${GREEN}═══════════════════════════════════════${RESET}`)
    console.log(`${GREEN}   UPX Compression Only${RESET}`)
    console.log(`${GREEN}═══════════════════════════════════════${RESET}`)
    upxCompress()
    return
  }

  if (!needsBuild()) return

  let archs
  try {
    archs = parseArchs()
  } catch (e) {
    error(e.message)
    process.exit(1)
    return
  }

  console.log(`${GREEN}═══════════════════════════════════════${RESET}`)
  console.log(`${GREEN}   ainovel-cli Engine Build${RESET}`)
  console.log(`${GREEN}   Host:    ${os.platform()} ${os.arch()}${RESET}`)
  console.log(`${GREEN}   Targets: ${archs.join(', ')}${RESET}`)
  console.log(`${GREEN}═══════════════════════════════════════${RESET}`)

  const built = build(archs)
  if (!built) {
    // postinstall 走 --check：缺 Go 或编译失败不应阻断 npm install，
    // 运行 AI 引擎前再执行 `npm run build:cli` 即可。
    if (IS_CHECK) {
      warn('跳过 ainovel-cli 编译（不影响安装）。运行 AI 引擎前请执行: npm run build:cli')
      process.exit(0)
      return
    }
    process.exit(1)
    return
  }

  for (const { arch, bin } of built) {
    upxCompress(bin, arch)
  }
  process.exit(0)
}

main()
