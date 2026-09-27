// server.js — Express 服务：上传 PDF、拼版、返回核对清单、提供下载
import express from 'express';
import multer from 'multer';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { imposePdf, ImpositionError } from './imposition.js';
import { analyzeTextSafety, PreflightError } from './preflight.js';
import { checkPageNumbers, PageNumberError } from './pagenumbers.js';
import { checkFontEmbedding, FontCheckError } from './fonts.js';
import { analyzeImageResolution, ImageResolutionError } from './imageresolution.js';
import { checkBleedBoxes, BleedBoxError } from './bleedboxes.js';
import { checkAnnotations, AnnotationError } from './annotations.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT ? Number(process.env.PORT) : 3000;
const MAX_FILE_MB = 100;

const app = express();
app.use(express.static(path.join(__dirname, 'public')));

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_FILE_MB * 1024 * 1024 },
});

// 任务结果暂存于内存（不写盘），1 小时后自动清理
const jobs = new Map();
const JOB_TTL_MS = 60 * 60 * 1000;
setInterval(() => {
  const now = Date.now();
  for (const [id, job] of jobs) {
    if (now - job.createdAt > JOB_TTL_MS) jobs.delete(id);
  }
}, 10 * 60 * 1000).unref();

app.get('/api/health', (_req, res) => {
  res.json({ ok: true });
});

app.post('/api/impose', (req, res) => {
  upload.single('pdf')(req, res, async (err) => {
    if (err) {
      if (err.code === 'LIMIT_FILE_SIZE') {
        return res
          .status(400)
          .json({ error: `文件过大，上限 ${MAX_FILE_MB} MB。` });
      }
      return res.status(400).json({ error: `上传失败：${err.message}` });
    }
    if (!req.file) {
      return res.status(400).json({ error: '未收到文件，请选择要上传的 PDF。' });
    }

    const sheetsPerSignature = Number(req.body.sheetsPerSignature);
    if (![4, 8, 16].includes(sheetsPerSignature)) {
      return res
        .status(400)
        .json({ error: '每帖页数必须为 4、8 或 16。' });
    }

    try {
      const { pdfBytes, plan, pageSize } = await imposePdf(
        req.file.buffer,
        sheetsPerSignature
      );

      const originalName =
        req.file.originalname
          ? Buffer.from(req.file.originalname, 'latin1').toString('utf8')
          : 'document.pdf';
      const base = originalName.replace(/\.pdf$/i, '') || 'document';
      const downloadName = `${base}-imposed-${sheetsPerSignature}up.pdf`;

      const id = randomUUID();
      jobs.set(id, {
        pdfBytes,
        downloadName,
        createdAt: Date.now(),
      });

      res.json({
        jobId: id,
        originalName,
        downloadName,
        pageSize,
        pageSizeMm: {
          width: ptToMm(pageSize.width),
          height: ptToMm(pageSize.height),
        },
        outputFaceSize: { width: pageSize.width * 2, height: pageSize.height },
        plan,
      });
    } catch (e) {
      const status = e instanceof ImpositionError ? 400 : 500;
      if (status === 500) console.error(e);
      res.status(status).json({
        error:
          status === 400
            ? e.message
            : '服务器处理失败，请检查文件后重试。',
      });
    }
  });
});

// 印前文字安全区预检：沿用同一套上传限制（multer 100 MB、仅 PDF），
// 服务端用 PDF.js 提取每页文字及几何框并判定边缘禁入带风险。
app.post('/api/preflight', (req, res) => {
  upload.single('pdf')(req, res, async (err) => {
    if (err) {
      if (err.code === 'LIMIT_FILE_SIZE') {
        return res
          .status(400)
          .json({ error: `文件过大，上限 ${MAX_FILE_MB} MB。` });
      }
      return res.status(400).json({ error: `上传失败：${err.message}` });
    }
    if (!req.file) {
      return res.status(400).json({ error: '未收到文件，请选择要上传的 PDF。' });
    }

    const trimMarginMm = Number(req.body.trimMarginMm);
    const bindingMarginMm = Number(req.body.bindingMarginMm);

    try {
      const report = await analyzeTextSafety(req.file.buffer, {
        trimMarginMm,
        bindingMarginMm,
      });

      const originalName =
        req.file.originalname
          ? Buffer.from(req.file.originalname, 'latin1').toString('utf8')
          : 'document.pdf';

      res.json({ originalName, ...report });
    } catch (e) {
      const status = e instanceof PreflightError ? 400 : 500;
      if (status === 500) console.error(e);
      res.status(status).json({
        error:
          status === 400
            ? e.message
            : '服务器处理失败，请检查文件后重试。',
      });
    }
  });
});

// 原稿页脚页码核对：沿用同一套上传限制（multer 100 MB、仅 PDF），
// 服务端用 PDF.js 提取页脚带内数字并与期望页码逐页比对。
app.post('/api/pagenumbers', (req, res) => {
  upload.single('pdf')(req, res, async (err) => {
    if (err) {
      if (err.code === 'LIMIT_FILE_SIZE') {
        return res
          .status(400)
          .json({ error: `文件过大，上限 ${MAX_FILE_MB} MB。` });
      }
      return res.status(400).json({ error: `上传失败：${err.message}` });
    }
    if (!req.file) {
      return res.status(400).json({ error: '未收到文件，请选择要上传的 PDF。' });
    }

    const firstPageIndex = Number(req.body.firstPageIndex);
    const firstPrintedNumber = Number(req.body.firstPrintedNumber);
    const footerBandMm = Number(req.body.footerBandMm);

    try {
      const report = await checkPageNumbers(req.file.buffer, {
        firstPageIndex,
        firstPrintedNumber,
        footerBandMm,
      });

      const originalName =
        req.file.originalname
          ? Buffer.from(req.file.originalname, 'latin1').toString('utf8')
          : 'document.pdf';

      res.json({ originalName, ...report });
    } catch (e) {
      const status = e instanceof PageNumberError ? 400 : 500;
      if (status === 500) console.error(e);
      res.status(status).json({
        error:
          status === 400
            ? e.message
            : '服务器处理失败，请检查文件后重试。',
      });
    }
  });
});

// 原稿字体嵌入核查：沿用同一套上传限制（multer 100 MB、仅 PDF），
// 服务端用 pdf-lib 逐页读取（含继承的）Resources/Font 并递归检查表单 XObject。
app.post('/api/fonts', (req, res) => {
  upload.single('pdf')(req, res, async (err) => {
    if (err) {
      if (err.code === 'LIMIT_FILE_SIZE') {
        return res
          .status(400)
          .json({ error: `文件过大，上限 ${MAX_FILE_MB} MB。` });
      }
      return res.status(400).json({ error: `上传失败：${err.message}` });
    }
    if (!req.file) {
      return res.status(400).json({ error: '未收到文件，请选择要上传的 PDF。' });
    }

    try {
      const report = await checkFontEmbedding(req.file.buffer);

      const originalName =
        req.file.originalname
          ? Buffer.from(req.file.originalname, 'latin1').toString('utf8')
          : 'document.pdf';

      res.json({ originalName, ...report });
    } catch (e) {
      const status = e instanceof FontCheckError ? 400 : 500;
      if (status === 500) console.error(e);
      res.status(status).json({
        error:
          status === 400
            ? e.message
            : '服务器处理失败，请检查文件后重试。',
      });
    }
  });
});

// 原稿位图有效分辨率预检：沿用同一套上传限制（multer 100 MB、仅 PDF），
// 服务端用 PDF.js 读取每页绘制指令，追踪图形状态与表单嵌套变换，
// 逐次计算实际绘制的普通 Image XObject 的横纵 DPI。
app.post('/api/image-resolution', (req, res) => {
  upload.single('pdf')(req, res, async (err) => {
    if (err) {
      if (err.code === 'LIMIT_FILE_SIZE') {
        return res
          .status(400)
          .json({ error: `文件过大，上限 ${MAX_FILE_MB} MB。` });
      }
      return res.status(400).json({ error: `上传失败：${err.message}` });
    }
    if (!req.file) {
      return res.status(400).json({ error: '未收到文件，请选择要上传的 PDF。' });
    }

    const minDpi = Number(req.body.minDpi);

    try {
      const report = await analyzeImageResolution(req.file.buffer, { minDpi });

      const originalName =
        req.file.originalname
          ? Buffer.from(req.file.originalname, 'latin1').toString('utf8')
          : 'document.pdf';

      res.json({ originalName, ...report });
    } catch (e) {
      const status = e instanceof ImageResolutionError ? 400 : 500;
      if (status === 500) console.error(e);
      res.status(status).json({
        error:
          status === 400
            ? e.message
            : '服务器处理失败，请检查文件后重试。',
      });
    }
  });
});

// 原稿裁切盒与出血盒核验：沿用同一套上传限制（multer 100 MB、仅 PDF），
// 服务端用 pdf-lib 逐页读取继承的 MediaBox/CropBox/Rotate 与页面显式声明的
// TrimBox/BleedBox，按旋转后阅读方向核对成品尺寸并逐边计算可用出血。
// 同一份上传同时进入“注释印刷风险区”：逐页解析 /Annots 注释的
// Subtype/Rect/F/AP，判定屏显与打印状态；并对 /Link 注释做内部链接目标
// 核对（/Dest 或 /A（/S=/GoTo）的 /D 是否指向本文件页面），
// 两项结果随同一响应返回。
app.post('/api/bleedboxes', (req, res) => {
  upload.single('pdf')(req, res, async (err) => {
    if (err) {
      if (err.code === 'LIMIT_FILE_SIZE') {
        return res
          .status(400)
          .json({ error: `文件过大，上限 ${MAX_FILE_MB} MB。` });
      }
      return res.status(400).json({ error: `上传失败：${err.message}` });
    }
    if (!req.file) {
      return res.status(400).json({ error: '未收到文件，请选择要上传的 PDF。' });
    }

    const finishedWidthMm = Number(req.body.finishedWidthMm);
    const finishedHeightMm = Number(req.body.finishedHeightMm);
    const minBleedMm = Number(req.body.minBleedMm);

    try {
      const report = await checkBleedBoxes(req.file.buffer, {
        finishedWidthMm,
        finishedHeightMm,
        minBleedMm,
      });
      // 注释印刷风险区：复用同一上传文件与逐页报告
      const annotations = await checkAnnotations(req.file.buffer);

      const originalName =
        req.file.originalname
          ? Buffer.from(req.file.originalname, 'latin1').toString('utf8')
          : 'document.pdf';

      res.json({ originalName, ...report, annotations });
    } catch (e) {
      const status =
        e instanceof BleedBoxError || e instanceof AnnotationError ? 400 : 500;
      if (status === 500) console.error(e);
      res.status(status).json({
        error:
          status === 400
            ? e.message
            : '服务器处理失败，请检查文件后重试。',
      });
    }
  });
});

app.get('/api/download/:id', (req, res) => {
  const job = jobs.get(req.params.id);
  if (!job) {
    return res
      .status(404)
      .send('文件已过期或不存在，请返回页面重新拼版。');
  }
  const encoded = encodeURIComponent(job.downloadName).replace(
    /['()*]/g,
    (c) => '%' + c.charCodeAt(0).toString(16)
  );
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader(
    'Content-Disposition',
    `attachment; filename="imposed.pdf"; filename*=UTF-8''${encoded}`
  );
  res.send(job.pdfBytes);
});

app.listen(PORT, () => {
  console.log(`骑马订拼版服务已启动：http://localhost:${PORT}`);
});

function ptToMm(pt) {
  return Math.round(((pt * 25.4) / 72) * 10) / 10;
}
