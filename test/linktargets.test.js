// test/linktargets.test.js
// 内部链接目标核对（随 checkAnnotations 报告的 linkTargets 返回）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  PDFArray,
  PDFDocument,
  PDFHexString,
  PDFName,
  PDFNumber,
  PDFRef,
  PDFString,
} from 'pdf-lib';
import { checkAnnotations, LINK_STATUS, PT_PER_MM } from '../annotations.js';

// ---- 构造工具 ----

const mm = (v) => v * PT_PER_MM;
const INSIDE = [mm(10), mm(20), mm(110), mm(120)];

function box(ctx, vals) {
  const a = PDFArray.withContext(ctx);
  for (const v of vals) a.push(PDFNumber.of(v));
  return a;
}

/** 显式目标数组：[页引用 /Fit]（缩放参数应被忽略）。 */
function destArray(doc, pageRef, fit = 'Fit') {
  return doc.context.obj([pageRef, PDFName.of(fit)]);
}

/**
 * 构造测试 PDF。
 * spec: {
 *   pageCount?: number（默认 3）,
 *   links?: Array<{
 *     page?: number（从 0 起，默认 0）,
 *     dest?: (doc, pages) => 目标值,
 *     action?: (doc, pages) => /A 值,
 *     annotRef?: boolean（注释字典用间接引用）,
 *   }>,
 *   setup?: (doc, pages) => 配置 Catalog/Dests、Names 等,
 * }
 */
async function buildPdf(spec) {
  const doc = await PDFDocument.create();
  const pages = [];
  for (let i = 0; i < (spec.pageCount ?? 3); i++) {
    pages.push(doc.addPage([mm(210), mm(297)]));
  }
  if (spec.setup) spec.setup(doc, pages);

  for (const link of spec.links ?? []) {
    const dict = doc.context.obj({});
    dict.set(PDFName.of('Subtype'), PDFName.of('Link'));
    dict.set(PDFName.of('Rect'), box(doc.context, INSIDE));
    if (link.dest) dict.set(PDFName.of('Dest'), link.dest(doc, pages));
    if (link.action) dict.set(PDFName.of('A'), link.action(doc, pages));

    const node = pages[link.page ?? 0].node;
    let arr = node.get(PDFName.of('Annots'));
    if (!(arr instanceof PDFArray)) {
      arr = PDFArray.withContext(doc.context);
      node.set(PDFName.of('Annots'), arr);
    }
    arr.push(link.annotRef ? doc.context.register(dict) : dict);
  }
  return doc.save();
}

async function checkLinks(spec) {
  const bytes = await buildPdf(spec);
  const report = await checkAnnotations(Buffer.from(bytes));
  return report.linkTargets;
}

// ---- /Dest 显式数组 ----

test('/Dest 数组首项为本文件页面引用：有效，页序从 1 起；缩放参数不核对', async () => {
  const lt = await checkLinks({
    links: [
      {
        page: 0,
        dest: (doc, pages) =>
          doc.context.obj([
            pages[1].ref,
            PDFName.of('XYZ'),
            PDFNumber.of(10),
            PDFNumber.of(20),
            PDFNumber.of(2),
          ]),
      },
    ],
  });
  assert.equal(lt.links.length, 1);
  const link = lt.links[0];
  assert.equal(link.status, LINK_STATUS.ok);
  assert.equal(link.targetPage, 2);
  assert.equal(link.pageNumber, 1);
  assert.equal(link.annotIndex, 1);
  assert.equal(link.source, 'Dest');
  assert.ok(link.reason.includes('第 2 页'));
  assert.deepEqual(lt.summary, {
    total: 1,
    ok: 1,
    broken: 0,
    unknown: 0,
    outOfScope: 0,
  });
});

test('/Dest 为间接引用的数组：正常解析', async () => {
  const lt = await checkLinks({
    links: [
      {
        page: 2,
        dest: (doc, pages) =>
          doc.context.register(destArray(doc, pages[2].ref)),
      },
    ],
  });
  assert.equal(lt.links[0].status, LINK_STATUS.ok);
  assert.equal(lt.links[0].targetPage, 3);
  assert.equal(lt.links[0].pageNumber, 3);
});

test('/Dest 数组首项为坏引用：无法判断；引用非页面对象：失效', async () => {
  const broken = await checkLinks({
    links: [
      {
        dest: (doc) =>
          doc.context.obj([PDFRef.of(99995), PDFName.of('Fit')]),
      },
    ],
  });
  assert.equal(broken.links[0].status, LINK_STATUS.unknown);
  assert.ok(broken.links[0].reason.includes('引用损坏'));

  // 引用有效但指向普通字典（不是页面）：目标页不存在 → 失效
  const notPage = await checkLinks({
    links: [
      {
        dest: (doc) =>
          doc.context.obj([
            doc.context.register(doc.context.obj({ Foo: PDFName.of('Bar') })),
            PDFName.of('Fit'),
          ]),
      },
    ],
  });
  assert.equal(notPage.links[0].status, LINK_STATUS.broken);
  assert.equal(notPage.links[0].targetPage, null);
  assert.ok(notPage.links[0].reason.includes('目标页不存在'));
});

test('/Dest 空数组或首项非间接引用：无法判断（非法类型）', async () => {
  const empty = await checkLinks({
    links: [{ dest: (doc) => doc.context.obj([]) }],
  });
  assert.equal(empty.links[0].status, LINK_STATUS.unknown);
  assert.ok(empty.links[0].reason.includes('空'));

  const firstIsName = await checkLinks({
    links: [
      { dest: (doc) => doc.context.obj([PDFName.of('Fit')]) },
    ],
  });
  assert.equal(firstIsName.links[0].status, LINK_STATUS.unknown);
  assert.ok(firstIsName.links[0].reason.includes('首项'));
});

test('/Dest 为损坏的间接引用或非法类型：无法判断', async () => {
  const brokenRef = await checkLinks({
    links: [{ dest: () => PDFRef.of(99996) }],
  });
  assert.equal(brokenRef.links[0].status, LINK_STATUS.unknown);

  const wrongType = await checkLinks({
    links: [{ dest: () => PDFNumber.of(3) }],
  });
  assert.equal(wrongType.links[0].status, LINK_STATUS.unknown);
  assert.ok(wrongType.links[0].reason.includes('类型非法'));
});

// ---- /Dest 名称对象 → Catalog/Dests ----

test('/Dest 名称查 Catalog/Dests：值为数组或 /D 为数组的字典均有效', async () => {
  const asArray = await checkLinks({
    setup: (doc, pages) => {
      doc.catalog.set(
        PDFName.of('Dests'),
        doc.context.obj({
          intro: destArray(doc, pages[1].ref),
        })
      );
    },
    links: [{ dest: () => PDFName.of('intro') }],
  });
  assert.equal(asArray.links[0].status, LINK_STATUS.ok);
  assert.equal(asArray.links[0].targetPage, 2);

  const asDict = await checkLinks({
    setup: (doc, pages) => {
      doc.catalog.set(
        PDFName.of('Dests'),
        doc.context.obj({
          ch9: doc.context.obj({ D: destArray(doc, pages[2].ref) }),
        })
      );
    },
    links: [{ dest: () => PDFName.of('ch9') }],
  });
  assert.equal(asDict.links[0].status, LINK_STATUS.ok);
  assert.equal(asDict.links[0].targetPage, 3);
});

test('/Dest 名称在 Catalog/Dests 中缺失：失效；无 /Dests：失效', async () => {
  const missing = await checkLinks({
    setup: (doc) => {
      doc.catalog.set(PDFName.of('Dests'), doc.context.obj({}));
    },
    links: [{ dest: () => PDFName.of('nope') }],
  });
  assert.equal(missing.links[0].status, LINK_STATUS.broken);
  assert.ok(missing.links[0].reason.includes('无名称'));

  const noDests = await checkLinks({
    links: [{ dest: () => PDFName.of('nope') }],
  });
  assert.equal(noDests.links[0].status, LINK_STATUS.broken);
  assert.ok(noDests.links[0].reason.includes('Catalog 无 /Dests'));
});

test('/Dest 名称：Catalog/Dests 非字典或坏引用：无法判断', async () => {
  const notDict = await checkLinks({
    setup: (doc) => {
      doc.catalog.set(PDFName.of('Dests'), PDFNumber.of(7));
    },
    links: [{ dest: () => PDFName.of('a') }],
  });
  assert.equal(notDict.links[0].status, LINK_STATUS.unknown);

  const brokenRef = await checkLinks({
    setup: (doc) => {
      doc.catalog.set(PDFName.of('Dests'), PDFRef.of(99997));
    },
    links: [{ dest: () => PDFName.of('a') }],
  });
  assert.equal(brokenRef.links[0].status, LINK_STATUS.unknown);
});

test('/Dest 名称命中项的值类型非法（非数组/字典、/D 非数组、坏引用）：无法判断', async () => {
  const badValue = await checkLinks({
    setup: (doc) => {
      doc.catalog.set(
        PDFName.of('Dests'),
        doc.context.obj({ x: PDFNumber.of(1) })
      );
    },
    links: [{ dest: () => PDFName.of('x') }],
  });
  assert.equal(badValue.links[0].status, LINK_STATUS.unknown);
  assert.ok(badValue.links[0].reason.includes('类型非法'));

  const badD = await checkLinks({
    setup: (doc) => {
      doc.catalog.set(
        PDFName.of('Dests'),
        doc.context.obj({ x: doc.context.obj({ D: PDFNumber.of(1) }) })
      );
    },
    links: [{ dest: () => PDFName.of('x') }],
  });
  assert.equal(badD.links[0].status, LINK_STATUS.unknown);

  const valueBrokenRef = await checkLinks({
    setup: (doc) => {
      doc.catalog.set(
        PDFName.of('Dests'),
        doc.context.obj({ x: PDFRef.of(99998) })
      );
    },
    links: [{ dest: () => PDFName.of('x') }],
  });
  assert.equal(valueBrokenRef.links[0].status, LINK_STATUS.unknown);
});

// ---- /Dest 字符串 → Catalog/Names/Dests 名称树 ----

test('/Dest 字符串查名称树：多层 /Kids，值为数组或 /D 字典；十六进制键按解码原文匹配', async () => {
  const deep = await checkLinks({
    setup: (doc, pages) => {
      const leaf = doc.context.obj({
        Names: [PDFString.of('deep'), destArray(doc, pages[2].ref)],
      });
      const mid = doc.context.obj({ Kids: [leaf] });
      doc.catalog.set(
        PDFName.of('Names'),
        doc.context.obj({ Dests: doc.context.obj({ Kids: [mid] }) })
      );
    },
    links: [{ dest: () => PDFString.of('deep') }],
  });
  assert.equal(deep.links[0].status, LINK_STATUS.ok);
  assert.equal(deep.links[0].targetPage, 3);

  // /Dest 为十六进制字符串、名称树叶键为普通字符串（均解码为 ch1）
  const hex = await checkLinks({
    setup: (doc, pages) => {
      const leaf = doc.context.obj({
        Names: [
          PDFString.of('ch1'),
          doc.context.obj({ D: destArray(doc, pages[1].ref) }),
        ],
      });
      doc.catalog.set(
        PDFName.of('Names'),
        doc.context.obj({ Dests: doc.context.obj({ Kids: [leaf] }) })
      );
    },
    links: [{ dest: () => PDFHexString.of('636831') }],
  });
  assert.equal(hex.links[0].status, LINK_STATUS.ok);
  assert.equal(hex.links[0].targetPage, 2);
});

test('/Dest 字符串：名称树无此名（树完好）记为失效；无 /Names 或无 /Names/Dests 记为失效', async () => {
  const missing = await checkLinks({
    setup: (doc) => {
      const leaf = doc.context.obj({
        Names: [PDFString.of('other'), doc.context.obj([PDFName.of('Fit')])],
      });
      doc.catalog.set(
        PDFName.of('Names'),
        doc.context.obj({ Dests: doc.context.obj({ Kids: [leaf] }) })
      );
    },
    links: [{ dest: () => PDFString.of('want') }],
  });
  assert.equal(missing.links[0].status, LINK_STATUS.broken);
  assert.ok(missing.links[0].reason.includes('无名称'));

  const noNames = await checkLinks({
    links: [{ dest: () => PDFString.of('want') }],
  });
  assert.equal(noNames.links[0].status, LINK_STATUS.broken);

  const noDestsTree = await checkLinks({
    setup: (doc) => {
      doc.catalog.set(PDFName.of('Names'), doc.context.obj({}));
    },
    links: [{ dest: () => PDFString.of('want') }],
  });
  assert.equal(noDestsTree.links[0].status, LINK_STATUS.broken);
});

test('名称树存在坏分支且未命中：无法判断；命中唯一名称不受他处坏分支影响', async () => {
  const miss = await checkLinks({
    setup: (doc, pages) => {
      const good = doc.context.obj({
        Names: [PDFString.of('good'), destArray(doc, pages[0].ref)],
      });
      doc.catalog.set(
        PDFName.of('Names'),
        doc.context.obj({
          Dests: doc.context.obj({ Kids: [PDFRef.of(99993), good] }),
        })
      );
    },
    links: [{ dest: () => PDFString.of('want') }],
  });
  assert.equal(miss.links[0].status, LINK_STATUS.unknown);
  assert.ok(miss.links[0].reason.includes('损坏分支'));

  // 同名出现在好分支：坏分支不影响已命中的唯一名称
  const hit = await checkLinks({
    setup: (doc, pages) => {
      const good = doc.context.obj({
        Names: [PDFString.of('good'), destArray(doc, pages[1].ref)],
      });
      doc.catalog.set(
        PDFName.of('Names'),
        doc.context.obj({
          Dests: doc.context.obj({ Kids: [PDFRef.of(99993), good] }),
        })
      );
    },
    links: [{ dest: () => PDFString.of('good') }],
  });
  assert.equal(hit.links[0].status, LINK_STATUS.ok);
  assert.equal(hit.links[0].targetPage, 2);
});

test('名称树 /Names 为奇数长度或键非字符串：坏分支，未命中时无法判断', async () => {
  const odd = await checkLinks({
    setup: (doc) => {
      const bad = doc.context.obj({
        Names: doc.context.obj([PDFString.of('a')]), // 只有键没有值
      });
      doc.catalog.set(
        PDFName.of('Names'),
        doc.context.obj({ Dests: doc.context.obj({ Kids: [bad] }) })
      );
    },
    links: [{ dest: () => PDFString.of('want') }],
  });
  assert.equal(odd.links[0].status, LINK_STATUS.unknown);

  const badKey = await checkLinks({
    setup: (doc) => {
      const bad = doc.context.obj({
        Names: doc.context.obj([
          PDFNumber.of(1),
          doc.context.obj([PDFName.of('Fit')]),
        ]),
      });
      doc.catalog.set(
        PDFName.of('Names'),
        doc.context.obj({ Dests: doc.context.obj({ Kids: [bad] }) })
      );
    },
    links: [{ dest: () => PDFString.of('want') }],
  });
  assert.equal(badKey.links[0].status, LINK_STATUS.unknown);
});

test('名称树循环引用：无法判断', async () => {
  const lt = await checkLinks({
    setup: (doc) => {
      const rootDict = doc.context.obj({});
      const rootRef = doc.context.register(rootDict);
      // 叶子指回根节点，形成循环
      const leaf = doc.context.obj({ Kids: [rootRef] });
      rootDict.set(PDFName.of('Kids'), doc.context.obj([leaf]));
      doc.catalog.set(
        PDFName.of('Names'),
        doc.context.obj({ Dests: rootRef })
      );
    },
    links: [{ dest: () => PDFString.of('x') }],
  });
  assert.equal(lt.links[0].status, LINK_STATUS.unknown);
  assert.ok(lt.links[0].reason.includes('循环'));
});

test('名称树重名：无法判断', async () => {
  const lt = await checkLinks({
    setup: (doc, pages) => {
      const leaf1 = doc.context.obj({
        Names: [PDFString.of('dup'), destArray(doc, pages[0].ref)],
      });
      const leaf2 = doc.context.obj({
        Names: [PDFString.of('dup'), destArray(doc, pages[1].ref)],
      });
      doc.catalog.set(
        PDFName.of('Names'),
        doc.context.obj({
          Dests: doc.context.obj({ Kids: [leaf1, leaf2] }),
        })
      );
    },
    links: [{ dest: () => PDFString.of('dup') }],
  });
  assert.equal(lt.links[0].status, LINK_STATUS.unknown);
  assert.ok(lt.links[0].reason.includes('重名'));
});

test('Catalog/Names 非字典或名称树根损坏：无法判断', async () => {
  const badNames = await checkLinks({
    setup: (doc) => {
      doc.catalog.set(PDFName.of('Names'), PDFNumber.of(5));
    },
    links: [{ dest: () => PDFString.of('x') }],
  });
  assert.equal(badNames.links[0].status, LINK_STATUS.unknown);

  const badRoot = await checkLinks({
    setup: (doc) => {
      doc.catalog.set(
        PDFName.of('Names'),
        doc.context.obj({ Dests: PDFNumber.of(5) })
      );
    },
    links: [{ dest: () => PDFString.of('x') }],
  });
  assert.equal(badRoot.links[0].status, LINK_STATUS.unknown);
});

// ---- /A 动作字典 ----

test('/A /S=/GoTo 且 /D 为数组：有效，来源记为 A', async () => {
  const lt = await checkLinks({
    links: [
      {
        page: 1,
        action: (doc, pages) =>
          doc.context.obj({
            S: PDFName.of('GoTo'),
            D: destArray(doc, pages[0].ref),
          }),
      },
    ],
  });
  assert.equal(lt.links[0].status, LINK_STATUS.ok);
  assert.equal(lt.links[0].targetPage, 1);
  assert.equal(lt.links[0].source, 'A');
  assert.equal(lt.links[0].pageNumber, 2);
});

test('/A /S=/GoTo 且 /D 为字符串名称：经名称树解析', async () => {
  const lt = await checkLinks({
    setup: (doc, pages) => {
      const leaf = doc.context.obj({
        Names: [PDFString.of('sec'), destArray(doc, pages[2].ref)],
      });
      doc.catalog.set(
        PDFName.of('Names'),
        doc.context.obj({ Dests: doc.context.obj({ Kids: [leaf] }) })
      );
    },
    links: [
      {
        action: (doc) =>
          doc.context.obj({ S: PDFName.of('GoTo'), D: PDFString.of('sec') }),
      },
    ],
  });
  assert.equal(lt.links[0].status, LINK_STATUS.ok);
  assert.equal(lt.links[0].targetPage, 3);
});

test('/A /S 非 GoTo（/URI、/GoToR 等）：范围外，不访问网络', async () => {
  const uri = await checkLinks({
    links: [
      {
        action: (doc) =>
          doc.context.obj({
            S: PDFName.of('URI'),
            URI: PDFString.of('https://example.com'),
          }),
      },
    ],
  });
  assert.equal(uri.links[0].status, LINK_STATUS.outOfScope);
  assert.equal(uri.links[0].targetPage, null);
  assert.ok(uri.links[0].reason.includes('/URI'));
  assert.ok(uri.links[0].reason.includes('范围外'));

  const remote = await checkLinks({
    links: [
      {
        action: (doc) =>
          doc.context.obj({
            S: PDFName.of('GoToR'),
            F: PDFString.of('other.pdf'),
            D: doc.context.obj([PDFNumber.of(0), PDFName.of('Fit')]),
          }),
      },
    ],
  });
  assert.equal(remote.links[0].status, LINK_STATUS.outOfScope);
});

test('/A /S=/GoTo 但缺少 /D：失效（未设目标）', async () => {
  const lt = await checkLinks({
    links: [
      { action: (doc) => doc.context.obj({ S: PDFName.of('GoTo') }) },
    ],
  });
  assert.equal(lt.links[0].status, LINK_STATUS.broken);
  assert.ok(lt.links[0].reason.includes('未设目标'));
});

test('/A 非字典/坏引用、缺 /S、/S 非名称：无法判断', async () => {
  const notDict = await checkLinks({
    links: [{ action: () => PDFNumber.of(5) }],
  });
  assert.equal(notDict.links[0].status, LINK_STATUS.unknown);

  const brokenRef = await checkLinks({
    links: [{ action: () => PDFRef.of(99994) }],
  });
  assert.equal(brokenRef.links[0].status, LINK_STATUS.unknown);

  const noS = await checkLinks({
    links: [{ action: (doc) => doc.context.obj({}) }],
  });
  assert.equal(noS.links[0].status, LINK_STATUS.unknown);

  const badS = await checkLinks({
    links: [
      { action: (doc) => doc.context.obj({ S: PDFNumber.of(1) }) },
    ],
  });
  assert.equal(badS.links[0].status, LINK_STATUS.unknown);
});

// ---- /Dest 与 /A 并存、均缺失 ----

test('/Dest 与 /A 并存：无法判断（即使两者各自有效）', async () => {
  const lt = await checkLinks({
    links: [
      {
        dest: (doc, pages) => destArray(doc, pages[0].ref),
        action: (doc, pages) =>
          doc.context.obj({
            S: PDFName.of('GoTo'),
            D: destArray(doc, pages[1].ref),
          }),
      },
    ],
  });
  assert.equal(lt.links[0].status, LINK_STATUS.unknown);
  assert.ok(lt.links[0].reason.includes('同时设有'));
});

test('无 /Dest 与 /A：失效（未设目标）', async () => {
  const lt = await checkLinks({ links: [{}] });
  assert.equal(lt.links[0].status, LINK_STATUS.broken);
  assert.equal(lt.links[0].targetPage, null);
  assert.ok(lt.links[0].reason.includes('未设目标'));
});

// ---- 范围、序号、汇总与既有功能保留 ----

test('非 /Link 注释不参与链接核对；印刷风险结果仍保留', async () => {
  const doc = await PDFDocument.create();
  const page = doc.addPage([mm(210), mm(297)]);
  const dict = doc.context.obj({});
  dict.set(PDFName.of('Subtype'), PDFName.of('Text'));
  dict.set(PDFName.of('Rect'), box(doc.context, INSIDE));
  const arr = PDFArray.withContext(doc.context);
  arr.push(dict);
  page.node.set(PDFName.of('Annots'), arr);
  const bytes = await doc.save();
  const report = await checkAnnotations(Buffer.from(bytes));

  assert.equal(report.linkTargets.summary.total, 0);
  assert.equal(report.linkTargets.links.length, 0);
  assert.ok(report.linkTargets.scopeNote.includes('内部目标'));
  // 印刷风险区不受影响：Text 注释仍是漏印风险
  assert.equal(report.pages[0].annotations[0].status, 'missed-print-risk');
});

test('多页多链接逐条列出来源页、注释序号并汇总失效与无法判断数', async () => {
  const lt = await checkLinks({
    pageCount: 3,
    links: [
      // 第 1 页第 1 条：有效 → 第 2 页
      { page: 0, dest: (doc, pages) => destArray(doc, pages[1].ref) },
      // 第 1 页第 2 条：失效（未设目标）
      { page: 0 },
      // 第 2 页：失效（名称无出处）
      { page: 1, dest: () => PDFName.of('nowhere') },
      // 第 3 页第 1 条：无法判断（非法类型）
      { page: 2, dest: () => PDFNumber.of(3) },
      // 第 3 页第 2 条：范围外
      {
        page: 2,
        action: (doc) =>
          doc.context.obj({
            S: PDFName.of('URI'),
            URI: PDFString.of('https://example.com'),
          }),
      },
    ],
  });
  assert.equal(lt.links.length, 5);
  assert.deepEqual(
    lt.links.map((l) => [l.pageNumber, l.annotIndex]),
    [
      [1, 1],
      [1, 2],
      [2, 1],
      [3, 1],
      [3, 2],
    ]
  );
  assert.equal(lt.links[0].targetPage, 2);
  assert.deepEqual(lt.summary, {
    total: 5,
    ok: 1,
    broken: 2,
    unknown: 1,
    outOfScope: 1,
  });
});

test('注释条目损坏时不中断同页其他链接的核对', async () => {
  const doc = await PDFDocument.create();
  const page = doc.addPage([mm(210), mm(297)]);
  const annots = PDFArray.withContext(doc.context);
  annots.push(PDFRef.of(99991)); // 坏引用条目（非 Link）
  annots.push(PDFNumber.of(42)); // 非字典条目（非 Link）
  const link = doc.context.obj({});
  link.set(PDFName.of('Subtype'), PDFName.of('Link'));
  link.set(PDFName.of('Rect'), box(doc.context, INSIDE));
  annots.push(link); // 无 /Dest、/A → 失效
  page.node.set(PDFName.of('Annots'), annots);

  const report = await checkAnnotations(Buffer.from(await doc.save()));
  const lt = report.linkTargets;
  assert.equal(lt.links.length, 1);
  assert.equal(lt.links[0].annotIndex, 3);
  assert.equal(lt.links[0].status, LINK_STATUS.broken);
  // 印刷风险区仍逐条记录（前两条无法判断）
  assert.equal(report.pages[0].counts.total, 3);
  assert.equal(report.pages[0].counts.unknown, 2);
});
