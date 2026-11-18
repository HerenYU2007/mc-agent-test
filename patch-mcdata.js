const fs = require('node:fs')
const path = 'node_modules/minecraft-data/data.js'
let source = fs.readFileSync(path, 'utf8')
const start = source.indexOf("    '26.1': {")
const marker = "\n  },\n  'bedrock':"
const end = source.indexOf(marker, start)
if (start < 0 || end < 0) throw new Error(`Could not locate data.js block: ${start} ${end}`)
const block = source.slice(start, end + 5)
const copy = block.replace("'26.1'", "'26.3'").replaceAll('/26.1/', '/26.3/')
source = source.slice(0, end + 5) + ',\n' + copy + source.slice(end + 5)
fs.writeFileSync(path, source)
console.log('patched', start, end)
