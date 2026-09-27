// pagenumbers.js
// 原稿页脚页码核对核心逻辑。
//
// 规则：
//   - 用户指定首个带页码的 PDF 页序（1 起）、该页印刷页码（正整数）与
//     页脚带高度（毫米，> 0 且小于最矮页高度的一半）；
//   - 首个带页码页之前的页跳过；自该页起期望页码按 PDF 页序逐页 +1，
//     不随提取结果调整；
//   - 只识别完整落在可见页框（CropBox，含页面旋转后的视口）底部带内的
//     横排（书写方向水平朝右）纯阿拉伯数字文本（半角 0-9、全角 ０-９）；
//   - 同基线（纵向容差内）且水平间隔 ≤ 2mm 的数字片段按几何位置
//     （x 升序）拼接为一个候选，不按提取顺序盲连；
//   - 每页恰有一个候选才与期望页码核对；无候选或多个候选标记“无法判断”；
//   - 图像（扫描件）中的页码未纳入识别。
//
// 文本几何取自 PDF.js TextItem（同 preflight.js）：transform 为文本空间→
// 用户空间矩阵（e/f 为基线起点），width/height 为用户空间单位（pt）。

import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';
import {
  PT_PER_MM,
  textItemAABB,
  applyTransform,
  isEncryptedError,
} from './preflight.js';

export class PageNumberError extends Error {
  constructor(message) {
    super(message);
    this.name = 'PageNumberError';
  }
}

// 数字片段拼接允许的最大水平间隔（pt）：2 毫米
export const JOIN_GAP_PT = 2 * PT_PER_MM;
// 同基线判定的纵向容差（pt）
export const BASELINE_TOLERANCE_PT = 1;
// 文本框落带判定的容差（pt）
const BAND_EPS_PT = 0.01;
// 横排判定：视口空间中书写方向的纵向分量占比上限
const HORIZONTAL_DIR_EPS = 1e-3;

const DIGIT_FRAGMENT_RE = /^[0-9０-９]+$/;

/** 是否纯阿拉伯数字片段：trim 后全部为半角 0-9 或全角 ０-９。 */
export function isDigitFragment(str) {
  return typeof str === 'string' && DIGIT_FRAGMENT_RE.test(str.trim());
}

/** 全角数字转半角，其余字符原样保留。 */
export function normalizeDigits(str) {
  return str.replace(/[０-９]/g, (ch) =>
    String.fromCharCode(ch.charCodeAt(0) - 0xfee0)
  );
}

/**
 * 由一页底部带内的数字片段拼接页码候选。
 * 同基线（纵向差 ≤ BASELINE_TOLERANCE_PT）的片段归为一组；
 * 组内按 x 升序排列，相邻片段水平间隔 ≤ JOIN_GAP_PT 的依次拼接，
 * 间隔更大时断开为新候选。拼接顺序只取决于几何位置，与提取顺序无关。
 *
 * @param {Array<{text:string, baselineY:number, startX:number, x1:number, x2:number}>} fragments
 * @returns {Array<{text:string, value:number}>}
 */
export function buildCandidates(fragments) {
  const sorted = [...fragments].sort(
    (a, b) => a.baselineY - b.baselineY || a.startX - b.startX
  );

  // 按基线聚类：与所在组基准（组内首个片段）的纵向差在容差内即同组
  const lines = [];
  for (const frag of sorted) {
    const line = lines[lines.length - 1];
    if (
      line &&
      Math.abs(frag.baselineY - line.baselineY) <= BASELINE_TOLERANCE_PT
    ) {
      line.fragments.push(frag);
    } else {
      lines.push({ baselineY: frag.baselineY, fragments: [frag] });
    }
  }

  const candidates = [];
  for (const line of lines) {
    const frags = [...line.fragments].sort((a, b) => a.startX - b.startX);
    let current = null;
    for (const frag of frags) {
      if (current && frag.x1 - current.x2 <= JOIN_GAP_PT) {
        current.text += frag.text;
        current.x2 = Math.max(current.x2, frag.x2);
      } else {
        if (current) candidates.push(current);
        current = { text: frag.text, x2: frag.x2 };
      }
    }
    if (current) candidates.push(current);
  }

  return candidates.map((c) => ({
    text: c.text,
    value: parseInt(normalizeDigits(c.text), 10),
  }));
}

function round1(n) {
  return Math.round(n * 10) / 10;
}

/**
 * 提取一页底部带内的横排纯数字片段（视口坐标，原点为可见页框左上角）。
 * 只保留：书写方向水平朝右、文本框完整落在底部带内、纯阿拉伯数字的文本项。
 */
async function collectDigitFragments(page, viewport, bandPt) {
  const textContent = await page.getTextContent();
  const pageW = viewport.width;
  const pageH = viewport.height;
  const bandTop = pageH - bandPt;
  const vt = viewport.transform;

  const fragments = [];
  for (const item of textContent.items) {
    if (typeof item.str !== 'string' || item.str.trim() === '') continue;
    if (!isDigitFragment(item.str)) continue;

    const t = item.transform;
    if (!Array.isArray(t) || t.length < 6) continue;

    // 书写方向（用户空间）→ 视口空间，仅保留水平朝右的横排文字
    const dirX = vt[0] * t[0] + vt[2] * t[1];
    const dirY = vt[1] * t[0] + vt[3] * t[1];
    const dirLen = Math.hypot(dirX, dirY);
    if (dirLen === 0) continue;
    if (Math.abs(dirY) > dirLen * HORIZONTAL_DIR_EPS || dirX <= 0) continue;

    // 用户空间 → 视口空间（可见页框左上角为原点，y 轴向下）
    const userAabb = textItemAABB(item);
    if (!userAabb) continue;
    const corners = [
      applyTransform(vt, userAabb.x1, userAabb.y1),
      applyTransform(vt, userAabb.x2, userAabb.y1),
      applyTransform(vt, userAabb.x1, userAabb.y2),
      applyTransform(vt, userAabb.x2, userAabb.y2),
    ];
    const aabb = {
      x1: Math.min(...corners.map((c) => c[0])),
      y1: Math.min(...corners.map((c) => c[1])),
      x2: Math.max(...corners.map((c) => c[0])),
      y2: Math.max(...corners.map((c) => c[1])),
    };

    // 文本框须完整落在可见页框底部带内
    if (aabb.y1 < bandTop - BAND_EPS_PT || aabb.y2 > pageH + BAND_EPS_PT) {
      continue;
    }
    if (aabb.x1 < -BAND_EPS_PT || aabb.x2 > pageW + BAND_EPS_PT) continue;

    const [startX, startY] = applyTransform(vt, t[4], t[5]);
    fragments.push({
      text: item.str.trim(),
      baselineY: startY,
      startX,
      x1: aabb.x1,
      x2: aabb.x2,
    });
  }
  return fragments;
}

/**
 * 页码核对主流程：校验上传文件与参数，逐页提取页脚带内数字并与期望页码比对。
 * @param {Buffer} buffer 上传的原始 PDF 字节
 * @param {{firstPageIndex:number, firstPrintedNumber:number, footerBandMm:number}} options
 *   firstPageIndex 首个带页码的 PDF 页序（1 起）；firstPrintedNumber 该页印刷页码；
 *   footerBandMm 页脚带高度（毫米）
 */
export async function checkPageNumbers(
  buffer,
  { firstPageIndex, firstPrintedNumber, footerBandMm }
) {
  if (!Buffer.isBuffer(buffer) || buffer.length === 0) {
    throw new PageNumberError('上传文件为空，请选择有效的 PDF 文件。');
  }
  const head = buffer.subarray(0, 5).toString('latin1');
  if (head !== '%PDF-') {
    throw new PageNumberError(
      '文件不是有效的 PDF（文件头损坏或并非 PDF 文件）。'
    );
  }

  if (!Number.isInteger(firstPageIndex) || firstPageIndex < 1) {
    throw new PageNumberError('首个带页码的 PDF 页序必须为不小于 1 的整数。');
  }
  if (!Number.isInteger(firstPrintedNumber) || firstPrintedNumber < 1) {
    throw new PageNumberError('该页印刷页码必须为正整数。');
  }
  if (
    typeof footerBandMm !== 'number' ||
    !Number.isFinite(footerBandMm) ||
    footerBandMm <= 0
  ) {
    throw new PageNumberError('页脚带高度必须为大于 0 的数字（毫米）。');
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
      throw new PageNumberError('该 PDF 已加密，请先解除密码/加密后再上传。');
    }
    throw new PageNumberError(`PDF 文件损坏或无法解析：${err.message}`);
  }

  try {
    if (doc.numPages === 0) {
      throw new PageNumberError('PDF 中没有任何页面。');
    }
    if (firstPageIndex > doc.numPages) {
      throw new PageNumberError(
        `首个带页码的 PDF 页序超出范围：本文档共 ${doc.numPages} 页。`
      );
    }

    // 逐页取可见页框（视口，scale=1 时单位为 pt），并求最矮页高度用于带高上限校验
    const viewports = [];
    let minPageHeightMm = Infinity;
    for (let p = 1; p <= doc.numPages; p++) {
      const page = await doc.getPage(p);
      const viewport = page.getViewport({ scale: 1 });
      viewports.push(viewport);
      const heightMm = viewport.height / PT_PER_MM;
      if (heightMm < minPageHeightMm) minPageHeightMm = heightMm;
    }

    const bandLimitMm = minPageHeightMm / 2;
    if (footerBandMm >= bandLimitMm) {
      throw new PageNumberError(
        `页脚带高度必须小于最矮页高度的一半（本文档最矮页高 ${round1(
          minPageHeightMm
        )} mm，带高须小于 ${round1(bandLimitMm)} mm）。`
      );
    }

    const bandPt = footerBandMm * PT_PER_MM;

    const pages = [];
    for (let p = 1; p <= doc.numPages; p++) {
      if (p < firstPageIndex) {
        pages.push({
          pageNumber: p,
          status: 'skipped',
          expected: null,
          extracted: null,
          candidateCount: 0,
          candidates: [],
          note: '首个带页码页之前，跳过。',
        });
        continue;
      }

      // 期望页码只随 PDF 页序递增，不随提取结果调整
      const expected = firstPrintedNumber + (p - firstPageIndex);
      const page = await doc.getPage(p);
      const fragments = await collectDigitFragments(
        page,
        viewports[p - 1],
        bandPt
      );
      const candidates = buildCandidates(fragments);

      let status;
      let extracted = null;
      let note = null;
      if (candidates.length === 1) {
        extracted = candidates[0].value;
        if (extracted === expected) {
          status = 'ok';
        } else {
          status = 'mismatch';
          note = `错号：提取页码 ${extracted}，期望 ${expected}。`;
        }
      } else if (candidates.length === 0) {
        status = 'unknown';
        note = '页脚带内未识别到页码数字（图像中的页码未纳入识别）。';
      } else {
        status = 'unknown';
        note = `识别到 ${candidates.length} 个候选（${candidates
          .map((c) => `“${c.text}”`)
          .join('、')}），无法判断。`;
      }

      pages.push({
        pageNumber: p,
        status,
        expected,
        extracted,
        candidateCount: candidates.length,
        candidates,
        note,
      });
    }

    const countBy = (s) => pages.filter((pg) => pg.status === s).length;
    return {
      firstPageIndex,
      firstPrintedNumber,
      footerBandMm,
      pageCount: doc.numPages,
      pages,
      summary: {
        totalPages: doc.numPages,
        skippedPages: firstPageIndex - 1,
        checkedPages: doc.numPages - firstPageIndex + 1,
        okPages: countBy('ok'),
        mismatchPages: countBy('mismatch'),
        unknownPages: countBy('unknown'),
      },
    };
  } finally {
    await doc.destroy().catch(() => {});
  }
}
