// PBC Management — Enhanced with filter, batch edit, list view, export, bulk ops, charts
import { useState, useRef, useEffect, useMemo, Fragment } from 'react'
import { useLanguage } from '../contexts/LanguageContext'
import { PBC_CATEGORIES, PBC_ITEM_DEFS } from '../data/pbcCatalog'
import './PBCManager.css'

// ===== Types =====
/**
 * PBC 内部状态（用于推导对外的「已接收 / 未接收」及「已分类 / 未分类」）
 *   requested  未接收        审计已发出请求，客户尚未提交资料
 *   review     已接收·未分类  客户已提交，尚未归类 / 复核
 *   accepted   已接收·已分类  已归类并复核通过
 */
type PBCStatus = 'requested' | 'review' | 'accepted'

/** 对外展示的接收状态：PBC 清单实际只有「已接收 / 未接收」两种 */
type ReceiveState = 'received' | 'not_received'

const RECEIVE_META: Record<ReceiveState, { zh: string; en: string; color: string; bg: string }> = {
  received:     { zh: '已接收', en: 'Received',     color: '#059669', bg: '#ECFDF5' },
  not_received: { zh: '未接收', en: 'Not Received', color: '#D69E2E', bg: '#FFFBEB' },
}

/** 内部三态 → 对外两态：requested → 未接收；review / accepted → 已接收 */
const receiveOf = (s: PBCStatus): ReceiveState => (s === 'requested' ? 'not_received' : 'received')

interface PBCItem {
  id: string
  category: string
  description: string | ((isZh: boolean) => string)
  requestedBy: string
  requestedDate: string
  dueDate: string
  status: PBCStatus
  priority: 'high' | 'medium' | 'low'
  dataType: 'structured' | 'unstructured'
  fileName?: string
  fileSize?: string
  assignee?: string
}

// Helper for bilingual description
const resolveDesc = (desc: string | ((isZh: boolean) => string), isZh: boolean): string =>
  typeof desc === 'function' ? desc(isZh) : desc

// ===== 大类 / 子类 分类目录（来源：客户 PBC 清单 A 列）=====
// A 列加粗标题行 → 大类；A 列非加粗行 → 该大类下的子类
const CATEGORIES = PBC_CATEGORIES
const categoryMetaMap = Object.fromEntries(CATEGORIES.map(c => [c.key, c]))
const getCategoryLabel = (key: string, isZh: boolean) => {
  const cat = CATEGORIES.find(c => c.key === key)
  return cat ? (isZh ? cat.zh : cat.en) : key
}

// 大类数据类型徽章：由其下子类的实际数据类型推导
const categoryDataType = (
  items: { dataType: 'structured' | 'unstructured' }[],
): 'structured' | 'unstructured' | 'mixed' => {
  if (items.length === 0) return 'mixed'
  const types = new Set(items.map(i => i.dataType))
  return types.size > 1 ? 'mixed' : items[0].dataType
}

// Team members for assignment dropdown
const TEAM_MEMBERS = ['Zhang San', 'Li Si', 'Wang Wu', 'Zhao Liu', 'Qian Qi', 'Sun Ba']

// ===== Demo Data =====
// 每一条 PBC 请求 = 分类目录中的一个子类；请求元数据按顺序确定性生成
// 状态按真实分布轮转：已接收 > 待复核 > 待提供
const STATUS_SEQ: PBCStatus[] = ['accepted', 'review', 'accepted', 'requested', 'review', 'accepted', 'review', 'accepted', 'requested', 'accepted', 'review', 'requested']
const PRIORITY_SEQ: PBCItem['priority'][] = ['high', 'medium', 'medium', 'low']
const pad2 = (n: number) => String(n).padStart(2, '0')

const pbcItems: PBCItem[] = PBC_ITEM_DEFS.map((def, idx) => {
  const status = STATUS_SEQ[idx % STATUS_SEQ.length]
  const reqDay = 1 + (idx % 24)
  const dueDay = Math.min(reqDay + 9 + (idx % 6), 28)
  // 待提供的条目当前还没有可用文件
  const withFile = status !== 'requested'
  const slug = def.en.replace(/[^A-Za-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 26)
  return {
    id: String(idx + 1),
    category: def.c,
    description: (isZh: boolean) => (isZh ? def.zh : def.en),
    requestedBy: TEAM_MEMBERS[idx % TEAM_MEMBERS.length],
    requestedDate: `2026-07-${pad2(reqDay)}`,
    dueDate: `2026-07-${pad2(dueDay)}`,
    status,
    priority: PRIORITY_SEQ[idx % PRIORITY_SEQ.length],
    dataType: def.dt === 's' ? 'structured' : 'unstructured',
    fileName: withFile ? `${slug}.${def.dt === 's' ? 'xlsx' : 'pdf'}` : undefined,
    fileSize: withFile ? `${120 + (idx * 37) % 1800}KB` : undefined,
    assignee: status === 'requested' ? '' : TEAM_MEMBERS[(idx + 2) % TEAM_MEMBERS.length],
  }
})

// File Pool 列表 = PBC 管理清单中已获得文件的条目（待推送 / 已推送的候选）
// 该页签只做一件事：把这些 PBC 文件推送到 Audit File Pool
const poolCandidates: PBCItem[] = pbcItems.filter(i => i.fileName)

// ===== 未分类 PBC 文件池 =====
// 项目组已从客户处收到、但尚未匹配到 PBC 清单具体类型的文件。
// 通过拖拽到清单条目（或点击选中后再点条目）完成匹配。
/** 文件部分内容预览：表格型（Excel/明细）或文本型（PDF/合同/决议） */
type PoolPreview =
  | { type: 'table'; headers: string[]; rows: string[][]; note: string }
  | { type: 'text'; lines: string[]; note: string }

/** 清单表头的按列筛选条件 */
type ColFilters = {
  tree: string
  file: 'all' | 'matched' | 'pending'
  assignee: string
  due: string
  status: string
  priority: string
  dataType: string
  pool: 'all' | 'pushed' | 'pending'
}
const EMPTY_COL_FILTERS: ColFilters = {
  tree: '',
  file: 'all',
  assignee: 'all',
  due: 'all',
  status: 'all',
  priority: 'all',
  dataType: 'all',
  pool: 'all',
}

interface PoolFile {
  id: string
  fileName: string
  fileSize: string
  kind: 'xlsx' | 'pdf' | 'docx' | 'csv'
  /** 来源渠道 */
  source: string
  receivedAt: string
  /** 用于快速识别文件的部分内容预览 */
  preview: PoolPreview
}

const UNCLASSIFIED_FILES: PoolFile[] = [
  {
    id: 'uf-01', fileName: '2026Q2_销售明细表.xlsx', fileSize: '968KB', kind: 'xlsx', source: '客户邮件', receivedAt: '2026-07-10',
    preview: {
      type: 'table',
      headers: ['日期', '客户', '产品', '数量', '金额(元)'],
      rows: [
        ['2026-04-03', '华信科技', '智能网关 X1', '120', '1,236,000'],
        ['2026-04-18', '中科数据', '传感器模组', '340', '986,400'],
        ['2026-05-09', '恒远电子', '智能网关 X1', '95', '978,500'],
        ['2026-05-27', '华信科技', '云服务订阅', '1', '420,000'],
        ['2026-06-15', '南方智造', '传感器模组', '210', '609,000'],
      ],
      note: '共 1,284 行 · 仅预览前 5 行（Sheet1）',
    },
  },
  {
    id: 'uf-02', fileName: '董事会决议扫描件_20260709.pdf', fileSize: '1.2MB', kind: 'pdf', source: '共享盘', receivedAt: '2026-07-09',
    preview: {
      type: 'text',
      lines: [
        '启元科技有限公司 2026 年第 3 次董事会决议',
        '会议时间：2026 年 7 月 9 日 14:00',
        '会议地点：公司总部 12 层第一会议室',
        '出席董事：王建国、李慧敏、张伟民、陈静（应到 5 人，实到 4 人）',
        '',
        '议题一：审议《2026 年半年度财务报告》',
        '　决议：经审议，全体出席董事一致同意通过该报告。',
        '议题二：审议对外投资设立全资子公司事项',
        '　决议：同意以自有资金 2,000 万元设立全资子公司。',
      ],
      note: '扫描件 · 共 4 页 · 第 1 页',
    },
  },
  {
    id: 'uf-03', fileName: '应收账款账龄分析_20260630.xlsx', fileSize: '642KB', kind: 'xlsx', source: '客户邮件', receivedAt: '2026-07-08',
    preview: {
      type: 'table',
      headers: ['客户', '1年以内', '1-2年', '2年以上', '合计'],
      rows: [
        ['华信科技', '3,120,400', '480,000', '0', '3,600,400'],
        ['中科数据', '1,980,600', '120,500', '86,000', '2,187,100'],
        ['恒远电子', '860,000', '0', '240,000', '1,100,000'],
        ['南方智造', '1,420,300', '310,000', '0', '1,730,300'],
        ['合计', '7,381,300', '910,500', '326,000', '8,617,800'],
      ],
      note: '共 236 行 · 仅预览前 5 行',
    },
  },
  {
    id: 'uf-04', fileName: '银行对账单_招商银行_202606.pdf', fileSize: '2.1MB', kind: 'pdf', source: '共享盘', receivedAt: '2026-07-08',
    preview: {
      type: 'table',
      headers: ['日期', '摘要', '借方', '贷方', '余额'],
      rows: [
        ['06-01', '期初余额', '—', '—', '5,842,310.00'],
        ['06-05', '收到货款-华信科技', '—', '1,236,000.00', '7,078,310.00'],
        ['06-12', '支付货款-中兴电子', '486,500.00', '—', '6,591,810.00'],
        ['06-20', '发放工资', '1,024,800.00', '—', '5,567,010.00'],
        ['06-30', '月末余额', '—', '—', '5,567,010.00'],
      ],
      note: '招商银行 · 账号 ****8823 · 共 3 页',
    },
  },
  {
    id: 'uf-05', fileName: '存货盘点表_20260630.xlsx', fileSize: '418KB', kind: 'xlsx', source: '现场提供', receivedAt: '2026-07-07',
    preview: {
      type: 'table',
      headers: ['存货编码', '存货名称', '账面数量', '实盘数量', '差异'],
      rows: [
        ['WL-1001', '智能网关 X1', '860', '858', '-2'],
        ['WL-1002', '传感器模组', '1,240', '1,240', '0'],
        ['WL-1003', '云服务授权卡', '500', '497', '-3'],
        ['WL-1004', '控制主板', '320', '320', '0'],
      ],
      note: '共 412 行 · 仅预览前 4 行',
    },
  },
  {
    id: 'uf-06', fileName: '薪资汇总表_202606.xlsx', fileSize: '306KB', kind: 'xlsx', source: '客户邮件', receivedAt: '2026-07-07',
    preview: {
      type: 'table',
      headers: ['部门', '人数', '应发合计', '社保公积金', '个人所得税', '实发合计'],
      rows: [
        ['研发中心', '86', '1,032,000', '196,080', '62,400', '773,520'],
        ['销售中心', '54', '742,500', '123,255', '41,860', '577,385'],
        ['职能中心', '32', '368,000', '83,904', '18,240', '265,856'],
        ['合计', '172', '2,142,500', '403,239', '122,500', '1,616,761'],
      ],
      note: '共 172 人 · 仅预览汇总行',
    },
  },
  {
    id: 'uf-07', fileName: '固定资产台账_202606.xlsx', fileSize: '1.5MB', kind: 'xlsx', source: '共享盘', receivedAt: '2026-07-06',
    preview: {
      type: 'table',
      headers: ['资产编号', '资产名称', '类别', '原值', '累计折旧', '净值'],
      rows: [
        ['FA-2001', '生产设备-贴片机', '机器设备', '4,860,000', '1,296,000', '3,564,000'],
        ['FA-2002', '检测仪 A3', '机器设备', '860,000', '215,000', '645,000'],
        ['FA-2003', '总部办公楼', '房屋建筑物', '18,600,000', '2,480,000', '16,120,000'],
        ['FA-2004', '服务器集群', '电子设备', '1,240,000', '620,000', '620,000'],
      ],
      note: '共 168 项 · 仅预览前 4 项',
    },
  },
  {
    id: 'uf-08', fileName: '增值税申报表_202606.pdf', fileSize: '764KB', kind: 'pdf', source: '客户邮件', receivedAt: '2026-07-06',
    preview: {
      type: 'table',
      headers: ['项目', '本期数', '本年累计'],
      rows: [
        ['按适用税率计税销售额', '8,642,300.00', '48,915,600.00'],
        ['销项税额', '1,123,499.00', '6,359,028.00'],
        ['进项税额', '986,420.00', '5,842,140.00'],
        ['应纳增值税额', '137,079.00', '516,888.00'],
      ],
      note: '国家税务总局格式 · 所属期 2026 年 6 月',
    },
  },
  {
    id: 'uf-09', fileName: '采购订单明细_2026H1.xlsx', fileSize: '880KB', kind: 'xlsx', source: '共享盘', receivedAt: '2026-07-05',
    preview: {
      type: 'table',
      headers: ['订单号', '供应商', '物料', '数量', '含税金额'],
      rows: [
        ['PO-2603012', '中兴电子', '控制主板', '400', '1,360,000'],
        ['PO-2604028', '联创精密', '传感器模组', '1,200', '864,000'],
        ['PO-2605044', '中兴电子', '智能网关 X1', '300', '1,020,000'],
        ['PO-2606038', '华芯半导', '通信芯片', '5,000', '1,750,000'],
      ],
      note: '共 326 张订单 · 仅预览前 4 张',
    },
  },
  {
    id: 'uf-10', fileName: '租赁合同_总部办公_扫描.pdf', fileSize: '3.4MB', kind: 'pdf', source: '现场提供', receivedAt: '2026-07-04',
    preview: {
      type: 'text',
      lines: [
        '房屋租赁合同',
        '出租方（甲方）：启元置业有限公司',
        '承租方（乙方）：启元科技有限公司',
        '',
        '第一条　租赁物：总部办公楼 8–12 层，建筑面积 4,860 ㎡',
        '第二条　租赁期限：2024-01-01 至 2028-12-31（共 5 年）',
        '第三条　租金：每月人民币 486,000 元，按季预付',
        '第四条　押金：相当于 3 个月租金，计 1,458,000 元',
      ],
      note: '扫描件 · 共 12 页 · 第 1 页',
    },
  },
]

const POOL_FILE_MAP: Record<string, PoolFile> = Object.fromEntries(UNCLASSIFIED_FILES.map(f => [f.id, f]))

/** 文件名关键词 → 建议匹配的 PBC 大类（用于「AI 建议」提示，仅演示） */
const SUGGEST_RULES: [RegExp, string][] = [
  [/销售|收入|发票/, 'revenue'],
  [/应收|账龄/, 'ar'],
  [/采购|订单|供应商/, 'purchase'],
  [/银行|对账|流水/, 'cash'],
  [/存货|盘点/, 'inventory'],
  [/薪资|工资/, 'payroll'],
  [/固定资|台账/, 'fixedasset'],
  [/增值税|申报|税/, 'tax'],
  [/租赁|合同/, 'lease'],
  [/董事会|决议/, 'general'],
]
const suggestCategoryKey = (f: PoolFile): string =>
  SUGGEST_RULES.find(([re]) => re.test(f.fileName))?.[1] || 'general'

// ===== Component =====
function PBCManager() {
  const { lang } = useLanguage()
  const [viewMode, setViewMode] = useState<'cards' | 'list'>('list')
  const [expandedCategory, setExpandedCategory] = useState<string | null>(null)
  /** Sync to KCC 按钮的同步中状态（演示用，无真实后端） */
  const [kccSyncing, setKccSyncing] = useState(false)

  // Filter states (from screenshot guide)
  const [filterStatus, setFilterStatus] = useState<string>('all')
  const [filterCategory, setFilterCategory] = useState<string>('all')
  const [filterSearch, setFilterSearch] = useState('')
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set())

  // Batch edit state
  const [showBatchEdit, setShowBatchEdit] = useState(false)
  const [batchAssignee, setBatchAssignee] = useState('')
  const [batchDueDate, setBatchDueDate] = useState('')
  const [batchPriority, setBatchPriority] = useState('')

  // File Pool 推送状态（已推送到 Audit File Pool 的 PBC 文件 id 集合）
  const [pushedIds, setPushedIds] = useState<Set<string>>(
    // 演示：已接收(accepted)的条目默认视为已推送成功
    () => new Set(poolCandidates.filter(i => i.status === 'accepted').map(i => i.id)),
  )

  // ===== 未分类文件 → PBC 清单 匹配（在「文件分拣」窗口内完成）=====
  const [poolIds, setPoolIds] = useState<string[]>(() => UNCLASSIFIED_FILES.map(f => f.id))
  /** 条目 id → 已匹配的文件 id 数组（一个条目可匹配多个文件） */
  const [matches, setMatches] = useState<Record<string, string[]>>({})
  /** 匹配成功后条目的状态覆盖（新收到文件 → 待复核） */
  const [statusOverride, setStatusOverride] = useState<Record<string, PBCStatus>>({})
  const [collapsedCats, setCollapsedCats] = useState<Set<string>>(new Set())
  const [flashId, setFlashId] = useState<string | null>(null)
  const [toast, setToast] = useState<string | null>(null)
  const toastTimer = useRef<number | null>(null)

  // ===== 文件分拣窗口 =====
  const [showSorter, setShowSorter] = useState(false)
  const [sorterFileId, setSorterFileId] = useState<string | null>(null)
  const [sorterFileQuery, setSorterFileQuery] = useState('')
  const [sorterCheckQuery, setSorterCheckQuery] = useState('')
  const [sorterStatus, setSorterStatus] = useState<'all' | 'pending'>('all')
  const [sorterKind, setSorterKind] = useState<'all' | PoolFile['kind']>('all')
  const [sorterCollapsed, setSorterCollapsed] = useState<Set<string>>(new Set())
  /** 分拣窗口：正在拖拽的文件 / 当前拖入高亮的条目 */
  const [draggingSorterFileId, setDraggingSorterFileId] = useState<string | null>(null)
  const [sorterDropItemId, setSorterDropItemId] = useState<string | null>(null)
  const [sorterDropCatKey, setSorterDropCatKey] = useState<string | null>(null)

  // ===== 清单表头按列筛选 =====
  const [colFilters, setColFilters] = useState<ColFilters>(EMPTY_COL_FILTERS)

  const showToast = (msg: string) => {
    setToast(msg)
    if (toastTimer.current) window.clearTimeout(toastTimer.current)
    toastTimer.current = window.setTimeout(() => setToast(null), 2600)
  }

  /** 条目 → 已匹配的文件 id 数组（一个条目可匹配多个文件，一份文件只属于一个条目） */
  const matchedFileIds = (item: PBCItem): string[] => matches[item.id] || []

  /** 条目当前生效的文件：优先第一个从文件池匹配的文件，其次条目自带文件 */
  const effFile = (item: PBCItem): { name: string; size?: string; kind: string; fromPool: boolean } | null => {
    const ids = matches[item.id]
    if (ids && ids.length) {
      const pf = POOL_FILE_MAP[ids[0]]
      if (pf) return { name: pf.fileName, size: pf.fileSize, kind: pf.kind, fromPool: true }
    }
    if (item.fileName) {
      return { name: item.fileName, size: item.fileSize, kind: (item.fileName.split('.').pop() || '').toLowerCase(), fromPool: false }
    }
    return null
  }

  const effStatus = (item: PBCItem): PBCStatus => statusOverride[item.id] || item.status

  /**
   * 将一个未分类文件匹配到某 PBC 条目。
   * 文件「一对一」消费：匹配后从左侧未分类列表消失（移出 poolIds），
   * 同一份文件不会被匹配到多个条目；而一个条目可以累积多个文件。
   */
  const assignFile = (itemId: string, fileId: string) => {
    const f = POOL_FILE_MAP[fileId]
    const item = pbcItems.find(i => i.id === itemId)
    if (!f || !item) return
    if (!poolIds.includes(fileId)) return // 已匹配过，忽略
    setMatches(m => {
      const arr = m[itemId] ? [...m[itemId]] : []
      if (!arr.includes(fileId)) arr.push(fileId)
      return { ...m, [itemId]: arr }
    })
    setPoolIds(ids => ids.filter(id => id !== fileId))
    setStatusOverride(s => ({ ...s, [itemId]: 'review' }))
    setFlashId(itemId)
    window.setTimeout(() => setFlashId(cur => (cur === itemId ? null : cur)), 1100)
    showToast(t(`已将「${f.fileName}」匹配到「${resolveDesc(item.description, isZh)}」`,
                `Matched "${f.fileName}" to "${resolveDesc(item.description, isZh)}"`))
  }

  /** 解除某份文件的匹配：从所属条目移除并放回未分类文件池（一份文件只属于一个条目） */
  const unassignFile = (fileId: string) => {
    const entry = Object.entries(matches).find(([, arr]) => arr.includes(fileId))
    if (!entry) return
    const [itemId] = entry
    setMatches(m => {
      const n = { ...m }
      n[itemId] = (n[itemId] || []).filter(id => id !== fileId)
      if (n[itemId].length === 0) delete n[itemId]
      return n
    })
    setPoolIds(ids => UNCLASSIFIED_FILES.map(p => p.id).filter(id => id === fileId || ids.includes(id)))
    setStatusOverride(s => {
      const n = { ...s }
      const rest = (matches[itemId] || []).filter(id => id !== fileId)
      if (rest.length === 0) delete n[itemId]
      return n
    })
    showToast(t('已取消匹配，文件已放回未分类文件池', 'Unmatched — file returned to the pool'))
  }

  const toggleCat = (key: string) => setCollapsedCats(prev => {
    const next = new Set(prev)
    if (next.has(key)) next.delete(key); else next.add(key)
    return next
  })

  /** 勾选 / 取消勾选某个大类下的全部条目 */
  const toggleCatSelect = (items: PBCItem[]) => {
    const allSelected = items.every(i => selectedIds.has(i.id))
    setSelectedIds(prev => {
      const next = new Set(prev)
      if (allSelected) items.forEach(i => next.delete(i.id))
      else items.forEach(i => next.add(i.id))
      return next
    })
  }

  const cardRefs = useRef<Record<string, HTMLDivElement | null>>({})

  const isZh = lang === 'zh'
  const t = (zh: string, en: string) => (isZh ? zh : en)

  // --- 接收状态展示配置（已接收 / 未接收）---
  const rc = (state: ReceiveState) => {
    const d = RECEIVE_META[state]
    return { label: isZh ? d.zh : d.en, color: d.color, bg: d.bg }
  }

  // --- File Pool 推送 ---
  const isPushed = (id: string) => pushedIds.has(id)
  const pushFiles = (ids: string[]) => {
    setPushedIds(prev => {
      const next = new Set(prev)
      ids.forEach(id => next.add(id))
      return next
    })
  }

  // --- Computed filtered data ---
  const filteredItems = useMemo(() => {
    let items = pbcItems
    if (filterStatus !== 'all') items = items.filter(i => receiveOf(effStatus(i)) === filterStatus)
    if (filterCategory !== 'all') items = items.filter(i => i.category === filterCategory)
    if (filterSearch.trim()) {
      const q = filterSearch.toLowerCase()
      items = items.filter(i =>
        resolveDesc(i.description, isZh).toLowerCase().includes(q) ||
        getCategoryLabel(i.category, isZh).toLowerCase().includes(q) ||
        i.requestedBy.toLowerCase().includes(q)
      )
    }

    // ===== 表头按列筛选 =====
    const cf = colFilters
    if (cf.tree.trim()) {
      const q = cf.tree.trim().toLowerCase()
      items = items.filter(i => resolveDesc(i.description, isZh).toLowerCase().includes(q))
    }
    if (cf.file !== 'all') {
      items = items.filter(i => (cf.file === 'matched' ? Boolean(effFile(i)) : !effFile(i)))
    }
    if (cf.assignee !== 'all') items = items.filter(i => (i.assignee || i.requestedBy) === cf.assignee)
    if (cf.due !== 'all') items = items.filter(i => i.dueDate === cf.due)
    if (cf.status !== 'all') items = items.filter(i => receiveOf(effStatus(i)) === cf.status)
    if (cf.priority !== 'all') items = items.filter(i => i.priority === cf.priority)
    if (cf.dataType !== 'all') items = items.filter(i => i.dataType === cf.dataType)
    if (cf.pool !== 'all') {
      items = items.filter(i => (cf.pool === 'pushed' ? isPushed(i.id) : !isPushed(i.id)))
    }
    return items
  }, [filterStatus, filterCategory, filterSearch, isZh, colFilters, matches, statusOverride, pushedIds])

  /** 表头筛选可选值 */
  const colOptions = useMemo(() => ({
    assignees: Array.from(new Set(pbcItems.map(i => i.assignee || i.requestedBy))).sort(),
    dues: Array.from(new Set(pbcItems.map(i => i.dueDate))).sort(),
  }), [])

  const hasColFilters = colFilters.tree.trim() !== '' ||
    colFilters.file !== 'all' || colFilters.assignee !== 'all' || colFilters.due !== 'all' ||
    colFilters.status !== 'all' || colFilters.priority !== 'all' ||
    colFilters.dataType !== 'all' || colFilters.pool !== 'all'

  // Stats
  const stats = useMemo(() => {
    const byStatus: Record<PBCStatus, number> = { requested: 0, review: 0, accepted: 0 }
    let structured = 0
    pbcItems.forEach(i => {
      byStatus[i.status] += 1
      if (i.dataType === 'structured') structured += 1
    })
    // 对外两态：已接收 = 待复核 + 已接收；未接收 = 待提供
    const received = byStatus.review + byStatus.accepted
    // 已接收细分：已分类 = 复核通过(accepted)；未分类 = 已收到但待归类/复核(review)
    const classified = byStatus.accepted
    const unclassified = byStatus.review
    const notReceived = byStatus.requested
    return {
      total: pbcItems.length,
      byStatus,
      received,
      classified,
      unclassified,
      notReceived,
      /** 仍需客户方提供的条目（即未接收） */
      followUp: notReceived,
      structured,
      unstructured: pbcItems.length - structured,
      /** File Pool：已获得文件、可进入推送流程的条目数 */
      inPool: poolCandidates.length,
    }
  }, [])

  // Chart data
  const chartData = useMemo(() => {
    const byCategory = CATEGORIES.map(c => {
      const items = pbcItems.filter(i => i.category === c.key)
      const total = items.length
      const received = items.filter(i => effStatus(i) !== 'requested').length
      const notReceived = total - received
      // 该类目下收到的文件总数：一个条目可能挂多个文件，一个类目可包含多个条目，
      // 因此这里按「文件」聚合，而不是按「条目」计数（与下方 checklist 一致）。
      const fileCount = items.reduce(
        (n, i) => n + (matchedFileIds(i).length || (i.fileName ? 1 : 0)),
        0,
      )
      return {
        key: c.key,
        label: isZh ? c.zh : c.en,
        color: c.color,
        total,
        received,
        notReceived,
        fileCount,
      }
    }).filter(c => c.total > 0)
    return {
      // 完成率 = 已接收到的 PBC 条目 / 全部 PBC 条目
      completionRate: Math.round((stats.received / stats.total) * 100),
      byCategory,
      // 条形长度按最大类目的条目数归一化，条内再按已接收 / 未接收分段
      maxCategoryCount: Math.max(1, ...byCategory.map(c => c.total)),
      // 类目文件合计（= 下方 checklist 中已接收文件数之和）
      totalFiles: byCategory.reduce((n, c) => n + c.fileCount, 0),
    }
  }, [isZh, stats, matches, statusOverride])

  // Grouped for card view
  const grouped: Record<string, PBCItem[]> = {}
  filteredItems.forEach(item => {
    if (!grouped[item.category]) grouped[item.category] = []
    grouped[item.category].push(item)
  })

  // List 视图树形数据：父级 = 大类，子级 = 该大类下的 PBC 条目（保持目录顺序）
  const treeData = useMemo(() => {
    const byCat: Record<string, PBCItem[]> = {}
    filteredItems.forEach(i => {
      if (!byCat[i.category]) byCat[i.category] = []
      byCat[i.category].push(i)
    })
    return CATEGORIES
      .filter(c => byCat[c.key] && byCat[c.key].length > 0)
      .map(c => ({ cat: c, items: byCat[c.key] }))
  }, [filteredItems])

  /** 当前筛选结果中「已匹配到文件」的条目数（含新从文件池匹配的） */
  const matchedItemCount = filteredItems.filter(i => effFile(i)).length

  // ===== 文件分拣窗口：数据 =====
  /** 文件 id → 匹配到的条目 id（一份文件只属于一个条目） */
  const fileMatchMap = useMemo(() => {
    const map: Record<string, string> = {}
    Object.entries(matches).forEach(([itemId, ids]) => {
      ids.forEach(fid => { map[fid] = itemId })
    })
    return map
  }, [matches])

  /** 左栏文件列表：仅展示尚未匹配（仍在未分类池）的文件，匹配后即消失 */
  const sorterFiles = useMemo(() => {
    const q = sorterFileQuery.trim().toLowerCase()
    return poolIds
      .map(id => POOL_FILE_MAP[id])
      .filter(Boolean)
      .filter(f => {
        if (q && !f.fileName.toLowerCase().includes(q)) return false
        if (sorterKind !== 'all' && f.kind !== sorterKind) return false
        return true
      })
  }, [sorterFileQuery, sorterKind, poolIds])

  /** 中栏清单树：不受主列表筛选影响，展示全部 PBC 条目 */
  const sorterTree = useMemo(() => {
    const q = sorterCheckQuery.trim().toLowerCase()
    const byCat: Record<string, PBCItem[]> = {}
    pbcItems.forEach(i => {
      const hay = `${resolveDesc(i.description, isZh)} ${getCategoryLabel(i.category, isZh)}`.toLowerCase()
      if (q && !hay.includes(q)) return
      if (!byCat[i.category]) byCat[i.category] = []
      byCat[i.category].push(i)
    })
    return CATEGORIES
      .filter(c => byCat[c.key] && byCat[c.key].length > 0)
      .map(c => ({ cat: c, items: byCat[c.key] }))
  }, [sorterCheckQuery, isZh])

  const sorterFile = sorterFileId ? POOL_FILE_MAP[sorterFileId] : null
  const sorterMatchedItemId = sorterFileId ? fileMatchMap[sorterFileId] : undefined
  const sorterMatchedItem = sorterMatchedItemId
    ? pbcItems.find(i => i.id === sorterMatchedItemId)
    : undefined
  const sorterSuggest = sorterFile ? categoryMetaMap[suggestCategoryKey(sorterFile)] : undefined
  const sorterKeywords = sorterFile
    ? sorterFile.fileName.replace(/\.[^.]+$/, '').split(/[_\-\s]+/).filter(Boolean).slice(0, 3)
    : []
  const allMatchedCount = pbcItems.filter(i => effFile(i)).length

  const openSorter = () => {
    setSorterFileId(poolIds[0] || UNCLASSIFIED_FILES[0]?.id || null)
    setSorterFileQuery('')
    setSorterCheckQuery('')
    setSorterStatus('all')
    setSorterKind('all')
    setShowSorter(true)
  }

  const toggleSorterCat = (key: string) => setSorterCollapsed(prev => {
    const next = new Set(prev)
    if (next.has(key)) next.delete(key); else next.add(key)
    return next
  })

  /** 在分拣窗口内把当前选中文件匹配到某条目，并自动跳到下一个待分拣文件 */
  const matchSorterItem = (item: PBCItem) => {
    if (!sorterFileId) {
      showToast(t('请先在左侧选择一个文件', 'Select a file on the left first'))
      return
    }
    const nextFileId = poolIds.find(id => id !== sorterFileId) || null
    assignFile(item.id, sorterFileId)
    setSorterFileId(nextFileId)
  }

  /** 拖拽匹配：把左侧某份文件直接放到中间条目上；匹配后该文件从左侧消失，自动切到下一个待分拣文件 */
  const dropSorterFileOnItem = (fileId: string, item: PBCItem) => {
    if (!POOL_FILE_MAP[fileId]) return
    if (!poolIds.includes(fileId)) return // 已匹配过，忽略
    assignFile(item.id, fileId)
    const nextFileId = poolIds.find(id => id !== fileId) || null
    setSorterFileId(nextFileId)
  }

  /** 拖到分类标题：匹配到该分类下第一个尚未匹配文件的条目 */
  const dropSorterFileOnCategory = (fileId: string, items: PBCItem[]) => {
    const target = items.find(i => matchedFileIds(i).length === 0)
    if (!target) {
      showToast(t('该分类下的条目均已匹配文件', 'All items in this category already have files'))
      return
    }
    dropSorterFileOnItem(fileId, target)
  }

  /** Sync to KCC：演示交互——先进入同步中，再回执本次同步的条目数 */
  const handleSyncToKcc = () => {
    if (kccSyncing) return
    setKccSyncing(true)
    showToast(t('正在同步至 KCC…', 'Syncing to KCC…'))
    window.setTimeout(() => {
      setKccSyncing(false)
      showToast(t(`已同步 ${filteredItems.length} 项 PBC 至 KCC`, `Synced ${filteredItems.length} PBC items to KCC`))
    }, 1200)
  }

  // ===== File Pool 推送统计（Cards / List 两个视图共用）=====
  const poolReadyCount = poolCandidates.filter(i => !isPushed(i.id)).length
  const poolPushedCount = poolCandidates.length - poolReadyCount
  /** 当前筛选结果中「已选中且可推送」的条目 ID */
  const selectedPushableIds = filteredItems
    .filter(i => selectedIds.has(i.id) && i.fileName && !isPushed(i.id))
    .map(i => i.id)
  /** 推送目标数：有选中则推所选，否则推全部待推送 */
  const pushTargetCount = selectedPushableIds.length > 0 ? selectedPushableIds.length : poolReadyCount
  const pushAllReady = () => pushFiles(poolCandidates.filter(i => !isPushed(i.id)).map(i => i.id))
  /** 单一推送入口：优先推送所选，无选中时推送全部 */
  const handlePush = () => {
    if (selectedPushableIds.length > 0) pushFiles(selectedPushableIds)
    else pushAllReady()
  }

  // --- Handlers ---
  const handleCardClick = (category: string) => {
    setExpandedCategory(expandedCategory === category ? null : category)
  }

  const toggleSelect = (id: string) => {
    setSelectedIds(prev => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id); else next.add(id)
      return next
    })
  }

  const toggleSelectAll = () => {
    if (selectedIds.size === filteredItems.length) {
      setSelectedIds(new Set())
    } else {
      setSelectedIds(new Set(filteredItems.map(i => i.id)))
    }
  }

  const clearFilters = () => {
    setFilterStatus('all')
    setFilterCategory('all')
    setFilterSearch('')
    setColFilters(EMPTY_COL_FILTERS)
    setSelectedIds(new Set())
  }

  const clearColFilters = () => setColFilters(EMPTY_COL_FILTERS)

  const applyBatchEdit = () => {
    // In real app this would call API
    alert(t(`批量更新 ${selectedIds.size} 条PBC：负责人=${batchAssignee}, 截止=${batchDueDate}, 优先级=${batchPriority}`,
             `Bulk update ${selectedIds.size} PBCs: Assignee=${batchAssignee}, Due=${batchDueDate}, Priority=${batchPriority}`))
    setSelectedIds(new Set())
    setShowBatchEdit(false)
    setBatchAssignee('')
    setBatchDueDate('')
    setBatchPriority('')
  }

  useEffect(() => {
    const handleEsc = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      setExpandedCategory(null)
      setShowSorter(false)
    }
    window.addEventListener('keydown', handleEsc)
    return () => window.removeEventListener('keydown', handleEsc)
  }, [])

  // ======================== RENDER ========================
  return (
    <div className="pbc-manager animate-fade-in">
      {/* ===== Header ===== */}
      <div className="pbc-header-row">
        <div className="pbc-header-left">
          <div>
            <h1 className="pbc-title">{t('PBC 管理清单', 'PBC Management List')}</h1>
            <span className="pbc-subtitle">{t('客户文件采集 · 分类 · 处理与推送中心', 'Client document collection · categorization · processing & push center')}</span>
          </div>
          {/* 视图切换：移到左侧，靠近标题，便于用户发现 */}
          <div className="pbc-view-toggle">
            <button className={`pvt-btn ${viewMode === 'cards' ? 'active' : ''}`} onClick={() => setViewMode('cards')}>
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><rect x="3" y="3" width="7" height="7"/><rect x="14" y="3" width="7" height="7"/><rect x="3" y="14" width="7" height="7"/><rect x="14" y="14" width="7" height="7"/></svg>
              {t('分类视图', 'Cards')}
            </button>
            <button className={`pvt-btn ${viewMode === 'list' ? 'active' : ''}`} onClick={() => setViewMode('list')}>
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><line x1="3" y1="6" x2="21" y2="6"/><line x1="3" y1="12" x2="21" y2="12"/><line x1="3" y1="18" x2="21" y2="18"/></svg>
              {t('列表视图', 'List')}
            </button>
          </div>
        </div>
        <div className="pbc-header-actions">
          <button className="pbc-sync-btn" onClick={handleSyncToKcc} disabled={kccSyncing} title={t('将当前 PBC 清单同步至 KCC', 'Sync current PBC list to KCC')}>
            <svg className={`pbc-sync-ico ${kccSyncing ? 'is-spinning' : ''}`} width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M21 12a9 9 0 0 1-15.5 6.2" />
              <path d="M3 12a9 9 0 0 1 15.5-6.2" />
              <polyline points="21 3 21 9 15 9" />
              <polyline points="3 21 3 15 9 15" />
            </svg>
            {kccSyncing ? t('同步中…', 'Syncing…') : 'Sync to KCC'}
          </button>
          <button className="pbc-new-btn">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
            {t('新建请求', 'New Request')}
          </button>
        </div>
      </div>

      {/* ===== Overview Statistics — compact summary band ===== */}
      <div className="pbc-charts-section">
        <div className="pch-head">
          <h3 className="pch-title">
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="#00338D" strokeWidth="2"><path d="M21.21 15.89A10 10 0 118 2.83"/><path d="M22 12A10 10 0 0012 2v10z"/></svg>
            {t('概览统计', 'Overview Statistics')}
          </h3>
          <span className="pch-head-meta">
            {t(
              `共 ${stats.total} 项 PBC · ${stats.followUp} 项待客户跟进`,
              `${stats.total} PBC items · ${stats.followUp} awaiting client`
            )}
          </span>
        </div>

        <div className="pch-grid">
          {/* 1 — 完成率 */}
          <div className="pch-card pch-pie">
            <h4>{t('完成率', 'Completion Rate')}</h4>
            <div className="pie-chart-viz">
              <svg viewBox="0 0 100 100" className="pie-svg">
                <circle cx="50" cy="50" r="42" fill="none" stroke="#e9eef4" strokeWidth="11" />
                <circle cx="50" cy="50" r="42" fill="none" stroke="#059669" strokeWidth="11"
                  strokeDasharray={`${(chartData.completionRate * 2.639).toFixed(1)} 263.9`}
                  strokeLinecap="round" />
              </svg>
              <div className="pie-center">
                <span className="pie-percent">{chartData.completionRate}%</span>
                <span className="pie-label">{t('已接收', 'Received')}</span>
              </div>
            </div>
            <div className="pie-legend">
              <div className="pleg-item">
                <span className="pleg-dot" style={{ background: '#059669' }} />
                <span className="pleg-text">{t('已接收', 'Received')}</span>
                <span className="pleg-val">{stats.received}</span>
              </div>
              <div className="pleg-item">
                <span className="pleg-dot" style={{ background: '#e9eef4' }} />
                <span className="pleg-text">{t('未接收', 'Not Received')}</span>
                <span className="pleg-val">{stats.notReceived}</span>
              </div>
            </div>
          </div>

          {/* 2 — 接收情况：已接收（含已分类 / 未分类） / 未接收 */}
          <div className="pch-card pch-status-cards">
            <h4>{t('接收情况', 'Receipt Status')}</h4>
            <div className="psc-grid psc-grid-2">
              {/* 已接收（大类）：其下细分已分类 / 未分类 */}
              <div className="psc-item psc-received" style={{ borderTopColor: '#059669' }}
                title={t(`已接收 ${stats.received} 项：已分类 ${stats.classified} · 未分类 ${stats.unclassified}`,
                         `Received ${stats.received}: classified ${stats.classified} · unclassified ${stats.unclassified}`)}>
                <span className="psc-num" style={{ color: stats.received > 0 ? '#059669' : '#cbd5e1' }}>{stats.received}</span>
                <span className="psc-lbl">{t('已接收', 'Received')}</span>
                <span className="psc-sub">
                  <span className="psc-sub-item"><i style={{ background: '#059669' }} />{t('已分类', 'Classified')} {stats.classified}</span>
                  <span className="psc-sub-item"><i style={{ background: '#34D399' }} />{t('未分类', 'Unclassified')} {stats.unclassified}</span>
                </span>
              </div>
              {/* 未接收（大类） */}
              <div className="psc-item" style={{ borderTopColor: '#D69E2E' }}
                title={t(`未接收 ${stats.notReceived} 项`, `Not received ${stats.notReceived}`)}>
                <span className="psc-num" style={{ color: stats.notReceived > 0 ? '#D69E2E' : '#cbd5e1' }}>{stats.notReceived}</span>
                <span className="psc-lbl">{t('未接收', 'Not Received')}</span>
              </div>
            </div>
            <div className="psc-stack">
              {stats.classified > 0 && <span className="psc-seg" style={{ flexGrow: stats.classified, background: '#059669' }} />}
              {stats.unclassified > 0 && <span className="psc-seg" style={{ flexGrow: stats.unclassified, background: '#34D399' }} />}
              {stats.notReceived > 0 && <span className="psc-seg" style={{ flexGrow: stats.notReceived, background: '#D69E2E' }} />}
            </div>
            <div className="psc-foot">
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="12" cy="12" r="10"/><path d="M12 8v4"/><path d="M12 16h.01"/></svg>
              {t(`${stats.notReceived} 项未接收，待客户提供`, `${stats.notReceived} not received, awaiting client`)}
            </div>
          </div>

          {/* 3 — 类别分布：文件维度 + 已接收 / 未接收进度 */}
          <div className="pch-card pch-categories">
            <h4>{t('类别分布', 'Category Distribution')}</h4>
            <div className="pcat-grid">
              {chartData.byCategory.map(cat => (
                <div key={cat.key} className="pcat-row"
                  title={t(
                    `${cat.label}：已接收文件 ${cat.fileCount} 个；条目 已接收 ${cat.received} / 未接收 ${cat.notReceived}（共 ${cat.total}）`,
                    `${cat.label}: ${cat.fileCount} files received; ${cat.received} received / ${cat.notReceived} not received (${cat.total} items)`,
                  )}>
                  <span className="pcat-dot" style={{ background: cat.color }} />
                  <span className="pcat-name">{cat.label}</span>
                  <div className="pcat-bar-track">
                    <div className="pcat-bar-group"
                      style={{ width: `${(cat.total / chartData.maxCategoryCount) * 100}%` }}>
                      {cat.received > 0 && <span className="pcat-bar-fill received" style={{ flexGrow: cat.received }} />}
                      {cat.notReceived > 0 && <span className="pcat-bar-fill not-received" style={{ flexGrow: cat.notReceived }} />}
                    </div>
                  </div>
                  <span className="pcat-count">{cat.fileCount}</span>
                </div>
              ))}
            </div>
            <div className="pcat-foot">
              <span className="pcat-legend"><i className="received" />{t('已接收', 'Received')}</span>
              <span className="pcat-legend"><i className="not-received" />{t('未接收', 'Not Received')}</span>
              <span className="pcat-total">{t(`合计 ${chartData.totalFiles} 个文件`, `${chartData.totalFiles} files`)}</span>
            </div>
          </div>
        </div>
      </div>

      {/* ===== FILTER SECTION (from guide screenshot) ===== */}
        <div className="pbc-filter-section">
        <div className="pfs-row">
          {/* Status filter */}
          <div className="pfs-group">
            <label>{t('状态筛选', 'Status')}</label>
            <select value={filterStatus} onChange={e => setFilterStatus(e.target.value)}>
              <option value="all">{t('全部状态', 'All Statuses')}</option>
              <option value="received">{t('已接收', 'Received')} ({stats.received})</option>
              <option value="not_received">{t('未接收', 'Not Received')} ({stats.notReceived})</option>
            </select>
          </div>
          {/* Category filter */}
          <div className="pfs-group">
            <label>{t('类别筛选', 'Category')}</label>
            <select value={filterCategory} onChange={e => setFilterCategory(e.target.value)}>
              <option value="all">{t('全部类别', 'All Categories')}</option>
              {CATEGORIES.map(c => (
                <option key={c.key} value={c.key}>{isZh ? c.zh : c.en}</option>
              ))}
            </select>
          </div>
          {/* Search */}
          <div className="pfs-group pfs-search">
            <label>{t('搜索', 'Search')}</label>
            <input type="text" value={filterSearch} onChange={e => setFilterSearch(e.target.value)}
              placeholder={t('搜索描述、类别或负责人...', 'Search description, category or assignee...')} />
          </div>
          {/* Clear button */}
          <button className="pfs-clear-btn" onClick={clearFilters}>
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M3 6h18M8 6V4a2 2 0 012-2h4a2 2 0 012 2v2m3 0v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6h14z"/></svg>
            {t('清除筛选条件', 'Clear Filters')}
          </button>
        </div>
        <div className="pfs-result-hint">
          {t(`筛选结果：${filteredItems.length} 条 PBC`, `Filtered: ${filteredItems.length} PBC items`)}
          {(filterStatus !== 'all' || filterCategory !== 'all' || filterSearch.trim()) && (
            <span className="pfs-active-tags">
              {filterStatus !== 'all' && <span className="pfs-tag">{rc(filterStatus as ReceiveState).label}<button onClick={() => setFilterStatus('all')}>×</button></span>}
              {filterCategory !== 'all' && <span className="pfs-tag">{getCategoryLabel(filterCategory, isZh)}<button onClick={() => setFilterCategory('all')}>×</button></span>}
              {filterSearch.trim() && <span className="pfs-tag">"{filterSearch}"<button onClick={() => setFilterSearch('')}>×</button></span>}
            </span>
          )}
        </div>
      </div>

      {/* ===== 操作栏：导出 + File Pool 推送（精简为单一推送入口） ===== */}
      <div className="pbc-action-bar">
        <div className="pab-left">
          <button className="pab-btn pab-export" title={t('导出PBC列表为Excel', 'Export PBC list as Excel')}>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>
            {t('导出PBC列表', 'Export PBC List')}
          </button>
          <button className="pab-btn pab-export" title={t('导出文件清单', 'Export file manifest')}>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>
            {t('导出文件清单', 'Export Files')}
          </button>
        </div>
        <div className="pab-right">
          {/* File Pool 进度（纯展示，不可点击） */}
          <div className="pab-pool"
            title={t(`已推送 ${poolPushedCount} / ${poolCandidates.length} 个文件到 File Pool`,
              `${poolPushedCount} / ${poolCandidates.length} files pushed to File Pool`)}>
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><ellipse cx="12" cy="5" rx="9" ry="3"/><path d="M21 12c0 1.66-4 3-9 3s-9-1.34-9-3"/><path d="M3 5v14c0 1.66 4 3 9 3s9-1.34 9-3V5"/></svg>
            <span className="pab-pool-name">File Pool</span>
            <span className="pab-pool-count"><b>{poolPushedCount}</b>/{poolCandidates.length}</span>
          </div>
          {/* 批量编辑：仅在有选中时出现 */}
          {selectedIds.size > 0 && (
            <button className="pab-btn pab-bulk has-selection"
              title={t('批量修改所选条目的负责人 / 截止日期 / 优先级', 'Bulk edit assignee / due date / priority')}
              onClick={() => setShowBatchEdit(!showBatchEdit)}>
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M11 4H4a2 2 0 00-2 2v14a2 2 0 002 2h14a2 2 0 002-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 013 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>
              {t('批量编辑', 'Bulk Edit')}
              <span className="pab-badge">{selectedIds.size}</span>
            </button>
          )}
          {/* 推送：单一入口 —— 有选中推所选，无选中推全部 */}
          <button className="pab-btn pab-push"
            disabled={pushTargetCount === 0}
            onClick={handlePush}
            title={selectedPushableIds.length > 0
              ? t(`推送所选 ${selectedPushableIds.length} 个文件到 File Pool`, `Push ${selectedPushableIds.length} selected to File Pool`)
              : t(`推送全部 ${poolReadyCount} 个待推送文件到 File Pool`, `Push all ${poolReadyCount} pending to File Pool`)}>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/></svg>
            {selectedPushableIds.length > 0
              ? t(`推送所选 (${selectedPushableIds.length})`, `Push Selected (${selectedPushableIds.length})`)
              : t(`推送全部 (${poolReadyCount})`, `Push All (${poolReadyCount})`)}
          </button>
        </div>
      </div>

      {/* ===== BATCH EDIT PANEL (collapsible) ===== */}
      {showBatchEdit && selectedIds.size > 0 && (
        <div className="pbc-batch-edit-panel animate-fade-in">
          <div className="pbep-header">
            <strong>{t('PBC编辑配置 — 批量修改所选条目', 'PBC Edit Config — Bulk edit selected items')}</strong>
            <span>{t(`已选 ${selectedIds.size} 条`, `${selectedIds.size} selected`)}</span>
          </div>
          <div className="pbep-fields">
            <div className="pbep-field">
              <label>{t('分配负责人', 'Assign To')}</label>
              <select value={batchAssignee} onChange={e => setBatchAssignee(e.target.value)}>
                <option value="">-- {t('不更改', 'No change')} --</option>
                {TEAM_MEMBERS.map(m => <option key={m} value={m}>{m}</option>)}
              </select>
            </div>
            <div className="pbep-field">
              <label>{t('截止日期', 'Due Date')}</label>
              <input type="date" value={batchDueDate} onChange={e => setBatchDueDate(e.target.value)} />
            </div>
            <div className="pbep-field">
              <label>{t('优先级', 'Priority')}</label>
              <select value={batchPriority} onChange={e => setBatchPriority(e.target.value)}>
                <option value="">-- {t('不更改', 'No change')} --</option>
                <option value="high">{t('高', 'High')}</option>
                <option value="medium">{t('中', 'Medium')}</option>
                <option value="low">{t('低', 'Low')}</option>
              </select>
            </div>
            <div className="pbep-actions">
              <button className="pbep-apply" onClick={applyBatchEdit}>{t('应用更改', 'Apply Changes')}</button>
              <button className="pbep-cancel" onClick={() => setShowBatchEdit(false)}>{t('取消', 'Cancel')}</button>
            </div>
          </div>
        </div>
      )}

      {/* ===== VIEW: Category Cards ===== */}
      {viewMode === 'cards' && (
        <div className={`pbc-cards-grid ${expandedCategory ? 'grid-dimmed' : ''}`}>
          {Object.entries(grouped).map(([catKey, items]) => {
            const meta = categoryMetaMap[catKey] || { icon: '📄', color: '#64748b', bg: '#f8fafc', zh: catKey, en: catKey }
            const isExpanded = expandedCategory === catKey
            const dtype = categoryDataType(items)
            const catFiles = items.filter(i => i.fileName)
            const catReady = catFiles.filter(i => !isPushed(i.id))

            return (
              <div key={catKey} ref={el => { cardRefs.current[catKey] = el }}
                className={`pbc-category-card ${isExpanded ? 'card-expanded' : 'card-lift'}`}
                style={{ borderTop: `3px solid ${meta.color}` }}
                onClick={() => handleCardClick(catKey)}
              >
                <div className="pbc-card-header" style={{ background: meta.bg }}>
                  <div className="pbc-card-icon" style={{ background: meta.color }}>{meta.icon}</div>
                  <div className="pbc-card-title-wrap">
                    <h3 className="pbc-card-title">{isZh ? meta.zh : meta.en}</h3>
                    <div className="pbc-card-tags">
                      <span className="pbc-data-type-badge" style={{
                        background: dtype === 'structured' ? '#eef2ff' : dtype === 'unstructured' ? '#f3effb' : '#fffbeb',
                        color: dtype === 'structured' ? '#4f46e5' : dtype === 'unstructured' ? '#805AD5' : '#d97706',
                      }}>
                        {dtype === 'structured' ? t('结构化', 'Structured') : dtype === 'unstructured' ? t('非结构化', 'Unstructured') : t('混合', 'Mixed')}
                      </span>
                      <span className="pbc-card-count">{items.length} {t('个子类', 'sub-categories')}</span>
                    </div>
                  </div>
                  {catFiles.length > 0 && catReady.length === 0 && (
                    <span className="pbc-push-btn pbc-push-done" title={t('已全部推送到 File Pool', 'All pushed to File Pool')}>
                      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3"><polyline points="20 6 9 17 4 12"/></svg>
                      File Pool
                    </span>
                  )}
                  {catReady.length > 0 && (
                    <button className="pbc-push-btn" onClick={e => { e.stopPropagation(); pushFiles(catReady.map(i => i.id)) }}
                      title={t('将该分类文件推送到 File Pool', 'Push category files to File Pool')}>
                      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/></svg>
                      File Pool<span className="pbc-push-num">{catReady.length}</span>
                    </button>
                  )}
                  <div className="pbc-card-expand-hint">
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><polyline points="6 9 12 15 18 9"/></svg>
                  </div>
                </div>
                <div className="pbc-card-list">
                  {items.slice(0, isExpanded ? undefined : 3).map(item => (
                    <div key={item.id} className={`pbc-card-item priority-${item.priority}`}>
                      <div className="pbc-card-item-top">
                        <p className="pbc-card-desc">{resolveDesc(item.description, isZh)}</p>
                        <span className="pbc-status" style={{ background: rc(receiveOf(item.status)).bg, color: rc(receiveOf(item.status)).color }}>
                          {rc(receiveOf(item.status)).label}
                        </span>
                      </div>
                      <div className="pbc-card-item-bottom">
                        <div className="pbc-card-dates">
                          <span>{t('截止:', 'Due:')} {item.dueDate}</span>
                          <span>{item.assignee || item.requestedBy}</span>
                          {item.fileName && <span className="pbc-file-tag">📎 {item.fileName}</span>}
                        </div>
                        <div className="pbc-card-item-right">
                          {item.fileName && (isPushed(item.id)
                            ? <span className="pp-push-done pp-push-mini-tag" title={t('已推送到 File Pool', 'Pushed to File Pool')}>✓</span>
                            : <button className="pp-push-btn pp-push-xs" onClick={e => { e.stopPropagation(); pushFiles([item.id]) }}
                                title={t('推送到 File Pool', 'Push to File Pool')}>
                                <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.6"><path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/></svg>
                                {t('推送', 'Push')}
                              </button>
                          )}
                          <div className="pbc-card-priority">
                            <span className={`priority-dot priority-${item.priority}`}></span>{item.priority}
                          </div>
                        </div>
                      </div>
                    </div>
                  ))}
                  {!isExpanded && items.length > 3 && (
                    <div className="pbc-more-items">+{items.length - 3} {t('更多', 'more')}</div>
                  )}
                </div>
              </div>
            )
          })}
        </div>
      )}

      {/* ===== VIEW: List View (category filter on top, full-width table) ===== */}
      {viewMode === 'list' && (
        <div className="pbc-list-view animate-fade-in">
          {/* Category filter bar: horizontal clickable labels */}
          <div className="plv-filter-bar">
            <div className="plvf-head">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#00338D" strokeWidth="2"><path d="M22 3H2l8 9.46V19l4 2v-8.54L22 3z"/></svg>
              <span>{t('按会计科目/类别筛选', 'Filter by Account Category')}</span>
            </div>
            <div className="plvf-chips">
              <button className={`plvf-chip ${filterCategory === 'all' ? 'active' : ''}`} onClick={() => setFilterCategory('all')}>
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M3 9l9-7 9 7v11a2 2 0 01-2 2H5a2 2 0 01-2-2z"/></svg>
                <span>{t('全部分类', 'All Categories')}</span>
                <span className="plvf-num">{pbcItems.length}</span>
              </button>
              {CATEGORIES.map(cat => {
                const count = pbcItems.filter(i => i.category === cat.key).length
                if (count === 0) return null
                return (
                  <button key={cat.key} className={`plvf-chip ${filterCategory === cat.key ? 'active' : ''}`}
                    onClick={() => setFilterCategory(cat.key)}>
                    <span className="plvf-dot" style={{ background: cat.color }}></span>
                    <span>{isZh ? cat.zh : cat.en}</span>
                    <span className="plvf-num">{count}</span>
                  </button>
                )
              })}
            </div>
          </div>

          <div className="plv-split">
            {/* ===== 左：PBC 管理清单（树形） ===== */}
            <div className="plv-left">
              <div className="plv-panel-head">
                <div className="plvp-title">
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#00338D" strokeWidth="2"><path d="M3 7a2 2 0 012-2h4l2 2h8a2 2 0 012 2v9a2 2 0 01-2 2H5a2 2 0 01-2-2z"/></svg>
                  <span>{t('PBC 清单', 'PBC Checklist')}</span>
                  <span className="plvp-badge">{matchedItemCount}/{filteredItems.length} {t('已匹配', 'matched')}</span>
                </div>
                <div className="plvp-actions">
                  <div className="plvp-search-wrap">
                    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="11" cy="11" r="7"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>
                    <input className="plvp-search" value={filterSearch} onChange={e => setFilterSearch(e.target.value)}
                      placeholder={t('搜索资料类别...', 'Search checklist...')} />
                  </div>
                  <button className="plvp-sort-btn" onClick={openSorter}
                    title={t('打开文件分拣窗口，将已收到的文件匹配到清单类型', 'Open file triage to match received files to checklist types')}>
                    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.1" strokeLinecap="round" strokeLinejoin="round">
                      <path d="M3 6h18" /><path d="M6 12h12" /><path d="M10 18h4" />
                    </svg>
                    {t('文件分拣中心', 'File Triage')}
                    <span className="plvp-sort-count">{poolIds.length}</span>
                  </button>
                </div>
              </div>

              <main className="plv-main">
              <div className="plv-table-header">
                <label className="plv-select-all">
                  <input type="checkbox" checked={selectedIds.size === filteredItems.length && filteredItems.length > 0}
                    onChange={toggleSelectAll} />
                  <span>{t('全选', 'Select All')}</span>
                </label>
                <div className="plv-th-actions">
                  {hasColFilters && (
                    <button className="plv-clear-col" onClick={clearColFilters}
                      title={t('清除表头筛选', 'Clear column filters')}>
                      <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.6"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
                      {t('清除列筛选', 'Clear filters')}
                    </button>
                  )}
                  <span className="plv-table-info">
                    {t(`${filteredItems.length} 条结果`, `${filteredItems.length} results`)}
                  </span>
                </div>
              </div>
              <table className="plv-table">
                <thead>
                  <tr>
                    <th className="plv-c-check"></th>
                    <th className="plv-c-tree">
                      <div className="plv-th-cell">
                        <span className="plv-th-label">{t('PBC 清单', 'PBC Checklist')}</span>
                        <input className="plv-col-input" value={colFilters.tree}
                          onChange={e => setColFilters(f => ({ ...f, tree: e.target.value }))}
                          onClick={e => e.stopPropagation()}
                          placeholder={t('筛选', 'Filter')} />
                      </div>
                    </th>
                    <th className="plv-c-file">
                      <div className="plv-th-cell">
                        <span className="plv-th-label">{t('匹配文件', 'Matched File')}</span>
                        <select className="plv-col-select" value={colFilters.file}
                          onChange={e => setColFilters(f => ({ ...f, file: e.target.value as ColFilters['file'] }))}>
                          <option value="all">{t('全部', 'All')}</option>
                          <option value="matched">{t('已匹配', 'Matched')}</option>
                          <option value="pending">{t('待补充', 'Pending')}</option>
                        </select>
                      </div>
                    </th>
                    <th className="plv-c-assignee">
                      <div className="plv-th-cell">
                        <span className="plv-th-label">{t('负责人', 'Assignee')}</span>
                        <select className="plv-col-select" value={colFilters.assignee}
                          onChange={e => setColFilters(f => ({ ...f, assignee: e.target.value }))}>
                          <option value="all">{t('全部', 'All')}</option>
                          {colOptions.assignees.map(a => <option key={a} value={a}>{a}</option>)}
                        </select>
                      </div>
                    </th>
                    <th className="plv-c-due">
                      <div className="plv-th-cell">
                        <span className="plv-th-label">{t('截止日期', 'Due Date')}</span>
                        <select className="plv-col-select" value={colFilters.due}
                          onChange={e => setColFilters(f => ({ ...f, due: e.target.value }))}>
                          <option value="all">{t('全部', 'All')}</option>
                          {colOptions.dues.map(d => <option key={d} value={d}>{d}</option>)}
                        </select>
                      </div>
                    </th>
                    <th className="plv-c-status">
                      <div className="plv-th-cell">
                        <span className="plv-th-label">{t('状态', 'Status')}</span>
                        <select className="plv-col-select" value={colFilters.status}
                          onChange={e => setColFilters(f => ({ ...f, status: e.target.value }))}>
                          <option value="all">{t('全部', 'All')}</option>
                          <option value="received">{t('已接收', 'Received')}</option>
                          <option value="not_received">{t('未接收', 'Not Received')}</option>
                        </select>
                      </div>
                    </th>
                    <th className="plv-c-prio">
                      <div className="plv-th-cell">
                        <span className="plv-th-label">{t('优先级', 'Priority')}</span>
                        <select className="plv-col-select" value={colFilters.priority}
                          onChange={e => setColFilters(f => ({ ...f, priority: e.target.value }))}>
                          <option value="all">{t('全部', 'All')}</option>
                          <option value="high">{t('高', 'High')}</option>
                          <option value="medium">{t('中', 'Medium')}</option>
                          <option value="low">{t('低', 'Low')}</option>
                        </select>
                      </div>
                    </th>
                    <th className="plv-c-dtype">
                      <div className="plv-th-cell">
                        <span className="plv-th-label">{t('数据类型', 'Data Type')}</span>
                        <select className="plv-col-select" value={colFilters.dataType}
                          onChange={e => setColFilters(f => ({ ...f, dataType: e.target.value }))}>
                          <option value="all">{t('全部', 'All')}</option>
                          <option value="structured">{t('结构化', 'Str')}</option>
                          <option value="unstructured">{t('非结构化', 'Unstr')}</option>
                        </select>
                      </div>
                    </th>
                    <th className="plv-c-pool">
                      <div className="plv-th-cell">
                        <span className="plv-th-label">{t('File Pool', 'File Pool')}</span>
                        <select className="plv-col-select" value={colFilters.pool}
                          onChange={e => setColFilters(f => ({ ...f, pool: e.target.value as ColFilters['pool'] }))}>
                          <option value="all">{t('全部', 'All')}</option>
                          <option value="pushed">{t('已推送', 'Pushed')}</option>
                          <option value="pending">{t('待推送', 'Pending')}</option>
                        </select>
                      </div>
                    </th>
                    {/* 占位列：吸收表格富余宽度，避免其余列被撑宽 */}
                    <th className="plv-c-spacer" aria-hidden="true"></th>
                  </tr>
                </thead>
                <tbody>
                  {treeData.map(({ cat, items }) => {
                    const collapsed = collapsedCats.has(cat.key)
                    const matched = items.filter(i => effFile(i)).length
                    const catSelected = items.every(i => selectedIds.has(i.id))
                    const dtype = categoryDataType(items)
                    const dist: Record<ReceiveState, number> = { received: 0, not_received: 0 }
                    items.forEach(i => { dist[receiveOf(effStatus(i))] += 1 })
                    return (
                      <Fragment key={cat.key}>
                        {/* 大类（父级）行 */}
                        <tr className="plv-row-cat" onClick={() => toggleCat(cat.key)}>
                          <td>
                            <input type="checkbox" checked={catSelected}
                              onClick={e => e.stopPropagation()}
                              onChange={() => toggleCatSelect(items)}
                              ref={el => { if (el) el.indeterminate = !catSelected && items.some(i => selectedIds.has(i.id)) }} />
                          </td>
                          <td className="plv-c-tree">
                            <div className="plv-cat-cell">
                              <span className={`plv-cat-caret ${collapsed ? 'collapsed' : ''}`}>
                                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><polyline points="6 9 12 15 18 9" /></svg>
                              </span>
                              <span className="plv-cat-icon">{cat.icon}</span>
                              <span className="plv-cat-name">{isZh ? cat.zh : cat.en}</span>
                              <span className={`plv-cat-count ${matched === items.length ? 'full' : ''}`}>{matched}/{items.length}</span>
                            </div>
                          </td>
                          <td></td>
                          <td></td>
                          <td></td>
                          <td>
                            <span className="plv-band-stack"
                              title={t(`已接收 ${dist.received} · 未接收 ${dist.not_received}`,
                                       `Received ${dist.received} · Not received ${dist.not_received}`)}>
                              {dist.received > 0 && <i style={{ flexGrow: dist.received, background: '#059669' }} />}
                              {dist.not_received > 0 && <i style={{ flexGrow: dist.not_received, background: '#D69E2E' }} />}
                            </span>
                          </td>
                          <td></td>
                          <td>
                            <span className={`plv-dtype ${dtype}`}>
                              {dtype === 'structured' ? t('结构化', 'Str') : dtype === 'unstructured' ? t('非结构化', 'Unstr') : t('混合', 'Mixed')}
                            </span>
                          </td>
                          <td></td>
                          <td className="plv-c-spacer" aria-hidden="true"></td>
                        </tr>

                        {/* 条目（子级）行 */}
                        {!collapsed && items.map(item => {
                          const fileIds = matchedFileIds(item)
                          const fileCount = fileIds.length
                          const hasBuiltin = Boolean(item.fileName)
                          const isSel = selectedIds.has(item.id)
                          const stt = effStatus(item)
                          const file = fileCount || hasBuiltin ? effFile(item) : null
                          return (
                            <tr key={item.id}
                              className={`plv-row-item ${isSel ? 'row-selected' : ''} priority-${item.priority} ${flashId === item.id ? 'row-flash' : ''}`}
                              onClick={() => toggleSelect(item.id)}>
                              <td>
                                <input type="checkbox" checked={isSel}
                                  onChange={() => toggleSelect(item.id)}
                                  onClick={e => e.stopPropagation()} />
                              </td>
                              <td className="plv-c-tree">
                                <div className="plv-item-cell">
                                  <span className="plv-item-name" title={resolveDesc(item.description, isZh)}>
                                    {resolveDesc(item.description, isZh)}
                                  </span>
                                  <span className={`plv-tree-chip ${file ? 'match' : 'pending'}`}>
                                    {file ? '✓' : t('待补充', 'Pending')}
                                  </span>
                                </div>
                              </td>
                              <td className="plv-c-file">
                                {fileCount > 0 ? (
                                  <div className="plv-file-cell">
                                    <span
                                      className={`plv-pbc-count ${fileCount > 1 ? 'multi' : ''}`}
                                      title={`${fileCount} ${t('个文件', 'files')}：${fileIds.map(id => POOL_FILE_MAP[id]?.fileName).filter(Boolean).join(', ')}`}>
                                      <b>{fileCount}</b>
                                      <span>{t('文件', 'files')}</span>
                                    </span>
                                    <button className="plv-file-unlink"
                                      title={t('取消匹配，放回未分类文件池', 'Unmatch — return to pool')}
                                      onClick={e => { e.stopPropagation(); fileIds.forEach(id => unassignFile(id)) }}>
                                      <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4"><path d="M9 14l-4-4 4-4"/><path d="M5 10h11a4 4 0 010 8h-1"/></svg>
                                    </button>
                                  </div>
                                ) : hasBuiltin ? (
                                  <span className="plv-file-builtin" title={item.fileName}>
                                    <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>
                                    {t('自带文件', 'Attached')}
                                  </span>
                                ) : (
                                  <span className="plv-file-empty">
                                    <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
                                    {t('待补充', 'Pending')}
                                  </span>
                                )}
                              </td>
                              <td>{item.assignee || item.requestedBy}</td>
                              <td>{item.dueDate}</td>
                              <td>
                                <span className="pbc-status" style={{ background: rc(receiveOf(stt)).bg, color: rc(receiveOf(stt)).color }}>
                                  {rc(receiveOf(stt)).label}
                                </span>
                              </td>
                              <td>
                                <span className={`priority-dot priority-${item.priority}`}></span>
                                {item.priority}
                              </td>
                              <td>
                                <span className={`plv-dtype ${item.dataType}`}>
                                  {item.dataType === 'structured' ? t('结构化', 'Str') : t('非结构化', 'Unstr')}
                                </span>
                              </td>
                              <td className="plv-c-pool">
                                {!file
                                  ? <span className="plv-na">—</span>
                                  : isPushed(item.id)
                                    ? <span className="pp-push-done" title={t('已推送到 File Pool', 'Pushed to File Pool')}>
                                        <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3.2"><polyline points="20 6 9 17 4 12"/></svg>
                                        {t('已推送', 'Pushed')}
                                      </span>
                                    : <button className="pp-push-btn" onClick={e => { e.stopPropagation(); pushFiles([item.id]) }}
                                        title={t('推送到 File Pool', 'Push to File Pool')}>
                                        <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4"><path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/></svg>
                                        {t('推送', 'Push')}
                                      </button>
                                }
                              </td>
                              <td className="plv-c-spacer" aria-hidden="true"></td>
                            </tr>
                          )
                        })}
                      </Fragment>
                    )
                  })}
                  {filteredItems.length === 0 && (
                    <tr><td colSpan={10} className="plv-empty">{t('无匹配的PBC条目', 'No matching PBC items')}</td></tr>
                  )}
                </tbody>
              </table>
              </main>
            </div>

          </div>
        </div>
      )}

      {/* Expanded overlay (cards view) */}
      {expandedCategory && viewMode === 'cards' && (
        <>
          <div className="pbc-overlay-backdrop" onClick={() => setExpandedCategory(null)} />
          <div className="pbc-expanded-card-wrapper">
            {(() => {
              const items = grouped[expandedCategory] || []
              const meta = categoryMetaMap[expandedCategory] || { icon: '📄', color: '#64748b', bg: '#f8fafc', zh: expandedCategory, en: expandedCategory }
              const dtype = categoryDataType(items)
              return (
                <div className="pbc-category-card pbc-expanded-card" style={{ borderTop: `3px solid ${meta.color}` }} onClick={e => e.stopPropagation()}>
                  <div className="pbc-card-header" style={{ background: meta.bg }}>
                    <div className="pbc-card-icon" style={{ background: meta.color }}>{meta.icon}</div>
                    <div className="pbc-card-title-wrap">
                      <h3 className="pbc-card-title">{isZh ? (meta.zh || expandedCategory) : (meta.en || expandedCategory)}</h3>
                      <div className="pbc-card-tags">
                        <span className="pbc-data-type-badge" style={{
                          background: dtype === 'structured' ? '#eef2ff' : dtype === 'unstructured' ? '#f3effb' : '#fffbeb',
                          color: dtype === 'structured' ? '#4f46e5' : dtype === 'unstructured' ? '#805AD5' : '#d97706',
                        }}>
                          {dtype === 'structured' ? t('结构化', 'Structured') : dtype === 'unstructured' ? t('非结构化', 'Unstructured') : t('混合', 'Mixed')}
                        </span>
                        <span className="pbc-card-count">{items.length} {t('个子类', 'sub-categories')}</span>
                      </div>
                    </div>
                    <button className="pbc-card-close" onClick={() => setExpandedCategory(null)}>
                      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
                    </button>
                  </div>
                  <div className="pbc-card-list">
                    {items.map(item => (
                      <div key={item.id} className={`pbc-card-item priority-${item.priority}`}>
                        <div className="pbc-card-item-top">
                          <p className="pbc-card-desc">{resolveDesc(item.description, isZh)}</p>
                          <span className="pbc-status" style={{ background: rc(receiveOf(item.status)).bg, color: rc(receiveOf(item.status)).color }}>{rc(receiveOf(item.status)).label}</span>
                        </div>
                        <div className="pbc-card-item-bottom">
                          <div className="pbc-card-dates">
                            <span>{t('截止:', 'Due:')} {item.dueDate}</span>
                            <span>{item.assignee || item.requestedBy}</span>
                            {item.fileName && <span className="pbc-file-tag">📎 {item.fileName}</span>}
                          </div>
                          <div className="pbc-card-item-right">
                            {item.fileName && (isPushed(item.id)
                              ? <span className="pp-push-done pp-push-mini-tag" title={t('已推送到 File Pool', 'Pushed to File Pool')}>✓</span>
                              : <button className="pp-push-btn pp-push-xs" onClick={e => { e.stopPropagation(); pushFiles([item.id]) }}
                                  title={t('推送到 File Pool', 'Push to File Pool')}>
                                  <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.6"><path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/></svg>
                                  {t('推送', 'Push')}
                                </button>
                            )}
                            <div className="pbc-card-priority">
                              <span className={`priority-dot priority-${item.priority}`}></span>{item.priority}
                            </div>
                          </div>
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              )
            })()}
          </div>
        </>
      )}

      {/* ===== 文件分拣窗口：上传文件 · PBC 清单 · 文件预览 ===== */}
      {showSorter && (
        <div className="pbc-sorter-overlay" onMouseDown={() => setShowSorter(false)}>
          <div className="pbc-sorter" onMouseDown={e => e.stopPropagation()}>
            {/* 窗口头 */}
            <div className="psr-head">
              <div className="psr-head-left">
                <span className="psr-head-icon">
                  <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M3 7a2 2 0 012-2h4l2 2h8a2 2 0 012 2v9a2 2 0 01-2 2H5a2 2 0 01-2-2z" />
                    <path d="M8 13h8" />
                  </svg>
                </span>
                <div>
                  <h3>{t('文件分拣', 'File Triage')}</h3>
                  <p>{t('将已收到的文件匹配到 PBC 清单类型：把左侧文件拖到中间条目，或点选条目完成匹配',
                       'Match received files to PBC checklist types: drag a file onto a row, or click a row to match.')}</p>
                </div>
              </div>
              <div className="psr-head-stats">
                <span>{t(`已匹配 ${allMatchedCount}`, `${allMatchedCount} matched`)}</span>
                <span>{t(`待分拣 ${poolIds.length}`, `${poolIds.length} pending`)}</span>
              </div>
              <button className="psr-close" onClick={() => setShowSorter(false)}
                aria-label={t('关闭', 'Close')}>×</button>
            </div>

            <div className="psr-body">
              {/* 左：上传文件列表 */}
              <section className="psr-pane psr-files">
                <header className="psr-pane-head">
                  <span className="psr-pane-title">{t('上传文件列表', 'Received Files')}</span>
                  <span className="psr-pane-count">{sorterFiles.length}</span>
                </header>
                <div className="psr-filters">
                  <input className="psr-search" value={sorterFileQuery}
                    onChange={e => setSorterFileQuery(e.target.value)}
                    placeholder={t('搜索文件名...', 'Search file name...')} />
                  <div className="psr-filter-row">
                    <select value={sorterStatus} onChange={e => setSorterStatus(e.target.value as typeof sorterStatus)}>
                      <option value="all">{t('全部状态', 'All status')}</option>
                      <option value="pending">{t('待分拣', 'Pending')}</option>
                    </select>
                    <select value={sorterKind} onChange={e => setSorterKind(e.target.value as typeof sorterKind)}>
                      <option value="all">{t('全部类型', 'All types')}</option>
                      <option value="xlsx">XLSX</option>
                      <option value="pdf">PDF</option>
                      <option value="docx">DOCX</option>
                      <option value="csv">CSV</option>
                    </select>
                  </div>
                </div>
                <div className="psr-file-list">
                  {sorterFiles.map(f => (
                      <button key={f.id}
                        className={`psr-file ${sorterFileId === f.id ? 'active' : ''} ${draggingSorterFileId === f.id ? 'dragging' : ''}`}
                        draggable
                        title={t('拖拽到中间清单条目完成匹配，或点击选中后点击条目',
                                 'Drag onto a checklist row to match, or click to select then click a row')}
                        onDragStart={e => {
                          e.dataTransfer.setData('text/plain', f.id)
                          e.dataTransfer.effectAllowed = 'copyMove'
                          setDraggingSorterFileId(f.id)
                          setSorterFileId(f.id)
                        }}
                        onDragEnd={() => {
                          setDraggingSorterFileId(null)
                          setSorterDropItemId(null)
                          setSorterDropCatKey(null)
                        }}
                        onClick={() => setSorterFileId(f.id)}>
                        <span className={`psr-file-ico ${f.kind}`}>{f.kind.slice(0, 3).toUpperCase()}</span>
                        <span className="psr-file-main">
                          <span className="psr-file-name" title={f.fileName}>{f.fileName}</span>
                          <span className="psr-file-meta">{f.fileSize} · {f.source} · {f.receivedAt}</span>
                        </span>
                        <span className="psr-file-tag pending">{t('待分拣', 'Pending')}</span>
                      </button>
                    ))}
                  {sorterFiles.length === 0 && (
                    <div className="psr-empty">{t('没有符合条件的文件', 'No files match the filters')}</div>
                  )}
                </div>
              </section>

              {/* 中：PBC 清单 */}
              <section className="psr-pane psr-checklist">
                <header className="psr-pane-head">
                  <span className="psr-pane-title">{t('PBC 清单', 'PBC Checklist')}</span>
                  <span className="psr-pane-count green">{allMatchedCount}/{pbcItems.length}</span>
                </header>
                <div className="psr-filters">
                  <input className="psr-search" value={sorterCheckQuery}
                    onChange={e => setSorterCheckQuery(e.target.value)}
                    placeholder={t('搜索资料类别...', 'Search checklist...')} />
                </div>
                <div className="psr-tree">
                  {sorterTree.map(({ cat, items }) => {
                    const collapsed = sorterCollapsed.has(cat.key)
                    const matched = items.filter(i => effFile(i)).length
                    return (
                      <div key={cat.key} className="psr-cat">
                        <button className={`psr-cat-head ${collapsed ? 'collapsed' : ''} ${sorterDropCatKey === cat.key ? 'drop-target' : ''}`}
                          onClick={() => toggleSorterCat(cat.key)}
                          onDragOver={e => {
                            if (!e.dataTransfer.types.includes('text/plain')) return
                            e.preventDefault()
                            e.dataTransfer.dropEffect = 'copy'
                            setSorterDropCatKey(cur => (cur === cat.key ? cur : cat.key))
                          }}
                          onDragLeave={() => setSorterDropCatKey(cur => (cur === cat.key ? null : cur))}
                          onDrop={e => {
                            e.preventDefault()
                            const fid = e.dataTransfer.getData('text/plain') || draggingSorterFileId
                            setSorterDropCatKey(null)
                            setDraggingSorterFileId(null)
                            if (fid) dropSorterFileOnCategory(fid, items)
                          }}>
                          <span className="psr-caret">▾</span>
                          <span className="psr-cat-icon">{cat.icon}</span>
                          <span className="psr-cat-name">{isZh ? cat.zh : cat.en}</span>
                          <span className={`psr-cat-count ${matched === items.length ? 'full' : ''}`}>
                            {matched}/{items.length}
                          </span>
                        </button>
                        {!collapsed && items.map(item => {
                          const fileIds = matchedFileIds(item)
                          const fileCount = fileIds.length
                          return (
                            <button key={item.id}
                              className={`psr-item ${fileCount > 0 ? 'has-file' : ''} ${fileIds.includes(sorterFileId) ? 'is-target' : ''} ${sorterDropItemId === item.id ? 'drop-target' : ''}`}
                              onClick={() => matchSorterItem(item)}
                              onDragOver={e => {
                                if (!e.dataTransfer.types.includes('text/plain')) return
                                e.preventDefault()
                                e.dataTransfer.dropEffect = 'copy'
                                setSorterDropItemId(cur => (cur === item.id ? cur : item.id))
                                setSorterDropCatKey(null)
                              }}
                              onDragLeave={() => setSorterDropItemId(cur => (cur === item.id ? null : cur))}
                              onDrop={e => {
                                e.preventDefault()
                                const fid = e.dataTransfer.getData('text/plain') || draggingSorterFileId
                                setSorterDropItemId(null)
                                setDraggingSorterFileId(null)
                                if (fid) dropSorterFileOnItem(fid, item)
                              }}
                              title={fileCount ? t(`已匹配 ${fileCount} 个文件`, `${fileCount} files matched`) : t('点击匹配当前文件', 'Click to match selected file')}>
                              <span className="psr-item-dot" />
                              <span className="psr-item-body">
                                <span className="psr-item-name">{resolveDesc(item.description, isZh)}</span>
                                {fileCount > 0 && (
                                  <span className="psr-item-files">
                                    {fileIds.map(id => (
                                      <span key={id} className="psr-file-chip">
                                        <span className="psr-file-chip-name" title={POOL_FILE_MAP[id]?.fileName}>
                                          {POOL_FILE_MAP[id]?.fileName}
                                        </span>
                                        <span
                                          className="psr-file-chip-del"
                                          role="button"
                                          tabIndex={0}
                                          title={t('取消匹配，退回左侧列表', 'Unmatch — return to the left list')}
                                          onClick={e => { e.stopPropagation(); unassignFile(id) }}
                                          onKeyDown={e => {
                                            if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); e.stopPropagation(); unassignFile(id) }
                                          }}>×</span>
                                      </span>
                                    ))}
                                  </span>
                                )}
                              </span>
                              <span className={`psr-item-ratio ${fileCount > 0 ? 'full' : ''}`}>
                                {fileCount > 0 ? `${fileCount} 文件` : '0'}
                              </span>
                              <span className="psr-item-add">+</span>
                            </button>
                          )
                        })}
                      </div>
                    )
                  })}
                  {sorterTree.length === 0 && (
                    <div className="psr-empty">{t('没有符合条件的条目', 'No checklist items match')}</div>
                  )}
                </div>
              </section>

              {/* 右：文件内容预览 */}
              <section className="psr-pane psr-preview">
                {sorterFile ? (
                  <>
                    <header className="psr-doc-head">
                      <div className="psr-doc-title">
                        <span className={`psr-file-ico ${sorterFile.kind}`}>{sorterFile.kind.slice(0, 3).toUpperCase()}</span>
                        <span title={sorterFile.fileName}>{sorterFile.fileName}</span>
                      </div>
                      <button className="psr-kcc-btn">{t('抽取 KCC 字段', 'Extract KCC')}</button>
                    </header>
                    <div className="psr-doc-bar">
                      <span className="psr-ai-chip">
                        {t('AI 建议', 'AI hint')} · {t('所属科目', 'Category')}：
                        {sorterSuggest ? (isZh ? sorterSuggest.zh : sorterSuggest.en) : '—'}
                      </span>
                      <span className="psr-kw">
                        {t('关键词', 'Keywords')}：{sorterKeywords.join(' / ') || '—'}
                      </span>
                      <span className="psr-zoom">100%</span>
                    </div>
                    {sorterMatchedItem && (
                      <div className="psr-match-banner">
                        <span>
                          {t(`已匹配至「${resolveDesc(sorterMatchedItem.description, isZh)}」`,
                             `Matched to "${resolveDesc(sorterMatchedItem.description, isZh)}"`)}
                        </span>
                        <button onClick={() => unassignFile(sorterFile.id)}>{t('取消匹配', 'Unmatch')}</button>
                      </div>
                    )}
                    <div className="psr-doc-canvas">
                      <div className="psr-doc-paper">
                        <div className="psr-doc-page">{t('第 1 页', 'Page 1')}</div>
                        {sorterFile.preview.type === 'table' ? (
                          <table className="psr-doc-table">
                            <thead>
                              <tr>{sorterFile.preview.headers.map((h, i) => <th key={i}>{h}</th>)}</tr>
                            </thead>
                            <tbody>
                              {sorterFile.preview.rows.map((row, ri) => (
                                <tr key={ri}>{row.map((cell, ci) => <td key={ci}>{cell}</td>)}</tr>
                              ))}
                            </tbody>
                          </table>
                        ) : (
                          <div className="psr-doc-text">
                            {sorterFile.preview.lines.map((line, i) => <div key={i}>{line || '\u00A0'}</div>)}
                          </div>
                        )}
                      </div>
                    </div>
                    <div className="psr-doc-foot">
                      {t('预览为文件识别结果，如匹配有误请点击中间清单条目重新指定',
                         'Preview only — click a checklist row to re-assign.')}
                    </div>
                  </>
                ) : (
                  <div className="psr-empty big">{t('选择左侧文件以查看预览', 'Select a file to preview')}</div>
                )}
              </section>
            </div>

            <div className="psr-foot">
              <span className="psr-foot-hint">
                {t('拖拽左侧文件到中间条目即可匹配；匹配后文件从左侧移出，一个条目可接收多个文件',
                   'Drag a file onto a checklist row to match — matched files leave the left list, and a row can hold multiple files.')}
              </span>
              <button className="psr-btn-primary" onClick={() => setShowSorter(false)}>{t('完成', 'Done')}</button>
            </div>
          </div>
        </div>
      )}

      {/* 匹配结果提示 */}
      {toast && <div className="pbc-toast">{toast}</div>}
    </div>
  )
}

export default PBCManager
