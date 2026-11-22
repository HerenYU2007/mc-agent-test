// The model can choose an index. World actions and coordinates belong to the NMO executor.
const ENDPOINT = 'https://api.nju-aia.com/v1/chat/completions'

function createNmoPlanner(env, { log = console.log, signal, request = fetch, now = Date.now } = {}) {
  if (!env.LLM_API_KEY) return null
  if (!env.LLM_MODEL?.trim()) throw Error('配置 AIA 时需要指定 LLM_MODEL')
  if (
    env.LLM_BASE_URL &&
    ![ENDPOINT, ENDPOINT.replace('/chat/completions', '')].includes(env.LLM_BASE_URL.replace(/\/+$/, ''))
  ) {
    throw Error('AIA 规划器需要官方 LLM_BASE_URL https://api.nju-aia.com/v1')
  }
  const limit = env.LLM_MAX_CALLS === undefined ? Infinity : Number(env.LLM_MAX_CALLS)
  if (env.LLM_MAX_CALLS !== undefined && (!Number.isSafeInteger(limit) || limit < 0))
    throw Error('LLM_MAX_CALLS 需要非负整数')
  let attempts = 0
  let nextCall = 0

  return async function choose(observation) {
    if (signal?.aborted || observation.options.length < 2 || attempts >= limit || now() < nextCall)
      return undefined
    attempts++
    nextCall = now() + 30000
    try {
      const timeout = AbortSignal.timeout(15000)
      const response = await request(ENDPOINT, {
        method: 'POST',
        redirect: 'error',
        signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
        headers: { Authorization: 'Bearer ' + env.LLM_API_KEY, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: env.LLM_MODEL,
          temperature: 0.1,
          max_tokens: 192,
          stream: false,
          chat_template_kwargs: { enable_thinking: false },
          messages: [
            {
              role: 'system',
              content:
                '你是 Minecraft 生存规划器。从 options 中选一个适合当前 objective 的候选。索引从 0 开始。采集时优先可达、靠近且高度合适的目标。只返回 JSON {"choice":整数}。',
            },
            { role: 'user', content: JSON.stringify(observation) },
          ],
        }),
      })
      if (!response.ok) throw Error('HTTP ' + response.status)
      const result = await response.json()
      const message = result.choices?.[0]?.message?.content
      const text = Array.isArray(message) ? message.map((p) => p.text || '').join('') : message
      const parsed = JSON.parse(
        String(text || '')
          .trim()
          .replace(/^\x60{3}(?:json)?\s*|\s*\x60{3}$/gi, ''),
      )
      const choice = parsed?.choice
      if (!Number.isSafeInteger(choice) || choice < 0 || choice >= observation.options.length)
        throw Error('候选编号无效')
      const used = result.usage?.total_tokens
      log(
        'AIA ' +
          env.LLM_MODEL +
          ' 选择 ' +
          observation.objective +
          ' ' +
          JSON.stringify(observation.options[choice]) +
          (Number.isSafeInteger(used) ? '，总 Token ' + used : ''),
      )
      return choice
    } catch (error) {
      signal?.throwIfAborted()
      // Log only our own diagnostics. Provider responses and request headers may contain private data.
      const detail = /^(HTTP \d{3}|候选编号无效)$/.test(error.message) ? error.message : error.name
      log('AIA 本次未采用模型结果（' + detail + '），继续本地流程')
      return null
    }
  }
}
module.exports = { createNmoPlanner }
