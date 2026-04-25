/**
 * NAI 메타데이터 JSON 구조 (V4.5 기준).
 * UserComment EXIF 필드 안에 다음 형식으로 저장됨:
 *   { "Comment": "<inner JSON 문자열>" }
 * 그 inner JSON이 NaiGenerationParams.
 */

export interface NaiV4Caption {
  base_caption: string;
  char_captions: NaiV4CharCaption[];
}

export interface NaiV4CharCaption {
  char_caption: string;
  centers?: { x: number; y: number }[];
}

export interface NaiV4Prompt {
  caption: NaiV4Caption;
  use_coords: boolean;
  use_order: boolean;
  legacy_uc?: boolean;
}

export interface NaiGenerationParams {
  prompt: string;
  steps: number;
  height: number;
  width: number;
  scale: number;
  uncond_scale: number;
  cfg_rescale: number;
  seed: number;
  n_samples: number;
  noise_schedule: string;
  legacy_v3_extend?: boolean;
  v4_prompt?: NaiV4Prompt;
  v4_negative_prompt?: NaiV4Prompt;
  // 그 외 NAI가 추가하는 필드는 unknown으로 보관
  [key: string]: unknown;
}

export interface NaiMetadata {
  /** Software EXIF 태그 (예: "NovelAI Diffusion V4.5 4BDE2A90") */
  software?: string;
  /** ImageDescription EXIF 태그 (보통 prompt 원문) */
  description?: string;
  /** UserComment 안 JSON.Comment 를 풀어둔 본체 */
  generation?: NaiGenerationParams;
  /** 파싱 실패한 경우 raw 문자열 보관 (디버깅용) */
  raw?: {
    userComment?: string;
    comment?: string;
  };
}
