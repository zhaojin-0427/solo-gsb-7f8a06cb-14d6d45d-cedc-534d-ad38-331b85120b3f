// test/fonts.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  PDFDocument,
  PDFName,
  PDFRef,
  StandardFonts,
} from 'pdf-lib';
import {
  checkFontEmbedding,
  stripSubsetPrefix,
  isStandard14,
  FontCheckError,
  FONT_STATUS,
  SCOPE_NOTE,
} from '../fonts.js';

// ---- 构造工具 ----

/** 未嵌入普通字体（无 FontDescriptor）。 */
function plainFontRef(doc, baseFont, subtype = 'TrueType') {
  return doc.context.register(
    doc.context.obj({ Type: 'Font', Subtype: subtype, BaseFont: baseFont })
  );
}

/** 带描述符的字体；embedAs 指定字体流字段，'empty' 表示空流，null 表示无流。 */
function descriptorFontRef(doc, baseFont, subtype, embedAs = 'FontFile2') {
  const descriptor = {
    Type: 'FontDescriptor',
    FontName: baseFont,
    Flags: 4,
    FontBBox: [0, -200, 1000, 900],
    ItalicAngle: 0,
    Ascent: 800,
    Descent: -200,
    CapHeight: 700,
    StemV: 80,
  };
  if (embedAs) {
    const bytes =
      embedAs === 'empty' ? new Uint8Array(0) : new Uint8Array([1, 2, 3, 4]);
    const key = embedAs === 'empty' ? 'FontFile2' : embedAs;
    descriptor[key] = doc.context.register(doc.context.stream(bytes));
  }
  const descRef = doc.context.register(doc.context.obj(descriptor));
  return doc.context.register(
    doc.context.obj({
      Type: 'Font',
      Subtype: subtype,
      BaseFont: baseFont,
      FontDescriptor: descRef,
    })
  );
}

/** Type0 复合字体；embed=false 时子字体描述符不含字体流。 */
function type0FontRef(doc, baseFont, { embed = true } = {}) {
  const descriptor = {
    Type: 'FontDescriptor',
    FontName: baseFont,
    Flags: 4,
    FontBBox: [0, -200, 1000, 900],
    ItalicAngle: 0,
    Ascent: 800,
    Descent: -200,
    CapHeight: 700,
    StemV: 80,
  };
  if (embed) {
    descriptor.FontFile2 = doc.context.register(
      doc.context.stream(new Uint8Array([9, 8, 7, 6]))
    );
  }
  const descRef = doc.context.register(doc.context.obj(descriptor));
  const cidRef = doc.context.register(
    doc.context.obj({
      Type: 'Font',
      Subtype: 'CIDFontType2',
      BaseFont: baseFont,
      CIDSystemInfo: { Registry: 'Adobe', Ordering: 'Identity', Supplement: 0 },
      FontDescriptor: descRef,
    })
  );
  return doc.context.register(
    doc.context.obj({
      Type: 'Font',
      Subtype: 'Type0',
      BaseFont: baseFont,
      Encoding: 'Identity-H',
      DescendantFonts: [cidRef],
    })
  );
}

/** Type3 字体（字形内建于内容流）。 */
function type3FontRef(doc, baseFont) {
  return doc.context.register(
    doc.context.obj({
      Type: 'Font',
      Subtype: 'Type3',
      BaseFont: baseFont,
      FontBBox: [0, 0, 1000, 1000],
      FontMatrix: [0.001, 0, 0, 0.001, 0, 0],
      CharProcs: {},
      Encoding: {},
      FirstChar: 0,
      LastChar: 0,
      Widths: [500],
    })
  );
}

/** 表单 XObject（自带资源字典）。 */
function formRef(doc, resources) {
  return doc.context.register(
    doc.context.stream(new Uint8Array([32]), {
      Type: 'XObject',
      Subtype: 'Form',
      BBox: [0, 0, 100, 100],
      Resources: resources,
    })
  );
}

/** 覆盖页面自身资源字典。 */
function setPageResources(doc, page, resources) {
  page.node.set(PDFName.of('Resources'), doc.context.obj(resources));
}

async function saveAndCheck(doc) {
  const bytes = Buffer.from(await doc.save());
  return checkFontEmbedding(bytes);
}

// ---- 纯函数 ----

test('stripSubsetPrefix：去掉 6 大写字母 + 加号的子集前缀', () => {
  assert.equal(stripSubsetPrefix('ABCDEF+SimSun'), 'SimSun');
  assert.equal(stripSubsetPrefix('Helvetica'), 'Helvetica');
  assert.equal(stripSubsetPrefix('ABCDE+Short'), 'ABCDE+Short'); // 5 位不算
  assert.equal(stripSubsetPrefix(null), null);
});

test('isStandard14：标准 14 字体判定（忽略子集前缀）', () => {
  assert.ok(isStandard14('Helvetica'));
  assert.ok(isStandard14('ABCDEF+Times-Bold'));
  assert.ok(isStandard14('ZapfDingbats'));
  assert.ok(!isStandard14('SimSun'));
  assert.ok(!isStandard14('HelveticaNeue'));
  assert.ok(!isStandard14(null));
});

// ---- 集成：pdf-lib 生成 PDF，走完整核查流程 ----

test('普通字体：非空字体流算已嵌入，缺描述符 / 缺流 / 空流算未嵌入', async () => {
  const doc = await PDFDocument.create();
  const page = doc.addPage([595, 842]);
  setPageResources(doc, page, {
    Font: {
      F1: descriptorFontRef(doc, 'MySans', 'TrueType', 'FontFile2'),
      F2: plainFontRef(doc, 'CustomSans'), // 无描述符
      F3: descriptorFontRef(doc, 'NoStream', 'Type1', null), // 描述符无字体流
      F4: descriptorFontRef(doc, 'EmptyStream', 'TrueType', 'empty'), // 空流
      F5: descriptorFontRef(doc, 'CffFont', 'Type1', 'FontFile3'),
    },
  });
  const report = await saveAndCheck(doc);

  assert.equal(report.pageCount, 1);
  const fonts = report.pages[0].fonts;
  assert.equal(fonts.length, 5);
  const byName = Object.fromEntries(fonts.map((f) => [f.resourceName, f]));

  assert.equal(byName.F1.status, FONT_STATUS.embedded);
  assert.match(byName.F1.note, /FontFile2/);
  assert.equal(byName.F1.baseFont, 'MySans');
  assert.equal(byName.F1.subtype, 'TrueType');
  assert.equal(byName.F1.source, '页面资源');

  assert.equal(byName.F2.status, FONT_STATUS.notEmbedded);
  assert.match(byName.F2.note, /FontDescriptor/);

  assert.equal(byName.F3.status, FONT_STATUS.notEmbedded);
  assert.match(byName.F3.note, /FontFile/);

  assert.equal(byName.F4.status, FONT_STATUS.notEmbedded);
  assert.match(byName.F4.note, /为空/);

  assert.equal(byName.F5.status, FONT_STATUS.embedded);
  assert.match(byName.F5.note, /FontFile3/);

  assert.equal(report.pages[0].status, 'risk');
  assert.equal(report.summary.pagesWithUnembedded, 1);
  assert.equal(report.summary.embedded, 2);
  assert.equal(report.summary.notEmbedded, 3);
});

test('未嵌入的标准 14 字体单列为可替代', async () => {
  const doc = await PDFDocument.create();
  // pdf-lib 嵌入标准字体时不写字体流 → 未嵌入的标准 14
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const page = doc.addPage([595, 842]);
  page.drawText('Hello', { font, x: 50, y: 700 });
  // 再加一个子集前缀的标准 14 与一个非标准字体
  const page2 = doc.addPage([595, 842]);
  setPageResources(doc, page2, {
    Font: {
      F1: plainFontRef(doc, 'ABCDEF+Courier-Bold', 'Type1'),
      F2: plainFontRef(doc, 'SimSun'),
    },
  });
  const report = await saveAndCheck(doc);

  const [p1, p2] = report.pages;
  assert.equal(p1.fonts.length, 1);
  assert.equal(p1.fonts[0].status, FONT_STATUS.standard14);
  assert.equal(p1.fonts[0].baseFont, 'Helvetica');
  assert.equal(p1.status, 'ok'); // 可替代不计入未嵌入

  const byName = Object.fromEntries(p2.fonts.map((f) => [f.resourceName, f]));
  assert.equal(byName.F1.status, FONT_STATUS.standard14); // 子集前缀仍识别
  assert.equal(byName.F2.status, FONT_STATUS.notEmbedded);
  assert.equal(p2.status, 'risk');

  assert.equal(report.summary.standard14, 2);
  assert.equal(report.summary.pagesWithStandard14, 2);
  assert.equal(report.summary.pagesWithUnembedded, 1);
});

test('Type0 字体沿 DescendantFonts 查找；缺子字体标无法判断', async () => {
  const doc = await PDFDocument.create();
  const page = doc.addPage([595, 842]);
  const noDescendants = doc.context.register(
    doc.context.obj({
      Type: 'Font',
      Subtype: 'Type0',
      BaseFont: 'BrokenCID',
      Encoding: 'Identity-H',
    })
  );
  setPageResources(doc, page, {
    Font: {
      F1: type0FontRef(doc, 'ABCDEF+MyCID', { embed: true }),
      F2: type0FontRef(doc, 'NotEmbeddedCID', { embed: false }),
      F3: noDescendants,
    },
  });
  const report = await saveAndCheck(doc);

  const byName = Object.fromEntries(
    report.pages[0].fonts.map((f) => [f.resourceName, f])
  );
  assert.equal(byName.F1.status, FONT_STATUS.embedded);
  assert.equal(byName.F1.subtype, 'Type0');
  assert.equal(byName.F2.status, FONT_STATUS.notEmbedded);
  assert.equal(byName.F3.status, FONT_STATUS.unknown);
  assert.match(byName.F3.note, /DescendantFonts/);
});

test('Type3 标为内置字形', async () => {
  const doc = await PDFDocument.create();
  const page = doc.addPage([595, 842]);
  setPageResources(doc, page, {
    Font: { F1: type3FontRef(doc, 'MyType3') },
  });
  const report = await saveAndCheck(doc);

  const font = report.pages[0].fonts[0];
  assert.equal(font.status, FONT_STATUS.type3);
  assert.match(font.note, /Type3/);
  assert.equal(report.pages[0].status, 'ok');
  assert.equal(report.summary.type3, 1);
});

test('损坏的字体字典标为无法判断', async () => {
  const doc = await PDFDocument.create();
  const page = doc.addPage([595, 842]);
  setPageResources(doc, page, {
    Font: {
      F1: 42, // 条目不是字典
      F2: PDFRef.of(9999, 0), // 悬空引用
      F3: plainFontRef(doc, 'Weird', 'PostScript'), // 无法识别的子类型
      F4: descriptorFontRef(doc, 'GoodFont', 'TrueType', 'FontFile2'),
    },
  });
  const report = await saveAndCheck(doc);

  const byName = Object.fromEntries(
    report.pages[0].fonts.map((f) => [f.resourceName, f])
  );
  assert.equal(byName.F1.status, FONT_STATUS.unknown);
  assert.match(byName.F1.note, /不是字典/);
  assert.equal(byName.F2.status, FONT_STATUS.unknown);
  assert.equal(byName.F3.status, FONT_STATUS.unknown);
  assert.match(byName.F3.note, /子类型/);
  assert.equal(byName.F4.status, FONT_STATUS.embedded);
  assert.equal(report.pages[0].status, 'unknown'); // 无未嵌入但有无法判断
  assert.equal(report.summary.unknown, 3);
  assert.equal(report.summary.pagesWithUnknown, 1);
});

test('继承的 Resources：资源挂在 Pages 父节点也能逐页读到', async () => {
  const doc = await PDFDocument.create();
  const p1 = doc.addPage([595, 842]);
  const p2 = doc.addPage([595, 842]);
  // 删除页自身资源，模拟自父节点继承的 PDF
  p1.node.delete(PDFName.of('Resources'));
  p2.node.delete(PDFName.of('Resources'));
  p1.node
    .Parent()
    .set(
      PDFName.of('Resources'),
      doc.context.obj({ Font: { F1: plainFontRef(doc, 'InheritedSans') } })
    );
  const report = await saveAndCheck(doc);

  assert.equal(report.pages.length, 2);
  for (const pg of report.pages) {
    assert.equal(pg.fonts.length, 1);
    assert.equal(pg.fonts[0].baseFont, 'InheritedSans');
    assert.equal(pg.fonts[0].status, FONT_STATUS.notEmbedded);
    assert.equal(pg.status, 'risk');
  }
  assert.equal(report.summary.pagesWithUnembedded, 2);
});

test('递归检查表单 XObject 资源，来源逐层标注', async () => {
  const doc = await PDFDocument.create();
  const innerFont = plainFontRef(doc, 'InnerFont');
  const inner = formRef(doc, { Font: { FIn: innerFont } });
  const outerFont = descriptorFontRef(doc, 'OuterFont', 'TrueType', 'FontFile2');
  const outer = formRef(doc, {
    Font: { FOut: outerFont },
    XObject: { Fm2: inner },
  });
  const page = doc.addPage([595, 842]);
  setPageResources(doc, page, {
    Font: { F1: plainFontRef(doc, 'PageFont') },
    XObject: { Fm1: outer },
  });
  const report = await saveAndCheck(doc);

  const fonts = report.pages[0].fonts;
  assert.equal(fonts.length, 3);
  const byName = Object.fromEntries(fonts.map((f) => [f.resourceName, f]));
  assert.equal(byName.F1.source, '页面资源');
  assert.equal(byName.FOut.source, '表单 XObject /Fm1');
  assert.equal(byName.FOut.status, FONT_STATUS.embedded);
  assert.equal(byName.FIn.source, '表单 XObject /Fm1 → /Fm2');
  assert.equal(byName.FIn.status, FONT_STATUS.notEmbedded);
});

test('同一表单被多页引用时逐页计入', async () => {
  const doc = await PDFDocument.create();
  const shared = formRef(doc, { Font: { FSh: plainFontRef(doc, 'SharedFont') } });
  const p1 = doc.addPage([595, 842]);
  const p2 = doc.addPage([595, 842]);
  setPageResources(doc, p1, { XObject: { Fm1: shared } });
  setPageResources(doc, p2, { XObject: { Fm1: shared } });
  const report = await saveAndCheck(doc);

  assert.equal(report.pages[0].fonts.length, 1);
  assert.equal(report.pages[1].fonts.length, 1);
  assert.equal(report.pages[0].fonts[0].baseFont, 'SharedFont');
  assert.equal(report.pages[1].fonts[0].baseFont, 'SharedFont');
  assert.equal(report.summary.totalFontRefs, 2);
  assert.equal(report.summary.pagesWithUnembedded, 2);
});

test('表单循环引用（互相引用与自引用）不会卡住核查', async () => {
  const doc = await PDFDocument.create();
  // 互相引用：A ↔ B（nextRef 预留前向引用，避免与自动编号冲突）
  const aRef = doc.context.nextRef();
  const bRef = doc.context.nextRef();
  doc.context.assign(
    aRef,
    doc.context.stream(new Uint8Array([32]), {
      Type: 'XObject',
      Subtype: 'Form',
      BBox: [0, 0, 100, 100],
      Resources: {
        Font: { FA: plainFontRef(doc, 'FontA') },
        XObject: { B: bRef },
      },
    })
  );
  doc.context.assign(
    bRef,
    doc.context.stream(new Uint8Array([32]), {
      Type: 'XObject',
      Subtype: 'Form',
      BBox: [0, 0, 100, 100],
      Resources: {
        Font: { FB: plainFontRef(doc, 'FontB') },
        XObject: { A: aRef },
      },
    })
  );
  // 自引用：C → C
  const cRef = doc.context.nextRef();
  doc.context.assign(
    cRef,
    doc.context.stream(new Uint8Array([32]), {
      Type: 'XObject',
      Subtype: 'Form',
      BBox: [0, 0, 100, 100],
      Resources: {
        Font: { FC: plainFontRef(doc, 'FontC') },
        XObject: { C: cRef },
      },
    })
  );
  const page = doc.addPage([595, 842]);
  setPageResources(doc, page, { XObject: { FmA: aRef, FmC: cRef } });

  const report = await saveAndCheck(doc);
  const names = report.pages[0].fonts.map((f) => f.baseFont).sort();
  assert.deepEqual(names, ['FontA', 'FontB', 'FontC']); // 各计一次，未死循环
  assert.equal(report.summary.totalFontRefs, 3);
});

test('无字体资源的页面：通过并附说明', async () => {
  const doc = await PDFDocument.create();
  doc.addPage([595, 842]);
  const report = await saveAndCheck(doc);

  assert.equal(report.pages[0].status, 'ok');
  assert.equal(report.pages[0].fonts.length, 0);
  assert.match(report.pages[0].note, /未引用字体资源/);
  assert.equal(report.summary.totalFontRefs, 0);
  assert.equal(report.summary.pagesWithUnembedded, 0);
});

test('报告注明检查对象是资源引用', async () => {
  const doc = await PDFDocument.create();
  doc.addPage([595, 842]);
  const report = await saveAndCheck(doc);
  assert.equal(report.scopeNote, SCOPE_NOTE);
  assert.match(report.scopeNote, /资源字典中的字体引用/);
  assert.match(report.scopeNote, /不判断字形是否在页面中实际绘制/);
});

test('非 PDF / 空文件报错', async () => {
  await assert.rejects(
    () => checkFontEmbedding(Buffer.from('not a pdf at all')),
    (e) => e instanceof FontCheckError && /PDF/.test(e.message)
  );
  await assert.rejects(
    () => checkFontEmbedding(Buffer.alloc(0)),
    (e) => e instanceof FontCheckError
  );
});

test('损坏的 PDF 字节报错', async () => {
  const doc = await PDFDocument.create();
  doc.addPage([595, 842]);
  const good = Buffer.from(await doc.save());
  const broken = Buffer.concat([
    good.subarray(0, 20),
    Buffer.from('####garbled####'),
    good.subarray(good.length - 20),
  ]);
  await assert.rejects(
    () => checkFontEmbedding(broken),
    (e) => e instanceof FontCheckError
  );
});
