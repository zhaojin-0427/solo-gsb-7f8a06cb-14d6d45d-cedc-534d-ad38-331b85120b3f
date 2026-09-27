// preflight.js
// 印前文字安全区预检核心逻辑。
//
// 规则：
//   - 以每页可见页框（CropBox，经页面旋转后的视口）为界；
//   - 奇数页左侧、偶数页右侧为装订边，使用装订边距；其余三边使用裁切边距；
//   - 页内旋转文字取“变换后的轴对齐外接框”（AABB）；
//   - 文本框穿入某边禁入带（距离 < 边距）才报风险，恰好贴边不报；
//     同一文本触及多边时逐边列出；越出页框的距离记为负值；
//   - 无可提取文字的页标记为“无法判断”（图像文字未纳入检查）。
//
// 文本几何取自 PDF.js TextItem：transform 为文本空间→用户空间矩阵
// （e/f 为基线起点），width/height 已是用户空间单位（pt）。
// 文本框 = 基线起点沿书写方向延伸 width、沿升高方向延伸 height 的平行四边形，
// 旋转文字先变换再取轴对齐外接框。

import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';

export class PreflightError extends Error {
  constructor(message) {
    super(message);
    this.name = 'PreflightError';
  }
}

export const PT_PER_MM = 72 / 25.4;
// 贴边容差（pt）：距离恰好等于边距（含微小浮动误差）时不报风险
export const EDGE_EPS_PT = 0.01;

export const EDGE_NAMES = {
  left: '左',
  right: '右',
  top: '上',
  bottom: '下',
};
const EDGE_ORDER = ['left', 'right', 'top', 'bottom'];

export const NO_TEXT_NOTE =
  '该页未提取到文字，无法判断；图像中的文字未纳入检查。';

/** 奇数页装订边在左，偶数页在右。pageNumber 为 1 起页号。 */
export function bindingEdgeForPage(pageNumber) {
  return pageNumber % 2 === 1 ? 'left' : 'right';
}

/** 2D 仿射矩阵复合：m = m1 ∘ m2（先应用 m2，再应用 m1）。 */
export function multiplyTransform(m1, m2) {
  return [
    m1[0] * m2[0] + m1[2] * m2[1],
    m1[1] * m2[0] + m1[3] * m2[1],
    m1[0] * m2[2] + m1[2] * m2[3],
    m1[1] * m2[2] + m1[3] * m2[3],
    m1[0] * m2[4] + m1[2] * m2[5] + m1[4],
    m1[1] * m2[4] + m1[3] * m2[5] + m1[5],
  ];
}

export function applyTransform(m, x, y) {
  return [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]];
}

/**
 * 由 PDF.js 文本项计算其在用户空间中的轴对齐外接框。
 * item.transform = [a,b,c,d,e,f]，item.width/height 为用户空间单位（pt）。
 * @returns {{x1:number,y1:number,x2:number,y2:number} | null} 退化项返回 null
 */
export function textItemAABB(item) {
  const t = item.transform;
  const w = item.width;
  const h = item.height;
  if (!Array.isArray(t) || t.length < 6) return null;
  if (!(w > 0) || !(h > 0)) return null;

  const lenX = Math.hypot(t[0], t[1]); // 书写方向（基线方向）的缩放
  const lenY = Math.hypot(t[2], t[3]); // 升高方向的缩放
  if (lenX === 0 || lenY === 0) return null;

  const ux = t[0] / lenX;
  const uy = t[1] / lenX;
  const vx = t[2] / lenY;
  const vy = t[3] / lenY;

  // 文本空间四角：(0,0) (w,0) (0,h) (w,h)，原点为基线起点
  const xs = [];
  const ys = [];
  for (const [px, py] of [
    [0, 0],
    [w, 0],
    [0, h],
    [w, h],
  ]) {
    xs.push(t[4] + px * ux + py * vx);
    ys.push(t[5] + px * uy + py * vy);
  }
  return {
    x1: Math.min(...xs),
    y1: Math.min(...ys),
    x2: Math.max(...xs),
    y2: Math.max(...ys),
  };
}

/**
 * 文本框到可见页框四边的距离（pt，页内为正，越出页框为负）。
 * 视口空间：原点在页框左上角，y 轴向下。
 */
export function edgeDistances(aabb, pageWidth, pageHeight) {
  return {
    left: aabb.x1,
    right: pageWidth - aabb.x2,
    top: aabb.y1,
    bottom: pageHeight - aabb.y2,
  };
}

/**
 * 判定穿入禁入带的边：距离严格小于（边距 − 容差）才算穿入，恰好贴边不报。
 * @param distances edgeDistances 的结果（pt）
 * @param requiredPt 各边要求的边距（pt）：{left,right,top,bottom}
 * @returns {Array<{edge:string, distancePt:number, requiredPt:number}>} 按 左右上下 排序
 */
export function findRiskEdges(distances, requiredPt) {
  const risks = [];
  for (const edge of EDGE_ORDER) {
    const required = requiredPt[edge];
    const distance = distances[edge];
    if (distance < required - EDGE_EPS_PT) {
      risks.push({ edge, distancePt: distance, requiredPt: required });
    }
  }
  return risks;
}

export function isEncryptedError(err) {
  return (
    err &&
    (err.name === 'PasswordException' ||
      /password|encrypt/i.test(err.message || ''))
  );
}

function round1(n) {
  return Math.round(n * 10) / 10;
}

/**
 * 预检主流程：校验上传文件与边距，逐页提取文字并判定安全区风险。
 * @param {Buffer} buffer 上传的原始 PDF 字节
 * @param {{trimMarginMm:number, bindingMarginMm:number}} margins 毫米
 */
export async function analyzeTextSafety(buffer, { trimMarginMm, bindingMarginMm }) {
  if (!Buffer.isBuffer(buffer) || buffer.length === 0) {
    throw new PreflightError('上传文件为空，请选择有效的 PDF 文件。');
  }
  const head = buffer.subarray(0, 5).toString('latin1');
  if (head !== '%PDF-') {
    throw new PreflightError('文件不是有效的 PDF（文件头损坏或并非 PDF 文件）。');
  }

  for (const [label, value] of [
    ['裁切边距', trimMarginMm],
    ['装订边距', bindingMarginMm],
  ]) {
    if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
      throw new PreflightError(`${label}必须为大于 0 的数字（毫米）。`);
    }
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
      throw new PreflightError('该 PDF 已加密，请先解除密码/加密后再上传。');
    }
    throw new PreflightError(`PDF 文件损坏或无法解析：${err.message}`);
  }

  try {
    if (doc.numPages === 0) {
      throw new PreflightError('PDF 中没有任何页面。');
    }

    // 逐页取可见页框（视口，scale=1 时单位为 pt），并求最短边用于边距上限校验
    const viewports = [];
    let minShortSideMm = Infinity;
    for (let p = 1; p <= doc.numPages; p++) {
      const page = await doc.getPage(p);
      const viewport = page.getViewport({ scale: 1 });
      viewports.push(viewport);
      const shortSideMm = Math.min(viewport.width, viewport.height) / PT_PER_MM;
      if (shortSideMm < minShortSideMm) minShortSideMm = shortSideMm;
    }

    const limitMm = minShortSideMm / 2;
    for (const [label, value] of [
      ['裁切边距', trimMarginMm],
      ['装订边距', bindingMarginMm],
    ]) {
      if (value >= limitMm) {
        throw new PreflightError(
          `${label}必须小于页面短边的一半（本文档最短边 ${round1(
            minShortSideMm
          )} mm，边距须小于 ${round1(limitMm)} mm）。`
        );
      }
    }

    const trimPt = trimMarginMm * PT_PER_MM;
    const bindingPt = bindingMarginMm * PT_PER_MM;

    const pages = [];
    for (let p = 1; p <= doc.numPages; p++) {
      const page = await doc.getPage(p);
      const viewport = viewports[p - 1];
      const pageW = viewport.width;
      const pageH = viewport.height;
      const bindingEdge = bindingEdgeForPage(p);
      const requiredPt = {
        left: trimPt,
        right: trimPt,
        top: trimPt,
        bottom: trimPt,
      };
      requiredPt[bindingEdge] = bindingPt;

      const textContent = await page.getTextContent();
      let sawText = false;
      const items = [];

      for (const item of textContent.items) {
        if (typeof item.str !== 'string' || item.str.trim() === '') continue;
        sawText = true;
        const userAabb = textItemAABB(item);
        if (!userAabb) continue;

        // 用户空间 → 视口空间（可见页框左上角为原点，y 轴向下）
        const corners = [
          applyTransform(viewport.transform, userAabb.x1, userAabb.y1),
          applyTransform(viewport.transform, userAabb.x2, userAabb.y1),
          applyTransform(viewport.transform, userAabb.x1, userAabb.y2),
          applyTransform(viewport.transform, userAabb.x2, userAabb.y2),
        ];
        const aabb = {
          x1: Math.min(...corners.map((c) => c[0])),
          y1: Math.min(...corners.map((c) => c[1])),
          x2: Math.max(...corners.map((c) => c[0])),
          y2: Math.max(...corners.map((c) => c[1])),
        };

        const distances = edgeDistances(aabb, pageW, pageH);
        const riskEdges = findRiskEdges(distances, requiredPt);
        if (riskEdges.length === 0) continue;

        items.push({
          text: item.str,
          edges: riskEdges.map((r) => ({
            edge: r.edge,
            edgeName: EDGE_NAMES[r.edge],
            distanceMm: round1(r.distancePt / PT_PER_MM),
            requiredMm: round1(r.requiredPt / PT_PER_MM),
          })),
          minDistanceMm: round1(
            Math.min(
              distances.left,
              distances.right,
              distances.top,
              distances.bottom
            ) / PT_PER_MM
          ),
        });
      }

      pages.push({
        pageNumber: p,
        widthMm: round1(pageW / PT_PER_MM),
        heightMm: round1(pageH / PT_PER_MM),
        bindingEdge,
        bindingEdgeName: EDGE_NAMES[bindingEdge],
        status: items.length > 0 ? 'risk' : sawText ? 'ok' : 'no-text',
        note: sawText ? null : NO_TEXT_NOTE,
        items,
      });
    }

    const pagesWithRisk = pages.filter((pg) => pg.status === 'risk').length;
    const pagesNoText = pages.filter((pg) => pg.status === 'no-text').length;
    const riskItemCount = pages.reduce((n, pg) => n + pg.items.length, 0);

    return {
      trimMarginMm,
      bindingMarginMm,
      pageCount: doc.numPages,
      pages,
      summary: {
        totalPages: doc.numPages,
        pagesWithText: doc.numPages - pagesNoText,
        pagesNoText,
        pagesWithRisk,
        riskItemCount,
      },
    };
  } finally {
    await doc.destroy().catch(() => {});
  }
}
