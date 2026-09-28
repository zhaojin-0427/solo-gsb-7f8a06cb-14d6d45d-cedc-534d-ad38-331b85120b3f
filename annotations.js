// annotations.js
// 注释印刷风险核查核心逻辑（裁切与出血盒核验页的“注释印刷风险区”）。
//
// 规则：
//   - 逐页读取页面叶子字典自身的 /Annots（注释不继承），支持直接或间接数组；
//     数组元素支持直接或间接的注释字典；无 /Annots（或为空数组）的页标为“无注释”；
//   - 每条注释读取 /Subtype（名称）、/Rect（四个有限数且正面积）、
//     /F（非负整数标志位，缺省 0）与 /AP/N 正常外观：
//       · /AP/N 为流时直接采用；为字典时须由注释的 /AS 选中一个有效流；
//       · 缺少 /AP 或 /AP/N 记为“外观缺失”，结构或引用损坏记为“外观损坏”；
//   - 以继承的 CropBox（缺省取 MediaBox）为可见页框：有效矩形与页框
//     无正面积交集的注释标为“页外”（页框本身无效时跳过页外判定）；
//   - 标志位：Hidden（位 2）覆盖 Print（位 3）——隐藏注释不显示也不打印；
//     NoView（位 6）只排除屏显，不取消 Print；
//   - 判定：设 Print 且外观有效为“打印候选”；设 Print 但外观缺失或损坏为
//     “待确认”；屏显候选（未设 Hidden/NoView）而未设 Print 为“漏印风险”；
//   - 坏引用或非法字段（注释不是字典、Subtype/Rect/F 非法等）标为“无法判断”，
//     单条失败不中断同页其他注释；
//   - 只核查 PDF 注释对象的属性，不模拟渲染（不重生成外观、不绘制页面）。
//
// 内部链接目标核对（/Link 注释）：
//   - 逐页筛出 /Subtype=/Link 的注释，检查其 /Dest 或 /A（/S=/GoTo）的 /D：
//     两者并存记为“无法判断”，均未设置（含 /GoTo 缺 /D）记为“失效（未设目标）”；
//   - 目标数组只核对首项是否为本文件页面的间接引用：成功显示从 1 起的页序，
//     不核对缩放参数；首项坏引用/非引用记为“无法判断”，引用有效但不是本文件
//     页面记为“失效（目标页不存在）”；
//   - 目标为名称对象时查 Catalog/Dests 字典；为字符串（PDFString/PDFHexString）
//     时查 Catalog/Names/Dests 名称树：遍历 /Kids、/Names，按解码原文匹配；
//     名称目标值支持数组或 /D 为数组的字典；
//   - 名称树坏引用、循环引用、重名或非法类型记为“无法判断”，并继续处理其他
//     分支与其他链接；完整查找后仍缺名（或目标页不存在）记为“失效”；
//     名称树存在坏分支且未命中时记为“无法判断”，命中唯一名称时不受他处坏分支影响；
//   - /A 的 /S 不是 /GoTo（如 /URI、/GoToR）标为“范围外”，不访问网络、
//     不追踪外部动作。
//
// 解析使用 pdf-lib 底层对象模型（PDFDict / PDFArray / PDFStream / PDFRef）。

import {
  PDFDocument,
  PDFArray,
  PDFDict,
  PDFHexString,
  PDFName,
  PDFNumber,
  PDFRef,
  PDFStream,
  PDFString,
} from 'pdf-lib';

export class AnnotationError extends Error {
  constructor(message) {
    super(message);
    this.name = 'AnnotationError';
  }
}

export const PT_PER_MM = 72 / 25.4;
// 浮点容差（pt）：交集需有正面积才算页内
export const EPS_PT = 1e-6;

// 注释标志位（/F，PDF 32000-1 表 165）
export const FLAG_BITS = [
  [1, 'Invisible'],
  [2, 'Hidden'],
  [4, 'Print'],
  [8, 'NoZoom'],
  [16, 'NoRotate'],
  [32, 'NoView'],
  [64, 'ReadOnly'],
  [128, 'Locked'],
  [256, 'ToggleNoView'],
  [512, 'LockedContents'],
];
const FLAG_HIDDEN = 2;
const FLAG_PRINT = 4;
const FLAG_NOVIEW = 32;

// 单条注释的判定状态
export const ANNOT_STATUS = {
  printCandidate: 'print-candidate', // 打印候选（设 Print 且外观有效）
  missedPrintRisk: 'missed-print-risk', // 漏印风险（屏显候选但未设 Print）
  needsConfirmation: 'needs-confirmation', // 待确认（设 Print 但外观缺失/损坏）
  offPage: 'off-page', // 页外（与可见页框无交集）
  unknown: 'unknown', // 无法判断（坏引用或非法字段）
  ok: 'ok', // 正常（有意不打印：Hidden/NoView 且未设 Print）
};

// 页面级状态优先级（取最高）：unknown > 漏印风险 > 待确认 > 页外 > ok/none
export const PAGE_STATUS = {
  none: 'none', // 无注释
  ok: 'ok',
  offPage: 'off-page',
  needsConfirmation: 'needs-confirmation',
  missedPrintRisk: 'missed-print-risk',
  unknown: 'unknown',
};

export const SCOPE_NOTE =
  '本区仅核查 PDF 注释对象的属性（/Subtype、/Rect、/F 标志位与 /AP 外观流），' +
  '不模拟渲染、不重生成外观、不绘制页面。';

// ---- 内部链接目标核对 ----

// 单条内部链接（/Link 注释）的核对状态
export const LINK_STATUS = {
  ok: 'ok', // 有效：目标指向本文件页面
  broken: 'broken', // 失效：未设目标、完整查找后仍缺名或目标页不存在
  unknown: 'unknown', // 无法判断：坏引用、循环、重名、非法类型或 /Dest 与 /A 并存
  outOfScope: 'out-of-scope', // 范围外：非 /GoTo 动作（不访问网络）
};

export const LINK_SCOPE_NOTE =
  '本区仅核对 /Link 注释的内部目标（/Dest，或 /A 动作字典中 /S=/GoTo 的 /D）' +
  '是否指向本文件页面：目标数组只核对首项的页面引用（页序从 1 起），不核对缩放参数；' +
  '名称对象查 Catalog/Dests，字符串查 Catalog/Names/Dests 名称树；' +
  '其他动作类型（如 /URI、/GoToR）属范围外，不访问网络、不追踪外部动作。';

/** @typedef {{x:number,y:number,x2:number,y2:number,width:number,height:number}} Rect */

/** 数组规整为矩形 {x,y,x2,y2,width,height}（pt）；非法返回 null。 */
function toRect(nums) {
  if (!Array.isArray(nums) || nums.length !== 4) return null;
  if (!nums.every((n) => typeof n === 'number' && Number.isFinite(n))) return null;
  const [x1, y1, x2, y2] = nums;
  const width = x2 - x1;
  const height = y2 - y1;
  if (!(width > 0) || !(height > 0)) return null;
  return { x: x1, y: y1, x2, y2, width, height };
}

/** 两个轴对齐矩形的交集；无正面积交集返回 null。 */
function intersectRects(a, b) {
  const x1 = Math.max(a.x, b.x);
  const y1 = Math.max(a.y, b.y);
  const x2 = Math.min(a.x2, b.x2);
  const y2 = Math.min(a.y2, b.y2);
  if (!(x2 - x1 > EPS_PT) || !(y2 - y1 > EPS_PT)) return null;
  return { x: x1, y: y1, x2, y2, width: x2 - x1, height: y2 - y1 };
}

/** 解析可能为间接引用的值；引用损坏或解析异常时返回 undefined。 */
function resolve(context, value) {
  try {
    return context.lookup(value);
  } catch {
    return undefined;
  }
}

function nameText(pdfName) {
  try {
    return pdfName.decodeText();
  } catch {
    return String(pdfName);
  }
}

function ptToMm(n) {
  return n / PT_PER_MM;
}
function round1(n) {
  return Math.round(n * 10) / 10;
}

/** 对外输出用：矩形 pt → 毫米（原点与宽高，保留 1 位小数）。 */
function rectMmOut(rect) {
  if (!rect) return null;
  return {
    x: round1(ptToMm(rect.x)),
    y: round1(ptToMm(rect.y)),
    width: round1(ptToMm(rect.width)),
    height: round1(ptToMm(rect.height)),
  };
}

/**
 * 读取可见页框：继承的 CropBox，缺省取 MediaBox（均为默认用户空间矩形）。
 * @returns {{frame:Rect|null, note:string|null}}
 */
function visibleFrame(context, node) {
  let media = null;
  try {
    media = toRect(readArrayNumbers(context, node.MediaBox()));
  } catch {
    media = null; // 整棵树缺失 MediaBox 或类型错误
  }
  if (!media) {
    return {
      frame: null,
      note: '继承的 MediaBox 缺失或无效，可见页框无法确定，页外判定跳过。',
    };
  }

  let cropDeclared = false;
  try {
    cropDeclared =
      node.getInheritableAttribute(PDFName.of('CropBox')) !== undefined;
  } catch {
    cropDeclared = true;
  }
  let crop = null;
  try {
    crop = toRect(readArrayNumbers(context, node.CropBox()));
  } catch {
    crop = null;
  }
  if (cropDeclared && !crop) {
    return {
      frame: null,
      note: '继承的 CropBox 已声明但无效，可见页框无法确定，页外判定跳过。',
    };
  }
  return { frame: crop ?? media, note: null };
}

/** 读取 PDFArray 的 4 个数字（元素可间接引用）；非法返回 null。 */
function readArrayNumbers(context, array) {
  if (!array || typeof array.size !== 'function' || array.size() !== 4) {
    return null;
  }
  const nums = [];
  for (let i = 0; i < 4; i++) {
    const numObj = resolve(context, array.get(i));
    if (!(numObj instanceof PDFNumber)) return null;
    nums.push(numObj.asNumber());
  }
  return nums;
}

/** 读取 /Subtype：必须是名称对象。 */
function readSubtype(context, dict) {
  const raw = dict.get(PDFName.of('Subtype'));
  if (raw === undefined) return { error: '缺少 /Subtype。' };
  if (raw instanceof PDFRef && resolve(context, raw) === undefined) {
    return { error: '/Subtype 间接引用损坏。' };
  }
  const value = resolve(context, raw);
  if (!(value instanceof PDFName)) return { error: '/Subtype 不是名称对象。' };
  return { subtype: nameText(value) };
}

/** 读取 /Rect：四个有限数且正面积。 */
function readRect(context, dict) {
  const raw = dict.get(PDFName.of('Rect'));
  if (raw === undefined) return { error: '缺少 /Rect。' };
  if (raw instanceof PDFRef && resolve(context, raw) === undefined) {
    return { error: '/Rect 间接引用损坏。' };
  }
  const array = resolve(context, raw);
  if (!(array instanceof PDFArray)) return { error: '/Rect 不是 4 元素数组。' };
  const rect = toRect(readArrayNumbers(context, array));
  if (!rect) {
    return { error: '/Rect 不是四个有限数构成的正面积矩形。' };
  }
  return { rect };
}

/** 读取 /F：非负整数，缺省 0。 */
function readFlags(context, dict) {
  const raw = dict.get(PDFName.of('F'));
  if (raw === undefined) return { flags: 0 };
  if (raw instanceof PDFRef && resolve(context, raw) === undefined) {
    return { error: '/F 间接引用损坏。' };
  }
  const value = resolve(context, raw);
  if (!(value instanceof PDFNumber)) return { error: '/F 不是数字。' };
  const flags = value.asNumber();
  if (!Number.isInteger(flags) || flags < 0) {
    return { error: `/F=${flags} 不是非负整数。` };
  }
  return { flags };
}

/**
 * 读取 /AP/N 正常外观：
 *   - /AP/N 为流时直接采用；
 *   - /AP/N 为字典时须由注释的 /AS 选中一个有效流；
 *   - 缺少 /AP 或 /AP/N 记为“缺失”，结构或引用损坏记为“损坏”。
 * @returns {{state:'valid'|'missing'|'broken', note:string}}
 */
function readAppearance(context, dict) {
  const rawAP = dict.get(PDFName.of('AP'));
  if (rawAP === undefined) {
    return { state: 'missing', note: '缺少 /AP 外观字典' };
  }
  const ap = resolve(context, rawAP);
  if (!(ap instanceof PDFDict)) {
    return {
      state: 'broken',
      note:
        rawAP instanceof PDFRef
          ? '/AP 间接引用损坏或不是字典'
          : '/AP 不是字典对象',
    };
  }

  const rawN = ap.get(PDFName.of('N'));
  if (rawN === undefined) {
    return { state: 'missing', note: '/AP 缺少 /N 正常外观' };
  }
  const n = resolve(context, rawN);
  if (n instanceof PDFStream) {
    return { state: 'valid', note: '/AP/N 为外观流，直接采用' };
  }
  if (n instanceof PDFDict) {
    // 外观子典：须由 /AS 选中有效流
    const rawAS = dict.get(PDFName.of('AS'));
    if (rawAS === undefined) {
      return { state: 'broken', note: '/AP/N 为外观子典，但注释缺少 /AS' };
    }
    const as = resolve(context, rawAS);
    if (!(as instanceof PDFName)) {
      return { state: 'broken', note: '/AS 缺失或不是名称对象' };
    }
    const asText = nameText(as);
    const selected = resolve(context, n.get(as));
    if (selected instanceof PDFStream) {
      return {
        state: 'valid',
        note: `/AP/N 为外观子典，由 /AS（/${asText}）选中有效流`,
      };
    }
    return {
      state: 'broken',
      note: `/AP/N 外观子典中 /AS（/${asText}）未选中有效流`,
    };
  }
  return {
    state: 'broken',
    note:
      rawN instanceof PDFRef
        ? '/AP/N 间接引用损坏或既不是流也不是字典'
        : '/AP/N 既不是流也不是字典',
  };
}

/** 分析单条注释（raw 为 /Annots 数组元素，可直接或间接）。 */
function analyzeAnnotation(context, raw, index, frame) {
  const annot = {
    index,
    subtype: null,
    rectMm: null,
    flags: null,
    flagNames: null,
    appearance: null,
    offPage: null,
    screen: null,
    print: null,
    status: ANNOT_STATUS.unknown,
    notes: [],
  };

  const dict = resolve(context, raw);
  if (!(dict instanceof PDFDict)) {
    annot.notes.push(
      raw instanceof PDFRef && dict === undefined
        ? '注释间接引用损坏，无法取得注释字典。'
        : '注释条目不是字典对象。'
    );
    return finalizeUnknown(annot);
  }

  // ---- 字段读取：任一非法即“无法判断”，但不中断同页其他注释 ----
  const subtypeRead = readSubtype(context, dict);
  const rectRead = readRect(context, dict);
  const flagsRead = readFlags(context, dict);
  const fieldErrors = [subtypeRead.error, rectRead.error, flagsRead.error].filter(
    Boolean
  );
  if (subtypeRead.subtype) annot.subtype = subtypeRead.subtype;
  if (flagsRead.flags !== undefined) {
    annot.flags = flagsRead.flags;
    annot.flagNames = FLAG_BITS.filter(([bit]) => flagsRead.flags & bit).map(
      ([, name]) => name
    );
  }
  // 即使存在非法字段，已读出的矩形仍以毫米给出，便于定位
  if (rectRead.rect) annot.rectMm = rectMmOut(rectRead.rect);
  if (fieldErrors.length > 0) {
    annot.notes.push(...fieldErrors);
    return finalizeUnknown(annot);
  }

  // ---- 外观（/AP/N）----
  annot.appearance = readAppearance(context, dict);

  // ---- 位置：有效矩形与可见页框的交集 ----
  if (!frame) {
    annot.offPage = null;
    annot.notes.push('可见页框无效，页外判定跳过。');
  } else {
    annot.offPage = intersectRects(rectRead.rect, frame) === null;
  }

  // ---- 屏显 / 打印状态与判定 ----
  const flags = annot.flags;
  const hidden = (flags & FLAG_HIDDEN) !== 0;
  const noView = (flags & FLAG_NOVIEW) !== 0;
  const printFlag = (flags & FLAG_PRINT) !== 0;

  if (annot.offPage === true) {
    const reason = '注释矩形与可见页框（继承 CropBox，缺省 MediaBox）无交集。';
    annot.screen = { text: '页外不显示', reason };
    annot.print = { text: '页外不打印', reason };
    annot.status = ANNOT_STATUS.offPage;
    return annot;
  }

  if (hidden) {
    // Hidden 覆盖 Print：不显示也不打印
    annot.screen = { text: '不显示', reason: 'Hidden 置位：不显示也不打印。' };
    annot.print = {
      text: '不打印',
      reason: printFlag
        ? 'Hidden 覆盖 Print：虽设 Print 仍不打印。'
        : 'Hidden 置位：不打印。',
    };
    annot.status = ANNOT_STATUS.ok;
    return annot;
  }

  annot.screen = noView
    ? {
        text: '不显示',
        reason: 'NoView 置位：屏上不显示（只排除屏显，不取消 Print）。',
      }
    : { text: '屏显候选', reason: '未设 Hidden/NoView，屏幕上可见。' };

  if (printFlag) {
    if (annot.appearance.state === 'valid') {
      annot.print = {
        text: '打印候选',
        reason: `已设 Print 标志；${annot.appearance.note}。`,
      };
      annot.status = ANNOT_STATUS.printCandidate;
    } else {
      annot.print = {
        text: '待确认',
        reason: `已设 Print 标志，但外观${
          annot.appearance.state === 'missing' ? '缺失' : '损坏'
        }（${annot.appearance.note}），打印结果取决于查看器是否重生成外观。`,
      };
      annot.status = ANNOT_STATUS.needsConfirmation;
    }
    return annot;
  }

  annot.print = noView
    ? { text: '不打印', reason: '未设 Print 标志，不打印。' }
    : { text: '不打印', reason: '未设 Print 标志，打印时将丢失。' };
  // 屏显候选而未设 Print → 漏印风险；NoView 不屏显则不打印属预期
  annot.status = noView ? ANNOT_STATUS.ok : ANNOT_STATUS.missedPrintRisk;
  return annot;
}

/** 标为“无法判断”并补齐屏显/打印说明。 */
function finalizeUnknown(annot) {
  const reason = annot.notes.join('；') || '注释解析失败。';
  annot.screen = { text: '无法判断', reason };
  annot.print = { text: '无法判断', reason };
  annot.status = ANNOT_STATUS.unknown;
  return annot;
}

/** 逐页分析：读取页面自身的 /Annots 并逐条判定。 */
function analyzePageAnnotations(context, page, pageNumber) {
  const node = page.node;
  const record = {
    pageNumber,
    status: PAGE_STATUS.none,
    annotsDeclared: false,
    pageError: null,
    frameNote: null,
    annotations: [],
    counts: null,
  };

  let rawAnnots;
  try {
    rawAnnots = node.get(PDFName.of('Annots'));
  } catch (err) {
    record.status = PAGE_STATUS.unknown;
    record.pageError = `/Annots 读取失败：${err.message}，本页注释无法判断。`;
    return record;
  }
  if (rawAnnots === undefined) return record; // 无 /Annots：无注释
  record.annotsDeclared = true;

  const annots = resolve(context, rawAnnots);
  if (!(annots instanceof PDFArray)) {
    record.status = PAGE_STATUS.unknown;
    record.pageError =
      rawAnnots instanceof PDFRef
        ? '/Annots 间接引用损坏或不是数组，本页注释无法判断。'
        : '/Annots 不是数组，本页注释无法判断。';
    return record;
  }
  if (annots.size() === 0) return record; // 空数组：无注释

  const { frame, note } = visibleFrame(context, node);
  record.frameNote = note;

  for (let i = 0; i < annots.size(); i++) {
    let raw;
    try {
      raw = annots.get(i);
    } catch {
      raw = undefined;
    }
    record.annotations.push(analyzeAnnotation(context, raw, i + 1, frame));
  }

  const counts = {
    total: record.annotations.length,
    printCandidate: 0,
    missedPrintRisk: 0,
    needsConfirmation: 0,
    offPage: 0,
    unknown: 0,
    ok: 0,
  };
  const countKey = {
    [ANNOT_STATUS.printCandidate]: 'printCandidate',
    [ANNOT_STATUS.missedPrintRisk]: 'missedPrintRisk',
    [ANNOT_STATUS.needsConfirmation]: 'needsConfirmation',
    [ANNOT_STATUS.offPage]: 'offPage',
    [ANNOT_STATUS.unknown]: 'unknown',
    [ANNOT_STATUS.ok]: 'ok',
  };
  for (const a of record.annotations) counts[countKey[a.status]] += 1;
  record.counts = counts;

  // 页面级状态取最高优先级
  if (counts.unknown > 0) record.status = PAGE_STATUS.unknown;
  else if (counts.missedPrintRisk > 0) record.status = PAGE_STATUS.missedPrintRisk;
  else if (counts.needsConfirmation > 0)
    record.status = PAGE_STATUS.needsConfirmation;
  else if (counts.offPage > 0) record.status = PAGE_STATUS.offPage;
  else record.status = PAGE_STATUS.ok;

  return record;
}

/**
 * 内部链接目标核对：逐页筛出 /Link 注释，核对其 /Dest 或 /A(/S=/GoTo) 的 /D
 * 是否指向本文件页面。单条链接失败不中断其他链接。
 * @param {import('pdf-lib').PDFContext} context
 * @param {PDFDict} catalog Catalog 字典
 * @param {import('pdf-lib').PDFPage[]} pdfPages
 */
function checkLinkTargets(context, catalog, pdfPages) {
  // 本文件页面引用 → 页序（从 1 起）
  const pageRefs = new Map();
  pdfPages.forEach((page, i) => {
    if (page.ref) pageRefs.set(refKey(page.ref), i + 1);
  });

  const links = [];
  pdfPages.forEach((page, i) => {
    const pageNumber = i + 1;
    let rawAnnots;
    try {
      rawAnnots = page.node.get(PDFName.of('Annots'));
    } catch {
      return; // /Annots 读取失败：印刷风险区已记整页无法判断，链接核对跳过
    }
    if (rawAnnots === undefined) return;
    const annots = resolve(context, rawAnnots);
    if (!(annots instanceof PDFArray)) return;

    for (let idx = 0; idx < annots.size(); idx++) {
      let raw;
      try {
        raw = annots.get(idx);
      } catch {
        continue; // 该条目在印刷风险区已记为无法判断
      }
      const dict = resolve(context, raw);
      if (!(dict instanceof PDFDict)) continue; // 非字典：印刷风险区已记无法判断
      const subtypeRead = readSubtype(context, dict);
      if (subtypeRead.subtype !== 'Link') continue;
      links.push(
        analyzeLinkTarget(context, catalog, dict, pageRefs, pageNumber, idx + 1)
      );
    }
  });

  const summary = {
    total: links.length,
    ok: 0,
    broken: 0,
    unknown: 0,
    outOfScope: 0,
  };
  for (const link of links) {
    if (link.status === LINK_STATUS.ok) summary.ok += 1;
    else if (link.status === LINK_STATUS.broken) summary.broken += 1;
    else if (link.status === LINK_STATUS.unknown) summary.unknown += 1;
    else summary.outOfScope += 1;
  }
  return { links, summary, scopeNote: LINK_SCOPE_NOTE };
}

/** 间接引用键（对象号 + 生成号），用于页面引用映射。 */
function refKey(ref) {
  return `${ref.objectNumber} ${ref.generationNumber}`;
}

/**
 * 核对单条 /Link 注释的内部目标。
 * 记录：来源页、注释序号（页内 /Annots 序号，从 1 起）、目标来源、目标页、状态、原因。
 */
function analyzeLinkTarget(context, catalog, dict, pageRefs, pageNumber, annotIndex) {
  const record = {
    pageNumber,
    annotIndex,
    source: null, // 'Dest' | 'A' | null
    targetPage: null, // 从 1 起的页序；未解析到页面时为 null
    status: LINK_STATUS.unknown,
    reason: '',
  };

  const rawDest = dict.get(PDFName.of('Dest'));
  const rawA = dict.get(PDFName.of('A'));

  if (rawDest !== undefined && rawA !== undefined) {
    record.status = LINK_STATUS.unknown;
    record.reason = '同时设有 /Dest 与 /A，目标来源冲突，无法判断。';
    return record;
  }
  if (rawDest === undefined && rawA === undefined) {
    record.status = LINK_STATUS.broken;
    record.reason = '未设目标：/Link 注释缺少 /Dest 与 /A。';
    return record;
  }

  if (rawDest !== undefined) {
    record.source = 'Dest';
    return applyTarget(
      record,
      resolveDestination(context, catalog, rawDest, pageRefs)
    );
  }

  // 只有 /A：读取动作字典
  record.source = 'A';
  const action = resolve(context, rawA);
  if (!(action instanceof PDFDict)) {
    record.status = LINK_STATUS.unknown;
    record.reason =
      rawA instanceof PDFRef
        ? '/A 间接引用损坏或不是字典。'
        : '/A 不是字典对象。';
    return record;
  }
  const rawS = action.get(PDFName.of('S'));
  if (rawS === undefined) {
    record.status = LINK_STATUS.unknown;
    record.reason = '/A 动作字典缺少 /S，动作类型无法判断。';
    return record;
  }
  const s = resolve(context, rawS);
  if (!(s instanceof PDFName)) {
    record.status = LINK_STATUS.unknown;
    record.reason =
      rawS instanceof PDFRef
        ? '/A 的 /S 间接引用损坏或不是名称对象。'
        : '/A 的 /S 不是名称对象。';
    return record;
  }
  const sText = nameText(s);
  if (sText !== 'GoTo') {
    record.status = LINK_STATUS.outOfScope;
    record.reason =
      `动作类型 /${sText} 不是 /GoTo，属范围外（不访问网络、不追踪外部动作）。`;
    return record;
  }
  const rawD = action.get(PDFName.of('D'));
  if (rawD === undefined) {
    record.status = LINK_STATUS.broken;
    record.reason = '未设目标：/GoTo 动作缺少 /D。';
    return record;
  }
  return applyTarget(
    record,
    resolveDestination(context, catalog, rawD, pageRefs)
  );
}

function applyTarget(record, result) {
  record.status = result.status;
  record.reason = result.reason;
  if (result.targetPage !== undefined && result.targetPage !== null) {
    record.targetPage = result.targetPage;
  }
  return record;
}

/**
 * 解析目标值（/Dest 的值或 /D 的值，可间接引用）：
 *   - PDFArray  → 显式目标数组；
 *   - PDFName   → 查 Catalog/Dests；
 *   - PDFString/PDFHexString → 查 Catalog/Names/Dests 名称树；
 *   - 其他类型  → 无法判断（非法类型）。
 */
function resolveDestination(context, catalog, rawDest, pageRefs) {
  const dest = resolve(context, rawDest);
  if (dest === undefined) {
    return { status: LINK_STATUS.unknown, reason: '目标为损坏的间接引用。' };
  }
  if (dest instanceof PDFArray) {
    return resolveDestArray(context, dest, pageRefs);
  }
  if (dest instanceof PDFName) {
    return lookupDestsDict(context, catalog, nameText(dest), pageRefs);
  }
  if (dest instanceof PDFString || dest instanceof PDFHexString) {
    let key;
    try {
      key = dest.decodeText();
    } catch {
      return { status: LINK_STATUS.unknown, reason: '目标字符串解码失败。' };
    }
    return lookupNameTree(context, catalog, key, pageRefs);
  }
  return {
    status: LINK_STATUS.unknown,
    reason: '目标既不是数组、名称也不是字符串，类型非法。',
  };
}

/**
 * 显式目标数组：只核对首项是否为本文件页面的间接引用，不查缩放参数。
 * @returns {{status:string, reason:string, targetPage?:number}}
 */
function resolveDestArray(context, destArray, pageRefs) {
  if (destArray.size() === 0) {
    return { status: LINK_STATUS.unknown, reason: '目标数组为空，非法。' };
  }
  let first;
  try {
    first = destArray.get(0);
  } catch {
    first = undefined;
  }
  if (!(first instanceof PDFRef)) {
    return {
      status: LINK_STATUS.unknown,
      reason: '目标数组首项不是页面间接引用，类型非法（不核对缩放参数）。',
    };
  }
  // 坏引用 → 无法判断；引用有效但不属于本文件页面 → 目标页不存在（失效）
  const target = resolve(context, first);
  if (target === undefined) {
    return { status: LINK_STATUS.unknown, reason: '目标页间接引用损坏。' };
  }
  const pageNumber = pageRefs.get(refKey(first));
  if (pageNumber === undefined) {
    return {
      status: LINK_STATUS.broken,
      reason: '目标页不存在：目标数组首项引用并非本文件页面。',
    };
  }
  return {
    status: LINK_STATUS.ok,
    targetPage: pageNumber,
    reason: `目标为第 ${pageNumber} 页（只核对首项页面引用，不核对缩放参数）。`,
  };
}

/**
 * 名称目标值（Catalog/Dests 项或名称树叶子值）：
 * 支持数组，或 /D 为数组的字典。
 */
function destValueToArray(context, value, rawValue, pageRefs, originDesc) {
  if (value === undefined) {
    return {
      status: LINK_STATUS.unknown,
      reason: `${originDesc}为损坏的间接引用。`,
    };
  }
  if (value instanceof PDFArray) {
    return resolveDestArray(context, value, pageRefs);
  }
  if (value instanceof PDFDict) {
    const rawD = value.get(PDFName.of('D'));
    if (rawD === undefined) {
      return {
        status: LINK_STATUS.unknown,
        reason: `${originDesc}为字典但缺少 /D 数组。`,
      };
    }
    const d = resolve(context, rawD);
    if (d instanceof PDFArray) {
      return resolveDestArray(context, d, pageRefs);
    }
    return {
      status: LINK_STATUS.unknown,
      reason:
        rawD instanceof PDFRef
          ? `${originDesc}的 /D 间接引用损坏或不是数组。`
          : `${originDesc}的 /D 不是数组。`,
    };
  }
  return {
    status: LINK_STATUS.unknown,
    reason: `${originDesc}既不是数组也不是字典，类型非法。`,
  };
}

/** 名称对象目标：查 Catalog/Dests 字典，按名称解码原文匹配。 */
function lookupDestsDict(context, catalog, targetName, pageRefs) {
  const rawDests = catalog.get(PDFName.of('Dests'));
  if (rawDests === undefined) {
    return {
      status: LINK_STATUS.broken,
      reason: `Catalog 无 /Dests 字典，名称 /${targetName} 无出处，目标缺失。`,
    };
  }
  const dests = resolve(context, rawDests);
  if (!(dests instanceof PDFDict)) {
    return {
      status: LINK_STATUS.unknown,
      reason:
        rawDests instanceof PDFRef
          ? 'Catalog/Dests 间接引用损坏或不是字典。'
          : 'Catalog/Dests 不是字典对象。',
    };
  }

  // 按解码原文收集匹配；编码不同但解码相同的键视为重名
  const matches = [];
  for (const [key, value] of dests.entries()) {
    let keyText;
    try {
      keyText = key.decodeText();
    } catch {
      keyText = String(key);
    }
    if (keyText === targetName) matches.push(value);
  }
  if (matches.length > 1) {
    return {
      status: LINK_STATUS.unknown,
      reason: `Catalog/Dests 中名称 /${targetName} 重名（${matches.length} 处），无法判断。`,
    };
  }
  if (matches.length === 0) {
    return {
      status: LINK_STATUS.broken,
      reason: `Catalog/Dests 中无名称 /${targetName}，目标缺失。`,
    };
  }
  const rawValue = matches[0];
  const value = resolve(context, rawValue);
  return destValueToArray(
    context,
    value,
    rawValue,
    pageRefs,
    `Catalog/Dests 中 /${targetName} 的目标`
  );
}

/**
 * 字符串目标：查 Catalog/Names/Dests 名称树。
 * 遍历所有 /Kids 与 /Names，按键解码原文匹配；
 * 记录坏分支与循环：命中唯一名称时不受他处坏分支影响（循环除外，
 * 因为循环意味着遍历不完整、无法排除重名）；未命中时，存在坏分支或循环
 * 记为无法判断，树完好则记为失效（缺名）。
 */
function lookupNameTree(context, catalog, key, pageRefs) {
  const rawNames = catalog.get(PDFName.of('Names'));
  if (rawNames === undefined) {
    return {
      status: LINK_STATUS.broken,
      reason: `Catalog 无 /Names 名称字典，名称“${key}”无出处，目标缺失。`,
    };
  }
  const names = resolve(context, rawNames);
  if (!(names instanceof PDFDict)) {
    return {
      status: LINK_STATUS.unknown,
      reason:
        rawNames instanceof PDFRef
          ? 'Catalog/Names 间接引用损坏或不是字典。'
          : 'Catalog/Names 不是字典对象。',
    };
  }
  const rawRoot = names.get(PDFName.of('Dests'));
  if (rawRoot === undefined) {
    return {
      status: LINK_STATUS.broken,
      reason: `Catalog/Names 无 /Dests 名称树，名称“${key}”无出处，目标缺失。`,
    };
  }
  const root = resolve(context, rawRoot);
  if (!(root instanceof PDFDict)) {
    return {
      status: LINK_STATUS.unknown,
      reason: 'Catalog/Names/Dests 名称树根节点损坏或不是字典。',
    };
  }

  const matches = [];
  let badBranch = false;
  let cycle = false;
  const visited = new Set();

  const visit = (node) => {
    if (visited.has(node)) {
      cycle = true;
      return;
    }
    visited.add(node);

    // 叶节点 /Names：[key1, value1, key2, value2, ...]
    let rawArr;
    try {
      rawArr = node.get(PDFName.of('Names'));
    } catch {
      rawArr = undefined;
      badBranch = true;
    }
    if (rawArr !== undefined) {
      const arr = resolve(context, rawArr);
      if (!(arr instanceof PDFArray)) {
        badBranch = true;
      } else {
        if (arr.size() % 2 !== 0) badBranch = true;
        for (let i = 0; i + 1 < arr.size(); i += 2) {
          let kRaw;
          let vRaw;
          try {
            kRaw = arr.get(i);
            vRaw = arr.get(i + 1);
          } catch {
            badBranch = true;
            continue;
          }
          const keyObj = resolve(context, kRaw);
          if (
            !(keyObj instanceof PDFString) &&
            !(keyObj instanceof PDFHexString)
          ) {
            badBranch = true;
            continue;
          }
          let text;
          try {
            text = keyObj.decodeText();
          } catch {
            badBranch = true;
            continue;
          }
          if (text === key) matches.push(vRaw);
        }
      }
    }

    // 中间节点 /Kids：子节点数组
    let rawKids;
    try {
      rawKids = node.get(PDFName.of('Kids'));
    } catch {
      rawKids = undefined;
      badBranch = true;
    }
    if (rawKids !== undefined) {
      const kids = resolve(context, rawKids);
      if (!(kids instanceof PDFArray)) {
        badBranch = true;
      } else {
        for (let i = 0; i < kids.size(); i++) {
          let kidRaw;
          try {
            kidRaw = kids.get(i);
          } catch {
            badBranch = true;
            continue;
          }
          const kid = resolve(context, kidRaw);
          if (!(kid instanceof PDFDict)) {
            badBranch = true;
            continue;
          }
          visit(kid);
        }
      }
    }
  };
  visit(root);

  if (matches.length > 1) {
    return {
      status: LINK_STATUS.unknown,
      reason: `名称树中名称“${key}”重名（${matches.length} 处），无法判断。`,
    };
  }
  if (matches.length === 1) {
    if (cycle) {
      return {
        status: LINK_STATUS.unknown,
        reason: `名称树存在循环引用，遍历不完整，无法确认名称“${key}”唯一。`,
      };
    }
    const rawValue = matches[0];
    const value = resolve(context, rawValue);
    return destValueToArray(
      context,
      value,
      rawValue,
      pageRefs,
      `名称树中“${key}”的目标`
    );
  }
  if (badBranch || cycle) {
    return {
      status: LINK_STATUS.unknown,
      reason:
        `名称树存在${badBranch ? '损坏分支' : ''}${
          badBranch && cycle ? '或' : ''
        }${cycle ? '循环引用' : ''}且未命中名称“${key}”，无法判断。`,
    };
  }
  return {
    status: LINK_STATUS.broken,
    reason: `名称树中无名称“${key}”，目标缺失。`,
  };
}

/**
 * 注释印刷风险核查主流程：校验上传文件，逐页解析注释并判定屏显/打印状态。
 * @param {Buffer} buffer 上传的原始 PDF 字节
 */
export async function checkAnnotations(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length === 0) {
    throw new AnnotationError('上传文件为空，请选择有效的 PDF 文件。');
  }
  const head = buffer.subarray(0, 5).toString('latin1');
  if (head !== '%PDF-') {
    throw new AnnotationError('文件不是有效的 PDF（文件头损坏或并非 PDF 文件）。');
  }

  let doc;
  let pdfPages;
  try {
    doc = await PDFDocument.load(buffer, {
      ignoreEncryption: false,
      updateMetadata: false,
    });
    // 部分损坏文件在访问页树时才暴露错误，一并纳入解析失败处理
    pdfPages = doc.getPages();
  } catch (err) {
    if (/encrypt|password/i.test(err.message || '')) {
      throw new AnnotationError('该 PDF 已加密，请先解除密码/加密后再上传。');
    }
    throw new AnnotationError(`PDF 文件损坏或无法解析：${err.message}`);
  }

  // 双保险：检查 trailer 中的 Encrypt 字典
  try {
    const encrypt =
      doc.context.trailer && doc.context.trailer.dict
        ? doc.context.trailer.dict.get('Encrypt')
        : undefined;
    if (encrypt) {
      throw new AnnotationError('该 PDF 已加密，请先解除密码/加密后再上传。');
    }
  } catch (err) {
    if (err instanceof AnnotationError) throw err;
    // 字典访问异常不影响主流程
  }

  if (pdfPages.length === 0) {
    throw new AnnotationError('PDF 中没有任何页面。');
  }

  const context = doc.context;
  const pages = pdfPages.map((page, i) =>
    analyzePageAnnotations(context, page, i + 1)
  );

  // 内部链接目标核对：复用同一文档，逐页筛出 /Link 注释
  const linkTargets = checkLinkTargets(context, doc.catalog, pdfPages);

  const withAnnots = pages.filter((pg) => pg.annotations.length > 0);
  // 汇总按“页内是否含该状态注释”统计（一页可同时出现在多个列表）
  const pagesWith = (key) =>
    pages
      .filter((pg) => pg.counts && pg.counts[key] > 0)
      .map((pg) => pg.pageNumber);
  const totalCount = (key) =>
    pages.reduce((n, pg) => n + (pg.counts ? pg.counts[key] : 0), 0);

  return {
    pageCount: pages.length,
    pages,
    linkTargets,
    summary: {
      totalPages: pages.length,
      pagesWithAnnotations: withAnnots.length,
      totalAnnotations: totalCount('total'),
      missedPrintRiskPages: pagesWith('missedPrintRisk'),
      needsConfirmationPages: pagesWith('needsConfirmation'),
      offPagePages: pagesWith('offPage'),
      unknownPages: pages
        .filter((pg) => pg.status === PAGE_STATUS.unknown)
        .map((pg) => pg.pageNumber),
      counts: {
        printCandidate: totalCount('printCandidate'),
        missedPrintRisk: totalCount('missedPrintRisk'),
        needsConfirmation: totalCount('needsConfirmation'),
        offPage: totalCount('offPage'),
        unknown: totalCount('unknown'),
        ok: totalCount('ok'),
      },
    },
    scopeNote: SCOPE_NOTE,
  };
}
