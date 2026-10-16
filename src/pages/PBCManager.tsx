// PBC Management — Enhanced with filter, batch edit, list view, export, bulk ops, charts
import { useState, useRef, useEffect, useMemo, Fragment } from 'react'
import { useLanguage } from '../contexts/LanguageContext'
import { PBC_CATEGORIES, PBC_ITEM_DEFS } from '../data/pbcCatalog'
import './PBCManager.css'

// ===== Types =====
/**
 * PBC 状态（三态闭环，贴合「发出请求 → 收到 → 复核接收」的实际流程）
 *   requested  待提供    审计已发出请求，客户尚未提交资料
 *   review     待复核    客户已提交，等待 / 正在进行审计复核
 *   accepted   已接收    复核通过，可归档 / 推送 DPE
 * （复核不通过的条目会退回客户，重新进入「待提供」，故不再单列 rejected / partial）
 */
type PBCStatus = 'requested' | 'review' | 'accepted'

interface StatusDef {
  key: PBCStatus
  zh: string
  en: string
  color: string
  bg: string
  /** 是否仍需客户方动作（用于「待跟进」统计） */
  clientAction?: boolean
}

const PBC_STATUS_FLOW: StatusDef[] = [
  { key: 'requested', zh: '待提供', en: 'Requested', color: '#D69E2E', bg: '#FFFBEB', clientAction: true },
  { key: 'review',    zh: '待复核', en: 'In Review', color: '#3182CE', bg: '#EBF4FF' },
  { key: 'accepted',  zh: '已接收', en: 'Accepted',  color: '#059669', bg: '#ECFDF5' },
]

const statusDefMap = Object.fromEntries(PBC_STATUS_FLOW.map(s => [s.key, s])) as Record<PBCStatus, StatusDef>

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

/** 预览浮层所需的数据（右侧文件池 / 左侧已匹配文件 共用） */
type PreviewCardData = {
  fileName: string
  fileSize?: string
  kind: string
  /** 副标题：大小 · 来源 · 日期 */
  meta: string
  preview: PoolPreview
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

// ===== Component =====
function PBCManager() {
  const { lang } = useLanguage()
  const [viewMode, setViewMode] = useState<'cards' | 'list'>('cards')
  const [expandedCategory, setExpandedCategory] = useState<string | null>(null)

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

  // ===== 未分类文件 → PBC 清单 匹配（拖拽 / 点击）=====
  const [poolIds, setPoolIds] = useState<string[]>(() => UNCLASSIFIED_FILES.map(f => f.id))
  /** 条目 id → 从文件池匹配来的文件 id */
  const [matches, setMatches] = useState<Record<string, string>>({})
  /** 匹配成功后条目的状态覆盖（新收到文件 → 待复核） */
  const [statusOverride, setStatusOverride] = useState<Record<string, PBCStatus>>({})
  const [collapsedCats, setCollapsedCats] = useState<Set<string>>(new Set())
  const [draggingPoolId, setDraggingPoolId] = useState<string | null>(null)
  const [dragOverId, setDragOverId] = useState<string | null>(null)
  const [poolDropActive, setPoolDropActive] = useState(false)
  const [pickedPoolId, setPickedPoolId] = useState<string | null>(null)
  const [flashId, setFlashId] = useState<string | null>(null)
  const [toast, setToast] = useState<string | null>(null)
  const toastTimer = useRef<number | null>(null)

  // ===== 未分类文件「部分内容预览」=====
  const [previewFileId, setPreviewFileId] = useState<string | null>(null)
  /** 预览浮层相对右栏顶部的偏移，使浮层与所点条目对齐 */
  const [previewTop, setPreviewTop] = useState(0)
  const rightPanelRef = useRef<HTMLElement | null>(null)

  // ===== 左侧清单「已匹配文件」部分内容预览 =====
  /** 正在预览的条目 id + 浮层相对左栏的偏移（由所点眼睛按钮计算） */
  const [rowPreview, setRowPreview] = useState<{ itemId: string; top: number; left: number } | null>(null)
  const leftPanelRef = useRef<HTMLDivElement | null>(null)

  /** 打开 / 切换某文件的部分内容预览（浮层出现在该条目左侧） */
  const openFilePreview = (e: React.MouseEvent<HTMLButtonElement>, f: PoolFile) => {
    e.stopPropagation()
    if (previewFileId === f.id) { setPreviewFileId(null); return }
    const itemEl = e.currentTarget.closest('.plv-pool-item') as HTMLElement | null
    const panel = rightPanelRef.current
    if (itemEl && panel) {
      const ir = itemEl.getBoundingClientRect()
      const pr = panel.getBoundingClientRect()
      const POP_H = 300
      // 以 .plv-right 为定位基准，同时把浮层钳制在视口内（允许向上溢出到清单区域）
      const minTop = 8 - pr.top
      const maxTop = window.innerHeight - POP_H - 8 - pr.top
      setPreviewTop(Math.max(minTop, Math.min(ir.top - pr.top - 4, Math.max(minTop, maxTop))))
    } else {
      setPreviewTop(0)
    }
    setPreviewFileId(f.id)
  }

  /**
   * 打开 / 切换某条目「已匹配文件」的部分内容预览。
   * 浮层出现在该行文件列右侧，并钳制在左栏宽度内，避免压住右侧文件池。
   */
  const openRowPreview = (e: React.MouseEvent<HTMLButtonElement>, itemId: string) => {
    e.stopPropagation()
    if (rowPreview?.itemId === itemId) { setRowPreview(null); return }
    const btn = e.currentTarget
    const panel = leftPanelRef.current
    if (btn && panel) {
      const br = btn.getBoundingClientRect()
      const pr = panel.getBoundingClientRect()
      const POP_W = 348
      const POP_H = 300
      const maxLeft = pr.width - POP_W - 6
      const minTop = 8 - pr.top
      const maxTop = window.innerHeight - POP_H - 8 - pr.top
      setRowPreview({
        itemId,
        left: Math.max(6, Math.min(br.right - pr.left + 10, Math.max(6, maxLeft))),
        top: Math.max(minTop, Math.min(br.top - pr.top - 4, Math.max(minTop, maxTop))),
      })
    } else {
      setRowPreview({ itemId, left: 6, top: 0 })
    }
  }

  const pool = useMemo(() => UNCLASSIFIED_FILES.filter(f => poolIds.includes(f.id)), [poolIds])

  const showToast = (msg: string) => {
    setToast(msg)
    if (toastTimer.current) window.clearTimeout(toastTimer.current)
    toastTimer.current = window.setTimeout(() => setToast(null), 2600)
  }

  /** 条目当前生效的文件：优先「从文件池匹配」的文件，其次条目自带文件 */
  const effFile = (item: PBCItem): { name: string; size?: string; kind: string; fromPool: boolean } | null => {
    const pid = matches[item.id]
    const pf = pid ? POOL_FILE_MAP[pid] : undefined
    if (pf) return { name: pf.fileName, size: pf.fileSize, kind: pf.kind, fromPool: true }
    if (item.fileName) {
      return { name: item.fileName, size: item.fileSize, kind: (item.fileName.split('.').pop() || '').toLowerCase(), fromPool: false }
    }
    return null
  }

  const effStatus = (item: PBCItem): PBCStatus => statusOverride[item.id] || item.status

  /** 将文件池中的文件匹配到某个 PBC 条目 */
  const assignFile = (itemId: string, poolId: string) => {
    const f = POOL_FILE_MAP[poolId]
    const item = pbcItems.find(i => i.id === itemId)
    if (!f || !item) return
    const prev = matches[itemId]
    setMatches(m => ({ ...m, [itemId]: poolId }))
    setPoolIds(ids => {
      const next = new Set(ids)
      if (prev && prev !== poolId) next.add(prev) // 替换时把原文件放回池
      next.delete(poolId)
      return UNCLASSIFIED_FILES.map(p => p.id).filter(id => next.has(id))
    })
    setStatusOverride(s => ({ ...s, [itemId]: 'review' }))
    setRowPreview(null) // 文件发生变化，关闭旧的预览浮层
    setFlashId(itemId)
    window.setTimeout(() => setFlashId(cur => (cur === itemId ? null : cur)), 1100)
    showToast(t(`已将「${f.fileName}」匹配到「${resolveDesc(item.description, isZh)}」`,
                `Matched "${f.fileName}" to "${resolveDesc(item.description, isZh)}"`))
  }

  /** 取消匹配，把文件放回未分类文件池 */
  const unassignFile = (itemId: string) => {
    const pid = matches[itemId]
    if (!pid) return
    setMatches(m => { const n = { ...m }; delete n[itemId]; return n })
    setPoolIds(ids => UNCLASSIFIED_FILES.map(p => p.id).filter(id => id === pid || ids.includes(id)))
    setStatusOverride(s => { const n = { ...s }; delete n[itemId]; return n })
    setRowPreview(null) // 文件发生变化，关闭旧的预览浮层
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

  // --- Status config ---
  const sc = (key: string) => {
    const d = statusDefMap[key as PBCStatus] || PBC_STATUS_FLOW[0]
    return { label: isZh ? d.zh : d.en, color: d.color, bg: d.bg }
  }

  /**
   * 条目「已匹配文件」的预览内容：
   * 来自文件池的文件沿用其预置的部分内容；条目自带文件（演示数据）没有正文，
   * 按条目信息生成一份文件摘要，便于快速识别。
   */
  const rowFilePreview = (item: PBCItem): PreviewCardData | null => {
    const file = effFile(item)
    if (!file) return null
    const poolId = matches[item.id]
    const pf = poolId ? POOL_FILE_MAP[poolId] : undefined
    if (pf) {
      return {
        fileName: pf.fileName,
        fileSize: pf.fileSize,
        kind: pf.kind,
        meta: `${pf.fileSize} · ${pf.source} · ${pf.receivedAt}`,
        preview: pf.preview,
      }
    }
    const cat = categoryMetaMap[item.category]
    const lines = [
      `${t('文件名', 'File')}：${file.name}`,
      `${t('大小', 'Size')}：${file.size || '—'}　${t('类型', 'Type')}：${file.kind.toUpperCase()}`,
      `${t('所属条目', 'Item')}：${resolveDesc(item.description, isZh)}`,
      `${t('所属大类', 'Category')}：${cat ? (isZh ? cat.zh : cat.en) : item.category}`,
      `${t('状态', 'Status')}：${sc(effStatus(item)).label}`,
      `${t('负责人', 'Assignee')}：${item.assignee || item.requestedBy}　${t('截止', 'Due')}：${item.dueDate}`,
      '',
      t('演示环境未接入文件正文，此处展示文件识别信息。',
        'No file body in this demo — identification info only.'),
    ]
    return {
      fileName: file.name,
      fileSize: file.size,
      kind: file.kind,
      meta: `${file.size || '—'} · ${t('条目自带文件', 'Item file')}`,
      preview: {
        type: 'text',
        lines,
        note: t('文件摘要 · 原型演示', 'File summary · prototype demo'),
      },
    }
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
    if (filterStatus !== 'all') items = items.filter(i => i.status === filterStatus)
    if (filterCategory !== 'all') items = items.filter(i => i.category === filterCategory)
    if (filterSearch.trim()) {
      const q = filterSearch.toLowerCase()
      items = items.filter(i =>
        resolveDesc(i.description, isZh).toLowerCase().includes(q) ||
        getCategoryLabel(i.category, isZh).toLowerCase().includes(q) ||
        i.requestedBy.toLowerCase().includes(q)
      )
    }
    return items
  }, [filterStatus, filterCategory, filterSearch, isZh])

  // Stats
  const stats = useMemo(() => {
    const byStatus: Record<PBCStatus, number> = { requested: 0, review: 0, accepted: 0 }
    let structured = 0
    pbcItems.forEach(i => {
      byStatus[i.status] += 1
      if (i.dataType === 'structured') structured += 1
    })
    return {
      total: pbcItems.length,
      byStatus,
      /** 仍需客户方提供的条目（复核退回重提也归于此状态） */
      followUp: byStatus.requested,
      structured,
      unstructured: pbcItems.length - structured,
      /** File Pool：已获得文件、可进入推送流程的条目数 */
      inPool: poolCandidates.length,
    }
  }, [])

  // Chart data
  const chartData = useMemo(() => {
    const byCategory = CATEGORIES.map(c => ({
      key: c.key,
      label: isZh ? c.zh : c.en,
      count: pbcItems.filter(i => i.category === c.key).length,
      color: c.color,
    })).filter(c => c.count > 0)
    return {
      completionRate: Math.round((stats.byStatus.accepted / stats.total) * 100),
      byCategory,
      // 条形按最大类别归一化，否则相对总量全部偏短、无法比较
      maxCategoryCount: Math.max(1, ...byCategory.map(c => c.count)),
    }
  }, [isZh, stats])

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

  /**
   * 打开 PBC 条目对应的文件。
   * 演示环境没有真实文件存储，这里生成一份占位文档在新标签页打开，
   * 以便完整呈现「点击图标 → 打开该文件」的交互。
   */
  const openFile = (fileName: string, fileSize?: string) => {
    const html = `<!doctype html><html><head><meta charset="utf-8"><title>${fileName}</title></head>
<body style="margin:0;font-family:system-ui,-apple-system,'Segoe UI',sans-serif;color:#1e293b">
  <div style="max-width:720px;margin:64px auto;padding:0 24px">
    <div style="display:flex;align-items:center;gap:10px">
      <span style="display:inline-flex;width:34px;height:34px;align-items:center;justify-content:center;border-radius:8px;background:#eef2ff;color:#00338D;font-size:16px">&#128196;</span>
      <h1 style="font-size:17px;margin:0;word-break:break-all">${fileName}</h1>
    </div>
    <p style="color:#64748b;font-size:13px;margin:14px 0 22px">${fileSize ? fileSize + ' · ' : ''}${t('演示文件预览', 'Demo file preview')}</p>
    <div style="border:1px dashed #cbd5e1;border-radius:10px;padding:28px;text-align:center;color:#94a3b8;font-size:13px">
      ${t('此处为文件占位内容（原型演示）', 'Placeholder content (prototype demo)')}
    </div>
  </div>
</body></html>`
    const url = URL.createObjectURL(new Blob([html], { type: 'text/html' }))
    window.open(url, '_blank', 'noopener')
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
    setSelectedIds(new Set())
  }

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
      setPreviewFileId(null)
      setRowPreview(null)
    }
    window.addEventListener('keydown', handleEsc)
    return () => window.removeEventListener('keydown', handleEsc)
  }, [])

  // 点击浮层/预览按钮以外的区域、或滚动页面 → 关闭预览
  useEffect(() => {
    if (!previewFileId && !rowPreview) return
    const onDown = (e: MouseEvent) => {
      const el = e.target as HTMLElement
      if (el.closest('.plv-preview-pop') || el.closest('.plvi-preview-btn') || el.closest('.plv-file-eye')) return
      setPreviewFileId(null)
      setRowPreview(null)
    }
    const onScroll = () => { setPreviewFileId(null); setRowPreview(null) }
    document.addEventListener('mousedown', onDown)
    window.addEventListener('scroll', onScroll, true)
    return () => {
      document.removeEventListener('mousedown', onDown)
      window.removeEventListener('scroll', onScroll, true)
    }
  }, [previewFileId, rowPreview])

  /** 文件部分内容预览浮层（右侧文件池 / 左侧已匹配文件 共用） */
  const renderPreviewCard = (
    data: PreviewCardData,
    onClose: () => void,
    position?: { style?: React.CSSProperties; className?: string },
  ) => (
    <div className={`plv-preview-pop ${position?.className || ''}`} style={position?.style} role="dialog"
      aria-label={t('文件预览', 'File preview')}>
      <div className="plvp-pop-head">
        <span className={`plvi-icon ${data.kind}`}>{data.kind.slice(0, 3).toUpperCase()}</span>
        <div className="plvp-pop-title">
          <div className="plvp-pop-name" title={data.fileName}>{data.fileName}</div>
          <div className="plvp-pop-sub">{data.meta}</div>
        </div>
        <button type="button" className="plvp-pop-close"
          title={t('关闭', 'Close')} aria-label={t('关闭', 'Close')}
          onClick={onClose}>
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
        </button>
      </div>

      <div className="plvp-pop-body">
        {data.preview.type === 'table' ? (
          <table className="plvp-pop-table">
            <thead>
              <tr>{data.preview.headers.map((h, i) => <th key={i}>{h}</th>)}</tr>
            </thead>
            <tbody>
              {data.preview.rows.map((row, ri) => (
                <tr key={ri}>{row.map((cell, ci) => <td key={ci}>{cell}</td>)}</tr>
              ))}
            </tbody>
          </table>
        ) : (
          <div className="plvp-pop-text">
            {data.preview.lines.map((line, i) => <div key={i}>{line || '\u00A0'}</div>)}
          </div>
        )}
      </div>

      <div className="plvp-pop-foot">
        <span className="plvp-pop-note" title={data.preview.note}>{data.preview.note}</span>
        <button type="button" className="plvp-pop-open"
          onClick={() => openFile(data.fileName, data.fileSize)}>
          <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2"><path d="M18 13v6a2 2 0 01-2 2H5a2 2 0 01-2-2V8a2 2 0 012-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/></svg>
          {t('打开文件', 'Open')}
        </button>
      </div>
    </div>
  )

  // ======================== RENDER ========================
  return (
    <div className="pbc-manager animate-fade-in">
      {/* ===== Header ===== */}
      <div className="pbc-header-row">
        <div>
          <h1 className="pbc-title">{t('PBC 管理清单', 'PBC Management List')}</h1>
          <span className="pbc-subtitle">{t('客户文件采集 · 分类 · 处理与推送中心', 'Client document collection · categorization · processing & push center')}</span>
        </div>
        <div className="pbc-header-actions">
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
                <span className="pie-label">{t('已接收', 'Accepted')}</span>
              </div>
            </div>
            <div className="pie-legend">
              <div className="pleg-item">
                <span className="pleg-dot" style={{ background: '#059669' }} />
                <span className="pleg-text">{t('已接收', 'Accepted')}</span>
                <span className="pleg-val">{stats.byStatus.accepted}</span>
              </div>
              <div className="pleg-item">
                <span className="pleg-dot" style={{ background: '#e9eef4' }} />
                <span className="pleg-text">{t('未完成', 'Outstanding')}</span>
                <span className="pleg-val">{stats.total - stats.byStatus.accepted}</span>
              </div>
            </div>
          </div>

          {/* 2 — 状态分布 */}
          <div className="pch-card pch-status-cards">
            <h4>{t('状态分布', 'Status Distribution')}</h4>
            <div className="psc-grid">
              {PBC_STATUS_FLOW.map(s => {
                const n = stats.byStatus[s.key]
                return (
                  <div key={s.key} className="psc-item" style={{ borderTopColor: s.color }}
                    title={`${isZh ? s.zh : s.en} · ${n} (${((n / stats.total) * 100).toFixed(0)}%)`}>
                    <span className="psc-num" style={{ color: n > 0 ? s.color : '#cbd5e1' }}>{n}</span>
                    <span className="psc-lbl">{isZh ? s.zh : s.en}</span>
                  </div>
                )
              })}
            </div>
            <div className="psc-stack">
              {PBC_STATUS_FLOW.map(s => (
                stats.byStatus[s.key] > 0
                  ? <span key={s.key} className="psc-seg" style={{ flexGrow: stats.byStatus[s.key], background: s.color }} />
                  : null
              ))}
            </div>
            <div className="psc-foot">
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="12" cy="12" r="10"/><path d="M12 8v4"/><path d="M12 16h.01"/></svg>
              {t(`${stats.followUp} 项待客户提供`, `${stats.followUp} awaiting client submission`)}
            </div>
          </div>

          {/* 3 — 类别分布（紧凑多列） */}
          <div className="pch-card pch-categories">
            <h4>{t('类别分布', 'Category Distribution')}</h4>
            <div className="pcat-grid">
              {chartData.byCategory.map(cat => (
                <div key={cat.key} className="pcat-row" title={`${cat.label} · ${cat.count}`}>
                  <span className="pcat-dot" style={{ background: cat.color }} />
                  <span className="pcat-name">{cat.label}</span>
                  <div className="pcat-bar-track">
                    <div className="pcat-bar-fill"
                      style={{ width: `${(cat.count / chartData.maxCategoryCount) * 100}%`, background: cat.color }} />
                  </div>
                  <span className="pcat-count">{cat.count}</span>
                </div>
              ))}
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
              {PBC_STATUS_FLOW.map(s => (
                <option key={s.key} value={s.key}>
                  {isZh ? s.zh : s.en} ({stats.byStatus[s.key]})
                </option>
              ))}
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
              {filterStatus !== 'all' && <span className="pfs-tag">{sc(filterStatus).label}<button onClick={() => setFilterStatus('all')}>×</button></span>}
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
                        <span className="pbc-status" style={{ background: sc(item.status).bg, color: sc(item.status).color }}>
                          {sc(item.status).label}
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
        <div className={`pbc-list-view animate-fade-in ${pickedPoolId ? 'is-picking' : ''}`}>
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
            <div className="plv-left" ref={leftPanelRef}>
              {pickedPoolId && (
                <div className="plv-pick-banner">
                  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M13 2L3 14h9l-1 8 10-12h-9l1-8z"/></svg>
                  <span>{t(`已选中「${POOL_FILE_MAP[pickedPoolId]?.fileName}」：点击左侧条目完成匹配，或直接拖拽`,
                           `Selected "${POOL_FILE_MAP[pickedPoolId]?.fileName}" — click a checklist row to match`)}</span>
                  <button onClick={() => setPickedPoolId(null)}>{t('取消', 'Cancel')}</button>
                </div>
              )}

              <div className="plv-panel-head">
                <div className="plvp-title">
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#00338D" strokeWidth="2"><path d="M3 7a2 2 0 012-2h4l2 2h8a2 2 0 012 2v9a2 2 0 01-2 2H5a2 2 0 01-2-2z"/></svg>
                  <span>{t('PBC 清单', 'PBC Checklist')}</span>
                  <span className="plvp-badge">{matchedItemCount}/{filteredItems.length} {t('已匹配', 'matched')}</span>
                </div>
                <input className="plvp-search" value={filterSearch} onChange={e => setFilterSearch(e.target.value)}
                  placeholder={t('搜索资料类别...', 'Search checklist...')} />
              </div>

              <main className="plv-main">
              <div className="plv-table-header">
                <label className="plv-select-all">
                  <input type="checkbox" checked={selectedIds.size === filteredItems.length && filteredItems.length > 0}
                    onChange={toggleSelectAll} />
                  <span>{t('全选', 'Select All')}</span>
                </label>
                <span className="plv-table-info">
                  {t(`${filteredItems.length} 条结果`, `${filteredItems.length} results`)}
                </span>
              </div>
              <table className="plv-table">
                <thead>
                  <tr>
                    <th className="plv-c-check"></th>
                    <th className="plv-c-tree">{t('PBC 清单', 'PBC Checklist')}</th>
                    <th className="plv-c-file">{t('匹配文件', 'Matched File')}</th>
                    <th className="plv-c-assignee">{t('负责人', 'Assignee')}</th>
                    <th className="plv-c-due">{t('截止日期', 'Due Date')}</th>
                    <th className="plv-c-status">{t('状态', 'Status')}</th>
                    <th className="plv-c-prio">{t('优先级', 'Priority')}</th>
                    <th className="plv-c-dtype">{t('数据类型', 'Data Type')}</th>
                    <th className="plv-c-pool">{t('File Pool', 'File Pool')}</th>
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
                    const dist: Record<PBCStatus, number> = { accepted: 0, review: 0, requested: 0 }
                    items.forEach(i => { dist[effStatus(i)] += 1 })
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
                              title={t(`已接收 ${dist.accepted} · 待复核 ${dist.review} · 待提供 ${dist.requested}`,
                                       `Accepted ${dist.accepted} · In review ${dist.review} · Requested ${dist.requested}`)}>
                              {dist.accepted > 0 && <i style={{ flexGrow: dist.accepted, background: '#059669' }} />}
                              {dist.review > 0 && <i style={{ flexGrow: dist.review, background: '#3182CE' }} />}
                              {dist.requested > 0 && <i style={{ flexGrow: dist.requested, background: '#D69E2E' }} />}
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

                        {/* 条目（子级）行：可接收右侧文件池的拖拽匹配 */}
                        {!collapsed && items.map(item => {
                          const file = effFile(item)
                          const isSel = selectedIds.has(item.id)
                          const stt = effStatus(item)
                          const isDrop = dragOverId === item.id
                          return (
                            <tr key={item.id}
                              className={`plv-row-item ${isSel ? 'row-selected' : ''} priority-${item.priority} ${flashId === item.id ? 'row-flash' : ''} ${isDrop ? 'plv-drop-active' : ''}`}
                              onClick={() => {
                                if (pickedPoolId) { assignFile(item.id, pickedPoolId); setPickedPoolId(null) }
                                else toggleSelect(item.id)
                              }}
                              onDragOver={e => {
                                if (!e.dataTransfer.types.includes('text/plain')) return
                                e.preventDefault()
                                if (dragOverId !== item.id) setDragOverId(item.id)
                              }}
                              onDragLeave={() => setDragOverId(cur => (cur === item.id ? null : cur))}
                              onDrop={e => {
                                const pid = e.dataTransfer.getData('text/plain') || draggingPoolId
                                if (!pid) return
                                e.preventDefault()
                                assignFile(item.id, pid)
                                setDragOverId(null); setDraggingPoolId(null)
                              }}>
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
                                    {file ? '1/1' : t('待补充', 'Pending')}
                                  </span>
                                </div>
                              </td>
                              <td className="plv-c-file">
                                {file ? (
                                  <div className="plv-file-cell">
                                    <button
                                      className={`plv-file-eye ${rowPreview?.itemId === item.id ? 'active' : ''}`}
                                      title={`${t('预览文件内容', 'Preview file')}：${file.name}${file.size ? ` (${file.size})` : ''}`}
                                      aria-label={`${t('预览文件内容', 'Preview file')}：${file.name}`}
                                      onClick={e => openRowPreview(e, item.id)}
                                    >
                                      <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                                        <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" />
                                        <circle cx="12" cy="12" r="3" />
                                      </svg>
                                    </button>
                                    <span className="plv-file-name" title={file.name}
                                      draggable={file.fromPool}
                                      onDragStart={e => {
                                        if (!file.fromPool) return
                                        e.dataTransfer.setData('application/x-pbc-item', item.id)
                                        e.dataTransfer.effectAllowed = 'move'
                                      }}>
                                      {file.name}
                                    </span>
                                    {file.fromPool && (
                                      <button className="plv-file-unlink"
                                        title={t('取消匹配，放回未分类文件池', 'Unmatch — return to pool')}
                                        onClick={e => { e.stopPropagation(); unassignFile(item.id) }}>
                                        <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4"><path d="M9 14l-4-4 4-4"/><path d="M5 10h11a4 4 0 010 8h-1"/></svg>
                                      </button>
                                    )}
                                  </div>
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
                                <span className="pbc-status" style={{ background: sc(stt).bg, color: sc(stt).color }}>
                                  {sc(stt).label}
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

              {/* 已匹配文件预览浮层（浮于该行文件列右侧，用于快速识别文件） */}
              {rowPreview && (() => {
                const item = pbcItems.find(i => i.id === rowPreview.itemId)
                const pv = item ? rowFilePreview(item) : null
                if (!pv) return null
                return renderPreviewCard(pv, () => setRowPreview(null), {
                  className: 'plv-pop-row',
                  style: { top: rowPreview.top, left: rowPreview.left },
                })
              })()}
            </div>

            {/* ===== 右：未分类 PBC 文件池（拖拽来源） ===== */}
            <aside className="plv-right" ref={rightPanelRef}>
              <div className="plv-pool-card">
                <div className="plv-pool-head">
                  <div className="plvph-title">
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#00338D" strokeWidth="2"><path d="M22 12h-6l-2 3h-4l-2-3H2"/><path d="M5.45 5.11L2 12v6a2 2 0 002 2h16a2 2 0 002-2v-6l-3.45-6.89A2 2 0 0016.76 4H7.24a2 2 0 00-1.79 1.11z"/></svg>
                    <span>{t('未分类文件', 'Unclassified Files')}</span>
                    <span className="plvph-count">{pool.length}</span>
                  </div>
                  <div className="plvph-hint">
                    {t('项目组已收到、但尚未匹配到类型的 PBC 文件。拖拽到左侧对应类型，或点击文件再点击条目完成匹配。',
                       'Received PBC files not yet matched to a type. Drag onto a checklist row, or click a file then a row.')}
                  </div>
                </div>
                <div className={`plv-pool ${poolDropActive ? 'drop-active' : ''}`}
                  onScroll={() => setPreviewFileId(null)}
                  onDragOver={e => {
                    if (draggingPoolId) return
                    if (!e.dataTransfer.types.includes('application/x-pbc-item')) return
                    e.preventDefault()
                    if (!poolDropActive) setPoolDropActive(true)
                  }}
                  onDragLeave={() => setPoolDropActive(false)}
                  onDrop={e => {
                    e.preventDefault(); setPoolDropActive(false)
                    const itemId = e.dataTransfer.getData('application/x-pbc-item')
                    if (itemId) unassignFile(itemId)
                  }}>
                  {pool.map(f => (
                    <div key={f.id}
                      className={`plv-pool-item ${draggingPoolId === f.id ? 'dragging' : ''} ${pickedPoolId === f.id ? 'picked' : ''}`}
                      draggable
                      onDragStart={e => {
                        e.dataTransfer.setData('text/plain', f.id)
                        e.dataTransfer.effectAllowed = 'move'
                        setDraggingPoolId(f.id)
                        setPickedPoolId(null)
                        setPreviewFileId(null)
                      }}
                      onDragEnd={() => { setDraggingPoolId(null); setDragOverId(null) }}
                      onClick={() => { setPreviewFileId(null); setPickedPoolId(cur => (cur === f.id ? null : f.id)) }}>
                      <span className={`plvi-icon ${f.kind}`}>{f.kind.slice(0, 3).toUpperCase()}</span>
                      <div className="plvi-main">
                        <div className="plvi-name" title={f.fileName}>{f.fileName}</div>
                        <div className="plvi-meta">{f.fileSize} · {f.source} · {f.receivedAt}</div>
                      </div>
                      <button type="button"
                        className={`plvi-preview-btn ${previewFileId === f.id ? 'active' : ''}`}
                        title={t('预览文件内容', 'Preview file')}
                        aria-label={t('预览文件内容', 'Preview file')}
                        onClick={e => openFilePreview(e, f)}>
                        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                          <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" />
                          <circle cx="12" cy="12" r="3" />
                        </svg>
                      </button>
                    </div>
                  ))}
                  {pool.length === 0 && (
                    <div className="plv-pool-empty">
                      <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="#cbd5e1" strokeWidth="1.8"><polyline points="20 6 9 17 4 12"/></svg>
                      <div>{t('未分类文件已全部匹配', 'All unclassified files matched')}</div>
                    </div>
                  )}
                </div>
              </div>

              {/* 文件部分内容预览浮层（浮于文件条目左侧，用于快速识别文件） */}
              {previewFileId && (() => {
                const pf = POOL_FILE_MAP[previewFileId]
                if (!pf) return null
                return renderPreviewCard(
                  {
                    fileName: pf.fileName,
                    fileSize: pf.fileSize,
                    kind: pf.kind,
                    meta: `${pf.fileSize} · ${pf.source} · ${pf.receivedAt}`,
                    preview: pf.preview,
                  },
                  () => setPreviewFileId(null),
                  { style: { top: previewTop } },
                )
              })()}
            </aside>
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
                          <span className="pbc-status" style={{ background: sc(item.status).bg, color: sc(item.status).color }}>{sc(item.status).label}</span>
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

      {/* 匹配结果提示 */}
      {toast && <div className="pbc-toast">{toast}</div>}
    </div>
  )
}

export default PBCManager
