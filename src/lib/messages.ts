/**
 * 세 컨텍스트(content / background / popup)가 주고받는 메시지의 단일 정의처.
 *
 * 이전에는 각 파일이 같은 모양의 인터페이스를 따로 선언하고 있어서(runner.ts의
 * StripStatus, service-worker.ts의 StripStatusReport 등) 한쪽만 고치면 조용히
 * 어긋났다. 앞으로 새 메시지를 추가할 때는 반드시 아래 MessageMap에 먼저 등록할 것.
 */

import type { DownloadMode } from './storage';

// ---------------------------------------------------------------------------
// 페이로드 / 응답 타입
// ---------------------------------------------------------------------------

/** 스트리핑이 실제로 어떻게 됐는지 — 패널 로그·배너에 그대로 쓰인다. */
export interface StripStatusReport {
  mode: DownloadMode;
  level: 'good' | 'info' | 'bad';
  /** 사람이 읽을 한 줄 요약 (배너/로그용) */
  message: string;
  /** 원인 추적용 상세 — 콘솔에만 찍는다 (바이트 덤프, 환경 정보 등) */
  detail?: string;
}

export interface DownloadPayload {
  /** base64 인코딩된 원본 이미지 바이트 */
  bytes: string;
  mode: DownloadMode;
  /** 최상위 폴더부터의 경로 (renderFolder 결과) */
  folder: string;
  /** 확장자를 뺀 파일명 */
  filename: string;
  strip: { keepIccp: boolean };
}

export interface DownloadResponse {
  saved: string[];
  errors?: string[];
  stripStatus?: StripStatusReport;
  /** 핸들러 자체가 실패한 경우 */
  error?: string;
}

export interface WebhookPayload {
  url: string;
  body: unknown;
}

export interface WebhookResponse {
  ok: boolean;
  status?: number;
}

export interface BadgePayload {
  text: string;
  color?: string;
}

/** 브라우저 알림 (N03) — Discord를 쓰지 않는 사용자를 위한 기본 통보 수단 */
export interface NotifyPayload {
  title: string;
  message: string;
  kind: 'done' | 'error' | 'anlasFloor';
}

/** 배치 진행 상태 — 팝업이 실행 중 화면을 그리는 데 쓴다 (B04) */
export interface RunState {
  running: boolean;
  paused: boolean;
  /** 완료한 장수 */
  done: number;
  /** 목표 장수 */
  total: number;
  /** 남은 예상 시간(초). 계산 전이면 0 */
  etaSec: number;
}

export interface AnlasQueryResponse {
  anlas: number | null;
  state: RunState;
  /**
   * Generate 버튼에 표시된 1회 생성 가격(Anlas). NAI가 현재 해상도·스텝·동시 생성 장수를
   * 전부 반영해서 계산해 준 값이라, 확장이 따로 추정하지 않고 이걸 그대로 쓴다.
   * 파싱에 실패하면 null — 호출부는 어림값으로 폴백하되 "어림"임을 드러내야 한다.
   */
  generateCost: number | null;
}

/** 셀렉터 자가진단 한 항목 (N02) */
export interface SelfCheckItem {
  key: string;
  /** 사용자에게 보여줄 이름 (예: "프롬프트 입력 영역") */
  label: string;
  ok: boolean;
  /** 실패 원인 또는 찾은 노드 요약 */
  detail?: string;
}

export interface SelfCheckResponse {
  items: SelfCheckItem[];
  okCount: number;
  total: number;
}

/** 이력에서 프롬프트를 NAI 페이지에 채워 넣기 (U10) */
export interface PromptFillPayload {
  prompt: string;
  uc?: string;
}

/**
 * 이미 저장해 둔 파일들을 나중에 일괄로 클린 처리 (N09).
 * 스트리핑 파이프라인은 바이트 배열만 받으면 되므로 그대로 재사용한다.
 */
export interface StripFilesPayload {
  /** name은 확장자를 뺀 원본 파일명, bytes는 base64 */
  files: Array<{ name: string; bytes: string }>;
  mode: DownloadMode;
  folder: string;
  keepIccp: boolean;
}

export interface StripFilesResponse {
  results: Array<{
    name: string;
    saved: string[];
    error?: string;
    stripStatus?: StripStatusReport;
  }>;
}

/** 배치가 도는 동안 시스템 절전을 막는다. content script에는 chrome.power가 없어 SW가 대신 호출한다. */
export interface PowerPayload {
  /** true면 절전 방지 요청, false면 해제 */
  on: boolean;
}

export interface OkResponse {
  ok: boolean;
  /** 거절된 경우 사유 (예: 약관 미동의) */
  reason?: string;
}

// ---------------------------------------------------------------------------
// 메시지 레지스트리
// ---------------------------------------------------------------------------

/**
 * 각 메시지의 페이로드/응답 타입. payload가 undefined면 sendMessage에서 인자를 생략한다.
 *
 * 수신처:
 *   naisu.download / webhook / badge / notify → background
 *   그 외 → content script (novelai.net 탭)
 */
export interface MessageMap {
  'naisu.download': { payload: DownloadPayload; response: DownloadResponse };
  'naisu.webhook': { payload: WebhookPayload; response: WebhookResponse };
  'naisu.badge': { payload: BadgePayload; response: OkResponse };
  'naisu.notify': { payload: NotifyPayload; response: OkResponse };
  'naisu.power': { payload: PowerPayload; response: OkResponse };
  /** 저장된 파일들을 일괄 클린 (N09) */
  'naisu.strip.files': { payload: StripFilesPayload; response: StripFilesResponse };

  'naisu.query.anlas': { payload: undefined; response: AnlasQueryResponse };
  'naisu.batch.start': { payload: { count?: number } | undefined; response: OkResponse };
  'naisu.batch.stop': { payload: undefined; response: OkResponse };
  'naisu.batch.pause': { payload: undefined; response: OkResponse };
  /** 중단된 배치를 커서부터 이어서 실행 (N07) */
  'naisu.batch.resume': { payload: undefined; response: OkResponse };
  'naisu.ui.reset': { payload: undefined; response: OkResponse };
  /** 화면에 떠 있는 이미지를 즉시 저장 (패널 버튼과 같은 동작, 단축키용) */
  'naisu.manual.download': { payload: undefined; response: OkResponse };
  /** NAI DOM 셀렉터가 아직 유효한지 검사 (N02) */
  'naisu.selfcheck': { payload: undefined; response: SelfCheckResponse };
  /** 이력의 프롬프트를 NAI 입력란에 채우기 (U10) */
  'naisu.prompt.fill': { payload: PromptFillPayload; response: OkResponse };
}

export type MessageType = keyof MessageMap;

export type PayloadOf<K extends MessageType> = MessageMap[K]['payload'];
export type ResponseOf<K extends MessageType> = MessageMap[K]['response'];

/** 라우터에서 받는 메시지 유니온 — switch(msg.type)로 좁혀진다. */
export type NaisuMessage = {
  [K in MessageType]: { type: K; payload: PayloadOf<K> };
}[MessageType];

/** payload가 undefined인 메시지는 인자를 생략할 수 있게 하는 튜플 트릭 */
type PayloadArgs<K extends MessageType> = undefined extends PayloadOf<K>
  ? [payload?: PayloadOf<K>]
  : [payload: PayloadOf<K>];

// ---------------------------------------------------------------------------
// 전송 헬퍼
// ---------------------------------------------------------------------------

/**
 * 확장 내부(주로 background)로 보냅니다. 수신처가 없으면 예외가 그대로 올라옵니다 —
 * 조용히 삼키지 않는 것이 이 프로젝트의 규칙이라, 무시해도 되는 자리에서는
 * trySendMessage를 쓰세요.
 */
export async function sendMessage<K extends MessageType>(
  type: K,
  ...args: PayloadArgs<K>
): Promise<ResponseOf<K>> {
  return (await chrome.runtime.sendMessage({ type, payload: args[0] })) as ResponseOf<K>;
}

/** 실패해도 흐름을 끊으면 안 되는 자리용 (배지 갱신 등). 실패는 콘솔에 남깁니다. */
export async function trySendMessage<K extends MessageType>(
  type: K,
  ...args: PayloadArgs<K>
): Promise<ResponseOf<K> | undefined> {
  try {
    return await sendMessage(type, ...args);
  } catch (e) {
    console.warn(`[naisu] ${type} 전송 실패 (수신처 없음일 수 있음)`, e);
    return undefined;
  }
}

/** 특정 탭의 content script로 보냅니다 (팝업 → NAI 탭). */
export async function sendToTab<K extends MessageType>(
  tabId: number,
  type: K,
  ...args: PayloadArgs<K>
): Promise<ResponseOf<K>> {
  return (await chrome.tabs.sendMessage(tabId, { type, payload: args[0] })) as ResponseOf<K>;
}

/** content script가 아직 안 붙은 탭에서도 흐름을 끊지 않게. */
export async function trySendToTab<K extends MessageType>(
  tabId: number,
  type: K,
  ...args: PayloadArgs<K>
): Promise<ResponseOf<K> | undefined> {
  try {
    return await sendToTab(tabId, type, ...args);
  } catch {
    return undefined;
  }
}

// ---------------------------------------------------------------------------
// 레인 간 계약 (구현은 각 레인, 시그니처는 여기서 고정)
// ---------------------------------------------------------------------------

/**
 * 자동 배치를 시작해도 되는지 확인합니다. 미동의면 약관 모달을 띄우고 false를 반환.
 * 구현: content/overlay.ts (D01) · 호출: content/runner.ts::runBatch() 첫 줄
 */
export type EnsureDisclaimerAccepted = () => Promise<boolean>;

/**
 * NAI DOM 셀렉터가 아직 유효한지 검사합니다.
 * 구현: content/selectors.ts (N02) · 호출: 팝업/패널의 "연결 확인" 버튼
 */
export type RunSelfCheck = () => SelfCheckResponse;
