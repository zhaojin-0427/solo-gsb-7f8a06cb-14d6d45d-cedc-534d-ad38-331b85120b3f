// linktargets.js
// 内部链接目标核对核心逻辑（裁切与出血盒核验页“注释印刷风险区”的链接目标核对）。
//
// 规则：
//   - 只核对 /Subtype 为 /Link 的注释：目标取自 /Dest，或 /A 动作字典
//     （/S=/GoTo）的 /D；两者同时存在记为“无法判断”（以哪个为准无法确定）；
//   - 未设目标（无 /Dest，且 /A 不是 /GoTo 或缺少 /D）记为“失效”；
//     /A 的 /S 不是 /GoTo（如 /URI、/GoToR、/Launch 等）标为“范围外”，
//     不访问网络、不追踪外部目标；
//   - 目标为数组（显式目标）时只核对首项是否为本文件页面的间接引用：
//     命中显示从 1 起的页序，不检查缩放/位置参数；首项引用损坏记为
//     “无法判断”，引用可解析但不是本文件页面记为“失效”（目标页不存在），
//     首项不是间接引用（非法类型）记为“无法判断”；
//   - 目标为名称对象时查 Catalog/Dests 字典，为字符串时查
//     Catalog/Names/Dests 名称树：遍历 /Kids 与 /Names，按解码后的原文
//     匹配；命中的值支持目标数组或 /D 为目标数组的字典；
//   - 坏引用、循环（名称树 /Kids 回环）、重名（多处同名条目）或非法类型
//     记为“无法判断”，单处失败不中断其他分支与其他链接；完整查找后仍
//     缺名、或目标页不存在，记为“失效”；名称树存在损坏分支且未命中时
//     记为“无法判断”；
//   - 只核对 PDF 对象结构，不模拟点击、不访问网络。
//
// 解析使用 pdf-lib 底层对象模型（PDFDict / PDFArray / PDFName / PDFString /
// PDFHexString / PDFRef）。

import {
  PDFArray,
  PDFDict,
  PDFHexString,
  PDFName,
  PDFRef,
  PDFString,
} from 'pdf-lib';

// 链接目标核对状态
export const LINK_STATUS = {
  ok: 'ok', // 有效：目标为本文件页面
  broken: 'broken', // 失效：未设目标 / 缺名 / 目标页不存在
  unknown: 'unknown', // 无法判断：坏引用、循环、重名、非法类型、两者并存等
  outOfScope: 'out-of-scope', // 范围外：非 /GoTo 动作，不访问网络
};

export const LINK_SCOPE_NOTE =
  '本区仅核对 /Link 注释的内部跳转目标（/Dest 或 /A（/S=/GoTo）的 /D）' +
  '是否指向本文件页面，不模拟点击、不访问网络；/URI、/GoToR 等其他动作' +
  '标为“范围外”。';

/** 解析可能为间接引用的值；引用损坏或解析异常时返回 undefined。 */
function resolve(context, value) {
  try {
    return context.lookup(value);
  } catch {
    return undefined;
  }
}

/** 名称对象解码（#XX 转义）；失败时退回原始串。 */
function nameText(pdfName) {
  try {
    return pdfName.decodeText();
  } catch {
    return String(pdfName);
  }
}

/** 字符串对象解码（UTF-16 / PDFDocEncoding）；失败返回 undefined。 */
function stringText(pdfString) {
  try {
    return pdfString.decodeText();
  } catch {
    return undefined;
  }
}

const ok = (targetPage, reason) => ({
  status: LINK_STATUS.ok,
  targetPage,
  reason,
});
const broken = (reason) => ({
  status: LINK_STATUS.broken,
  targetPage: null,
  reason,
});
const unknown = (reason) => ({
  status: LINK_STATUS.unknown,
  targetPage: null,
  reason,
});
const outOfScope = (reason) => ({
  status: LINK_STATUS.outOfScope,
  targetPage: null,
  reason,
});

/** 截断过长的目标名，便于报告展示。 */
function shown(text, limit = 50) {
  return text.length > limit ? `${text.slice(0, limit)}…` : text;
}

/**
 * 创建内部链接目标核对器（每份文档一个）。
 * @param context pdf-lib 的 PDFContext
 * @param catalog 文档 Catalog 字典
 * @param pages doc.getPages() 返回的页面数组（页序 = 下标 + 1）
 */
export function createLinkChecker(context, catalog, pages) {
  // 本文件页面间接引用（"N G R" 标签）→ 从 1 起的页序
  const pageRefs = new Map();
  pages.forEach((page, i) => {
    if (page && page.ref) pageRefs.set(page.ref.toString(), i + 1);
  });

  // ---- Catalog/Dests 名称字典索引（惰性构建一次，供所有名称目标复用）----
  let destsCache = null;
  function destsIndex() {
    if (destsCache) return destsCache;
    const raw = catalog.get(PDFName.of('Dests'));
    if (raw === undefined) {
      destsCache = { state: 'absent' };
      return destsCache;
    }
    const dict = resolve(context, raw);
    if (!(dict instanceof PDFDict)) {
      destsCache = {
        state: 'bad',
        note:
          raw instanceof PDFRef
            ? 'Catalog/Dests 间接引用损坏或不是字典'
            : 'Catalog/Dests 不是字典',
      };
      return destsCache;
    }
    const map = new Map(); // 解码原文 -> { count, value }
    for (const [key, value] of dict.entries()) {
      const text = key instanceof PDFName ? nameText(key) : String(key);
      const hit = map.get(text);
      if (hit) hit.count += 1;
      else map.set(text, { count: 1, value });
    }
    destsCache = { state: 'ok', map };
    return destsCache;
  }

  // ---- Catalog/Names/Dests 名称树索引（惰性遍历一次，供所有字符串目标复用）----
  let nameTreeCache = null;
  function nameTreeIndex() {
    if (nameTreeCache) return nameTreeCache;
    const build = (state, extra) => {
      nameTreeCache = { state, ...extra };
      return nameTreeCache;
    };

    const namesRaw = catalog.get(PDFName.of('Names'));
    if (namesRaw === undefined) return build('absent');
    const names = resolve(context, namesRaw);
    if (!(names instanceof PDFDict)) {
      return build('bad', {
        note:
          namesRaw instanceof PDFRef
            ? 'Catalog/Names 间接引用损坏或不是字典'
            : 'Catalog/Names 不是字典',
      });
    }
    const rootRaw = names.get(PDFName.of('Dests'));
    if (rootRaw === undefined) return build('absent');
    const root = resolve(context, rootRaw);
    if (!(root instanceof PDFDict)) {
      return build('bad', {
        note:
          rootRaw instanceof PDFRef
            ? 'Catalog/Names/Dests 间接引用损坏或不是字典'
            : 'Catalog/Names/Dests 不是字典',
      });
    }

    // 迭代遍历 /Kids 与 /Names（避免深层树递归溢出）；visited 检测循环引用
    const map = new Map(); // 解码原文 -> { count, value }
    let badBranch = null; // 首个损坏分支的说明
    const markBad = (note) => {
      if (!badBranch) badBranch = note;
    };
    const visited = new Set();
    if (rootRaw instanceof PDFRef) visited.add(rootRaw.toString());
    const stack = [root];
    while (stack.length > 0) {
      const node = stack.pop();

      const namesArrRaw = node.get(PDFName.of('Names'));
      if (namesArrRaw !== undefined) {
        const arr = resolve(context, namesArrRaw);
        if (!(arr instanceof PDFArray)) {
          markBad('名称树节点的 /Names 不是数组或引用损坏');
        } else {
          if (arr.size() % 2 !== 0) {
            markBad('名称树 /Names 数组长度为奇数（名字与值不成对）');
          }
          for (let i = 0; i + 1 < arr.size(); i += 2) {
            const nameObj = resolve(context, arr.get(i));
            const isString =
              nameObj instanceof PDFString || nameObj instanceof PDFHexString;
            if (!isString) {
              markBad(`名称树 /Names 第 ${i / 2 + 1} 对的名字不是字符串`);
              continue;
            }
            const text = stringText(nameObj);
            if (text === undefined) {
              markBad(`名称树 /Names 第 ${i / 2 + 1} 对的名字解码失败`);
              continue;
            }
            const value = arr.get(i + 1); // 原始值，命中时再解析
            const hit = map.get(text);
            if (hit) hit.count += 1;
            else map.set(text, { count: 1, value });
          }
        }
      }

      const kidsRaw = node.get(PDFName.of('Kids'));
      if (kidsRaw !== undefined) {
        const kids = resolve(context, kidsRaw);
        if (!(kids instanceof PDFArray)) {
          markBad('名称树节点的 /Kids 不是数组或引用损坏');
        } else {
          for (let i = 0; i < kids.size(); i++) {
            const kidRaw = kids.get(i);
            if (kidRaw instanceof PDFRef) {
              const tag = kidRaw.toString();
              if (visited.has(tag)) {
                markBad(`名称树 /Kids 存在循环引用（${tag}）`);
                continue;
              }
              visited.add(tag);
            }
            const kid = resolve(context, kidRaw);
            if (!(kid instanceof PDFDict)) {
              markBad(`名称树 /Kids 第 ${i + 1} 项引用损坏或不是字典`);
              continue;
            }
            stack.push(kid);
          }
        }
      }
    }
    return build('ok', { map, badBranch });
  }

  // ---- 显式目标数组：只核对首项是否为本文件页面引用（不查缩放参数）----
  function checkDestArray(arr, desc) {
    if (arr.size() === 0) {
      return unknown(`${desc}：目标数组为空，缺少首项页面引用。`);
    }
    const first = arr.get(0);
    if (first instanceof PDFRef) {
      const tag = first.toString();
      const pageNumber = pageRefs.get(tag);
      if (pageNumber !== undefined) {
        return ok(
          pageNumber,
          `${desc}：目标数组首项 ${tag} 指向第 ${pageNumber} 页。`
        );
      }
      if (resolve(context, first) === undefined) {
        return unknown(`${desc}：目标数组首项 ${tag} 间接引用损坏。`);
      }
      return broken(
        `${desc}：目标数组首项 ${tag} 不是本文件页面（目标页不存在）。`
      );
    }
    return unknown(`${desc}：目标数组首项不是页面间接引用（非法类型）。`);
  }

  // ---- 名称/字符串命中的目标值：目标数组或 /D 为目标数组的字典 ----
  function checkNamedValue(rawValue, desc) {
    const value = resolve(context, rawValue);
    if (value === undefined) {
      return unknown(`${desc}：命中的目标值间接引用损坏。`);
    }
    if (value instanceof PDFArray) return checkDestArray(value, desc);
    if (value instanceof PDFDict) {
      const dRaw = value.get(PDFName.of('D'));
      if (dRaw === undefined) {
        return unknown(`${desc}：命中的目标字典缺少 /D 目标数组。`);
      }
      const d = resolve(context, dRaw);
      if (!(d instanceof PDFArray)) {
        return unknown(`${desc}：目标字典的 /D 不是数组或引用损坏。`);
      }
      return checkDestArray(d, desc);
    }
    return unknown(`${desc}：命中的目标值不是数组或含 /D 的字典（非法类型）。`);
  }

  // ---- 名称目标：查 Catalog/Dests ----
  function lookupDests(text) {
    const idx = destsIndex();
    if (idx.state === 'absent') {
      return broken(
        `目标名称 /${shown(text)}：文档没有 Catalog/Dests 名称字典，完整查找后缺名。`
      );
    }
    if (idx.state === 'bad') {
      return unknown(`目标名称 /${shown(text)}：${idx.note}，无法判断。`);
    }
    const hit = idx.map.get(text);
    if (!hit) {
      return broken(`目标名称 /${shown(text)}：完整查找 Catalog/Dests 后缺名。`);
    }
    if (hit.count > 1) {
      return unknown(
        `目标名称 /${shown(text)}：Catalog/Dests 中存在 ${hit.count} 处同名条目（重名）。`
      );
    }
    return checkNamedValue(hit.value, `目标名称 /${shown(text)}（Catalog/Dests）`);
  }

  // ---- 字符串目标：查 Catalog/Names/Dests 名称树 ----
  function lookupNameTree(text) {
    const idx = nameTreeIndex();
    if (idx.state === 'absent') {
      return broken(
        `目标字符串“${shown(text)}”：文档没有 Catalog/Names/Dests 名称树，完整查找后缺名。`
      );
    }
    if (idx.state === 'bad') {
      return unknown(`目标字符串“${shown(text)}”：${idx.note}，无法判断。`);
    }
    const hit = idx.map.get(text);
    if (!hit) {
      return idx.badBranch
        ? unknown(
            `目标字符串“${shown(text)}”：名称树存在损坏分支（${idx.badBranch}）且未命中，无法判断。`
          )
        : broken(`目标字符串“${shown(text)}”：完整查找名称树后缺名。`);
    }
    if (hit.count > 1) {
      return unknown(
        `目标字符串“${shown(text)}”：名称树中存在 ${hit.count} 处同名条目（重名）。`
      );
    }
    return checkNamedValue(hit.value, `目标字符串“${shown(text)}”（名称树）`);
  }

  // ---- 目标值分派：数组 / 名称 / 字符串（均可为间接引用）----
  function checkDestValue(raw, desc) {
    const value = resolve(context, raw);
    if (value === undefined) {
      return unknown(`${desc}间接引用损坏。`);
    }
    if (value instanceof PDFArray) return checkDestArray(value, desc);
    if (value instanceof PDFName) return lookupDests(nameText(value));
    if (value instanceof PDFString || value instanceof PDFHexString) {
      const text = stringText(value);
      if (text === undefined) return unknown(`${desc}字符串解码失败。`);
      return lookupNameTree(text);
    }
    return unknown(`${desc}不是数组、名称或字符串（非法类型）。`);
  }

  /**
   * 核对单条 /Link 注释的内部目标。
   * @param annotDict 注释字典（已解析的 PDFDict）
   * @returns {{status:string, targetPage:number|null, reason:string}}
   */
  function check(annotDict) {
    const rawDest = annotDict.get(PDFName.of('Dest'));
    const rawAction = annotDict.get(PDFName.of('A'));

    let gotoD;
    if (rawAction !== undefined) {
      const action = resolve(context, rawAction);
      if (!(action instanceof PDFDict)) {
        return unknown(
          rawAction instanceof PDFRef && action === undefined
            ? '/A 动作字典间接引用损坏，无法判断。'
            : '/A 不是字典对象，无法判断。'
        );
      }
      const rawS = action.get(PDFName.of('S'));
      const s = rawS === undefined ? undefined : resolve(context, rawS);
      if (!(s instanceof PDFName)) {
        return unknown('/A 动作缺少 /S 或 /S 不是名称对象，无法判断。');
      }
      const sText = nameText(s);
      if (sText !== 'GoTo') {
        return outOfScope(
          `动作 /S=/${sText} 超出核对范围（仅核对 /GoTo 内部目标），不访问网络。`
        );
      }
      gotoD = action.get(PDFName.of('D'));
    }

    const hasDest = rawDest !== undefined;
    const hasGotoD = gotoD !== undefined;
    if (hasDest && hasGotoD) {
      return unknown('/Dest 与 /A（/S=/GoTo）的 /D 同时存在，无法判断以哪个为准。');
    }
    if (!hasDest && !hasGotoD) {
      return broken(
        rawAction !== undefined
          ? '未设目标：/A（/S=/GoTo）缺少 /D，注释也没有 /Dest。'
          : '未设目标：注释缺少 /Dest 与 /A。'
      );
    }
    return hasGotoD
      ? checkDestValue(gotoD, '/A（/S=/GoTo）的 /D')
      : checkDestValue(rawDest, '/Dest');
  }

  return { check };
}
