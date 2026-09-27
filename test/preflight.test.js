// test/preflight.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PDFDocument, rgb, degrees, StandardFonts } from 'pdf-lib';
import {
  analyzeTextSafety,
  bindingEdgeForPage,
  textItemAABB,
  edgeDistances,
  findRiskEdges,
  multiplyTransform,
  PreflightError,
  PT_PER_MM,
  NO_TEXT_NOTE,
} from '../preflight.js';

const mm = (v) => v * PT_PER_MM;
const A4 = { w: 595.28, h: 841.89 };

// ---- 纯几何函数 ----

test('装订边：奇数页左、偶数页右', () => {
  assert.equal(bindingEdgeForPage(1), 'left');
  assert.equal(bindingEdgeForPage(2), 'right');
  assert.equal(bindingEdgeForPage(7), 'left');
  assert.equal(bindingEdgeForPage(8), 'right');
});

test('textItemAABB：水平文字', () => {
  const box = textItemAABB({
    transform: [20, 0, 0, 20, 100, 200],
    width: 45.56,
    height: 20,
  });
  assert.deepEqual(box, { x1: 100, y1: 200, x2: 145.56, y2: 220 });
});

test('textItemAABB：旋转 90° 文字取变换后的轴对齐外接框', () => {
  // 逆时针 90°：书写方向朝 +y，升高方向朝 -x
  const box = textItemAABB({
    transform: [0, 30, -30, 0, 300, 400],
    width: 60,
    height: 30,
  });
  assert.ok(Math.abs(box.x1 - 270) < 1e-9);
  assert.ok(Math.abs(box.x2 - 300) < 1e-9);
  assert.ok(Math.abs(box.y1 - 400) < 1e-9);
  assert.ok(Math.abs(box.y2 - 460) < 1e-9);
});

test('textItemAABB：45° 旋转', () => {
  const s = Math.SQRT1_2;
  const box = textItemAABB({
    transform: [10 * s, 10 * s, -10 * s, 10 * s, 0, 0],
    width: 10 * Math.SQRT2,
    height: 10 * Math.SQRT2,
  });
  // 四角：(0,0) (10,10) (-10,10) (0,20)
  assert.ok(Math.abs(box.x1 - -10) < 1e-9);
  assert.ok(Math.abs(box.x2 - 10) < 1e-9);
  assert.ok(Math.abs(box.y1 - 0) < 1e-9);
  assert.ok(Math.abs(box.y2 - 20) < 1e-9);
});

test('textItemAABB：退化项返回 null', () => {
  assert.equal(textItemAABB({ transform: [1, 0, 0, 1, 0, 0], width: 0, height: 10 }), null);
  assert.equal(textItemAABB({ transform: [0, 0, 0, 0, 0, 0], width: 5, height: 10 }), null);
});

test('edgeDistances：页内为正，越界为负', () => {
  const d = edgeDistances({ x1: 10, y1: 20, x2: 110, y2: 220 }, 200, 300);
  assert.deepEqual(d, { left: 10, right: 90, top: 20, bottom: 80 });
  const out = edgeDistances({ x1: -5, y1: 10, x2: 250, y2: 20 }, 200, 300);
  assert.equal(out.left, -5);
  assert.equal(out.right, -50);
});

test('findRiskEdges：穿入才报，恰好贴边不报，多边逐边列出', () => {
  const required = { left: 30, right: 10, top: 10, bottom: 10 };
  // 左：恰好贴边（30 == 30）不报；上：9 < 10 穿入
  const risks = findRiskEdges(
    { left: 30, right: 100, top: 9, bottom: 100 },
    required
  );
  assert.equal(risks.length, 1);
  assert.equal(risks[0].edge, 'top');

  // 同时穿入左、下两边 → 逐边列出
  const multi = findRiskEdges(
    { left: 5, right: 100, top: 100, bottom: -2 },
    required
  );
  assert.deepEqual(multi.map((r) => r.edge), ['left', 'bottom']);

  // 容差范围内的“贴边”不报
  const eps = findRiskEdges(
    { left: 30 - 0.005, right: 100, top: 100, bottom: 100 },
    required
  );
  assert.equal(eps.length, 0);
});

test('multiplyTransform：复合顺序', () => {
  // m = m1 ∘ m2：先平移 (10,20)，再缩放 2 倍
  const m = multiplyTransform([2, 0, 0, 2, 0, 0], [1, 0, 0, 1, 10, 20]);
  assert.deepEqual(m, [2, 0, 0, 2, 20, 40]);
});

// ---- 集成：pdf-lib 生成 PDF，走完整预检流程 ----

async function makePreflightPdf() {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const size = 12;
  const draw = (page, text, opts) =>
    page.drawText(text, { size, font, color: rgb(0, 0, 0), ...opts });

  // 第 1 页（奇，装订边左）：安全文字
  {
    const page = doc.addPage([A4.w, A4.h]);
    draw(page, 'Safe', { x: mm(20), y: 700 });
  }
  // 第 2 页（偶，装订边右）：文字右缘距右页边 10mm < 装订 15mm
  {
    const page = doc.addPage([A4.w, A4.h]);
    const text = 'BindR';
    const w = font.widthOfTextAtSize(text, size);
    draw(page, text, { x: A4.w - mm(10) - w, y: 700 });
  }
  // 第 3 页（奇）：文字左缘恰好贴在装订禁入带边界（15mm）→ 不报
  {
    const page = doc.addPage([A4.w, A4.h]);
    draw(page, 'Edge', { x: mm(15), y: 700 });
  }
  // 第 4 页（偶）：旋转 90° 文字，外接框下缘距底边 3mm < 裁切 5mm
  {
    const page = doc.addPage([A4.w, A4.h]);
    draw(page, 'Rot', { x: 100, y: mm(3), rotate: degrees(90) });
  }
  // 第 5 页（奇）：文字越出左页边 2mm → 负边距
  {
    const page = doc.addPage([A4.w, A4.h]);
    draw(page, 'Out', { x: mm(-2), y: 700 });
  }
  // 第 6 页（偶）：右上角文字同时触及右边（装订）与上边（裁切）
  {
    const page = doc.addPage([A4.w, A4.h]);
    const text = 'Corner';
    const w = font.widthOfTextAtSize(text, size);
    draw(page, text, { x: A4.w - mm(3) - w, y: A4.h - size - mm(2) });
  }
  // 第 7 页：空白页 → 无法判断
  {
    doc.addPage([A4.w, A4.h]);
  }
  // 第 8 页（偶）：带 CropBox 偏移，文字距可见左框 10pt < 裁切 5mm
  {
    const page = doc.addPage([A4.w, A4.h]);
    page.setCropBox(50, 50, 400, 600);
    draw(page, 'Crop', { x: 60, y: 500 });
  }
  // 第 9 页（奇）：页面旋转 90°，文字在可见视口中距上边 3mm < 裁切 5mm
  {
    const page = doc.addPage([A4.w, A4.h]);
    page.setRotation(degrees(90));
    draw(page, 'RotPage', { x: mm(3), y: 300 });
  }
  return Buffer.from(await doc.save());
}

const MARGINS = { trimMarginMm: 5, bindingMarginMm: 15 };

test('端到端：逐页风险判定', async () => {
  const bytes = await makePreflightPdf();
  const report = await analyzeTextSafety(bytes, MARGINS);

  assert.equal(report.pageCount, 9);
  assert.equal(report.trimMarginMm, 5);
  assert.equal(report.bindingMarginMm, 15);

  const [p1, p2, p3, p4, p5, p6, p7, p8, p9] = report.pages;

  // 第 1 页：安全
  assert.equal(p1.status, 'ok');
  assert.equal(p1.items.length, 0);
  assert.equal(p1.bindingEdge, 'left');

  // 第 2 页：装订边（右）穿入，实际边距 10mm / 要求 15mm
  assert.equal(p2.status, 'risk');
  assert.equal(p2.bindingEdge, 'right');
  assert.equal(p2.items.length, 1);
  assert.equal(p2.items[0].text, 'BindR');
  assert.deepEqual(
    p2.items[0].edges.map((e) => e.edge),
    ['right']
  );
  assert.equal(p2.items[0].edges[0].distanceMm, 10);
  assert.equal(p2.items[0].edges[0].requiredMm, 15);
  assert.equal(p2.items[0].minDistanceMm, 10);

  // 第 3 页：恰好贴边不报
  assert.equal(p3.status, 'ok');
  assert.equal(p3.items.length, 0);

  // 第 4 页：旋转文字外接框穿入下边（裁切）
  assert.equal(p4.status, 'risk');
  assert.equal(p4.items.length, 1);
  assert.deepEqual(
    p4.items[0].edges.map((e) => e.edge),
    ['bottom']
  );
  assert.equal(p4.items[0].edges[0].distanceMm, 3);
  assert.equal(p4.items[0].edges[0].requiredMm, 5);

  // 第 5 页：越出页框记负值
  assert.equal(p5.status, 'risk');
  assert.equal(p5.items[0].edges[0].edge, 'left');
  assert.ok(p5.items[0].edges[0].distanceMm < 0);
  assert.equal(p5.items[0].minDistanceMm, -2);

  // 第 6 页：同一文本触及多边，逐边列出
  assert.equal(p6.status, 'risk');
  assert.deepEqual(
    p6.items[0].edges.map((e) => e.edge),
    ['right', 'top']
  );
  const right = p6.items[0].edges.find((e) => e.edge === 'right');
  const top = p6.items[0].edges.find((e) => e.edge === 'top');
  assert.equal(right.requiredMm, 15); // 偶数页右侧为装订边
  assert.equal(top.requiredMm, 5);

  // 第 7 页：无可提取文字 → 无法判断
  assert.equal(p7.status, 'no-text');
  assert.equal(p7.note, NO_TEXT_NOTE);
  assert.equal(p7.items.length, 0);

  // 第 8 页：以可见页框（CropBox）为界
  assert.equal(p8.status, 'risk');
  assert.equal(p8.widthMm, Math.round((400 / PT_PER_MM) * 10) / 10);
  assert.equal(p8.heightMm, Math.round((600 / PT_PER_MM) * 10) / 10);
  assert.deepEqual(
    p8.items[0].edges.map((e) => e.edge),
    ['left']
  );
  assert.equal(p8.items[0].edges[0].distanceMm, 3.5); // 10pt ≈ 3.5mm
  assert.equal(p8.items[0].edges[0].requiredMm, 5);

  // 第 9 页：页面旋转 90° 后以可见视口为界，文字距视口上边 3mm
  assert.equal(p9.status, 'risk');
  assert.equal(p9.widthMm, 297);
  assert.equal(p9.heightMm, 210);
  assert.deepEqual(
    p9.items[0].edges.map((e) => e.edge),
    ['top']
  );
  assert.equal(p9.items[0].edges[0].distanceMm, 3);

  // 汇总
  assert.equal(report.summary.totalPages, 9);
  assert.equal(report.summary.pagesNoText, 1);
  assert.equal(report.summary.pagesWithText, 8);
  assert.equal(report.summary.pagesWithRisk, 6);
  assert.equal(report.summary.riskItemCount, 6);
});

test('边距校验：必须大于 0', async () => {
  const bytes = await makePreflightPdf();
  await assert.rejects(
    () => analyzeTextSafety(bytes, { trimMarginMm: 0, bindingMarginMm: 15 }),
    (e) => e instanceof PreflightError && /裁切边距/.test(e.message)
  );
  await assert.rejects(
    () => analyzeTextSafety(bytes, { trimMarginMm: 5, bindingMarginMm: -1 }),
    (e) => e instanceof PreflightError && /装订边距/.test(e.message)
  );
  await assert.rejects(
    () => analyzeTextSafety(bytes, { trimMarginMm: NaN, bindingMarginMm: 15 }),
    (e) => e instanceof PreflightError && /裁切边距/.test(e.message)
  );
});

test('边距校验：必须小于页面短边的一半', async () => {
  const bytes = await makePreflightPdf();
  // A4 短边 ≈ 210mm，一半 ≈ 105mm
  await assert.rejects(
    () => analyzeTextSafety(bytes, { trimMarginMm: 105, bindingMarginMm: 15 }),
    (e) =>
      e instanceof PreflightError &&
      /裁切边距必须小于页面短边的一半/.test(e.message)
  );
  await assert.rejects(
    () => analyzeTextSafety(bytes, { trimMarginMm: 5, bindingMarginMm: 200 }),
    (e) =>
      e instanceof PreflightError &&
      /装订边距必须小于页面短边的一半/.test(e.message)
  );
});

test('非 PDF / 空文件报错', async () => {
  await assert.rejects(
    () => analyzeTextSafety(Buffer.from('not a pdf at all'), MARGINS),
    (e) => e instanceof PreflightError && /PDF/.test(e.message)
  );
  await assert.rejects(
    () => analyzeTextSafety(Buffer.alloc(0), MARGINS),
    (e) => e instanceof PreflightError
  );
});

test('损坏的 PDF 字节报错', async () => {
  const good = await makePreflightPdf();
  const broken = Buffer.concat([
    good.subarray(0, 20),
    Buffer.from('####garbled####'),
    good.subarray(good.length - 20),
  ]);
  await assert.rejects(
    () => analyzeTextSafety(broken, MARGINS),
    (e) => e instanceof PreflightError
  );
});
