// test/linktargets.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  PDFDocument,
  PDFArray,
  PDFName,
  PDFNumber,
  PDFRef,
  PDFString,
  PDFHexString,
} from 'pdf-lib';
import { checkAnnotations, ANNOT_STATUS } from '../annotations.js';
import { LINK_STATUS } from '../linktargets.js';

// ---- 构造工具 ----

const PT_PER_MM = 72 / 25.4;
const mm = (v) => v * PT_PER_MM;
// 默认页面 210x297mm，页内注释矩形
const INSIDE = [mm(10), mm(20), mm(110), mm(120)];

/** 在指定上下文中构造 PDF 矩形数组（直接对象）。 */
function box(ctx, vals) {
  const a = PDFArray.withContext(ctx);
  for (const v of vals) a.push(PDFNumber.of(v));
  return a;
}

/**
 * 构造 /Link 注释字典（直接对象）。
 * spec: { rect?, badRect?, flags?, destRaw?(doc, pages), actionRaw?(doc, pages) }
 *   - destRaw：自定义 /Dest 原始值（数组、名称、字符串、引用等）
 *   - actionRaw：自定义 /A 原始值
 */
function linkAnnot(doc, spec = {}) {
  const dict = doc.context.obj({});
  dict.set(PDFName.of('Subtype'), PDFName.of('Link'));
  if (spec.badRect) dict.set(PDFName.of('Rect'), spec.badRect(doc));
  else dict.set(PDFName.of('Rect'), box(doc.context, spec.rect ?? INSIDE));
  if (spec.flags !== undefined) {
    dict.set(PDFName.of('F'), PDFNumber.of(spec.flags));
  }
  if (spec.destRaw) dict.set(PDFName.of('Dest'), spec.destRaw(doc));
  if (spec.actionRaw) dict.set(PDFName.of('A'), spec.actionRaw(doc));
  return dict;
}

/** 构造普通文本注释（非 /Link）。 */
function textAnnot(doc) {
  const dict = doc.context.obj({});
  dict.set(PDFName.of('Subtype'), PDFName.of('Text'));
  dict.set(PDFName.of('Rect'), box(doc.context, INSIDE));
  return dict;
}

/**
 * 构造测试 PDF。
 * pageSpecs: [{ annots?: [dict | (doc, pages) => dict] }]
 * setup(doc, pages)：保存前回调（设置 Catalog/Dests、Catalog/Names 等）
 */
async function buildPdf(pageSpecs, setup) {
  const doc = await PDFDocument.create();
  const pages = pageSpecs.map(() => doc.addPage([mm(210), mm(297)]));
  pageSpecs.forEach((spec, i) => {
    if (!spec.annots) return;
    const arr = PDFArray.withContext(doc.context);
    for (const a of spec.annots) {
      arr.push(typeof a === 'function' ? a(doc, pages) : a);
    }
    pages[i].node.set(PDFName.of('Annots'), arr);
  });
  if (setup) setup(doc, pages);
  return doc.save();
}

async function checkLinks(bytes) {
  const report = await checkAnnotations(Buffer.from(bytes));
  return report.linkTargets;
}

/** 显式目标数组：[pageRef, /Fit]（pages 下标从 0 起）。 */
function destTo(doc, pages, pageIndex) {
  return doc.context.obj([pages[pageIndex].ref, 'Fit']);
}

// ---- 显式目标数组 ----

test('显式目标数组：首项为本文件页面引用，显示从 1 起的页序（不查缩放参数）', async () => {
  const bytes = await buildPdf([
    {
      annots: [
        // 指向第 2 页，带缩放/位置参数（不核对）
        (doc, pages) =>
          linkAnnot(doc, {
            destRaw: () =>
              doc.context.obj([pages[1].ref, 'XYZ', 0, 0, 5]),
          }),
        // 指向第 3 页
        (doc, pages) =>
          linkAnnot(doc, { destRaw: () => destTo(doc, pages, 2) }),
        // 指向自身（第 1 页）
        (doc, pages) =>
          linkAnnot(doc, { destRaw: () => destTo(doc, pages, 0) }),
      ],
    },
    {},
    {},
  ]);
  const lt = await checkLinks(bytes);
  assert.equal(lt.total, 3);
  assert.deepEqual(
    lt.items.map((it) => [it.pageNumber, it.annotIndex, it.targetPage, it.status]),
    [
      [1, 1, 2, LINK_STATUS.ok],
      [1, 2, 3, LINK_STATUS.ok],
      [1, 3, 1, LINK_STATUS.ok],
    ]
  );
  assert.equal(lt.counts.ok, 3);
  assert.equal(lt.counts.broken, 0);
  assert.equal(lt.counts.unknown, 0);
});

test('目标数组首项异常：坏引用→无法判断；非页引用→失效；非引用→无法判断；空数组→无法判断', async () => {
  const bytes = await buildPdf([
    {
      annots: [
        // 首项为不存在的间接引用
        (doc) =>
          linkAnnot(doc, {
            destRaw: () => doc.context.obj([PDFRef.of(99990), 'Fit']),
          }),
        // 首项引用可解析但不是页面（数字对象）
        (doc) =>
          linkAnnot(doc, {
            destRaw: () =>
              doc.context.obj([doc.context.register(PDFNumber.of(5)), 'Fit']),
          }),
        // 首项为数字（非法类型）
        (doc) => linkAnnot(doc, { destRaw: () => doc.context.obj([3, 'Fit']) }),
        // 空目标数组
        (doc) => linkAnnot(doc, { destRaw: () => doc.context.obj([]) }),
      ],
    },
  ]);
  const lt = await checkLinks(bytes);
  assert.equal(lt.total, 4);
  assert.equal(lt.items[0].status, LINK_STATUS.unknown);
  assert.ok(lt.items[0].reason.includes('间接引用损坏'));
  assert.equal(lt.items[1].status, LINK_STATUS.broken);
  assert.ok(lt.items[1].reason.includes('目标页不存在'));
  assert.equal(lt.items[2].status, LINK_STATUS.unknown);
  assert.ok(lt.items[2].reason.includes('非法类型'));
  assert.equal(lt.items[3].status, LINK_STATUS.unknown);
  assert.ok(lt.items[3].reason.includes('为空'));
  assert.equal(lt.counts.unknown, 3);
  assert.equal(lt.counts.broken, 1);
});

test('/Dest 为间接引用的目标数组：正常解析', async () => {
  const bytes = await buildPdf(
    [
      {
        annots: [
          (doc, pages) =>
            linkAnnot(doc, {
              destRaw: () => doc.context.register(destTo(doc, pages, 1)),
            }),
        ],
      },
      {},
    ]
  );
  const lt = await checkLinks(bytes);
  assert.equal(lt.items[0].status, LINK_STATUS.ok);
  assert.equal(lt.items[0].targetPage, 2);
});

test('/Dest 为非法类型（数字）或坏引用：无法判断', async () => {
  const bytes = await buildPdf([
    {
      annots: [
        (doc) => linkAnnot(doc, { destRaw: () => PDFNumber.of(3) }),
        (doc) => linkAnnot(doc, { destRaw: () => PDFRef.of(99991) }),
      ],
    },
  ]);
  const lt = await checkLinks(bytes);
  assert.equal(lt.items[0].status, LINK_STATUS.unknown);
  assert.ok(lt.items[0].reason.includes('非法类型'));
  assert.equal(lt.items[1].status, LINK_STATUS.unknown);
  assert.ok(lt.items[1].reason.includes('间接引用损坏'));
});

// ---- /A 动作 ----

test('/A（/S=/GoTo）的 /D 为目标数组：核对通过', async () => {
  const bytes = await buildPdf(
    [
      {
        annots: [
          (doc, pages) =>
            linkAnnot(doc, {
              actionRaw: () =>
                doc.context.obj({ S: 'GoTo', D: destTo(doc, pages, 1) }),
            }),
        ],
      },
      {},
    ]
  );
  const lt = await checkLinks(bytes);
  assert.equal(lt.items[0].status, LINK_STATUS.ok);
  assert.equal(lt.items[0].targetPage, 2);
  assert.ok(lt.items[0].reason.includes('/D'));
});

test('/Dest 与 /A（/S=/GoTo）的 /D 并存：无法判断', async () => {
  const bytes = await buildPdf(
    [
      {
        annots: [
          (doc, pages) =>
            linkAnnot(doc, {
              destRaw: () => destTo(doc, pages, 1),
              actionRaw: () =>
                doc.context.obj({ S: 'GoTo', D: destTo(doc, pages, 1) }),
            }),
        ],
      },
      {},
    ]
  );
  const lt = await checkLinks(bytes);
  assert.equal(lt.items[0].status, LINK_STATUS.unknown);
  assert.ok(lt.items[0].reason.includes('同时存在'));
});

test('未设目标（无 /Dest 且无 /A；/A 为 /GoTo 但缺 /D）：失效', async () => {
  const bytes = await buildPdf([
    {
      annots: [
        (doc) => linkAnnot(doc), // 两者皆无
        (doc) =>
          linkAnnot(doc, {
            actionRaw: () => doc.context.obj({ S: 'GoTo' }), // GoTo 缺 /D
          }),
      ],
    },
  ]);
  const lt = await checkLinks(bytes);
  assert.equal(lt.items[0].status, LINK_STATUS.broken);
  assert.ok(lt.items[0].reason.includes('未设目标'));
  assert.equal(lt.items[1].status, LINK_STATUS.broken);
  assert.ok(lt.items[1].reason.includes('未设目标'));
  assert.equal(lt.counts.broken, 2);
});

test('其他动作（/URI、/GoToR、/Launch）：范围外，不访问网络', async () => {
  const bytes = await buildPdf([
    {
      annots: [
        (doc) =>
          linkAnnot(doc, {
            actionRaw: () =>
              doc.context.obj({ S: 'URI', URI: PDFString.of('https://example.com') }),
          }),
        (doc) =>
          linkAnnot(doc, {
            actionRaw: (d) =>
              d.context.obj({ S: 'GoToR', D: [PDFNumber.of(0), 'Fit'] }),
          }),
        (doc) =>
          linkAnnot(doc, {
            actionRaw: () => doc.context.obj({ S: 'Launch' }),
          }),
      ],
    },
  ]);
  const lt = await checkLinks(bytes);
  assert.equal(lt.total, 3);
  for (const item of lt.items) {
    assert.equal(item.status, LINK_STATUS.outOfScope, item.reason);
    assert.ok(item.reason.includes('不访问网络'));
  }
  assert.equal(lt.counts.outOfScope, 3);
});

test('/A 坏引用、非字典或缺 /S：无法判断', async () => {
  const bytes = await buildPdf([
    {
      annots: [
        (doc) => linkAnnot(doc, { actionRaw: () => PDFRef.of(99992) }), // 坏引用
        (doc) => linkAnnot(doc, { actionRaw: () => PDFNumber.of(1) }), // 非字典
        (doc) =>
          linkAnnot(doc, {
            actionRaw: (d) => d.context.obj({ D: [] }), // 缺 /S
          }),
        (doc) =>
          linkAnnot(doc, {
            actionRaw: () => doc.context.obj({ S: PDFNumber.of(7) }), // /S 非名称
          }),
      ],
    },
  ]);
  const lt = await checkLinks(bytes);
  assert.equal(lt.total, 4);
  for (const item of lt.items) {
    assert.equal(item.status, LINK_STATUS.unknown, item.reason);
  }
});

// ---- 名称目标：Catalog/Dests ----

test('名称目标查 Catalog/Dests：数组值与 /D 字典值均支持', async () => {
  const bytes = await buildPdf(
    [
      {
        annots: [
          (doc) =>
            linkAnnot(doc, { destRaw: () => PDFName.of('Chap1') }), // 数组值
          (doc) =>
            linkAnnot(doc, { destRaw: () => PDFName.of('Chap2') }), // /D 字典值
        ],
      },
      {},
      {},
    ],
    (doc, pages) => {
      doc.catalog.set(
        PDFName.of('Dests'),
        doc.context.obj({
          Chap1: destTo(doc, pages, 1),
          Chap2: { D: destTo(doc, pages, 2) },
        })
      );
    }
  );
  const lt = await checkLinks(bytes);
  assert.equal(lt.items[0].status, LINK_STATUS.ok);
  assert.equal(lt.items[0].targetPage, 2);
  assert.equal(lt.items[1].status, LINK_STATUS.ok);
  assert.equal(lt.items[1].targetPage, 3);
});

test('名称按解码原文匹配（#XX 转义等价）', async () => {
  const bytes = await buildPdf(
    [
      {
        annots: [
          // “Chapter 1”编码为 /Chapter#201
          (doc) => linkAnnot(doc, { destRaw: () => PDFName.of('Chapter 1') }),
        ],
      },
      {},
    ],
    (doc, pages) => {
      doc.catalog.set(
        PDFName.of('Dests'),
        doc.context.obj({ 'Chapter 1': destTo(doc, pages, 1) })
      );
    }
  );
  const lt = await checkLinks(bytes);
  assert.equal(lt.items[0].status, LINK_STATUS.ok);
  assert.equal(lt.items[0].targetPage, 2);
});

test('名称缺名、无 Dests、Dests 结构损坏分别记为失效/无法判断', async () => {
  // Dests 存在但缺名 → 失效
  const missing = await buildPdf(
    [
      {
        annots: [(doc) => linkAnnot(doc, { destRaw: () => PDFName.of('Nope') })],
      },
    ],
    (doc, pages) => {
      doc.catalog.set(
        PDFName.of('Dests'),
        doc.context.obj({ Other: destTo(doc, pages, 0) })
      );
    }
  );
  const lt1 = await checkLinks(missing);
  assert.equal(lt1.items[0].status, LINK_STATUS.broken);
  assert.ok(lt1.items[0].reason.includes('缺名'));

  // 无 Catalog/Dests → 失效
  const noDests = await buildPdf([
    { annots: [(doc) => linkAnnot(doc, { destRaw: () => PDFName.of('Nope') })] },
  ]);
  const lt2 = await checkLinks(noDests);
  assert.equal(lt2.items[0].status, LINK_STATUS.broken);

  // Dests 不是字典 → 无法判断
  const badDests = await buildPdf(
    [
      {
        annots: [(doc) => linkAnnot(doc, { destRaw: () => PDFName.of('Nope') })],
      },
    ],
    (doc) => {
      doc.catalog.set(PDFName.of('Dests'), PDFNumber.of(7));
    }
  );
  const lt3 = await checkLinks(badDests);
  assert.equal(lt3.items[0].status, LINK_STATUS.unknown);

  // Dests 为坏引用 → 无法判断
  const brokenRef = await buildPdf(
    [
      {
        annots: [(doc) => linkAnnot(doc, { destRaw: () => PDFName.of('Nope') })],
      },
    ],
    (doc) => {
      doc.catalog.set(PDFName.of('Dests'), PDFRef.of(99993));
    }
  );
  const lt4 = await checkLinks(brokenRef);
  assert.equal(lt4.items[0].status, LINK_STATUS.unknown);
});

test('Dests 命中值异常：坏引用、非法类型、字典缺 /D 均无法判断', async () => {
  const bytes = await buildPdf(
    [
      {
        annots: [
          (doc) => linkAnnot(doc, { destRaw: () => PDFName.of('A') }),
          (doc) => linkAnnot(doc, { destRaw: () => PDFName.of('B') }),
          (doc) => linkAnnot(doc, { destRaw: () => PDFName.of('C') }),
        ],
      },
    ],
    (doc) => {
      doc.catalog.set(
        PDFName.of('Dests'),
        doc.context.obj({
          A: PDFRef.of(99994), // 值坏引用
          B: 42, // 值非法类型
          C: { X: 1 }, // 字典缺 /D
        })
      );
    }
  );
  const lt = await checkLinks(bytes);
  assert.equal(lt.total, 3);
  for (const item of lt.items) {
    assert.equal(item.status, LINK_STATUS.unknown, item.reason);
  }
});

// ---- 字符串目标：Catalog/Names/Dests 名称树 ----

test('字符串目标查名称树：根 /Names 与 /Kids 分支均命中（值支持数组与 /D 字典）', async () => {
  const bytes = await buildPdf(
    [
      {
        annots: [
          (doc) => linkAnnot(doc, { destRaw: () => PDFString.of('root-hit') }),
          (doc) => linkAnnot(doc, { destRaw: () => PDFString.of('kid-hit') }),
        ],
      },
      {},
      {},
    ],
    (doc, pages) => {
      const kid = doc.context.obj({
        Names: [PDFString.of('kid-hit'), { D: destTo(doc, pages, 2) }],
        Limits: [PDFString.of('kid-hit'), PDFString.of('kid-hit')],
      });
      const kidRef = doc.context.register(kid);
      const root = doc.context.obj({
        Names: [PDFString.of('root-hit'), destTo(doc, pages, 1)],
        Kids: [kidRef],
      });
      doc.catalog.set(PDFName.of('Names'), doc.context.obj({ Dests: root }));
    }
  );
  const lt = await checkLinks(bytes);
  assert.equal(lt.items[0].status, LINK_STATUS.ok);
  assert.equal(lt.items[0].targetPage, 2);
  assert.equal(lt.items[1].status, LINK_STATUS.ok);
  assert.equal(lt.items[1].targetPage, 3);
});

test('字符串按解码原文匹配（HexString 与 String 等价）', async () => {
  const bytes = await buildPdf(
    [
      {
        annots: [
          (doc) =>
            linkAnnot(doc, { destRaw: () => PDFHexString.fromText('chap 1') }),
        ],
      },
      {},
    ],
    (doc, pages) => {
      doc.catalog.set(
        PDFName.of('Names'),
        doc.context.obj({
          Dests: {
            Names: [PDFString.of('chap 1'), destTo(doc, pages, 1)],
          },
        })
      );
    }
  );
  const lt = await checkLinks(bytes);
  assert.equal(lt.items[0].status, LINK_STATUS.ok);
  assert.equal(lt.items[0].targetPage, 2);
});

test('名称树缺名：完整查找后失效；无名称树同样失效', async () => {
  // 树存在但缺名 → 失效
  const missing = await buildPdf(
    [
      {
        annots: [
          (doc) => linkAnnot(doc, { destRaw: () => PDFString.of('nowhere') }),
        ],
      },
    ],
    (doc, pages) => {
      doc.catalog.set(
        PDFName.of('Names'),
        doc.context.obj({
          Dests: { Names: [PDFString.of('other'), destTo(doc, pages, 0)] },
        })
      );
    }
  );
  const lt1 = await checkLinks(missing);
  assert.equal(lt1.items[0].status, LINK_STATUS.broken);
  assert.ok(lt1.items[0].reason.includes('缺名'));

  // 无 Catalog/Names → 失效
  const noNames = await buildPdf([
    {
      annots: [
        (doc) => linkAnnot(doc, { destRaw: () => PDFString.of('nowhere') }),
      ],
    },
  ]);
  const lt2 = await checkLinks(noNames);
  assert.equal(lt2.items[0].status, LINK_STATUS.broken);

  // Names 无 Dests 键 → 失效
  const noDestsKey = await buildPdf(
    [
      {
        annots: [
          (doc) => linkAnnot(doc, { destRaw: () => PDFString.of('nowhere') }),
        ],
      },
    ],
    (doc) => {
      doc.catalog.set(PDFName.of('Names'), doc.context.obj({}));
    }
  );
  const lt3 = await checkLinks(noDestsKey);
  assert.equal(lt3.items[0].status, LINK_STATUS.broken);
});

test('名称树重名（多处同名条目）：无法判断', async () => {
  const bytes = await buildPdf(
    [
      {
        annots: [
          (doc) => linkAnnot(doc, { destRaw: () => PDFString.of('dup') }),
        ],
      },
      {},
      {},
    ],
    (doc, pages) => {
      const kid = doc.context.obj({
        Names: [PDFString.of('dup'), destTo(doc, pages, 2)],
      });
      doc.catalog.set(
        PDFName.of('Names'),
        doc.context.obj({
          Dests: {
            Names: [PDFString.of('dup'), destTo(doc, pages, 1)],
            Kids: [doc.context.register(kid)],
          },
        })
      );
    }
  );
  const lt = await checkLinks(bytes);
  assert.equal(lt.items[0].status, LINK_STATUS.unknown);
  assert.ok(lt.items[0].reason.includes('重名'));
});

test('名称树有坏分支且未命中：无法判断；坏分支但其他分支命中：不受影响', async () => {
  // 坏分支（Kids 含坏引用）+ 未命中 → 无法判断
  const miss = await buildPdf(
    [
      {
        annots: [
          (doc) => linkAnnot(doc, { destRaw: () => PDFString.of('nowhere') }),
        ],
      },
    ],
    (doc) => {
      doc.catalog.set(
        PDFName.of('Names'),
        doc.context.obj({ Dests: { Kids: [PDFRef.of(99995)] } })
      );
    }
  );
  const lt1 = await checkLinks(miss);
  assert.equal(lt1.items[0].status, LINK_STATUS.unknown);
  assert.ok(lt1.items[0].reason.includes('损坏分支'));

  // 坏分支 + 其他分支命中 → 正常命中
  const hit = await buildPdf(
    [
      {
        annots: [
          (doc) => linkAnnot(doc, { destRaw: () => PDFString.of('here') }),
        ],
      },
      {},
    ],
    (doc, pages) => {
      doc.catalog.set(
        PDFName.of('Names'),
        doc.context.obj({
          Dests: {
            Names: [PDFString.of('here'), destTo(doc, pages, 1)],
            Kids: [PDFRef.of(99995)], // 坏分支不影响已命中的查找
          },
        })
      );
    }
  );
  const lt2 = await checkLinks(hit);
  assert.equal(lt2.items[0].status, LINK_STATUS.ok);
  assert.equal(lt2.items[0].targetPage, 2);
});

test('名称树 /Kids 循环引用且未命中：无法判断（不死循环）', async () => {
  const bytes = await buildPdf(
    [
      {
        annots: [
          (doc) => linkAnnot(doc, { destRaw: () => PDFString.of('nowhere') }),
        ],
      },
    ],
    (doc) => {
      const kid = doc.context.obj({});
      const kidRef = doc.context.register(kid);
      kid.set(PDFName.of('Kids'), doc.context.obj([kidRef])); // 自引用循环
      doc.catalog.set(PDFName.of('Names'), doc.context.obj({ Dests: kidRef }));
    }
  );
  const lt = await checkLinks(bytes);
  assert.equal(lt.items[0].status, LINK_STATUS.unknown);
  assert.ok(lt.items[0].reason.includes('循环'));
});

test('名称树根损坏或命中值坏引用：无法判断', async () => {
  // Names/Dests 不是字典 → 无法判断
  const badRoot = await buildPdf(
    [
      {
        annots: [
          (doc) => linkAnnot(doc, { destRaw: () => PDFString.of('x') }),
        ],
      },
    ],
    (doc) => {
      doc.catalog.set(
        PDFName.of('Names'),
        doc.context.obj({ Dests: PDFNumber.of(3) })
      );
    }
  );
  const lt1 = await checkLinks(badRoot);
  assert.equal(lt1.items[0].status, LINK_STATUS.unknown);

  // 命中值为坏引用 → 无法判断
  const badValue = await buildPdf(
    [
      {
        annots: [
          (doc) => linkAnnot(doc, { destRaw: () => PDFString.of('x') }),
        ],
      },
    ],
    (doc) => {
      doc.catalog.set(
        PDFName.of('Names'),
        doc.context.obj({
          Dests: { Names: [PDFString.of('x'), PDFRef.of(99996)] },
        })
      );
    }
  );
  const lt2 = await checkLinks(badValue);
  assert.equal(lt2.items[0].status, LINK_STATUS.unknown);
  assert.ok(lt2.items[0].reason.includes('引用损坏'));
});

// ---- 汇总与印刷风险共存 ----

test('跨页多条链接逐条列出来源页与注释序号，汇总失效与无法判断数', async () => {
  const bytes = await buildPdf(
    [
      {
        annots: [
          (doc, pages) =>
            linkAnnot(doc, { destRaw: () => destTo(doc, pages, 1) }), // 有效
          (doc) => linkAnnot(doc), // 失效：未设目标
        ],
      },
      {
        annots: [
          (doc, pages) =>
            linkAnnot(doc, {
              destRaw: () => destTo(doc, pages, 0),
              actionRaw: () =>
                doc.context.obj({ S: 'GoTo', D: destTo(doc, pages, 0) }),
            }), // 无法判断：并存
          (doc) => textAnnot(doc), // 非 Link：不参与
          (doc) =>
            linkAnnot(doc, {
              actionRaw: () =>
                doc.context.obj({ S: 'URI', URI: PDFString.of('https://a.b') }),
            }), // 范围外
        ],
      },
      {}, // 无注释页
    ],
    null
  );
  const report = await checkAnnotations(Buffer.from(bytes));
  const lt = report.linkTargets;
  assert.equal(lt.total, 4);
  assert.deepEqual(lt.counts, { ok: 1, broken: 1, unknown: 1, outOfScope: 1 });
  assert.deepEqual(lt.brokenItems, [{ pageNumber: 1, annotIndex: 2 }]);
  assert.deepEqual(lt.unknownItems, [{ pageNumber: 2, annotIndex: 1 }]);
  // 逐条：来源页、注释序号、目标页、状态、原因
  assert.deepEqual(
    lt.items.map((it) => [it.pageNumber, it.annotIndex, it.status]),
    [
      [1, 1, LINK_STATUS.ok],
      [1, 2, LINK_STATUS.broken],
      [2, 1, LINK_STATUS.unknown],
      [2, 3, LINK_STATUS.outOfScope],
    ]
  );
  assert.equal(lt.items[0].targetPage, 2);
  assert.ok(lt.items.every((it) => typeof it.reason === 'string' && it.reason));
  assert.ok(lt.scopeNote.includes('不访问网络'));
});

test('无 /Link 注释时链接核对为空；印刷风险结果保留', async () => {
  const bytes = await buildPdf([{ annots: [(doc) => textAnnot(doc)] }], null);
  const report = await checkAnnotations(Buffer.from(bytes));
  assert.equal(report.linkTargets.total, 0);
  assert.deepEqual(report.linkTargets.counts, {
    ok: 0,
    broken: 0,
    unknown: 0,
    outOfScope: 0,
  });
  assert.equal(report.linkTargets.items.length, 0);
  // 印刷风险判定不受影响
  assert.equal(report.pages[0].annotations[0].status, ANNOT_STATUS.missedPrintRisk);
  assert.equal(report.pages[0].annotations[0].linkTarget, null);
});

test('Link 注释的印刷风险判定保留，且字段非法时仍给出链接目标结果', async () => {
  const bytes = await buildPdf(
    [
      {
        annots: [
          // 未设 Print 的 Link：漏印风险 + 链接目标有效
          (doc, pages) =>
            linkAnnot(doc, { destRaw: () => destTo(doc, pages, 1) }),
          // Rect 非法的 Link：注释无法判断 + 链接目标仍有效
          (doc, pages) =>
            linkAnnot(doc, {
              badRect: (d) => box(d.context, [0, 0, 10]),
              destRaw: () => destTo(doc, pages, 1),
            }),
        ],
      },
      {},
    ],
    null
  );
  const report = await checkAnnotations(Buffer.from(bytes));
  const [a1, a2] = report.pages[0].annotations;
  assert.equal(a1.status, ANNOT_STATUS.missedPrintRisk);
  assert.equal(a1.linkTarget.status, LINK_STATUS.ok);
  assert.equal(a1.linkTarget.targetPage, 2);
  assert.equal(a2.status, ANNOT_STATUS.unknown); // Rect 非法
  assert.equal(a2.linkTarget.status, LINK_STATUS.ok); // 链接目标独立核对
  assert.equal(report.linkTargets.total, 2);
  assert.equal(report.linkTargets.counts.ok, 2);
});
