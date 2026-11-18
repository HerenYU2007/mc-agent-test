const fs = require('node:fs')
const path = 'node_modules/minecraft-data/data.js'
const source = fs.readFileSync(path, 'utf8')
fs.writeFileSync(path, source.replace('  },,\n    \'26.3\':', '  },\n    \'26.3\':'))
