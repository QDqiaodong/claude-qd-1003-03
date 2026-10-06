<script setup>
import { computed, ref, watch } from 'vue'
import router from '../router'
import api from '../api'
import {
  INTAKE_STATUSES, INTAKE_RESULTS,
  filtersFromQuery, queryFromFilters,
  createIntakeLoader
} from './intakeFilters'

// ------------------------------------------------------------------
// 页面操作范式：过磅三联柱 + 品质胶囊。
// 每张磅单画成一根竖直的三段柱：底段毛重、其上皮重（挖掉的一段）、顶端扣杂（斜纹），
// 剩下那截高亮的就是净重——重量关系一眼看得出来，不用读数字。
// 右侧三枚胶囊直接给出糖度/纯度/纤维分，结论徽章跟着 record 自动判定走。
//
// 筛选口径（验收状态 / 品质结论）：
//  - 两个条件可单独可组合，组合按「同时满足」，未选择的不参与限制；
//  - 条件与地址查询参数（#/intake?status=&result=）双向一致，直接打开 / 刷新看到同一批；
//  - 空结果保持空态，绝不回退全部磅单；
//  - 快速切换时旧的慢响应由序号 + AbortController 丢弃，不会盖住最后一次选择；
//  - 请求失败保留当前条件与已展示列表，明确提示并可按原条件重试；
//  - 「今日进厂(吨)」由独立接口按全厂当日有效磅单统计，永远不被列表条件缩小。
// ------------------------------------------------------------------

const routeQuery = computed(() => router.currentRoute.value.query || {})
const error = ref('')
const tip = ref('')
const selectedId = ref(null)
const form = ref({
  ticketNo: '', supplier: '', truckNo: '',
  grossKg: 30000, tareKg: 11800, deductionKg: 600,
  quality: { brix: 13.5, purity: 86.0, fiber: 12.5 }
})

// 筛选条件：唯一事实来源是地址查询参数，下拉框只是它的镜像
const filters = ref(filtersFromQuery(routeQuery.value))

// 防串台加载器（序号防慢响应覆盖 + AbortController 取消旧请求；纯逻辑见 intakeFilters.js）
const loader = createIntakeLoader(api, {
  onChange(s) {
    // 刷新后选中项若不在当前结果里，落到第一项；结果为空则不选，避免详情面板展示未命中磅单
    if (s.intakes.length && !s.intakes.some((i) => i.id === selectedId.value)) {
      selectedId.value = s.intakes[0].id
    } else if (!s.intakes.length) {
      selectedId.value = null
    }
  }
})
const intakes = computed(() => loader.state.intakes)
const daily = computed(() => loader.state.daily)
const loading = computed(() => loader.state.loading)
const listError = computed(() => loader.state.error)
const hasFilter = computed(() => !!(filters.value.status || filters.value.result))

const selected = computed(() => intakes.value.find((i) => i.id === selectedId.value) || null)

// 预览：净重 = 毛重 - 皮重 - 扣杂
const previewNet = computed(() => {
  const g = Number(form.value.grossKg) || 0
  const t = Number(form.value.tareKg) || 0
  const d = Number(form.value.deductionKg) || 0
  return g - t - d
})

const previewRate = computed(() => {
  const base = (Number(form.value.grossKg) || 0) - (Number(form.value.tareKg) || 0)
  return base > 0 ? ((Number(form.value.deductionKg) || 0) / base * 100).toFixed(1) : '0.0'
})

// 下拉框改动：只更新对应查询参数，清空一项只移除那一项
function onFilterChange() {
  const target = queryFromFilters(filters.value)
  const current = routeQuery.value
  const query = { status: current.status, result: current.result, ...target }
  router.replace({ query })
}

// 地址变化（下拉框、浏览器前进后退、直接打开带参地址、首次挂载）：
// 同步下拉框并按新条件加载。immediate 同时承担首屏加载，避免重复请求。
watch(routeQuery, (q) => {
  const next = filtersFromQuery(q)
  filters.value = next
  loader.load(next)
}, { deep: true, immediate: true })

async function retryLoad() {
  // 恢复后按当前条件重试，不改条件、不清空已展示的列表
  await loader.retry()
}

async function create() {
  error.value = ''; tip.value = ''
  try {
    await api.createIntake(form.value)
    tip.value = '磅单已登记，净重 ' + previewNet.value + ' 千克'
    form.value.ticketNo = ''
    await loader.load(filters.value)
  } catch (e) { error.value = e.message }
}

async function accept(id) {
  error.value = ''; tip.value = ''
  try {
    await api.acceptIntake(id)
    tip.value = '验收完成'
    await loader.load(filters.value)
  } catch (e) { error.value = e.message }
}

async function reject(id) {
  error.value = ''; tip.value = ''
  try {
    await api.rejectIntake(id, '品质不达标')
    tip.value = '已拒收'
    await loader.load(filters.value)
  } catch (e) { error.value = e.message }
}

// 三段柱：按毛重为基准归一
function seg(v, gross) {
  const g = Number(gross) || 1
  return Math.max(0, Math.min(100, (Number(v) / g) * 100)) + '%'
}
</script>

<template>
  <div>
    <div class="panel">
      <div class="panel-head">
        <span class="panel-title">甘蔗进厂 · 过磅三联柱</span>
        <span class="panel-desc">柱高按毛重归一；挖掉皮重与扣杂，剩下高亮那段就是净重</span>
      </div>

      <div v-if="error" class="err">{{ error }}</div>
      <div v-if="tip" class="ok-tip">{{ tip }}</div>

      <div class="stat-row">
        <!-- 前三项是「当前筛选结果」的口径，数量随列表走 -->
        <div class="stat"><div class="k">磅单</div><div class="v">{{ intakes.length }}</div></div>
        <div class="stat"><div class="k">已验收</div><div class="v">{{ intakes.filter(i => i.status === '已验收').length }}</div></div>
        <div class="stat"><div class="k">拒收</div><div class="v">{{ intakes.filter(i => i.result === '拒收').length }}</div></div>
        <!-- 今日进厂总量：全厂当日有效磅单口径，不随筛选缩小 -->
        <div class="stat"><div class="k">今日进厂(吨)</div><div class="v">{{ daily }}</div></div>
      </div>

      <div class="filter-row">
        <label>验收状态
          <select v-model="filters.status" class="fld" @change="onFilterChange">
            <option value="">全部</option>
            <option v-for="s in INTAKE_STATUSES" :key="s" :value="s">{{ s }}</option>
          </select>
        </label>
        <label>品质结论
          <select v-model="filters.result" class="fld" @change="onFilterChange">
            <option value="">全部</option>
            <option v-for="r in INTAKE_RESULTS" :key="r" :value="r">{{ r }}</option>
          </select>
        </label>
        <span v-if="loading" class="f-state">查询中…</span>
      </div>

      <!-- 接口失败：保留当前条件与上一批已展示列表，明确提示并允许按原条件重试 -->
      <div v-if="listError" class="err retry-bar">
        磅单查询失败：{{ listError }}（筛选条件已保留）
        <button class="act sm primary" @click="retryLoad">按当前条件重试</button>
      </div>

      <!-- 空结果空态：合法的「没有命中」就明说，不混入任何未命中磅单 -->
      <div v-if="!listError && !loading && !intakes.length" class="empty">
        {{ hasFilter ? '当前筛选条件下没有匹配的磅单' : '暂无磅单' }}
      </div>

      <div v-if="intakes.length" class="scale-row">
        <div v-for="i in intakes" :key="i.id" class="scale" :class="{ on: i.id === selectedId }" @click="selectedId = i.id">
          <div class="col">
            <div class="seg ded" :style="{ height: seg(i.deductionKg, i.grossKg) }"></div>
            <div class="seg tare" :style="{ height: seg(i.tareKg, i.grossKg) }"></div>
            <div class="seg net" :style="{ height: seg(i.netKg, i.grossKg) }"></div>
          </div>
          <div class="s-no">{{ i.ticketNo }}</div>
          <div class="s-net">{{ i.netKg }}kg</div>
          <div class="s-res" :class="'r-' + i.result">{{ i.result }}</div>
        </div>
      </div>

      <div v-if="intakes.length" class="legend">
        <span class="lg"><i class="sw net"></i>净重</span>
        <span class="lg"><i class="sw tare"></i>皮重</span>
        <span class="lg"><i class="sw ded"></i>扣杂</span>
      </div>
    </div>

    <div class="panel" v-if="selected">
      <div class="panel-head">
        <span class="panel-title">{{ selected.ticketNo }} · {{ selected.supplier }}</span>
        <span class="panel-desc">品质三指标由 record 组件整体承载（@CompositeType）</span>
      </div>
      <div class="q-row">
        <span class="q-chip">糖度 {{ selected.quality.brix }}°</span>
        <span class="q-chip">纯度 {{ selected.quality.purity }}%</span>
        <span class="q-chip">纤维 {{ selected.quality.fiber }}%</span>
        <span class="q-chip">扣杂率 {{ selected.deductionRate }}%</span>
      </div>
      <div class="op-row">
        <button class="act primary" :disabled="selected.status !== '待验'" @click="accept(selected.id)">验收</button>
        <button class="act" :disabled="selected.status !== '待验'" @click="reject(selected.id)">拒收</button>
        <span class="st">{{ selected.status }}</span>
      </div>
    </div>

    <div class="panel">
      <div class="panel-head">
        <span class="panel-title">新增过磅</span>
        <span class="panel-desc">净重实时算给你看：{{ previewNet }} 千克，扣杂率 {{ previewRate }}%</span>
      </div>
      <div class="form-row">
        <input v-model="form.ticketNo" class="fld" placeholder="磅单号" />
        <input v-model="form.supplier" class="fld" placeholder="蔗农/合作社" />
        <input v-model="form.truckNo" class="fld" placeholder="车牌" style="width:110px" />
        <input v-model.number="form.grossKg" class="fld n" placeholder="毛重" />
        <input v-model.number="form.tareKg" class="fld n" placeholder="皮重" />
        <input v-model.number="form.deductionKg" class="fld n" placeholder="扣杂" />
      </div>
      <div class="form-row">
        <input v-model.number="form.quality.brix" class="fld n" placeholder="糖度" />
        <input v-model.number="form.quality.purity" class="fld n" placeholder="纯度" />
        <input v-model.number="form.quality.fiber" class="fld n" placeholder="纤维分" />
        <button class="act primary" @click="create">登记过磅</button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.filter-row { display: flex; gap: 12px; margin: 10px 0; align-items: center; flex-wrap: wrap; }
.filter-row label { font-size: 12px; color: var(--muted); display: flex; align-items: center; gap: 6px; }
.f-state { font-size: 12px; color: var(--muted); }
.retry-bar { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
.empty { font-size: 13px; color: var(--muted); padding: 14px 2px; }

.scale-row { display: flex; gap: 14px; flex-wrap: wrap; align-items: flex-end; }

.scale { width: 92px; text-align: center; cursor: pointer; padding: 6px; border-radius: 9px; border: 1px solid transparent; }
.scale:hover { border-color: var(--primary-soft); }
.scale.on { border-color: var(--primary); background: var(--primary-wash); }

.col {
  height: 150px; display: flex; flex-direction: column; justify-content: flex-end;
  background: #f2f4e8; border-radius: 6px; overflow: hidden; border: 1px solid var(--line);
}
.seg { width: 100%; }
.seg.net { background: linear-gradient(180deg, var(--primary-soft), var(--primary)); }
.seg.tare { background: #cfd6c2; }
.seg.ded {
  background: repeating-linear-gradient(45deg, #e57373, #e57373 5px, #ef9a9a 5px, #ef9a9a 10px);
}

.s-no { font-size: 11px; font-weight: 700; color: var(--primary-deep); margin-top: 5px; }
.s-net { font-size: 11px; color: var(--muted); }
.s-res { font-size: 10px; font-weight: 800; padding: 1px 6px; border-radius: 8px; margin-top: 3px; display: inline-block; }
.s-res.r-合格 { background: #e8f5e9; color: #2e7d32; }
.s-res.r-扣杂 { background: #fff8e1; color: #f57f17; }
.s-res.r-拒收 { background: #ffebee; color: #c62828; }

.legend { display: flex; gap: 16px; font-size: 12px; color: var(--muted); margin-top: 10px; }
.lg { display: flex; align-items: center; gap: 5px; }
.sw { width: 12px; height: 12px; border-radius: 3px; display: inline-block; }
.sw.net { background: var(--primary); }
.sw.tare { background: #cfd6c2; }
.sw.ded { background: #e57373; }

.q-row { display: flex; gap: 8px; flex-wrap: wrap; margin-bottom: 10px; }
.q-chip { font-size: 12px; padding: 4px 12px; border-radius: 14px; background: var(--primary-wash); color: var(--primary-deep); font-weight: 700; }
.op-row { display: flex; gap: 8px; align-items: center; }
.op-row .st { font-size: 12px; color: var(--muted); }

.form-row { display: flex; gap: 8px; flex-wrap: wrap; align-items: center; margin-bottom: 8px; }
</style>
