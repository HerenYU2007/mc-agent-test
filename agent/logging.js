const fs = require('node:fs')
const { EXPERIENCE_LOG_PATH, RUNTIME_LOG_PATH } = require('./config')

function createLogging(runtimeState) {
  function restoreExperience() {
    try {
      const lines = fs.readFileSync(EXPERIENCE_LOG_PATH, 'utf8').trim().split(/\r?\n/).filter(Boolean)
      const previous = lines.length ? JSON.parse(lines[lines.length - 1]) : null
      if (previous?.experience) runtimeState.lastExperience = String(previous.experience)
    } catch {
      // The experience file is optional on a first run.
    }
  }

  function persistExperience(entry) {
    if (!entry?.experience) return
    runtimeState.lastExperience = String(entry.experience).slice(0, 500)
    try {
      fs.appendFileSync(EXPERIENCE_LOG_PATH, `${JSON.stringify({ time: new Date().toISOString(), ...entry })}\n`, 'utf8')
    } catch (error) {
      log('experience persistence failed', { message: error.message })
    }
  }

  function log(message, data = undefined) {
    const suffix = data === undefined ? '' : ` ${JSON.stringify(data)}`
    const event = { time: new Date().toISOString(), message, data: data ?? null }
    console.log(`[agent ${event.time}] ${message}${suffix}`)
    runtimeState.eventLog.push(event)
    if (runtimeState.eventLog.length > 80) runtimeState.eventLog.shift()
    try {
      fs.appendFileSync(RUNTIME_LOG_PATH, `${JSON.stringify(event)}\n`, 'utf8')
    } catch (error) {
      console.error(`[agent ${event.time}] runtime log persistence failed: ${error.message}`)
    }
  }

  return {
    restoreExperience,
    persistExperience,
    log,
  }
}

module.exports = createLogging
