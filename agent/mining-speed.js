const toolTags = new WeakMap()
const tools = ['pickaxe', 'axe', 'shovel', 'hoe']

function observeToolTags(bot) {
  if (toolTags.has(bot)) return
  toolTags.set(bot, null)
  bot._client.on('tags', (packet) => {
    const registry = packet.tags?.find((entry) => entry.tagType === 'minecraft:block')
    if (!registry) return
    const sets = {}
    for (const tool of tools) {
      const tag = registry.tags.find((t) => t.tagName === 'minecraft:mineable/' + tool)
      if (tag) sets[tool] = new Set(tag.entries)
    }
    toolTags.set(bot, sets)
  })
}

function blockForTool(bot, block, item) {
  if (!block || !item) return block
  const kind = item.name?.match(/_(pickaxe|axe|shovel|hoe)$/)?.[1]
  if (!kind) return block
  const material = 'mineable/' + kind
  if (!bot.registry.materials[material]?.[item.type]) return block
  const tags = toolTags.get(bot)?.[kind]
  // Native runners can join after configuration. For that case only, recover
  // the missing pickaxe material when the block explicitly lists pickaxes.
  const fallback =
    kind === 'pickaxe' &&
    String(block.material).startsWith('incorrect_for_') &&
    Object.keys(block.harvestTools || {}).some((id) => bot.registry.items[id]?.name.endsWith('_pickaxe'))
  const defaultSpeed = bot.registry.materials[block.material]?.[item.type] || 1
  if (tags ? !tags.has(block.type) : !fallback) {
    if (tags && defaultSpeed > 1) return Object.create(block, { material: { value: 'default' } })
    return block
  }
  if (defaultSpeed === bot.registry.materials[material][item.type]) return block
  return Object.create(block, { material: { value: material } })
}
module.exports = { observeToolTags, blockForTool }
