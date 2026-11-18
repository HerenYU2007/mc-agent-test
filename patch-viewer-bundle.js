const fs = require('node:fs')
const path = 'node_modules/prismarine-viewer/public/index.js'
let source = fs.readFileSync(path, 'utf8')
source = source.replace('"1.21.1","1.21.4"]', '"1.21.1","1.21.4","26.1"]')
source = source.replace('function t(t){if(e.indexOf(t)!==-1)return t;', 'function t(t){if(t==="26.1")return"1.21.4";if(e.indexOf(t)!==-1)return t;')
fs.writeFileSync(path, source)
console.log('viewer bundle patched', source.includes('26.1'))
