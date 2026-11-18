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
const libraries = []

for (const entry of version.libraries ?? []) {
  const artifact = entry.downloads?.artifact
  if (artifact?.path) libraries.push(path.join(mcRoot, 'libraries', artifact.path))
  if (!artifact?.path && entry.name) {
    const parts = entry.name.split(':')
    if (parts.length >= 3) {
      const groupPath = parts[0].split('.').join('/')
      const artifactName = parts[1]
      const versionName = parts[2]
      libraries.push(path.join(mcRoot, 'libraries', groupPath, artifactName, versionName, `${artifactName}-${versionName}.jar`))
    }
  }
  const classifiers = entry.downloads?.classifiers
  const nativeName = entry.natives?.windows
  if (classifiers && nativeName && classifiers[nativeName]?.path) {
    const nativePath = path.join(mcRoot, 'libraries', classifiers[nativeName].path)
    if (fs.existsSync(nativePath)) libraries.push(nativePath)
  }
}
libraries.push(path.join(profile, '26.1-Fabric 0.19.5.jar'))
const cp = libraries.filter(fs.existsSync).join(path.delimiter)
const uuid = '802d9214-b975-38d6-a707-7763a7475626'
const args = [
  '-Xms2G', '-Xmx4G', '--enable-native-access=ALL-UNNAMED',
  `-Djava.library.path=${natives}`,
  `-Djna.tmpdir=${natives}`,
  `-Dorg.lwjgl.system.SharedLibraryExtractPath=${natives}`,
  `-Dio.netty.native.workdir=${natives}`,
  '-Dminecraft.launcher.brand=PCL',
  '-Dminecraft.launcher.version=2',
  '-DFabricMcEmu= net.minecraft.client.main.Main ',
  '-cp', cp,
  version.mainClass,
  '--username', 'NMOViewer',
  '--version', version.id,
  '--gameDir', profile,
  '--assetsDir', path.join(mcRoot, 'assets'),
  '--assetIndex', version.assetIndex.id,
  '--uuid', uuid,
  '--accessToken', '0',
  '--clientId', '0',
  '--xuid', '0',
  '--versionType', 'release',
  '--width', '1280', '--height', '720',
  '--quickPlayMultiplayer', '127.0.0.1:25566',
]

console.log(`Launching ${version.id} with ${libraries.length} libraries (${cp.length} classpath chars)`)
const child = spawn(java, args, { cwd: profile, stdio: 'inherit', windowsHide: false })
child.on('exit', code => console.log(`Minecraft exited with code ${code}`))
