// content.js — Shinkansen Content Script 主模組
// 職責：Debug Bridge、translatePage、restorePage、translateUnits、
// 編輯模式、訊息處理、Debug API、初始化。
// 注意：content script 不支援 ES module import。
// v1.1.9: 拆分為 7 個檔案，本檔為主協調層，依賴 content-ns/toast/detect/serialize/inject/spa。

(function(SK) {

  const STATE = SK.STATE;

  // ─── v0.88: Debug Bridge ──────────────────────────────
  window.addEventListener('shinkansen-debug-request', (e) => {
    const { action, afterSeq } = (e.detail || {});
    const respond = (detail) => {
      window.dispatchEvent(new CustomEvent('shinkansen-debug-response', { detail }));
    };

    if (action === 'GET_LOGS') {
      browser.runtime.sendMessage(
        { type: 'GET_LOGS', payload: { afterSeq: afterSeq || 0 } },
        (res) => respond(res || { ok: false, error: 'no response' }),
      );
    } else if (action === 'CLEAR_LOGS') {
      browser.runtime.sendMessage({ type: 'CLEAR_LOGS' }, (res) => {
        respond(res || { ok: true });
      });
    } else if (action === 'CLEAR_CACHE') {
      browser.runtime.sendMessage({ type: 'CLEAR_CACHE' }, (res) => {
        respond(res || { ok: true });
      });
    } else if (action === 'TRANSLATE') {
      respond({ ok: true, triggered: true });
      SK.translatePage();
    } else if (action === 'RESTORE') {
      if (STATE.translated) {
        restorePage();
        respond({ ok: true, restored: true });
      } else {
        respond({ ok: false, error: 'not translated' });
      }
    } else if (action === 'CLEAR_RPD') {
      browser.runtime.sendMessage({ type: 'CLEAR_RPD' }, (res) => {
        respond(res || { ok: true });
      });
    } else if (action === 'GET_PERSISTED_LOGS') {
      // v1.2.52: 讀取跨 service worker 重啟仍保留的持久化 log
      browser.runtime.sendMessage({ type: 'GET_PERSISTED_LOGS' }, (res) => {
        respond(res || { ok: false, error: 'no response' });
      });
    } else if (action === 'CLEAR_PERSISTED_LOGS') {
      // v1.2.52: 清除持久化 log（測試前呼叫，避免舊資料干擾）
      browser.runtime.sendMessage({ type: 'CLEAR_PERSISTED_LOGS' }, (res) => {
        respond(res || { ok: true });
      });
    } else if (action === 'GET_STATE') {
      respond({
        ok: true,
        translated: STATE.translated,
        translating: STATE.translating,
        segmentCount: STATE.originalHTML.size,
      });
    } else if (action === 'GET_YT_DEBUG') {
      // 暴露 YT 字幕翻譯的內部狀態，供除錯比對用
      const YT = SK.YT;
      if (!YT) { respond({ ok: false, error: 'SK.YT not available' }); return; }
      const rawNorms    = YT.rawSegments.map(s => s.normText);
      const rawTexts    = YT.rawSegments.map(s => s.text);
      const rawStartMs  = YT.rawSegments.map(s => s.startMs);
      const rawGroupIds = YT.rawSegments.map(s => s.groupId);
      const mapKeys     = Array.from(YT.captionMap.keys());
      const rawSet      = new Set(rawNorms);
      const onTheFlyKeys = mapKeys.filter(k => !rawSet.has(k));
      respond({
        ok: true,
        active:           YT.active,
        translating:      YT.translating,
        rawCount:         YT.rawSegments.length,
        rawNormTexts:     rawNorms,
        rawTexts:         rawTexts,
        rawStartMs:       rawStartMs,
        rawGroupIds:      rawGroupIds,
        captionMapSize:   YT.captionMap.size,
        captionMapKeys:   mapKeys,
        onTheFlyKeys:     onTheFlyKeys,
        translatedUpToMs: YT.translatedUpToMs,
        ytConfig:         YT.config,
      });
    } else {
      respond({ ok: false, error: 'unknown action: ' + action });
    }
  });

  // ─── 延遲 Rescan 機制 ────────────────────────────────

  let rescanAttempts = 0;
  let rescanTimer = null;

  SK.cancelRescan = function cancelRescan() {
    if (rescanTimer) {
      clearTimeout(rescanTimer);
      rescanTimer = null;
    }
    rescanAttempts = 0;
  };

  function scheduleRescanForLateContent() {
    SK.cancelRescan();
    rescanTimer = setTimeout(rescanTick, SK.RESCAN_DELAYS_MS[0]);
  }

  async function rescanTick() {
    rescanTimer = null;
    if (!STATE.translated) return;
    const newUnits = SK.collectParagraphs();
    if (newUnits.length > 0) {
      try {
        const { done, failures } = await SK.translateUnits(newUnits);
        if (!STATE.translated) return;
        if (done > 0) {
          SK.sendLog('info', 'translate', 'rescan caught new units', { done, failures: failures.length, attempt: rescanAttempts + 1 });
        }
      } catch (err) {
        SK.sendLog('warn', 'translate', 'rescan failed', { error: err.message });
      }
    }
    rescanAttempts += 1;
    if (rescanAttempts < SK.RESCAN_DELAYS_MS.length) {
      rescanTimer = setTimeout(rescanTick, SK.RESCAN_DELAYS_MS[rescanAttempts]);
    }
  }

  // ─── 並行執行器 ──────────────────────────────────────

  // 每批 API 呼叫逾時門檻：超過此時間視為逾時，以 error 記錄並繼續下一批。
  // 防止 Gemini API 無回應時整頁翻譯永久卡住。
  const BATCH_TIMEOUT_MS = 90_000;

  async function runWithConcurrency(jobs, maxConcurrent, workerFn) {
    const n = Math.min(maxConcurrent, jobs.length);
    if (n === 0) return;
    let cursor = 0;
    const workers = [];
    for (let w = 0; w < n; w++) {
      workers.push((async () => {
        // eslint-disable-next-line no-constant-condition
        while (true) {
          if (STATE.abortController?.signal.aborted) return;
          const idx = cursor++;
          if (idx >= jobs.length) return;
          await workerFn(jobs[idx]);
        }
      })());
    }
    await Promise.all(workers);
  }

  // ─── Greedy 打包 ─────────────────────────────────────

  function packBatches(texts, units, slotsList, maxUnits, maxChars) {
    const jobs = [];
    let cur = null;
    const flush = () => {
      if (cur && cur.texts.length > 0) jobs.push(cur);
      cur = null;
    };
    for (let i = 0; i < texts.length; i++) {
      const len = (texts[i] || '').length;
      if (len > maxChars) {
        flush();
        jobs.push({
          start: i,
          texts: [texts[i]],
          units: [units[i]],
          slots: [slotsList[i]],
          chars: len,
          oversized: true,
        });
        continue;
      }
      if (cur && (cur.chars + len > maxChars || cur.texts.length >= maxUnits)) {
        flush();
      }
      if (!cur) cur = { start: i, texts: [], units: [], slots: [], chars: 0 };
      cur.texts.push(texts[i]);
      cur.units.push(units[i]);
      cur.slots.push(slotsList[i]);
      cur.chars += len;
    }
    flush();
    return jobs;
  }

  // ─── translateUnits ──────────────────────────────────

  SK.translateUnits = async function translateUnits(units, { onProgress, glossary, signal } = {}) {
    const total = units.length;
    const serialized = units.map(unit => {
      if (unit.kind === 'fragment') {
        return SK.serializeFragmentWithPlaceholders(unit);
      }
      const el = unit.el;
      // v1.2.4: 移除 containsMedia 強制 slots:[] 的早返回。
      // 含媒體元素（如 <img> emoji + <a> 連結）的段落應正常序列化 slots，
      // 讓 LLM 能保留 <a> 佔位符，injection path B 的 fragment 注入已支援此情境。
      if (!SK.hasPreservableInline(el)) {
        return { text: el.innerText.trim(), slots: [] };
      }
      return SK.serializeWithPlaceholders(el);
    });
    const texts = serialized.map(s => s.text);
    const slotsList = serialized.map(s => s.slots);

    // v1.1.9: 合併讀取設定（減少 browser.storage.sync.get 呼叫次數）
    let maxConcurrent = SK.DEFAULT_MAX_CONCURRENT;
    let maxUnitsPerBatch = SK.DEFAULT_UNITS_PER_BATCH;
    let maxCharsPerBatch = SK.DEFAULT_CHARS_PER_BATCH;
    try {
      const batchCfg = await browser.storage.sync.get(['maxConcurrentBatches', 'maxUnitsPerBatch', 'maxCharsPerBatch']);
      if (Number.isFinite(batchCfg.maxConcurrentBatches) && batchCfg.maxConcurrentBatches > 0) {
        maxConcurrent = batchCfg.maxConcurrentBatches;
      }
      if (Number.isFinite(batchCfg.maxUnitsPerBatch) && batchCfg.maxUnitsPerBatch >= 1) {
        maxUnitsPerBatch = batchCfg.maxUnitsPerBatch;
      }
      if (Number.isFinite(batchCfg.maxCharsPerBatch) && batchCfg.maxCharsPerBatch >= 500) {
        maxCharsPerBatch = batchCfg.maxCharsPerBatch;
      }
    } catch (_) { /* 保持 default */ }

    let done = 0;
    const pageUsage = {
      inputTokens: 0, outputTokens: 0, cachedTokens: 0, costUSD: 0,
      billedInputTokens: 0, billedCostUSD: 0,
      cacheHits: 0,
    };
    const jobs = packBatches(texts, units, slotsList, maxUnitsPerBatch, maxCharsPerBatch);
    const failures = [];
    let rpdWarning = false;
    let hadAnyMismatch = false;

    const t0All = Date.now();
    SK.sendLog('info', 'translate', 'translateUnits start', { batches: jobs.length, total, maxConcurrent });

    await runWithConcurrency(jobs, maxConcurrent, async (job) => {
      if (signal?.aborted) return;
      const batchIdx = jobs.indexOf(job);
      const t0 = Date.now();
      SK.sendLog('info', 'translate', `batch ${batchIdx + 1}/${jobs.length} start`, { units: job.texts.length, chars: job.chars });
      try {
        const response = await Promise.race([
          browser.runtime.sendMessage({
            type: 'TRANSLATE_BATCH',
            payload: { texts: job.texts, glossary: glossary || null },
          }),
          new Promise((_, reject) =>
            setTimeout(() => reject(new Error(`批次逾時（${BATCH_TIMEOUT_MS / 1000}s）`)), BATCH_TIMEOUT_MS)
          ),
        ]);
        const elapsed = Date.now() - t0;
        const cacheHit = response?.usage?.cacheHits || 0;
        const apiCalls = job.texts.length - cacheHit;
        SK.sendLog('info', 'translate', `batch ${batchIdx + 1}/${jobs.length} done`, { elapsed, cacheHits: cacheHit, apiCalls });
        if (!response?.ok) throw new Error(response?.error || '未知錯誤');
        const translations = response.result;
        if (response.usage) {
          pageUsage.inputTokens += response.usage.inputTokens || 0;
          pageUsage.outputTokens += response.usage.outputTokens || 0;
          pageUsage.cachedTokens += response.usage.cachedTokens || 0;
          pageUsage.costUSD += response.usage.costUSD || 0;
          pageUsage.billedInputTokens += response.usage.billedInputTokens || 0;
          pageUsage.billedCostUSD += response.usage.billedCostUSD || 0;
          pageUsage.cacheHits += response.usage.cacheHits || 0;
        }
        if (response.rpdExceeded) rpdWarning = true;
        if (response.hadMismatch) hadAnyMismatch = true;
        translations.forEach((tr, j) => SK.injectTranslation(job.units[j], tr, job.slots[j]));
        done += job.texts.length;
        if (onProgress) onProgress(done, total, hadAnyMismatch);
      } catch (err) {
        const elapsed = Date.now() - t0;
        SK.sendLog('error', 'translate', `batch ${batchIdx + 1}/${jobs.length} FAILED`, { elapsed, start: job.start, error: err.message });
        failures.push({ start: job.start, count: job.texts.length, error: err.message });
      }
    });

    SK.sendLog('info', 'translate', 'translateUnits complete', { elapsed: Date.now() - t0All, done, total, failures: failures.length });

    return { done, total, failures, pageUsage, rpdWarning };
  };

  // ─── Google Docs 偵測 ────────────────────────────────

  function isGoogleDocsEditorPage() {
    return location.hostname === 'docs.google.com'
      && /^\/document\/d\/[^/]+\/(edit|preview|view)/.test(location.pathname);
  }

  function isGoogleDocsMobileBasic() {
    return location.hostname === 'docs.google.com'
      && /^\/document\/d\/[^/]+\/mobilebasic/.test(location.pathname);
  }

  function getGoogleDocsMobileBasicUrl() {
    const match = location.pathname.match(/^\/document\/d\/([^/]+)/);
    if (!match) return null;
    return `https://docs.google.com/document/d/${match[1]}/mobilebasic`;
  }

  // ─── translatePage ───────────────────────────────────

  SK.translatePage = async function translatePage() {
    // v1.2.12: YouTube 頁面的 Option+S 翻譯頁面內容（說明、留言等），
    // 字幕翻譯改由 popup toggle 或 autoTranslate 設定控制，與快捷鍵無關。

    if (STATE.translated) {
      restorePage();
      return;
    }

    if (isGoogleDocsEditorPage()) {
      const mobileUrl = getGoogleDocsMobileBasicUrl();
      if (mobileUrl) {
        SK.sendLog('info', 'translate', 'Google Docs detected, redirecting to mobilebasic', { mobileUrl });
        SK.showToast('loading', '偵測到 Google Docs，正在開啟可翻譯的閱讀版⋯');
        browser.runtime.sendMessage({
          type: 'OPEN_GDOC_MOBILE',
          payload: { url: mobileUrl },
        }).catch(() => {});
        return;
      }
    }

    if (STATE.translating) {
      SK.sendLog('info', 'translate', 'aborting in-progress translation');
      STATE.abortController?.abort();
      SK.showToast('loading', '正在取消翻譯⋯');
      return;
    }

    if (!navigator.onLine) {
      SK.showToast('error', '目前處於離線狀態，無法翻譯。請確認網路連線後再試', { autoHideMs: 5000 });
      return;
    }

    // v1.1.9: 合併所有設定讀取為單一 browser.storage.sync.get(null)
    let settings = {};
    try {
      settings = await browser.storage.sync.get(null);
    } catch (_) { /* 讀取失敗用 default */ }

    // 頁面層級繁中偵測
    {
      const skipCheck = settings.skipTraditionalChinesePage === false;
      if (!skipCheck) {
        const contentRoot =
          document.querySelector('article') ||
          document.querySelector('main') ||
          document.querySelector('[role="main"]') ||
          document.body;
        const pageSample = (contentRoot.innerText || '').slice(0, 2000);
        if (pageSample.length > 20 && SK.isTraditionalChinese(pageSample)) {
          SK.showToast('error', '此頁面已是繁體中文，不需翻譯', { autoHideMs: 3000 });
          return;
        }
      }
    }

    STATE.translating = true;
    STATE.abortController = new AbortController();
    const translateStartTime = Date.now();
    const abortSignal = STATE.abortController.signal;

    let units = SK.collectParagraphs();
    if (units.length === 0) {
      SK.showToast('error', '找不到可翻譯的內容', { autoHideMs: 3000 });
      STATE.translating = false;
      STATE.abortController = null;
      return;
    }

    // 超大頁面防護
    let maxTotalUnits = SK.DEFAULT_MAX_TOTAL_UNITS;
    {
      const v = settings.maxTranslateUnits;
      if (Number.isFinite(v) && v >= 0) maxTotalUnits = v;
    }

    let truncatedCount = 0;
    if (maxTotalUnits > 0 && units.length > maxTotalUnits) {
      truncatedCount = units.length - maxTotalUnits;
      SK.sendLog('warn', 'translate', 'page truncated', { total: units.length, limit: maxTotalUnits, skipped: truncatedCount });
      units = units.slice(0, maxTotalUnits);
    }
    const total = units.length;

    // ─── 術語表前置流程 ────────────────────────────
    let glossaryEnabled = true;
    let skipThreshold = SK.GLOSSARY_SKIP_THRESHOLD_DEFAULT;
    let blockingThreshold = SK.GLOSSARY_BLOCKING_THRESHOLD_DEFAULT;
    let glossaryTimeout = SK.GLOSSARY_TIMEOUT_DEFAULT;
    {
      const gc = settings.glossary;
      if (gc) {
        glossaryEnabled = gc.enabled !== false;
        skipThreshold = gc.skipThreshold ?? skipThreshold;
        blockingThreshold = gc.blockingThreshold ?? blockingThreshold;
        glossaryTimeout = gc.timeoutMs ?? glossaryTimeout;
      }
    }

    const preSerialized = units.map(unit => {
      if (unit.kind === 'fragment') return { text: (unit.parent?.innerText || '').trim() };
      return { text: (unit.el?.innerText || '').trim() };
    });
    const preTexts = preSerialized.map(s => s.text);

    // 估算批次數
    let estUnitsPerBatch = SK.DEFAULT_UNITS_PER_BATCH;
    let estCharsPerBatch = SK.DEFAULT_CHARS_PER_BATCH;
    {
      const uv = settings.maxUnitsPerBatch;
      const cv = settings.maxCharsPerBatch;
      if (Number.isFinite(uv) && uv >= 1) estUnitsPerBatch = uv;
      if (Number.isFinite(cv) && cv >= 500) estCharsPerBatch = cv;
    }

    let batchCount = 0;
    {
      let chars = 0, segs = 0;
      for (const t of preTexts) {
        const len = t.length;
        if (len > estCharsPerBatch) { batchCount++; chars = 0; segs = 0; continue; }
        if (chars + len > estCharsPerBatch || segs >= estUnitsPerBatch) {
          batchCount++; chars = 0; segs = 0;
        }
        chars += len; segs++;
      }
      if (segs > 0) batchCount++;
    }

    let glossary = null;

    if (glossaryEnabled && batchCount > skipThreshold) {
      const compressedText = SK.extractGlossaryInput(units);
      const inputHash = await SK.sha1(compressedText);
      SK.sendLog('info', 'glossary', 'glossary preprocessing', { batchCount, mode: batchCount > blockingThreshold ? 'blocking' : 'fire-and-forget', compressedChars: compressedText.length, hash: inputHash.slice(0, 8) });

      if (batchCount > blockingThreshold) {
        SK.showToast('loading', '建立術語表⋯', { progress: 0, startTimer: true });
        try {
          const glossaryResult = await Promise.race([
            browser.runtime.sendMessage({
              type: 'EXTRACT_GLOSSARY',
              payload: { compressedText, inputHash },
            }),
            new Promise((_, reject) =>
              setTimeout(() => reject(new Error('術語表逾時')), glossaryTimeout)
            ),
          ]);
          if (glossaryResult?.ok && glossaryResult.glossary?.length > 0) {
            glossary = glossaryResult.glossary;
            SK.sendLog('info', 'glossary', 'glossary ready', { terms: glossary.length, fromCache: !!glossaryResult.fromCache });
          } else if (glossaryResult?.ok) {
            SK.sendLog('warn', 'glossary', 'glossary returned empty', { fromCache: glossaryResult.fromCache, diag: glossaryResult._diag, inputTokens: glossaryResult.usage?.inputTokens || 0, outputTokens: glossaryResult.usage?.outputTokens || 0 });
          } else {
            SK.sendLog('warn', 'glossary', 'glossary returned not ok', { error: glossaryResult?.error, diag: glossaryResult?._diag });
          }
        } catch (err) {
          SK.sendLog('warn', 'glossary', 'glossary failed/timeout, proceeding without', { error: err.message });
        }
      } else {
        const glossaryPromise = browser.runtime.sendMessage({
          type: 'EXTRACT_GLOSSARY',
          payload: { compressedText, inputHash },
        }).then(res => {
          if (res?.ok && res.glossary?.length > 0) {
            SK.sendLog('info', 'glossary', 'glossary arrived (async)', { terms: res.glossary.length });
            return res.glossary;
          }
          return null;
        }).catch(err => {
          SK.sendLog('warn', 'glossary', 'glossary async failed', { error: err.message });
          return null;
        });
        STATE._glossaryPromise = glossaryPromise;
      }
    }

    SK.showToast('loading', `翻譯中… 0 / ${total}`, {
      progress: 0,
      startTimer: true,
    });

    try {
      if (!glossary && STATE._glossaryPromise) {
        try {
          glossary = await Promise.race([
            STATE._glossaryPromise,
            new Promise(resolve => setTimeout(() => resolve(null), 2000)),
          ]);
        } catch (_) { /* ignore */ }
        STATE._glossaryPromise = null;
      }

      const { done, failures, pageUsage, rpdWarning } = await SK.translateUnits(units, {
        glossary,
        signal: abortSignal,
        onProgress: (d, t, mismatch) => SK.showToast('loading', `翻譯中… ${d} / ${t}`, {
          progress: d / t,
          mismatch: !!mismatch,
        }),
      });

      if (abortSignal.aborted) {
        SK.sendLog('info', 'translate', 'translation aborted', { done, total });
        if (STATE.originalHTML.size > 0) {
          STATE.originalHTML.forEach((originalHTML, el) => {
            el.innerHTML = originalHTML;
            el.removeAttribute('data-shinkansen-translated');
          });
          STATE.originalHTML.clear();
        }
        STATE.translated = false;
        SK.showToast('success', '已取消翻譯', { progress: 1, stopTimer: true, autoHideMs: 2000 });
        return;
      }

      if (failures.length) {
        const failedSegs = failures.reduce((s, f) => s + f.count, 0);
        const firstErr = failures[0].error;
        SK.showToast('error', `翻譯部分失敗:${failedSegs} / ${total} 段失敗`, {
          stopTimer: true,
          detail: firstErr.slice(0, 120),
        });
      }

      STATE.translated = true;
      STATE.translatedBy = 'gemini';  // v1.4.0
      STATE.stickyTranslate = true;
      browser.runtime.sendMessage({ type: 'SET_BADGE_TRANSLATED' }).catch(() => {});
      // v1.4.11: 跨 tab sticky——此 tab 進入 sticky set，opener 鏈中新開的 tab 會繼承
      browser.runtime.sendMessage({ type: 'STICKY_SET', payload: { engine: 'gemini' } }).catch(() => {});

      if (!failures.length) {
        const totalTokens = pageUsage.inputTokens + pageUsage.outputTokens;
        const successMsg = truncatedCount > 0
          ? `翻譯完成 （${total} 段，另有 ${truncatedCount} 段因頁面過長被略過）`
          : `翻譯完成 （${total} 段）`;
        let detail;
        if (totalTokens > 0) {
          const billedTotalTokens = pageUsage.billedInputTokens + pageUsage.outputTokens;
          let line1 = `${SK.formatTokens(billedTotalTokens)} tokens`;
          let line2 = SK.formatUSD(pageUsage.billedCostUSD);
          if (pageUsage.cachedTokens > 0 && pageUsage.inputTokens > 0) {
            const hitPct = (pageUsage.cachedTokens / pageUsage.inputTokens) * 100;
            const savedPct = pageUsage.costUSD > 0
              ? ((pageUsage.costUSD - pageUsage.billedCostUSD) / pageUsage.costUSD) * 100
              : 0;
            line1 += ` (${hitPct.toFixed(0)}% hit)`;
            line2 += ` (${savedPct.toFixed(0)}% saved)`;
          }
          detail = `${line1}\n${line2}`;
        } else if (pageUsage.cacheHits === total) {
          detail = '全部快取命中 · 本次未計費';
        }
        SK.sendLog('info', 'translate', 'page translation usage', {
          segments: total,
          inputTokens: pageUsage.inputTokens,
          cachedTokens: pageUsage.cachedTokens,
          outputTokens: pageUsage.outputTokens,
          billedInputTokens: pageUsage.billedInputTokens,
          billedTotalTokens: pageUsage.billedInputTokens + pageUsage.outputTokens,
          implicitCacheHitRate: pageUsage.inputTokens > 0
            ? `${((pageUsage.cachedTokens / pageUsage.inputTokens) * 100).toFixed(1)}%`
            : 'n/a',
          billedCostUSD: pageUsage.billedCostUSD,
          localCacheHitSegments: pageUsage.cacheHits,
          url: location.href,
        });
        SK.showToast('success', successMsg, {
          progress: 1,
          stopTimer: true,
          detail,
        });
      }

      // 記錄用量到 IndexedDB
      if (done > 0) {
        browser.runtime.sendMessage({
          type: 'LOG_USAGE',
          payload: {
            url: location.href,
            title: document.title,
            inputTokens: pageUsage.inputTokens,
            outputTokens: pageUsage.outputTokens,
            cachedTokens: pageUsage.cachedTokens,
            billedInputTokens: pageUsage.billedInputTokens,
            billedCostUSD: pageUsage.billedCostUSD,
            segments: total,
            cacheHits: pageUsage.cacheHits,
            durationMs: Date.now() - translateStartTime,
            timestamp: Date.now(),
          },
        }).catch(() => {});
      }

      if (rpdWarning) {
        setTimeout(() => {
          SK.showToast('error', '提醒：今日 API 請求次數已超過預算上限', {
            detail: '翻譯仍可正常使用，但請留意用量。每日計數於太平洋時間午夜重置（約台灣時間下午 3 點）',
            autoHideMs: 6000,
          });
        }, 1500);
      }

      scheduleRescanForLateContent();
      SK.startSpaObserver();
    } catch (err) {
      SK.sendLog('error', 'translate', 'translatePage error', { error: err.message || String(err) });
      if (!abortSignal.aborted) {
        SK.showToast('error', `翻譯失敗:${err.message}`, { stopTimer: true });
      }
    } finally {
      STATE.translating = false;
      STATE.abortController = null;
    }
  };

  // ─── restorePage ─────────────────────────────────────

  function restorePage() {
    if (editModeActive) toggleEditMode(false);
    SK.cancelRescan();
    SK.stopSpaObserver();
    STATE.originalHTML.forEach((originalHTML, el) => {
      el.innerHTML = originalHTML;
      el.removeAttribute('data-shinkansen-translated');
    });
    STATE.originalHTML.clear();
    STATE.translatedHTML.clear();
    STATE.translated = false;
    STATE.translatedBy = null;  // v1.4.0
    STATE.stickyTranslate = false;
    browser.runtime.sendMessage({ type: 'CLEAR_BADGE' }).catch(() => {});
    // v1.4.11: 清除跨 tab sticky（只影響當前 tab，不影響樹中其他 tab）
    browser.runtime.sendMessage({ type: 'STICKY_CLEAR' }).catch(() => {});
    SK.showToast('success', '已還原原文', { progress: 1, autoHideMs: 2000 });
  }

  // ─── v1.4.0: Google Translate 批次送出 ──────────────────────
  // 與 SK.translateUnits 相同架構，但送 TRANSLATE_BATCH_GOOGLE 訊息，
  // 不走術語表（Google MT 無 LLM 語意支援），回傳含 chars 的用量資訊。
  //
  // v1.4.2 格式保留：使用 serializeForGoogleTranslate 專用序列化，只標記
  // <a> 連結（【N】/【/N】）與 atomic 元素（【*N】），其餘 span/b/i/abbr 直接取文字。
  // 相比 v1.4.1 的 serializeWithPlaceholders+⟦→【 轉換，本版大幅減少標記數量
  // （通常 2-4 個，而非 10+），Google MT 不再被過多標記搞亂位置。
  SK.translateUnitsGoogle = async function translateUnitsGoogle(units, { onProgress, signal } = {}) {
    const total = units.length;

    // ── 序列化：只標 <a> 連結與 atomic 元素（footnote sup 等），其餘取純文字 ──
    // 使用 Google Translate 專用序列化（【N】標記），避免 Gemini 路徑的 ⟦N⟧ 標記
    // 在 Google MT 下位置錯亂（⟦⟧ 是數學符號；【】是 CJK 標點，Google MT 原樣保留）。
    const serialized = units.map(unit => {
      if (unit.kind === 'fragment') {
        return SK.serializeFragmentForGoogleTranslate(unit);
      }
      return SK.serializeForGoogleTranslate(unit.el);
    });

    const texts = serialized.map(s => s.text);
    const slotsList = serialized.map(s => s.slots);

    let done = 0;
    let totalChars = 0;
    const failures = [];

    const jobs = packBatches(texts, units, slotsList, 20, 4000);
    const t0All = Date.now();
    SK.sendLog('info', 'translate', 'translateUnitsGoogle start', { batches: jobs.length, total });

    await runWithConcurrency(jobs, 5, async (job) => {
      if (signal?.aborted) return;
      const batchIdx = jobs.indexOf(job);
      try {
        const response = await Promise.race([
          browser.runtime.sendMessage({
            type: 'TRANSLATE_BATCH_GOOGLE',
            payload: { texts: job.texts },
          }),
          new Promise((_, reject) =>
            setTimeout(() => reject(new Error('批次逾時（90s）')), BATCH_TIMEOUT_MS)
          ),
        ]);
        if (!response?.ok) throw new Error(response?.error || '未知錯誤');
        totalChars += response.usage?.chars || 0;
        const translations = response.result;
        translations.forEach((tr, j) => {
          const unit = job.units[j];
          if (!tr) return;
          const slots = job.slots[j];
          // 【N】/【/N】/【*N】 換回 ⟦N⟧/⟦/N⟧/⟦*N⟧，走現有 deserializeWithPlaceholders
          const restored = slots?.length
            ? SK.restoreGoogleTranslateMarkers(tr)
            : tr;
          SK.injectTranslation(unit, restored, slots || []);
        });
        done += job.texts.length;
        if (onProgress) onProgress(done, total);
      } catch (err) {
        SK.sendLog('error', 'translate', `google batch ${batchIdx + 1} FAILED`, { error: err.message });
        failures.push({ start: job.start, count: job.texts.length, error: err.message });
      }
    });

    SK.sendLog('info', 'translate', 'translateUnitsGoogle complete', {
      elapsed: Date.now() - t0All, done, total, failures: failures.length, chars: totalChars,
    });

    return { done, total, failures, chars: totalChars };
  };

  // ─── v1.4.0: Google Translate 翻譯整頁 ──────────────────────
  SK.translatePageGoogle = async function translatePageGoogle() {
    // 若同一引擎已翻譯 → 還原（toggle）
    if (STATE.translated && STATE.translatedBy === 'google') {
      restorePage();
      return;
    }

    // 若正在翻譯中（任何引擎）→ 中止
    if (STATE.translating) {
      STATE.abortController?.abort();
      SK.showToast('loading', '正在取消翻譯⋯');
      return;
    }

    // 若 Gemini 翻譯已完成 → 先還原，再用 Google 翻
    if (STATE.translated) {
      restorePage();
    }

    if (!navigator.onLine) {
      SK.showToast('error', '目前處於離線狀態，無法翻譯。請確認網路連線後再試', { autoHideMs: 5000 });
      return;
    }

    // 繁中偵測（與 Gemini 相同邏輯）
    let settings = {};
    try { settings = await browser.storage.sync.get(null); } catch (_) {}
    {
      const skipCheck = settings.skipTraditionalChinesePage === false;
      if (!skipCheck) {
        const contentRoot =
          document.querySelector('article') ||
          document.querySelector('main') ||
          document.querySelector('[role="main"]') ||
          document.body;
        const pageSample = (contentRoot.innerText || '').slice(0, 2000);
        if (pageSample.length > 20 && SK.isTraditionalChinese(pageSample)) {
          SK.showToast('error', '此頁面已是繁體中文，不需翻譯', { autoHideMs: 3000 });
          return;
        }
      }
    }

    STATE.translating = true;
    STATE.abortController = new AbortController();
    const translateStartTime = Date.now();
    const abortSignal = STATE.abortController.signal;

    let units = SK.collectParagraphs();
    if (units.length === 0) {
      SK.showToast('error', '找不到可翻譯的內容', { autoHideMs: 3000 });
      STATE.translating = false;
      STATE.abortController = null;
      return;
    }

    // 超大頁面防護（沿用相同上限設定）
    let maxTotalUnits = SK.DEFAULT_MAX_TOTAL_UNITS;
    const v = settings.maxTranslateUnits;
    if (Number.isFinite(v) && v >= 0) maxTotalUnits = v;
    let truncatedCount = 0;
    if (maxTotalUnits > 0 && units.length > maxTotalUnits) {
      truncatedCount = units.length - maxTotalUnits;
      units = units.slice(0, maxTotalUnits);
    }
    const total = units.length;

    SK.showToast('loading', `Google 翻譯中… 0 / ${total}`, { progress: 0, startTimer: true });

    try {
      const { done, failures, chars } = await SK.translateUnitsGoogle(units, {
        signal: abortSignal,
        onProgress: (d, t) => SK.showToast('loading', `Google 翻譯中… ${d} / ${t}`, {
          progress: d / t,
        }),
      });

      if (abortSignal.aborted) {
        if (STATE.originalHTML.size > 0) {
          STATE.originalHTML.forEach((originalHTML, el) => {
            el.innerHTML = originalHTML;
            el.removeAttribute('data-shinkansen-translated');
          });
          STATE.originalHTML.clear();
        }
        STATE.translated = false;
        SK.showToast('success', '已取消翻譯', { progress: 1, stopTimer: true, autoHideMs: 2000 });
        return;
      }

      if (failures.length) {
        const failedSegs = failures.reduce((s, f) => s + f.count, 0);
        SK.showToast('error', `翻譯部分失敗：${failedSegs} / ${total} 段失敗`, {
          stopTimer: true,
          detail: failures[0].error.slice(0, 120),
        });
      }

      STATE.translated = true;
      STATE.translatedBy = 'google';  // v1.4.0
      STATE.stickyTranslate = true;
      browser.runtime.sendMessage({ type: 'SET_BADGE_TRANSLATED' }).catch(() => {});
      // v1.4.11: 跨 tab sticky——此 tab 進入 sticky set（Google engine）
      browser.runtime.sendMessage({ type: 'STICKY_SET', payload: { engine: 'google' } }).catch(() => {});

      if (!failures.length) {
        const successMsg = truncatedCount > 0
          ? `Google 翻譯完成（${total} 段，另有 ${truncatedCount} 段因頁面過長被略過）`
          : `Google 翻譯完成（${total} 段）`;
        SK.showToast('success', successMsg, {
          progress: 1,
          stopTimer: true,
          detail: `${chars.toLocaleString()} 字元 · 免費`,
        });
      }

      // 記錄用量（engine 欄位由 background 的 handleTranslateGoogle 寫入）
      SK.sendLog('info', 'translate', 'google page translation done', {
        segments: total, chars, elapsed: Date.now() - translateStartTime, url: location.href,
      });

      scheduleRescanForLateContent();
      SK.startSpaObserver();
    } catch (err) {
      SK.sendLog('error', 'translate', 'translatePageGoogle error', { error: err.message || String(err) });
      if (!abortSignal.aborted) {
        SK.showToast('error', `翻譯失敗：${err.message}`, { stopTimer: true });
      }
    } finally {
      STATE.translating = false;
      STATE.abortController = null;
    }
  };

  // ─── 編輯譯文模式 ────────────────────────────────────

  let editModeActive = false;

  function toggleEditMode(forceState) {
    if (!STATE.translated && forceState !== false) {
      return { ok: false, error: 'translation not complete' };
    }
    const enable = typeof forceState === 'boolean' ? forceState : !editModeActive;
    const els = document.querySelectorAll('[data-shinkansen-translated]');
    if (els.length === 0) return { ok: false, error: 'no translated elements' };

    for (const el of els) {
      if (enable) {
        el.setAttribute('contenteditable', 'true');
        el.classList.add('shinkansen-editable');
      } else {
        el.removeAttribute('contenteditable');
        el.classList.remove('shinkansen-editable');
      }
    }
    editModeActive = enable;
    SK.sendLog('info', 'system', enable ? 'edit mode ON' : 'edit mode OFF', { elements: els.length });
    return { ok: true, editing: editModeActive, elements: els.length };
  }

  // ─── 訊息接收 ────────────────────────────────────────

  browser.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (msg?.type === 'TOGGLE_TRANSLATE') {
      SK.translatePage();
      return;
    }
    if (msg?.type === 'TOGGLE_EDIT_MODE') {
      sendResponse(toggleEditMode());
      return true;
    }
    if (msg?.type === 'GET_STATE') {
      sendResponse({ ok: true, translated: STATE.translated, editing: editModeActive });
      return true;
    }
    // v1.2.12: YouTube 字幕翻譯開關（popup toggle 用）
    if (msg?.type === 'GET_SUBTITLE_STATE') {
      sendResponse({ ok: true, active: SK.YT?.active ?? false });
      return true;
    }
    // v1.4.0: Google Translate 快捷鍵（Opt+G）
    if (msg?.type === 'TOGGLE_TRANSLATE_GOOGLE') {
      SK.translatePageGoogle();
      return;
    }
    if (msg?.type === 'TOGGLE_SUBTITLE') {
      if (SK.translateYouTubeSubtitles) {
        SK.translateYouTubeSubtitles().catch(err => {
          SK.sendLog('warn', 'system', 'TOGGLE_SUBTITLE failed', { error: err.message });
        });
      }
      return;
    }
  });

  window.__shinkansen_translate = SK.translatePage;

  // ─── Debug API ────────────────────────────────────────

  function buildSelectorPath(el) {
    const parts = [];
    let cur = el;
    while (cur && cur !== document.body && parts.length < 6) {
      let s = cur.tagName.toLowerCase();
      if (cur.id) {
        s += '#' + cur.id;
        parts.unshift(s);
        break;
      }
      if (cur.className && typeof cur.className === 'string') {
        const cls = cur.className.trim().split(/\s+/).slice(0, 2).join('.');
        if (cls) s += '.' + cls;
      }
      parts.unshift(s);
      cur = cur.parentElement;
    }
    return parts.join(' > ');
  }

  function unitSummary(unit, i) {
    if (unit.kind === 'fragment') {
      let text = '';
      let n = unit.startNode;
      while (n) {
        text += n.textContent || '';
        if (n === unit.endNode) break;
        n = n.nextSibling;
      }
      const trimmed = text.trim();
      return {
        index: i,
        kind: 'fragment',
        tag: unit.el.tagName,
        id: unit.el.id || null,
        textLength: trimmed.length,
        textPreview: trimmed.slice(0, 200),
        hasMedia: false,
        selectorPath: buildSelectorPath(unit.el),
      };
    }
    const el = unit.el;
    return {
      index: i,
      kind: 'element',
      tag: el.tagName,
      id: el.id || null,
      textLength: (el.innerText || '').trim().length,
      textPreview: (el.innerText || '').trim().slice(0, 200),
      hasMedia: SK.containsMedia(el),
      selectorPath: buildSelectorPath(el),
    };
  }

  window.__shinkansen = {
    get version() { return browser.runtime.getManifest().version; },
    collectParagraphs() {
      return SK.collectParagraphs().map(unitSummary);
    },
    collectParagraphsWithStats() {
      const stats = {};
      const units = SK.collectParagraphs(document.body, stats);
      return {
        units: units.map(unitSummary),
        skipStats: stats,
      };
    },
    serialize(el) { return SK.serializeWithPlaceholders(el); },
    deserialize(text, slots) { return SK.deserializeWithPlaceholders(text, slots); },
    testInject(el, translation) {
      if (!el || el.nodeType !== Node.ELEMENT_NODE) {
        throw new Error('testInject: el must be an Element');
      }
      const { text, slots } = SK.serializeWithPlaceholders(el);
      const unit = { kind: 'element', el };
      SK.injectTranslation(unit, translation, slots);
      return { sourceText: text, slotCount: slots.length };
    },
    selectBestSlotOccurrences(text) {
      return SK.selectBestSlotOccurrences(text);
    },
    getState() {
      return {
        translated: STATE.translated,
        translating: STATE.translating,
        stickyTranslate: STATE.stickyTranslate,
        replacedCount: STATE.originalHTML.size,
        cacheSize: STATE.cache.size,
        guardCacheSize: STATE.translatedHTML.size,
      };
    },
    setTestState(overrides) {
      if ('translated' in overrides) STATE.translated = !!overrides.translated;
      if ('stickyTranslate' in overrides) STATE.stickyTranslate = !!overrides.stickyTranslate;
    },
    testRunContentGuard() {
      return SK.testRunContentGuard();
    },
    testGoogleDocsUrl(urlString) {
      try {
        const url = new URL(urlString);
        const isEditor = url.hostname === 'docs.google.com'
          && /^\/document\/d\/[^/]+\/(edit|preview|view)/.test(url.pathname);
        const isMobileBasic = url.hostname === 'docs.google.com'
          && /^\/document\/d\/[^/]+\/mobilebasic/.test(url.pathname);
        const match = url.pathname.match(/^\/document\/d\/([^/]+)/);
        const mobileBasicUrl = match
          ? `https://docs.google.com/document/d/${match[1]}/mobilebasic`
          : null;
        return { isEditor, isMobileBasic, mobileBasicUrl };
      } catch { return { isEditor: false, isMobileBasic: false, mobileBasicUrl: null }; }
    },
  };

  // ─── 初始化 ──────────────────────────────────────────

  browser.runtime.sendMessage({ type: 'CLEAR_BADGE' }).catch(() => {});

  SK.sendLog('info', 'system', 'content script ready', { version: browser.runtime.getManifest().version, url: location.href });

  // 首次載入時的自動翻譯
  (async () => {
    try {
      // v1.2.11: YouTube 字幕自動翻譯（優先於一般 auto-translate）
      if (SK.isYouTubePage?.()) {
        const saved = await browser.storage.sync.get('ytSubtitle');
        if (saved.ytSubtitle?.autoTranslate) {
          SK.sendLog('info', 'system', 'YouTube auto-subtitle enabled, activating on load');
          // 稍微延遲，等 content script 完成初始化、XHR 攔截器就位
          setTimeout(() => {
            SK.translateYouTubeSubtitles?.().catch(err => {
              SK.sendLog('warn', 'system', 'YouTube auto-subtitle failed', { error: err.message });
            });
          }, 800);
        }
        return; // YouTube 頁面不走一般 auto-translate
      }

      // v1.4.11: 跨 tab sticky——若本 tab 從已翻譯的 opener tab 繼承，自動翻譯
      const stickyResp = await browser.runtime.sendMessage({ type: 'STICKY_QUERY' }).catch(() => null);
      if (stickyResp?.shouldTranslate) {
        const engine = stickyResp.engine === 'google' ? 'google' : 'gemini';
        SK.sendLog('info', 'system', 'sticky translate inherited from opener tab, translating on load', { engine, url: location.href });
        if (engine === 'google') {
          SK.translatePageGoogle?.();
        } else {
          SK.translatePage();
        }
        return;
      }

      const { autoTranslate = false } = await browser.storage.sync.get('autoTranslate');
      if (!autoTranslate) return;
      if (await SK.isDomainWhitelisted()) {
        SK.sendLog('info', 'system', 'domain in auto-translate list, translating on load', { url: location.href });
        SK.translatePage();
      }
    } catch (err) {
      SK.sendLog('warn', 'system', 'auto-translate check failed on load', { error: err.message });
    }
  })();

})(window.__SK);
