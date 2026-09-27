// bleedboxes.js
// 裁切盒（TrimBox）与出血盒（BleedBox）核验核心逻辑。
//
// 规则：
//   - 逐页读取继承的 MediaBox、CropBox、Rotate：CropBox 缺省取 MediaBox，
//     Rotate 缺省取 0 度（只接受 0/90/180/270，其他值视为无效）；
//   - TrimBox、BleedBox 只读取页面叶子字典中“显式声明”的条目，不套用默认盒
//     （不回退到 CropBox）；缺少即标为“未声明”，声明但非法（不是 4 个数字、
//     宽高不大于 0）标为“无法判断”；
//   - 按 /Rotate 旋转后的阅读方向（上方为阅读上边）比较 TrimBox 与用户输入的
//     成品宽、高：宽、高任一与成品尺寸相差严格超过 0.5 mm 报“尺寸不符”，
//     0.5 mm 以内视为相符（恰好 0.5 mm 不报）；
//   - 把 BleedBox 与 CropBox、MediaBox 的交集作为“可用出血范围”，
//     逐边计算它超出 TrimBox 的距离（毫米）：严格小于最低出血量报风险，
//     恰好达到不报；交集为空（或退化）时标为“无法判断”；
//   - 正确处理非零盒原点（所有盒按 [左下 x/y, 右上 x/y] 原样参与运算）与
//     90/180/270 度旋转（先在默认用户空间取盒，再逐点映射到阅读方向）；
//   - 只核验盒几何（位置与尺寸），不判断页面画面是否铺满出血区。
//
// 解析使用 pdf-lib 底层对象模型：MediaBox/CropBox/Rotate 经
// PDFPageLeaf 的可继承属性读取，TrimBox/BleedBox 仅读叶子字典自身条目。

import { PDFDocument, PDFName, PDFNumber } from 'pdf-lib';

export class BleedBoxError extends Error {
  constructor(message) {
    super(message);
    this.name = 'BleedBoxError';
  }
}

export const PT_PER_MM = 72 / 25.4;
// 成品尺寸容差（mm）：差值严格超过 0.5 mm 才报尺寸不符
export const SIZE_TOLERANCE_MM = 0.5;
// 浮点容差（pt）：恰好达到阈值（含微小浮动误差）不报风险
export const EPS_PT = 1e-6;

export const EDGE_NAMES = {
  left: '左',
  right: '右',
  top: '上',
  bottom: '下',
};
const EDGE_ORDER = ['left', 'right', 'top', 'bottom'];

// 页面整体状态：unknown（无法判断） > undeclared（有未声明） > risk（风险） > ok
export const PAGE_STATUS = {
  ok: 'ok',
  risk: 'risk',
  undeclared: 'undeclared',
  unknown: 'unknown',
};

export const SCOPE_NOTE =
  '本页仅核验 PDF 页面各盒（MediaBox / CropBox / TrimBox / BleedBox）的几何位置与尺寸，' +
  '不判断页面画面（图像、底色等）是否实际铺满出血区。';

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

/**
 * 读取一个可继承的盒（MediaBox / CropBox，自 Pages 父节点继承）。
 * @returns {{declared:boolean, rect:Rect|null, invalid:boolean}}
 */
function readInheritedRect(pageNode, keyName) {
  let declared = false;
  try {
    // 先用可继承属性判断叶子或父节点是否实际声明（类型错误也视为已声明）
    declared = pageNode.getInheritableAttribute(PDFName.of(keyName)) !== undefined;
  } catch {
    declared = true;
  }
  let array;
  try {
    array = keyName === 'MediaBox' ? pageNode.MediaBox() : pageNode.CropBox();
  } catch {
    // 已声明但不是 PDFArray（如误写为数字），或 MediaBox 整棵树缺失
    return { declared, rect: null, invalid: declared };
  }
  if (array === undefined || array === null) {
    return { declared: false, rect: null, invalid: false };
  }
  const rect = toRect(readArrayNumbers(array));
  return { declared: true, rect, invalid: rect === null };
}

/**
 * 读取页面叶子字典中显式声明的盒（TrimBox / BleedBox），不套用默认盒。
 * @returns {{declared:boolean, rect:Rect|null, invalid:boolean}}
 */
function readExplicitRect(pageNode, keyName) {
  // 显式声明：只看页面叶子字典自身是否含该键（不向 Pages 父节点继承）
  if (!pageNode.has(PDFName.of(keyName))) {
    return { declared: false, rect: null, invalid: false };
  }
  let array;
  try {
    array = keyName === 'TrimBox' ? pageNode.TrimBox() : pageNode.BleedBox();
  } catch {
    return { declared: true, rect: null, invalid: true };
  }
  if (array === undefined || array === null) {
    // 声明了但不是数组（如误写为数字、字典等）
    return { declared: true, rect: null, invalid: true };
  }
  const rect = toRect(readArrayNumbers(array));
  return { declared: true, rect, invalid: rect === null };
}

/** 读取 PDFArray 的 4 个数字（元素可间接引用）；长度不符或含非数字时返回 null。 */
function readArrayNumbers(array) {
  if (typeof array.size !== 'function' || array.size() !== 4) return null;
  const nums = [];
  for (let i = 0; i < 4; i++) {
    let numObj;
    try {
      numObj = array.lookup(i, PDFNumber);
    } catch {
      return null;
    }
    if (!numObj) return null;
    nums.push(numObj.asNumber());
  }
  return nums;
}

/** 两个轴对齐矩形的交集；无交集（或退化）返回 null。 */
function intersectRects(a, b) {
  const x1 = Math.max(a.x, b.x);
  const y1 = Math.max(a.y, b.y);
  const x2 = Math.min(a.x2, b.x2);
  const y2 = Math.min(a.y2, b.y2);
  if (!(x2 - x1 > EPS_PT) || !(y2 - y1 > EPS_PT)) return null;
  return { x: x1, y: y1, x2, y2, width: x2 - x1, height: y2 - y1 };
}

/**
 * 默认用户空间中的点（pt）映射到旋转后的阅读方向。
 * 阅读方向：X 向右、Y 向下，原点为旋转后页面的左上角，
 * 以 MediaBox 的左下角（mx,my）与宽高（mw,mh）为旋转枢轴。
 * @returns {{X:number,Y:number}}
 */
export function mapPointToReading(x, y, rotation, media) {
  const { x: mx, y: my, width: mw, height: mh } = media;
  switch (rotation) {
    case 0:
      return { X: x - mx, Y: mh - (y - my) };
    case 90:
      return { X: y - my, Y: x - mx };
    case 180:
      return { X: mw - (x - mx), Y: y - my };
    case 270:
      return { X: mh - (y - my), Y: mw - (x - mx) };
    default:
      throw new Error(`不支持的旋转角：${rotation}`);
  }
}

/** 默认用户空间矩形映射到阅读方向后的轴对齐外接矩形。 */
function mapRectToReading(rect, rotation, media) {
  const corners = [
    mapPointToReading(rect.x, rect.y, rotation, media),
    mapPointToReading(rect.x2, rect.y, rotation, media),
    mapPointToReading(rect.x, rect.y2, rotation, media),
    mapPointToReading(rect.x2, rect.y2, rotation, media),
  ];
  const X1 = Math.min(...corners.map((c) => c.X));
  const X2 = Math.max(...corners.map((c) => c.X));
  const Y1 = Math.min(...corners.map((c) => c.Y));
  const Y2 = Math.max(...corners.map((c) => c.Y));
  return { X: X1, Y: Y1, X2, Y2, width: X2 - X1, height: Y2 - Y1 };
}

function ptToMm(n) {
  return n / PT_PER_MM;
}
function round1(n) {
  return Math.round(n * 10) / 10;
}
function round2(n) {
  return Math.round(n * 100) / 100;
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
 * 核验主流程：校验上传文件与输入参数，逐页读取页面盒并判定尺寸/出血风险。
 * @param {Buffer} buffer 上传的原始 PDF 字节
 * @param {{finishedWidthMm:number, finishedHeightMm:number, minBleedMm:number}} opts
 */
export async function checkBleedBoxes(buffer, {
  finishedWidthMm,
  finishedHeightMm,
  minBleedMm,
}) {
  if (!Buffer.isBuffer(buffer) || buffer.length === 0) {
    throw new BleedBoxError('上传文件为空，请选择有效的 PDF 文件。');
  }
  const head = buffer.subarray(0, 5).toString('latin1');
  if (head !== '%PDF-') {
    throw new BleedBoxError('文件不是有效的 PDF（文件头损坏或并非 PDF 文件）。');
  }

  for (const [label, value] of [
    ['成品宽度', finishedWidthMm],
    ['成品高度', finishedHeightMm],
    ['最低出血量', minBleedMm],
  ]) {
    if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
      throw new BleedBoxError(`${label}必须为大于 0 的数字（毫米）。`);
    }
  }

  let doc;
  let pdfPages;
  try {
    doc = await PDFDocument.load(buffer, {
      ignoreEncryption: false,
      updateMetadata: false,
    });
    pdfPages = doc.getPages();
  } catch (err) {
    if (/encrypt|password/i.test(err.message || '')) {
      throw new BleedBoxError('该 PDF 已加密，请先解除密码/加密后再上传。');
    }
    throw new BleedBoxError(`PDF 文件损坏或无法解析：${err.message}`);
  }

  // 双保险：检查 trailer 中的 Encrypt 字典
  try {
    const encrypt =
      doc.context.trailer && doc.context.trailer.dict
        ? doc.context.trailer.dict.get('Encrypt')
        : undefined;
    if (encrypt) {
      throw new BleedBoxError('该 PDF 已加密，请先解除密码/加密后再上传。');
    }
  } catch (err) {
    if (err instanceof BleedBoxError) throw err;
    // 字典访问异常不影响主流程
  }

  if (pdfPages.length === 0) {
    throw new BleedBoxError('PDF 中没有任何页面。');
  }

  const tolerancePt = SIZE_TOLERANCE_MM * PT_PER_MM;
  const finishedWidthPt = finishedWidthMm * PT_PER_MM;
  const finishedHeightPt = finishedHeightMm * PT_PER_MM;
  const minBleedPt = minBleedMm * PT_PER_MM;

  const pages = pdfPages.map((page, i) =>
    analyzePage(page, i + 1, {
      finishedWidthPt,
      finishedHeightPt,
      tolerancePt,
      minBleedPt,
    })
  );

  const byStatus = (s) => pages.filter((pg) => pg.status === s);
  const sizeMismatchPages = pages
    .filter((pg) => pg.sizeCheck && pg.sizeCheck.status === 'mismatch')
    .map((pg) => pg.pageNumber);
  const riskEdgePageSet = new Set(
    pages
      .filter((pg) => Array.isArray(pg.bleedEdges))
      .flatMap((pg) =>
        pg.bleedEdges.some((e) => e.status === 'risk') ? [pg.pageNumber] : []
      )
  );

  return {
    finishedMm: { width: finishedWidthMm, height: finishedHeightMm },
    minBleedMm,
    pageCount: pages.length,
    pages,
    summary: {
      totalPages: pages.length,
      riskPages: byStatus(PAGE_STATUS.risk).map((pg) => pg.pageNumber),
      undeclaredPages: byStatus(PAGE_STATUS.undeclared).map((pg) => pg.pageNumber),
      unknownPages: byStatus(PAGE_STATUS.unknown).map((pg) => pg.pageNumber),
      sizeMismatchPages,
      bleedRiskPages: [...riskEdgePageSet],
      okPages: byStatus(PAGE_STATUS.ok).map((pg) => pg.pageNumber),
    },
    scopeNote: SCOPE_NOTE,
  };
}

/**
 * 逐页分析。
 * @param {import('pdf-lib').PDFPage} page
 */
function analyzePage(page, pageNumber, thresholds) {
  const notes = [];
  const node = page.node;

  // ---- 继承的 MediaBox / CropBox / Rotate ----
  let mediaBox;
  let mediaInvalid = false;
  try {
    const r = readInheritedRect(node, 'MediaBox');
    mediaBox = r.rect;
    mediaInvalid = r.declared && r.invalid;
    if (!mediaBox) notes.push('MediaBox 缺失或不是有效的正数矩形，本页无法判断。');
  } catch (err) {
    mediaBox = null;
    notes.push(`MediaBox 读取失败：${err.message}；本页无法判断。`);
  }

  let cropBox = null;
  let cropRead = { declared: false, rect: null, invalid: false };
  let cropDefaulted = false;
  if (mediaBox) {
    try {
      cropRead = readInheritedRect(node, 'CropBox');
      if (!cropRead.declared) {
        // 缺省取 MediaBox（不视为未声明，属于规范默认值）
        cropBox = mediaBox;
        cropDefaulted = true;
      } else if (!cropRead.rect) {
        notes.push('CropBox 已声明但不是有效的正数矩形，本页无法判断。');
      } else {
        cropBox = cropRead.rect;
      }
    } catch (err) {
      notes.push(`CropBox 读取失败：${err.message}；本页无法判断。`);
    }
  }

  let rotation = null;
  if (mediaBox) {
    try {
      const rotateValue = node.Rotate(); // 可继承；缺省为 undefined
      if (!rotateValue) {
        rotation = 0;
      } else {
        const angle = rotateValue.asNumber();
        if ([0, 90, 180, 270].includes(angle)) {
          rotation = angle;
        } else {
          notes.push(
            `Rotate=${angle} 不是 0/90/180/270 度，本页无法判断。`
          );
        }
      }
    } catch (err) {
      notes.push(`Rotate 读取失败：${err.message}；本页无法判断。`);
    }
  }

  // ---- 页面显式声明的 TrimBox / BleedBox（不套用默认盒）----
  let trimRead = { declared: false, rect: null, invalid: false };
  let bleedRead = { declared: false, rect: null, invalid: false };
  if (mediaBox) {
    try {
      trimRead = readExplicitRect(node, 'TrimBox');
    } catch (err) {
      trimRead = { declared: true, rect: null, invalid: true };
      notes.push(`TrimBox 读取失败：${err.message}。`);
    }
    try {
      bleedRead = readExplicitRect(node, 'BleedBox');
    } catch (err) {
      bleedRead = { declared: true, rect: null, invalid: true };
      notes.push(`BleedBox 读取失败：${err.message}。`);
    }
    if (trimRead.invalid) {
      notes.push('TrimBox 已声明但不是 4 个数字构成的有效正数矩形。');
    }
    if (bleedRead.invalid) {
      notes.push('BleedBox 已声明但不是 4 个数字构成的有效正数矩形。');
    }
  }

  const boxes = {
    media: {
      declared: !!mediaBox || mediaInvalid,
      invalid: mediaInvalid,
      defaulted: false,
      rectMm: rectMmOut(mediaBox),
    },
    crop: {
      declared: cropRead.declared,
      invalid: cropRead.invalid,
      defaulted: cropDefaulted,
      rectMm: rectMmOut(cropBox),
    },
    trim: {
      declared: trimRead.declared,
      invalid: trimRead.invalid,
      defaulted: false,
      rectMm: rectMmOut(trimRead.rect),
    },
    bleed: {
      declared: bleedRead.declared,
      invalid: bleedRead.invalid,
      defaulted: false,
      rectMm: rectMmOut(bleedRead.rect),
    },
  };

  const geometryBroken =
    !mediaBox || !cropBox || rotation === null || trimRead.invalid || bleedRead.invalid;

  // ---- TrimBox 成品尺寸核对（按旋转后的阅读方向）----
  let sizeCheck = null;
  let trimReading = null;
  if (trimRead.rect && !geometryBroken) {
    trimReading = mapRectToReading(trimRead.rect, rotation, mediaBox);
    const diffW = trimReading.width - thresholds.finishedWidthPt;
    const diffH = trimReading.height - thresholds.finishedHeightPt;
    const mismatch =
      Math.abs(diffW) > thresholds.tolerancePt + EPS_PT ||
      Math.abs(diffH) > thresholds.tolerancePt + EPS_PT;
    sizeCheck = {
      status: mismatch ? 'mismatch' : 'ok',
      expectedMm: {
        width: round1(ptToMm(thresholds.finishedWidthPt)),
        height: round1(ptToMm(thresholds.finishedHeightPt)),
      },
      actualMm: {
        width: round1(ptToMm(trimReading.width)),
        height: round1(ptToMm(trimReading.height)),
      },
      diffMm: {
        width: round2(ptToMm(diffW)),
        height: round2(ptToMm(diffH)),
      },
      note: mismatch
        ? '按旋转后阅读方向比较，TrimBox 与成品尺寸相差超过 0.5 mm。'
        : '按旋转后阅读方向比较，TrimBox 与成品尺寸相符（误差不超过 0.5 mm）。',
    };
  } else if (!trimRead.declared && !geometryBroken) {
    sizeCheck = {
      status: 'undeclared',
      expectedMm: {
        width: round1(ptToMm(thresholds.finishedWidthPt)),
        height: round1(ptToMm(thresholds.finishedHeightPt)),
      },
      actualMm: null,
      diffMm: null,
      note: '页面未显式声明 TrimBox，不套用默认盒，成品尺寸无法核对。',
    };
  }

  // ---- 出血逐边计算 ----
  let bleedEdges = null;
  let usableBleedRectMm = null;
  if (bleedRead.declared && bleedRead.rect && trimReading && !geometryBroken) {
    // 可用出血范围 = BleedBox ∩ CropBox ∩ MediaBox（默认用户空间）
    const usableBleed = intersectRects(bleedRead.rect, cropBox);
    const usable = usableBleed ? intersectRects(usableBleed, mediaBox) : null;
    if (!usable) {
      notes.push(
        'BleedBox 与 CropBox、MediaBox 无交集（或交集退化），无法取得可用出血范围。'
      );
    } else {
      usableBleedRectMm = rectMmOut(usable);
      const usableReading = mapRectToReading(usable, rotation, mediaBox);
      // 各边距离：可用出血盒边界相对 TrimBox 边界向外的超出量（pt）
      const raw = {
        left: trimReading.X - usableReading.X,
        right: usableReading.X2 - trimReading.X2,
        top: trimReading.Y - usableReading.Y,
        bottom: usableReading.Y2 - trimReading.Y2,
      };
      bleedEdges = EDGE_ORDER.map((edge) => {
        const distancePt = raw[edge];
        const status =
          distancePt + EPS_PT < thresholds.minBleedPt ? 'risk' : 'ok';
        return {
          edge,
          edgeName: EDGE_NAMES[edge],
          distanceMm: round2(ptToMm(distancePt)),
          requiredMm: round2(ptToMm(thresholds.minBleedPt)),
          status,
          note:
            status === 'risk'
              ? distancePt < -EPS_PT
                ? '可用出血范围未覆盖 TrimBox 该边（负值表示裁切盒落在出血范围之外）。'
                : '该边可用出血严格小于最低出血量（恰好达到不报）。'
              : '该边可用出血不小于最低出血量。',
        };
      });
    }
  } else if (!bleedRead.declared && !geometryBroken) {
    notes.push('页面未显式声明 BleedBox，不套用默认盒，出血距离无法计算。');
  }

  // ---- 整体状态 ----
  let status;
  if (geometryBroken || (bleedRead.declared && bleedEdges === null)) {
    status = PAGE_STATUS.unknown;
  } else if (!trimRead.declared || !bleedRead.declared) {
    status = PAGE_STATUS.undeclared;
  } else if (
    sizeCheck.status === 'mismatch' ||
    bleedEdges.some((e) => e.status === 'risk')
  ) {
    status = PAGE_STATUS.risk;
  } else {
    status = PAGE_STATUS.ok;
  }

  return {
    pageNumber,
    rotation,
    status,
    boxes,
    trimDeclared: trimRead.declared,
    bleedDeclared: bleedRead.declared,
    sizeCheck,
    bleedEdges,
    usableBleedRectMm,
    notes,
  };
}
