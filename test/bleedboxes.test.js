// test/bleedboxes.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  PDFDocument,
  PDFArray,
  PDFName,
  PDFNumber,
} from 'pdf-lib';
import {
  checkBleedBoxes,
  BleedBoxError,
  PAGE_STATUS,
  PT_PER_MM,
  SIZE_TOLERANCE_MM,
  mapPointToReading,
} from '../bleedboxes.js';

// ---- 构造工具 ----

const mm = (v) => v * PT_PER_MM;

/** 在指定上下文中构造 PDF 矩形数组（直接对象）。 */
function box(ctx, vals) {
  const a = PDFArray.withContext(ctx);
  for (const v of vals) a.push(PDFNumber.of(v));
  return a;
}

/**
 * 构造单页（或多页）测试 PDF。
 * pages: [{ media?, crop?, trim?, bleed?, rotate?, inheritedRotate?, inheritedMedia? }]
 * 矩形均为 [llx,lly,urx,ury]（pt）；缺省 MediaBox 为 210x297mm 原点 0。
 */
async function buildPdf(pages) {
  const doc = await PDFDocument.create();
  const specs = pages.length === 0 ? [{}] : pages;

  // 在 Pages 根上放置可继承属性（用于继承测试）
  const root = doc.context.lookup(doc.catalog.get(PDFName.of('Pages')));

  for (const spec of specs) {
    const trim = spec.trim ?? null;
    const bleed = spec.bleed ?? null;
    // 未显式给出 media 时，自动把 MediaBox 扩到容纳 TrimBox 与 BleedBox
    // （含出血外扩），模拟真实出血文件
    const containing = (() => {
      const base = spec.media ?? spec.inheritedMedia ?? trim ?? bleed ?? [0, 0, mm(210), mm(297)];
      if (!bleed) return base;
      return [
        Math.min(base[0], bleed[0]),
        Math.min(base[1], bleed[1]),
        Math.max(base[2], bleed[2]),
        Math.max(base[3], bleed[3]),
      ];
    })();
    const media = spec.media ?? spec.inheritedMedia ?? containing;
    // addPage 按 [宽, 高] 建页；随后会用真正的 MediaBox 覆盖（或删除以走继承）
    const page = doc.addPage([media[2] - media[0], media[3] - media[1]]);
    const node = page.node;

    node.set(PDFName.of('MediaBox'), box(doc.context, media));
    // 未显式给出 crop 时：默认让 CropBox = 容纳盒（与 MediaBox 相同），
    // spec.cropDefaulted=true 则不写 CropBox，用于验证缺省取 MediaBox
    if (spec.crop && !spec.badCrop) {
      node.set(PDFName.of('CropBox'), box(doc.context, spec.crop));
    } else if (!spec.cropDefaulted && !spec.badCrop) {
      node.set(PDFName.of('CropBox'), box(doc.context, containing));
    }
    if (trim && !spec.badTrim) node.set(PDFName.of('TrimBox'), box(doc.context, trim));
    if (bleed && !spec.badBleed) node.set(PDFName.of('BleedBox'), box(doc.context, bleed));
    if (typeof spec.rotate === 'number') {
      node.set(PDFName.of('Rotate'), PDFNumber.of(spec.rotate));
    }
    if (typeof spec.inheritedRotate === 'number') {
      root.set(PDFName.of('Rotate'), PDFNumber.of(spec.inheritedRotate));
    }
    // 非法盒：声明为非数组（数字）或退化矩形
    if (spec.badTrim) node.set(PDFName.of('TrimBox'), PDFNumber.of(7));
    if (spec.badBleed) node.set(PDFName.of('BleedBox'), PDFNumber.of(7));
    if (spec.badCrop) node.set(PDFName.of('CropBox'), PDFNumber.of(7));
    if (spec.badMedia) {
      node.set(PDFName.of('MediaBox'), box(doc.context, spec.badMedia));
    }
    if (spec.inheritedMedia) {
      // 删除叶子上的 MediaBox，改由父节点提供
      node.delete(PDFName.of('MediaBox'));
      root.set(PDFName.of('MediaBox'), box(doc.context, spec.inheritedMedia));
    }
  }
  if (pages.length === 0) {
    // 删除全部页面
    root.set(PDFName.of('Kids'), doc.context.obj([]));
    root.set(PDFName.of('Count'), PDFNumber.of(0));
  }
  return doc.save();
}

const DEFAULT_OPTS = {
  finishedWidthMm: 210,
  finishedHeightMm: 297,
  minBleedMm: 3,
};

async function checkOne(spec, opts = DEFAULT_OPTS) {
  const bytes = await buildPdf([spec]);
  const report = await checkBleedBoxes(Buffer.from(bytes), opts);
  return report.pages[0];
}

const edgeMap = (edges) => Object.fromEntries(edges.map((e) => [e.edge, e]));

// ---- 参数与文件校验 ----

test('非 PDF / 空文件 / 无页面 / 参数非法时报 BleedBoxError', async () => {
  await assert.rejects(
    checkBleedBoxes(Buffer.from('not a pdf'), DEFAULT_OPTS),
    BleedBoxError
  );
  await assert.rejects(
    checkBleedBoxes(Buffer.alloc(0), DEFAULT_OPTS),
    BleedBoxError
  );
  const empty = await buildPdf([]);
  await assert.rejects(
    checkBleedBoxes(Buffer.from(empty), DEFAULT_OPTS),
    BleedBoxError
  );
  for (const bad of [
    { ...DEFAULT_OPTS, finishedWidthMm: 0 },
    { ...DEFAULT_OPTS, finishedHeightMm: -1 },
    { ...DEFAULT_OPTS, minBleedMm: NaN },
  ]) {
    const ok = await buildPdf([{}]);
    await assert.rejects(
      checkBleedBoxes(Buffer.from(ok), bad),
      BleedBoxError
    );
  }
});

// ---- 未声明 ----

test('TrimBox/BleedBox 均缺省标为未声明，且不套用默认盒', async () => {
  const pg = await checkOne({ cropDefaulted: true });
  assert.equal(pg.status, PAGE_STATUS.undeclared);
  assert.equal(pg.trimDeclared, false);
  assert.equal(pg.bleedDeclared, false);
  assert.equal(pg.bleedEdges, null);
  assert.equal(pg.sizeCheck.status, 'undeclared');
  assert.equal(pg.boxes.crop.defaulted, true);
  assert.equal(pg.boxes.crop.declared, false);
  assert.equal(pg.boxes.trim.declared, false);
  assert.equal(pg.boxes.bleed.declared, false);
});

test('只声明 TrimBox、未声明 BleedBox：尺寸可核对，出血无法计算', async () => {
  const pg = await checkOne({
    trim: [0, 0, mm(210), mm(297)],
  });
  assert.equal(pg.status, PAGE_STATUS.undeclared);
  assert.equal(pg.sizeCheck.status, 'ok');
  assert.equal(pg.bleedEdges, null);
});

// ---- 尺寸核对（含 0.5mm 边界）----

test('TrimBox 与成品完全一致：尺寸相符、四边出血 3mm 恰好达标，通过', async () => {
  const pg = await checkOne({
    trim: [0, 0, mm(210), mm(297)],
    bleed: [-mm(3), -mm(3), mm(210) + mm(3), mm(297) + mm(3)],
  });
  assert.equal(pg.status, PAGE_STATUS.ok, JSON.stringify(pg.notes));
  assert.equal(pg.sizeCheck.status, 'ok');
  const edges = edgeMap(pg.bleedEdges);
  for (const e of ['left', 'right', 'top', 'bottom']) {
    assert.equal(edges[e].status, 'ok');
    assert.ok(Math.abs(edges[e].distanceMm - 3) < 1e-6);
  }
});

test('TrimBox 宽高各差 0.5mm（恰好容差）不报尺寸不符', async () => {
  const pg = await checkOne({
    trim: [0, 0, mm(210) + mm(0.5), mm(297) + mm(0.5)],
    bleed: [-mm(3), -mm(3), mm(210) + mm(3.5), mm(297) + mm(3.5)],
  });
  assert.equal(pg.sizeCheck.status, 'ok');
});

test('TrimBox 任一方向超过 0.5mm 报尺寸不符', async () => {
  const pg = await checkOne({
    trim: [0, 0, mm(210) + mm(0.6), mm(297)],
    bleed: [-mm(3), -mm(3), mm(210) + mm(3.6), mm(297) + mm(3)],
  });
  assert.equal(pg.sizeCheck.status, 'mismatch');
  assert.equal(pg.status, PAGE_STATUS.risk);
});

// ---- 逐边出血、严格小于 ----

test('四边出血为非对称值，2.99mm 严格小于 3mm 报风险，3.0mm 不报', async () => {
  const pg = await checkOne({
    trim: [0, 0, mm(210), mm(297)],
    bleed: [-mm(3), -mm(4), mm(210) + mm(2.99), mm(297) + mm(5)],
  });
  const edges = edgeMap(pg.bleedEdges);
  assert.equal(edges.left.status, 'ok');   // 3.00 恰好达到
  assert.equal(edges.bottom.status, 'ok'); // 4
  assert.equal(edges.right.status, 'risk'); // 2.99 严格小于
  assert.equal(edges.top.status, 'ok'); // 5
  assert.equal(pg.status, PAGE_STATUS.risk);
  assert.ok(edges.right.distanceMm < 3);
});

test('出血距离为负（可用范围未覆盖 TrimBox 该边）报风险并给负值', async () => {
  const pg = await checkOne({
    trim: [0, 0, mm(210), mm(297)],
    // BleedBox 右侧反而在 TrimBox 右边以内 1mm
    bleed: [0, 0, mm(210) - mm(1), mm(297)],
  });
  const edges = edgeMap(pg.bleedEdges);
  assert.equal(edges.right.status, 'risk');
  assert.ok(edges.right.distanceMm < 0);
  assert.equal(edges.left.status, 'risk'); // 0mm 也 < 3mm
});

// ---- CropBox/MediaBox 交集裁剪 ----

test('CropBox 裁掉部分 BleedBox：可用出血按交集计算', async () => {
  // 容纳盒（MediaBox/默认 CropBox）四周均留 5mm；本页显式 CropBox 左边界
  // 只外扩 1mm：左交后只剩 1mm
  const pg = await checkOne({
    crop: [-mm(1), -mm(5), mm(210) + mm(5), mm(297) + mm(5)],
    trim: [0, 0, mm(210), mm(297)],
    bleed: [-mm(5), -mm(5), mm(210) + mm(5), mm(297) + mm(5)],
  });
  const edges = edgeMap(pg.bleedEdges);
  assert.equal(edges.left.status, 'risk');
  assert.ok(Math.abs(edges.left.distanceMm - 1) < 1e-6);
  assert.equal(edges.right.status, 'ok');
  assert.equal(edges.top.status, 'ok');
  assert.equal(edges.bottom.status, 'ok');
});

test('BleedBox 与 CropBox/MediaBox 完全无交集：无法判断', async () => {
  // MediaBox 容纳 TrimBox 与远处的 BleedBox，但显式 CropBox 只覆盖 TrimBox
  const pg = await checkOne({
    crop: [0, 0, mm(210), mm(297)],
    trim: [0, 0, mm(210), mm(297)],
    bleed: [mm(300), mm(400), mm(300) + mm(10), mm(400) + mm(10)],
  });
  assert.equal(pg.status, PAGE_STATUS.unknown);
  assert.equal(pg.bleedEdges, null);
  assert.ok(pg.notes.join('；').includes('无交集'));
});

// ---- 非零盒原点 ----

test('非零 MediaBox/TrimBox/BleedBox 原点按原样计算', async () => {
  const ox = mm(15);
  const oy = mm(20);
  const pg = await checkOne({
    media: [ox - mm(3), oy - mm(3), ox + mm(213), oy + mm(300)],
    crop: [ox - mm(3), oy - mm(3), ox + mm(213), oy + mm(300)],
    trim: [ox, oy, ox + mm(210), oy + mm(297)],
    bleed: [ox - mm(3), oy - mm(3), ox + mm(213), oy + mm(300)],
  });
  assert.equal(pg.status, PAGE_STATUS.ok, JSON.stringify(pg.notes));
  const edges = edgeMap(pg.bleedEdges);
  for (const e of ['left', 'right', 'top', 'bottom']) {
    assert.equal(edges[e].status, 'ok');
    assert.ok(Math.abs(edges[e].distanceMm - 3) < 1e-6);
  }
  assert.deepEqual(pg.boxes.trim.rectMm.x, 15);
  assert.deepEqual(pg.boxes.trim.rectMm.y, 20);
});

// ---- 旋转 ----

test('Rotate=90：TrimBox 阅读宽高互换，四边按阅读方向归属', async () => {
  // 未旋转页面 297mm 宽、210mm 高；成品 210x297；旋转 90 后阅读为 210x297
  // 出血：未旋转左 2 / 右 4 / 下 5 / 上 6（mm）
  // 90°CW 映射：阅读左=未旋转下边(5)、阅读上=未旋转左边(2)、
  //            阅读右=未旋转上边(6)、阅读下=未旋转右边(4)
  const pg = await checkOne({
    trim: [0, 0, mm(297), mm(210)],
    bleed: [-mm(2), -mm(5), mm(297) + mm(4), mm(210) + mm(6)],
    rotate: 90,
  });
  assert.equal(pg.sizeCheck.status, 'ok');
  assert.deepEqual(pg.sizeCheck.actualMm, { width: 210, height: 297 });
  const edges = edgeMap(pg.bleedEdges);
  assert.ok(Math.abs(edges.left.distanceMm - 5) < 1e-6);
  assert.ok(Math.abs(edges.top.distanceMm - 2) < 1e-6);
  assert.ok(Math.abs(edges.right.distanceMm - 6) < 1e-6);
  assert.ok(Math.abs(edges.bottom.distanceMm - 4) < 1e-6);
  // 只有“阅读上边 = 未旋转左边 = 2mm”不足
  assert.equal(edges.top.status, 'risk');
  assert.equal(edges.left.status, 'ok');
  assert.equal(edges.right.status, 'ok');
  assert.equal(edges.bottom.status, 'ok');
  assert.equal(pg.status, PAGE_STATUS.risk);
});

test('Rotate=180/270 的四边归属正确', async () => {
  // 非对称出血：未旋转左 2 / 右 4 / 下 5 / 上 6
  const bleed = [-mm(2), -mm(5), mm(210) + mm(4), mm(297) + mm(6)];
  const pg180 = await checkOne({
    trim: [0, 0, mm(210), mm(297)],
    bleed,
    rotate: 180,
  });
  const e180 = edgeMap(pg180.bleedEdges);
  // 180：阅读左=未旋转右(4)、右=未旋转左(2)、上=未旋转上? 检查：
  // (x,y) -> (mw-x, y-my)：阅读上=Y最小=y最小=未旋转下边(5)；阅读下=未旋转上边(6)
  assert.ok(Math.abs(e180.left.distanceMm - 4) < 1e-6);
  assert.ok(Math.abs(e180.right.distanceMm - 2) < 1e-6);
  assert.ok(Math.abs(e180.top.distanceMm - 5) < 1e-6);
  assert.ok(Math.abs(e180.bottom.distanceMm - 6) < 1e-6);

  const pg270 = await checkOne({
    trim: [0, 0, mm(297), mm(210)],
    bleed: [-mm(2), -mm(5), mm(297) + mm(4), mm(210) + mm(6)],
    rotate: 270,
  });
  const e270 = edgeMap(pg270.bleedEdges);
  // 270CW：(x,y) -> (mh-(y-my), mw-(x-mx))
  // 阅读左=未旋转上边(6)、右=未旋转下边(5)、上=未旋转右边(4)、下=未旋转左边(2)
  assert.ok(Math.abs(e270.left.distanceMm - 6) < 1e-6);
  assert.ok(Math.abs(e270.right.distanceMm - 5) < 1e-6);
  assert.ok(Math.abs(e270.top.distanceMm - 4) < 1e-6);
  assert.ok(Math.abs(e270.bottom.distanceMm - 2) < 1e-6);
  assert.equal(pg270.sizeCheck.status, 'ok');
});

test('Rotate 缺省为 0；非法旋转角（45）标为无法判断', async () => {
  const okPage = await checkOne({
    trim: [0, 0, mm(210), mm(297)],
    bleed: [-mm(3), -mm(3), mm(210) + mm(3), mm(297) + mm(3)],
  });
  assert.equal(okPage.rotation, 0);

  const bad = await checkOne({
    trim: [0, 0, mm(210), mm(297)],
    bleed: [-mm(3), -mm(3), mm(210) + mm(3), mm(297) + mm(3)],
    rotate: 45,
  });
  assert.equal(bad.status, PAGE_STATUS.unknown);
  assert.equal(bad.rotation, null);
});

test('Rotate 自 Pages 父节点继承', async () => {
  const pg = await checkOne({
    trim: [0, 0, mm(297), mm(210)],
    bleed: [-mm(3), -mm(3), mm(297) + mm(3), mm(210) + mm(3)],
    inheritedRotate: 90,
  });
  assert.equal(pg.rotation, 90);
  assert.equal(pg.sizeCheck.status, 'ok');
});

test('MediaBox 自 Pages 父节点继承，非零原点出血仍正确', async () => {
  const ox = mm(10);
  const pg = await checkOne({
    // 叶子不写 MediaBox，由父节点提供（完整容纳四周 3mm 出血）
    inheritedMedia: [ox - mm(3), -mm(3), ox + mm(213), mm(300)],
    crop: [ox - mm(3), -mm(3), ox + mm(213), mm(300)],
    trim: [ox, 0, ox + mm(210), mm(297)],
    bleed: [ox - mm(3), -mm(3), ox + mm(213), mm(300)],
  });
  assert.equal(pg.status, PAGE_STATUS.ok, JSON.stringify(pg.notes));
  assert.deepEqual(pg.boxes.media.rectMm.x, 7);
  const edges = edgeMap(pg.bleedEdges);
  for (const e of ['left', 'right', 'top', 'bottom']) {
    assert.ok(Math.abs(edges[e].distanceMm - 3) < 1e-6);
  }
});

test('交集退化为零宽度（仅相接）：无法判断', async () => {
  // BleedBox 与 CropBox 仅在 x=mm(210) 一条线上相接
  const pg = await checkOne({
    crop: [0, 0, mm(210), mm(297)],
    trim: [0, 0, mm(210), mm(297)],
    bleed: [mm(210), 0, mm(210) + mm(3), mm(297)],
  });
  assert.equal(pg.status, PAGE_STATUS.unknown);
  assert.equal(pg.bleedEdges, null);
});

// ---- 无效盒 ----

test('无效 TrimBox / BleedBox / CropBox / MediaBox 均标为无法判断', async () => {
  const badTrim = await checkOne({
    trim: [0, 0, mm(210), mm(297)],
    bleed: [-mm(3), -mm(3), mm(210) + mm(3), mm(297) + mm(3)],
    badTrim: true,
  });
  assert.equal(badTrim.status, PAGE_STATUS.unknown);
  assert.equal(badTrim.trimDeclared, true);
  assert.equal(badTrim.boxes.trim.invalid, true);

  const badBleed = await checkOne({
    trim: [0, 0, mm(210), mm(297)],
    badBleed: true,
  });
  assert.equal(badBleed.status, PAGE_STATUS.unknown);

  const badCrop = await checkOne({
    trim: [0, 0, mm(210), mm(297)],
    bleed: [-mm(3), -mm(3), mm(210) + mm(3), mm(297) + mm(3)],
    badCrop: true,
  });
  assert.equal(badCrop.status, PAGE_STATUS.unknown);

  const badMedia = await checkOne({ badMedia: [0, 0, 0, mm(297)] });
  assert.equal(badMedia.status, PAGE_STATUS.unknown);
});

// ---- 汇总 ----

test('多页文档逐页判定并正确汇总风险/未声明/无法判断页', async () => {
  const bytes = await buildPdf([
    { cropDefaulted: true }, // 未声明
    {
      trim: [0, 0, mm(210), mm(297)],
      bleed: [-mm(3), -mm(3), mm(210) + mm(3), mm(297) + mm(3)],
    }, // ok
    {
      trim: [0, 0, mm(210), mm(297)],
      bleed: [0, 0, mm(210), mm(297)],
    }, // risk：四边 0
    { badTrim: true, bleed: [-mm(3), -mm(3), mm(210) + mm(3), mm(297) + mm(3)] }, // unknown
  ]);
  const report = await checkBleedBoxes(Buffer.from(bytes), DEFAULT_OPTS);
  assert.equal(report.pageCount, 4);
  assert.deepEqual(report.summary.undeclaredPages, [1]);
  assert.deepEqual(report.summary.okPages, [2]);
  assert.deepEqual(report.summary.riskPages, [3]);
  assert.deepEqual(report.summary.unknownPages, [4]);
  assert.deepEqual(report.summary.bleedRiskPages, [3]);
  assert.equal(report.scopeNote.includes('不判断'), true);
});

// ---- 旋转映射单元测试（非零原点枢轴）----

test('mapPointToReading 以 MediaBox 为枢轴处理非零原点', () => {
  const media = { x: 10, y: 20, width: 200, height: 300 };
  // 0°：左下 (10,20) -> (0,300)
  assert.deepEqual(mapPointToReading(10, 20, 0, media), { X: 0, Y: 300 });
  // 90°CW：左下 -> 阅读左上 (0,0)
  assert.deepEqual(mapPointToReading(10, 20, 90, media), { X: 0, Y: 0 });
  // 180：左下 -> 阅读右上
  assert.deepEqual(mapPointToReading(10, 20, 180, media), { X: 200, Y: 0 });
  // 270CW：左下 -> 阅读右下
  assert.deepEqual(mapPointToReading(10, 20, 270, media), { X: 300, Y: 200 });
});

test('容差常量为 0.5 mm', () => {
  assert.equal(SIZE_TOLERANCE_MM, 0.5);
});
