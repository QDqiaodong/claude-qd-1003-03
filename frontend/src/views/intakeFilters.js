// ------------------------------------------------------------------
// 甘蔗进厂磅单筛选：与 vue 无关的纯逻辑（URL 查询参数 <-> 筛选条件、接口参数、
// 慢响应防覆盖、失败保留条件）。抽成纯 JS 是为了不依赖浏览器 / Vue 就能跑单测；
// IntakeView.vue 只负责把这里的状态包成 ref 并驱动界面。
// ------------------------------------------------------------------

// 取值与后端 Dict 对齐；下拉框只能从这里选，非法值不会发出
export const INTAKE_STATUSES = ['待验', '已验收', '已拒收']
export const INTAKE_RESULTS = ['合格', '扣杂', '拒收']

/** 空白条件统一成 ''，页面上表示「全部 / 不限制」 */
export function normalizeFilters(f) {
  const filters = f || {}
  const blank = (v) => (typeof v === 'string' && v.trim() ? v.trim() : '')
  return {
    status: blank(filters.status),
    result: blank(filters.result)
  }
}

/**
 * 地址查询参数 -> 筛选条件。只认 status / result 两个键，且取值必须在词典内，
 * 避免手改地址带出非法条件（非法项按未选择处理，不参与限制）。
 */
export function filtersFromQuery(query) {
  const q = query || {}
  const pick = (v, allowed) => (typeof v === 'string' && allowed.includes(v) ? v : '')
  return {
    status: pick(q.status, INTAKE_STATUSES),
    result: pick(q.result, INTAKE_RESULTS)
  }
}

/**
 * 筛选条件 -> 地址查询参数：未选择的项不出现在地址里，
 * 清空某一项只会移除对应的键，不能动另一项。
 */
export function queryFromFilters(filters) {
  const f = normalizeFilters(filters)
  const q = {}
  if (f.status) q.status = f.status
  if (f.result) q.result = f.result
  return q
}

/** 筛选条件 -> 接口查询参数：未选择不传，组合时两个一起传（后端按「同时满足」） */
export function paramsFromFilters(filters) {
  const f = normalizeFilters(filters)
  const p = {}
  if (f.status) p.status = f.status
  if (f.result) p.result = f.result
  return p
}

/**
 * 连续快速切换条件时的防串台加载器。
 *
 * 关键规则：
 *  ① 每次 load 递增序号，较早发出的慢响应回来后序号已过期，直接丢弃，绝不覆盖最后一次结果；
 *  ② 旧请求通过 api 支持的 signal 主动取消（AbortController）；
 *  ③ 空结果就是空结果，绝不回退成「再查一次全部」混入未命中磅单；
 *  ④ 请求失败保留当前筛选条件与上一批已展示结果，并给出错误状态供页面提示 + 重试；
 *  ⑤ 「今日进厂总量」单独统计：列表接口失败不影响它，且口径永远不受列表条件缩小。
 *
 * @param {{list: function, dailyTon: function}} api 接口，list(params, signal)
 * @param {{onChange?: function}} hooks onChange 在结果真正切换到某一批条件后回调（如校正选中项）
 */
export function createIntakeLoader(api, hooks) {
  const h = hooks || {}
  const state = {
    intakes: [],
    daily: 0,
    filters: normalizeFilters(null),
    loading: false,
    error: ''
  }

  let seq = 0
  let inflightController = null

  /**
   * @param {{status?: string, result?: string}} filters 当前条件
   * @param {{resetError?: boolean}} opts resetError=false 时不清错（内部重试入口）
   */
  async function load(filters, opts) {
    const next = normalizeFilters(filters)
    const mine = ++seq
    state.filters = next
    state.loading = true
    if (opts?.resetError !== false) state.error = ''

    // 顶掉上一批仍在飞的列表请求（慢响应连同它的总量请求一起取消）
    if (inflightController) inflightController.abort()
    const controller = typeof AbortController !== 'undefined' ? new AbortController() : null
    inflightController = controller
    const signal = controller ? controller.signal : undefined
    // 总量是与列表相互独立的全厂口径：并行请求、各自兜底，
    // 但同一批 load 被新选择顶掉时，两个请求一起作废（结果按序号丢弃）。
    const tonPromise = api.dailyTon(signal)
      .then((v) => ({ ok: true, v }))
      .catch((e) => ({ ok: false, e }))

    let rows
    try {
      rows = await api.list(paramsFromFilters(next), signal)
    } catch (e) {
      if (e?.name === 'AbortError') return // 被后一次 load 顶掉：结果、错误都不许写
      if (mine !== seq) return
      state.error = (e && e.message) || '磅单查询失败，请重试'
      state.loading = false
      return
    }
    if (mine !== seq) return // 较早发出的慢响应：直接丢弃，不能覆盖最后一次选择
    if (inflightController === controller) inflightController = null

    // 成功（含重试成功）：清空错误。空结果同样赋值空数组，不做任何回退查询
    state.error = ''
    state.intakes = Array.isArray(rows) ? rows : []

    const ton = await tonPromise
    if (mine === seq && ton.ok) state.daily = ton.v

    if (mine !== seq) return
    state.loading = false
    if (h.onChange) h.onChange(state)
  }

  /** 按当前条件重试（失败恢复后可直接点） */
  function retry() {
    return load(state.filters, { resetError: false })
  }

  return { state, load, retry }
}
