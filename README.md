# TTS Studio

Ứng dụng web chuyển văn bản thành giọng nói (TTS), chạy trên máy của bạn:

- **Tiếng Việt mặc định dùng model [VieNeu-TTS](https://github.com/pnnbao97/VieNeu-TTS) chạy offline.** App tự khởi động model, người dùng chỉ cần chọn giọng đọc.
- **Giọng địa phương:** ghi âm vài giây giọng quê của một người, app nhân bản thành giọng đọc mới, có sẵn kiểm tra micro và lọc nhiễu.
- **Microsoft Edge TTS** cho 7 ngôn ngữ, miễn phí, không cần API key.
- Không giới hạn độ dài, phát ngay khi đang tạo, phụ đề karaoke, tải về MP3/SRT/VTT.

**Công nghệ:** Next.js 16 (App Router) · React 19 · TypeScript (strict) · Tailwind CSS v4 · `ws` · `@breezystack/lamejs` · VieNeu-TTS (Python, ONNX Runtime)

Quá trình phát triển, các lỗi đã gặp và cách xử lý được ghi chi tiết trong [docs/NHAT-KY-PHAT-TRIEN.md](docs/NHAT-KY-PHAT-TRIEN.md).

## Tính năng

| Tính năng | Cách triển khai |
|---|---|
| Giọng offline VieNeu-TTS (mặc định cho tiếng Việt) | App tự chạy server VieNeu làm tiến trình con. PCM nhận về được mã hóa sang MP3 96 kbps ngay khi tới, nên dùng chung trình phát, cache và tải về với Edge |
| Giọng địa phương (nhân bản giọng) | Ghi âm 3–15 giây hoặc tải file lên → lọc nhiễu → đăng ký với VieNeu (zero-shot cloning) → lưu ở `.voices/`, tự nạp lại mỗi lần VieNeu khởi động |
| Kiểm tra micro | Chọn thiết bị, đo ồn nền và mức tiếng nói, báo độ chênh / vỡ tiếng kèm lời khuyên, nghe lại bản thử |
| Lọc nhiễu bản ghi mẫu | [scripts/clean_voice.py](scripts/clean_voice.py): lọc thông cao, khử ồn phổ (*minimum statistics* + Wiener), rút ngắn khoảng lặng; đo độ hài âm (HNR) để gắn nhãn **Rõ / Tạm / Rè** |
| Tự phục hồi VieNeu | Hàng đợi phía app (không để request chờ trong VieNeu), phát hiện kẹt luồng / treo, tự khởi động lại rồi **tự đọc lại đoạn lỗi**, ghi nhật ký `.vieneu.log` |
| Edge TTS miễn phí, không cần API key | Client WebSocket tự viết, gọi endpoint "Read Aloud" của Edge, token `Sec-MS-GEC`, tự hiệu chỉnh lệch giờ khi gặp HTTP 403 |
| Không giới hạn độ dài | Chia đoạn theo đoạn văn → câu → mệnh đề → từ, giới hạn theo **byte UTF-8 sau khi escape XML** |
| Phát trực tiếp | Mỗi frame MP3 được chuyển tiếp ngay khi tạo ra (NDJSON) → MediaSource Extensions ở trình duyệt |
| Phụ đề karaoke | Edge: mốc `SentenceBoundary`. VieNeu: ước lượng theo độ dài câu. Mọi cue nằm trên một timeline chung, từng từ được tô sáng dần |
| 7 ngôn ngữ, nhiều giọng | Việt, Anh, Nhật, Trung, Hàn, Pháp, Đức (Edge); tiếng Việt thêm 25 giọng VieNeu và giọng địa phương của bạn |
| Tải về | MP3 (ghép toàn bộ luồng), SRT và VTT (câu dài được tách thành dòng dễ đọc) |
| Cache thông minh | Trình duyệt: IndexedDB lưu cả kết quả. Server: LRU trong RAM + file trên đĩa **theo từng đoạn** |

## Chạy ở máy local

```bash
npm install
npm run dev          # http://localhost:3102
```

Bản production: `npm run build && npm start`. Yêu cầu Node.js ≥ 20.9.

Để có giọng offline (khuyến nghị), cài VieNeu-TTS **một lần** vào thư mục **cạnh** dự án. Mặc định app tìm ở `../VieNeu-TTS`, đổi bằng `VIENEU_DIR`. Cần [uv](https://docs.astral.sh/uv/).

```bash
cd ..   # thư mục chứa dự án này
git clone https://github.com/pnnbao97/VieNeu-TTS.git && cd VieNeu-TTS
uv sync                 # CPU (ONNX)   ·   GPU NVIDIA: uv sync --extra cuda
```

Lần chạy đầu, VieNeu tải model từ HuggingFace (khoảng 5 phút). Lần tạo giọng địa phương đầu tiên tải thêm model mã hóa giọng (khoảng 2 phút). Sau đó mọi thứ chạy offline. Không cài VieNeu thì app vẫn chạy với giọng Edge.

## Giọng offline VieNeu-TTS

[VieNeu-TTS](https://github.com/pnnbao97/VieNeu-TTS) là model TTS tiếng Việt chạy hoàn toàn trên máy (CPU hoặc GPU), có 25 giọng mẫu.

- **Tự khởi động:** khi server Next khởi động ([src/instrumentation.ts](src/instrumentation.ts)), app chạy `uv run python -m apps.openai_speech` làm tiến trình con, và tắt cả cây tiến trình (kể cả python) khi app dừng. Nếu VieNeu đã chạy sẵn ở `VIENEU_URL` thì app dùng luôn.
- **Một danh sách giọng duy nhất:** với tiếng Việt, các nhóm hiện theo thứ tự *Giọng địa phương của bạn* → *VieNeu · offline* (đề xuất, nữ, nam) → *Edge · online*. Giọng chọn sẵn là giọng nữ được tác giả VieNeu đề xuất cao nhất. Ngôn ngữ khác dùng Edge.
- **Khi VieNeu chưa sẵn sàng:** màn hình hiện "Đang khởi động VieNeu…". Nếu VieNeu hỏng hoặc chưa cài, app lùi về giọng Edge và hiện nút **Thử lại**.
- **Điều chỉnh:** âm lượng có tác dụng (khuếch đại khi mã hóa MP3). Tốc độ và cao độ bị VieNeu **bỏ qua**, nên hai thanh này bị khóa khi dùng giọng offline.
- **Phụ đề:** VieNeu không trả mốc thời gian câu, nên phụ đề được **ước lượng** theo độ dài câu. Đoạn văn được chia nhỏ (600 byte ≈ 20–25 giây) để phụ đề sát hơn và để bấm Dừng thì VieNeu rảnh nhanh.
- **Song song:** số đoạn tạo cùng lúc tự lấy theo `max_streams` của VieNeu (`/health`): CPU fp32 = 1, GPU = 16. Mọi request đi qua một hàng đợi phía app, nên không bao giờ phải chờ bên trong VieNeu.
- **Tự phục hồi:**
  - VieNeu không gửi âm thanh sau 60 giây, ngừng giữa chừng 30 giây, hoặc bị kẹt luồng → app tự khởi động lại VieNeu, chờ nạp lại giọng rồi **tự đọc lại đoạn đó**.
  - VieNeu chết bất ngờ → được chạy lại, tối đa 3 lần trong 10 phút.
  - Mọi output của VieNeu và các sự kiện trên được ghi vào `.vieneu.log`.
- **Hiệu năng** (i7-6700, 4 nhân, không GPU): âm thanh đầu tiên khoảng 0,7–1,5 giây, tốc độ tạo xấp xỉ thời gian thực (RTF ~1,0), lần đọc đầu ngay sau khởi động chậm hơn (~6 giây). `VIENEU_PRECISION=int8` chỉ nhanh hơn khoảng 10% trên máy này.
- **Docker:** container không chứa VieNeu nên không tự chạy được. Chạy VieNeu ở máy host; `docker-compose.yml` đã trỏ `VIENEU_URL=http://host.docker.internal:8000`.

## Giọng địa phương (nhân bản từ ghi âm)

Trong khung **Giọng đọc** (tiếng Việt), bấm **Thêm giọng địa phương**:

1. **Thông tin giọng:** đặt tên, vùng miền (gợi ý sẵn Hà Nội, Nghệ An, Huế, Cần Thơ…), giới tính.
2. **Kiểm tra micro (nên làm):** chọn thiết bị (tai nghe, micro laptop…), giữ im lặng 2 giây để đo ồn nền, rồi đọc câu mẫu 5 giây. App báo mức tiếng nói, ồn nền, độ chênh (nên ≥ 20 dB) và vỡ tiếng, kèm lời khuyên cụ thể, cho nghe lại bản thử. Micro đã chọn được dùng luôn khi ghi âm thật.
3. **Ghi âm:** người có giọng quê đọc câu mẫu trên màn hình. Bấm **Ghi âm** (3–15 giây, có thanh đo mức âm theo dB) hoặc **Tải file lên** (bản ghi từ điện thoại, mọi định dạng trình duyệt đọc được).
4. **Tạo giọng:** tích xác nhận người trong ghi âm đồng ý, rồi bấm **Tạo giọng**. Mất khoảng 2–10 giây trên CPU.

Giọng mới được chọn ngay, nằm ở nhóm **Giọng địa phương của bạn**. Trong hộp thoại có danh sách giọng đã lưu: nghe lại bản ghi, nhãn chất lượng, nút **Lọc nhiễu** (cho giọng tạo trước khi có bộ lọc) và nút **Xóa**.

**Cách hoạt động:**

- **Ghi âm PCM thô:** micro được ghi qua AudioWorklet, **tắt** khử ồn, tự chỉnh âm lượng và khử vọng của trình duyệt. Các bộ xử lý đó làm giọng rè và chèn nhiễu, mà giọng nhân bản sẽ bắt chước theo.
- **Chuẩn hóa bản ghi:** trình duyệt chuyển bản ghi sang WAV mono 24 kHz, bỏ 0,15 giây đầu (tiếng "tách" khi mở micro), cắt khoảng lặng đầu/cuối theo **ngưỡng tương đối** (so với ồn nền và mức tiếng nói của chính bản ghi), rồi chuẩn hóa âm lượng ([src/lib/client/recording.ts](src/lib/client/recording.ts)).
- **Lọc nhiễu trên server:** [scripts/clean_voice.py](scripts/clean_voice.py) chạy bằng môi trường Python của VieNeu, gồm lọc thông cao 70 Hz, khử ồn phổ và rút ngắn khoảng lặng dài. Giọng nhân bản sao chép cả điều kiện thu âm, nên bước này bỏ được tiếng rè/ù nền trong mọi câu đọc. Bản ghi gốc vẫn được giữ (`*.raw.wav`) để lọc lại khi cần.
- **Nhãn chất lượng Rõ / Tạm / Rè:** đo bằng độ hài âm (HNR). Giọng rè hoặc vang (phòng vang, ngồi xa micro laptop) **không lọc được**. Nhãn **Rè** nghĩa là nên ghi lại gần micro (15–20 cm), trong phòng ít vang, tắt quạt/điều hòa.
- **Lưu và nạp lại giọng:** server gửi bản ghi cho VieNeu (`POST /v1/voices`) rồi lưu vào `.voices/` (đổi bằng `VOICES_DIR`). VieNeu chỉ giữ giọng nhân bản trong RAM, nên mỗi lần VieNeu khởi động lại, app **tự nạp lại** các giọng ở nền.
- **Mã giọng riêng:** mỗi giọng có mã `local-…`. Lọc lại hoặc tạo lại cùng tên sẽ ra mã mới, nên không bao giờ phát nhầm âm thanh cũ trong cache; lựa chọn giọng của bạn tự đi theo mã mới.
- **Giới hạn:** nhân bản zero-shot giữ được âm sắc và một phần ngữ điệu vùng miền. Muốn giọng địa phương đậm và ổn định hơn, VieNeu hỗ trợ fine-tune LoRA với 10–30 phút ghi âm (cần GPU), xem [VieNeu-TTS/finetune](https://github.com/pnnbao97/VieNeu-TTS).

## Truy cập từ máy khác trong mạng LAN

Server lắng nghe mọi địa chỉ, nên có thể mở bằng mọi IP của máy, ví dụ `http://192.168.168.96:3102` hoặc `http://192.168.121.31:3102`.

- **Chế độ dev:** `next.config.ts` đã khai báo `allowedDevOrigins` cho các dải mạng nội bộ. Thiếu khai báo này, trang mở bằng IP sẽ không chạy JavaScript (không tải được giọng, bộ đếm ký tự luôn 0).
- **Tường lửa Windows:** mạng ở chế độ **Public** chặn truy cập từ máy khác. Mở cổng một lần bằng PowerShell **Run as administrator**:

  ```powershell
  New-NetFirewallRule -DisplayName 'TTS Studio (cong 3102, mang LAN)' -Direction Inbound -Protocol TCP -LocalPort 3102 -RemoteAddress '192.168.0.0/16','10.0.0.0/8','172.16.0.0/12' -Action Allow -Profile Any
  ```

- **Proxy công ty:** nếu máy truy cập đi qua proxy, thêm `192.168.*` vào danh sách **bỏ qua proxy**, nếu không sẽ gặp "504 Gateway Time-out".
- **Micro qua IP:** trình duyệt chỉ cho ghi âm trên `http://localhost` hoặc HTTPS. Khi mở bằng IP, dùng **Tải file lên**, hoặc đặt HTTPS qua reverse proxy.

## Xử lý sự cố

| Hiện tượng | Nguyên nhân thường gặp | Cách xử lý |
|---|---|---|
| Mở bằng IP: "Đang tải…" mãi, 0 ký tự | Next dev chặn file JS cho origin lạ | Đã có `allowedDevOrigins`; nếu dùng dải IP khác, thêm vào `next.config.ts` |
| Máy khác mở bị "504 Gateway Time-out" | Tường lửa Windows chặn cổng 3102 / proxy | Xem mục [Truy cập từ máy khác](#truy-cập-từ-máy-khác-trong-mạng-lan) |
| "Đang khởi động VieNeu…" rất lâu | Lần đầu tải model từ HuggingFace | Chờ khoảng 5 phút; xem `.vieneu.log` |
| Đọc bằng giọng VieNeu báo lỗi treo / kẹt | VieNeu treo hoặc chết | App tự khởi động lại và đọc lại; nếu vẫn lỗi, gửi `.vieneu.log` |
| Giọng địa phương có tạp âm | Bản ghi mẫu nhiễu, vang hoặc rè | Bấm **Lọc nhiễu**; nếu nhãn là **Rè** thì ghi lại gần micro, phòng ít vang |
| Ghi âm báo "phần có tiếng nói quá ngắn" | Micro nhỏ hoặc chọn sai micro | Dùng **Kiểm tra micro**, chọn đúng thiết bị, nói gần hơn |
| `npm run typecheck` báo lỗi trong `.next/dev/types` | File type do Next dev sinh ra bị hỏng khi thêm route | Tắt và chạy lại `npm run dev` |

## Kiến trúc

```
src/
├─ instrumentation.ts       chạy VieNeu khi server Next khởi động
├─ app/
│  ├─ api/tts/route.ts      POST → luồng NDJSON (audio, cues, chunk, done)
│  ├─ api/voices/route.ts   GET  → giọng Neural của Edge (cache 12 giờ, có danh sách dự phòng)
│  ├─ api/vieneu/voices/    GET  → trạng thái VieNeu + giọng mẫu + giọng địa phương (?refresh=1: thử lại)
│  ├─ api/vieneu/custom-voices/          GET danh sách · POST tạo · DELETE ?id= xóa
│  ├─ api/vieneu/custom-voices/clean/    POST ?id= lọc nhiễu lại (trả về mã giọng mới)
│  ├─ api/vieneu/custom-voices/audio/    GET ?id= bản ghi mẫu (WAV)
│  └─ api/health/route.ts   kiểm tra liveness cho Docker/Coolify
├─ lib/
│  ├─ edge-tts/             client WebSocket, token Sec-MS-GEC, danh sách giọng
│  ├─ vieneu/client.ts      client VieNeu (OpenAI API): hàng đợi, phát hiện treo, tự phục hồi, stream PCM
│  ├─ vieneu/launcher.ts    chạy / giám sát / khởi động lại VieNeu, ghi .vieneu.log
│  ├─ vieneu/custom-voices.ts  lưu giọng địa phương, lọc nhiễu, nạp lại khi VieNeu khởi động
│  ├─ audio/mp3-encoder.ts  mã hóa PCM → MP3 24 kHz 96 kbps theo luồng (lamejs)
│  ├─ audio/mp3.ts          tính thời lượng chính xác từ frame MP3
│  ├─ text/chunker.ts       thuật toán chia đoạn
│  ├─ text/ssml.ts          escape XML, tạo SSML
│  ├─ tts/pipeline.ts       tổng hợp song song, phát ra đúng thứ tự, chọn engine theo giọng
│  ├─ tts/server-cache.ts   cache đoạn trong RAM + trên đĩa
│  ├─ subtitles.ts          xuất SRT / VTT
│  └─ client/               trình phát MSE, cache IndexedDB, ghi âm PCM + đo mức âm (recording.ts)
├─ hooks/                   useTts, useVoices, useVieneuVoices, useActiveCue, useLocalStorage
└─ components/              TtsApp, TextEditor, VoiceSettings, VoiceCloneDialog, MicTest,
                            PlayerControls, LiveCaptions, DownloadPanel
scripts/clean_voice.py      lọc nhiễu bản ghi mẫu + đo chất lượng (chạy bằng Python của VieNeu)
```

Dữ liệu khi chạy (không commit): `.tts-cache/` (cache đoạn), `.voices/` (giọng địa phương), `.vieneu.log` (nhật ký VieNeu).

### Luồng streaming

1. **Chia đoạn:** server chia văn bản với kích thước đoạn **tăng dần** (Edge: 200 → 400 → 800 → … → 3000 byte; VieNeu: tối đa 600 byte). Đoạn đầu nhỏ nên có âm thanh sớm.
2. **Tổng hợp song song:** nhiều đoạn được tạo cùng lúc (Edge: `TTS_CONCURRENCY`; VieNeu: theo `max_streams`). Đoạn ở đầu hàng đợi được chuyển tiếp **từng frame**, các đoạn sau được giữ trong bộ đệm và phát ra đúng thứ tự.
3. **Backpressure:** `ReadableStream` dạng pull, nên server chỉ tạo tiếp khi client đọc. Client ngắt kết nối thì các WebSocket tới Edge bị hủy. Riêng request tới VieNeu thì **không cắt ngang** mà đọc nốt đoạn đang tạo rồi bỏ đi, vì cắt ngang làm VieNeu mất luồng xử lý.
4. **Phát ở trình duyệt:** từng frame được đưa vào `SourceBuffer` ở chế độ `sequence`. `audio.currentTime` khớp trực tiếp với timeline của cue, vì mỗi đoạn bắt đầu tại tổng thời lượng các đoạn trước (tính chính xác từ frame MP3, không lệch dần).
5. **Văn bản rất dài:** trình phát chỉ đệm trước tối đa 3 phút. Khi luồng kết thúc, trình phát chuyển sang file MP3 hoàn chỉnh để tua được toàn bộ.

### Hiệu năng đo thực tế

| Giọng | Âm thanh đầu tiên | Tốc độ tạo |
|---|---|---|
| `en-US-AvaNeural` (Edge) | ~1,3 s | ~12× thời gian thực |
| `vi-VN-HoaiMyNeural` (Edge) | 2,5–7 s (do máy chủ Microsoft) | ~1× mỗi kết nối, ~2–3× khi song song |
| VieNeu (CPU i7-6700) | 0,7–1,5 s | ~1× thời gian thực |
| Phát lại từ cache | ~0,3 s | tức thì |

## Cấu hình

Mọi biến môi trường đều tùy chọn, mô tả chi tiết trong [.env.example](.env.example).

| Nhóm | Biến chính |
|---|---|
| Chung | `PORT`, `TTS_MAX_TEXT_LENGTH`, `CACHE_MEMORY_MB`, `CACHE_DIR`, `CACHE_DISK_MAX_MB` |
| Edge | `TTS_CONCURRENCY`, `TTS_MAX_CHUNK_BYTES`, `TTS_FIRST_CHUNK_BYTES`, `TTS_CHUNK_TIMEOUT_MS`, `TTS_MAX_RETRIES`, `EDGE_CHROMIUM_VERSION` |
| VieNeu | `VIENEU_URL`, `VIENEU_AUTOSTART`, `VIENEU_DIR`, `VIENEU_UV`, `VIENEU_API_KEY`, `VIENEU_MODEL`, `VIENEU_CONCURRENCY`, `VIENEU_MAX_CHUNK_BYTES`, `VIENEU_FIRST_BYTE_TIMEOUT_MS`, `VIENEU_TIMEOUT_MS`, `VIENEU_LOG_FILE`, `VIENEU_PRECISION` (truyền cho VieNeu) |
| Giọng địa phương | `VOICES_DIR`, `VIENEU_CLEAN_SCRIPT` |
| API đối tác | `CLIENTS_FILE`, `USAGE_DIR`, `V1_MAX_CONCURRENT`, `INTERNAL_BASIC_AUTH` |

## API

Hai lớp API:

- **`/api/v1/*`, cho đối tác bên ngoài:** có API key, giới hạn, ghi nhận sử dụng, giọng nhân bản tách riêng theo từng đối tác. Tài liệu gửi đối tác: [docs/API.md](docs/API.md). Cách vận hành: mục [Cung cấp API cho đối tác](#cung-cấp-api-cho-đối-tác).
- **Các route bên dưới, dành cho web UI nội bộ:** không có API key. Khi mở server ra Internet, hãy khóa lại bằng `INTERNAL_BASIC_AUTH`.

`POST /api/tts`, body `{ "text": "...", "voice": "vi-VN-HoaiMyNeural", "rate": 0, "pitch": 0, "volume": 0 }`

Response `application/x-ndjson`, mỗi dòng là một sự kiện:

```jsonc
{"type":"start","totalChunks":3,"totalChars":1127}
{"type":"audio","index":0,"data":"<base64 MP3>"}          // lặp lại nhiều lần, ghép theo thứ tự ra 1 file MP3
{"type":"cues","index":0,"cues":[{"id":0,"start":0.1,"end":1.8,"text":"Xin chào!"}]}
{"type":"chunk","index":0,"start":0,"duration":17.09,"cached":false}
{"type":"done","duration":83.1,"cachedChunks":0}
```

- **Tham số:** `rate` là %, trong khoảng −100…200; `pitch` là Hz, trong khoảng −100…100; `volume` là %, trong khoảng −100…100.
- **Giọng VieNeu:** `"voice": "vieneu:<tên giọng>"`, ví dụ `"vieneu:Mai Anh"`. Giọng địa phương dùng mã `"vieneu:local-…"`. Danh sách lấy từ `GET /api/vieneu/voices`. `rate` và `pitch` bị bỏ qua.
- **Tạo giọng địa phương:** `POST /api/vieneu/custom-voices`, dạng `multipart/form-data`, gồm `name`, `region`, `gender` (`Female` | `Male`), `denoise` (`true` | `false`), `consent=true`, `file` (WAV 3–20 giây).

## Cung cấp API cho đối tác

**Quản lý đối tác** bằng [scripts/clients.mjs](scripts/clients.mjs) (Docker: `docker compose exec tts node scripts/clients.mjs …`). App tự đọc lại khi file thay đổi, không cần khởi động lại:

```bash
node scripts/clients.mjs add "Công ty ABC" --cloning   # in API key MỘT lần duy nhất, gửi cho đối tác
node scripts/clients.mjs list
node scripts/clients.mjs set <id> charsPerMonth=2000000 requestsPerMinute=30 engines=vieneu
node scripts/clients.mjs rotate <id>                   # cấp key mới, key cũ hết hiệu lực ngay
node scripts/clients.mjs disable <id>                  # hoặc enable
node scripts/clients.mjs usage [<id>] [2026-10]        # số ký tự tính phí theo tháng
```

- **Key:** chỉ lưu SHA-256 của key trong `.clients/clients.json`, không lưu key gốc.
- **Giới hạn** mỗi đối tác: `maxCharsPerRequest` (5.000), `charsPerMonth` (1.000.000; 0 = không giới hạn), `requestsPerMinute` (20), `maxConcurrent` (1), `allowCloning` (false), `maxVoices` (10), `engines` (`vieneu,edge`). Toàn server chạy tối đa `V1_MAX_CONCURRENT` request cùng lúc (mặc định 2), vượt thì trả 429/503 kèm `Retry-After` thay vì xếp hàng.
- **Ghi nhận sử dụng:** mỗi request một dòng trong `.usage/<YYYY-MM>.ndjson` (giờ Việt Nam). Chỉ tính ký tự của phần âm thanh đã gửi đi, nên request lỗi không bị tính phí.
- **Giọng nhân bản:** mỗi giọng gắn với đối tác đã tạo nó (`ownerId`), cùng bằng chứng đồng ý (`speaker_name`, `consent_statement`, thời điểm, IP). Đối tác khác và web UI nội bộ không thấy, không dùng, không xóa được giọng đó.
- **Khóa phần nội bộ:** đặt `INTERNAL_BASIC_AUTH=user:mật-khẩu` để web UI và các route `/api/tts`, `/api/voices`, `/api/vieneu/*` đòi đăng nhập ([src/proxy.ts](src/proxy.ts)). `/api/v1/*` và `/api/health` không bị chặn.
- **HTTPS:** dùng [Caddyfile](Caddyfile) mẫu (tự cấp chứng chỉ, không đệm luồng, timeout 15 phút).
- **Sao lưu định kỳ** `.clients/`, `.usage/`, `.voices/`. Đây là dữ liệu không tạo lại được (Docker: volume `tts-clients`, `tts-usage`, `tts-voices`).
- **Năng lực trên CPU:** VieNeu chỉ chạy 1 luồng, nhanh xấp xỉ thời gian thực. Như vậy chỉ đủ cho vài đối tác lưu lượng thấp; muốn phục vụ nhiều hơn cần GPU (16 luồng).

## Triển khai (self-host)

### Docker Compose (VPS Linux bất kỳ)

```bash
git clone <repo> tts-studio && cd tts-studio
docker compose up -d --build        # http://<server-ip>:3102
# Đổi cổng: HOST_PORT=8080 docker compose up -d
```

- **Dữ liệu bền:** cache và giọng địa phương nằm trong volume `tts-cache` và `tts-voices`, nên còn nguyên sau khi build lại.
- **HTTPS:** nên đặt reverse proxy (Caddy, Nginx, Traefik) phía trước; HTTPS cũng là điều kiện để ghi âm bằng micro từ máy khác.
- **Streaming qua proxy:** response đã có sẵn header `X-Accel-Buffering: no` và `Cache-Control: no-transform` để Nginx không đệm luồng.

### Coolify + Cloudflare Tunnel

File `docker-compose.coolify.yml` chạy 2 container: `tts` (app) và `vieneu` (VieNeu-TTS bản CPU, build từ repo gốc, ghim commit). `vieneu` chỉ nằm trong mạng nội bộ, không có domain.

1. **Coolify → Sources**: kết nối GitHub App (repo private) hoặc dùng Public Repository.
2. **New Resource → chọn repo → Build Pack: Docker Compose**, Docker Compose Location: `/docker-compose.coolify.yml`.
3. **Domain của service `tts`**: `http://tts.<domain>:3102`. Dùng **`http://`** vì Cloudflare đã lo HTTPS; nếu nhập `https://`, Traefik sẽ cố xin chứng chỉ Let's Encrypt phía sau tunnel và dễ gây redirect loop. Để trống domain của `vieneu`.
4. **Environment Variables**: bắt buộc `INTERNAL_BASIC_AUTH=user:matkhau` (web public). Tùy chọn `VIENEU_PRECISION=int8` (nhanh hơn trên CPU có VNNI), `V1_MAX_CONCURRENT`, `VIENEU_API_KEY` (dùng chung cho cả hai service).
5. **Cloudflare Zero Trust → Networks → Tunnels → (tunnel) → Public Hostname → Add**:
   - Subdomain `tts`, Domain `<domain>`, Type `HTTP`
   - URL: `localhost:80` nếu cloudflared chạy trên host; `coolify-proxy:80` nếu cloudflared chạy dạng container trong mạng `coolify`.
   - Trỏ vào **Traefik (cổng 80)**, không trỏ thẳng cổng 3102. Không đặt HTTP Host Header, vì Traefik định tuyến theo host `tts.<domain>`.
6. **Deploy**. Lần đầu VieNeu tải model từ Hugging Face (mất vài phút, lưu trong volume `vieneu-hf-cache`). Trong lúc đó Edge TTS vẫn dùng được, giọng VieNeu hiện ra khi đã sẵn sàng.
7. **Quản lý client của partner API**: Coolify → service `tts` → Terminal: `node scripts/clients.mjs …`.

Lưu ý:
- Cloudflare trả lỗi 524 nếu sau 100 giây chưa có byte đầu tiên. App đã stream chunk đầu rất nhỏ nên bình thường không gặp; chỉ nên tránh thử ngay lúc VieNeu còn đang nạp model.
- Upload bị giới hạn 100 MB (gói Free), dư sức cho file ghi âm 5 MB.
- VieNeu CPU cần khoảng 2–4 GB RAM. Với fp32, 6 core chỉ đủ cho 1 luồng chạy kịp thời gian thực.
- Công cụ lọc nhiễu `clean_voice.py` không chạy trong Docker, nên giọng clone được dùng nguyên như bản ghi.

### Railway

1. **New Project → Deploy from GitHub repo**. Railway tự nhận `Dockerfile`.
2. Railway tự đặt biến `PORT`, server standalone sẽ đọc biến này.
3. (Tùy chọn) Thêm Volume mount vào `/app/.tts-cache` để giữ cache giữa các lần deploy.

### Không dùng Docker

```bash
npm ci && npm run build
cp -r public .next/standalone/ && cp -r .next/static .next/standalone/.next/
cd .next/standalone && PORT=3102 HOSTNAME=0.0.0.0 node server.js
```

## Lưu ý

- Edge TTS là dịch vụ không chính thức, không có SLA, Microsoft có thể thay đổi giao thức. Nếu gặp HTTP 403 kéo dài, hãy tăng `EDGE_CHROMIUM_VERSION` lên phiên bản Edge mới nhất.
- Giới hạn tần suất chỉ áp dụng cho `/api/v1` và nằm trong RAM của một instance. Các route nội bộ không có giới hạn, nên phải khóa bằng `INTERNAL_BASIC_AUTH` khi mở công khai.
- Chỉ nhân bản giọng của người đã đồng ý. App bắt buộc tích xác nhận trước khi tạo giọng.
