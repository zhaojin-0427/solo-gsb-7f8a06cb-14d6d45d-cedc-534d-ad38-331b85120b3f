// test/annotations.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  PDFDocument,
  PDFArray,
  PDFName,
  PDFNumber,
  PDFRef,
} from 'pdf-lib';
import {
  checkAnnotations,
  AnnotationError,
  ANNOT_STATUS,
  PAGE_STATUS,
  PT_PER_MM,
} from '../annotations.js';

// ---- 构造工具 ----

const mm = (v) => v * PT_PER_MM;
// 默认页面 210x297mm，原点 0；页内注释矩形
const INSIDE = [mm(10), mm(20), mm(110), mm(120)];
// 完全在默认页框之外的注释矩形
const OUTSIDE = [mm(300), mm(400), mm(320), mm(420)];

/** 在指定上下文中构造 PDF 矩形数组（直接对象）。 */
function box(ctx, vals) {
  const a = PDFArray.withContext(ctx);
  for (const v of vals) a.push(PDFNumber.of(v));
  return a;
}

/** 外观流（Form XObject），返回间接引用。 */
function appearanceStream(doc) {
  const stream = doc.context.stream('0 0 10 10 re f', {
    Type: 'XObject',
    Subtype: 'Form',
    BBox: [0, 0, 10, 10],
  });
  return doc.context.register(stream);
}

/**
 * 构造注释字典（spec.indirect 时返回间接引用）。
 * spec: { subtype?, rect?, flags?, as?, indirect?, badRect?, badF?, ap? }
 * ap 取值：
 *   'stream'             /AP/N 为外观流（间接）
 *   'dict'               /AP/N 为外观子典，/AS 选中有效流
 *   'dict-no-as'         /AP/N 为外观子典，但缺少 /AS
 *   'dict-as-unmatched'  /AP/N 为外观子典，/AS 未选中任何流
 *   'empty'              /AP 存在但无 /N
 *   'broken'             /AP 为损坏的间接引用
 *   省略                 不写 /AP（外观缺失）
 */
function buildAnnot(doc, spec) {
  const dict = doc.context.obj({});
  if (spec.subtype !== undefined) {
    dict.set(PDFName.of('Subtype'), PDFName.of(spec.subtype));
  }
  if (spec.rect) dict.set(PDFName.of('Rect'), box(doc.context, spec.rect));
  if (spec.badRect) dict.set(PDFName.of('Rect'), spec.badRect(doc));
  if (spec.flags !== undefined) {
    dict.set(PDFName.of('F'), PDFNumber.of(spec.flags));
  }
  if (spec.badF) dict.set(PDFName.of('F'), spec.badF(doc));

  const ap = spec.ap;
  if (ap === 'stream') {
    dict.set(PDFName.of('AP'), doc.context.obj({ N: appearanceStream(doc) }));
  } else if (ap === 'dict') {
    dict.set(
      PDFName.of('AP'),
      doc.context.obj({
        N: { On: appearanceStream(doc), Off: appearanceStream(doc) },
      })
    );
    dict.set(PDFName.of('AS'), PDFName.of(spec.as ?? 'On'));
  } else if (ap === 'dict-no-as') {
    dict.set(
      PDFName.of('AP'),
      doc.context.obj({ N: { On: appearanceStream(doc) } })
    );
  } else if (ap === 'dict-as-unmatched') {
    dict.set(
      PDFName.of('AP'),
      doc.context.obj({ N: { On: appearanceStream(doc) } })
    );
    dict.set(PDFName.of('AS'), PDFName.of('Off')); // 子典中没有 /Off
  } else if (ap === 'empty') {
    dict.set(PDFName.of('AP'), doc.context.obj({}));
  } else if (ap === 'broken') {
    dict.set(PDFName.of('AP'), PDFRef.of(99990)); // 不存在的间接对象
  }

  return spec.indirect ? doc.context.register(dict) : dict;
}

/**
 * 构造测试 PDF。
 * pages: [{ media?, crop?, inheritedCrop?, annots?, indirectAnnots?, annotsRaw? }]
 *   - annots 省略/null：不写 /Annots（无注释）
 *   - annotsRaw(doc)：自定义 /Annots 原始值（损坏场景）
 *   - indirectAnnots：/Annots 数组本身使用间接引用
 */
async function buildPdf(pages) {
  const doc = await PDFDocument.create();
  const specs = pages.length === 0 ? [{}] : pages;
  const root = doc.context.lookup(doc.catalog.get(PDFName.of('Pages')));

  for (const spec of specs) {
    const media = spec.media ?? [0, 0, mm(210), mm(297)];
    const page = doc.addPage([media[2] - media[0], media[3] - media[1]]);
    const node = page.node;
    node.set(PDFName.of('MediaBox'), box(doc.context, media));
    if (spec.badMedia) node.set(PDFName.of('MediaBox'), box(doc.context, spec.badMedia));
    if (spec.crop) node.set(PDFName.of('CropBox'), box(doc.context, spec.crop));
    if (spec.badCrop) node.set(PDFName.of('CropBox'), PDFNumber.of(7));
    if (spec.inheritedCrop) {
      root.set(PDFName.of('CropBox'), box(doc.context, spec.inheritedCrop));
    }

    if (spec.annotsRaw) {
      node.set(PDFName.of('Annots'), spec.annotsRaw(doc));
      continue;
    }
    if (spec.annots === undefined || spec.annots === null) continue;
    const arr = PDFArray.withContext(doc.context);
    for (const a of spec.annots) arr.push(buildAnnot(doc, a));
    node.set(
      PDFName.of('Annots'),
      spec.indirectAnnots ? doc.context.register(arr) : arr
    );
  }

  if (pages.length === 0) {
    // 删除全部页面
    root.set(PDFName.of('Kids'), doc.context.obj([]));
    root.set(PDFName.of('Count'), PDFNumber.of(0));
  }
  return doc.save();
}

async function checkOne(spec) {
  const bytes = await buildPdf([spec]);
  const report = await checkAnnotations(Buffer.from(bytes));
  return report.pages[0];
}

// ---- 参数与文件校验 ----

test('非 PDF / 空文件 / 无页面时报 AnnotationError', async () => {
  await assert.rejects(checkAnnotations(Buffer.from('not a pdf')), AnnotationError);
  await assert.rejects(checkAnnotations(Buffer.alloc(0)), AnnotationError);
  const empty = await buildPdf([]);
  await assert.rejects(checkAnnotations(Buffer.from(empty)), AnnotationError);
});

// ---- 无注释 ----

test('无 /Annots 的页标为无注释；空数组同样无注释', async () => {
  const noKey = await checkOne({});
  assert.equal(noKey.status, PAGE_STATUS.none);
  assert.equal(noKey.annotsDeclared, false);
  assert.equal(noKey.annotations.length, 0);

  const emptyArr = await checkOne({ annots: [] });
  assert.equal(emptyArr.status, PAGE_STATUS.none);
  assert.equal(emptyArr.annotsDeclared, true);
  assert.equal(emptyArr.annotations.length, 0);
});

// ---- 直接或间接 /Annots 与注释字典 ----

test('直接或间接 /Annots 与注释字典均正确解析', async () => {
  const spec = {
    annots: [{ subtype: 'Text', rect: INSIDE, flags: 4, ap: 'stream' }],
  };
  const direct = await checkOne(spec);
  assert.equal(direct.annotations.length, 1);
  assert.equal(direct.annotations[0].status, ANNOT_STATUS.printCandidate);

  const indirect = await checkOne({
    annots: [{ subtype: 'Text', rect: INSIDE, flags: 4, ap: 'stream', indirect: true }],
    indirectAnnots: true,
  });
  assert.equal(indirect.annotations.length, 1);
  assert.equal(indirect.annotations[0].status, ANNOT_STATUS.printCandidate);
  assert.equal(indirect.annotations[0].subtype, 'Text');
});

test('字段的间接引用（/Rect、/F）正常解析', async () => {
  const bytes = await buildPdf([
    {
      annots: [
        {
          subtype: 'FreeText',
          flags: 4,
          ap: 'stream',
          badRect: (doc) => doc.context.register(box(doc.context, INSIDE)),
          badF: (doc) => doc.context.register(PDFNumber.of(4)),
        },
      ],
    },
  ]);
  const report = await checkAnnotations(Buffer.from(bytes));
  const annot = report.pages[0].annotations[0];
  assert.equal(annot.status, ANNOT_STATUS.printCandidate);
  assert.equal(annot.flags, 4);
  assert.deepEqual(annot.rectMm, { x: 10, y: 20, width: 100, height: 100 });
});

// ---- 打印候选与外观 ----

test('设 Print 且 /AP/N 为流：打印候选，外观直接采用', async () => {
  const pg = await checkOne({
    annots: [{ subtype: 'Stamp', rect: INSIDE, flags: 4, ap: 'stream' }],
  });
  const a = pg.annotations[0];
  assert.equal(a.status, ANNOT_STATUS.printCandidate);
  assert.equal(a.appearance.state, 'valid');
  assert.ok(a.appearance.note.includes('直接采用'));
  assert.equal(a.screen.text, '屏显候选');
  assert.equal(a.print.text, '打印候选');
  assert.equal(pg.status, PAGE_STATUS.ok);
});

test('/AP/N 为字典时由 /AS 选中有效流：打印候选', async () => {
  const pg = await checkOne({
    annots: [{ subtype: 'Stamp', rect: INSIDE, flags: 4, ap: 'dict', as: 'Off' }],
  });
  const a = pg.annotations[0];
  assert.equal(a.status, ANNOT_STATUS.printCandidate);
  assert.equal(a.appearance.state, 'valid');
  assert.ok(a.appearance.note.includes('/AS'));
  assert.ok(a.appearance.note.includes('/Off'));
});

test('设 Print 但外观缺失（无 /AP、/AP 无 /N）：待确认', async () => {
  const noAp = await checkOne({
    annots: [{ subtype: 'Text', rect: INSIDE, flags: 4 }],
  });
  const a1 = noAp.annotations[0];
  assert.equal(a1.status, ANNOT_STATUS.needsConfirmation);
  assert.equal(a1.appearance.state, 'missing');
  assert.equal(a1.print.text, '待确认');
  assert.equal(noAp.status, PAGE_STATUS.needsConfirmation);

  const emptyAp = await checkOne({
    annots: [{ subtype: 'Text', rect: INSIDE, flags: 4, ap: 'empty' }],
  });
  assert.equal(emptyAp.annotations[0].appearance.state, 'missing');
  assert.equal(emptyAp.annotations[0].status, ANNOT_STATUS.needsConfirmation);
});

test('设 Print 但外观损坏（/AP 坏引用、子典缺 /AS、/AS 未选中流）：待确认', async () => {
  for (const ap of ['broken', 'dict-no-as', 'dict-as-unmatched']) {
    const pg = await checkOne({
      annots: [{ subtype: 'Stamp', rect: INSIDE, flags: 4, ap }],
    });
    const a = pg.annotations[0];
    assert.equal(a.appearance.state, 'broken', ap);
    assert.equal(a.status, ANNOT_STATUS.needsConfirmation, ap);
    assert.equal(a.print.text, '待确认', ap);
  }
});

// ---- 标志位 ----

test('屏显候选而未设 Print（/F 缺省为 0）：漏印风险', async () => {
  const pg = await checkOne({
    annots: [{ subtype: 'Text', rect: INSIDE, ap: 'stream' }],
  });
  const a = pg.annotations[0];
  assert.equal(a.flags, 0); // /F 缺省为 0
  assert.equal(a.status, ANNOT_STATUS.missedPrintRisk);
  assert.equal(a.screen.text, '屏显候选');
  assert.equal(a.print.text, '不打印');
  assert.equal(pg.status, PAGE_STATUS.missedPrintRisk);
});

test('Hidden 覆盖 Print：不显示也不打印，判为正常', async () => {
  const pg = await checkOne({
    annots: [{ subtype: 'Text', rect: INSIDE, flags: 2 | 4, ap: 'stream' }],
  });
  const a = pg.annotations[0];
  assert.equal(a.status, ANNOT_STATUS.ok);
  assert.equal(a.screen.text, '不显示');
  assert.ok(a.screen.reason.includes('Hidden'));
  assert.equal(a.print.text, '不打印');
  assert.ok(a.print.reason.includes('Hidden 覆盖 Print'));
  assert.deepEqual(a.flagNames, ['Hidden', 'Print']);
});

test('NoView 只排除屏显、不取消 Print', async () => {
  // NoView + Print + 有效外观：屏上不显示，仍是打印候选
  const printable = await checkOne({
    annots: [{ subtype: 'Text', rect: INSIDE, flags: 32 | 4, ap: 'stream' }],
  });
  const a1 = printable.annotations[0];
  assert.equal(a1.screen.text, '不显示');
  assert.ok(a1.screen.reason.includes('NoView'));
  assert.equal(a1.status, ANNOT_STATUS.printCandidate);

  // 仅 NoView：不显示也不打印，属预期（正常）
  const hidden2 = await checkOne({
    annots: [{ subtype: 'Text', rect: INSIDE, flags: 32 }],
  });
  const a2 = hidden2.annotations[0];
  assert.equal(a2.status, ANNOT_STATUS.ok);
  assert.equal(a2.screen.text, '不显示');
  assert.equal(a2.print.text, '不打印');
});

// ---- 页外 ----

test('有效矩形与可见页框无交集标为页外（含仅边相接）', async () => {
  const pg = await checkOne({
    annots: [{ subtype: 'Text', rect: OUTSIDE, flags: 4, ap: 'stream' }],
  });
  const a = pg.annotations[0];
  assert.equal(a.offPage, true);
  assert.equal(a.status, ANNOT_STATUS.offPage);
  assert.equal(a.screen.text, '页外不显示');
  assert.equal(a.print.text, '页外不打印');
  assert.equal(pg.status, PAGE_STATUS.offPage);

  // 仅右边与页框右边线相接（零面积交集）也算页外
  const touching = await checkOne({
    annots: [
      { subtype: 'Text', rect: [mm(210), mm(10), mm(220), mm(50)], flags: 4, ap: 'stream' },
    ],
  });
  assert.equal(touching.annotations[0].status, ANNOT_STATUS.offPage);
});

test('可见页框为继承 CropBox（缺省 MediaBox）：框外注释标为页外', async () => {
  // CropBox 只保留左半页：矩形在 MediaBox 内但在 CropBox 外 → 页外
  const cropped = await checkOne({
    crop: [0, 0, mm(100), mm(297)],
    annots: [{ subtype: 'Text', rect: [mm(150), mm(20), mm(200), mm(60)] }],
  });
  assert.equal(cropped.annotations[0].status, ANNOT_STATUS.offPage);

  // CropBox 自 Pages 父节点继承
  const inherited = await checkOne({
    inheritedCrop: [0, 0, mm(100), mm(297)],
    annots: [
      { subtype: 'Text', rect: [mm(10), mm(20), mm(90), mm(60)] }, // 框内
      { subtype: 'Text', rect: [mm(150), mm(20), mm(200), mm(60)] }, // 框外
    ],
  });
  assert.equal(inherited.annotations[0].offPage, false);
  assert.equal(inherited.annotations[0].status, ANNOT_STATUS.missedPrintRisk);
  assert.equal(inherited.annotations[1].offPage, true);
});

test('页框无效时跳过页外判定，仍按标志位判定', async () => {
  const pg = await checkOne({
    badMedia: [0, 0, 0, mm(297)], // 退化 MediaBox
    annots: [{ subtype: 'Text', rect: INSIDE, flags: 4, ap: 'stream' }],
  });
  const a = pg.annotations[0];
  assert.equal(a.offPage, null);
  assert.equal(a.status, ANNOT_STATUS.printCandidate);
  assert.ok(pg.frameNote.includes('可见页框无法确定'));

  const badCrop = await checkOne({
    badCrop: true,
    annots: [{ subtype: 'Text', rect: INSIDE, flags: 4, ap: 'stream' }],
  });
  assert.equal(badCrop.annotations[0].offPage, null);
  assert.ok(badCrop.frameNote.includes('CropBox'));
});

// ---- 无法判断（不中断其他注释）----

test('坏引用或非法字段标为无法判断，不中断同页其他注释', async () => {
  const pg = await checkOne({
    annots: [
      { subtype: 'Text', rect: INSIDE }, // 正常：漏印风险
      { subtype: 'Text', badRect: (doc) => box(doc.context, [0, 0, 10]) }, // Rect 非 4 元素
      { subtype: 'Text', rect: [0, 0, 0, mm(10)] }, // Rect 零面积
      { subtype: 'Text', rect: INSIDE, badF: () => PDFNumber.of(-2) }, // F 为负
      { subtype: 'Text', rect: INSIDE, badF: () => PDFNumber.of(2.5) }, // F 非整数
      { rect: INSIDE }, // 缺 /Subtype
    ],
  });
  assert.equal(pg.annotations.length, 6);
  assert.equal(pg.annotations[0].status, ANNOT_STATUS.missedPrintRisk);
  for (let i = 1; i < 6; i++) {
    assert.equal(pg.annotations[i].status, ANNOT_STATUS.unknown, `第 ${i + 1} 条`);
    assert.equal(pg.annotations[i].screen.text, '无法判断');
  }
  // 缺 /Subtype 的注释仍给出 Rect 毫米位置
  assert.deepEqual(pg.annotations[5].rectMm, { x: 10, y: 20, width: 100, height: 100 });
  assert.equal(pg.status, PAGE_STATUS.unknown);
  assert.equal(pg.counts.unknown, 5);
  assert.equal(pg.counts.missedPrintRisk, 1);
});

test('注释条目为坏引用或非字典：无法判断，其余注释不受影响', async () => {
  const bytes = await buildPdf([
    {
      annotsRaw: (doc) => {
        const arr = PDFArray.withContext(doc.context);
        arr.push(PDFRef.of(99991)); // 坏引用
        arr.push(PDFNumber.of(42)); // 非字典
        arr.push(buildAnnot(doc, { subtype: 'Text', rect: INSIDE, flags: 4, ap: 'stream' }));
        return arr;
      },
    },
  ]);
  const report = await checkAnnotations(Buffer.from(bytes));
  const pg = report.pages[0];
  assert.equal(pg.annotations.length, 3);
  assert.equal(pg.annotations[0].status, ANNOT_STATUS.unknown);
  assert.ok(pg.annotations[0].notes.join('；').includes('引用损坏'));
  assert.equal(pg.annotations[1].status, ANNOT_STATUS.unknown);
  assert.equal(pg.annotations[2].status, ANNOT_STATUS.printCandidate);
});

test('/Annots 不是数组或引用损坏：整页无法判断', async () => {
  const notArray = await checkOne({
    annotsRaw: (doc) => PDFNumber.of(7),
  });
  assert.equal(notArray.status, PAGE_STATUS.unknown);
  assert.ok(notArray.pageError.includes('不是数组'));

  const brokenRef = await checkOne({
    annotsRaw: () => PDFRef.of(99992),
  });
  assert.equal(brokenRef.status, PAGE_STATUS.unknown);
  assert.ok(brokenRef.pageError.includes('引用损坏'));
});

// ---- 汇总 ----

test('多页文档逐页判定并汇总漏印风险页与待确认页', async () => {
  const bytes = await buildPdf([
    {}, // 无注释
    { annots: [{ subtype: 'Text', rect: INSIDE }] }, // 漏印风险
    { annots: [{ subtype: 'Text', rect: INSIDE, flags: 4 }] }, // 待确认（无外观）
    { annots: [{ subtype: 'Text', rect: OUTSIDE, flags: 4, ap: 'stream' }] }, // 页外
    { annots: [{ subtype: 'Text', rect: INSIDE, flags: 4, ap: 'stream' }] }, // 打印候选
  ]);
  const report = await checkAnnotations(Buffer.from(bytes));
  const { summary } = report;
  assert.equal(summary.totalPages, 5);
  assert.equal(summary.pagesWithAnnotations, 4);
  assert.equal(summary.totalAnnotations, 4);
  assert.deepEqual(summary.missedPrintRiskPages, [2]);
  assert.deepEqual(summary.needsConfirmationPages, [3]);
  assert.deepEqual(summary.offPagePages, [4]);
  assert.deepEqual(summary.unknownPages, []);
  assert.equal(summary.counts.printCandidate, 1);
  assert.equal(summary.counts.missedPrintRisk, 1);
  assert.equal(summary.counts.needsConfirmation, 1);
  assert.equal(summary.counts.offPage, 1);
  assert.ok(report.scopeNote.includes('不模拟渲染'));
});

test('同页含多状态注释时同时计入漏印风险页与待确认页', async () => {
  const bytes = await buildPdf([
    {
      annots: [
        { subtype: 'Text', rect: INSIDE }, // 漏印风险
        { subtype: 'Stamp', rect: INSIDE, flags: 4 }, // 待确认
        { subtype: 'Link', rect: OUTSIDE }, // 页外
      ],
    },
  ]);
  const report = await checkAnnotations(Buffer.from(bytes));
  const { summary } = report;
  // 页面级状态取最高优先级（漏印风险），但汇总按包含关系统计
  assert.equal(report.pages[0].status, PAGE_STATUS.missedPrintRisk);
  assert.deepEqual(summary.missedPrintRiskPages, [1]);
  assert.deepEqual(summary.needsConfirmationPages, [1]);
  assert.deepEqual(summary.offPagePages, [1]);
});

test('注释矩形以毫米输出（默认用户空间原点与宽高）', async () => {
  const pg = await checkOne({
    annots: [{ subtype: 'Caret', rect: [mm(15.5), mm(25.25), mm(115.5), mm(125.25)] }],
  });
  assert.deepEqual(pg.annotations[0].rectMm, {
    x: 15.5,
    y: 25.3,
    width: 100,
    height: 100,
  });
});
