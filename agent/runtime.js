const createState = require('./state')
const createLifecycle = require('./lifecycle')
const createLogging = require('./logging')
const createDashboard = require('./dashboard')
const createTelemetry = require('./telemetry')
const createNavigation = require('./navigation')
const createWorld = require('./world')
const createSwimming = require('./swimming')
const createWaterClutch = require('./water-clutch')
const createCanopy = require('./canopy')
const createModel = require('./model')
const createCombat = require('./combat')
const createCombatDefence = require('./combat-defence')
const createCombatBow = require('./combat-bow')
const createCombatInterruption = require('./combat-interruption')
const createInventory = require('./inventory')
const createCrafting = require('./crafting')
const createSmelting = require('./smelting')
const createEquipment = require('./equipment')
const createFood = require('./food')
const createMining = require('./mining')
const createDigging = require('./digging')
const createWood = require('./wood')
const createDeathRecovery = require('./death-recovery')
const createConstruction = require('./construction')
const createBaseProgression = require('./base-progression')
const createShelter = require('./shelter')
const createProgression = require('./progression')
const createScheduler = require('./scheduler')

function startAgent() {
  const runtimeState = createState()
  const features = {}

  const factories = [
    createLifecycle,
    createLogging,
    createDashboard,
    createTelemetry,
    createNavigation,
    createWorld,
    createSwimming,
    createWaterClutch,
    createCanopy,
    createModel,
    createCombat,
    createCombatDefence,
    createCombatBow,
    createCombatInterruption,
    createInventory,
    createCrafting,
    createSmelting,
    createEquipment,
    createFood,
    createMining,
    createDigging,
    createWood,
    createDeathRecovery,
    createConstruction,
    createBaseProgression,
    createShelter,
    createProgression,
    createScheduler,
  ]
  // Factories declare their actions before any feature starts executing.
  for (const makeFeature of factories) {
    for (const [name, action] of Object.entries(makeFeature(runtimeState, features))) {
      if (Object.hasOwn(features, name)) throw new Error(`Duplicate agent feature action: ${name}`)
      features[name] = action
    }
  }

  features.installAsyncErrorHandler()
  features.initializeSupplyBase()
  features.restoreExperience()
  features.startDashboard()
  if (runtimeState.botEnabled) features.createBotConnection()
}

module.exports = { startAgent }
