// test/pagenumbers.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PDFDocument, rgb, degrees, StandardFonts } from 'pdf-lib';
import {
  checkPageNumbers,
  buildCandidates,
  isDigitFragment,
  normalizeDigits,
  PageNumberError,
  JOIN_GAP_PT,
} from '../pagenumbers.js';
import { PT_PER_MM } from '../preflight.js';

const mm = (v) => v * PT_PER_MM;
const A4 = { w: 595.28, h: 841.89 };

// ---- 纯函数：数字片段判定与全角转换 ----

test('isDigitFragment：纯阿拉伯数字（含全角）', () => {
  assert.ok(isDigitFragment('12'));
  assert.ok(isDigitFragment('１２３'));
  assert.ok(isDigitFragment(' 7 ')); // trim 后判定
  assert.ok(isDigitFragment('０'));
  assert.ok(!isDigitFragment('12a'));
  assert.ok(!isDigitFragment('第12页'));
  assert.ok(!isDigitFragment('1 2')); // 片段内部含空白
  assert.ok(!isDigitFragment('-12'));
  assert.ok(!isDigitFragment(''));
  assert.ok(!isDigitFragment('   '));
  assert.ok(!isDigitFragment(null));
});

test('normalizeDigits：全角转半角', () => {
  assert.equal(normalizeDigits('１２３'), '123');
  assert.equal(normalizeDigits('１2３'), '123');
  assert.equal(normalizeDigits('42'), '42');
});

// ---- 纯函数：几何拼接 ----

const frag = (text, startX, x1, x2, baselineY = 100) => ({
  text,
  startX,
  x1,
  x2,
  baselineY,
});

test('buildCandidates：同基线近距片段按几何位置拼接，与输入顺序无关', () => {
  // 提取顺序（右片在前）不影响拼接结果
  const candidates = buildCandidates([
    frag('0', 20, 20, 25),
    frag('1', 10, 10, 15),
  ]);
  assert.equal(candidates.length, 1);
  assert.equal(candidates[0].text, '10');
  assert.equal(candidates[0].value, 10);
});

test('buildCandidates：水平间隔超过 2mm 断开为不同候选', () => {
  const gap = JOIN_GAP_PT + 1; // 刚好超过 2mm
  const candidates = buildCandidates([
    frag('1', 0, 0, 10),
    frag('2', 10 + gap, 10 + gap, 20 + gap),
  ]);
  assert.equal(candidates.length, 2);
  assert.deepEqual(
    candidates.map((c) => c.value),
    [1, 2]
  );
});

test('buildCandidates：间隔恰好 2mm 仍拼接（不超过即拼）', () => {
  const candidates = buildCandidates([
    frag('1', 0, 0, 10),
    frag('2', 10 + JOIN_GAP_PT, 10 + JOIN_GAP_PT, 20 + JOIN_GAP_PT),
  ]);
  assert.equal(candidates.length, 1);
  assert.equal(candidates[0].value, 12);
});

test('buildCandidates：不同基线不拼接', () => {
  const candidates = buildCandidates([
    frag('1', 0, 0, 10, 100),
    frag('2', 12, 12, 22, 100 + 5), // 纵向差 5pt > 容差
  ]);
  assert.equal(candidates.length, 2);
});

test('buildCandidates：三片段链式拼接与全角数字求值', () => {
  const candidates = buildCandidates([
    frag('３', 24, 24, 30),
    frag('１', 0, 0, 10),
    frag('２', 12, 12, 22),
  ]);
  assert.equal(candidates.length, 1);
  assert.equal(candidates[0].text, '１２３');
  assert.equal(candidates[0].value, 123);
});

// ---- 集成：pdf-lib 生成 PDF，走完整核对流程 ----

async function makePageNumberPdf() {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const size = 12;
  const draw = (page, text, xPt, yPt, extra = {}) =>
    page.drawText(text, { size, font, color: rgb(0, 0, 0), x: xPt, y: yPt, ...extra });

  // 页 1：首个带页码页之前 → 跳过（页脚数字不参与核对）
  {
    const page = doc.addPage([A4.w, A4.h]);
    draw(page, '123', mm(100), mm(5));
  }
  // 页 2（期望 9）：页脚 "9" → 相符
  {
    const page = doc.addPage([A4.w, A4.h]);
    draw(page, '9', mm(100), mm(5));
  }
  // 页 3（期望 10）：分两片 "1" "0"，同基线、间隔 1mm，须按几何拼接
  {
    const page = doc.addPage([A4.w, A4.h]);
    draw(page, '1', mm(100), mm(5));
    const w1 = font.widthOfTextAtSize('1', size);
    draw(page, '0', mm(100) + w1 + mm(1), mm(5));
  }
  // 页 4（期望 11）：页脚 "12" → 错号
  {
    const page = doc.addPage([A4.w, A4.h]);
    draw(page, '12', mm(100), mm(5));
  }
  // 页 5（期望 12）：页脚无数字（仅带外正文）→ 无法判断（无候选）
  {
    const page = doc.addPage([A4.w, A4.h]);
    draw(page, 'Body text', mm(20), 700);
  }
  // 页 6（期望 13）：页脚左右各一个 "13"，间隔远超 2mm → 无法判断（多候选）
  {
    const page = doc.addPage([A4.w, A4.h]);
    draw(page, '13', mm(10), mm(5));
    draw(page, '13', mm(180), mm(5));
  }
  // 页 7（期望 14）：页脚 "14" → 相符（期望值不随前两页无法判断而调整）
  {
    const page = doc.addPage([A4.w, A4.h]);
    draw(page, '14', mm(100), mm(5));
  }
  // 页 8（期望 15）：带内仅一个旋转 90° 的 "15" → 非横排，不识别 → 无法判断
  {
    const page = doc.addPage([A4.w, A4.h]);
    draw(page, '15', mm(100), mm(5), { rotate: degrees(90) });
  }
  // 页 9（期望 16）：带外（页面中部）"16" + 带内 "16" → 只认带内 → 相符
  {
    const page = doc.addPage([A4.w, A4.h]);
    draw(page, '16', mm(100), 700);
    draw(page, '16', mm(100), mm(5));
  }
  // 页 10（期望 17）：带内 "Page 17" → 非纯数字 → 无法判断
  {
    const page = doc.addPage([A4.w, A4.h]);
    draw(page, 'Page 17', mm(100), mm(5));
  }
  return Buffer.from(await doc.save());
}

const OPTIONS = { firstPageIndex: 2, firstPrintedNumber: 9, footerBandMm: 15 };

test('端到端：逐页核对页脚页码', async () => {
  const bytes = await makePageNumberPdf();
  const report = await checkPageNumbers(bytes, OPTIONS);

  assert.equal(report.pageCount, 10);
  assert.equal(report.firstPageIndex, 2);
  assert.equal(report.firstPrintedNumber, 9);
  assert.equal(report.footerBandMm, 15);

  const [p1, p2, p3, p4, p5, p6, p7, p8, p9, p10] = report.pages;

  // 页 1：跳过，无期望页码
  assert.equal(p1.status, 'skipped');
  assert.equal(p1.expected, null);
  assert.equal(p1.extracted, null);

  // 页 2：相符
  assert.equal(p2.status, 'ok');
  assert.equal(p2.expected, 9);
  assert.equal(p2.extracted, 9);

  // 页 3：两片段几何拼接为 10
  assert.equal(p3.status, 'ok');
  assert.equal(p3.expected, 10);
  assert.equal(p3.extracted, 10);

  // 页 4：错号（提取 12，期望 11）
  assert.equal(p4.status, 'mismatch');
  assert.equal(p4.expected, 11);
  assert.equal(p4.extracted, 12);
  assert.match(p4.note, /错号/);

  // 页 5：无候选 → 无法判断
  assert.equal(p5.status, 'unknown');
  assert.equal(p5.expected, 12);
  assert.equal(p5.extracted, null);
  assert.equal(p5.candidateCount, 0);

  // 页 6：两个候选 → 无法判断
  assert.equal(p6.status, 'unknown');
  assert.equal(p6.expected, 13);
  assert.equal(p6.candidateCount, 2);
  assert.match(p6.note, /2 个候选/);

  // 页 7：期望页码不因前两页无法判断而跳变
  assert.equal(p7.status, 'ok');
  assert.equal(p7.expected, 14);
  assert.equal(p7.extracted, 14);

  // 页 8：旋转（非横排）数字不识别 → 无法判断
  assert.equal(p8.status, 'unknown');
  assert.equal(p8.expected, 15);
  assert.equal(p8.candidateCount, 0);

  // 页 9：带外数字不识别，带内相符
  assert.equal(p9.status, 'ok');
  assert.equal(p9.expected, 16);
  assert.equal(p9.extracted, 16);
  assert.equal(p9.candidateCount, 1);

  // 页 10：非纯数字片段不识别 → 无法判断
  assert.equal(p10.status, 'unknown');
  assert.equal(p10.expected, 17);
  assert.equal(p10.candidateCount, 0);

  // 汇总
  assert.equal(report.summary.totalPages, 10);
  assert.equal(report.summary.skippedPages, 1);
  assert.equal(report.summary.checkedPages, 9);
  assert.equal(report.summary.okPages, 4);
  assert.equal(report.summary.mismatchPages, 1);
  assert.equal(report.summary.unknownPages, 4);
});

test('参数校验：首个带页码页序', async () => {
  const bytes = await makePageNumberPdf();
  for (const bad of [0, -1, 1.5, NaN]) {
    await assert.rejects(
      () => checkPageNumbers(bytes, { ...OPTIONS, firstPageIndex: bad }),
      (e) => e instanceof PageNumberError && /页序/.test(e.message)
    );
  }
  // 超出总页数
  await assert.rejects(
    () => checkPageNumbers(bytes, { ...OPTIONS, firstPageIndex: 11 }),
    (e) => e instanceof PageNumberError && /超出范围/.test(e.message)
  );
});

test('参数校验：印刷页码必须为正整数', async () => {
  const bytes = await makePageNumberPdf();
  for (const bad of [0, -3, 2.5, NaN]) {
    await assert.rejects(
      () => checkPageNumbers(bytes, { ...OPTIONS, firstPrintedNumber: bad }),
      (e) => e instanceof PageNumberError && /正整数/.test(e.message)
    );
  }
});

test('参数校验：页脚带高度必须大于 0', async () => {
  const bytes = await makePageNumberPdf();
  for (const bad of [0, -1, NaN]) {
    await assert.rejects(
      () => checkPageNumbers(bytes, { ...OPTIONS, footerBandMm: bad }),
      (e) => e instanceof PageNumberError && /页脚带高度/.test(e.message)
    );
  }
});

test('参数校验：页脚带高度必须小于最矮页高度的一半', async () => {
  const doc = await PDFDocument.create();
  doc.addPage([A4.w, A4.h]); // 高 ≈ 297mm
  doc.addPage([A4.w, mm(40)]); // 最矮页高 40mm → 带高须 < 20mm
  const bytes = Buffer.from(await doc.save());

  // 15mm < 20mm：通过（两页均无页脚数字，均为无法判断）
  const report = await checkPageNumbers(bytes, {
    firstPageIndex: 1,
    firstPrintedNumber: 1,
    footerBandMm: 15,
  });
  assert.equal(report.summary.unknownPages, 2);

  // 25mm ≥ 20mm：报错（虽小于 A4 页高的一半）
  await assert.rejects(
    () =>
      checkPageNumbers(bytes, {
        firstPageIndex: 1,
        firstPrintedNumber: 1,
        footerBandMm: 25,
      }),
    (e) => e instanceof PageNumberError && /最矮页高度的一半/.test(e.message)
  );
});

test('非 PDF / 空文件报错', async () => {
  await assert.rejects(
    () => checkPageNumbers(Buffer.from('not a pdf at all'), OPTIONS),
    (e) => e instanceof PageNumberError && /PDF/.test(e.message)
  );
  await assert.rejects(
    () => checkPageNumbers(Buffer.alloc(0), OPTIONS),
    (e) => e instanceof PageNumberError
  );
});

test('损坏的 PDF 字节报错', async () => {
  const good = await makePageNumberPdf();
  const broken = Buffer.concat([
    good.subarray(0, 20),
    Buffer.from('####garbled####'),
    good.subarray(good.length - 20),
  ]);
  await assert.rejects(
    () => checkPageNumbers(broken, OPTIONS),
    (e) => e instanceof PageNumberError
  );
});
