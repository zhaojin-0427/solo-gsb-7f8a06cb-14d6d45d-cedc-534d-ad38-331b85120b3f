// fonts.js
// 原稿字体嵌入核查核心逻辑。
//
// 规则：
//   - 逐页读取页面（含自 Pages 父节点继承）的 Resources/Font 字体字典，
//     并递归进入页面资源中引用的 Form XObject，检查其自带 Resources 里的字体；
//     同一表单被多页引用时逐页计入；表单循环引用按页去重，不会死循环；
//   - 普通字体（Type1 / MMType1 / TrueType / CIDFont*）检查 FontDescriptor 中的
//     FontFile、FontFile2、FontFile3；Type0 字体沿 DescendantFonts 子字体查找；
//     对应字段为非空 PDF 流才算已嵌入，缺少描述符或字体流算未嵌入；
//   - Type3 字体字形由内容流内建定义，标为“内置字形”；
//   - 未嵌入的标准 14 字体（Helvetica、Times、Courier、Symbol、ZapfDingbats 族）
//     单列为“可替代”；
//   - 字体字典损坏（条目非字典、子类型无法识别、Type0 缺少子字体等）标为“无法判断”；
//   - 检查对象是资源字典中的字体引用，不判断字形是否在页面中实际绘制。
//
// 解析使用 pdf-lib 底层对象模型（PDFDict / PDFStream / PDFRef），
// 页面继承资源由 PDFPageLeaf.Resources()（getInheritableAttribute）取得。

import {
  PDFDocument,
  PDFArray,
  PDFDict,
  PDFHexString,
  PDFName,
  PDFRef,
  PDFStream,
  PDFString,
} from 'pdf-lib';

export class FontCheckError extends Error {
  constructor(message) {
    super(message);
    this.name = 'FontCheckError';
  }
}

// 标准 14 字体（未嵌入时可由查看器内置字体替代）
export const STANDARD_14_FONTS = [
  'Courier',
  'Courier-Bold',
  'Courier-Oblique',
  'Courier-BoldOblique',
  'Helvetica',
  'Helvetica-Bold',
  'Helvetica-Oblique',
  'Helvetica-BoldOblique',
  'Times-Roman',
  'Times-Bold',
  'Times-Italic',
  'Times-BoldItalic',
  'Symbol',
  'ZapfDingbats',
];
const STANDARD_14_SET = new Set(STANDARD_14_FONTS);

// FontDescriptor 中的字体程序流字段
export const FONT_FILE_KEYS = ['FontFile', 'FontFile2', 'FontFile3'];

// 简单字体子类型：直接在自身 FontDescriptor 上检查字体流
const SIMPLE_FONT_SUBTYPES = new Set([
  'Type1',
  'MMType1',
  'TrueType',
  'CIDFontType0',
  'CIDFontType2',
]);

// 字体引用状态
export const FONT_STATUS = {
  embedded: 'embedded', // 已嵌入
  notEmbedded: 'not-embedded', // 未嵌入
  standard14: 'standard14', // 可替代（标准 14 未嵌入）
  type3: 'type3', // 内置字形（Type3）
  unknown: 'unknown', // 无法判断（字典损坏等）
};

export const SCOPE_NOTE =
  '检查对象为页面及表单 XObject 资源字典中的字体引用（含继承的 Resources），' +
  '不判断字形是否在页面中实际绘制。';

/** 去掉子集前缀（形如 ABCDEF+），返回字体族名。 */
export function stripSubsetPrefix(baseFont) {
  if (typeof baseFont !== 'string') return baseFont;
  return baseFont.replace(/^[A-Z]{6}\+/, '');
}

/** 是否标准 14 字体（忽略子集前缀）。 */
export function isStandard14(baseFont) {
  if (typeof baseFont !== 'string') return false;
  return STANDARD_14_SET.has(stripSubsetPrefix(baseFont));
}

function nameText(pdfName) {
  try {
    return pdfName.decodeText();
  } catch {
    return String(pdfName);
  }
}

/** 读取字体字典的 BaseFont（PDFName 或字符串对象），失败返回 null。 */
function readBaseFont(fontDict) {
  try {
    const value = fontDict.get(PDFName.of('BaseFont'));
    if (value instanceof PDFName) return nameText(value);
    if (value instanceof PDFString || value instanceof PDFHexString) {
      return value.decodeText();
    }
  } catch {
    // 忽略，按缺失处理
  }
  return null;
}

/**
 * 检查字体字典的 FontDescriptor 中是否有非空字体流。
 * @returns {{embedded:boolean, keys:string[], reason:string|null}}
 */
function checkDescriptorEmbedding(context, fontDict) {
  const descriptor = fontDict.lookupMaybe(
    PDFName.of('FontDescriptor'),
    PDFDict
  );
  if (!descriptor) {
    return {
      embedded: false,
      keys: [],
      reason: '缺少 FontDescriptor 字体描述符',
    };
  }
  const keys = [];
  let sawEmptyStream = false;
  for (const key of FONT_FILE_KEYS) {
    const stream = descriptor.lookupMaybe(PDFName.of(key), PDFStream);
    if (!stream) continue;
    if (stream.getContentsSize() > 0) keys.push(key);
    else sawEmptyStream = true;
  }
  if (keys.length > 0) return { embedded: true, keys, reason: null };
  return {
    embedded: false,
    keys: [],
    reason: sawEmptyStream
      ? '字体流为空（非空 PDF 流才算已嵌入）'
      : 'FontDescriptor 中无 FontFile/FontFile2/FontFile3 字体流',
  };
}

/** 按嵌入检查结果落地条目状态；未嵌入时标准 14 单列为可替代。 */
function applyEmbeddingResult(entry, results) {
  if (results.every((r) => r.embedded)) {
    entry.status = FONT_STATUS.embedded;
    const keys = [...new Set(results.flatMap((r) => r.keys))];
    entry.note = `字体文件已嵌入（${keys.join('、')}）。`;
    return;
  }
  if (isStandard14(entry.baseFont)) {
    entry.status = FONT_STATUS.standard14;
    entry.note =
      '标准 14 字体未嵌入；属可替代字体，查看器通常以内置字体显示。';
    return;
  }
  entry.status = FONT_STATUS.notEmbedded;
  const reasons = [...new Set(results.map((r) => r.reason).filter(Boolean))];
  entry.note = reasons.length > 0 ? `${reasons.join('；')}。` : '未嵌入字体文件。';
}

/** 分析单个字体字典，结果写入 entry（就地修改）。 */
function analyzeFontDict(context, fontDict, entry) {
  const subtypeValue = fontDict.get(PDFName.of('Subtype'));
  const subtype = subtypeValue instanceof PDFName ? nameText(subtypeValue) : null;
  entry.subtype = subtype;
  entry.baseFont = readBaseFont(fontDict);

  if (subtype === 'Type3') {
    entry.status = FONT_STATUS.type3;
    entry.note = 'Type3 字体：字形由 PDF 内容流内建定义，无需嵌入字体文件。';
    return;
  }

  if (subtype === 'Type0') {
    // Type0 复合字体：沿 DescendantFonts 子字体查找字体流
    const descendants = fontDict.lookupMaybe(
      PDFName.of('DescendantFonts'),
      PDFArray
    );
    if (!descendants || descendants.size() === 0) {
      entry.status = FONT_STATUS.unknown;
      entry.note = 'Type0 字体缺少 DescendantFonts 子字体，字体字典不完整。';
      return;
    }
    const results = [];
    for (let i = 0; i < descendants.size(); i++) {
      const descendant = context.lookup(descendants.get(i));
      if (!(descendant instanceof PDFDict)) {
        entry.status = FONT_STATUS.unknown;
        entry.note = 'DescendantFonts 子字体不是字典对象，字体字典损坏。';
        return;
      }
      results.push(checkDescriptorEmbedding(context, descendant));
    }
    applyEmbeddingResult(entry, results);
    return;
  }

  if (SIMPLE_FONT_SUBTYPES.has(subtype)) {
    applyEmbeddingResult(entry, [checkDescriptorEmbedding(context, fontDict)]);
    return;
  }

  entry.status = FONT_STATUS.unknown;
  entry.note = subtype
    ? `无法识别的字体子类型 /${subtype}。`
    : '字体字典缺少 Subtype，无法识别。';
}

/** 分析一个 /Font 资源条目（值为字体字典或其间接引用）。 */
function analyzeFontEntry(context, nameObj, value, sourceChain) {
  const entry = {
    resourceName: nameObj instanceof PDFName ? nameText(nameObj) : String(nameObj),
    baseFont: null,
    subtype: null,
    source:
      sourceChain.length === 0
        ? '页面资源'
        : `表单 XObject ${sourceChain.map((n) => `/${n}`).join(' → ')}`,
    status: FONT_STATUS.unknown,
    note: null,
  };

  let fontDict;
  try {
    fontDict = context.lookup(value);
  } catch (err) {
    entry.note = `字体对象解析失败：${err.message}`;
    return entry;
  }
  if (!(fontDict instanceof PDFDict)) {
    entry.note = '字体条目不是字典对象，字体字典损坏。';
    return entry;
  }

  try {
    analyzeFontDict(context, fontDict, entry);
  } catch (err) {
    entry.status = FONT_STATUS.unknown;
    entry.note = `字体字典读取失败：${err.message}`;
  }
  return entry;
}

/**
 * 收集一个资源字典中的字体条目，并递归进入 Form XObject 的自带资源。
 * @param {PDFDict} resourcesDict 资源字典
 * @param {string[]} sourceChain 表单来源链（空数组表示页面资源）
 * @param {Set<string>} visitedForms 本页已访问的表单引用（循环去重）
 * @param {Array} out 输出数组（就地追加）
 */
function collectResourceFonts(context, resourcesDict, sourceChain, visitedForms, out) {
  let fontDict;
  try {
    fontDict = resourcesDict.lookupMaybe(PDFName.of('Font'), PDFDict);
  } catch {
    fontDict = undefined;
  }
  if (fontDict) {
    for (const [nameObj, value] of fontDict.entries()) {
      out.push(analyzeFontEntry(context, nameObj, value, sourceChain));
    }
  }

  let xobjectDict;
  try {
    xobjectDict = resourcesDict.lookupMaybe(PDFName.of('XObject'), PDFDict);
  } catch {
    xobjectDict = undefined;
  }
  if (!xobjectDict) return;

  for (const [nameObj, value] of xobjectDict.entries()) {
    let stream;
    try {
      stream = context.lookup(value);
    } catch {
      continue; // 损坏的 XObject 引用与字体无关，跳过
    }
    if (!(stream instanceof PDFStream)) continue;

    let isForm = false;
    try {
      const subtype = stream.dict.get(PDFName.of('Subtype'));
      isForm = subtype instanceof PDFName && nameText(subtype) === 'Form';
    } catch {
      isForm = false;
    }
    if (!isForm) continue;

    // 循环引用防护：间接引用的表单按引用标记，本页内只进入一次；
    // 直接对象（非引用）天然树形，不可能成环
    if (value instanceof PDFRef) {
      if (visitedForms.has(value.tag)) continue;
      visitedForms.add(value.tag);
    }

    let formResources;
    try {
      formResources = stream.dict.lookupMaybe(PDFName.of('Resources'), PDFDict);
    } catch {
      formResources = undefined;
    }
    if (!formResources) continue;

    const formName = nameObj instanceof PDFName ? nameText(nameObj) : String(nameObj);
    collectResourceFonts(
      context,
      formResources,
      [...sourceChain, formName],
      visitedForms,
      out
    );
  }
}

/**
 * 字体嵌入核查主流程：校验上传文件，逐页收集字体资源引用并判定嵌入状态。
 * @param {Buffer} buffer 上传的原始 PDF 字节
 */
export async function checkFontEmbedding(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length === 0) {
    throw new FontCheckError('上传文件为空，请选择有效的 PDF 文件。');
  }
  const head = buffer.subarray(0, 5).toString('latin1');
  if (head !== '%PDF-') {
    throw new FontCheckError('文件不是有效的 PDF（文件头损坏或并非 PDF 文件）。');
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
      throw new FontCheckError('该 PDF 已加密，请先解除密码/加密后再上传。');
    }
    throw new FontCheckError(`PDF 文件损坏或无法解析：${err.message}`);
  }

  // 双保险：检查 trailer 中的 Encrypt 字典（个别加密文档的报错信息不含 encrypt）
  try {
    const encrypt =
      doc.context.trailer && doc.context.trailer.dict
        ? doc.context.trailer.dict.get('Encrypt')
        : undefined;
    if (encrypt) {
      throw new FontCheckError('该 PDF 已加密，请先解除密码/加密后再上传。');
    }
  } catch (err) {
    if (err instanceof FontCheckError) throw err;
    // 字典访问异常不影响主流程
  }

  if (pdfPages.length === 0) {
    throw new FontCheckError('PDF 中没有任何页面。');
  }

  const context = doc.context;
  const pages = [];
  for (let i = 0; i < pdfPages.length; i++) {
    const fonts = [];
    let resourceError = null;
    let resources;
    try {
      // 含自 Pages 父节点继承的 Resources
      resources = pdfPages[i].node.Resources();
    } catch (err) {
      resources = undefined;
      resourceError = `页面资源字典读取失败：${err.message}`;
    }
    if (resources) {
      try {
        // 表单访问集合按页独立：同一表单被多页引用时逐页计入
        collectResourceFonts(context, resources, [], new Set(), fonts);
      } catch (err) {
        resourceError = `页面资源遍历失败：${err.message}`;
      }
    }

    let status;
    let note = null;
    if (resourceError) {
      status = 'unknown';
      note = resourceError;
    } else if (fonts.some((f) => f.status === FONT_STATUS.notEmbedded)) {
      status = 'risk';
    } else if (fonts.some((f) => f.status === FONT_STATUS.unknown)) {
      status = 'unknown';
    } else {
      status = 'ok';
      if (fonts.length === 0) note = '本页未引用字体资源。';
    }

    pages.push({ pageNumber: i + 1, status, note, fonts });
  }

  const countFonts = (s) =>
    pages.reduce((n, pg) => n + pg.fonts.filter((f) => f.status === s).length, 0);
  const countPages = (pred) => pages.filter(pred).length;

  return {
    pageCount: pdfPages.length,
    pages,
    summary: {
      totalPages: pdfPages.length,
      totalFontRefs: pages.reduce((n, pg) => n + pg.fonts.length, 0),
      pagesWithUnembedded: countPages((pg) =>
        pg.fonts.some((f) => f.status === FONT_STATUS.notEmbedded)
      ),
      pagesWithStandard14: countPages((pg) =>
        pg.fonts.some((f) => f.status === FONT_STATUS.standard14)
      ),
      pagesWithUnknown: countPages(
        (pg) =>
          pg.status === 'unknown' ||
          pg.fonts.some((f) => f.status === FONT_STATUS.unknown)
      ),
      embedded: countFonts(FONT_STATUS.embedded),
      notEmbedded: countFonts(FONT_STATUS.notEmbedded),
      standard14: countFonts(FONT_STATUS.standard14),
      type3: countFonts(FONT_STATUS.type3),
      unknown: countFonts(FONT_STATUS.unknown),
    },
    scopeNote: SCOPE_NOTE,
  };
}
