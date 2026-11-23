// Build with Zig 0.15.2. Cubiomes source is pinned to Cubitect/cubiomes PR #162.
const { readFileSync, copyFileSync } = require('node:fs')
const { join, resolve } = require('node:path')
const { spawnSync } = require('node:child_process')

const revision = 'ca9fcb4e2b4f29a88b15a19fe1f00a73bf503ec2'
const source = process.argv[2] && resolve(process.argv[2])
if (!source) throw Error('用法：node scripts/build-village-locator.cjs <Cubiomes 源码目录>')
const checkout = spawnSync('git', ['-C', source, 'rev-parse', 'HEAD'], { encoding: 'utf8' })
if (checkout.stdout?.trim() !== revision) throw Error('Cubiomes 必须检出 ' + revision)

const agent = resolve(__dirname, '../agent')
const files = ['biomenoise.c', 'biomes.c', 'finders.c', 'generator.c', 'layers.c', 'noise.c']
const args = ['cc', '-target', 'wasm32-wasi', '-mexec-model=reactor', '-O2', '-g0', '-fwrapv', '-Wl,--strip-all',
  '-Wl,--export=find_villages', '-Wl,--export=village_coordinates',
  '-I', source, join(__dirname, 'village-locator.c'), ...files.map(file => join(source, file)),
  '-o', join(agent, 'village-locator.wasm')]
const license = join(source, 'LICENSE')
readFileSync(license)
const build = spawnSync(process.env.VILLAGE_LOCATOR_ZIG || 'zig', args, { stdio: 'inherit' })
if (build.error || build.status !== 0) throw build.error ?? Error('村庄生成器编译失败')
copyFileSync(license, join(agent, 'village-locator-LICENSE.txt'))
