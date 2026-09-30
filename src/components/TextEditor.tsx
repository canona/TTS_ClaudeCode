'use client';

import { useRef, type ChangeEvent, type KeyboardEvent } from 'react';
import { Card } from './Card';
import { FileIcon, SparkIcon, TrashIcon } from './icons';

interface TextEditorProps {
  value: string;
  onChange: (value: string) => void;
  onSubmit: () => void;
  sample: string;
  disabled?: boolean;
}

const ghostButton =
  'inline-flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-xs font-medium text-slate-600 transition hover:bg-slate-100 disabled:opacity-40 dark:text-slate-300 dark:hover:bg-slate-800';

export function TextEditor({ value, onChange, onSubmit, sample, disabled }: TextEditorProps) {
  const fileInput = useRef<HTMLInputElement>(null);
  const words = value.trim() ? value.trim().split(/\s+/).length : 0;

  const handleFile = async (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (file) onChange(await file.text());
  };

  const handleKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      onSubmit();
    }
  };

  return (
    <Card
      title="Văn bản"
      actions={
        <>
          <button type="button" className={ghostButton} onClick={() => onChange(sample)} disabled={disabled}>
            <SparkIcon width={14} height={14} /> Mẫu
          </button>
          <button type="button" className={ghostButton} onClick={() => fileInput.current?.click()} disabled={disabled}>
            <FileIcon width={14} height={14} /> Mở .txt
          </button>
          <button type="button" className={ghostButton} onClick={() => onChange('')} disabled={disabled || !value}>
            <TrashIcon width={14} height={14} /> Xóa
          </button>
          <input ref={fileInput} type="file" accept=".txt,.md,text/plain" className="hidden" onChange={handleFile} />
        </>
      }
    >
      <textarea
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={handleKeyDown}
        placeholder="Nhập hoặc dán văn bản cần đọc – không giới hạn độ dài, kể cả cả một cuốn tiểu thuyết…"
        spellCheck={false}
        className="h-64 w-full resize-y rounded-xl border border-slate-200 bg-slate-50 p-4 text-[15px] leading-relaxed text-slate-800 outline-none transition placeholder:text-slate-400 focus:border-indigo-400 focus:bg-white focus:ring-4 focus:ring-indigo-500/10 sm:h-72 dark:border-slate-700 dark:bg-slate-950/60 dark:text-slate-100 dark:focus:bg-slate-950"
      />
      <div className="mt-2 flex flex-wrap items-center justify-between gap-2 text-xs text-slate-500 dark:text-slate-400">
        <span>
          {value.length.toLocaleString('vi-VN')} ký tự · {words.toLocaleString('vi-VN')} từ
        </span>
        <span className="hidden sm:inline">
          <kbd className="rounded border border-slate-300 px-1 dark:border-slate-600">Ctrl</kbd> +{' '}
          <kbd className="rounded border border-slate-300 px-1 dark:border-slate-600">Enter</kbd> để đọc
        </span>
      </div>
    </Card>
  );
}
