// imposition.js
// 骑马订（saddle stitch）拼版核心逻辑与 PDF 生成。
//
// 规则（每帖 N 页，N ∈ {4,8,16}；第 i 张纸 i 从 0 起）：
//   正面：左 = 第 N - 2i 页，   右 = 第 1 + 2i 页
//   背面：左 = 第 2 + 2i 页，   右 = 第 N - 1 - 2i 页
// 输出顺序：每张纸的正面、背面交替排列；帖之间依次相连。

import { PDFDocument } from 'pdf-lib';

export const ALLOWED_SHEET_SIZES = [4, 8, 16];

export class ImpositionError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ImpositionError';
  }
}

/**
 * 按原顺序分帖，末帖尾部补白至 sheetsPerSignature 页。
 * @param {number} totalPages
 * @param {number} sheetsPerSignature 每帖页数（4 / 8 / 16）
 * @returns {number[][]} 每帖包含的“原页索引（从 0 起）”；-1 表示补白页
 */
export function buildSignatures(totalPages, sheetsPerSignature) {
  if (!ALLOWED_SHEET_SIZES.includes(sheetsPerSignature)) {
    throw new ImpositionError(
      `每帖页数仅支持 ${ALLOWED_SHEET_SIZES.join('、')} 页。`
    );
  }
  if (!Number.isInteger(totalPages) || totalPages <= 0) {
    throw new ImpositionError('PDF 中没有可拼版的页面。');
  }

  const signatures = [];
  for (let start = 0; start < totalPages; start += sheetsPerSignature) {
    const sig = [];
    for (let k = 0; k < sheetsPerSignature; k++) {
      const sourceIndex = start + k;
      sig.push(sourceIndex < totalPages ? sourceIndex : -1);
    }
    signatures.push(sig);
  }
  return signatures;
}

/**
 * 生成一帖的所有版面。
 * 每张纸两个面（front / back），每个面两个槽位（left / right）。
 * slot.sourceIndex 为原页 0 起索引，-1 表示补白空白位。
 * slot.pageNumber 为原页 1 起页号，null 表示空白位。
 */
export function buildSignaturePlaces(signature) {
  const N = signature.length; // 必为 4 的倍数
  const sheets = N / 4;
  const places = [];

  for (let i = 0; i < sheets; i++) {
    const frontLeft = N - 2 * i; // 1-based 页号
    const frontRight = 1 + 2 * i;
    const backLeft = 2 + 2 * i;
    const backRight = N - 1 - 2 * i;

    const toSlot = (oneBased) => {
      const sourceIndex = signature[oneBased - 1];
      return {
        pageNumber: sourceIndex === -1 ? null : sourceIndex + 1,
        sourceIndex,
        signaturePosition: oneBased,
      };
    };

    places.push({
      side: 'front',
      sheetIndex: i,
      label: `第 ${i + 1} 张纸 · 正面`,
      left: toSlot(frontLeft),
      right: toSlot(frontRight),
    });
    places.push({
      side: 'back',
      sheetIndex: i,
      label: `第 ${i + 1} 张纸 · 背面`,
      left: toSlot(backLeft),
      right: toSlot(backRight),
    });
  }
  return places;
}

/**
 * 生成完整拼版方案（不依赖 PDF 库，便于测试与前端核对展示）。
 */
export function buildPlan(totalPages, sheetsPerSignature) {
  const signatures = buildSignatures(totalPages, sheetsPerSignature);
  const faces = [];
  let outputFaceIndex = 0;
  const planSignatures = signatures.map((sig, sigIndex) => {
    const places = buildSignaturePlaces(sig);
    const blankCount = sig.filter((p) => p === -1).length;
    const realCount = sig.length - blankCount;
    for (const place of places) {
      faces.push({
        outputFace: outputFaceIndex + 1, // 输出 PDF 1-based 面号
        signatureIndex: sigIndex + 1,
        ...place,
      });
      outputFaceIndex += 1;
    }
    return {
      signatureIndex: sigIndex + 1,
      pageCount: sig.length,
      realCount,
      blankCount,
      places,
    };
  });

  return {
    totalPages,
    sheetsPerSignature,
    signatureCount: signatures.length,
    totalBlankPages: signatures.reduce(
      (n, sig) => n + sig.filter((p) => p === -1).length,
      0
    ),
    outputFaceCount: faces.length,
    signatures: planSignatures,
    faces,
  };
}

/**
 * 校验并拼版 PDF。
 * @param {Buffer} buffer 上传的原始 PDF 字节
 * @param {number} sheetsPerSignature 每帖页数
 * @returns {Promise<{pdfBytes: Buffer, plan: object, pageSize: {width:number,height:number}}>}
 */
export async function imposePdf(buffer, sheetsPerSignature) {
  if (!Buffer.isBuffer(buffer) || buffer.length === 0) {
    throw new ImpositionError('上传文件为空，请选择有效的 PDF 文件。');
  }

  // 文件头魔数校验：%PDF-
  const head = buffer.subarray(0, 5).toString('latin1');
  if (head !== '%PDF-') {
    throw new ImpositionError('文件不是有效的 PDF（文件头损坏或并非 PDF 文件）。');
  }

  let srcDoc;
  let srcPages;
  try {
    srcDoc = await PDFDocument.load(buffer, {
      ignoreEncryption: false,
      updateMetadata: false,
    });
    srcPages = srcDoc.getPages();
  } catch (err) {
    if (/encrypt|password/i.test(err.message)) {
      throw new ImpositionError('该 PDF 已加密，请先解除密码/加密后再上传。');
    }
    throw new ImpositionError(`PDF 文件损坏或无法解析：${err.message}`);
  }

  // 双保险：检查 trailer 中的 Encrypt 字典（个别加密文档的报错信息不含 encrypt）
  try {
    const encrypt =
      srcDoc.context.trailer && srcDoc.context.trailer.dict
        ? srcDoc.context.trailer.dict.get('Encrypt')
        : undefined;
    if (encrypt) {
      throw new ImpositionError('该 PDF 已加密，请先解除密码/加密后再上传。');
    }
  } catch (err) {
    if (err instanceof ImpositionError) throw err;
    // 字典访问异常不影响主流程
  }

  if (srcPages.length === 0) {
    throw new ImpositionError('PDF 中没有任何页面。');
  }

  // 校验：所有页面同尺寸、无旋转
  const first = srcPages[0];
  const firstSize = first.getSize();
  const EPS = 0.5; // pt，容差
  for (let i = 0; i < srcPages.length; i++) {
    const page = srcPages[i];
    const size = page.getSize();
    if (
      Math.abs(size.width - firstSize.width) > EPS ||
      Math.abs(size.height - firstSize.height) > EPS
    ) {
      throw new ImpositionError(
        `各页尺寸不一致：第 1 页为 ${fmt(firstSize.width)} × ${fmt(
          firstSize.height
        )} pt，第 ${i + 1} 页为 ${fmt(size.width)} × ${fmt(
          size.height
        )} pt。请先统一页面尺寸。`
      );
    }
    const rotation = (page.getRotation().angle || 0) % 360;
    if (rotation !== 0) {
      throw new ImpositionError(
        `第 ${i + 1} 页含有旋转（旋转角 ${rotation}°），请先取消页面旋转后再上传。`
      );
    }
  }

  const plan = buildPlan(srcPages.length, sheetsPerSignature);
  const w = firstSize.width;
  const h = firstSize.height;

  const outDoc = await PDFDocument.create();
  // 将各原页作为 Form XObject 嵌入输出文档（按索引一一对应）；默认缩放 1，原页不缩放。
  const embedded = await outDoc.embedPdf(
    srcDoc,
    srcPages.map((_, i) => i)
  );

  for (const face of plan.faces) {
    const outPage = outDoc.addPage([w * 2, h]);
    for (const slotName of ['left', 'right']) {
      const slot = face[slotName];
      if (slot.sourceIndex === -1) continue; // 补白：保留空白
      const x = slotName === 'left' ? 0 : w;
      outPage.drawPage(embedded[slot.sourceIndex], { x, y: 0 });
    }
  }

  outDoc.setTitle('Saddle-stitched imposition');
  outDoc.setProducer('saddle-stitch-imposition (pdf-lib)');

  const pdfBytes = Buffer.from(await outDoc.save({ useObjectStreams: true }));
  return { pdfBytes, plan, pageSize: { width: w, height: h } };
}

function fmt(n) {
  return (Math.round(n * 10) / 10).toString();
}
