const fs = require('node:fs')
const path = require('node:path')
const { Vec3 } = require('vec3')
const { goals } = require('mineflayer-pathfinder')
const { readStructureNbt } = require('./structure-nbt')
const { HUT_ID, HUT_SIZE, hutBlueprint, hutItem, hutBlockMatches,
  hutEntrance, loadHutSchematic } = require('./starter-hut')
const { runBuildPass, visibleBuildFace, placeBuildBlock } = require('./agent/creative-build')

const AIR = new Set(['air', 'cave_air', 'void_air'])
const CLEARABLE = new Set(['short_grass', 'tall_grass', 'fern', 'large_fern', 'bush', 'dead_bush', 'snow'])
const ENTRANCES = [new Vec3(0, 0, -1), new Vec3(0, 0, 1), new Vec3(-1, 0, 0), new Vec3(1, 0, 0)]
const UP = new Vec3(0, 1, 0)
const PLANK = 'planks'
const STATION_SIZE = [5, 4, 5]

class StationPlacementGoal extends goals.GoalPlaceBlock {
  constructor(bot, cell) {
    const below = UP.scaled(-1)
    const faces = cell.faces ?? (cell.baseOnly ? [below] : undefined)
    super(cell.position, bot.world, { range: 4.25, half: cell.half, faces })
    // Clicking the top of the block below always places a bottom slab.
    if (cell.half === 'bottom' && (!faces || faces.some(face => face.equals(below)))) {
      const fromBelow = new goals.GoalPlaceBlock(cell.position, bot.world, { faces: [below] })
      this.facesPos = [...fromBelow.facesPos, ...this.facesPos.filter(([face]) => !face.equals(below))]
    }
    this.facesPos = this.facesPos.flatMap(([face, point, reference]) => {
      const center = [face, point, reference]
      if (!solidGround(bot.blockAt(reference))) return [center]
      const across = face.x ? new Vec3(0, 0.3, 0) : new Vec3(0.3, 0, 0)
      const along = face.z ? new Vec3(0, 0.3, 0) : new Vec3(0, 0, 0.3)
      const offsets = [across, across.scaled(-1)]
      if (face.y) {
        offsets.push(along, along.scaled(-1))
        for (const x of [-0.38, 0.38]) for (const z of [-0.38, 0.38]) offsets.push(new Vec3(x, 0, z))
      } else if (!cell.half) offsets.push(along, along.scaled(-1))
      return [center, ...offsets.map(offset => [face, point.plus(offset), reference])]
    })
    this.bot = bot
  }

  isEnd(node) {
    return !this.unusableFeet?.equals(node) && super.isEnd(node)
  }

  getFaceAndRef(eye) {
    for (const [face, to, ref] of this.facesPos) {
      if (visibleBuildFace(this.bot, eye, to, face.scaled(-1), ref, this.options.range)) return { face, to, ref }
    }
    return null
  }

  hitFrom(bot) {
    if (this.isStandingIn(bot.entity.position.floored())) return null
    return this.getFaceAndRef(bot.entity.position.offset(0, bot.entity.eyeHeight ?? 1.62, 0))
  }
}

function emptyOrClearable(block) {
  return block && (AIR.has(block.name) || CLEARABLE.has(block.name))
}

function solidGround(block) {
  return block?.shapes?.some(shape => shape.every((value, i) => value === (i < 3 ? 0 : 1))) &&
    !/(leaves|_log|_wood|magma_block|ice|honey_block|slime_block|cactus)$/.test(block.name) &&
    block.getProperties().waterlogged !== true
}

function siteAt(bot, center, size, allowSite) {
  if (!solidGround(bot.blockAt(center.offset(0, -1, 0)))) return null
  const supports = []
  const [width, height, depth] = size
  const left = Math.floor(width / 2)
  const back = Math.floor(depth / 2)
  for (let x = -left; x < width - left; x++) {
    for (let z = -back; z < depth - back; z++) {
      const ground = bot.blockAt(center.offset(x, -1, z))
      if (!solidGround(ground)) {
        if (!emptyOrClearable(ground) || !solidGround(bot.blockAt(center.offset(x, -2, z)))) return null
        supports.push({ x, z })
      }
      for (let y = 0; y < height; y++) {
        if (!emptyOrClearable(bot.blockAt(center.offset(x, y, z)))) return null
      }
    }
  }
  for (const front of ENTRANCES) {
    const distance = front.x < 0 ? left + 1 : front.x > 0 ? width - left : front.z < 0 ? back + 1 : depth - back
    const outside = center.plus(front.scaled(distance))
    for (const offset of [0, 1]) {
      const feet = outside.offset(0, offset, 0)
      if (solidGround(bot.blockAt(feet.offset(0, -1, 0))) && AIR.has(bot.blockAt(feet)?.name) &&
          AIR.has(bot.blockAt(feet.plus(UP))?.name)) {
        const site = { center, front, entry: feet, supports, dimension: bot.game.dimension }
        if (!allowSite || allowSite(site)) return site
      }
    }
  }
  return null
}

function findSite(bot, size, origin = bot.entity.position.floored(), allowSite) {
  const candidates = []
  for (let x = -16; x <= 16; x += 2) {
    for (let z = -16; z <= 16; z += 2) {
      for (const y of [0, -1, 1, -2, 2, -3, 3]) {
        const site = siteAt(bot, origin.offset(x, y, z), size, allowSite)
        if (site) candidates.push(site)
      }
    }
  }
  const score = site => site.center.distanceTo(origin) + site.supports.length * 1.4
  candidates.sort((a, b) => score(a) - score(b))
  return candidates.slice(0, 8)
}

function blueprint(site) {
  const cells = []
  const add = (phase, block, x, y, z, baseOnly = false) => {
    cells.push({ phase, block, position: site.center.offset(x, y, z), baseOnly })
  }
  for (const { x, z } of site.supports) add('地基', PLANK, x, -1, z, true)
  for (let x = -2; x <= 2; x++) {
    for (let z = -2; z <= 2; z++) add('地板', PLANK, x, 0, z, true)
  }
  const door = site.front.scaled(2)
  for (let y = 1; y <= 2; y++) {
    for (let x = -2; x <= 2; x++) {
      for (let z = -2; z <= 2; z++) {
        if (Math.max(Math.abs(x), Math.abs(z)) !== 2 || (x === door.x && z === door.z)) continue
        add('墙体', PLANK, x, y, z, true)
      }
    }
  }
  const back = site.front.scaled(-1)
  const right = new Vec3(-site.front.z, 0, site.front.x)
  add('室内', 'chest', back.x + right.x, 1, back.z + right.z, true)
  add('室内', 'furnace', back.x - right.x, 1, back.z - right.z, true)
  add('室内', 'torch', right.x, 1, right.z, true)
  // Start the roof above an intact wall and close the unsupported interior last.
  for (const ring of [2, 1, 0]) {
    for (let x = -ring; x <= ring; x++) {
      for (let z = -ring; z <= ring; z++) {
        if (Math.max(Math.abs(x), Math.abs(z)) === ring) add('屋顶', PLANK, x, 3, z)
      }
    }
  }
  return cells
}

function matches(name, expected) {
  return expected === PLANK ? Boolean(name?.endsWith('_planks')) : name === expected
}

function vector({ x, y, z }) {
  return new Vec3(x, y, z)
}

class SupplyStation {
  constructor(stateFile, requested, schematicFile, hut = false, hutFile, { progress, saveProgress } = {}) {
    this.stateFile = stateFile
    this.saveProgress = saveProgress
    hut ||= Boolean(hutFile)
    if (hut && schematicFile) throw new Error('生存小屋与外部 NBT 蓝图需分别启动')
    this.hut = hut
    this.hutSchematic = hutFile ? loadHutSchematic(hutFile) : null
    this.schematic = schematicFile ? readStructureNbt(schematicFile) : null
    this.blueprintId = hut ? this.hutSchematic?.id ?? HUT_ID : this.schematic?.id ?? null
    this.size = hut ? HUT_SIZE : this.schematic?.size ?? STATION_SIZE
    this.requested = requested || hut || Boolean(this.schematic)
    this.phase = '待选址'
    this.completed = false
    this.worked = 0
    this.cells = []
    this.failedCells = new Map()
    const data = progress ?? (stateFile && fs.existsSync(stateFile) ? JSON.parse(fs.readFileSync(stateFile, 'utf8')) : null)
    if (data) {
      if (data.version !== 1) throw new Error('Unsupported supply station state version')
      if ((data.schematicId ?? null) !== this.blueprintId) throw new Error('蓝图已变更，请使用该图纸专用的进度文件')
      this.site = { ...data.site, center: vector(data.site.center), front: vector(data.site.front), entry: vector(data.site.entry) }
      this.cells = this.cellsForSite()
      this.worked = data.worked
      this.completed = data.completed
      this.roofStep = Boolean(data.roofStep)
      this.spawnSet = Boolean(data.spawnSet)
      this.glassPrepared = Boolean(data.glassPrepared)
      this.phase = this.completed ? '已建成' : '待复工'
      this.requested = true
      this.resumePending = !this.completed
    }
  }

  get pending() { return this.requested && !this.completed }

  protects(bot, position) {
    const center = this.site?.center
    const [width, height, depth] = this.size
    const x = position?.x - center?.x + Math.floor(width / 2)
    const z = position?.z - center?.z + Math.floor(depth / 2)
    return center && position && this.site.dimension === bot.game.dimension &&
      x >= 0 && x < width && z >= 0 && z < depth && position.y >= center.y - 2 && position.y < center.y + height
  }

  status() {
    if (!this.requested) return null
    return { phase: this.phase, placed: this.worked, total: this.cells.length,
      center: this.site?.center ?? null, completed: this.completed,
      ...(this.hut ? { schematic: '5×5 生存小屋', size: this.size, spawnSet: Boolean(this.spawnSet) } :
        this.schematic ? { schematic: this.schematic.name, size: this.size } : {}) }
  }

  cellsForSite() {
    if (this.hut) {
      const cells = hutBlueprint(this.site)
      if (!this.hutSchematic) return cells
      const { center, front } = this.site
      const right = new Vec3(front.z, 0, -front.x)
      return cells.map(cell => {
        const offset = cell.position.minus(center)
        const preferred = this.hutSchematic.materials.get([offset.dot(right), offset.y, offset.dot(front)].join())
        return preferred ? { ...cell, preferred } : cell
      })
    }
    if (!this.schematic) return blueprint(this.site)
    const { center, supports } = this.site
    const origin = center.offset(-Math.floor(this.size[0] / 2), 0, -Math.floor(this.size[2] / 2))
    const cells = supports.map(({ x, z }) => ({ phase: '地基', block: PLANK, position: center.offset(x, -1, z), baseOnly: true }))
    const ordered = this.schematic.cells.slice().sort((a, b) => a.pos[1] - b.pos[1])
    return cells.concat(ordered.map(({ block, pos }) => ({ block, position: origin.offset(...pos), phase: `第 ${pos[1] + 1} 层` })))
  }

  save() {
    if (!this.stateFile && !this.saveProgress) return
    const data = { version: 1, site: this.site, worked: this.worked,
      completed: this.completed, roofStep: this.roofStep, schematicId: this.blueprintId,
      spawnSet: this.spawnSet, glassPrepared: this.glassPrepared }
    if (this.saveProgress) this.saveProgress(data)
    if (!this.stateFile) return
    fs.mkdirSync(path.dirname(this.stateFile), { recursive: true })
    const temp = this.stateFile + '.tmp'
    fs.writeFileSync(temp, JSON.stringify(data) + '\n')
    fs.renameSync(temp, this.stateFile)
  }

  interrupt(log, reason) {
    if (!this.pending || !this.site || this.resumePending) return
    this.resumePending = true
    log('supply station paused', { ...this.status(), reason })
  }

  async selectSite(bot, work) {
    this.phase = '选址'
    for (const site of findSite(bot, this.size, work.siteOrigin, work.allowSite)) {
      if (!work.ready()) return
      const arrived = await work.walk(new goals.GoalBlock(site.entry.x, site.entry.y, site.entry.z), 5000)
      if (!arrived || !work.ready() || !site.entry.equals(bot.entity.position.floored())) continue
      this.site = site
      this.cells = this.cellsForSite()
      this.save()
      work.log('supply station site selected', { ...this.status(), entrance: site.entry, supports: site.supports.length })
      return
    }
    if (work.ready()) await work.explore()
  }

  scan(bot) {
    const missing = this.cells.filter(cell => !this.cellMatches(bot, cell))
    this.worked = this.cells.length - missing.length
    return missing
  }

  cellMatches(bot, cell) {
    return this.hut ? hutBlockMatches(bot, cell) : matches(bot.blockAt(cell.position)?.name, cell.block)
  }

  async step(bot, work) {
    if (!this.pending || !work.ready() || bot.game.dimension !== 'overworld') return
    if (!this.site) await this.selectSite(bot, work)
    if (!this.site || this.site.dimension !== bot.game.dimension || !work.ready()) return
    const { center, entry } = this.site
    if (this.hut && bot.blockAt(entry) && !await this.clearHutEntrance(bot, work)) return
    if (this.hut && !this.glassPrepared) {
      const required = this.cells.filter(cell => cell.block === 'glass' && !this.cellMatches(bot, cell)).length
      if (!await work.prepareGlass(required) || !work.ready()) return
      this.glassPrepared = true
      this.save()
    }
    if (!bot.blockAt(center) || (this.resumePending && (!this.hut || bot.entity.position.distanceTo(center) > 9))) {
      this.phase = '返回工地'
      if (!await work.walk(new goals.GoalNear(entry.x, entry.y, entry.z, 1), 16000) || !work.ready()) return
    }
    const missing = this.scan(bot)
    if (this.resumePending) {
      this.resumePending = false
      work.log('supply station resumed', this.status())
    }
    if (!missing.length) {
      this.phase = '验收'
      if (this.hut) {
        if (this.roofStep && !await this.removeHutPlatform(bot, work)) return
        if (!this.spawnSet && !await this.setHutSpawn(bot, work)) return
      } else if (!this.schematic) {
        if (this.roofStep && !await this.removeRoofStep(bot, work)) return
        if (!await work.walk(new goals.GoalBlock(entry.x, entry.y, entry.z), 6000) || !work.ready()) return
        const inside = new goals.GoalBlock(center.x, center.y + 1, center.z)
        if (!await work.walk(inside, 6000) || !work.ready()) return
        work.log('supply station entrance verified', { from: entry, to: bot.entity.position.floored() })
        if (!await this.verifyFixtures(bot, work)) return
      }
      if (!work.ready() || this.scan(bot).length) return
      this.completed = true
      this.phase = '已建成'
      this.save()
      work.log('supply station completed', this.status())
      return
    }

    const materials = {}
    for (const cell of missing) materials[cell.block] = (materials[cell.block] || 0) + 1
    const outerRoof = cell => cell.phase === '屋顶' &&
      Math.max(Math.abs(cell.position.x - center.x), Math.abs(cell.position.z - center.z)) === 2
    const roofCorner = cell => Math.abs(cell.position.x - center.x) === 2 && Math.abs(cell.position.z - center.z) === 2
    const roofStepNeeded = () => AIR.has(bot.blockAt(center.offset(0, 3, 0))?.name)
    if (this.hut && missing.some(cell => outerRoof(cell) || cell.phase === '墙体第 3 层')) {
      const needed = this.hutPlatform().filter(position => !matches(bot.blockAt(position)?.name, PLANK)).length
      materials.planks = (materials.planks ?? 0) + needed
    } else if (missing.some(outerRoof) && roofStepNeeded() && !matches(bot.blockAt(center.plus(UP))?.name, PLANK)) {
      materials.planks = (materials.planks ?? 0) + 1
    }
    this.phase = '备料'
    if (!await work.materials(materials, this.hut ? this.site : null) || !work.ready()) return
    if (bot.entity.position.distanceTo(center) > 9) {
      this.phase = '返回工地'
      if (!await work.walk(new goals.GoalNear(entry.x, entry.y, entry.z, 1), 16000) || !work.ready()) return
    }

    for (let placed = 0; placed < 8 && work.ready(); placed++) {
      const outstanding = this.scan(bot)
      if (!outstanding.length) break
      const phase = outstanding[0].phase
      this.phase = phase
      let candidates = outstanding.filter(cell => cell.phase === phase)
      const hutRim = this.hut && phase === '屋顶' ? candidates.filter(outerRoof) : []
      if (this.hut) {
        if ((phase === '墙体第 3 层' || hutRim.length) && !await this.climbHutPlatform(bot, work)) return
        if (hutRim.length) {
          this.phase = '屋顶外圈'
          candidates = hutRim
        }
        if (!hutRim.length && (phase === '屋顶' || phase === '屋顶中格') &&
            this.roofStep && !await this.removeHutPlatform(bot, work)) return
        if ((phase === '屋顶中格' || phase === '室内照明') && !bot.entity.position.floored().equals(center) &&
            (!await work.walk(new goals.GoalBlock(center.x, center.y, center.z), 6500) || !work.ready())) return
        if (phase === '门' && !this.spawnSet) {
          if (work.enterHut) {
            if (!bot.entity.position.floored().equals(center) &&
                (!await work.walk(new goals.GoalBlock(center.x, center.y, center.z), 6500) || !work.ready())) return
          } else if (!await this.setHutSpawn(bot, work)) return
        }
      } else if (phase === '屋顶') {
        const rim = candidates.filter(outerRoof)
        if (rim.length && roofStepNeeded()) {
          if (!await this.climbRoofStep(bot, work)) return
          const corners = rim.filter(roofCorner)
          candidates = corners.length ? corners : rim
          if (corners.length && !corners.some(cell => new StationPlacementGoal(bot, cell).hitFrom(bot)) &&
              await this.openRoofCorner(bot, work, corners[0])) return
        } else if (this.roofStep && !await this.removeRoofStep(bot, work)) return
      }
      const eye = bot.entity.position.offset(0, bot.entity.eyeHeight ?? 1.62, 0)
      const topWall = this.hut && phase === '墙体第 3 层'
      const prioritizeCorner = topWall || (this.hut && phase === '屋顶')
      const nearby = candidates.filter(cell => (this.failedCells.get(cell.position.toString()) ?? 0) <= Date.now())
        .map(cell => {
          const corner = prioritizeCorner && roofCorner(cell)
          const goal = new StationPlacementGoal(bot, topWall && corner ? { ...cell, baseOnly: false } : cell)
          return { cell, goal, corner, reachable: Boolean(goal.hitFrom(bot)) }
        }).filter(({ goal }) => goal.facesPos.length > 0)
      nearby.sort((a, b) => Number(b.reachable) - Number(a.reachable) ||
        Number(b.corner) - Number(a.corner) ||
        a.cell.position.distanceTo(eye) - b.cell.position.distanceTo(eye))
      if (topWall && !nearby.some(candidate => candidate.reachable)) {
        const blockedCorner = nearby.find(candidate => candidate.corner)?.cell
        if (blockedCorner && await this.openRoofCorner(bot, work, blockedCorner)) return
      }
      if (hutRim.length && !nearby.some(candidate => candidate.reachable) &&
          await this.openHutRoofRim(bot, work, outerRoof)) return
      const { advanced } = await runBuildPass(nearby.slice(0, 5), async ({ cell, goal }) =>
        await this.place(bot, work, cell, goal) ? 'placed' : 'deferred', {
        ready: work.ready,
        limit: 1,
        onResult: ({ cell }, result) => {
          if (!work.ready()) return
          if (result !== 'placed') {
            this.failedCells.set(cell.position.toString(), Date.now() + 7000)
            return
          }
          this.scan(bot)
          this.save()
          work.log('supply station block placed', { ...this.status(), block: bot.blockAt(cell.position)?.name, position: cell.position })
        },
      })
      if (!advanced) return
    }
  }

  hutPlatform() {
    const { center, front } = this.site
    return [center.plus(front), center, center.plus(UP)]
  }

  async openHutRoofRim(bot, work, outerRoof) {
    // Older progress can have an inside slab sealing the line of sight to the rim.
    const blockers = this.cells
      .filter(cell => cell.phase === '屋顶' && !outerRoof(cell) && this.cellMatches(bot, cell))
      .map(cell => bot.blockAt(cell.position))
      .filter(block => bot.canDigBlock(block))
    for (const blocker of blockers) {
      if (!work.ready()) return false
      if (!await work.dig(blocker)) continue
      this.scan(bot)
      this.save()
      work.log('starter hut reopened roof access', { position: blocker.position })
      return true
    }
    return false
  }

  async clearHutEntrance(bot, work) {
    for (const position of hutEntrance(this.site, this.hutSchematic?.heights)) {
      let block = bot.blockAt(position)
      if (!block) return false
      if (AIR.has(block.name)) continue
      this.phase = '清理小屋入口'
      if (!bot.canDigBlock(block) || !bot.canSeeBlock(block)) {
        const goal = new goals.GoalLookAtBlock(position, bot.world, { reach: 4 })
        if (!await work.walk(goal, 6500) || !work.ready()) return false
        block = bot.blockAt(position)
        if (AIR.has(block?.name)) continue
      }
      if (!work.ready() || !block?.diggable || !bot.canDigBlock(block) || !bot.canSeeBlock(block)) return false
      if (!await work.dig(block, new Set([block.name])) || !AIR.has(bot.blockAt(position)?.name)) return false
      work.log('starter hut entrance cleared', { position, block: block.name })
    }
    return true
  }

  async climbHutPlatform(bot, work) {
    if (!this.roofStep) {
      this.roofStep = true
      this.save()
    }
    for (const position of this.hutPlatform()) {
      if (!matches(bot.blockAt(position)?.name, PLANK) && !await this.place(bot, work, { position, block: PLANK, baseOnly: true })) return false
    }
    const { x, y, z } = this.site.center.offset(0, 2, 0)
    if (bot.entity.position.floored().equals(new Vec3(x, y, z))) return true
    return work.walk(new goals.GoalBlock(x, y, z), 6500)
  }

  async removeHutPlatform(bot, work) {
    const [step, base, top] = this.hutPlatform()
    for (const position of [top, base, step]) {
      let block = bot.blockAt(position)
      if (!matches(block?.name, PLANK)) continue
      if (!bot.canDigBlock(block) || !bot.canSeeBlock(block)) {
        const goal = new goals.GoalLookAtBlock(position, bot.world, { reach: 4 })
        if (!await work.walk(goal, 5500) || !work.ready()) return false
        block = bot.blockAt(position)
      }
      if (!matches(block?.name, PLANK) || !bot.canDigBlock(block) || !bot.canSeeBlock(block) ||
          !work.ready() || !await work.dig(block) || !AIR.has(bot.blockAt(position)?.name)) return false
      await bot.waitForTicks(6)
    }
    this.roofStep = false
    this.save()
    return true
  }

  async setHutSpawn(bot, work) {
    const position = this.cells.find(cell => cell.block === 'bed').pair
    const bed = bot.blockAt(position)
    if (!bed?.name.endsWith('_bed')) return false
    const { x, y, z } = this.site.center
    if (work.enterHut && !await work.enterHut()) return false
    if (!bot.entity.position.floored().equals(this.site.center) &&
        (!await work.walk(new goals.GoalBlock(x, y, z), 6000) || !work.ready())) return false
    let confirmed = false
    const message = packet => {
      if (JSON.stringify(packet?.json ?? packet).includes('block.minecraft.set_spawn') ||
          /respawn point set|已设置重生点/i.test(packet?.toString() ?? '')) confirmed = true
    }
    bot.on('message', message)
    try {
      await bot.activateBlock(bed)
      for (let tick = 0; tick < 16 && !confirmed && !bot.isSleeping && work.ready(); tick++) await bot.waitForTicks(1)
      if (!confirmed && !bot.isSleeping) return false
      this.spawnSet = true
      this.save()
      work.log('starter hut respawn confirmed', { position })
      if (bot.isSleeping) await bot.wake()
      return true
    } finally {
      bot.removeListener('message', message)
    }
  }

  async climbRoofStep(bot, work) {
    const { center } = this.site
    const step = center.plus(UP)
    if (!this.roofStep) {
      this.roofStep = true
      this.save()
    }
    if (!matches(bot.blockAt(step)?.name, PLANK) &&
        !await this.place(bot, work, { position: step, block: PLANK, baseOnly: true })) return false
    const feet = step.plus(UP)
    return work.ready() && (feet.equals(bot.entity.position.floored()) ||
      await work.walk(new goals.GoalBlock(feet.x, feet.y, feet.z), 5500))
  }

  async openRoofCorner(bot, work, corner) {
    const { center } = this.site
    const { position } = corner
    const sides = [position.offset(Math.sign(center.x - position.x), 0, 0),
      position.offset(0, 0, Math.sign(center.z - position.z))]
    for (const side of sides) {
      const block = bot.blockAt(side)
      if (!work.ready() || !matches(block?.name, PLANK) || !bot.canDigBlock(block) || !bot.canSeeBlock(block)) continue
      if (!await work.dig(block) || !work.ready()) return false
      this.scan(bot)
      this.save()
      work.log('supply station corner access opened', { phase: corner.phase, corner: position, temporarilyRemoved: side })
      return true
    }
    return false
  }

  async removeRoofStep(bot, work) {
    const { center, front } = this.site
    const step = center.plus(UP)
    const neighbor = step.plus(front)
    if (!await work.walk(new goals.GoalBlock(neighbor.x, neighbor.y, neighbor.z), 5500) || !work.ready()) return false
    const block = bot.blockAt(step)
    if (matches(block?.name, PLANK)) {
      if (!bot.canDigBlock(block) || !await work.dig(block)) return false
    }
    if (!work.ready() || !AIR.has(bot.blockAt(step)?.name)) return false
    this.roofStep = false
    this.save()
    return true
  }

  async place(bot, work, cell, goal = new StationPlacementGoal(bot, cell)) {
    const { position, block } = cell
    let current = bot.blockAt(position)
    if (!emptyOrClearable(current)) return false
    if (!goal.facesPos.length) return false
    let target = goal.hitFrom(bot)
    if (!target) {
      // A path node tests the center of a tile. The Bot's actual eyes may be
      // outside that reach or sight line even when A* accepts its current tile.
      goal.unusableFeet = bot.entity.position.floored()
      if (!await work.walk(goal, 4200) || !work.ready()) return false
      target = goal.hitFrom(bot)
    }
    if (!target || !work.ready()) return false
    current = bot.blockAt(position)
    if (!emptyOrClearable(current)) return false
    if (CLEARABLE.has(current.name)) {
      if (!bot.canDigBlock(current)) return false
      await bot.dig(current, true)
    }
    if (cell.pair && CLEARABLE.has(bot.blockAt(cell.pair)?.name)) {
      const pairedPlant = bot.blockAt(cell.pair)
      if (!bot.canDigBlock(pairedPlant) || !bot.canSeeBlock(pairedPlant)) return false
      await bot.dig(pairedPlant, true)
    }
    const items = bot.inventory.items()
    const item = items.find(item => item.name === cell.preferred && hutItem(item.name, block)) ??
      items.find(item => this.hut ? hutItem(item.name, block) : matches(item.name, block))
    const support = bot.blockAt(target.ref)
    if (!item || !support || !work.ready() || !AIR.has(bot.blockAt(position)?.name)) return false
    await bot.equip(item, 'hand')
    if (!work.ready() || !AIR.has(bot.blockAt(position)?.name) || (cell.pair && !AIR.has(bot.blockAt(cell.pair)?.name))) return false
    try {
      const result = await placeBuildBlock(bot, { support, face: target.face.scaled(-1), delta: target.to.minus(target.ref) }, {
        look: cell.look, ready: work.ready, confirm: () => this.cellMatches(bot, cell),
      })
      if (result === 'placement-rejected') work.log('supply station placement retry', { position, block, message: result })
    } catch (error) {
      if (!this.cellMatches(bot, cell)) {
        work.log('supply station placement retry', { position, block, message: error.message })
      }
    }
    return work.ready() && this.cellMatches(bot, cell)
  }

  async verifyFixtures(bot, work) {
    for (const cell of this.cells.filter(cell => ['chest', 'furnace'].includes(cell.block))) {
      if (!work.ready()) return false
      const block = bot.blockAt(cell.position)
      const window = cell.block === 'chest' ? await bot.openContainer(block) : await bot.openFurnace(block)
      window.close()
      work.log('supply station fixture verified', { block: cell.block, position: cell.position })
    }
    return true
  }
}

module.exports = { SupplyStation }
