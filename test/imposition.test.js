// test/imposition.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PDFDocument, rgb, degrees } from 'pdf-lib';
import {
  buildSignatures,
  buildPlan,
  imposePdf,
  ImpositionError,
} from '../imposition.js';

test('分帖：整帖，无补白', () => {
  assert.deepEqual(buildSignatures(8, 8), [[0, 1, 2, 3, 4, 5, 6, 7]]);
  assert.deepEqual(buildSignatures(8, 4), [
    [0, 1, 2, 3],
    [4, 5, 6, 7],
  ]);
});

test('分帖：末帖尾部补白', () => {
  assert.deepEqual(buildSignatures(5, 4), [
    [0, 1, 2, 3],
    [4, -1, -1, -1],
  ]);
  assert.deepEqual(buildSignatures(10, 8), [
    [0, 1, 2, 3, 4, 5, 6, 7],
    [8, 9, -1, -1, -1, -1, -1, -1],
  ]);
  assert.deepEqual(buildSignatures(1, 16)[0].filter((p) => p === -1).length, 15);
});

test('4 页帖版面：正(4,1) 背(2,3)', () => {
  const plan = buildPlan(4, 4);
  assert.equal(plan.outputFaceCount, 2);
  const [front, back] = plan.faces;
  assert.equal(front.side, 'front');
  assert.equal(front.left.pageNumber, 4);
  assert.equal(front.right.pageNumber, 1);
  assert.equal(back.side, 'back');
  assert.equal(back.left.pageNumber, 2);
  assert.equal(back.right.pageNumber, 3);
});

test('8 页帖完整输出顺序：8/1, 2/7, 6/3, 4/5', () => {
  const { faces } = buildPlan(8, 8);
  const seq = faces.map((f) => [f.left.pageNumber, f.right.pageNumber]);
  assert.deepEqual(seq, [
    [8, 1],
    [2, 7],
    [6, 3],
    [4, 5],
  ]);
  // 正面、背面交替
  assert.deepEqual(faces.map((f) => f.side), ['front', 'back', 'front', 'back']);
});

test('16 页帖：张数、补白位置（5 个原页时空白位为 6,9,12,13,14,15...）', () => {
  const { faces, totalBlankPages } = buildPlan(5, 16);
  assert.equal(faces.length, 8); // 4 张纸 × 2 面
  assert.equal(totalBlankPages, 11);

  // 正面 i=0：左第16位（空白），右第1位
  assert.equal(faces[0].left.pageNumber, null);
  assert.equal(faces[0].left.signaturePosition, 16);
  assert.equal(faces[0].right.pageNumber, 1);
  // 每个原页 1..5 在所有槽位中恰好出现一次
  const used = faces.flatMap((f) => [f.left.pageNumber, f.right.pageNumber]);
  const pages = used.filter((n) => n !== null).sort((a, b) => a - b);
  assert.deepEqual(pages, [1, 2, 3, 4, 5]);
  assert.equal(used.filter((n) => n === null).length, 11);
});

test('非法每帖页数', () => {
  assert.throws(() => buildPlan(8, 12), ImpositionError);
});

// ---- 需要真实 PDF 的集成测试 ----

async function makePdf({
  pages = 8,
  width = 595.28,
  height = 841.89,
  variedSizes = false,
  rotated = false,
} = {}) {
  const doc = await PDFDocument.create();
  for (let i = 0; i < pages; i++) {
    const w = variedSizes && i === 1 ? width * 0.8 : width;
    const page = doc.addPage([w, height]);
    page.drawText(`P${i + 1}`, {
      x: 60,
      y: 60,
      size: 40,
      color: rgb(0, 0, 0),
    });
    if (rotated && i === 2) page.setRotation(degrees(90));
  }
  return Buffer.from(await doc.save());
}

test('端到端：输出页数、尺寸为原页两倍、面序正确', async () => {
  const bytes = await makePdf({ pages: 10 });
  const { pdfBytes, plan, pageSize } = await imposePdf(bytes, 8);

  assert.ok(Buffer.isBuffer(pdfBytes));
  assert.equal(plan.signatureCount, 2);
  assert.equal(plan.totalBlankPages, 6);
  assert.equal(plan.outputFaceCount, 8);

  const out = await PDFDocument.load(pdfBytes);
  const outPages = out.getPages();
  assert.equal(outPages.length, 8);
  assert.equal(outPages[0].getWidth(), pageSize.width * 2);
  assert.equal(outPages[0].getHeight(), pageSize.height);
});

test('4 页/帖端到端', async () => {
  const bytes = await makePdf({ pages: 8 });
  const { pdfBytes } = await imposePdf(bytes, 4);
  const out = await PDFDocument.load(pdfBytes);
  assert.equal(out.getPages().length, 4); // 2 帖 × 每帖 1 张纸 × 2 面
});

test('非 PDF 文件报错', async () => {
  await assert.rejects(
    () => imposePdf(Buffer.from('this is definitely not a pdf'), 8),
    (e) => e instanceof ImpositionError && /PDF/.test(e.message)
  );
});

test('损坏的 PDF 字节报错', async () => {
  const good = await makePdf({ pages: 2 });
  const broken = Buffer.concat([
    good.subarray(0, 20),
    Buffer.from('####garbled####'),
    good.subarray(good.length - 20),
  ]);
  await assert.rejects(
    () => imposePdf(broken, 4),
    (e) => e instanceof ImpositionError
  );
});

test('异尺寸页面报错', async () => {
  const bytes = await makePdf({ pages: 4, variedSizes: true });
  await assert.rejects(
    () => imposePdf(bytes, 4),
    (e) => e instanceof ImpositionError && /尺寸不一致/.test(e.message)
  );
});

test('含旋转页报错', async () => {
  const bytes = await makePdf({ pages: 4, rotated: true });
  await assert.rejects(
    () => imposePdf(bytes, 4),
    (e) => e instanceof ImpositionError && /旋转/.test(e.message)
  );
});
