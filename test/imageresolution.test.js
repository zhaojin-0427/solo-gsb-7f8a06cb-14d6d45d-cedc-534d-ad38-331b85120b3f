// test/imageresolution.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import zlib from 'node:zlib';
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';
import { PDFDocument, PDFName } from 'pdf-lib';
import {
  analyzeImageResolution,
  collectImagePlacements,
  placementResolution,
  concatTransform,
  ImageResolutionError,
  MIN_DPI,
  MAX_DPI,
  NO_IMAGE_NOTE,
} from '../imageresolution.js';

// ---- PNG 构造工具（无压缩 IHDR + 单 IDAT）----

function crc32(buf) {
  let c = ~0;
  for (let i = 0; i < buf.length; i++) {
    c ^= buf[i];
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
  }
  return (~c) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, 'latin1');
  const body = Buffer.concat([typeBuf, data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([len, body, crc]);
}

/** 生成纯灰 RGB PNG，宽高自定义（每像素 3 字节）。 */
function makePng(width, height, gray = 200) {
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // color type RGB
  const raw = Buffer.alloc((width * 3 + 1) * height);
  for (let y = 0; y < height; y++) {
    const rowStart = y * (width * 3 + 1);
    raw[rowStart] = 0; // filter none
    for (let x = 0; x < width; x++) {
      raw[rowStart + 1 + x * 3] = gray;
      raw[rowStart + 1 + x * 3 + 1] = gray;
      raw[rowStart + 1 + x * 3 + 2] = gray;
    }
  }
  const idat = zlib.deflateSync(raw);
  return Buffer.concat([
    sig,
    chunk('IHDR', ihdr),
    chunk('IDAT', idat),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// ---- PDF 构造工具 ----

/**
 * 以原始内容流创建单页 PDF：内部新建文档并嵌入一张指定尺寸 PNG，
 * 返回 { bytes, imgRef }（imgRef 可用于页面/表单资源）。
 */
async function buildPdf(pageSize, { content, resources = {}, rotate = 0, image = null }) {
  const doc = await PDFDocument.create();
  const page = doc.addPage(pageSize);
  if (image) {
    const png = await doc.embedPng(makePng(image.width, image.height));
    resources = { ...resources, XObject: { ...(resources.XObject || {}), Im0: png.ref } };
  }
  const csRef = doc.context.register(
    doc.context.stream(Buffer.from(content, 'latin1'), {})
  );
  page.node.set(PDFName.of('Contents'), csRef);
  page.node.set(PDFName.of('Resources'), doc.context.obj(resources));
  if (rotate) page.node.set(PDFName.of('Rotate'), doc.context.obj(rotate));
  return Buffer.from(await doc.save());
}

// ---- 纯函数 ----

test('常量：阈值范围 72～1200 DPI', () => {
  assert.equal(MIN_DPI, 72);
  assert.equal(MAX_DPI, 1200);
});

test('placementResolution：等比放置，72 pt/英寸换算', () => {
  // 300 px 放入 1 英寸（72 pt）→ 300 DPI
  const r = placementResolution(300, 300, [72, 0, 0, 72, 0, 0]);
  assert.ok(Math.abs(r.widthPt - 72) < 1e-9);
  assert.ok(Math.abs(r.heightPt - 72) < 1e-9);
  assert.ok(Math.abs(r.dpiX - 300) < 1e-9);
  assert.ok(Math.abs(r.dpiY - 300) < 1e-9);
  assert.equal(r.minDpi, 300);
});

test('placementResolution：非等比缩放，两轴分别计算并取小值', () => {
  // 200×100 px，横边 72 pt（1 in），纵边 36 pt（0.5 in）
  // → dpiX=200，dpiY=200；再改纵边为 72 → dpiY=100
  const r1 = placementResolution(200, 100, [72, 0, 0, 72, 0, 0]);
  assert.ok(Math.abs(r1.dpiX - 200) < 1e-9);
  assert.ok(Math.abs(r1.dpiY - 100) < 1e-9);
  assert.equal(r1.minDpi, 100);

  const r2 = placementResolution(200, 100, [36, 0, 0, 72, 0, 0]);
  assert.ok(Math.abs(r2.dpiX - 400) < 1e-9);
  assert.ok(Math.abs(r2.dpiY - 100) < 1e-9);
  assert.equal(r2.minDpi, 100);
});

test('placementResolution：旋转 90°，边长取向量模长（与 a/d 无关）', () => {
  // 90° 旋转：[0,72,-72,0,...] → 横边向量 (0,72) 长 72，纵边 (-72,0) 长 72
  const r = placementResolution(300, 150, [0, 72, -72, 0, 0, 0]);
  assert.ok(Math.abs(r.dpiX - 300) < 1e-9);
  assert.ok(Math.abs(r.dpiY - 150) < 1e-9);
  assert.equal(r.minDpi, 150);
});

test('placementResolution：45° 旋转边长', () => {
  const s = Math.SQRT1_2;
  // 横边向量 (36s,36s) 长 36；纵边 (-36s,36s) 长 36
  const r = placementResolution(100, 100, [36 * s, 36 * s, -36 * s, 36 * s, 0, 0]);
  assert.ok(Math.abs(r.widthPt - 36) < 1e-9);
  assert.ok(Math.abs(r.heightPt - 36) < 1e-9);
  assert.ok(Math.abs(r.dpiX - 200) < 1e-9);
});

test('placementResolution：退化（零边长）返回 null', () => {
  assert.equal(placementResolution(10, 10, [0, 0, 0, 50, 0, 0]), null);
  assert.equal(placementResolution(10, 10, [50, 0, 0, 0, 0, 0]), null);
});

test('concatTransform：先平移后缩放的复合顺序', () => {
  const m = concatTransform([2, 0, 0, 2, 0, 0], [1, 0, 0, 1, 10, 20]);
  assert.deepEqual(m, [2, 0, 0, 2, 20, 40]);
});

// ---- collectImagePlacements：合成绘制指令 ----

const OPS = pdfjs.OPS;

function opList(entries) {
  return {
    fnArray: entries.map(([fn]) => fn),
    argsArray: entries.map(([, args]) => args),
  };
}

test('collectImagePlacements：save/restore 隔离 cm，同图多次放置逐次计算', () => {
  // q 100 0 0 50 0 0 cm /Im Do Q；q 72 0 0 72 0 0 cm /Im Do Q
  const ol = opList([
    [OPS.save, null],
    [OPS.transform, [100, 0, 0, 50, 0, 0]],
    [OPS.paintImageXObject, ['img_1', 200, 100]],
    [OPS.restore, null],
    [OPS.save, null],
    [OPS.transform, [72, 0, 0, 72, 0, 0]],
    [OPS.paintImageXObject, ['img_1', 200, 100]],
    [OPS.restore, null],
  ]);
  const placements = collectImagePlacements(ol, 300);
  assert.equal(placements.length, 2);
  // 第一次：144×144 DPI 风险；第二次：200×100 → min 100 风险
  assert.ok(Math.abs(placements[0].dpiX - 144) < 1e-6);
  assert.ok(Math.abs(placements[0].dpiY - 144) < 1e-6);
  assert.equal(placements[0].risk, true);
  assert.ok(Math.abs(placements[1].dpiX - 200) < 1e-6);
  assert.ok(Math.abs(placements[1].dpiY - 100) < 1e-6);
  assert.equal(placements[1].risk, true);
});

test('collectImagePlacements：未配对 save 的 cm 累积到下一次绘制', () => {
  // cm 两次再 Do（无 q/Q）：2 × 72 = 144 pt
  const ol = opList([
    [OPS.transform, [2, 0, 0, 2, 0, 0]],
    [OPS.transform, [72, 0, 0, 72, 0, 0]],
    [OPS.paintImageXObject, ['img_1', 600, 600]],
  ]);
  const [p] = collectImagePlacements(ol, 300);
  assert.ok(Math.abs(p.widthPt - 144) < 1e-9);
  assert.ok(Math.abs(p.minDpi - 300) < 1e-9);
  assert.equal(p.risk, false); // 恰好 300 不报
});

test('collectImagePlacements：Form XObject Matrix 与外层 cm 嵌套复合', () => {
  // 外层 cm 0.5；表单 Matrix [2,0,0,2,...]；表单内 cm [60,0,0,30,...]；Do 图
  const ol = opList([
    [OPS.save, null],
    [OPS.transform, [0.5, 0, 0, 0.5, 0, 0]],
    [OPS.paintFormXObjectBegin, [[2, 0, 0, 2, 0, 0], [0, 0, 100, 100]]],
    [OPS.save, null],
    [OPS.transform, [60, 0, 0, 30, 0, 0]],
    [OPS.paintImageXObject, ['img_1', 120, 60]],
    [OPS.restore, null],
    [OPS.paintFormXObjectEnd, []],
    [OPS.restore, null],
  ]);
  const [p] = collectImagePlacements(ol, 300);
  // 0.5 × 2 × 60 = 60 pt → 120/（60/72)=144 DPI
  assert.equal(p.formDepth, 1);
  assert.ok(Math.abs(p.widthPt - 60) < 1e-9);
  assert.ok(Math.abs(p.heightPt - 30) < 1e-9);
  assert.ok(Math.abs(p.minDpi - 144) < 1e-9);
});

test('collectImagePlacements：表单 Matrix 为 null 时按单位矩阵处理', () => {
  const ol = opList([
    [OPS.save, null],
    [OPS.transform, [72, 0, 0, 72, 0, 0]],
    [OPS.paintFormXObjectBegin, [null, [0, 0, 72, 72]]],
    [OPS.paintImageXObject, ['img_1', 300, 300]],
    [OPS.paintFormXObjectEnd, []],
    [OPS.restore, null],
  ]);
  const [p] = collectImagePlacements(ol, 300);
  assert.ok(Math.abs(p.minDpi - 300) < 1e-9);
});

test('collectImagePlacements：内联图像与图像蒙版不计入', () => {
  const ol = opList([
    [OPS.save, null],
    [OPS.transform, [10, 0, 0, 10, 0, 0]],
    [OPS.paintImageMaskXObject, [{ data: 'm1', width: 4, height: 2, count: 1 }]],
    [OPS.paintImageMaskXObjectGroup, [[{ data: 'm2', width: 2, height: 2 }]]],
    [OPS.paintSolidColorImageMask, []],
    [OPS.paintInlineImageXObject, [{ width: 2, height: 2, kind: 3, data: new Uint8Array(12) }]],
    [OPS.restore, null],
  ]);
  assert.deepEqual(collectImagePlacements(ol, 300), []);
});

test('collectImagePlacements：严格低于阈值才报风险', () => {
  const ol = opList([
    [OPS.paintImageXObject, ['a', 300, 300]], // CTM 单位 → 300 px / 1pt 极大，不报
    [OPS.save, null],
    [OPS.transform, [72, 0, 0, 72, 0, 0]],
    [OPS.paintImageXObject, ['b', 300, 300]], // 恰好 300 DPI，不报
    [OPS.restore, null],
    [OPS.save, null],
    [OPS.transform, [72.01, 0, 0, 72.01, 0, 0]],
    [OPS.paintImageXObject, ['c', 300, 300]], // 略低于 300，报
    [OPS.restore, null],
  ]);
  const placements = collectImagePlacements(ol, 300);
  assert.deepEqual(placements.map((p) => p.risk), [false, false, true]);
});

// ---- 端到端：pdf-lib 生成 PDF ----

test('端到端：实际绘制计入、未绘制资源不计入、无图页标记', async () => {
  const doc = await PDFDocument.create();
  const png = await doc.embedPng(makePng(300, 300));
  const imgRef = png.ref;

  // 第 1 页：一张图放入 1 英寸（72 pt）→ 300 DPI 达标；同一图像再放大放置一次 → 风险
  const p1 = doc.addPage([300, 300]);
  const c1 = doc.context.register(
    doc.context.stream(
      Buffer.from(
        'q 72 0 0 72 10 10 cm /Im0 Do Q\nq 144 0 0 144 10 100 cm /Im0 Do Q\n',
        'latin1'
      ),
      {}
    )
  );
  p1.node.set(PDFName.of('Contents'), c1);
  p1.node.set(
    PDFName.of('Resources'),
    doc.context.obj({ XObject: { Im0: imgRef, Unused: imgRef } })
  );

  // 第 2 页：无内容（资源字典里有图但从不绘制）→ 无图
  const p2 = doc.addPage([300, 300]);
  const c2 = doc.context.register(doc.context.stream(Buffer.from('% 空内容\n', 'latin1'), {}));
  p2.node.set(PDFName.of('Contents'), c2);
  p2.node.set(
    PDFName.of('Resources'),
    doc.context.obj({ XObject: { Unused: imgRef } })
  );

  const bytes = Buffer.from(await doc.save());
  const report = await analyzeImageResolution(bytes, { minDpi: 300 });

  assert.equal(report.pageCount, 2);
  assert.equal(report.summary.totalPlacements, 2);
  assert.equal(report.summary.pagesWithImage, 1);
  assert.equal(report.summary.pagesWithoutImage, 1);
  assert.equal(report.summary.pagesWithRisk, 1);
  assert.equal(report.summary.riskPlacements, 1);

  const [page1, page2] = report.pages;
  assert.equal(page1.status, 'risk');
  assert.equal(page1.imageCount, 2);
  assert.equal(page1.riskCount, 1);
  assert.ok(Math.abs(page1.images[0].dpiX - 300) < 0.05);
  assert.equal(page1.images[0].risk, false);
  assert.ok(Math.abs(page1.images[1].dpiX - 150) < 0.05);
  assert.equal(page1.images[1].risk, true);

  assert.equal(page2.status, 'no-image');
  assert.equal(page2.note, NO_IMAGE_NOTE);
  assert.deepEqual(page2.images, []);
});

test('端到端：非等比缩放两轴 DPI 不同，取较小值判定', async () => {
  // 横边 72 pt（300 DPI），纵边 144 pt（150 DPI）→ 风险
  const bytes = await buildPdf([300, 300], {
    image: { width: 300, height: 300 },
    content: 'q 72 0 0 144 10 10 cm /Im0 Do Q\n',
  });
  const report = await analyzeImageResolution(bytes, { minDpi: 300 });
  const im = report.pages[0].images[0];
  assert.ok(Math.abs(im.dpiX - 300) < 0.05);
  assert.ok(Math.abs(im.dpiY - 150) < 0.05);
  assert.equal(im.minDpi, im.dpiY);
  assert.equal(report.pages[0].status, 'risk');
});

test('端到端：旋转放置按各自边长计算', async () => {
  // 90° 旋转后放置，边长仍为 72 pt → 300 DPI
  const bytes = await buildPdf([300, 300], {
    image: { width: 300, height: 300 },
    content: 'q 0 72 -72 0 100 100 cm /Im0 Do Q\n',
  });
  const report = await analyzeImageResolution(bytes, { minDpi: 300 });
  assert.equal(report.pages[0].status, 'ok');
  const im = report.pages[0].images[0];
  assert.ok(Math.abs(im.dpiX - 300) < 0.05);
  assert.ok(Math.abs(im.dpiY - 300) < 0.05);
});

test('端到端：表单 XObject 嵌套变换（外层 cm + 表单 Matrix + 内层 cm）', async () => {
  const doc = await PDFDocument.create();
  const png = await doc.embedPng(makePng(120, 60));
  const formRef = doc.context.register(
    doc.context.stream(
      Buffer.from('q 60 0 0 30 0 0 cm /Im0 Do Q\n', 'latin1'),
      {
        Type: 'XObject',
        Subtype: 'Form',
        BBox: [0, 0, 300, 300],
        Matrix: [2, 0, 0, 2, 0, 0],
        Resources: doc.context.obj({ XObject: doc.context.obj({ Im0: png.ref }) }),
      }
    )
  );
  const page = doc.addPage([300, 300]);
  const cs = doc.context.register(
    doc.context.stream(Buffer.from('q 0.5 0 0 0.5 0 0 cm /Fm1 Do Q\n', 'latin1'), {})
  );
  page.node.set(PDFName.of('Contents'), cs);
  page.node.set(
    PDFName.of('Resources'),
    doc.context.obj({ XObject: { Fm1: formRef } })
  );
  const bytes = Buffer.from(await doc.save());
  const report = await analyzeImageResolution(bytes, { minDpi: 300 });
  const pageReport = report.pages[0];
  assert.equal(pageReport.imageCount, 1);
  // 0.5 × 2 × 60 = 60 pt 横边 → 120/(60/72) = 144 DPI
  assert.ok(Math.abs(pageReport.images[0].dpiX - 144) < 0.05);
  assert.ok(Math.abs(pageReport.images[0].dpiY - 144) < 0.05);
  assert.equal(pageReport.images[0].inForm, true);
  assert.equal(pageReport.status, 'risk');
});

test('端到端：两层嵌套表单（外层 cm → 外层 Matrix → 内层 Matrix → 内层 cm）', async () => {
  const doc = await PDFDocument.create();
  const png = await doc.embedPng(makePng(300, 300));
  // 内层表单：Matrix 缩放 2，内容再 cm 36 pt → 图像横边 72 pt（内层坐标）
  const innerRef = doc.context.register(
    doc.context.stream(Buffer.from('q 36 0 0 36 0 0 cm /Im0 Do Q\n', 'latin1'), {
      Type: 'XObject', Subtype: 'Form', BBox: [0, 0, 200, 200],
      Matrix: [2, 0, 0, 2, 0, 0],
      Resources: doc.context.obj({ XObject: doc.context.obj({ Im0: png.ref }) }),
    })
  );
  // 外层表单：Matrix 缩放 0.5，Do 内层表单
  const outerRef = doc.context.register(
    doc.context.stream(Buffer.from('/Inner Do\n', 'latin1'), {
      Type: 'XObject', Subtype: 'Form', BBox: [0, 0, 200, 200],
      Matrix: [0.5, 0, 0, 0.5, 0, 0],
      Resources: doc.context.obj({ XObject: doc.context.obj({ Inner: innerRef }) }),
    })
  );
  const page = doc.addPage([300, 300]);
  const cs = doc.context.register(
    doc.context.stream(Buffer.from('q 2 0 0 2 0 0 cm /Outer Do Q\n', 'latin1'), {})
  );
  page.node.set(PDFName.of('Contents'), cs);
  page.node.set(
    PDFName.of('Resources'),
    doc.context.obj({ XObject: { Outer: outerRef } })
  );
  const bytes = Buffer.from(await doc.save());
  const report = await analyzeImageResolution(bytes, { minDpi: 300 });
  const im = report.pages[0].images[0];
  // 2（页面 cm）× 0.5（外 Matrix）× 2（内 Matrix）× 36 = 72 pt → 300 DPI
  assert.ok(Math.abs(im.dpiX - 300) < 0.05);
  assert.ok(Math.abs(im.dpiY - 300) < 0.05);
  assert.equal(im.inForm, true);
  assert.equal(report.pages[0].status, 'ok');
});

test('端到端：内联图像与图像蒙版不纳入检查，页面标为无图', async () => {
  const doc = await PDFDocument.create();
  // 1 位图像蒙版 4×2
  const maskRef = doc.context.register(
    doc.context.stream(new Uint8Array([0xaa, 0x55]), {
      Type: 'XObject',
      Subtype: 'Image',
      Width: 4,
      Height: 2,
      ImageMask: true,
      BitsPerComponent: 1,
    })
  );
  // 内联图像 2×2 RGB（w+h=4 < 200，PDF.js 走 paintInlineImageXObject）
  const content =
    'q 40 0 0 20 5 5 cm /Mk Do Q\n' +
    'q 50 0 0 25 0 100 cm\nBI\n/W 2\n/H 2\n/CS /RGB\n/BPC 8\nID\n' +
    Buffer.from([255, 0, 0, 0, 255, 0, 0, 0, 255, 255, 255, 0]).toString('latin1') +
    '\nEI\nQ\n';
  const bytes = await buildPdf([300, 300], {
    content,
    resources: { XObject: { Mk: maskRef } },
  });
  const report = await analyzeImageResolution(bytes, { minDpi: 300 });
  assert.equal(report.pages[0].status, 'no-image');
  assert.equal(report.pages[0].imageCount, 0);
});

test('端到端：恰好等于阈值不报风险', async () => {
  const doc = await PDFDocument.create();
  const png = await doc.embedPng(makePng(300, 300));
  const bytes = await buildPdf([300, 300], {
    image: { width: 300, height: 300 },
    content: 'q 72 0 0 72 0 0 cm /Im0 Do Q\n',
  });
  const report = await analyzeImageResolution(bytes, { minDpi: 300 });
  assert.equal(report.pages[0].status, 'ok');
  assert.equal(report.summary.riskPlacements, 0);
});

test('端到端：页面旋转 90° 仍按视口正常分析', async () => {
  const bytes = await buildPdf([300, 300], {
    image: { width: 300, height: 300 },
    content: 'q 72 0 0 72 10 10 cm /Im0 Do Q\n',
    rotate: 90,
  });
  const report = await analyzeImageResolution(bytes, { minDpi: 300 });
  assert.equal(report.pages[0].status, 'ok');
  assert.equal(report.pages[0].images.length, 1);
});

// ---- 参数与文件校验 ----

test('参数校验：阈值越界、非数字报业务错误', async () => {
  const doc = await PDFDocument.create();
  doc.addPage([100, 100]);
  const bytes = Buffer.from(await doc.save());

  for (const bad of [0, 71, 1201, NaN, '300', null, undefined]) {
    await assert.rejects(
      () => analyzeImageResolution(bytes, { minDpi: bad }),
      (e) => e instanceof ImageResolutionError && /72～1200/.test(e.message)
    );
  }
});

test('文件校验：空文件与非 PDF 文件报业务错误', async () => {
  await assert.rejects(
    () => analyzeImageResolution(Buffer.alloc(0), { minDpi: 300 }),
    /为空/
  );
  await assert.rejects(
    () => analyzeImageResolution(Buffer.from('not a pdf at all'), { minDpi: 300 }),
    /不是有效的 PDF/
  );
});
