/**
 * 저장 후처리 화면 — 워터마크·크레딧.
 *
 * 다운로드 화면(storage.ts)이 "무엇을 지울지"(저장 방식·품질·포맷)를 다룬다면 여기는
 * 파일에 뭘 더 얹을지(워터마크·크레딧)를 다룬다.
 *
 * ⚠ 여기 설정은 **원본(raw) 모드에는 적용되지 않는다.** "원본"이 원본이 아니게 되면
 *   그 모드의 존재 이유가 사라지기 때문 — 규칙 자체는 service-worker.ts가 강제한다.
 */

import { getSettings, setSettings, type ImageOps, type Settings } from '../../lib/storage';
import { opsSummary } from '../../lib/image-ops';
import { loadWatermarkFont } from '../../lib/webfont';
import { must } from '../ui/dom';
import { bindInput } from '../ui/input';
import { bindSeg } from '../ui/seg';
import { bindSwitch } from '../ui/switch';
import { helpLine } from '../ui/field-ui';
import { flashHint } from '../ui/status';
import type { Screen } from './types';

/** 현재 ops를 한 줄 요약으로 — 화면 상단과 홈 메뉴 배지가 같은 문장을 쓴다. */
export function describeImageOps(s: Settings): string {
  return opsSummary(s.imageOps) || '후처리 없음';
}

async function patchOps(patch: Partial<ImageOps>): Promise<ImageOps> {
  const s = await getSettings();
  const next: ImageOps = { ...s.imageOps, ...patch };
  await setSettings({ imageOps: next });
  flashHint('저장됨');
  return next;
}

export const outputScreen: Screen = {
  name: 'output',

  render: () => `
    <section class="screen" data-screen="output" hidden>
      <header class="hd sub">
        <button class="back" data-nav="home">←</button>
        <h2>저장 후처리</h2>
      </header>

      <div id="ops-summary" class="preview-line" style="margin:0 0 10px"></div>

      <div class="card">
        <label class="row sw-row">
          <span><span class="row-ttl">워터마크</span></span>
          <span class="switch" id="wm-sw"></span>
        </label>
        <div id="wm-fields" hidden>
          <label class="full"><span class="lbl">문구</span><input id="wm-text" type="text" placeholder="@handle"></label>
          <div class="lbl" style="margin-top:8px">위치</div>
          <div class="seg" id="wm-pos" role="radiogroup" style="--seg-n:4">
            <span class="seg-indicator"></span>
            <button data-v="tl">좌상</button>
            <button data-v="tr">우상</button>
            <button data-v="bl">좌하</button>
            <button data-v="br">우하</button>
          </div>
          <label class="full" style="margin-top:8px">
            <span class="lbl">크기 (짧은 변 대비 %)</span>
            <input id="wm-scale" type="number" min="1" max="20" step="1">
          </label>
          <label class="full" style="margin-top:8px">
            <span class="lbl">투명도 (0 ~ 1)</span>
            <input id="wm-opacity" type="number" min="0.1" max="1" step="0.05">
          </label>
          <label class="full" style="margin-top:8px">
            <span class="lbl">글자 색</span>
            <input id="wm-color" type="color">
          </label>
          <label class="full" style="margin-top:8px">
            <span class="lbl">폰트</span>
            <input id="wm-font-url" type="text" placeholder="비워두면 기본 폰트 · Google Fonts 링크 또는 .woff2 링크">
          </label>
          <div id="wm-font-help"></div>
          <div class="wm-preview" id="wm-preview" data-pos="br">
            <span id="wm-preview-text">@handle</span>
          </div>
        </div>
      </div>

      <div class="card">
        <label class="row sw-row">
          <span><span class="row-ttl">메타데이터에 설명 추가하기</span></span>
          <span class="switch" id="credit-sw"></span>
        </label>
        <div id="credit-help"></div>
        <label class="full" id="credit-text-wrap" hidden>
          <span class="lbl">남길 한 줄</span>
          <input id="credit-text" type="text" placeholder="art by @handle">
        </label>
      </div>
    </section>
  `,

  async mount() {
    const s = await getSettings();
    let ops = s.imageOps;

    const summary = must('#ops-summary');
    const refreshSummary = (): void => {
      summary.textContent = `→ ${opsSummary(ops) || '후처리 없음'}`;
    };

    // ---- 워터마크 ----
    const wmFields = must('#wm-fields');
    const syncWm = (): void => {
      wmFields.hidden = !ops.watermark.on;
    };

    const wmPreview = must('#wm-preview');
    const wmPreviewText = must('#wm-preview-text');
    const wmFontHelp = must('#wm-font-help');
    let previewFontFamily = '';
    const updatePreview = (): void => {
      const wm = ops.watermark;
      wmPreviewText.textContent = wm.text.trim() || '@handle';
      wmPreview.dataset.pos = wm.position;
      wmPreviewText.style.color = wm.color || '#ffffff';
      wmPreviewText.style.opacity = String(Math.min(1, Math.max(0, wm.opacity)));
      wmPreviewText.style.fontFamily = previewFontFamily || 'inherit';
      // scalePct는 "이미지 짧은 변 대비 %" — 미리보기 박스 너비를 그 짧은 변으로 삼아 흉내낸다.
      const boxWidth = wmPreview.clientWidth || 220;
      wmPreviewText.style.fontSize = `${Math.max(8, Math.round((boxWidth * wm.scalePct) / 100))}px`;
    };

    let fontLoadSeq = 0;
    const loadPreviewFont = async (url: string): Promise<void> => {
      const seq = ++fontLoadSeq; // 빠르게 여러 번 입력하면 마지막 시도만 반영
      if (!url.trim()) {
        previewFontFamily = '';
        wmFontHelp.innerHTML = helpLine('기본 폰트를 씁니다.');
        updatePreview();
        return;
      }
      wmFontHelp.innerHTML = helpLine('폰트를 불러오는 중…');
      try {
        const familyName = `naisu-wm-preview-${seq}`;
        await loadWatermarkFont(url, familyName, document.fonts);
        if (seq !== fontLoadSeq) return; // 그 사이 다른 링크로 바뀌었으면 버린다
        previewFontFamily = familyName;
        wmFontHelp.innerHTML = helpLine('폰트를 불러왔습니다. 실제 저장 시에도 이 폰트로 그립니다.');
      } catch (e) {
        if (seq !== fontLoadSeq) return;
        previewFontFamily = '';
        const why = e instanceof Error ? e.message : String(e);
        wmFontHelp.innerHTML = helpLine(
          `폰트를 불러오지 못했습니다 — ${why}. 저장 시에는 기본 폰트로 대체됩니다.`,
        );
      }
      updatePreview();
    };

    bindSwitch(must('#wm-sw'), ops.watermark.on, async (v) => {
      ops = await patchOps({ watermark: { ...ops.watermark, on: v } });
      syncWm();
      refreshSummary();
    });
    bindInput('#wm-text', ops.watermark.text, async (v) => {
      ops = await patchOps({ watermark: { ...ops.watermark, text: v } });
      refreshSummary();
      updatePreview();
    });
    bindSeg(must('#wm-pos'), ops.watermark.position, async (v) => {
      ops = await patchOps({ watermark: { ...ops.watermark, position: v as ImageOps['watermark']['position'] } });
      updatePreview();
    });
    bindInput('#wm-scale', String(ops.watermark.scalePct), async (v) => {
      const n = Number(v);
      if (!Number.isFinite(n) || n <= 0) return;
      ops = await patchOps({ watermark: { ...ops.watermark, scalePct: n } });
      updatePreview();
    });
    bindInput('#wm-opacity', String(ops.watermark.opacity), async (v) => {
      const n = Number(v);
      if (!Number.isFinite(n) || n <= 0 || n > 1) return;
      ops = await patchOps({ watermark: { ...ops.watermark, opacity: n } });
      updatePreview();
    });
    bindInput('#wm-color', ops.watermark.color, async (v) => {
      ops = await patchOps({ watermark: { ...ops.watermark, color: v || '#ffffff' } });
      updatePreview();
    });
    bindInput('#wm-font-url', ops.watermark.fontUrl, async (v) => {
      ops = await patchOps({ watermark: { ...ops.watermark, fontUrl: v } });
      void loadPreviewFont(v);
    });
    syncWm();
    void loadPreviewFont(ops.watermark.fontUrl);

    // ---- 크레딧 ----
    const creditWrap = must('#credit-text-wrap');
    must('#credit-help').innerHTML = helpLine(
      '프롬프트·시드 같은 원래 정보는 그대로 지워지고, 여기 적은 한 줄만 파일에 새로 남습니다.',
    );
    const syncCredit = (): void => {
      creditWrap.hidden = !ops.credit.on;
    };
    bindSwitch(must('#credit-sw'), ops.credit.on, async (v) => {
      ops = await patchOps({ credit: { ...ops.credit, on: v } });
      syncCredit();
      refreshSummary();
    });
    bindInput('#credit-text', ops.credit.text, async (v) => {
      ops = await patchOps({ credit: { ...ops.credit, text: v } });
      refreshSummary();
    });
    syncCredit();

    refreshSummary();
  },

  /**
   * 품질·출력 포맷은 다운로드 화면(storage.ts)에서 바꾼다 — 거기서 바꾸고 돌아왔을 때
   * 요약이 옛 값으로 남아 있지 않게 화면을 다시 그린다.
   */
  async enter() {
    const s = await getSettings();
    must('#ops-summary').textContent = `→ ${opsSummary(s.imageOps) || '후처리 없음'}`;
  },
};
