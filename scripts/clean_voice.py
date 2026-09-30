"""Clean a voice-cloning reference clip before it is enrolled into VieNeu-TTS.

A cloned voice reproduces the *recording conditions* of its reference along
with the speaker, so hiss or hum in a phone/laptop recording comes back in
every sentence read with it – including as buzzing in the pauses. VieNeu's
own denoiser (resemble-enhance) barely touches broadband hiss inside speech,
hence this extra pass:

  1. high-pass 70 Hz            rumble, handling noise, DC
  2. spectral denoise           noise PSD by minimum statistics – works even when the
                                browser's own noise suppression gated the pauses to
                                silence, so "learn the noise from silence" is impossible –
                                then a time/frequency-smoothed Wiener gain with a floor
                                (no "musical noise" / underwater artefacts)
  3. shorten long pauses        > 0.35 s → 0.25 s: the encoder wants continuous speech
  4. normalize                  -1 dBFS peak

What it cannot fix is a rough/hoarse voice (room echo, far-away mic): see
`harmonicity` – the app shows it so the user knows to re-record.

Runs inside VieNeu's environment (numpy, scipy, soundfile are its deps):
    uv run --project <VieNeu-TTS> python scripts/clean_voice.py in.wav out.wav
Prints one JSON line with quality figures (before / after) for the app.
"""
from __future__ import annotations

import json
import sys

import numpy as np
import soundfile as sf
from scipy import ndimage, signal

SR = 24_000


def to_db(x: np.ndarray) -> np.ndarray:
    return 20 * np.log10(np.maximum(x, 1e-9))


def frame_db(x: np.ndarray, win: int) -> np.ndarray:
    n = len(x) // win
    return to_db(np.sqrt((x[: n * win].reshape(n, win) ** 2).mean(1)))


def harmonicity(x: np.ndarray) -> float:
    """Median harmonics-to-noise ratio (dB) of the louder 40 ms frames.

    This is what "rough / hoarse / hissy voice" measures: a close, clean
    recording of speech scores ~6-12 dB; room echo, a far-away laptop mic or
    browser noise suppression artefacts smear the harmonics down to ~0 dB.
    Filtering cannot bring harmonics back – only a better recording can.
    """
    win = int(SR * 0.04)
    peak = float(np.abs(x).max()) or 1.0
    vals = []
    for i in range(0, len(x) - win, win // 2):
        fr = x[i:i + win] / peak * np.hanning(win)
        if np.sqrt((fr ** 2).mean()) < 0.02:
            continue
        ac = np.correlate(fr, fr, "full")[win - 1:]
        ac /= ac[0] + 1e-12
        r = float(ac[int(SR / 400): int(SR / 60)].max())  # pitch range 60-400 Hz
        vals.append(10 * np.log10(max(r, 1e-4) / max(1 - r, 1e-4)))
    return float(np.median(vals)) if vals else 0.0


def quality(x: np.ndarray) -> dict:
    """Rough figures: SNR estimate, share of noise-like HF energy during speech, harmonicity."""
    db = frame_db(x, int(SR * 0.02))
    voiced = db[db > -70]  # ignore digitally gated silence
    if voiced.size < 10:
        return {"snr": 0.0, "hiss": 0.0, "hnr": 0.0}
    snr = float(np.percentile(voiced, 90) - np.percentile(voiced, 10))
    f, _, z = signal.stft(x, SR, nperseg=512)
    mag = np.abs(z) ** 2
    loud = to_db(np.sqrt(mag.mean(0))) > np.percentile(to_db(np.sqrt(mag.mean(0))), 60)
    hiss = float(mag[f > 5000][:, loud].sum() / max(mag[:, loud].sum(), 1e-12) * 100)
    return {"snr": round(snr, 1), "hiss": round(hiss, 2), "hnr": round(harmonicity(x), 1)}


def denoise(x: np.ndarray, strength: float = 1.0) -> np.ndarray:
    nper, hop = 1024, 256
    f, _, z = signal.stft(x, SR, nperseg=nper, noverlap=nper - hop)
    power = np.abs(z) ** 2
    # Minimum statistics: noise PSD ≈ a low percentile of each bin over the frames
    # that are not gated silence, then smoothed across frequency.
    frame_level = to_db(np.sqrt(power.mean(0)))
    active = frame_level > max(-75.0, np.percentile(frame_level, 5))
    ref = power[:, active] if active.sum() > 20 else power
    noise = np.percentile(ref, 20, axis=1)
    noise = ndimage.uniform_filter1d(noise, 5)
    # Decision-directed-ish Wiener gain, smoothed over 3 bins x 5 frames.
    snr_post = power / (noise[:, None] * 1.5 * strength + 1e-12)
    gain = np.clip(1 - 1 / np.maximum(snr_post, 1e-6), 0, 1)
    gain = ndimage.uniform_filter(gain, size=(3, 5))
    floor = 10 ** (-18 / 20)  # keep -18 dB of the noise: natural, no pumping
    gain = np.maximum(gain, floor)
    _, y = signal.istft(z * gain, SR, nperseg=nper, noverlap=nper - hop)
    return y[: len(x)].astype(np.float32)


def shorten_pauses(x: np.ndarray, max_pause: float = 0.35, keep: float = 0.25) -> np.ndarray:
    win = int(SR * 0.01)
    db = frame_db(x, win)
    thr = max(np.percentile(db, 90) - 40, -60)
    labels, n = ndimage.label(db < thr)
    drop = np.zeros(len(db), bool)
    for k in range(1, n + 1):
        idx = np.flatnonzero(labels == k)
        # only pauses *inside* speech; keep `keep` seconds, split evenly around the cut
        if len(idx) * win > max_pause * SR and idx[0] > 0 and idx[-1] < len(db) - 1:
            margin = int(keep * SR / win) // 2
            drop[idx[margin: len(idx) - margin]] = True
    kept = [x[j * win: (j + 1) * win] for j in range(len(db)) if not drop[j]]
    kept.append(x[len(db) * win:])
    return np.concatenate(kept)


def main() -> None:
    src, dst = sys.argv[1], sys.argv[2]
    strength = float(sys.argv[3]) if len(sys.argv) > 3 else 1.0
    x, sr = sf.read(src, dtype="float32", always_2d=True)
    x = x.mean(1)
    if sr != SR:
        x = signal.resample_poly(x, SR, sr).astype(np.float32)
    before = quality(x)

    sos = signal.butter(4, 70, "highpass", fs=SR, output="sos")
    x = signal.sosfiltfilt(sos, x).astype(np.float32)
    x = denoise(x, strength)
    x = shorten_pauses(x)
    peak = float(np.abs(x).max()) or 1.0
    x = (x * (0.89 / peak)).astype(np.float32)

    sf.write(dst, x, SR, subtype="PCM_16")
    print(json.dumps({"before": before, "after": quality(x), "duration": round(len(x) / SR, 2)}))


if __name__ == "__main__":
    main()
