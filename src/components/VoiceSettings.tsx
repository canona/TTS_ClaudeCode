'use client';

import { useMemo } from 'react';
import type { VieneuState } from '@/hooks/useVieneuVoices';
import { LANGUAGES } from '@/lib/languages';
import { engineOfVoice, type LanguageCode, type ProsodySettings, type VoiceInfo } from '@/lib/types';
import { Card } from './Card';
import { MicIcon, SpinnerIcon } from './icons';

interface VoiceSettingsProps {
  /** Offline VieNeu voices – listed first for Vietnamese. */
  vieneu: VieneuState;
  /** Opens the dialog to record / manage cloned regional voices. */
  onOpenCustomVoices: () => void;
  language: LanguageCode;
  onLanguageChange: (code: LanguageCode) => void;
  voices: VoiceInfo[];
  voice: string;
  onVoiceChange: (shortName: string) => void;
  voicesLoading: boolean;
  voicesError: string | null;
  prosody: ProsodySettings;
  onProsodyChange: (prosody: ProsodySettings) => void;
  disabled?: boolean;
}

const regionNames = (() => {
  try {
    return new Intl.DisplayNames(['vi'], { type: 'region' });
  } catch {
    return null;
  }
})();

function regionLabel(locale: string): string {
  const parts = locale.split('-');
  const region = parts[1];
  const name = region ? (regionNames?.of(region) ?? region) : locale;
  return parts.length > 2 ? `${name} – ${parts.slice(2).join('-')}` : name;
}

interface SliderProps {
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  unit: string;
  onChange: (value: number) => void;
  disabled?: boolean;
  /** Replaces the value readout, e.g. when the engine ignores this setting. */
  note?: string;
}

function Slider({ label, value, min, max, step, unit, onChange, disabled, note }: SliderProps) {
  return (
    <label className={`block ${note ? 'opacity-50' : ''}`}>
      <div className="mb-1 flex items-center justify-between text-xs">
        <span className="font-medium text-slate-600 dark:text-slate-300">
          {label}
          {note && <span className="ml-1.5 font-normal text-slate-400">({note})</span>}
        </span>
        <button
          type="button"
          onClick={() => onChange(0)}
          disabled={disabled}
          className="rounded px-1.5 py-0.5 font-mono text-slate-500 tabular-nums hover:bg-slate-100 dark:hover:bg-slate-800"
          title="Đặt lại"
        >
          {value > 0 ? '+' : ''}
          {value}
          {unit}
        </button>
      </div>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        disabled={disabled}
        onChange={(e) => onChange(Number(e.target.value))}
        className="w-full accent-indigo-600"
      />
    </label>
  );
}

/** Compact state line of the offline engine, shown under the voice list (Vietnamese only). */
function VieneuStatus({ vieneu }: { vieneu: VieneuState }) {
  if (vieneu.available) return null;
  if (vieneu.loading || vieneu.starting) {
    return (
      <p className="mt-1.5 flex items-start gap-1.5 text-xs text-slate-500 dark:text-slate-400">
        <SpinnerIcon width={12} height={12} className="mt-0.5 shrink-0" />
        {vieneu.starting ? vieneu.error : 'Đang kết nối giọng offline VieNeu…'}
      </p>
    );
  }
  return (
    <div className="mt-1.5 rounded-lg bg-amber-50 px-3 py-2 text-xs text-amber-800 dark:bg-amber-500/10 dark:text-amber-300">
      <p className="font-medium">Giọng offline VieNeu chưa sẵn sàng – đang dùng giọng Edge.</p>
      <p className="mt-1 max-h-24 overflow-auto whitespace-pre-wrap break-words text-amber-700/80 dark:text-amber-300/70">
        {vieneu.error}
      </p>
      <button type="button" onClick={vieneu.refresh} className="mt-1 font-semibold underline-offset-2 hover:underline">
        Thử lại
      </button>
    </div>
  );
}

export function VoiceSettings(props: VoiceSettingsProps) {
  const { vieneu, language, voices, voice, prosody, disabled } = props;
  const isVieneu = engineOfVoice(voice) === 'vieneu';

  // Vietnamese: offline VieNeu voices first (the default), then Edge. Other languages: Edge only.
  const groups = useMemo(() => {
    const presets = vieneu.voices.filter((v) => !v.custom);
    const offline =
      language === 'vi'
        ? [
            { label: 'Giọng địa phương của bạn', items: vieneu.voices.filter((v) => v.custom) },
            { label: 'VieNeu · offline – Đề xuất', items: presets.filter((v) => v.featured) },
            { label: 'VieNeu · offline – Giọng nữ', items: presets.filter((v) => !v.featured && v.gender === 'Female') },
            { label: 'VieNeu · offline – Giọng nam', items: presets.filter((v) => !v.featured && v.gender === 'Male') },
          ]
        : [];
    const edge = voices.filter((v) => v.language === language);
    const prefix = offline.length > 0 ? 'Edge · online – ' : '';
    return [
      ...offline,
      { label: `${prefix}Giọng nữ`, items: edge.filter((v) => !v.isChild && v.gender === 'Female') },
      { label: `${prefix}Giọng nam`, items: edge.filter((v) => !v.isChild && v.gender === 'Male') },
      { label: `${prefix}Giọng trẻ em`, items: edge.filter((v) => v.isChild) },
    ].filter((g) => g.items.length > 0);
  }, [vieneu.voices, voices, language]);

  const count = groups.reduce((sum, g) => sum + g.items.length, 0);
  // While the offline engine is still coming up, the Vietnamese default is not decided yet.
  const pending = language === 'vi' && !vieneu.available && (vieneu.loading || vieneu.starting);
  const listLoading = props.voicesLoading || (pending && !voice);

  return (
    <Card title="Giọng đọc">
      <div className="grid grid-cols-4 gap-1.5 sm:grid-cols-7 lg:grid-cols-4">
        {LANGUAGES.map((lang) => {
          const active = lang.code === language;
          return (
            <button
              key={lang.code}
              type="button"
              disabled={disabled}
              onClick={() => props.onLanguageChange(lang.code)}
              className={`flex flex-col items-center gap-0.5 rounded-xl border px-1 py-2 text-[11px] font-medium transition disabled:opacity-50 ${
                active
                  ? 'border-indigo-500 bg-indigo-50 text-indigo-700 dark:bg-indigo-500/15 dark:text-indigo-300'
                  : 'border-slate-200 text-slate-600 hover:border-slate-300 hover:bg-slate-50 dark:border-slate-700 dark:text-slate-300 dark:hover:bg-slate-800'
              }`}
            >
              <span className="text-lg leading-none">{lang.flag}</span>
              {lang.label.replace('Tiếng ', '')}
            </button>
          );
        })}
      </div>

      <label className="mt-4 block">
        <span className="mb-1 flex justify-between text-xs font-medium text-slate-600 dark:text-slate-300">
          Chọn giọng
          <span className="font-normal text-slate-400">
            {listLoading ? 'Đang tải…' : `${count} giọng${isVieneu ? ' · đang dùng offline' : ''}`}
          </span>
        </span>
        <select
          value={voice}
          disabled={disabled || listLoading || count === 0}
          onChange={(e) => props.onVoiceChange(e.target.value)}
          className="w-full rounded-xl border border-slate-200 bg-white px-3 py-2.5 text-sm text-slate-800 outline-none focus:border-indigo-400 focus:ring-4 focus:ring-indigo-500/10 dark:border-slate-700 dark:bg-slate-950 dark:text-slate-100"
        >
          {!voice && <option value="">Đang chuẩn bị giọng đọc…</option>}
          {groups.map((group) => (
            <optgroup key={group.label} label={group.label}>
              {group.items.map((v) => (
                <option key={v.shortName} value={v.shortName} title={v.personalities.join(', ') || undefined}>
                  {v.custom
                    ? `${v.displayName}${v.region ? ` · ${v.region}` : ''}`
                    : engineOfVoice(v.shortName) === 'vieneu'
                      ? v.displayName
                      : `${v.displayName} · ${regionLabel(v.locale)}`}
                </option>
              ))}
            </optgroup>
          ))}
        </select>
        {props.voicesError && <p className="mt-1 text-xs text-rose-600">{props.voicesError}</p>}
      </label>
      {language === 'vi' && <VieneuStatus vieneu={vieneu} />}
      {language === 'vi' && vieneu.available && (
        <div className="mt-2 flex items-center justify-between gap-2 text-xs">
          <button
            type="button"
            onClick={props.onOpenCustomVoices}
            disabled={disabled}
            className="inline-flex items-center gap-1 font-medium text-indigo-600 hover:underline disabled:opacity-50 dark:text-indigo-300"
          >
            <MicIcon width={13} height={13} /> Thêm giọng địa phương
          </button>
          {(vieneu.restoring ?? 0) > 0 && (
            <span className="flex items-center gap-1 text-slate-400">
              <SpinnerIcon width={11} height={11} /> Đang nạp {vieneu.restoring} giọng của bạn…
            </span>
          )}
        </div>
      )}

      <div className="mt-4 space-y-3">
        <Slider
          label="Tốc độ"
          value={prosody.rate}
          min={-50}
          max={100}
          step={5}
          unit="%"
          disabled={disabled || isVieneu}
          note={isVieneu ? 'giọng offline không hỗ trợ' : undefined}
          onChange={(rate) => props.onProsodyChange({ ...prosody, rate })}
        />
        <Slider
          label="Cao độ"
          value={prosody.pitch}
          min={-50}
          max={50}
          step={5}
          unit="Hz"
          disabled={disabled || isVieneu}
          note={isVieneu ? 'giọng offline không hỗ trợ' : undefined}
          onChange={(pitch) => props.onProsodyChange({ ...prosody, pitch })}
        />
        <Slider
          label="Âm lượng"
          value={prosody.volume}
          min={-50}
          max={50}
          step={5}
          unit="%"
          disabled={disabled}
          onChange={(volume) => props.onProsodyChange({ ...prosody, volume })}
        />
      </div>
    </Card>
  );
}
