const { DEEPSEEK_API_KEY, DEEPSEEK_MODEL, DEEPSEEK_URL } = require('./config')
const { ACTIONS: VILLAGE_ACTIONS } = require('./expedition-village')

function createModel(runtimeState, features) {
  const pendingModelCalls = new Set()

  function stopModelCalls() {
    runtimeState.modelEnabled = false
    for (const controller of pendingModelCalls) controller.abort()
  }

  async function askDeepSeek(state, trigger = 'scheduled') {
    if (!runtimeState.modelEnabled || !runtimeState.botEnabled) return null
    const started = Date.now()
    const call = {
      time: new Date().toISOString(),
      cycle: state.cycle,
      trigger,
      status: 'pending',
      action: '—',
      target: null,
      reason: '',
      experience: '',
      promptTokens: 0,
      completionTokens: 0,
      totalTokens: 0,
      latencyMs: 0,
      state: {
        position: state.position,
        health: state.health,
        food: state.food,
        logs: state.logs,
        nearbyEntities: state.nearbyEntities,
      },
    }
    runtimeState.modelCalls.push(call)
    if (runtimeState.modelCalls.length > 60) runtimeState.modelCalls.shift()
    const payload = {
      model: DEEPSEEK_MODEL,
      messages: [
        {
          role: 'system',
          content: trigger === 'village-visit' ? [
            '你是 Minecraft 生存 Bot 的访村决策器，只返回 JSON {"action":"选项","reason":"中文理由","experience":"一句中文经验"}。',
            '仅从 choices 选一个。enter_village 进村找已有标记的资源，harvest_wheat 采成熟小麦或干草，',
            'craft_bread 用库存小麦做面包，take_bed 带走一张无人使用的备用床，observe_village 停在安全位置观察。',
            'supplies 是背包库存，resources 是村庄观测。resources.spareBed 只表示附近有可尝试取得的床，supplies.bed 才表示已经携带。干草可拆成小麦，不能用来做床。',
            '根据资源和库存判断是否值得行动。已有食物仍可合理补充面包和一张远行备用床，已够用时观察。',
            '安全返程由本地判断，发现村庄、资源暂不可达或单项物资已经够用不用返回。理由写具体物资或地形。',
          ].join(' ') : [
            '你是 Minecraft 生存 Agent 的高层决策器。',
            '根据当前状态选择一个动作，只返回 JSON：',
            '{"action":"attack|flee|collect_wood|gear_up|mine|build_camp|inspect_stone|explore","target_name":"目标实体名或方块名","target":{"x":整数,"z":整数},"reason":"简短原因","experience":"对本轮环境或行动的一句话经验总结"}。挖矿必须填写一种矿物，例如 diamond、iron、coal 或 stone，并与理由中所说的采矿目标一致。',
            '前期路线：开局先徒手砍 10-15 个原木；原木转木板，4 木板做工作台，木镐必须最先做，再做木剑和木斧；用木镐挖 8-10 块圆石，合成石镐、石剑、石斧；露天遇到第一夜时由脚本尝试做床或挖坑避难，矿洞内按当前任务行动；准备火把（煤炭加木棍）；煤炭够了后全力下矿/探洞找铁矿（绝对不要挖铜矿，不要选 copper），铁锭优先铁镐、铁剑、胸甲、头盔、盾牌；有铁镐后往深层阶梯式挖，找钻石。',
            '状态里的 stage 和 stageHint 是脚本判断的当前阶段，按 stageHint 选动作，不要跳过阶段。',
            '看到 nearbyEntities 中的 item 时优先靠近拾取；attack 只在 nearbyEntities 有敌对生物时使用；flee 表示跑路并远离威胁；生命低、饥饿低或苦力怕过近时优先 flee；explore 时给出下一目标 X/Z；不要输出游戏指令。',
            '近敌优先于砍树、挖矿和拾取。装备和生命够用时优先接战，包括有盾时接近射手。只有生命危急、缺武器、被围且状态不足，或苦力怕临近等明显打不过时才撤退。',
            '执行 collect_wood 时，材料足够就先合成木斧，再砍树。执行器会拆下并捡回自己放的临时工作台。',
          ].join(' '),
        },
        { role: 'user', content: JSON.stringify({ ...state, decisionTrigger: trigger, previousExperience: runtimeState.lastExperience }) },
      ],
      thinking: { type: 'disabled' },
      response_format: { type: 'json_object' },
      // The reply carries a Chinese reason and experience; 96 tokens cut the JSON
      // off mid-string ("Unterminated string"), which forced the script fallback.
      max_tokens: 320,
      stream: false,
    }

    const controller = new AbortController()
    pendingModelCalls.add(controller)
    try {
      const response = await fetch(DEEPSEEK_URL, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${DEEPSEEK_API_KEY}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify(payload),
        signal: AbortSignal.any([controller.signal, AbortSignal.timeout(12000)]),
      })
      if (!response.ok) throw new Error(`HTTP ${response.status}`)
      const body = await response.json()
      controller.signal.throwIfAborted()
      const usage = body.usage || {}
      runtimeState.modelUsage.requests += 1
      runtimeState.modelUsage.promptTokens += Number(usage.prompt_tokens || 0)
      runtimeState.modelUsage.completionTokens += Number(usage.completion_tokens || 0)
      runtimeState.modelUsage.totalTokens += Number(usage.total_tokens || 0)
      const content = body.choices?.[0]?.message?.content
      const decision = typeof content === 'string' ? JSON.parse(content) : content
      const allowed = new Set(['attack', 'flee', 'collect_wood', 'gear_up', 'mine', 'build_camp', 'inspect_stone', 'explore'])
      if (!decision || !(trigger === 'village-visit'
        ? VILLAGE_ACTIONS.includes(decision.action) && state.choices.includes(decision.action)
        : allowed.has(decision.action))) throw new Error('invalid model action')
      decision.reason = String(decision.reason || '').slice(0, 240)
      decision.experience = String(decision.experience || decision.reason || '').slice(0, 500)
      if (decision.target && Number.isFinite(Number(decision.target.x)) && Number.isFinite(Number(decision.target.z))) {
        decision.target = { x: Math.round(Number(decision.target.x)), z: Math.round(Number(decision.target.z)) }
      } else {
        decision.target = null
      }
      decision.target_name = String(decision.target_name || '').slice(0, 80)
      features.log('model decision', {
        model: body.model || DEEPSEEK_MODEL,
        action: decision.action,
        reason: String(decision.reason || '').slice(0, 160),
        target: decision.target,
        targetName: decision.target_name,
        experience: decision.experience,
        totalTokens: Number(usage.total_tokens || 0),
        latencyMs: Date.now() - started,
      })
      call.status = 'ok'
      call.action = decision.action
      call.target = decision.target_name
        ? { name: decision.target_name, ...(decision.target || {}) }
        : (decision.target || null)
      call.reason = decision.reason
      call.experience = decision.experience
      call.promptTokens = Number(usage.prompt_tokens || 0)
      call.completionTokens = Number(usage.completion_tokens || 0)
      call.totalTokens = Number(usage.total_tokens || 0)
      call.latencyMs = Date.now() - started
      runtimeState.lastModelDecision = { ...decision, model: body.model || DEEPSEEK_MODEL, trigger, cycle: state.cycle, time: call.time }
      features.persistExperience({ cycle: state.cycle, action: decision.action, reason: decision.reason, experience: decision.experience, target: decision.target || decision.target_name || null })
      return decision
    } catch (error) {
      call.latencyMs = Date.now() - started
      if (controller.signal.aborted) {
        call.status = 'cancelled'
        call.reason = 'DeepSeek 已关闭'
        return null
      }
      call.status = 'error'
      call.reason = error.message
      features.log('model call failed; using script fallback', { message: error.message, latencyMs: Date.now() - started })
      return null
    } finally {
      pendingModelCalls.delete(controller)
    }
  }

  return {
    stopModelCalls,
    askDeepSeek,
  }
}

module.exports = createModel
