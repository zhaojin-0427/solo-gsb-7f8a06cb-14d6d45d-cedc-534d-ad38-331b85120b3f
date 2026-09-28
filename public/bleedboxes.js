// bleedboxes.js（前端）— 上传原稿，渲染裁切盒与出血盒核验报告
const form = document.getElementById('bleedboxes-form');
const errorBox = document.getElementById('error');
const loadingBox = document.getElementById('loading');
const resultBox = document.getElementById('result');
const submitBtn = document.getElementById('submit-btn');

const PAGE_STATUS_LABEL = {
  ok: { text: '通过', cls: 'ok' },
  risk: { text: '风险', cls: 'risk' },
  undeclared: { text: '有未声明盒', cls: 'undeclared' },
  unknown: { text: '无法判断', cls: 'unknown' },
};

const EDGE_STATUS_LABEL = {
  ok: { text: '达标', cls: 'ok' },
  risk: { text: '出血不足', cls: 'risk' },
};

// 注释印刷风险区：单条注释判定
const ANNOT_STATUS_LABEL = {
  'print-candidate': { text: '打印候选', cls: 'ok' },
  'missed-print-risk': { text: '漏印风险', cls: 'risk' },
  'needs-confirmation': { text: '待确认', cls: 'needs-confirmation' },
  'off-page': { text: '页外', cls: 'off-page' },
  unknown: { text: '无法判断', cls: 'unknown' },
  ok: { text: '正常', cls: 'skip' },
};

// 注释印刷风险区：页面级状态
const ANNOT_PAGE_STATUS_LABEL = {
  none: { text: '无注释', cls: 'skip' },
  ok: { text: '无风险', cls: 'ok' },
  'missed-print-risk': { text: '漏印风险', cls: 'risk' },
  'needs-confirmation': { text: '待确认', cls: 'needs-confirmation' },
  'off-page': { text: '有页外注释', cls: 'off-page' },
  unknown: { text: '无法判断', cls: 'unknown' },
};

// 内部链接目标核对：单条链接状态
const LINK_STATUS_LABEL = {
  ok: { text: '有效', cls: 'ok' },
  broken: { text: '失效', cls: 'risk' },
  unknown: { text: '无法判断', cls: 'unknown' },
  'out-of-scope': { text: '范围外', cls: 'skip' },
};

form.addEventListener('submit', async (e) => {
  e.preventDefault();
  hideError();
  resultBox.hidden = true;

  const fileInput = document.getElementById('pdf');
  const file = fileInput.files[0];
  if (!file) {
    showError('请先选择一个 PDF 文件。');
    return;
  }

  const finishedWidthMm = Number(document.getElementById('finishedWidthMm').value);
  const finishedHeightMm = Number(document.getElementById('finishedHeightMm').value);
  const minBleedMm = Number(document.getElementById('minBleedMm').value);
  for (const [label, value] of [
    ['成品宽度', finishedWidthMm],
    ['成品高度', finishedHeightMm],
    ['最低出血量', minBleedMm],
  ]) {
    if (!Number.isFinite(value) || value <= 0) {
      showError(`${label}必须为大于 0 的数字（毫米）。`);
      return;
    }
  }

  const body = new FormData();
  body.append('pdf', file);
  body.append('finishedWidthMm', String(finishedWidthMm));
  body.append('finishedHeightMm', String(finishedHeightMm));
  body.append('minBleedMm', String(minBleedMm));

  loadingBox.hidden = false;
  submitBtn.disabled = true;
  try {
    const resp = await fetch('/api/bleedboxes', { method: 'POST', body });
    const data = await resp.json().catch(() => null);
    if (!resp.ok) {
      throw new Error((data && data.error) || `核验失败（HTTP ${resp.status}）。`);
    }
    renderReport(data);
  } catch (err) {
    showError(err.message || '请求失败，请确认服务已启动。');
  } finally {
    loadingBox.hidden = true;
    submitBtn.disabled = false;
  }
});

function renderReport(data) {
  const { summary, finishedMm, minBleedMm } = data;

  const pageList = (arr) =>
    arr.length === 0 ? '无' : `第 ${arr.join('、')} 页`;

  document.getElementById('summary').replaceChildren(
    row('源文件', data.originalName),
    row('总页数', `${summary.totalPages} 页`),
    row(
      '成品尺寸',
      `${finishedMm.width} × ${finishedMm.height} mm（旋转后阅读方向）`
    ),
    row('最低出血量', `四边均 ${minBleedMm} mm（恰好达到不报）`),
    row('通过', summary.riskPages.length || summary.undeclaredPages.length || summary.unknownPages.length
      ? `${summary.okPages.length} 页（第 ${summary.okPages.join('、') || '—'} 页）`
      : `${summary.totalPages} 页全部通过`),
    row('风险页', `${summary.riskPages.length} 页（${pageList(summary.riskPages)}）：尺寸不符或出血不足`),
    row(
      '尺寸不符页',
      `${summary.sizeMismatchPages.length} 页（${pageList(summary.sizeMismatchPages)}）`
    ),
    row(
      '出血不足页',
      `${summary.bleedRiskPages.length} 页（${pageList(summary.bleedRiskPages)}）`
    ),
    row(
      '未声明页',
      `${summary.undeclaredPages.length} 页（${pageList(summary.undeclaredPages)}）：TrimBox 或 BleedBox 未显式声明`
    ),
    row('无法判断页', `${summary.unknownPages.length} 页（${pageList(summary.unknownPages)}）：盒无效或交集为空`)
  );

  const pagesWrap = document.getElementById('pages');
  pagesWrap.textContent = '';
  for (const page of data.pages) {
    pagesWrap.appendChild(renderPage(page));
  }

  // 注释印刷风险区与内部链接目标核对（复用同一上传与逐页报告）
  if (data.annotations) {
    renderAnnotations(data.annotations);
    if (data.annotations.linkTargets) {
      renderLinkTargets(data.annotations.linkTargets);
    }
  }

  resultBox.hidden = false;
  resultBox.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function renderPage(page) {
  const status = PAGE_STATUS_LABEL[page.status];
  const card = document.createElement('div');
  card.className = `card page-card ${status.cls}`;

  const head = document.createElement('div');
  head.className = 'page-head';

  const title = document.createElement('span');
  title.className = 'page-title';
  title.textContent = `第 ${page.pageNumber} 页`;
  head.appendChild(title);

  const meta = document.createElement('span');
  meta.className = 'page-meta';
  meta.textContent = `Rotate ${page.rotation === null ? '—' : page.rotation}° ｜ TrimBox ${
    boxStateText(page.boxes.trim)
  } ｜ BleedBox ${boxStateText(page.boxes.bleed)}`;
  head.appendChild(meta);

  const badge = document.createElement('span');
  badge.className = `badge ${status.cls}`;
  badge.textContent = status.text;
  head.appendChild(badge);
  card.appendChild(head);

  card.appendChild(renderBoxTable(page.boxes));
  card.appendChild(renderSizeCheck(page.sizeCheck));

  if (page.bleedEdges) {
    card.appendChild(renderBleedTable(page));
  } else if (page.bleedDeclared && page.status === 'unknown') {
    card.appendChild(noteP('BleedBox 与 CropBox、MediaBox 无交集（或交集退化），无法计算可用出血。'));
  } else if (!page.bleedDeclared && page.status !== 'unknown') {
    card.appendChild(noteP('页面未显式声明 BleedBox，不套用默认盒，四边出血距离无法计算。'));
  }

  for (const text of page.notes) {
    card.appendChild(noteP(text));
  }
  return card;
}

// ---- 注释印刷风险区 ----

function renderAnnotations(ann) {
  const { summary } = ann;
  const pageList = (arr) =>
    arr.length === 0 ? '无' : `第 ${arr.join('、')} 页`;

  document.getElementById('annot-summary').replaceChildren(
    row('含注释页', `${summary.pagesWithAnnotations} / ${summary.totalPages} 页`),
    row('注释总数', `${summary.totalAnnotations} 条`),
    row(
      '漏印风险页',
      `${summary.missedPrintRiskPages.length} 页（${pageList(summary.missedPrintRiskPages)}）：屏显候选但未设 Print，打印时将丢失`
    ),
    row(
      '待确认页',
      `${summary.needsConfirmationPages.length} 页（${pageList(summary.needsConfirmationPages)}）：设 Print 但外观缺失或损坏`
    ),
    row(
      '页外注释页',
      `${summary.offPagePages.length} 页（${pageList(summary.offPagePages)}）：注释矩形与可见页框无交集`
    ),
    row(
      '无法判断页',
      `${summary.unknownPages.length} 页（${pageList(summary.unknownPages)}）：注释引用损坏或字段非法`
    ),
    row(
      '打印候选',
      `${summary.counts.printCandidate} 条（设 Print 且外观有效，随页面打印）`
    )
  );

  const wrap = document.getElementById('annot-pages');
  wrap.textContent = '';
  for (const page of ann.pages) {
    wrap.appendChild(renderAnnotPage(page));
  }
}

function renderAnnotPage(page) {
  const status = ANNOT_PAGE_STATUS_LABEL[page.status];
  const card = document.createElement('div');
  card.className = `card page-card ${status.cls}`;

  const head = document.createElement('div');
  head.className = 'page-head';

  const title = document.createElement('span');
  title.className = 'page-title';
  title.textContent = `第 ${page.pageNumber} 页`;
  head.appendChild(title);

  const meta = document.createElement('span');
  meta.className = 'page-meta';
  meta.textContent = page.counts
    ? `注释 ${page.counts.total} 条 ｜ 漏印风险 ${page.counts.missedPrintRisk} ｜ ` +
      `待确认 ${page.counts.needsConfirmation} ｜ 页外 ${page.counts.offPage} ｜ ` +
      `无法判断 ${page.counts.unknown}`
    : '无注释';
  head.appendChild(meta);

  const badge = document.createElement('span');
  badge.className = `badge ${status.cls}`;
  badge.textContent = status.text;
  head.appendChild(badge);
  card.appendChild(head);

  if (page.pageError) {
    card.appendChild(noteP(page.pageError));
    return card;
  }
  if (page.annotations.length === 0) {
    card.appendChild(noteP('本页无注释（页面未声明 /Annots 或为空数组）。'));
    return card;
  }
  if (page.frameNote) card.appendChild(noteP(page.frameNote));
  card.appendChild(renderAnnotTable(page.annotations));
  return card;
}

function renderAnnotTable(annotations) {
  const table = document.createElement('table');
  table.className = 'annots';
  table.innerHTML = `
    <thead>
      <tr><th>#</th><th>类型</th><th>原点 x / y（mm）</th><th>宽 × 高（mm）</th><th>屏显</th><th>打印</th><th>判定</th></tr>
    </thead>
    <tbody></tbody>`;
  const tbody = table.querySelector('tbody');
  for (const a of annotations) {
    const tr = document.createElement('tr');
    if (a.status === 'missed-print-risk') tr.className = 'row-mismatch';
    else if (a.status === 'unknown') tr.className = 'row-unknown';

    tr.appendChild(td(String(a.index), 'num'));

    const typeTd = td(a.subtype ? `/${a.subtype}` : '—', 'boxname');
    if (a.flags !== null && a.flags !== undefined) {
      const f = document.createElement('div');
      f.className = 'cell-reason';
      f.textContent =
        a.flagNames && a.flagNames.length > 0
          ? `/F=${a.flags}（${a.flagNames.join('、')}）`
          : `/F=${a.flags}`;
      typeTd.appendChild(f);
    }
    tr.appendChild(typeTd);

    if (a.rectMm) {
      tr.appendChild(td(`${fmt(a.rectMm.x)} / ${fmt(a.rectMm.y)}`, 'num'));
      tr.appendChild(td(`${fmt(a.rectMm.width)} × ${fmt(a.rectMm.height)}`, 'num'));
    } else {
      tr.appendChild(td('—', 'num'));
      tr.appendChild(td('—', 'num'));
    }

    tr.appendChild(statusCell(a.screen));
    tr.appendChild(statusCell(a.print));

    const judgeTd = document.createElement('td');
    const label = ANNOT_STATUS_LABEL[a.status];
    const chip = document.createElement('span');
    chip.className = `badge ${label.cls}`;
    chip.textContent = label.text;
    judgeTd.appendChild(chip);
    for (const note of a.notes) {
      judgeTd.appendChild(reasonDiv(note));
    }
    tr.appendChild(judgeTd);
    tbody.appendChild(tr);
  }
  return table;
}

// ---- 内部链接目标核对 ----

function renderLinkTargets(lt) {
  const s = lt.summary;
  document.getElementById('link-summary').replaceChildren(
    row('Link 注释', `${s.total} 条`),
    row('有效', `${s.ok} 条（目标为本文件页面，页序从 1 起）`),
    row(
      '失效',
      `${s.broken} 条（未设目标、完整查找后仍缺名或目标页不存在）`
    ),
    row(
      '无法判断',
      `${s.unknown} 条（坏引用、循环引用、重名、非法类型或 /Dest 与 /A 并存）`
    ),
    row('范围外', `${s.outOfScope} 条（非 /GoTo 动作，不访问网络）`)
  );

  const wrap = document.getElementById('link-list');
  wrap.textContent = '';
  if (!lt.links || lt.links.length === 0) {
    const card = document.createElement('div');
    card.className = 'card';
    card.appendChild(noteP('未检出 /Link 注释，无内部链接目标需要核对。'));
    wrap.appendChild(card);
    return;
  }

  const card = document.createElement('div');
  card.className = 'card';
  const table = document.createElement('table');
  table.className = 'annots';
  table.innerHTML = `
    <thead>
      <tr><th>来源页</th><th>注释序号</th><th>目标来源</th><th>目标页</th><th>状态</th><th>原因</th></tr>
    </thead>
    <tbody></tbody>`;
  const tbody = table.querySelector('tbody');
  for (const link of lt.links) {
    const tr = document.createElement('tr');
    if (link.status === 'broken') tr.className = 'row-mismatch';
    else if (link.status === 'unknown') tr.className = 'row-unknown';

    tr.appendChild(td(`第 ${link.pageNumber} 页`));
    tr.appendChild(td(String(link.annotIndex), 'num'));
    tr.appendChild(
      td(link.source === 'Dest' ? '/Dest' : link.source === 'A' ? '/A' : '—', 'boxname')
    );
    tr.appendChild(
      td(
        link.targetPage !== null && link.targetPage !== undefined
          ? `第 ${link.targetPage} 页`
          : '—',
        'num'
      )
    );

    const statusTd = document.createElement('td');
    const label = LINK_STATUS_LABEL[link.status];
    const chip = document.createElement('span');
    chip.className = `badge ${label.cls}`;
    chip.textContent = label.text;
    statusTd.appendChild(chip);
    tr.appendChild(statusTd);

    tr.appendChild(td(link.reason));
    tbody.appendChild(tr);
  }
  card.appendChild(table);
  wrap.appendChild(card);
}

function statusCell(s) {
  const cell = document.createElement('td');
  const main = document.createElement('div');
  main.textContent = s.text;
  cell.appendChild(main);
  cell.appendChild(reasonDiv(s.reason));
  return cell;
}

function reasonDiv(text) {
  const div = document.createElement('div');
  div.className = 'cell-reason';
  div.textContent = text;
  return div;
}

function renderBoxTable(boxes) {
  const table = document.createElement('table');
  table.className = 'bleed-boxes';
  table.innerHTML = `
    <thead>
      <tr><th>页面盒</th><th>状态</th><th>原点 x / y（mm）</th><th>宽 × 高（mm，未旋转用户空间）</th></tr>
    </thead>
    <tbody></tbody>`;
  const rows = [
    ['MediaBox', boxes.media, true],
    ['CropBox', boxes.crop, true],
    ['TrimBox', boxes.trim, false],
    ['BleedBox', boxes.bleed, false],
  ];
  const tbody = table.querySelector('tbody');
  for (const [name, info, required] of rows) {
    const tr = document.createElement('tr');
    if (info.invalid || (!info.declared && !info.defaulted)) tr.className = 'row-unknown';
    tr.appendChild(td(name, 'boxname'));

    const stateTd = document.createElement('td');
    if (info.defaulted) stateTd.textContent = '缺省（取 MediaBox）';
    else if (info.invalid) stateTd.textContent = '已声明但无效';
    else if (info.declared) stateTd.textContent = '显式声明';
    else stateTd.textContent = required ? '缺失/无效' : '未声明';
    tr.appendChild(stateTd);

    if (info.rectMm) {
      tr.appendChild(td(`${fmt(info.rectMm.x)} / ${fmt(info.rectMm.y)}`, 'num'));
      tr.appendChild(td(`${fmt(info.rectMm.width)} × ${fmt(info.rectMm.height)}`, 'num'));
    } else {
      tr.appendChild(td('—', 'num'));
      tr.appendChild(td('—', 'num'));
    }
    tbody.appendChild(tr);
  }
  return table;
}

function boxStateText(info) {
  if (info.invalid) return '已声明但无效';
  return info.declared ? '已声明' : '未声明';
}

function renderSizeCheck(sizeCheck) {
  if (!sizeCheck) {
    return noteP('盒几何无效，成品尺寸无法核对。');
  }
  const p = document.createElement('p');
  p.className = 'size-check';
  if (sizeCheck.status === 'undeclared') {
    p.textContent =
      `成品尺寸：期望 ${fmt(sizeCheck.expectedMm.width)} × ${fmt(sizeCheck.expectedMm.height)} mm；` +
      'TrimBox 未声明，无法核对。';
    return p;
  }
  const mismatch = sizeCheck.status === 'mismatch';
  p.classList.add(mismatch ? 'size-mismatch' : 'size-ok');
  p.textContent =
    `成品尺寸（旋转后阅读方向）：TrimBox ${fmt(sizeCheck.actualMm.width)} × ${fmt(sizeCheck.actualMm.height)} mm` +
    `，期望 ${fmt(sizeCheck.expectedMm.width)} × ${fmt(sizeCheck.expectedMm.height)} mm` +
    `，差值 ${signedFmt(sizeCheck.diffMm.width)} / ${signedFmt(sizeCheck.diffMm.height)} mm` +
    (mismatch ? ' —— 尺寸不符（超过 0.5 mm）。' : ' —— 相符（误差不超过 0.5 mm）。');
  return p;
}

function renderBleedTable(page) {
  const wrap = document.createElement('div');
  const caption = document.createElement('p');
  caption.className = 'table-caption';
  caption.textContent = page.usableBleedRectMm
    ? `可用出血范围 = BleedBox ∩ CropBox ∩ MediaBox（${fmt(page.usableBleedRectMm.width)} × ${fmt(page.usableBleedRectMm.height)} mm，未旋转用户空间）；四边超出 TrimBox 的距离（旋转后阅读方向）：`
    : '四边超出 TrimBox 的距离（旋转后阅读方向）：';
  wrap.appendChild(caption);

  const table = document.createElement('table');
  table.className = 'bleed-edges';
  table.innerHTML = `
    <thead>
      <tr><th>边</th><th>可用出血（mm）</th><th>最低要求（mm）</th><th>状态</th></tr>
    </thead>
    <tbody></tbody>`;
  const tbody = table.querySelector('tbody');
  for (const edge of page.bleedEdges) {
    const tr = document.createElement('tr');
    if (edge.status === 'risk') tr.className = 'row-mismatch';
    tr.appendChild(td(edge.edgeName));
    tr.appendChild(td(signedFmt(edge.distanceMm), 'num'));
    tr.appendChild(td(fmt(edge.requiredMm), 'num'));
    const stateTd = document.createElement('td');
    const label = EDGE_STATUS_LABEL[edge.status];
    const chip = document.createElement('span');
    chip.className = `badge ${label.cls}`;
    chip.textContent = label.text;
    stateTd.appendChild(chip);
    tr.appendChild(stateTd);
    tbody.appendChild(tr);
  }
  wrap.appendChild(table);
  return wrap;
}

function noteP(text) {
  const p = document.createElement('p');
  p.className = 'page-note';
  p.textContent = text;
  return p;
}

function td(text, className) {
  const el = document.createElement('td');
  if (className) el.className = className;
  el.textContent = text;
  return el;
}

function row(dtText, ddText) {
  const frag = document.createDocumentFragment();
  const dt = document.createElement('dt');
  dt.textContent = dtText;
  const dd = document.createElement('dd');
  dd.textContent = ddText;
  frag.append(dt, dd);
  return frag;
}

function fmt(n) {
  return (n === null || n === undefined) ? '—' : String(n);
}
function signedFmt(n) {
  return n > 0 ? `+${fmt(n)}` : fmt(n);
}

function showError(msg) {
  errorBox.textContent = msg;
  errorBox.hidden = false;
}
function hideError() {
  errorBox.textContent = '';
  errorBox.hidden = true;
}
