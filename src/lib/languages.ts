import type { LanguageCode } from './types';

export interface LanguageOption {
  code: LanguageCode;
  /** Label shown in the (Vietnamese) UI. */
  label: string;
  flag: string;
  /** Preferred locale – its voices are listed first and used as default. */
  primaryLocale: string;
  sample: string;
}

export const LANGUAGES: readonly LanguageOption[] = [
  {
    code: 'vi',
    label: 'Tiếng Việt',
    flag: '🇻🇳',
    primaryLocale: 'vi-VN',
    sample:
      'Xin chào! Đây là ứng dụng chuyển văn bản thành giọng nói miễn phí. Bạn có thể dán cả một cuốn tiểu thuyết vào đây, hệ thống sẽ tự động chia nhỏ và đọc ngay lập tức.',
  },
  {
    code: 'en',
    label: 'Tiếng Anh',
    flag: '🇺🇸',
    primaryLocale: 'en-US',
    sample:
      'Hello! This is a free text-to-speech app. Paste an entire novel here and it will be split into chunks and read aloud right away.',
  },
  {
    code: 'ja',
    label: 'Tiếng Nhật',
    flag: '🇯🇵',
    primaryLocale: 'ja-JP',
    sample: 'こんにちは！これは無料の音声合成アプリです。長い文章を貼り付けると、自動的に分割してすぐに読み上げます。',
  },
  {
    code: 'zh',
    label: 'Tiếng Trung',
    flag: '🇨🇳',
    primaryLocale: 'zh-CN',
    sample: '你好！这是一个免费的文字转语音应用。你可以粘贴整本小说，系统会自动分段并立即开始朗读。',
  },
  {
    code: 'ko',
    label: 'Tiếng Hàn',
    flag: '🇰🇷',
    primaryLocale: 'ko-KR',
    sample: '안녕하세요! 무료 텍스트 음성 변환 앱입니다. 긴 소설을 붙여 넣으면 자동으로 나누어 바로 읽어 드립니다.',
  },
  {
    code: 'fr',
    label: 'Tiếng Pháp',
    flag: '🇫🇷',
    primaryLocale: 'fr-FR',
    sample:
      "Bonjour ! Ceci est une application gratuite de synthèse vocale. Collez un roman entier et il sera découpé puis lu immédiatement.",
  },
  {
    code: 'de',
    label: 'Tiếng Đức',
    flag: '🇩🇪',
    primaryLocale: 'de-DE',
    sample:
      'Hallo! Dies ist eine kostenlose Text-zu-Sprache-App. Fügen Sie einen ganzen Roman ein, er wird automatisch aufgeteilt und sofort vorgelesen.',
  },
];

const CODES = new Set<string>(LANGUAGES.map((l) => l.code));

export function isLanguageCode(value: string): value is LanguageCode {
  return CODES.has(value);
}

/** "zh-CN-liaoning" -> "zh"; returns null for unsupported languages. */
export function languageFromLocale(locale: string): LanguageCode | null {
  const code = locale.split('-')[0]?.toLowerCase() ?? '';
  return isLanguageCode(code) ? code : null;
}

export function getLanguage(code: LanguageCode): LanguageOption {
  // LANGUAGES covers every LanguageCode, so the fallback is never used in practice.
  return LANGUAGES.find((l) => l.code === code) ?? LANGUAGES[0]!;
}
