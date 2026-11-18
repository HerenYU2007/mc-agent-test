const fs = require('node:fs')
const path = 'node_modules/minecraft-data/data.js'
let source = fs.readFileSync(path, 'utf8')
const start = source.indexOf("    '26.1': {")
const marker = "\n  },\n  'bedrock':"
const end = source.indexOf(marker, start)
if (start < 0 || end < 0) throw new Error(`Could not locate data.js block: ${start} ${end}`)
const original = source.slice(start, end)
const copy = original.replace("'26.1'", "'26.3'").replaceAll('/26.1/', '/26.3/')
const originalWithComma = original.replace(/\n    \}\s*$/, '\n    },')
source = source.slice(0, start) + originalWithComma + '\n' + copy + source.slice(end)
fs.writeFileSync(path, source)
