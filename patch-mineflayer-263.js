const fs = require('node:fs')
const path = 'node_modules/mineflayer/lib/version.js'
let source = fs.readFileSync(path, 'utf8')
source = source.replace("'26.1']", "'26.1', '26.3']")
fs.writeFileSync(path, source)
