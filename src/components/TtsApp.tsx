'use client';

import { useEffect, useMemo, useState } from 'react';
import { useActiveCue } from '@/hooks/useActiveCue';
import { useLocalStorage } from '@/hooks/useLocalStorage';
import { useTts, type TtsState } from '@/hooks/useTts';
import { useVieneuVoices } from '@/hooks/useVieneuVoices';
import { useVoices } from '@/hooks/useVoices';
import { cacheStats, clearCache } from '@/lib/client/idb-cache';
import { formatBytes, formatTime } from '@/lib/client/utils';
import { getLanguage } from '@/lib/languages';
import { VIENEU_VOICE_PREFIX, engineOfVoice, type LanguageCode, type ProsodySettings, type VoiceInfo } from '@/lib/types';
import { Card } from './Card';
import { DownloadPanel } from './DownloadPanel';
import { LiveCaptions } from './LiveCaptions';
import { PlayerControls } from './PlayerControls';
import { SpinnerIcon, StopIcon, WaveIcon } from './icons';
import { TextEditor } from './TextEditor';
import { VoiceCloneDialog } from './VoiceCloneDialog';
import { VoiceSettings } from './VoiceSettings';

const DEFAULT_PROSODY: ProsodySettings = { rate: 0, pitch: 0, volume: 0 };

/** Default voice: first adult female voice of the language's primary locale. */
function pickDefaultVoice(voices: VoiceInfo[], language: LanguageCode): string {
  const primary = getLanguage(language).primaryLocale;
  const list = voices.filter((v) => v.language === language);
  return (
    list.find((v) => v.locale === primary && v.gender === 'Female' && !v.isChild) ??
    list.find((v) => v.locale === primary) ??
    list[0]
  )?.shortName ?? '';
}

function StatusLine({ state }: { state: TtsState }) {
  const { status, progress, generatedSeconds } = state;
  const pct = progress.total > 0 ? Math.round((progress.done / progress.total) * 100) : 0;

  if (status === 'idle') return null;
  if (status === 'error') {
    return <p className="rounded-lg bg-rose-50 px-3 py-2 text-sm text-rose-700 dark:bg-rose-500/10 dark:text-rose-300">{state.error}</p>;
  }
  return (
    <div className="space-y-1.5">
      <div className="flex items-center justify-between text-xs text-slate-500 dark:text-slate-400">
        <span className="flex items-center gap-1.5">
          {status === 'loading' && (
            <>
              <SpinnerIcon width={13} height={13} /> Đang kết nối…
            </>
          )}
          {status === 'streaming' && (
            <>
              <SpinnerIcon width={13} height={13} /> Đang tạo đoạn {Math.min(progress.done + 1, progress.total)}/{progress.total}
            </>
          )}
          {status === 'done' && <>✓ Hoàn tất · {formatTime(generatedSeconds)}</>}
        </span>
        {status === 'streaming' && <span className="tabular-nums">{pct}%</span>}
      </div>
      {status === 'streaming' && (
        <div className="h-1 overflow-hidden rounded-full bg-slate-200 dark:bg-slate-800">
          <div className="h-full rounded-full bg-indigo-500 transition-all duration-500" style={{ width: `${pct}%` }} />
        </div>
      )}
      {state.source === 'browser-cache' && (
        <p className="text-xs text-emerald-600 dark:text-emerald-400">⚡ Phát ngay từ bộ nhớ đệm trình duyệt</p>
      )}
      {state.source === 'network' && state.serverCachedChunks > 0 && (
        <p className="text-xs text-emerald-600 dark:text-emerald-400">
          ⚡ {state.serverCachedChunks}/{progress.total} đoạn lấy từ cache máy chủ
        </p>
      )}
    </div>
  );
}

export function TtsApp() {
  const { voices, loading: voicesLoading, error: voicesError } = useVoices();
  const { audioRef, state, speak, stop, seek, play } = useTts();
  const activeIndex = useActiveCue(audioRef, state.cues);

  const [text, setText] = useLocalStorage('tts.text', '');
  const [language, setLanguage] = useLocalStorage<LanguageCode>('tts.language', 'vi');
  const [voiceByLanguage, setVoiceByLanguage] = useLocalStorage<Partial<Record<LanguageCode, string>>>('tts.voices', {});
  const [prosody, setProsody] = useLocalStorage<ProsodySettings>('tts.prosody', DEFAULT_PROSODY);
  const [cacheInfo, setCacheInfo] = useState<{ entries: number; bytes: number } | null>(null);
  const vieneu = useVieneuVoices();
  const [cloneOpen, setCloneOpen] = useState(false);

  // Stored choice if it still exists, else the default: for Vietnamese the
  // offline VieNeu voice (the server launches it on demand), else Edge.
  const voice = useMemo(() => {
    const stored = voiceByLanguage[language];
    const offline = language === 'vi' ? vieneu.voices : [];
    if (stored && [...offline, ...voices].some((v) => v.shortName === stored)) return stored;
    // A regional voice that was re-cleaned got a new id: follow it.
    const renamed = stored && offline.find((v) => v.previousIds?.some((id) => `${VIENEU_VOICE_PREFIX}${id}` === stored));
    if (renamed) return renamed.shortName;
    if (language === 'vi') {
      if (vieneu.available) {
        // Best-ranked recommended female voice (list is in recommendation order), like the Edge default.
        const featured = offline.filter((v) => v.featured);
        return (featured.find((v) => v.gender === 'Female') ?? featured[0] ?? offline[0])!.shortName;
      }
      // Still starting: wait instead of silently picking an online voice.
      if (vieneu.loading || vieneu.starting) return '';
    }
    return pickDefaultVoice(voices, language);
  }, [vieneu.voices, vieneu.available, vieneu.loading, vieneu.starting, voices, voiceByLanguage, language]);

  const busy = state.status === 'loading' || state.status === 'streaming';

  // An offline voice failed (e.g. VieNeu got stuck and is restarting): re-read its status so the
  // panel shows "đang khởi động" and the voices come back by themselves.
  const { refresh: refreshVieneu } = vieneu;
  useEffect(() => {
    if (state.status === 'error' && state.voice && engineOfVoice(state.voice) === 'vieneu') refreshVieneu();
  }, [state.status, state.voice, refreshVieneu]);

  useEffect(() => {
    if (state.status === 'done' || state.status === 'idle') void cacheStats().then(setCacheInfo);
  }, [state.status]);

  const handleSpeak = (): void => {
    if (!text.trim() || !voice) return;
    void speak({ text, voice, prosody });
  };

  return (
    <div className="min-h-dvh bg-slate-50 bg-radial-[at_50%_0%] from-indigo-100/60 via-slate-50 to-slate-50 text-slate-900 dark:bg-slate-950 dark:from-indigo-950/40 dark:via-slate-950 dark:to-slate-950 dark:text-slate-100">
      <audio ref={audioRef} preload="auto" className="hidden" />
      <VoiceCloneDialog
        open={cloneOpen}
        onClose={() => setCloneOpen(false)}
        onCreated={(created) => {
          // Select the new regional voice right away (it appears once the list reloads).
          setLanguage('vi');
          setVoiceByLanguage((prev) => ({ ...prev, vi: `${VIENEU_VOICE_PREFIX}${created.id}` }));
          vieneu.refresh();
        }}
        onChanged={() => vieneu.refresh()}
        onDeleted={() => vieneu.refresh()}
      />

      <header className="mx-auto flex max-w-6xl items-center justify-between gap-4 px-4 pt-6 pb-4 sm:px-6">
        <div className="flex items-center gap-3">
          <div className="grid size-10 place-items-center rounded-xl bg-linear-to-br from-indigo-600 to-violet-600 text-white shadow-lg shadow-indigo-600/30">
            <WaveIcon />
          </div>
          <div>
            <h1 className="text-lg leading-tight font-bold sm:text-xl">TTS Studio</h1>
            <p className="text-xs text-slate-500 dark:text-slate-400">Văn bản → giọng nói · VieNeu offline + Edge online · không giới hạn</p>
          </div>
        </div>
        <span className="hidden rounded-full border border-emerald-200 bg-emerald-50 px-3 py-1 text-xs font-medium text-emerald-700 sm:inline dark:border-emerald-500/30 dark:bg-emerald-500/10 dark:text-emerald-300">
          Không cần API key
        </span>
      </header>

      {/* Mobile order: text → settings/player → captions. Desktop: sidebar spans both rows on the right. */}
      <main className="mx-auto grid max-w-6xl gap-4 px-4 pb-10 sm:px-6 lg:grid-cols-[minmax(0,1fr)_360px] lg:grid-rows-[auto_1fr]">
        <TextEditor
          value={text}
          onChange={setText}
          onSubmit={handleSpeak}
          sample={getLanguage(language).sample}
          disabled={busy}
        />

        <aside className="space-y-4 lg:sticky lg:top-4 lg:col-start-2 lg:row-span-2 lg:row-start-1 lg:self-start">
          <VoiceSettings
            vieneu={vieneu}
            onOpenCustomVoices={() => setCloneOpen(true)}
            language={language}
            onLanguageChange={setLanguage}
            voices={voices}
            voice={voice}
            onVoiceChange={(shortName) => setVoiceByLanguage((prev) => ({ ...prev, [language]: shortName }))}
            voicesLoading={voicesLoading}
            voicesError={voicesError}
            prosody={prosody}
            onProsodyChange={setProsody}
            disabled={busy}
          />

          <Card className="space-y-4">
            {busy ? (
              <button
                type="button"
                onClick={stop}
                className="flex w-full items-center justify-center gap-2 rounded-xl bg-slate-800 px-4 py-3 font-semibold text-white transition hover:bg-slate-700 active:scale-[0.99] dark:bg-slate-700 dark:hover:bg-slate-600"
              >
                <StopIcon width={18} height={18} /> Dừng
              </button>
            ) : (
              <button
                type="button"
                onClick={handleSpeak}
                disabled={!text.trim() || !voice}
                className="flex w-full items-center justify-center gap-2 rounded-xl bg-linear-to-r from-indigo-600 to-violet-600 px-4 py-3 font-semibold text-white shadow-lg shadow-indigo-600/25 transition hover:brightness-110 active:scale-[0.99] disabled:from-slate-300 disabled:to-slate-300 disabled:shadow-none dark:disabled:from-slate-700 dark:disabled:to-slate-700"
              >
                <WaveIcon width={18} height={18} /> Đọc văn bản
              </button>
            )}

            <StatusLine state={state} />

            {state.autoplayBlocked && (
              <button
                type="button"
                onClick={play}
                className="w-full rounded-lg bg-amber-50 px-3 py-2 text-sm font-medium text-amber-800 dark:bg-amber-500/10 dark:text-amber-300"
              >
                Trình duyệt chặn tự phát – nhấn vào đây để nghe
              </button>
            )}

            <PlayerControls
              audioRef={audioRef}
              generatedSeconds={state.generatedSeconds}
              isStreaming={state.status === 'streaming'}
              onSeek={seek}
              onPlay={play}
            />

            <DownloadPanel audioBlob={state.audioBlob} cues={state.cues} voice={state.voice} />
          </Card>

          {cacheInfo && cacheInfo.entries > 0 && (
            <p className="flex items-center justify-between px-1 text-xs text-slate-500 dark:text-slate-400">
              <span>
                Bộ nhớ đệm: {cacheInfo.entries} bản ghi · {formatBytes(cacheInfo.bytes)}
              </span>
              <button
                type="button"
                className="underline-offset-2 hover:underline"
                onClick={() => void clearCache().then(() => setCacheInfo({ entries: 0, bytes: 0 }))}
              >
                Xóa cache
              </button>
            </p>
          )}
        </aside>

        <div className="lg:col-start-1 lg:row-start-2">
          <LiveCaptions
            cues={state.cues}
            activeIndex={activeIndex}
            audioRef={audioRef}
            onSeek={seek}
            isStreaming={busy}
          />
        </div>
      </main>
    </div>
  );
}
