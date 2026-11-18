const fs = require('node:fs')
const path = require('node:path')
const { spawn } = require('node:child_process')

const appData = process.env.APPDATA || path.join(process.env.USERPROFILE || 'C:/Users/Default', 'AppData/Roaming')
const mcRoot = process.env.MC_ROOT || path.join(appData, '.minecraft')
const profile = path.join(mcRoot, 'versions', '26.1-Fabric 0.19.5')
const versionFile = path.join(profile, '26.1-Fabric 0.19.5.json')
if (!fs.existsSync(versionFile)) {
  console.error(`Version file not found: ${versionFile}\nPlease ensure Minecraft Fabric 26.1 profile exists in ${mcRoot}`)
  process.exit(1)
}
const version = JSON.parse(fs.readFileSync(versionFile, 'utf8'))
const defaultJava = path.join(mcRoot, 'runtime', 'java-runtime-epsilon', 'bin', 'java.exe')
const java = process.env.MC_JAVA || (fs.existsSync(defaultJava) ? defaultJava : (process.env.JAVA_HOME ? path.join(process.env.JAVA_HOME, 'bin', 'java.exe') : 'java'))
const natives = path.join(profile, '26.1-Fabric 0.19.5-natives')
const gameDir = path.join(process.cwd(), 'client261-clean')
const serverAddress = process.env.MC_CLIENT_SERVER || '127.0.0.1:25567'
const observerPort = process.env.MC_OBSERVER_DASHBOARD_PORT || '3001'
if (!/^\d{1,5}$/.test(observerPort) || Number(observerPort) < 1 || Number(observerPort) > 65535) {
  throw new Error('MC_OBSERVER_DASHBOARD_PORT 必须是 1 至 65535 之间的端口')
}
fs.mkdirSync(gameDir, { recursive: true })
const libraries = []
for (const entry of version.libraries ?? []) {
  const artifact = entry.downloads?.artifact
  if (artifact?.path) libraries.push(path.join(mcRoot, 'libraries', artifact.path))
  if (!artifact?.path && entry.name) {
    const parts = entry.name.split(':')
    if (parts.length >= 3) libraries.push(path.join(mcRoot, 'libraries', parts[0].split('.').join('/'), parts[1], parts[2], `${parts[1]}-${parts[2]}.jar`))
  }
}
libraries.push(path.join(profile, '26.1-Fabric 0.19.5.jar'))
const cp = libraries.filter(fs.existsSync).join(path.delimiter)
const args = [
  '-Xms2G', '-Xmx4G', '--enable-native-access=ALL-UNNAMED',
  `-Dnmo.observer.port=${observerPort}`,
  `-Djava.library.path=${natives}`, `-Djna.tmpdir=${natives}`,
  `-Dorg.lwjgl.system.SharedLibraryExtractPath=${natives}`,
  `-Dio.netty.native.workdir=${natives}`, '-Dminecraft.launcher.brand=direct',
  '-Dminecraft.launcher.version=1', '-cp', cp, version.mainClass,
  '--username', 'NMOViewer', '--version', '26.1', '--gameDir', gameDir,
  '--assetsDir', path.join(mcRoot, 'assets'), '--assetIndex', '30',
  '--uuid', '802d9214-b975-38d6-a707-7763a7475626', '--accessToken', '0',
  '--clientId', '0', '--xuid', '0', '--versionType', 'release',
  '--width', '1280', '--height', '720', '--quickPlayMultiplayer', serverAddress,
]
console.log('Launching vanilla 26.1 client')
const child = spawn(java, args, { cwd: gameDir, stdio: 'inherit', windowsHide: false })
child.on('exit', code => console.log(`Minecraft exited with code ${code}`))
