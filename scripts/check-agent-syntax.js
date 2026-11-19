const { execFileSync } = require('node:child_process')
const { readdirSync } = require('node:fs')
const { join, resolve } = require('node:path')

const root = resolve(__dirname, '..')
const modules = readdirSync(join(root, 'agent'), { withFileTypes: true })
  .filter(entry => entry.isFile() && entry.name.endsWith('.js'))
  .map(entry => join('agent', entry.name))
const files = ['agent.js', 'supply-base.js', 'supply-station.js', 'structure-nbt.js', ...modules]

for (const file of files) {
  execFileSync(process.execPath, ['--check', file], { cwd: root, stdio: 'inherit' })
}
