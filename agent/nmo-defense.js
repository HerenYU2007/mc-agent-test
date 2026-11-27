const shooters = new Set(['skeleton', 'stray', 'bogged', 'pillager'])
const missiles = new Set(['arrow', 'spectral_arrow'])
const transparent = /^(air|cave_air|void_air|water|torch|wall_torch|short_grass|tall_grass)$/

async function clearSight(call, from, to) {
  const length = Math.hypot(...to.map((v, i) => v - from[i]))
  const cells = new Map()
  const origin = from.map(Math.floor).join(',')
  const destination = to.map(Math.floor).join(',')
  for (let k = 0.15; k < length; k += 0.3) {
    const point = from.map((v, i) => Math.floor(v + ((to[i] - v) * k) / length))
    const key=point.join(',')
    if(key!==origin && key!==destination) cells.set(key, point)
  }
  const blocks = await Promise.all([...cells.values()].map((pos) => call('get_block', { pos })))
  return blocks.every(b => transparent.test(b.name) ||
    (b.properties?.open === true && /(?:door|gate)$/.test(b.name)))
}

function closingArrow(arrow, last, feet) {
  if (!last) return false
  const delta = arrow.pos.map((v, i) => v - last[i])
  const norm = delta.reduce((sum, v) => sum + v * v, 0)
  if (norm < 0.02) return false
  const eye = [feet[0], feet[1] + 1.1, feet[2]]
  const offset = eye.map((v, i) => v - arrow.pos[i])
  const time = offset.reduce((sum, v, i) => sum + v * delta[i], 0) / norm
  if (time < 0) return false
  return Math.hypot(...offset.map((v, i) => v - time * delta[i])) <= 1.8
}

function createDefense(call) {
  let lastLook,
    old = new Map(),
    shieldOwned = false,
    holdUntil = 0,
    counterUntil = 0,
    shieldWear,
    rangedSeenUntil = 0,
    sight,
    wake
  async function release(s) {
    if (!shieldOwned) return
    if (s.blocking) await call('posture', { shield: false, jump: s.jumping, sneak: s.sneaking })
    shieldOwned = false
  }
  let pending
  function tick() {
    return (pending ||= observe().finally(() => {
      pending = null
    }))
  }
  async function observe() {
    const s = await call('status')
    if (!s.ready || !s.alive || s.gamemode !== 'survival' || s.offhand?.name !== 'shield') {
      old.clear()
      shieldOwned = false
      holdUntil = 0
      counterUntil = 0
      sight = null
      return 350
    }
    const now = Date.now()
    const rows = (await call('get_entities', { types: [...shooters, ...missiles, 'creeper'], radius: 24 }))
      .entities
    const arrows = rows.filter((e) => missiles.has(e.name))
    const wear = s.offhand.durability_used ?? 0
    if (shieldWear !== undefined && wear > shieldWear) {
      counterUntil = now + 720
      holdUntil = 0
    }
    shieldWear = wear
    const incoming =
      arrows.find((e) => closingArrow(e, old.get(e.id), s.pos)) ??
      arrows.find(
        (e) =>
          !old.has(e.id) &&
          rows.some((r) => shooters.has(r.name) && Math.hypot(...r.pos.map((v, i) => v - e.pos[i])) < 3.5),
      )
    old = new Map(arrows.map((e) => [e.id, e.pos]))
    const shooter = rows.find((e) => shooters.has(e.name) && e.dist <= 9)
    let target = incoming
    if (!target && shooter && now >= counterUntil) {
      const key = [shooter.id, ...shooter.pos.map(Math.floor), ...s.pos.map(Math.floor)].join(',')
      if (!sight || key !== sight.key || now > sight.until) {
        const visible = await clearSight(
          call,
          [s.pos[0], s.pos[1] + 1.55, s.pos[2]],
          [shooter.pos[0], shooter.pos[1] + 1.5, shooter.pos[2]],
        )
        sight = { key, visible, until: now + 240 }
      }
      if (sight.visible) target = shooter
    }
    const creeper = rows.find((e) => e.name === 'creeper' && e.dist <= 3.5)
    if (!target && creeper) target = creeper
    if (target) {
      // Mining can run for several seconds. Interrupt immediately when an archer has a clear shot.
      if (s.busy === 'dig') await call('stop', {})
      const [x, y, z] = target.pos
      const desiredY = y + (missiles.has(target.name) ? 0 : 1.4)
      const desiredYaw = Math.atan2(-(x - s.pos[0]), -(z - s.pos[2]))
      const error = Math.abs(Math.atan2(Math.sin(desiredYaw - s.yaw), Math.cos(desiredYaw - s.yaw)))
      if (!lastLook || lastLook.id !== target.id || error > 0.07 || now - lastLook.at > 450) {
        await call('look', { x, y: desiredY, z })
        lastLook = { id: target.id, at: now }
      }
      if (!s.blocking) {
        await call('posture', { shield: true, jump: s.jumping, sneak: s.sneaking })
        shieldOwned = true
      }
      holdUntil = now + (incoming ? 650 : 220)
      return 45
    }
    const distantShooter = rows.find((e) => shooters.has(e.name) && e.dist > 9 && e.dist <= 20)
    if (distantShooter && !s.busy && now >= counterUntil) {
      const key = [distantShooter.id, ...distantShooter.pos.map(Math.floor), ...s.pos.map(Math.floor)].join(
        ',',
      )
      if (!sight || sight.key !== key || now > sight.until) {
        sight = {
          key,
          until: now + 360,
          visible: await clearSight(
            call,
            [s.pos[0], s.pos[1] + 1.55, s.pos[2]],
            [distantShooter.pos[0], distantShooter.pos[1] + 1.5, distantShooter.pos[2]],
          ),
        }
      }
      if (sight.visible) rangedSeenUntil = now + 1000
      if (sight.visible || now < rangedSeenUntil) {
        if (!s.blocking) {
          await call('posture', { shield: true, jump: s.jumping, sneak: s.sneaking })
          shieldOwned = true
        }
        holdUntil = now + 180
        return 45
      }
    }
    if (now >= holdUntil) await release(s)
    return shooter || arrows.length || rows.length ? 55 : 280
  }
  // Single poll in flight; the disposal waits for it before session logout.
  function start() {
    let stopped = false
    const running = (async () => {
      while (!stopped) {
        let interval = 500
        try {
          interval = await tick()
        } catch {
          old.clear()
        }
        if (!stopped)
          await new Promise((resolve) => {
            const timer = setTimeout(resolve, interval)
            wake = () => {
              clearTimeout(timer)
              resolve()
            }
          })
      }
      try {
        await release(await call('status'))
      } catch {}
    })()
    return async () => {
      stopped = true
      wake?.()
      await running
    }
  }
  return {
    start,
    tick,
    guarding: () => Date.now() < holdUntil,
    counterReady: () => Date.now() < counterUntil,
  }
}
module.exports = { createDefense, clearSight }
