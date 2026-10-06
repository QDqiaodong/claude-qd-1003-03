// 甘蔗进厂磅单筛选的纯逻辑测试：不依赖浏览器 / Vue / axios，直接跑 node --test。
// 覆盖需求里的六类场景：单条件、双条件组合、空结果、快速切换防慢响应覆盖、
// 地址（刷新 / 直接打开）还原、请求失败保留条件 + 按原条件重试。
import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  INTAKE_STATUSES, INTAKE_RESULTS,
  filtersFromQuery, queryFromFilters, paramsFromFilters, normalizeFilters,
  createIntakeLoader
} from '../src/views/intakeFilters.js'

// ---------- 地址参数 <-> 筛选条件 ----------

test('无参数地址还原为两个条件都未选择', () => {
  assert.deepEqual(filtersFromQuery({}), { status: '', result: '' })
  assert.deepEqual(filtersFromQuery(undefined), { status: '', result: '' })
})

test('单条件地址只还原对应那一项', () => {
  assert.deepEqual(filtersFromQuery({ status: '已验收' }), { status: '已验收', result: '' })
  assert.deepEqual(filtersFromQuery({ result: '拒收' }), { status: '', result: '拒收' })
})

test('双条件地址刷新 / 直接打开后完整还原（刷新还原）', () => {
  assert.deepEqual(filtersFromQuery({ status: '待验', result: '合格' }),
    { status: '待验', result: '合格' })
})

test('地址里的非法取值按未选择处理，不会带着脏条件请求', () => {
  assert.deepEqual(filtersFromQuery({ status: '已发车', result: '优秀' }), { status: '', result: '' })
  assert.deepEqual(filtersFromQuery({ status: ['待验', '已验收'] }), { status: '', result: '' })
})

test('清空一项只会移除对应的查询参数，另一项保留', () => {
  // 先在双条件地址下，清空验收状态
  const afterClearStatus = queryFromFilters({ status: '', result: '拒收' })
  assert.deepEqual(afterClearStatus, { result: '拒收' })

  const afterClearResult = queryFromFilters({ status: '待验', result: '' })
  assert.deepEqual(afterClearResult, { status: '待验' })

  assert.deepEqual(queryFromFilters({ status: '', result: '' }), {})
})

test('条件与接口参数一致：未选择不传，组合时两个一起传', () => {
  assert.deepEqual(paramsFromFilters({ status: '', result: '' }), {})
  assert.deepEqual(paramsFromFilters({ status: '已验收', result: '' }), { status: '已验收' })
  assert.deepEqual(paramsFromFilters({ status: '', result: '扣杂' }), { result: '扣杂' })
  assert.deepEqual(paramsFromFilters({ status: '已验收', result: '合格' }),
    { status: '已验收', result: '合格' })
  // 空白等同未选择
  assert.deepEqual(paramsFromFilters(normalizeFilters({ status: '   ', result: null })), {})
})

// ---------- 加载器：空结果 / 防慢响应覆盖 / 失败保留条件 / 重试 ----------

// 可控的假接口：list 记录每次收到的参数，deferred 控制响应时机；
// signal abort 时以 axios 同款方式失败（拦截器会统一成 AbortError，这里直接模拟拦截后的结果）。
function fakeApi() {
  const calls = []
  const listImpls = []
  let listIdx = 0
  // 默认返回固定值；setDaily 可改成直接操作 resolve/reject 的函数
  let dailyImpl = async () => 100
  const rejectAborted = (signal, reject) => {
    if (signal) {
      signal.addEventListener('abort', () => {
        const e = new Error('请求已取消')
        e.name = 'AbortError'
        reject(e)
      })
    }
  }
  const api = {
    calls,
    setDaily(fn) { dailyImpl = fn },
    list(params, signal) {
      const idx = listIdx++
      calls.push({ params, signal })
      return new Promise((resolve, reject) => {
        rejectAborted(signal, reject)
        listImpls[idx](resolve, reject)
      })
    },
    dailyTon(signal) {
      return new Promise((resolve, reject) => {
        rejectAborted(signal, reject)
        Promise.resolve().then(() => dailyImpl()).then(resolve, reject)
      })
    }
  }
  api.when = (fn) => { listImpls.push(fn); return api }
  return api
}

const tick = (n = 1) => {
  let p = Promise.resolve()
  for (let i = 0; i < n; i++) p = p.then(() => {})
  return p
}

test('空结果保持空态：不会再发一次「全部」请求混入未命中磅单', async () => {
  const api = fakeApi().when(async (resolve) => resolve([]))
  const loader = createIntakeLoader(api)
  await loader.load({ status: '待验', result: '拒收' })
  assert.deepEqual(loader.state.intakes, [])
  assert.equal(loader.state.error, '')
  // 只有一次列表请求，没有回退全量查询
  assert.equal(api.calls.length, 1)
  assert.deepEqual(api.calls[0].params, { status: '待验', result: '拒收' })
})

test('单条件 / 双条件发出的接口参数与选择一致', async () => {
  const api = fakeApi()
    .when(async (resolve) => resolve([{ id: 1 }]))
    .when(async (resolve) => resolve([{ id: 2 }]))
    .when(async (resolve) => resolve([{ id: 3 }, { id: 4 }]))
  const loader = createIntakeLoader(api)

  await loader.load({ status: '已验收' })
  assert.deepEqual(api.calls.at(-1).params, { status: '已验收' })

  await loader.load({ result: '扣杂' })
  assert.deepEqual(api.calls.at(-1).params, { result: '扣杂' })

  await loader.load({ status: '已验收', result: '合格' })
  assert.deepEqual(api.calls.at(-1).params, { status: '已验收', result: '合格' })
  assert.equal(loader.state.intakes.length, 2)
})

test('快速切换：较早发出的慢响应不得覆盖最后一次选择', async () => {
  const api = fakeApi()
    .when(async (resolve) => { await new Promise((r) => setTimeout(r, 30)); resolve([{ id: '慢A' }]) })
    .when(async (resolve) => { await new Promise((r) => setTimeout(r, 5)); resolve([{ id: '快B' }]) })
  const loader = createIntakeLoader(api)

  const slow = loader.load({ status: '待验' }) // 先发出、慢
  await tick()
  const fast = loader.load({ status: '已验收' }) // 后发出、快
  await fast
  assert.deepEqual(loader.state.intakes.map((i) => i.id), ['快B'])
  await slow // 慢响应回来
  assert.deepEqual(loader.state.intakes.map((i) => i.id), ['快B'], '慢响应被丢弃，不能覆盖最后一次结果')
  assert.deepEqual(loader.state.filters, { status: '已验收', result: '' })
})

test('快速切换：旧请求被 AbortController 主动取消', async () => {
  const api = fakeApi()
    .when(async () => { /* 永不返回，等 abort */ })
    .when(async (resolve) => resolve([{ id: 2 }]))
  const loader = createIntakeLoader(api)

  const first = loader.load({ status: '待验' })
  await tick()
  assert.ok(api.calls[0].signal, '请求带了 AbortSignal')
  assert.equal(api.calls[0].signal.aborted, false)
  loader.load({ status: '已验收' })
  assert.equal(api.calls[0].signal.aborted, true, '旧请求已取消')
  await first.catch(() => {})
  assert.deepEqual(loader.state.intakes.map((i) => i.id), [2])
})

test('请求失败：保留当前条件与上一批结果，明确报错，不回退全部', async () => {
  const api = fakeApi()
    .when(async (resolve) => resolve([{ id: 'ok-1' }]))
    .when(async (_resolve, reject) => reject(new Error('网络超时')))
  const loader = createIntakeLoader(api)

  await loader.load({ status: '已验收' })
  assert.equal(loader.state.intakes[0].id, 'ok-1')
  await loader.load({ status: '已拒收', result: '拒收' })
  assert.match(loader.state.error, /网络超时/)
  // 条件原样保留，便于恢复后重试
  assert.deepEqual(loader.state.filters, { status: '已拒收', result: '拒收' })
  // 已展示的上一批结果不清空（也绝不混入全部磅单）
  assert.deepEqual(loader.state.intakes.map((i) => i.id), ['ok-1'])
})

test('恢复后按原条件重试：参数不变，成功则清空错误并展示新结果', async () => {
  const api = fakeApi()
    .when(async (resolve) => resolve([{ id: 'ok-1' }]))
    .when(async (_r, reject) => reject(new Error('网络超时')))
    .when(async (resolve) => resolve([{ id: 'recovered' }]))
  const loader = createIntakeLoader(api)

  await loader.load({ status: '已拒收' })
  await loader.load({ status: '已拒收' })
  assert.match(loader.state.error, /网络超时/)

  await loader.retry()
  assert.equal(loader.state.error, '')
  assert.deepEqual(loader.state.intakes.map((i) => i.id), ['recovered'])
  // 重试带的是失败时保留的同一条件
  assert.deepEqual(api.calls.at(-1).params, { status: '已拒收' })
})

test('今日进厂总量独立统计：不受列表筛选影响，列表失败时总量仍可刷新', async () => {
  const api = fakeApi().when(async (resolve) => resolve([]))
  api.setDaily(async () => 74.4)
  const loader = createIntakeLoader(api)

  await loader.load({ status: '待验', result: '拒收' }) // 列表空
  assert.deepEqual(loader.state.intakes, [])
  assert.equal(loader.state.daily, 74.4, '总量是全厂口径，不被空列表缩小')
})

test('列表失败不影响总量：总量失败也不影响列表口径', async () => {
  const api = fakeApi().when(async (resolve) => resolve([{ id: 1 }]))
  api.setDaily(async () => { throw new Error('总量接口挂了') })
  const loader = createIntakeLoader(api)
  await loader.load({})
  assert.deepEqual(loader.state.intakes.map((i) => i.id), [1])
  assert.equal(loader.state.error, '', '总量接口失败不记成列表错误')
})

test('词典与后端一致：状态 3 项、结论 3 项', () => {
  assert.deepEqual(INTAKE_STATUSES, ['待验', '已验收', '已拒收'])
  assert.deepEqual(INTAKE_RESULTS, ['合格', '扣杂', '拒收'])
})

test('直接打开 / 刷新带参地址：地址 -> 条件 -> 接口参数全链路一致', async () => {
  // 模拟刷新场景：页面从地址 #/intake?status=已验收&result=合格 重新初始化
  const addressQuery = { status: '已验收', result: '合格' }
  const restored = filtersFromQuery(addressQuery)
  assert.deepEqual(restored, { status: '已验收', result: '合格' })

  const api = fakeApi().when(async (resolve) => resolve([{ id: 9 }]))
  const loader = createIntakeLoader(api)
  await loader.load(restored) // 页面挂载即按还原出的条件请求

  // 刷新前后看到的是同一批结果的同一组查询参数
  assert.deepEqual(api.calls[0].params, addressQuery)
  assert.deepEqual(loader.state.intakes.map((i) => i.id), [9])

  // 刷新后只清空品质结论：地址里 result 键消失，重发请求只剩 status
  const clearedResult = { ...addressQuery, result: '' }
  const newQuery = queryFromFilters(filtersFromQuery(clearedResult))
  assert.deepEqual(newQuery, { status: '已验收' })
})
