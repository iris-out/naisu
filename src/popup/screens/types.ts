/**
 * 팝업 화면 하나의 계약.
 *
 * 화면마다 파일이 하나씩 대응하도록 쪼갠 이유는, 서로 다른 작업이 같은 파일을
 * 동시에 고치지 않게 하기 위함이다. 새 화면을 추가할 때는 이 인터페이스를 구현하고
 * popup.ts의 SCREENS 배열에 등록하기만 하면 된다.
 */
export interface Screen {
  /** 라우팅 이름 = data-screen 속성값 = data-nav 값 */
  name: string;
  /** 이 화면의 마크업. 최상위는 반드시 <section class="screen" data-screen="{name}"> */
  render(): string;
  /** 최초 1회 — 이벤트 바인딩과 저장값 주입 */
  mount?(): void | Promise<void>;
  /** 이 화면으로 진입할 때마다 — 표시값 새로고침 */
  enter?(): void | Promise<void>;
}
