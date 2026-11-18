// Compile observer-mod against the same classpath the 26.1 Fabric client uses,
// then package observer-mod/build/nmo-agent-observer-0.1.0.jar.
// Usage: node build-observer-mod.js
const fs = require('node:fs')
const path = require('node:path')
const { spawnSync } = require('node:child_process')

const appData = process.env.APPDATA || path.join(process.env.USERPROFILE || 'C:/Users/Default', 'AppData/Roaming')
const mcRoot = process.env.MC_ROOT || path.join(appData, '.minecraft')
const profile = path.join(mcRoot, 'versions', '26.1-Fabric 0.19.5')
const versionPath = path.join(profile, '26.1-Fabric 0.19.5.json')
const version = fs.existsSync(versionPath) ? JSON.parse(fs.readFileSync(versionPath, 'utf8')) : {}
const defaultJdk = path.join(mcRoot, 'runtime', 'java-runtime-epsilon')
const jdk = process.env.MC_JDK25 || (process.env.JAVA_HOME || defaultJdk)
const javac = path.join(jdk, 'bin', 'javac.exe')
const jarTool = path.join(jdk, 'bin', 'jar.exe')

const root = path.join(process.cwd(), 'observer-mod')
const src = path.join(root, 'src', 'main', 'java')
const res = path.join(root, 'src', 'main', 'resources')
const out = path.join(root, 'build', 'classes')
const jarPath = path.join(root, 'build', 'nmo-agent-observer-0.1.0.jar')

const libraries = [path.join(profile, '26.1-Fabric 0.19.5.jar')]
for (const entry of version.libraries ?? []) {
  const artifact = entry.downloads?.artifact
  if (artifact?.path) libraries.push(path.join(mcRoot, 'libraries', artifact.path))
  else if (entry.name) {
    const parts = entry.name.split(':')
    if (parts.length >= 3) libraries.push(path.join(mcRoot, 'libraries', parts[0].split('.').join('/'), parts[1], parts[2], `${parts[1]}-${parts[2]}.jar`))
  }
}
const cp = libraries.filter(fs.existsSync).join(path.delimiter)

for (const tool of [javac, jarTool]) {
  if (!fs.existsSync(tool)) {
    console.error(`missing ${tool}. The Minecraft runtime has no javac; set MC_JDK25 to a JDK 25 folder.`)
    process.exit(2)
  }
}

fs.rmSync(out, { recursive: true, force: true })
fs.mkdirSync(out, { recursive: true })
const sources = []
const walk = dir => {
  for (const name of fs.readdirSync(dir)) {
    const full = path.join(dir, name)
    if (fs.statSync(full).isDirectory()) walk(full)
    else if (name.endsWith('.java')) sources.push(full)
  }
}
walk(src)

let result = spawnSync(javac, ['-encoding', 'UTF-8', '--release', '25', '-cp', cp, '-d', out, ...sources], { stdio: 'inherit' })
if (result.status !== 0) process.exit(result.status ?? 1)
for (const name of fs.readdirSync(res)) fs.copyFileSync(path.join(res, name), path.join(out, name))
fs.rmSync(jarPath, { force: true })
result = spawnSync(jarTool, ['--create', '--file', jarPath, '-C', out, '.'], { stdio: 'inherit' })
if (result.status !== 0) process.exit(result.status ?? 1)
console.log(`built ${jarPath}`)
