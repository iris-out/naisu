/**
 * 워터마크 커스텀 폰트 로딩.
 *
 * 팝업(미리보기)과 service worker(실제 렌더링) 두 컨텍스트가 이 파일을 함께 쓴다 —
 * 둘 다 DOM 없이 fetch + FontFace API만으로 동작하는 로직이라 공유할 수 있다.
 * host_permissions을 넓히지 않는다: 확장 페이지(팝업/SW)의 fetch는 대상 서버가 CORS를
 * 허용하면 그대로 통과한다(Google Fonts는 원래 웹페이지에서도 크로스 오리진으로 쓰라고
 * 만든 서비스라 permissive) — 임의 웹폰트 링크는 그 서버가 CORS를 안 열어 두면 실패할 수
 * 있고, 그건 정상적인 실패로 보고 사용자에게 알려준다.
 */

/** Google Fonts CSS 링크에서 실제 폰트 파일(.woff2 등) URL을 뽑아낸다. */
async function extractGoogleFontsFileUrl(cssUrl: string): Promise<string> {
  const res = await fetch(cssUrl);
  if (!res.ok) throw new Error(`Google Fonts CSS를 불러오지 못했습니다 (${res.status})`);
  const css = await res.text();
  const match = css.match(/url\((https:\/\/fonts\.gstatic\.com\/[^)]+)\)/);
  if (!match) throw new Error('Google Fonts CSS에서 폰트 파일 주소를 찾지 못했습니다');
  return match[1];
}

/** 사용자가 붙여넣은 링크를 실제 폰트 파일 URL로 정리한다. */
export async function resolveFontFileUrl(input: string): Promise<string> {
  const url = input.trim();
  if (!url) throw new Error('폰트 링크가 비어 있습니다');
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error('올바른 URL이 아닙니다');
  }
  if (parsed.hostname === 'fonts.googleapis.com') return extractGoogleFontsFileUrl(url);
  return url;
}

/**
 * 폰트를 fetch해서 FontFace로 등록한다. `fontsSet`은 호출부의 FontFaceSet
 * (팝업은 `document.fonts`, service worker는 `self.fonts`)을 그대로 넘겨받는다 —
 * 이 파일은 어느 쪽 컨텍스트인지 몰라도 되게 하기 위함.
 */
export async function loadWatermarkFont(
  fontUrl: string,
  familyName: string,
  fontsSet: FontFaceSet,
): Promise<void> {
  const fileUrl = await resolveFontFileUrl(fontUrl);
  const face = new FontFace(familyName, `url(${fileUrl})`);
  await face.load();
  fontsSet.add(face);
}
