import { useEffect, useRef, useState } from 'react'
import type { ChangeEvent, DragEvent } from 'react'
import { createPortal } from 'react-dom'
import { useNavigate, useParams } from 'react-router-dom'
import {
  findProcedureItem,
  findProcedureType,
  procedureTypeIcon,
} from '../data/auditProcedures'
import { downloadSampleWorkPaperTemplate } from '../utils/sampleExcel'
import { useLanguage } from '../contexts/LanguageContext'
import type { Lang } from '../i18n/translations'
import './WorkPaperStation.css'

// ===== Data Types =====
interface WpRow {
  id: string
  name: string
  category: string
  requiredType: 'Required' | 'Highly Rec.'
  linkedKcwActivity: string
  status: 'Not Selected' | 'Selected'
}

// 与 Audit Procedure 模块的关联：指向某个程序类型下的具体程序
interface WpAuditProcedure {
  typeKey: string   // ProcedureType 的 key/id
  itemCode: string  // ProcedureItem 的 code
}

/** 抽样方法：KSP / MUS，或 N/A（不涉及抽样） */
type SamplingMethod = 'KSP' | 'MUS' | 'N/A'

const SAMPLING_METHODS: SamplingMethod[] = ['KSP', 'MUS', 'N/A']

/** KCW active screen 状态（KCW active screen Status 列）：进行中 / 待复核 / 复核完成 */
type ReviewStatus = 'In Progress' | 'Pending for review' | 'Review Completed'

/** 文档审核状态（Doc Review Status 列）：由 Actions 列的审核按钮驱动 */
type DocReviewStatus = 'Pending review' | 'Reviewed'

/** 实质性程序类型（TOD / SAP 为常规类型，Confirmation / Stocktake 为专项程序） */
type SubstWpType = 'WT' | 'TOE' | 'TOD' | 'SAP' | 'Confirmation' | 'Stocktake'

interface SubstWpRow {
  id: string
  businessProcess: string
  procedureName: string
  type: SubstWpType
  /** 关联系统：Vouching platform / OAK / KOIC / E-lease，无系统时为 N/A */
  relatedSystem: string
  samplingMethod: SamplingMethod
  /** 样本量；抽样方法为 N/A 时为 null（该列显示 N/A） */
  sampleCount: number | null
  wpTemplate: string
  workingPaper: string
  /** 已上传底稿在 cnDocs 中的完整路径（不含文件名时留空）；文件名见 workingPaper */
  workingPaperPath: string
  /** KCW active screen Status */
  reviewStatus: ReviewStatus
  /** 文档审核状态：由 Actions 列的审核按钮控制 */
  docReviewStatus: DocReviewStatus
  /**
   * 文档在「审核完成」之后是否又被修改过。
   * 审核之前的修改不记录；审核按钮点击（完成审核）时清零。
   */
  modifiedAfterReview: boolean
  uploader: string
  rmId: string
  kcwActivity: string
  preChecked: boolean
  actions: string[]
  /** 对应的 Audit Procedure（用于跳转到程序卡片 / 明细） */
  auditProcedure: WpAuditProcedure
}

/** 表体数据（不含跨模块关联与运行时状态），关联见下方 AUDIT_PROCEDURE_LINKS */
type SubstWpRowSeed = Omit<SubstWpRow, 'auditProcedure' | 'docReviewStatus' | 'modifiedAfterReview' | 'workingPaperPath'>

// KCW File type — mirrors EngagementHub's KCwFile for cross-page consistency
interface KcwFileOption {
  id: string
  name: string
  status: string
  type: string
}

// ===== Demo Data =====
const standardWpRows: WpRow[] = [
  { id: 's1', name: 'Inquiry Agenda', category: 'Risk assessment and planning', requiredType: 'Required', linkedKcwActivity: 'kcw_act_4a91cf', status: 'Not Selected' },
  { id: 's2', name: 'Going Concern - Identification of Events or Conditions - Required Work Paper', category: 'Going concern', requiredType: 'Required', linkedKcwActivity: 'kcw_act_7b23de', status: 'Not Selected' },
  { id: 's3', name: 'Independence Work Paper on Fees-related requirements', category: 'Independence', requiredType: 'Required', linkedKcwActivity: 'kcw_act_82144d', status: 'Not Selected' },
  { id: 's4', name: 'IRM specialists - Planning memorandum', category: 'Specialists & Specific Team Members', requiredType: 'Required', linkedKcwActivity: 'kcw_act_9c40b1', status: 'Not Selected' },
  { id: 's5', name: 'Actuarial criticality checklist', category: 'Risk assessment and planning', requiredType: 'Required', linkedKcwActivity: 'kcw_act_2f7e58', status: 'Not Selected' },
  { id: 's6', name: 'Centralized Services - Scope Document', category: 'Group audit', requiredType: 'Required', linkedKcwActivity: 'kcw_act_6d13a7', status: 'Not Selected' },
]

const substWpRowSeeds: SubstWpRowSeed[] = [
  // 销售与应收账款
  { id: 'r01', businessProcess: 'Sales, trade receivables', procedureName: 'Revenue throughout the period – inspect, vouch and evaluate', type: 'TOD', relatedSystem: 'Vouching platform', samplingMethod: 'KSP', sampleCount: 40, wpTemplate: 'Wp Temp', workingPaper: '', reviewStatus: 'In Progress', uploader: 'Chen (SZ/CP2)', rmId: 'RM_sp001', kcwActivity: 'kcw_act_5a0101', preChecked: false, actions: ['OA Vouching'] },
  { id: 'r02', businessProcess: 'Sales, trade receivables', procedureName: 'Trade receivables - voucher to relevant documentation', type: 'TOD', relatedSystem: 'Vouching platform', samplingMethod: 'KSP', sampleCount: 30, wpTemplate: 'Wp Temp', workingPaper: 'AR_Circ.xlsx', reviewStatus: 'Pending for review', uploader: 'Lu los (HZ/CP1)', rmId: 'RM_sp002', kcwActivity: 'kcw_act_5a0102', preChecked: true, actions: ['OA Vouching'] },
  { id: 'r03', businessProcess: 'Sales, trade receivables', procedureName: 'Sales - cut-off test', type: 'TOD', relatedSystem: 'Vouching platform', samplingMethod: 'KSP', sampleCount: 25, wpTemplate: 'Wp Temp', workingPaper: '', reviewStatus: 'In Progress', uploader: 'Hu, Freya (BJ/CP3)', rmId: 'RM_sp003', kcwActivity: 'kcw_act_5a0103', preChecked: false, actions: ['OA Vouching'] },
  { id: 'r04', businessProcess: 'Sales, trade receivables', procedureName: 'Sales - Three-way match - D&A', type: 'SAP', relatedSystem: 'OAK', samplingMethod: 'N/A', sampleCount: null, wpTemplate: 'Wp Temp', workingPaper: '', reviewStatus: 'In Progress', uploader: 'Chen (SZ/CP2)', rmId: 'RM_sp004', kcwActivity: 'kcw_act_5a0104', preChecked: false, actions: ['OAK'] },
  // 现金及现金等价物
  { id: 'r05', businessProcess: 'Cash and cash equivalents', procedureName: 'Cash and cash equivalents - bank confirmation', type: 'Confirmation', relatedSystem: 'OAK', samplingMethod: 'N/A', sampleCount: null, wpTemplate: 'Wp Temp', workingPaper: 'Bank_Conf.xlsx', reviewStatus: 'Review Completed', uploader: 'Lu los (HZ/CP1)', rmId: 'RM_sp005', kcwActivity: 'kcw_act_5a0105', preChecked: true, actions: ['OA Confirm'] },
  { id: 'r06', businessProcess: 'Cash and cash equivalents', procedureName: 'Cash and cash equivalents - bank reconciliation', type: 'SAP', relatedSystem: 'N/A', samplingMethod: 'N/A', sampleCount: null, wpTemplate: 'Wp Temp', workingPaper: '', reviewStatus: 'In Progress', uploader: 'Lu los (HZ/CP1)', rmId: 'RM_sp006', kcwActivity: 'kcw_act_5a0106', preChecked: false, actions: ['OA Review'] },
  // 存货、成本及销售成本（标准成本）
  { id: 'r07', businessProcess: 'Stock, inventory and cost of sales - standard cost', procedureName: 'Cost of goods sold - vouch', type: 'TOD', relatedSystem: 'Vouching platform', samplingMethod: 'KSP', sampleCount: 35, wpTemplate: 'Wp Temp', workingPaper: 'COS_RF.xlsx', reviewStatus: 'Pending for review', uploader: 'Hu, Freya (BJ/CP3)', rmId: 'RM_sp007', kcwActivity: 'kcw_act_5a0107', preChecked: true, actions: ['OA Vouching'] },
  { id: 'r08', businessProcess: 'Stock, inventory and cost of sales - standard cost', procedureName: 'Inventory observations', type: 'Stocktake', relatedSystem: 'KOIC', samplingMethod: 'N/A', sampleCount: null, wpTemplate: 'Wp Temp', workingPaper: 'Inv_WP.xlsx', reviewStatus: 'Review Completed', uploader: 'Chen (SZ/CP2)', rmId: 'RM_sp008', kcwActivity: 'kcw_act_5a0108', preChecked: true, actions: ['OA Site'] },
  { id: 'r09', businessProcess: 'Stock, inventory and cost of sales - standard cost', procedureName: 'Inventory fixed costs of conversion (standard cost method) - vouch and recalculate', type: 'SAP', relatedSystem: 'N/A', samplingMethod: 'N/A', sampleCount: null, wpTemplate: 'Wp Temp', workingPaper: '', reviewStatus: 'In Progress', uploader: 'Chen (SZ/CP2)', rmId: 'RM_sp009', kcwActivity: 'kcw_act_5a0109', preChecked: false, actions: ['OA Review'] },
  { id: 'r10', businessProcess: 'Stock, inventory and cost of sales - standard cost', procedureName: 'Inventory cost variance allocation (standard cost method) – recalculate', type: 'SAP', relatedSystem: 'N/A', samplingMethod: 'N/A', sampleCount: null, wpTemplate: 'Wp Temp', workingPaper: '', reviewStatus: 'In Progress', uploader: 'Hu, Freya (BJ/CP3)', rmId: 'RM_sp010', kcwActivity: 'kcw_act_5a0110', preChecked: false, actions: ['OA Review'] },
  // 物业、厂房及设备
  { id: 'r11', businessProcess: 'Property, plant and equipment', procedureName: 'PPE disposals and retirements - vouch (GOSPD05009)', type: 'TOD', relatedSystem: 'Vouching platform', samplingMethod: 'KSP', sampleCount: 20, wpTemplate: 'Wp Temp', workingPaper: '', reviewStatus: 'In Progress', uploader: 'Huang lan (SH/AQPF)', rmId: 'RM_sp011', kcwActivity: 'kcw_act_5a0111', preChecked: false, actions: ['OA Vouching'] },
  { id: 'r12', businessProcess: 'Property, plant and equipment', procedureName: 'PPE additions -vouch (SPD05001)', type: 'TOD', relatedSystem: 'Vouching platform', samplingMethod: 'KSP', sampleCount: 25, wpTemplate: 'Wp Temp', workingPaper: 'FA_Tag.xlsx', reviewStatus: 'Pending for review', uploader: 'Huang lan (SH/AQPF)', rmId: 'RM_sp012', kcwActivity: 'kcw_act_5a0112', preChecked: true, actions: ['OA Vouching'] },
  // 租赁
  { id: 'r13', businessProcess: 'Lease', procedureName: 'Rental lease reconciliation', type: 'SAP', relatedSystem: 'E-lease', samplingMethod: 'N/A', sampleCount: null, wpTemplate: 'Wp Temp', workingPaper: '', reviewStatus: 'In Progress', uploader: 'Wang (BJ/Tax)', rmId: 'RM_sp013', kcwActivity: 'kcw_act_5a0113', preChecked: false, actions: ['OA Review'] },
]

// 行 → Audit Procedure 模块的对应关系（按业务实质手工关联的 demo 映射）
const AUDIT_PROCEDURE_LINKS: Record<string, WpAuditProcedure> = {
  r01: { typeKey: 'vouching', itemCode: 'VO-001' },        // Revenue Vouching
  r02: { typeKey: 'vouching', itemCode: 'VO-001' },        // Revenue Vouching
  r03: { typeKey: 'vouching', itemCode: 'VO-001' },        // Revenue Vouching
  r04: { typeKey: 'alteryx', itemCode: 'ALY-001' },        // D&A 全量数据测试
  r05: { typeKey: 'kdc-confirm', itemCode: 'KDC-F001' },   // Bank Confirmation
  r06: { typeKey: 'kdc-cash', itemCode: 'KDC-C001' },      // Bank Reconciliation
  r07: { typeKey: 'vouching', itemCode: 'VO-003' },        // Purchase Vouching
  r08: { typeKey: 'inventory-obs', itemCode: 'IO-001' },   // Physical Inventory Observation
  r09: { typeKey: 'inventory-obs', itemCode: 'IO-003' },   // Inventory Valuation Check
  r10: { typeKey: 'inventory-obs', itemCode: 'IO-003' },   // Inventory Valuation Check
  r11: { typeKey: 'vouching', itemCode: 'VO-002' },        // Expense Vouching
  r12: { typeKey: 'vouching', itemCode: 'VO-002' },        // Expense Vouching
  r13: { typeKey: 'lease-recalc', itemCode: 'LR-001' },    // Lease Liability Recalculation
}

const DEFAULT_AUDIT_PROCEDURE: WpAuditProcedure = { typeKey: 'fsr', itemCode: 'FSR-001' }

// 文档审核状态为运行时状态（由 Actions 列的审核按钮驱动）：
// 演示初始值取「Review Completed 的底稿视为已完成文档审核」，其余为待审核。
const DEMO_MODIFIED_AFTER_REVIEW = new Set<string>(['r01'])

// ===== 已上传底稿的完整路径 =====
// 演示数据：按文件名维护其在 cnDocs 中的目录（必须在下方 substWpRows 之前声明）
const DEMO_WP_FOLDER: Record<string, string> = {
  'Indep_WP.docx': 'cnDocs/02 Fieldwork/Independence',
  'FS_Close.xlsx': 'cnDocs/02 Fieldwork/Financial Statement Close',
  'AR_Circ.xlsx': 'cnDocs/02 Fieldwork/Trade Receivables',
  'Vendor_Conf.xlsx': 'cnDocs/02 Fieldwork/Procurement',
  'Inv_WP.xlsx': 'cnDocs/02 Fieldwork/Inventory',
  'COS_RF.xlsx': 'cnDocs/02 Fieldwork/Cost of Sales',
  'FA_Tag.xlsx': 'cnDocs/02 Fieldwork/PPE',
  'Tax_Prov.xlsx': 'cnDocs/02 Fieldwork/Tax',
  'Payroll.xlsx': 'cnDocs/02 Fieldwork/Payroll',
  'Fees_WP.xlsx': 'cnDocs/02 Fieldwork/Independence',
  'Bank_Conf.xlsx': 'cnDocs/02 Fieldwork/Bank',
}

const substWpRows: SubstWpRow[] = substWpRowSeeds.map(seed => ({
  ...seed,
  workingPaperPath: buildWpPath(seed.workingPaper, DEMO_WP_FOLDER[seed.workingPaper]),
  auditProcedure: AUDIT_PROCEDURE_LINKS[seed.id] ?? DEFAULT_AUDIT_PROCEDURE,
  docReviewStatus: seed.reviewStatus === 'Review Completed' ? 'Reviewed' : 'Pending review',
  modifiedAfterReview: DEMO_MODIFIED_AFTER_REVIEW.has(seed.id),
}))

// KCW File demo data — mirrors EngagementHub's KCW File list.
const DEMO_KCW_FILES_BY_ENGAGEMENT: Record<string, KcwFileOption[]> = {
  default: [
    { id: 'KC001', name: '241231_Stat_RF_Aurora_Planning', status: 'completed', type: 'Planning' },
    { id: 'KC002', name: '241231_Stat_RF_Aurora_Risk', status: 'in-progress', type: 'Risk' },
    { id: 'KC003', name: '241231_Stat_RF_GoldenHorizon_Planning', status: 'pending', type: 'Planning' },
    { id: 'KC004', name: '241231_Stat_RF_GoldenHorizon_Fraud', status: 'not-started', type: 'Fraud' },
    { id: 'KC005', name: '241231_Stat_RF_PacificStar_Single', status: 'on-hold', type: 'Risk' },
  ],
}

/** 按 engagement + KCW File id 查找 KCW File（供 KCW File 详情页展示「已绑定文件」用） */
export function findKcwFileOption(
  engagementId: string | undefined,
  kcwId: string | undefined,
): KcwFileOption | undefined {
  if (!kcwId) return undefined
  const list = (engagementId && DEMO_KCW_FILES_BY_ENGAGEMENT[engagementId])
    ? DEMO_KCW_FILES_BY_ENGAGEMENT[engagementId]
    : DEMO_KCW_FILES_BY_ENGAGEMENT.default
  return list.find(f => f.id === kcwId)
}


function WpsToolbar({
  search,
  searchPlaceholder,
  onSearch,
  info,
}: {
  search: string
  searchPlaceholder: string
  onSearch: (v: string) => void
  /** 右侧附加信息（如已选项计数） */
  info?: string
}) {
  const inputRef = useRef<HTMLInputElement>(null)
  return (
    <div className="wps-toolbar">
      {/* 整个搜索框可点击聚焦，不只是中间那条输入区域 */}
      <div className="wps-search-box" onClick={() => inputRef.current?.focus()}>
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#94a3b8" strokeWidth="2"><circle cx="11" cy="11" r="7" /><path d="m21 21-4.3-4.3" /></svg>
        <input
          ref={inputRef}
          type="text"
          className="wps-search-input"
          placeholder={searchPlaceholder}
          aria-label={searchPlaceholder}
          value={search}
          onChange={e => onSearch(e.target.value)}
        />
        {search && (
          <button
            type="button"
            className="wps-search-clear"
            aria-label="Clear"
            onClick={e => {
              e.stopPropagation()
              onSearch('')
              inputRef.current?.focus()
            }}
          >
            ×
          </button>
        )}
      </div>
      {info ? <span className="wps-toolbar-info">{info}</span> : null}
    </div>
  )
}

// ===== 页面文案：跟随顶部 EN / 中 语言切换 =====
interface WpsCopy {
  kpiTotal: string
  kpiUploadRate: string
  kpiUploaded: string
  kpiPrecheckRate: string
  kpiPrecheckPassed: string
  kpiReviewRate: string
  kpiPassed: string
  kpiNotPassed: string
  kpiMateriality: string
  kpiPerfMateriality: string
  kpiMinThreshold: string
  pageShowing: (start: number, end: number, total: number) => string
  perPage: string
  rowUnit: string
  colWpName: string
  colCategory: string
  colReqLevel: string
  colLinkedKcw: string
  colStatus: string
  colSelect: string
  statusNotSelected: string
  statusSelected: string
  selectAllAria: string
  selectRowAria: (name: string) => string
  selectedCount: (n: number, total: number) => string
  colBusinessProcess: string
  colProcedureDesc: string
  colType: string
  colSamplingMethod: string
  colNoOfSamples: string
  colRelatedSystem: string
  colWpTemplate: string
  colWorkingPaper: string
  colUploader: string
  /** KCW active screen Status 列 */
  colKcwActivityStatus: string
  /** 文档审核状态列 */
  colDocReviewStatus: string
  /** 「审核后是否被修改」列 */
  colModifiedAfterReview: string
  colActions: string
  /** Actions 列：触发文档审核 */
  docReviewDo: string
  /** Actions 列：已完成审核（再次点击可撤销） */
  docReviewDone: string
  docReviewTitle: string
  docReviewUndoTitle: string
  docReviewAria: (name: string) => string
  /** 「审核后修改」列：未修改时的占位文案 */
  modifiedNo: string
  modifiedYes: string
  s1Note: string
  s1Search: string
  s1Empty: string
  s2Note: string
  s2Search: string
  s2Empty: string
  samplingMethodAria: (name: string) => string
  noOfSamplesAria: (name: string) => string
  upload: string
  removeWpTitle: string
  removeWpAria: (name: string) => string
  downloadTplTitle: (name: string) => string
  openProcedureTitle: (label: string, code: string, itemName: string) => string
  /** 已上传底稿：文件链接点击打开 */
  openWpTitle: (name: string) => string
  /** 上传弹窗：标题 */
  uploadModalTitle: string
  uploadApproach: string
  approachOwnDevice: string
  approachCnDocs: string
  dropHint: string
  dropHintHasFile: (name: string) => string
  cnDocsEmpty: string
  toggleFolderAria: (name: string) => string
  modalSubmit: string
  modalCancel: string
}

const WPS_COPY: Record<Lang, WpsCopy> = {
  zh: {
    kpiTotal: '实质性程序总数',
    kpiUploadRate: '底稿上传率',
    kpiUploaded: '已上传',
    kpiPrecheckRate: '底稿预检率',
    kpiPrecheckPassed: 'PreCheck 已通过',
    kpiReviewRate: '底稿复核通过率',
    kpiPassed: '已通过',
    kpiNotPassed: '未通过',
    kpiMateriality: '重要性水平',
    kpiPerfMateriality: '实际执行重要性水平',
    kpiMinThreshold: '最小阈值',
    pageShowing: (s, e, t) => `显示第 ${s} 至 ${e} 条，共 ${t} 条实质性程序记录`,
    perPage: '每页',
    rowUnit: '条',
    colWpName: '底稿名称',
    colCategory: '类别',
    colReqLevel: '必要级别',
    colLinkedKcw: '关联 KCw Activity',
    colStatus: '状态',
    colSelect: '选择',
    statusNotSelected: '未选择',
    statusSelected: '已选择',
    selectAllAria: '全选当前列表',
    selectRowAria: n => `选择底稿模板 ${n}`,
    selectedCount: (n, total) => `已选择 ${n} / ${total} 项`,
    colBusinessProcess: '业务流程',
    colProcedureDesc: '程序描述',
    colType: '类型',
    colSamplingMethod: '抽样方法',
    colNoOfSamples: '样本量',
    colRelatedSystem: '关联系统',
    colWpTemplate: '底稿模板',
    colWorkingPaper: '工作底稿',
    colUploader: '上传人',
    colKcwActivityStatus: 'KCW 活动页面状态',
    colDocReviewStatus: '文档审核状态',
    colModifiedAfterReview: '审核后是否被修改',
    colActions: '操作',
    docReviewDo: '审核',
    docReviewDone: '已审核',
    docReviewTitle: '将该文档标记为已审核',
    docReviewUndoTitle: '撤销审核，回到「待审核」',
    docReviewAria: n => `审核文档「${n}」`,
    modifiedNo: '否',
    modifiedYes: '是',
    s1Note: '系统将筛选出 Kcw Opinion Profile 中适用的审计计准则 / 工作底稿 / 实体类型/是否那个逻辑，与您管理范围的 Engagement 属性匹配则展示关联匹配。',
    s1Search: '搜索底稿名称、KCw Activity',
    s1Empty: '无匹配的底稿模板',
    s2Note: '系统解析用户上传的 RAAR Report，提取给 Engagement 下已计划的 RM 及对应的 Substantive Procedure，遍历管理链配置的实属性程序定义模板规则。',
    s2Search: '搜索 RMM ID、程序编号、科...',
    s2Empty: '无匹配的实质性程序底稿',
    samplingMethodAria: n => `选择「${n}」的抽样方法`,
    noOfSamplesAria: n => `填写「${n}」的样本量`,
    upload: '上传',
    removeWpTitle: '删除该工作底稿',
    removeWpAria: n => `删除 ${n}`,
    downloadTplTitle: n => `下载底稿模板（Excel）：${n}`,
    openProcedureTitle: (label, code, itemName) => `在 Audit Procedure 中查看「${label}」\n${code}${itemName}`,
    openWpTitle: n => `打开工作底稿：${n}`,
    uploadModalTitle: '统一文件池视图 - 上传文件',
    uploadApproach: '上传方式：',
    approachOwnDevice: '从我的设备上传文件',
    approachCnDocs: '文件已在 Engagement 的 cnDocs 中',
    dropHint: '点击或拖拽文件到此区域上传',
    dropHintHasFile: n => `已选择文件：${n}`,
    cnDocsEmpty: '该目录下暂无文件',
    toggleFolderAria: n => `展开 / 收起「${n}」`,
    modalSubmit: '提交',
    modalCancel: '取消',
  },
  en: {
    kpiTotal: 'Substantive Procedures',
    kpiUploadRate: 'WP Upload Rate',
    kpiUploaded: 'Uploaded',
    kpiPrecheckRate: 'WP Pre-check Rate',
    kpiPrecheckPassed: 'PreCheck passed',
    kpiReviewRate: 'WP Review Pass Rate',
    kpiPassed: 'Passed',
    kpiNotPassed: 'Not passed',
    kpiMateriality: 'Materiality',
    kpiPerfMateriality: 'Performance materiality',
    kpiMinThreshold: 'Minimum threshold',
    pageShowing: (s, e, t) => `Showing ${s}–${e} of ${t} substantive procedure records`,
    perPage: 'Per page',
    rowUnit: 'rows',
    colWpName: 'Work Paper Name',
    colCategory: 'Category',
    colReqLevel: 'Requirement Level',
    colLinkedKcw: 'Linked KCw Activity',
    colStatus: 'Status',
    colSelect: 'Select',
    statusNotSelected: 'Not Selected',
    statusSelected: 'Selected',
    selectAllAria: 'Select all in current list',
    selectRowAria: n => `Select work paper template ${n}`,
    selectedCount: (n, total) => `${n} of ${total} selected`,
    colBusinessProcess: 'Business Process',
    colProcedureDesc: 'Procedure Description',
    colType: 'Type',
    colSamplingMethod: 'Sampling Method',
    colNoOfSamples: 'No. of samples',
    colRelatedSystem: 'Related system',
    colWpTemplate: 'WP Template',
    colWorkingPaper: 'Working Paper',
    colUploader: 'Uploader',
    colKcwActivityStatus: 'KCW active screen Status',
    colDocReviewStatus: 'Doc Review Status',
    colModifiedAfterReview: 'Modified after review',
    colActions: 'Actions',
    docReviewDo: 'Review',
    docReviewDone: 'Reviewed',
    docReviewTitle: 'Mark this document as reviewed',
    docReviewUndoTitle: 'Revert to "Pending review"',
    docReviewAria: n => `Review document ${n}`,
    modifiedNo: 'No',
    modifiedYes: 'Yes',
    s1Note: 'The system filters the applicable auditing standards / work papers / entity types from the KCw Opinion Profile and shows the linked matches against the attributes of engagements within your management scope.',
    s1Search: 'Search work paper name, KCw Activity',
    s1Empty: 'No matching work paper templates',
    s2Note: 'The system parses the uploaded RAAR Report, extracts the planned RMs and corresponding Substantive Procedures for the engagement, and walks the template rules configured for substantive procedures in the management chain.',
    s2Search: 'Search RMM ID, procedure code...',
    s2Empty: 'No matching substantive procedure work papers',
    samplingMethodAria: n => `Sampling method for ${n}`,
    noOfSamplesAria: n => `No. of samples for ${n}`,
    upload: 'Upload',
    removeWpTitle: 'Remove this working paper',
    removeWpAria: n => `Remove ${n}`,
    downloadTplTitle: n => `Download WP template (Excel): ${n}`,
    openProcedureTitle: (label, code, itemName) => `Open in Audit Procedure — "${label}"\n${code}${itemName}`,
    openWpTitle: n => `Open work paper: ${n}`,
    uploadModalTitle: 'Unified File Pool View - Upload File',
    uploadApproach: 'Upload Approach:',
    approachOwnDevice: 'I will upload file from my own device',
    approachCnDocs: "The file is already in the engagement's cnDocs",
    dropHint: 'Click or drag file to this area to upload',
    dropHintHasFile: n => `Selected file: ${n}`,
    cnDocsEmpty: 'No file in this folder',
    toggleFolderAria: n => `Expand / collapse "${n}"`,
    modalSubmit: 'Submit',
    modalCancel: 'Cancel',
  },
}

function useCopy(): WpsCopy {
  const { lang } = useLanguage()
  return WPS_COPY[lang]
}

// 业务流程：数据按英文受控词表存储，中文界面下映射为中文名称
const BUSINESS_PROCESS_ZH: Record<string, string> = {
  'Sales, trade receivables': '销售、应收款项',
  'Cash and cash equivalents': '现金及现金等价物',
  'Stock, inventory and cost of sales - standard cost': '存货、成本及销售成本（标准成本）',
  'Property, plant and equipment': '物业、厂房及设备',
  'Lease': '租赁',
}

// KCW active screen Status 列：数值即英文状态本身，中文界面下映射为中文名称
const REVIEW_STATUS_ZH: Record<ReviewStatus, string> = {
  'In Progress': '进行中',
  'Pending for review': '待复核',
  'Review Completed': '复核完成',
}

// 文档审核状态列：同上
const DOC_REVIEW_STATUS_ZH: Record<DocReviewStatus, string> = {
  'Pending review': '待审核',
  'Reviewed': '已审核',
}

const businessProcessLabel = (v: string, lang: Lang) => (lang === 'zh' ? BUSINESS_PROCESS_ZH[v] ?? v : v)

const reviewStatusLabel = (s: ReviewStatus, lang: Lang) => (lang === 'zh' ? REVIEW_STATUS_ZH[s] : s)

const docReviewStatusLabel = (s: DocReviewStatus, lang: Lang) => (lang === 'zh' ? DOC_REVIEW_STATUS_ZH[s] : s)

/** 文档审核状态徽标配色：已审核=绿，待审核=灰 */
function docReviewClass(s: DocReviewStatus) {
  return s === 'Reviewed' ? 'done' : 'todo'
}

// 「抽样方法 / 样本量」两列：抽样方法为下拉（KSP / MUS / N/A），
// 选 N/A 时样本量不可填，该单元格直接显示 N/A
function SamplingMethodCell({ row, onChange }: { row: SubstWpRow; onChange: (method: SamplingMethod) => void }) {
  const c = useCopy()
  return (
    <select
      className="wps-sampling-select"
      value={row.samplingMethod}
      aria-label={c.samplingMethodAria(row.procedureName)}
      onChange={e => onChange(e.target.value as SamplingMethod)}
    >
      {SAMPLING_METHODS.map(m => <option key={m} value={m}>{m}</option>)}
    </select>
  )
}

function SampleCountCell({ row, onChange }: { row: SubstWpRow; onChange: (raw: string) => void }) {
  const c = useCopy()
  if (row.samplingMethod === 'N/A') return <span className="wps-na-text">N/A</span>
  return (
    <input
      type="number"
      min={1}
      className="wps-sample-count-input"
      value={row.sampleCount ?? ''}
      placeholder="—"
      aria-label={c.noOfSamplesAria(row.procedureName)}
      onChange={e => onChange(e.target.value)}
    />
  )
}

function reviewClass(s: ReviewStatus) {
  if (s === 'Review Completed') return 'done'
  if (s === 'Pending for review') return 'doing'
  return 'todo'
}

function typeClass(t: SubstWpRow['type']) {
  return `type-${t.toLowerCase()}`
}

function WpsKpiStrip({ total, uploaded, prechecked, reviewed }: { total: number; uploaded: number; prechecked: number; reviewed: number }) {
  const c = useCopy()
  const uploadRate = total ? Math.round((uploaded / total) * 100) : 0
  const precheckRate = total ? Math.round((prechecked / total) * 100) : 0
  const reviewRate = total ? Math.round((reviewed / total) * 100) : 0
  return (
    <div className="wps-kpi-strip">
      <div className="wps-kpi wps-kpi-primary">
        <div className="wps-kpi-label">{c.kpiTotal}</div>
        <div className="wps-kpi-num">{total}<span>Procedures</span></div>
      </div>
      <div className="wps-kpi">
        <div className="wps-kpi-label"><span className="wps-kpi-name">{c.kpiUploadRate}</span> <b>{uploadRate}%</b> <span className="wps-kpi-detail">{c.kpiUploaded} {uploaded}/{total}</span></div>
        <div className="wps-kpi-bar"><div className="wps-kpi-bar-fill" style={{ width: `${uploadRate}%` }} /></div>
      </div>
      <div className="wps-kpi">
        <div className="wps-kpi-label"><span className="wps-kpi-name">{c.kpiPrecheckRate}</span> <b>{precheckRate}%</b> <span className="wps-kpi-detail">{c.kpiPrecheckPassed} {prechecked}</span></div>
        <div className="wps-kpi-bar"><div className="wps-kpi-bar-fill orange" style={{ width: `${precheckRate}%` }} /></div>
      </div>
      <div className="wps-kpi">
        <div className="wps-kpi-label"><span className="wps-kpi-name">{c.kpiReviewRate}</span> <b>{reviewRate}%</b> <span className="wps-kpi-detail">{c.kpiPassed} {reviewed} · {c.kpiNotPassed} {total - reviewed}</span></div>
        <div className="wps-kpi-bar"><div className="wps-kpi-bar-fill green" style={{ width: `${reviewRate}%` }} /></div>
      </div>
      <div className="wps-kpi">
        <div className="wps-kpi-label">{c.kpiMateriality}</div>
        <div className="wps-kpi-num small">CNY 12,600,000</div>
        <div className="wps-kpi-sub">{c.kpiPerfMateriality} CNY 9,450,000<br />{c.kpiMinThreshold} CNY 630,000</div>
      </div>
    </div>
  )
}

function WpsPagination({ total, page, pageSize, onPage, onPageSize }: {
  total: number; page: number; pageSize: number; onPage: (p: number) => void; onPageSize: (s: number) => void
}) {
  const c = useCopy()
  const totalPages = Math.max(1, Math.ceil(total / pageSize))
  const start = total === 0 ? 0 : (page - 1) * pageSize + 1
  const end = Math.min(total, page * pageSize)
  return (
    <div className="wps-pagination">
      <span className="wps-page-info">{c.pageShowing(start, end, total)}</span>
      <div className="wps-page-right">
        <span>{c.perPage}</span>
        <select className="wps-page-size" value={pageSize} onChange={e => onPageSize(Number(e.target.value))}>
          <option value={15}>15 {c.rowUnit}</option>
          <option value={10}>10 {c.rowUnit}</option>
          <option value={20}>20 {c.rowUnit}</option>
        </select>
        <div className="wps-page-nav">
          <button type="button" disabled={page <= 1} onClick={() => onPage(page - 1)}>‹</button>
          <span>{page} / {totalPages}</span>
          <button type="button" disabled={page >= totalPages} onClick={() => onPage(page + 1)}>›</button>
        </div>
      </div>
    </div>
  )
}

// ===== 文件图标 =====
// Excel：绿色圆角方块 + 白色 X，贴近 Excel 真实标识
function ExcelIcon({ size = 15 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <rect x="2.5" y="2" width="19" height="20" rx="3.5" fill="#107C41" />
      <path
        d="M9 8.2h2.35l1.65 2.7 1.65-2.7H17l-2.85 3.8L17.15 16h-2.35L13.1 13.3 11.2 16H8.85l2.95-3.9z"
        fill="#fff"
      />
    </svg>
  )
}

// Word：蓝色圆角方块 + 白色 W
function WordIcon({ size = 15 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <rect x="2.5" y="2" width="19" height="20" rx="3.5" fill="#2B579A" />
      <text x="12" y="16.6" textAnchor="middle" fontSize="10.5" fontWeight="700" fill="#fff" fontFamily="'Segoe UI', Arial, sans-serif">
        W
      </text>
    </svg>
  )
}

// 其他格式：通用文档图标
function DocIcon({ size = 15 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <path d="M6 2h7.5L19 7.5V20a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2z" fill="#64748b" />
      <path d="M13.5 2 19 7.5h-4.5a1 1 0 0 1-1-1z" fill="#fff" opacity=".45" />
    </svg>
  )
}

function fileKind(name: string) {
  const ext = name.toLowerCase().split('.').pop() || ''
  if (['xlsx', 'xls', 'xlsm', 'csv'].includes(ext)) return 'excel'
  if (['docx', 'doc'].includes(ext)) return 'word'
  return 'other'
}

function FileTypeIcon({ name }: { name: string }) {
  const kind = fileKind(name)
  if (kind === 'excel') return <ExcelIcon />
  if (kind === 'word') return <WordIcon />
  return <DocIcon />
}

/**
 * 已上传底稿的「文件链接」点击行为。
 * 本演示没有真实文件存储，按文件名生成并下载一个同名占位文件，
 * 保证链接可点击且有可验证的反馈。
 */
function downloadWorkingPaper(fileName: string) {
  const blob = new Blob([`Work paper: ${fileName}\n`], { type: 'application/octet-stream' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = fileName
  document.body.appendChild(a)
  a.click()
  document.body.removeChild(a)
  URL.revokeObjectURL(url)
}

/** 拼接底稿完整路径：有目录则「目录/文件名」，否则落在 cnDocs 根下 */
function buildWpPath(fileName: string, dir?: string) {
  if (!fileName) return ''
  return dir ? `${dir}/${fileName}` : `cnDocs/${fileName}`
}

/** 取完整路径中的目录部分（含结尾斜杠），用于把路径与文件名分开排版 */
function wpDirOf(fullPath: string) {
  const i = fullPath.lastIndexOf('/')
  return i >= 0 ? fullPath.slice(0, i + 1) : ''
}

// ===== 上传弹窗：「文件已在 Engagement 的 cnDocs 中」用的演示目录树 =====
interface CnDocsNode {
  id: string
  name: string
  type: 'folder' | 'file'
  children?: CnDocsNode[]
}

const CNDOCS_TREE: CnDocsNode[] = [
  {
    id: 'd-tests', name: 'tests', type: 'folder', children: [
      { id: 'f-tests-1', name: 'Substantive_Test_Summary.xlsx', type: 'file' },
      { id: 'f-tests-2', name: 'Walkthrough_Notes.docx', type: 'file' },
    ],
  },
  {
    id: 'd-meetings', name: '03 Meetings & BOD', type: 'folder', children: [
      {
        id: 'd-minutes', name: 'Minutes', type: 'folder', children: [
          { id: 'f-minutes-1', name: 'BOD_Minutes_2024.docx', type: 'file' },
        ],
      },
      { id: 'f-meetings-1', name: 'Meeting_Agenda.docx', type: 'file' },
    ],
  },
  {
    id: 'd-kdc', name: '10 Work with KDC - PP&I', type: 'folder', children: [
      { id: 'f-kdc-1', name: 'KDC_WorkPaper.xlsx', type: 'file' },
    ],
  },
  {
    id: 'd-admin', name: '01 Administration', type: 'folder', children: [
      { id: 'f-admin-1', name: 'Engagement_Letter.pdf', type: 'file' },
      { id: 'f-admin-2', name: 'Independence_Checklist.xlsx', type: 'file' },
    ],
  },
  {
    id: 'd-pbc', name: '06 PBC', type: 'folder', children: [
      { id: 'f-pbc-1', name: 'PBC_List_Round2.xlsx', type: 'file' },
    ],
  },
  {
    id: 'd-rollforward', name: '09 Roll-forward folder', type: 'folder', children: [
      { id: 'f-rollforward-1', name: 'RF_Trial_Balance.xlsx', type: 'file' },
    ],
  },
  {
    id: 'd-presstest', name: 'PressTest', type: 'folder', children: [
      { id: 'f-presstest-1', name: 'PressTest_Result.xlsx', type: 'file' },
    ],
  },
  {
    id: 'd-stocktake', name: '08 Stocktake', type: 'folder', children: [
      { id: 'f-stocktake-1', name: 'Stocktake_Count_Sheet.xlsx', type: 'file' },
    ],
  },
  {
    id: 'd-forms', name: 'Forms', type: 'folder', children: [
      { id: 'f-forms-1', name: 'Confirmation_Form.docx', type: 'file' },
    ],
  },
  {
    id: 'd-group', name: '04 Group reporting', type: 'folder', children: [
      { id: 'f-group-1', name: 'Group_Package.xlsx', type: 'file' },
    ],
  },
]

/** 在 cnDocs 树中定位节点，返回从根到该节点的名称链（最后一项是文件名） */
function findCnDocsTrail(nodes: CnDocsNode[], id: string, trail: string[] = []): string[] | null {
  for (const node of nodes) {
    const next = [...trail, node.name]
    if (node.id === id) return next
    if (node.children) {
      const found = findCnDocsTrail(node.children, id, next)
      if (found) return found
    }
  }
  return null
}

/** cnDocs 目录树：文件夹可展开，文件可被选中作为上传来源 */
function CnDocsTree({
  nodes,
  depth = 0,
  expanded,
  selectedId,
  onToggle,
  onSelect,
  c,
}: {
  nodes: CnDocsNode[]
  depth?: number
  expanded: string[]
  selectedId: string | null
  onToggle: (id: string) => void
  onSelect: (node: CnDocsNode) => void
  c: WpsCopy
}) {
  return (
    <ul className="wps-tree" role={depth === 0 ? 'tree' : 'group'}>
      {nodes.map(node => {
        const isFolder = node.type === 'folder'
        const isOpen = expanded.includes(node.id)
        return (
          <li key={node.id} className="wps-tree-item" role="treeitem" aria-expanded={isFolder ? isOpen : undefined}>
            <div
              className={`wps-tree-row${selectedId === node.id ? ' is-selected' : ''}`}
              style={{ paddingLeft: 6 + depth * 16 }}
            >
              {isFolder ? (
                <button
                  type="button"
                  className="wps-tree-toggle"
                  title={c.toggleFolderAria(node.name)}
                  aria-label={c.toggleFolderAria(node.name)}
                  onClick={() => onToggle(node.id)}
                >
                  <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" aria-hidden="true">
                    <path d="M9 18V6l9 6z" transform={isOpen ? 'rotate(90 12 12)' : undefined} />
                  </svg>
                </button>
              ) : (
                <span className="wps-tree-toggle is-placeholder" aria-hidden="true" />
              )}

              {isFolder ? (
                <button
                  type="button"
                  className="wps-tree-label is-folder"
                  onClick={() => onToggle(node.id)}
                >
                  <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                    <path d="M3 7a2 2 0 0 1 2-2h3.6l1.7 2H19a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
                  </svg>
                  <span>{node.name}</span>
                </button>
              ) : (
                <button
                  type="button"
                  className="wps-tree-label is-file"
                  onClick={() => onSelect(node)}
                >
                  <span className="wps-file-icon"><FileTypeIcon name={node.name} /></span>
                  <span>{node.name}</span>
                </button>
              )}
            </div>

            {isFolder && isOpen && node.children && node.children.length > 0 && (
              <CnDocsTree
                nodes={node.children}
                depth={depth + 1}
                expanded={expanded}
                selectedId={selectedId}
                onToggle={onToggle}
                onSelect={onSelect}
                c={c}
              />
            )}
          </li>
        )
      })}
    </ul>
  )
}

// ===== 「审计程序」列 =====
// 展示该行关联的 Audit Procedure 程序类型（短名 + 程序编号），点击跳转到程序明细
function AuditProcedureCell({ row, onOpen }: { row: SubstWpRow; onOpen: (row: SubstWpRow) => void }) {
  const c = useCopy()
  const type = findProcedureType(row.auditProcedure.typeKey)
  if (!type) return <span className="wps-proc-empty">{row.relatedSystem}</span>
  // 无关联系统：只展示 N/A，不提供跳转
  if (row.relatedSystem === 'N/A') return <span className="wps-proc-empty">N/A</span>

  const item = findProcedureItem(type, row.auditProcedure.itemCode)
  const code = item?.code ?? row.auditProcedure.itemCode
  return (
    <button
      type="button"
      className="wps-proc-link"
      title={c.openProcedureTitle(type.label, code, item ? ` ${item.name}` : '')}
      onClick={() => onOpen(row)}
    >
      <span className="wps-proc-icon" style={{ background: `${type.color}1A`, color: type.color }}>
        {procedureTypeIcon(type, 12)}
      </span>
      <span className="wps-proc-label">{row.relatedSystem}</span>
      <svg className="wps-proc-go" width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <path d="M7 17 17 7" />
        <path d="M9 7h8v8" />
      </svg>
    </button>
  )
}

/**
 * Work Paper Station 主体（KPI + Standard / Substantive 两个 Section）。
 * 抽成独立组件，供 Engagement 层页面与 KCW File 层的 Work Paper Station 子模块共用，
 * 保证两处界面始终一致。
 *
 * - `showKpi`：是否展示顶部统计卡片。KCW File 页面上无需重复展示，置为 false。
 * - `showKcwSelector`：是否展示「Select the KCw file」下拉。KCW File 页面天然绑定当前 KCW File，置为 false。
 */
export function WorkPaperStationView({
  showKpi = true,
  showKcwSelector = true,
}: {
  showKpi?: boolean
  showKcwSelector?: boolean
} = {}) {
  const { clientId, engagementId } = useParams<{ clientId: string; engagementId: string }>()
  const navigate = useNavigate()
  const { lang } = useLanguage()
  const c = useCopy()

  const kcwFileList: KcwFileOption[] = (engagementId && DEMO_KCW_FILES_BY_ENGAGEMENT[engagementId])
    ? DEMO_KCW_FILES_BY_ENGAGEMENT[engagementId]
    : DEMO_KCW_FILES_BY_ENGAGEMENT.default

  const [selectedKcw, setSelectedKcw] = useState(kcwFileList[0]?.id || '')

  // 第 2 节表格数据：工作底稿的上传 / 删除都维护在本地状态里
  const [s2Data, setS2Data] = useState<SubstWpRow[]>(substWpRows)
  const fileInputRef = useRef<HTMLInputElement>(null)

  // 上传弹窗（Working Paper 列的 Upload）：open 时记录目标行，Submit 时才写回表格
  const [uploadRowId, setUploadRowId] = useState<string | null>(null)
  /** '' 表示尚未选择上传方式（此时不展示下方面板，Submit 置灰） */
  const [uploadApproach, setUploadApproach] = useState<'' | 'device' | 'cndocs'>('')
  /** 待提交的文件名：来自本机选择或 cnDocs 选中 */
  const [uploadFileName, setUploadFileName] = useState('')
  /** 待提交文件的完整路径（写入 workingPaperPath） */
  const [uploadPath, setUploadPath] = useState('')
  const [dragActive, setDragActive] = useState(false)
  const [expandedFolders, setExpandedFolders] = useState<string[]>([])
  const [pickedCnDocId, setPickedCnDocId] = useState<string | null>(null)
  const uploadModalOpen = uploadRowId !== null

  // KPI inputs (derived from substantive procedure rows)
  const wpTotal = s2Data.length
  const wpUploaded = s2Data.filter(r => r.workingPaper).length
  const wpPrechecked = s2Data.filter(r => r.preChecked).length
  const wpReviewed = s2Data.filter(r => r.reviewStatus === 'Review Completed').length

  // Section 1 (Standard WP Templates) search + selection state
  const [s1Search, setS1Search] = useState('')
  const [s1SelectedIds, setS1SelectedIds] = useState<string[]>(
    () => standardWpRows.filter(r => r.status === 'Selected').map(r => r.id),
  )
  const s1AllCheckRef = useRef<HTMLInputElement>(null)

  // Section 2 (Substantive Procedure WP) search + pagination state
  const [s2Search, setS2Search] = useState('')
  const [s2Page, setS2Page] = useState(1)
  const [s2PageSize, setS2PageSize] = useState(15)

  // 抽样方法：切换为 N/A 时样本量一并置空（该列展示 N/A）
  const handleSamplingMethodChange = (rowId: string, method: SamplingMethod) => {
    setS2Data(rows => rows.map(r => (r.id === rowId
      ? { ...r, samplingMethod: method, sampleCount: method === 'N/A' ? null : r.sampleCount }
      : r)))
  }

  // 样本量：允许留空，留空时按 null 存（展示占位符）
  const handleSampleCountChange = (rowId: string, raw: string) => {
    const value = raw.trim() === '' ? null : Math.max(0, Number(raw))
    setS2Data(rows => rows.map(r => (r.id === rowId ? { ...r, sampleCount: value } : r)))
  }

  /**
   * 文档审核：由 Actions 列的审核按钮驱动。
   * 审核完成的那一刻视为「未被再次修改」，因此把审核后修改标记清零；
   * 撤销审核后同样清零（审核之前的修改不记录）。
   */
  const handleToggleDocReview = (rowId: string) => {
    setS2Data(rows => rows.map(r => (r.id === rowId
      ? {
          ...r,
          docReviewStatus: r.docReviewStatus === 'Reviewed' ? 'Pending review' : 'Reviewed',
          modifiedAfterReview: false,
        }
      : r)))
  }

  // 底稿模版：点击即生成并下载一份样例 Excel
  const handleDownloadTemplate = (row: SubstWpRow) => {
    downloadSampleWorkPaperTemplate({
      templateName: row.wpTemplate,
      procedureName: row.procedureName,
      rmId: row.rmId,
      kcwActivity: row.kcwActivity,
      procedureType: row.type,
      businessProcess: row.businessProcess,
    })
  }

  // ===== 工作底稿上传弹窗 =====

  /** 打开上传弹窗：每次都重置为「未选择上传方式、无文件」的初始态 */
  const openUploadModal = (rowId: string) => {
    setUploadRowId(rowId)
    setUploadApproach('')
    setUploadFileName('')
    setUploadPath('')
    setDragActive(false)
    setExpandedFolders([])
    setPickedCnDocId(null)
  }

  const closeUploadModal = () => {
    setUploadRowId(null)
    setDragActive(false)
  }

  /** 选择上传方式：切换时清掉上一种方式选中的文件 */
  const handleApproachChange = (approach: 'device' | 'cndocs') => {
    setUploadApproach(approach)
    setUploadFileName('')
    setUploadPath('')
    setPickedCnDocId(null)
  }

  // 方式一：本机上传。点击拖拽区打开系统文件选择框，选中后先回填文件名，点 Submit 才写回表格
  const handlePickLocalFile = () => fileInputRef.current?.click()

  const acceptLocalFile = (file: File | undefined) => {
    if (!file) return
    setUploadFileName(file.name)
    // 本机文件上传后统一落到 engagement 的 cnDocs 根目录下
    setUploadPath(buildWpPath(file.name))
  }

  const handleWorkingPaperSelected = (e: ChangeEvent<HTMLInputElement>) => {
    acceptLocalFile(e.target.files?.[0])
    e.target.value = '' // 允许重复选择同一个文件
  }

  const handleDrop = (e: DragEvent<HTMLDivElement>) => {
    e.preventDefault()
    setDragActive(false)
    acceptLocalFile(e.dataTransfer.files?.[0])
  }

  // 方式二：从 cnDocs 目录树中选一个文件
  const toggleFolder = (id: string) =>
    setExpandedFolders(ids => (ids.includes(id) ? ids.filter(x => x !== id) : [...ids, id]))

  const handleSelectCnDoc = (node: CnDocsNode) => {
    setPickedCnDocId(node.id)
    setUploadFileName(node.name)
    // 完整路径 = cnDocs + 目录链路（链路末项即文件名）
    const trail = findCnDocsTrail(CNDOCS_TREE, node.id) ?? [node.name]
    setUploadPath(`cnDocs/${trail.join('/')}`)
  }

  const handleSubmitUpload = () => {
    if (!uploadRowId || !uploadFileName.trim()) return
    const rowId = uploadRowId
    const fileName = uploadFileName.trim()
    const fullPath = uploadPath.trim() || buildWpPath(fileName)
    // 文档若已审核，则上传新版本视为「审核后被修改」；审核之前的修改不记录
    setS2Data(rows => rows.map(r => (r.id === rowId
      ? {
          ...r,
          workingPaper: fileName,
          workingPaperPath: fullPath,
          modifiedAfterReview: r.modifiedAfterReview || r.docReviewStatus === 'Reviewed',
        }
      : r)))
    closeUploadModal()
  }

  // Esc 关闭上传弹窗
  useEffect(() => {
    if (!uploadModalOpen) return
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') closeUploadModal() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [uploadModalOpen])

  // 工作底稿：删除已上传的文件（已审核后删除同样算「审核后被修改」）
  const handleRemoveWorkingPaper = (rowId: string) => {
    setS2Data(rows => rows.map(r => (r.id === rowId
      ? {
          ...r,
          workingPaper: '',
          workingPaperPath: '',
          modifiedAfterReview: r.modifiedAfterReview || r.docReviewStatus === 'Reviewed',
        }
      : r)))
  }

  // 审计程序：跳转到 Audit Procedure 模块，直接打开对应程序类型的明细并高亮该程序
  const handleOpenProcedure = (row: SubstWpRow) => {
    const { typeKey, itemCode } = row.auditProcedure
    const query = new URLSearchParams({ type: typeKey, item: itemCode })
    navigate(`/engagement/${clientId}/${engagementId}/procedures?${query.toString()}`)
  }

  // Reset page when search/pagesize changes
  useEffect(() => { setS2Page(1) }, [s2Search, s2PageSize])

  // Section 1 filtered by search
  const s1Filtered = standardWpRows.filter(r => {
    const q = s1Search.trim().toLowerCase()
    return !q || r.name.toLowerCase().includes(q) || r.linkedKcwActivity.toLowerCase().includes(q) || r.category.toLowerCase().includes(q)
  })

  // Section 1 selection：勾选后 Status 列同步为「已选择 / 未选择」
  const isS1Selected = (id: string) => s1SelectedIds.includes(id)
  const toggleS1Row = (id: string) =>
    setS1SelectedIds(ids => (ids.includes(id) ? ids.filter(x => x !== id) : [...ids, id]))
  const s1VisibleIds = s1Filtered.map(r => r.id)
  const s1AllVisibleSelected = s1VisibleIds.length > 0 && s1VisibleIds.every(id => isS1Selected(id))
  const s1SomeVisibleSelected = s1VisibleIds.some(id => isS1Selected(id))
  const toggleS1All = () =>
    setS1SelectedIds(ids =>
      s1AllVisibleSelected
        ? ids.filter(id => !s1VisibleIds.includes(id))
        : Array.from(new Set([...ids, ...s1VisibleIds])),
    )

  // 表头全选框的「半选」态
  useEffect(() => {
    if (s1AllCheckRef.current) {
      s1AllCheckRef.current.indeterminate = !s1AllVisibleSelected && s1SomeVisibleSelected
    }
  }, [s1AllVisibleSelected, s1SomeVisibleSelected])

  // Section 2 filtered by search
  const s2Filtered = s2Data.filter(r => {
    const q = s2Search.trim().toLowerCase()
    return !q ||
      r.businessProcess.toLowerCase().includes(q) ||
      r.procedureName.toLowerCase().includes(q) ||
      r.relatedSystem.toLowerCase().includes(q) ||
      r.rmId.toLowerCase().includes(q) ||
      r.kcwActivity.toLowerCase().includes(q)
  })
  const s2PageCount = Math.max(1, Math.ceil(s2Filtered.length / s2PageSize))
  const s2SafePage = Math.min(s2Page, s2PageCount)
  const s2Rows = s2Filtered.slice((s2SafePage - 1) * s2PageSize, s2SafePage * s2PageSize)

  return (
    <div className="wps-view">
      {/* KPI Strip —— KCW File 页面下不展示 */}
      {showKpi && (
        <WpsKpiStrip total={wpTotal} uploaded={wpUploaded} prechecked={wpPrechecked} reviewed={wpReviewed} />
      )}

      {/* ============ Section 1: Standard Work Paper Templates ============ */}
      <div className="wps-section">
        <div className="wps-section-header">
          <h2 className="wps-section-title">
            <span className="wps-section-num">1</span> Standard Work Paper Templates
          </h2>
        </div>

        {/* Select KCW file row — dynamically populated from current Engagement's KCW Files.
            在 KCW File 页面下，工作底稿已天然关联当前 KCW File，无需再次选择，故整行隐藏。 */}
        {showKcwSelector && (
          <div className="wps-kcw-select-row">
            <label>*Select the KCw file:</label>
            <select className="wps-kcw-dropdown" value={selectedKcw} onChange={e => setSelectedKcw(e.target.value)}>
              {kcwFileList.map(kf => (
                <option key={kf.id} value={kf.id}>{kf.name}</option>
              ))}
            </select>
            {(() => {
              const current = kcwFileList.find(k => k.id === selectedKcw)
              return current ? (
                <span className="wps-opinion-link">
                  Type: <strong>{current.type}</strong> &middot; Status: <span className={`status-dot ${current.status === 'completed' ? 'selected' : 'not-selected'}`}></span> {current.status}
                </span>
              ) : null
            })()}
          </div>
        )}

        <div className="wps-info-note">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#2563eb" strokeWidth="2"><circle cx="12" cy="12" r="10" /><path d="M12 16v-4" /><path d="M12 8h.01" /></svg>
          {c.s1Note}
        </div>

        <WpsToolbar
          search={s1Search}
          searchPlaceholder={c.s1Search}
          onSearch={setS1Search}
          info={c.selectedCount(s1SelectedIds.length, standardWpRows.length)}
        />

        <div className="wps-table-wrap">
          <table className="wps-table wps-table-sm">
            <thead>
              <tr>
                <th className="wps-col-select">
                  <input
                    ref={s1AllCheckRef}
                    type="checkbox"
                    className="wps-check"
                    aria-label={c.selectAllAria}
                    checked={s1AllVisibleSelected}
                    onChange={toggleS1All}
                  />
                  <span className="wps-col-select-label">{c.colSelect}</span>
                </th>
                <th>{c.colWpName}</th>
                <th>{c.colCategory}</th>
                <th>{c.colReqLevel}</th>
                <th>{c.colLinkedKcw}</th>
                <th>{c.colStatus}</th>
              </tr>
            </thead>
            <tbody>
              {s1Filtered.map(row => {
                const selected = isS1Selected(row.id)
                return (
                  <tr key={row.id} className={selected ? 'is-selected' : undefined}>
                    <td className="wps-col-select">
                      <input
                        type="checkbox"
                        className="wps-check"
                        aria-label={c.selectRowAria(row.name)}
                        checked={selected}
                        onChange={() => toggleS1Row(row.id)}
                      />
                    </td>
                    <td className="wp-name-cell">{row.name}</td>
                    <td>{row.category}</td>
                    <td><span className={`req-badge ${row.requiredType === 'Required' ? 'required' : 'highly-rec'}`}>{row.requiredType}</span></td>
                    <td>{row.linkedKcwActivity}</td>
                    <td>
                      <span className={`status-dot ${selected ? 'selected' : 'not-selected'}`}></span>
                      {selected ? c.statusSelected : c.statusNotSelected}
                    </td>
                  </tr>
                )
              })}
              {s1Filtered.length === 0 && (
                <tr><td colSpan={6} className="wps-empty-cell">{c.s1Empty}</td></tr>
              )}
            </tbody>
          </table>
        </div>
      </div>

      {/* ============ Section 2: Substantive Procedure Work Paper ============ */}
      <div className="wps-section">
        <div className="wps-section-header">
          <h2 className="wps-section-title">
            <span className="wps-section-num">2</span> Substantive Procedure Work Paper
          </h2>
        </div>

        <div className="wps-info-note">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#2563eb" strokeWidth="2"><circle cx="12" cy="12" r="10" /><path d="M12 16v-4" /><path d="M12 8h.01" /></svg>
          {c.s2Note}
        </div>

        <div className="wps-section-body">
          <WpsToolbar
              search={s2Search}
              searchPlaceholder={c.s2Search}
              onSearch={setS2Search}
            />

            <div className="wps-table-wrap">
              <table className="wps-table subst-table">
                <thead>
                  <tr>
                    <th>{c.colBusinessProcess}</th>
                    <th>{c.colProcedureDesc}</th>
                    <th>{c.colType}</th>
                    <th>{c.colSamplingMethod}</th>
                    <th>{c.colNoOfSamples}</th>
                    <th>{c.colRelatedSystem}</th>
                    <th>{c.colWpTemplate}</th>
                    <th>{c.colWorkingPaper}</th>
                    <th>{c.colUploader}</th>
                    <th>{c.colKcwActivityStatus}</th>
                    <th>{c.colDocReviewStatus}</th>
                    <th>{c.colModifiedAfterReview}</th>
                    <th>{c.colActions}</th>
                  </tr>
                </thead>
                <tbody>
                  {s2Rows.map(row => (
                    <tr key={row.id}>
                      <td>{businessProcessLabel(row.businessProcess, lang)}</td>
                      <td className="wp-name-cell">{row.procedureName}</td>
                      <td><span className={`type-badge ${typeClass(row.type)}`}>{row.type}</span></td>
                      <td>
                        <SamplingMethodCell row={row} onChange={m => handleSamplingMethodChange(row.id, m)} />
                      </td>
                      <td className="wps-num">
                        <SampleCountCell row={row} onChange={raw => handleSampleCountChange(row.id, raw)} />
                      </td>
                      <td>
                        <AuditProcedureCell row={row} onOpen={handleOpenProcedure} />
                      </td>
                      <td>
                        {/* 底稿模版：一个可点击的下载链接，点击生成样例 Excel */}
                        <button
                          type="button"
                          className="wps-tpl-link"
                          title={c.downloadTplTitle(row.wpTemplate)}
                          onClick={() => handleDownloadTemplate(row)}
                        >
                          <span className="wps-tpl-icon"><ExcelIcon /></span>
                          <span className="wps-tpl-name">{row.wpTemplate}</span>
                          <svg className="wps-tpl-dl" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                            <path d="M12 3v11" />
                            <path d="m7.5 10 4.5 4.5 4.5-4.5" />
                            <path d="M4 20h16" />
                          </svg>
                        </button>
                      </td>
                      <td>
                        {row.workingPaper ? (
                          <span className="wps-file-link" data-kind={fileKind(row.workingPaper)}>
                            {/* 已上传：展示完整路径（目录弱化 + 文件名链接），点击打开底稿 */}
                            <button
                              type="button"
                              className="wps-file-open"
                              title={row.workingPaperPath || c.openWpTitle(row.workingPaper)}
                              onClick={() => downloadWorkingPaper(row.workingPaper)}
                            >
                              <span className="wps-file-icon"><FileTypeIcon name={row.workingPaper} /></span>
                              {row.workingPaperPath && (
                                <span className="wps-file-dir">{wpDirOf(row.workingPaperPath)}</span>
                              )}
                              <span className="wps-file-name">{row.workingPaper}</span>
                            </button>
                            <button
                              type="button"
                              className="wps-file-del"
                              title={c.removeWpTitle}
                              aria-label={c.removeWpAria(row.workingPaper)}
                              onClick={() => handleRemoveWorkingPaper(row.id)}
                            >
                              <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" aria-hidden="true">
                                <path d="M5 5l14 14M19 5 5 19" />
                              </svg>
                            </button>
                          </span>
                        ) : (
                          <button type="button" className="wps-mini-upload" onClick={() => openUploadModal(row.id)}>{c.upload}</button>
                        )}
                      </td>
                      <td className="wps-uploader">{row.uploader}</td>
                      {/* KCW active screen Status */}
                      <td><span className={`review-badge ${reviewClass(row.reviewStatus)}`}>{reviewStatusLabel(row.reviewStatus, lang)}</span></td>
                      {/* Doc Review Status —— 由 Actions 列的审核按钮驱动 */}
                      <td>
                        <span className={`review-badge ${docReviewClass(row.docReviewStatus)}`}>
                          {docReviewStatusLabel(row.docReviewStatus, lang)}
                        </span>
                      </td>
                      {/* 文档审核完成后是否又被修改：仅用 YES / NO + 图标表达 */}
                      <td>
                        {row.modifiedAfterReview ? (
                          <span className="wps-modified-badge" title={`${c.colModifiedAfterReview}: ${c.modifiedYes}`}>
                            <svg className="wps-mod-ico" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"><path d="M12 9v4" /><path d="M12 17h.01" /><path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" /></svg>
                            {c.modifiedYes}
                          </span>
                        ) : (
                          <span className="wps-modified-none" title={`${c.colModifiedAfterReview}: ${c.modifiedNo}`}>
                            <svg className="wps-mod-ico" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round"><path d="M20 6 9 17l-5-5" /></svg>
                            {c.modifiedNo}
                          </span>
                        )}
                      </td>
                      <td>
                        <button
                          type="button"
                          className={`wps-doc-review-btn ${row.docReviewStatus === 'Reviewed' ? 'is-reviewed' : ''}`}
                          title={row.docReviewStatus === 'Reviewed' ? c.docReviewUndoTitle : c.docReviewTitle}
                          aria-label={c.docReviewAria(row.procedureName)}
                          onClick={() => handleToggleDocReview(row.id)}
                        >
                          {row.docReviewStatus === 'Reviewed' ? (
                            <svg className="wps-dr-ico" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round"><path d="M20 6 9 17l-5-5" /></svg>
                          ) : null}
                          {row.docReviewStatus === 'Reviewed' ? c.docReviewDone : c.docReviewDo}
                        </button>
                      </td>
                    </tr>
                  ))}
                  {s2Rows.length === 0 && (
                    <tr><td colSpan={13} className="wps-empty-cell">{c.s2Empty}</td></tr>
                  )}
                </tbody>
              </table>
            </div>

            <WpsPagination
              total={s2Filtered.length}
              page={s2SafePage}
              pageSize={s2PageSize}
              onPage={setS2Page}
              onPageSize={s => { setS2PageSize(s); setS2Page(1) }}
            />
        </div>
      </div>

      {/* ===== 上传弹窗：Unified File Pool View - Upload File =====
          用 Portal 挂到 body，避免祖先元素的 transform / overflow 影响遮罩定位 */}
      {uploadModalOpen && createPortal(
        <div className="wps-modal-overlay" onClick={closeUploadModal}>
          <div
            className="wps-modal-dialog"
            role="dialog"
            aria-modal="true"
            aria-label={c.uploadModalTitle}
            onClick={e => e.stopPropagation()}
          >
            <div className="wps-modal-header">
              <h3>{c.uploadModalTitle}</h3>
              <button type="button" className="wps-modal-close" aria-label={c.modalCancel} onClick={closeUploadModal}>
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
                  <path d="M5 5l14 14M19 5 5 19" />
                </svg>
              </button>
            </div>

            <div className="wps-modal-body">
              {/* 第一步：选择上传方式（未选择时不展示下方面板，Submit 置灰） */}
              <div className="wps-approach">
                <span className="wps-approach-label">{c.uploadApproach}</span>
                <div className="wps-radio-group">
                  <label className="wps-radio">
                    <input
                      type="radio"
                      name="wps-upload-approach"
                      checked={uploadApproach === 'device'}
                      onChange={() => handleApproachChange('device')}
                    />
                    <span>{c.approachOwnDevice}</span>
                  </label>
                  <label className="wps-radio">
                    <input
                      type="radio"
                      name="wps-upload-approach"
                      checked={uploadApproach === 'cndocs'}
                      onChange={() => handleApproachChange('cndocs')}
                    />
                    <span>{c.approachCnDocs}</span>
                  </label>
                </div>
              </div>

              {/* 方式一：本机上传 —— 点击或拖拽到该区域 */}
              {uploadApproach === 'device' && (
                <div
                  className={`wps-dropzone${dragActive ? ' is-drag' : ''}`}
                  role="button"
                  tabIndex={0}
                  onClick={handlePickLocalFile}
                  onKeyDown={e => {
                    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); handlePickLocalFile() }
                  }}
                  onDragOver={e => { e.preventDefault(); setDragActive(true) }}
                  onDragLeave={() => setDragActive(false)}
                  onDrop={handleDrop}
                >
                  <svg className="wps-dropzone-icon" width="38" height="38" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                    <path d="M3 8a2 2 0 0 1 2-2h3.6l1.7 2H19a2 2 0 0 1 2 2v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
                    <path d="M12 17v-5" />
                    <path d="m9.6 14.4 2.4-2.4 2.4 2.4" />
                  </svg>
                  <p className="wps-dropzone-text">
                    {uploadFileName ? c.dropHintHasFile(uploadFileName) : c.dropHint}
                  </p>
                </div>
              )}

              {/* 方式二：文件已在 cnDocs 中 —— 从目录树里选一个文件 */}
              {uploadApproach === 'cndocs' && (
                <div className="wps-cndocs">
                  {CNDOCS_TREE.length === 0 ? (
                    <p className="wps-cndocs-empty">{c.cnDocsEmpty}</p>
                  ) : (
                    <CnDocsTree
                      nodes={CNDOCS_TREE}
                      expanded={expandedFolders}
                      selectedId={pickedCnDocId}
                      onToggle={toggleFolder}
                      onSelect={handleSelectCnDoc}
                      c={c}
                    />
                  )}
                </div>
              )}
            </div>

            <div className="wps-modal-footer">
              <button
                type="button"
                className="wps-btn wps-btn-primary"
                disabled={!uploadFileName.trim()}
                onClick={handleSubmitUpload}
              >
                {c.modalSubmit}
              </button>
              <button type="button" className="wps-btn" onClick={closeUploadModal}>{c.modalCancel}</button>
            </div>
          </div>
        </div>,
        document.body,
      )}

      {/* 工作底稿上传用的隐藏 input，所有行共用 */}
      <input
        ref={fileInputRef}
        type="file"
        className="wps-file-input"
        accept=".xlsx,.xls,.xlsm,.csv,.docx,.doc,.pdf"
        onChange={handleWorkingPaperSelected}
      />
    </div>
  )
}

/** Engagement 层的 Work Paper Station 页面：标题 + 共用主体 */
function WorkPaperStation() {
  return (
    <div className="wps-page animate-fade-in">
      {/* Title Row */}
      <div className="wps-title-row">
        <h1 className="wps-title">Work Paper Station</h1>
      </div>

      <WorkPaperStationView />
    </div>
  )
}

export default WorkPaperStation
