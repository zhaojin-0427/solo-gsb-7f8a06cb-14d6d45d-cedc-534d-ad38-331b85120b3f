// imageresolution.js
// 原稿位图有效分辨率预检核心逻辑。
//
// 规则：
//   - 用户输入最低分辨率（72～1200 DPI）；只核查实际绘制的普通 Image XObject，
//     仅在资源字典中出现、内容流里未绘制的图片不计入；
//   - 读取 PDF.js 绘制指令（operatorList），随 save/restore 与 transform（cm）
//     追踪图形状态（CTM），Form XObject 的嵌套变换通过 paintFormXObjectBegin
//     携带的 Matrix 一并追踪；同一图像多次放置时逐次计算；
//   - 每次绘制时，以图像像素宽、高分别除以变换后的横、纵边长（英寸）得到
//     横向、纵向两个 DPI，取较小值与阈值比较，严格低于阈值才报风险
//     （恰好等于阈值不报）；旋转与非等比缩放按各自边长分别计算；
//   - 内联图像（BI…EI，paintInlineImageXObject）、图像蒙版（ImageMask，
//     paintImageMaskXObject*）不纳入检查；不判断图像是否被裁切或遮挡。
//
// 几何说明：PDF 图像绘制时图像单位正方形 [0,1]×[0,1] 经 CTM 映射到页面，
// 因此图像横边（x 方向）在用户空间的向量为 (ctm.a, ctm.b)，纵边（y 方向）
// 向量为 (ctm.c, ctm.d)，边长（pt）即向量模长；除以 72 pt/英寸后与像素数相除。

import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';
import {
  multiplyTransform,
  isEncryptedError,
  PT_PER_MM,
} from './preflight.js';

export class ImageResolutionError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ImageResolutionError';
  }
}

export const PT_PER_INCH = 72;
export const MIN_DPI = 72;
export const MAX_DPI = 1200;
// 严格低于阈值才报风险，浮点容差（DPI）：差值在容差内视为恰好相等
export const DPI_EPS = 1e-6;

export const NO_IMAGE_NOTE = '本页无位图绘制。';
export const SCOPE_NOTE =
  '只检查内容流中实际绘制的普通 Image XObject；内联图像（BI…EI）、' +
  '图像蒙版（ImageMask）不纳入检查；不判断图像是否被裁切或遮挡。';

/** 2D 仿射矩阵复合：m = m1 ∘ m2（先应用 m2，再应用 m1）。 */
export function concatTransform(m1, m2) {
  return multiplyTransform(m1, m2);
}

export const IDENTITY = [1, 0, 0, 1, 0, 0];

/**
 * 计算一次图像放置的有效 DPI。
 *
 * 图像单位正方形经 CTM 映射：
 *   横边向量 = (ctm[0], ctm[1])，长度 = 图像横向绘制边长
 *   纵边向量 = (ctm[2], ctm[3])，长度 = 图像纵向绘制边长
 * （PDF.js 绘制图像时的 y 轴翻转发生在图像内部坐标，不改变边长。）
 *
 * @param {number} pixelWidth 图像像素宽 W
 * @param {number} pixelHeight 图像像素高 H
 * @param {number[]} ctm 绘制时的当前变换矩阵 [a,b,c,d,e,f]
 * @returns {{widthPt:number, heightPt:number, dpiX:number, dpiY:number, minDpi:number} | null}
 *   退化（边长为 0，实际不可见）时返回 null
 */
export function placementResolution(pixelWidth, pixelHeight, ctm) {
  const widthPt = Math.hypot(ctm[0], ctm[1]);
  const heightPt = Math.hypot(ctm[2], ctm[3]);
  if (!(widthPt > 0) || !(heightPt > 0)) return null;

  const widthIn = widthPt / PT_PER_INCH;
  const heightIn = heightPt / PT_PER_INCH;
  const dpiX = pixelWidth / widthIn;
  const dpiY = pixelHeight / heightIn;
  return {
    widthPt,
    heightPt,
    dpiX,
    dpiY,
    minDpi: Math.min(dpiX, dpiY),
  };
}

/**
 * 扫描一页的 PDF.js 绘制指令，逐次收集实际绘制的普通 Image XObject 的
 * 放置信息。随 save/restore/transform 追踪 CTM，Form XObject 的 Matrix
 * 与嵌套层级一并处理。
 *
 * 计入：OPS.paintImageXObject（普通 Image XObject；参数 [objId, W, H]）。
 * 不计入：paintInlineImageXObject（内联图像）、paintImageMaskXObject*
 * （图像蒙版）、paintXObject 之外的表单/图案内部资源。
 *
 * @param {{fnArray:number[], argsArray:Array}} operatorList page.getOperatorList 结果
 * @returns {Array<{pixelWidth:number, pixelHeight:number, ctm:number[],
 *   formDepth:number, widthPt:number, heightPt:number, dpiX:number, dpiY:number,
 *   minDpi:number, risk:boolean}>}
 */
export function collectImagePlacements(operatorList, minDpi) {
  const { fnArray, argsArray } = operatorList;
  const OPS = pdfjs.OPS;
  // 图形状态栈：save 压栈当前 CTM，restore 出栈
  const stack = [];
  let ctm = [...IDENTITY];
  let formDepth = 0;
  const placements = [];

  for (let i = 0; i < fnArray.length; i++) {
    const fn = fnArray[i];
    const args = argsArray[i];

    switch (fn) {
      case OPS.save:
        stack.push(ctm);
        ctm = [...ctm];
        break;

      case OPS.restore:
        ctm = stack.pop() ?? [...IDENTITY];
        break;

      case OPS.transform: {
        // cm：CTM = CTM × M（PDF 规定左连接）
        if (Array.isArray(args) && args.length === 6) {
          ctm = concatTransform(ctm, args);
        }
        break;
      }

      case OPS.paintFormXObjectBegin: {
        // paintFormXObjectBegin(matrix, bbox)：渲染端先 save 再应用表单 Matrix
        stack.push(ctm);
        ctm = [...ctm];
        formDepth++;
        const matrix = Array.isArray(args) ? args[0] : null;
        if (Array.isArray(matrix) && matrix.length === 6) {
          ctm = concatTransform(ctm, matrix);
        }
        break;
      }

      case OPS.paintFormXObjectEnd:
        ctm = stack.pop() ?? [...IDENTITY];
        formDepth = Math.max(0, formDepth - 1);
        break;

      case OPS.paintImageXObject: {
        // args = [objId, pixelWidth, pixelHeight]
        if (!Array.isArray(args) || args.length < 3) break;
        const pixelWidth = args[1];
        const pixelHeight = args[2];
        if (
          typeof pixelWidth !== 'number' ||
          typeof pixelHeight !== 'number' ||
          !(pixelWidth > 0) ||
          !(pixelHeight > 0)
        ) {
          break;
        }
        const result = placementResolution(pixelWidth, pixelHeight, ctm);
        if (!result) break; // 退化（零边长）放置不可见，跳过
        placements.push({
          pixelWidth,
          pixelHeight,
          ctm: [...ctm],
          formDepth,
          widthPt: result.widthPt,
          heightPt: result.heightPt,
          dpiX: result.dpiX,
          dpiY: result.dpiY,
          minDpi: result.minDpi,
          risk: result.minDpi < minDpi - DPI_EPS,
        });
        break;
      }

      // 内联图像（OPS.paintInlineImageXObject）与图像蒙版
      // （OPS.paintImageMaskXObject / paintImageMaskXObjectGroup /
      // paintSolidColorImageMask）按规则忽略，不做处理。
      default:
        break;
    }
  }

  return placements;
}

function round1(n) {
  return Math.round(n * 10) / 10;
}

function roundDpi(n) {
  // 分辨率保留 1 位小数，避免浮点显示噪音
  return Math.round(n * 10) / 10;
}

function ptToMm(pt) {
  return pt / PT_PER_MM;
}

/**
 * 有效分辨率预检主流程：校验上传文件与阈值，逐页读取绘制指令并计算每次
 * 普通位图放置的两个 DPI，严格低于阈值的放置计为风险。
 * @param {Buffer} buffer 上传的原始 PDF 字节
 * @param {{minDpi:number}} options minDpi 最低分辨率阈值（72～1200）
 */
export async function analyzeImageResolution(buffer, { minDpi }) {
  if (!Buffer.isBuffer(buffer) || buffer.length === 0) {
    throw new ImageResolutionError('上传文件为空，请选择有效的 PDF 文件。');
  }
  const head = buffer.subarray(0, 5).toString('latin1');
  if (head !== '%PDF-') {
    throw new ImageResolutionError(
      '文件不是有效的 PDF（文件头损坏或并非 PDF 文件）。'
    );
  }

  if (
    typeof minDpi !== 'number' ||
    !Number.isFinite(minDpi) ||
    minDpi < MIN_DPI ||
    minDpi > MAX_DPI
  ) {
    throw new ImageResolutionError(
      `最低分辨率必须为 ${MIN_DPI}～${MAX_DPI} DPI 之间的数字。`
    );
  }

  let doc;
  try {
    doc = await pdfjs.getDocument({
      data: new Uint8Array(buffer),
      useWorkerFetch: false,
      isEvalSupported: false,
      disableFontFace: true,
      verbosity: 0, // 仅报错，屏蔽标准字体等提示性警告
    }).promise;
  } catch (err) {
    if (isEncryptedError(err)) {
      throw new ImageResolutionError(
        '该 PDF 已加密，请先解除密码/加密后再上传。'
      );
    }
    throw new ImageResolutionError(
      `PDF 文件损坏或无法解析：${err.message}`
    );
  }

  try {
    if (doc.numPages === 0) {
      throw new ImageResolutionError('PDF 中没有任何页面。');
    }

    const pages = [];
    for (let p = 1; p <= doc.numPages; p++) {
      const page = await doc.getPage(p);
      const viewport = page.getViewport({ scale: 1 });

      let placements = [];
      let parseError = null;
      try {
        // OPLIST 意图下 PDF.js 不做渲染端的批量合并（NullOptimizer），
        // 得到的是与内容流指令一一对应的原始绘制序列。
        const operatorList = await page.getOperatorList({
          annotationMode: pdfjs.AnnotationMode.DISABLE,
        });
        placements = collectImagePlacements(operatorList, minDpi);
      } catch (err) {
        parseError = `绘制指令解析失败：${err.message}`;
      }

      const images = placements.map((pl, idx) => ({
        index: idx + 1,
        pixelWidth: pl.pixelWidth,
        pixelHeight: pl.pixelHeight,
        widthMm: round1(ptToMm(pl.widthPt)),
        heightMm: round1(ptToMm(pl.heightPt)),
        widthPt: round1(pl.widthPt),
        heightPt: round1(pl.heightPt),
        dpiX: roundDpi(pl.dpiX),
        dpiY: roundDpi(pl.dpiY),
        minDpi: roundDpi(pl.minDpi),
        inForm: pl.formDepth > 0,
        risk: pl.risk,
      }));

      const riskCount = images.reduce((n, im) => n + (im.risk ? 1 : 0), 0);

      let status;
      let note = null;
      if (parseError) {
        status = 'unknown';
        note = parseError;
      } else if (images.length === 0) {
        status = 'no-image';
        note = NO_IMAGE_NOTE;
      } else if (riskCount > 0) {
        status = 'risk';
      } else {
        status = 'ok';
      }

      pages.push({
        pageNumber: p,
        widthMm: round1(viewport.width / PT_PER_MM),
        heightMm: round1(viewport.height / PT_PER_MM),
        status,
        note,
        imageCount: images.length,
        riskCount,
        images,
      });
    }

    const totalPlacements = pages.reduce((n, pg) => n + pg.imageCount, 0);
    const totalRisks = pages.reduce((n, pg) => n + pg.riskCount, 0);
    return {
      minDpi,
      pageCount: doc.numPages,
      pages,
      summary: {
        totalPages: doc.numPages,
        pagesWithImage: pages.filter((pg) => pg.imageCount > 0).length,
        pagesWithoutImage: pages.filter((pg) => pg.status === 'no-image').length,
        pagesWithRisk: pages.filter((pg) => pg.status === 'risk').length,
        pagesUnknown: pages.filter((pg) => pg.status === 'unknown').length,
        totalPlacements,
        riskPlacements: totalRisks,
      },
      scopeNote: SCOPE_NOTE,
    };
  } finally {
    await doc.destroy().catch(() => {});
  }
}
