# Nhật ký phát triển TTS Studio (thực chiến)

Tài liệu này ghi lại quá trình phát triển TTS Studio: từ bản Edge TTS ban đầu tới giọng offline VieNeu, giọng địa phương, lọc nhiễu, kiểm tra micro và tự phục hồi. Nội dung gồm cả những lần sửa sai, vì phần đáng học nhất thường nằm ở đó.

Mỗi giai đoạn được ghi theo cùng một khung:

> **Yêu cầu** → **Hiện tượng** → **Điều tra** (kèm số liệu đo được) → **Nguyên nhân gốc** → **Giải pháp** → **Kiểm chứng** → **Bài học**

Môi trường: Windows 10, Intel i7-6700 (4 nhân, **không GPU**), Node.js 24, Next.js 16, VieNeu-TTS 3.8.3 (ONNX, CPU), máy có hai card mạng `192.168.168.96` và `192.168.121.31`.

## Dòng thời gian

| # | Giai đoạn | Kết quả chính |
|---|---|---|
| 0 | Hiện trạng ban đầu (24/09/2026) | Edge TTS Studio: Edge TTS, streaming, phụ đề karaoke, cache |
| 1 | Mở bằng IP không tải được giọng | `allowedDevOrigins` cho mạng nội bộ |
| 2 | Thêm engine VieNeu-TTS offline | Gọi API OpenAI của VieNeu, mã hóa PCM → MP3 trên server |
| 3 | VieNeu thành mặc định, tự khởi động | Tiến trình con, một danh sách giọng, hàng đợi theo `max_streams` |
| 4 | Giọng địa phương (nhân bản giọng) | Ghi âm → đăng ký với VieNeu → lưu `.voices/`, tự nạp lại |
| 5 | Lỗi "120 giây" lần 1: rò luồng xử lý | Hàng đợi phía app, đọc nốt thay vì cắt, phát hiện kẹt, tự khởi động lại |
| 6 | Tạp âm trong giọng địa phương | Bộ lọc nhiễu, đo HNR + nhãn chất lượng, MP3 96 kbps, ghi PCM thô |
| 7 | 504 khi truy cập bằng IP từ máy khác | Tường lửa Windows (mạng Public) chặn cổng 3102 |
| 8 | Ghi âm chỉ còn 0,2 giây | Ngưỡng cắt khoảng lặng tương đối + tính năng Kiểm tra micro |
| 9 | Lỗi "120 giây" lần 2: VieNeu treo/chết | Tự phục hồi và đọc lại, `.vieneu.log`, sửa lỗi trạng thái khi hot reload |

---

## Giai đoạn 0 · Hiện trạng ban đầu

Dự án ban đầu tên **Edge TTS Studio**, viết khoảng ngày 24/09/2026:

- **Engine:** client WebSocket tự viết gọi endpoint "Read Aloud" của Microsoft Edge, miễn phí, không cần API key.
- **Không giới hạn độ dài:** văn bản được chia đoạn theo byte UTF-8 sau khi escape XML, các đoạn tổng hợp song song rồi phát ra đúng thứ tự.
- **Streaming:** frame MP3 được chuyển tiếp qua NDJSON, trình duyệt phát bằng MediaSource Extensions.
- **Phụ đề karaoke:** dựa trên mốc `SentenceBoundary` của Edge.
- **Cache hai tầng:** IndexedDB ở trình duyệt; LRU trong RAM và file theo từng đoạn ở server.
- **Triển khai:** Docker, Coolify, Railway.

**Điểm yếu nhận thấy ngay từ đầu:** chưa có test tự động, thư mục chưa dùng git, không có rate limit, và phụ thuộc vào một dịch vụ Edge không chính thức.

---

## Giai đoạn 1 · Mở bằng địa chỉ IP thì không tải được giọng đọc

**Hiện tượng.** Mở `http://192.168.168.96:3102` thì khung chọn giọng hiện "Đang tải…" mãi. Có một chi tiết quan trọng: ô văn bản có chữ nhưng bộ đếm vẫn báo **"0 ký tự · 0 từ"**.

**Điều tra.** Bộ đếm sai nghĩa là **React chưa hydrate**, tức JavaScript phía client không chạy. Vậy lỗi không nằm ở API giọng đọc. Tài liệu Next 16 trong `node_modules/next/dist/docs/` ghi rằng dev server **chặn file dev (`/_next/*`) cho origin lạ**, mặc định chỉ cho `localhost`.

**Nguyên nhân gốc.** Next.js 16 ở chế độ dev chặn cross-origin với tài nguyên dev.

**Giải pháp.** Thêm vào `next.config.ts`:

```ts
allowedDevOrigins: ['192.168.*.*', '10.*.*.*', '*.local'],
```

Trước khi áp dụng, tôi đọc mã khớp wildcard trong `csrf-protection.js` để chắc rằng `*` khớp được từng nhóm số của địa chỉ IP.

**Kiểm chứng.** Tải file JS với `Referer` là địa chỉ IP trả về 200, `/api/voices` trả về 200.

**Bài học.**
- Nhìn vào **triệu chứng phụ** (bộ đếm ký tự bằng 0) để khoanh vùng lỗi nhanh hơn triệu chứng chính.
- Với phiên bản framework mới, đọc tài liệu đi kèm package trước, đừng dựa vào trí nhớ.

---

## Giai đoạn 2 · Thêm engine VieNeu-TTS offline

**Yêu cầu.** Thêm lựa chọn model [VieNeu-TTS](https://github.com/pnnbao97/VieNeu-TTS) chạy offline.

**Điều tra.**
- **VieNeu là server Python riêng** (`uv run python -m apps.openai_speech`, cổng 8000), có API tương thích OpenAI: `POST /v1/audio/speech`, `GET /v1/voices`, `GET /v1/models`, `GET /health`.
- **Định dạng đầu ra:** VieNeu **chỉ trả PCM/WAV**; yêu cầu mp3/opus trả lỗi 400.
- **Chuẩn của app:** toàn bộ app chạy trên MP3 (MSE, tính thời lượng từ frame MP3, cache, nút tải MP3).

**Quyết định kiến trúc.** Mã hóa **PCM → MP3 trên server, theo luồng**, bằng `@breezystack/lamejs`, ra đúng định dạng Edge dùng (MPEG-2 Layer III, 24 kHz, mono). Nhờ vậy phía trình duyệt gần như không phải sửa. Tôi thử nhanh bộ mã hóa: 1 giây âm thanh mất khoảng 90 ms, header `fff364c4` đúng MPEG-2 Layer III 48 kbps.

**Các điểm kỹ thuật.**
- **Mã giọng:** giọng VieNeu có tiền tố `vieneu:` (ví dụ `vieneu:Mai Anh`); engine được suy ra từ tên giọng.
- **Mẫu (sample) bị cắt đôi:** PCM s16le có thể đến với số byte lẻ, nên phải giữ lại byte thừa để ghép với lần sau.
- **Phụ đề:** VieNeu không trả mốc thời gian, nên phụ đề được ước lượng theo độ dài câu (dùng lại hàm `estimateCues` có sẵn).
- **Cache:** khóa cache gồm cả tên model VieNeu.

**Lỗi gặp khi kiểm thử.** Mọi giọng VieNeu đều bị báo "tên giọng không hợp lệ". Nguyên nhân: regex viết bằng template string `` `…[\p{L}…]` ``. Trong template string, `\p` bị hiểu thành chữ `p`, nên regex sai hoàn toàn. Sửa bằng regex literal `/^vieneu:[\p{L}\p{M}\p{N} _.'()-]{1,80}$/u`.

**Kiểm chứng bằng mock server.** Lúc đó máy chưa cài VieNeu, nên tôi viết một server Node giả lập API của VieNeu: trả PCM hình sin và cố ý gửi số byte lẻ để thử đúng đoạn code ghép mẫu. Kết quả: stream 34 mảnh MP3 hợp lệ, thời lượng đúng, cache trúng 7/7 đoạn ở lần thứ hai (310 ms), và báo lỗi tiếng Việt rõ ràng khi VieNeu tắt.

**Bài học.**
- Khi thiếu hệ thống thật, **mock đúng giao thức** để kiểm thử cả các ca biên (byte lẻ, server tắt).
- Không dùng `\p{…}` trong template string; nếu cần regex động, dùng `String.raw` hoặc escape `\\p`.

---

## Giai đoạn 3 · VieNeu thành mặc định, tự khởi động

**Yêu cầu.** Mặc định dùng VieNeu, người dùng chỉ cần chọn giọng đọc.

**Việc đã làm.**
- **Cài VieNeu** vào `J:\ThucHanh_AI\VieNeu-TTS`, **cạnh** dự án chứ không nằm trong dự án, để file watcher của Next không phải quét thư mục `.venv` lớn. Cài bằng `uv sync` bản CPU; lần đầu tải model mất khoảng 5,5 phút.
- **Tự khởi động:** `src/instrumentation.ts`, hàm `register()` chạy khi server Next khởi động, gọi `launcher.ts` để chạy VieNeu làm tiến trình con **mà không chờ** (`register` chặn server cho tới khi xong, nên không được chờ model tải).
- **Giao diện:** bỏ nút chuyển engine, chỉ còn **một danh sách giọng**: giọng VieNeu lên trước, giọng Edge phía dưới. Khi VieNeu đang khởi động, app chờ chứ không lặng lẽ chọn giọng Edge.

**Những điều phát hiện khi đọc mã nguồn VieNeu** (đọc tận file `apps/openai_speech.py`):

| Phát hiện | Hệ quả |
|---|---|
| `speed` được nhận nhưng **bị bỏ qua** (header `X-VieNeu-Ignored`) | Khóa thanh Tốc độ khi dùng giọng offline (bản trước tôi ghi nhầm là có hỗ trợ) |
| CPU fp32 chỉ chạy **1 luồng** cùng lúc | App đọc `max_streams` từ `/health` để đặt số đoạn tạo song song |
| Request dư phải chờ tối đa `VIENEU_QUEUE_TIMEOUT` (mặc định 10 giây) rồi nhận **429** | Xử lý 429 bằng cách chờ `Retry-After` |
| `featured` là **thứ hạng** (1, 2, 3…), không phải true/false | Sắp xếp theo thứ hạng; giọng mặc định là giọng nữ có hạng cao nhất (Trúc Ly) |

**Đo đạc.** fp32 có RTF 0,99, âm thanh đầu tiên sau khoảng 0,75 giây. int8 có RTF 0,88 (CPU Skylake không có VNNI). Chênh lệch chỉ khoảng 10%, nên tôi giữ fp32 để có chất lượng tốt hơn.

**Sự cố khi viết README.** Tôi viết README bằng lệnh `node -e "…"` đặt trong dấu nháy kép của bash. Các dấu backtick trong nội dung markdown bị bash **thực thi thành lệnh thật** (`git clone`, `uv sync`, `uv run`). May là tất cả đều thất bại mà không để lại tác dụng phụ; tôi đã kiểm tra lại thư mục và git status của VieNeu.

**Bài học.**
- **Đọc mã nguồn thư viện** thay vì tin tài liệu tóm tắt: tài liệu ghi có `speed`, nhưng mã thì bỏ qua nó.
- **Không bao giờ nhúng markdown có backtick vào lệnh shell.** Dùng công cụ ghi file (Write/Edit) hoặc heredoc có nháy đơn (`<<'EOF'`).

---

## Giai đoạn 4 · Giọng địa phương (nhân bản giọng)

**Yêu cầu.** Thu ghi âm giọng quê của một người để tạo giọng đọc địa phương.

**Điều tra.**
- **Có sẵn endpoint:** VieNeu có `POST /v1/voices` (form gồm `name`, `file`, `denoise`, `description`), nhân bản zero-shot từ 3–8 giây ghi âm.
- **Chỉ lưu trong RAM:** docstring ghi *"in memory, for this process"*, nên giọng mất khi VieNeu khởi động lại.
- **Tên giọng:** chỉ gồm chữ, số, khoảng trắng và các ký tự `.`, `-`, `_`.
- **Đo thời gian đăng ký giọng:** lần đầu **109 giây** (tải model mã hóa giọng), sau đó khoảng 9 giây nếu bật denoise, 2 giây nếu tắt.

**Thiết kế.**
- **App là nguồn dữ liệu gốc:** mỗi giọng được lưu thành `.voices/index.json` và `<id>.wav`. Khi thấy VieNeu thiếu giọng nào, app tự đăng ký lại ở nền.
- **Mã giọng riêng:** mỗi giọng có mã duy nhất `local-<thời gian><ngẫu nhiên>`, tách khỏi tên hiển thị. Xóa rồi tạo lại cùng tên không bao giờ phát nhầm âm thanh cũ trong cache, ở cả server lẫn trình duyệt.
- **Xóa giọng:** VieNeu không có endpoint xóa. Giọng bị xóa được **ẩn** (mọi mã `local-…` không có trong dữ liệu của app đều bị lọc khỏi danh sách) và không bao giờ đăng ký lại.
- **Trình duyệt:** MediaRecorder cho ra WebM, mà VieNeu chọn bộ giải mã theo đuôi file và không đọc WebM. Vì vậy mọi bản ghi được giải mã rồi mã hóa lại thành WAV ngay ở trình duyệt.
- **Đồng ý:** bắt buộc tích xác nhận người trong ghi âm đồng ý.

**Lỗi môi trường gặp phải.**
- **Route mới trả 404:** file route nằm trong thư mục vừa tạo cùng một lệnh với thư mục cha, nên watcher của Next dev không thấy. Ghi lại file một lần là được.
- **File type bị hỏng:** file type do Next sinh ra (`.next/dev/types/routes.d.ts`) bị ghi đè không cắt bớt độ dài, còn sót đuôi cũ, làm `tsc` báo lỗi. Tạm thời typecheck riêng `src/` bằng một tsconfig phụ; tắt và chạy lại `npm run dev` là hết.

**Kiểm chứng.** Tạo giọng mất 6 giây, đọc bằng giọng mới thành công. Tắt VieNeu rồi chạy lại: khoảng 60 giây sau giọng được nạp lại tự động.

---

## Giai đoạn 5 · Lỗi "VieNeu-TTS không gửi dữ liệu trong 120 giây" (lần 1)

**Hiện tượng.** Đọc bằng giọng địa phương thì treo 120 giây rồi báo lỗi.

**Điều tra.**
- `GET /health` trả về `"active":1,"waiting":1`: một luồng đang chiếm chỗ duy nhất.
- CPU của tiến trình python là **0 giây trong 5 giây đo**, và **không có kết nối nào đang mở**. Vậy VieNeu không bận, mà đang **giữ luồng "ma"**.
- Đọc code `speech()` của VieNeu:

  ```python
  eng.acquire()                  # lấy luồng NGAY trong handler
  chunks = _speech_chunks(...)   # generator: release() nằm trong finally của nó
  return StreamingResponse(...)
  ```

**Nguyên nhân gốc (lỗi của VieNeu).** Luồng được lấy **trước** khi stream, nhưng chỉ được trả trong `finally` của generator. Client ngắt kết nối **trước khi stream bắt đầu** thì generator không bao giờ chạy, nên luồng **không bao giờ được trả**. Về sau thử nghiệm cho thấy ngắt **giữa chừng** cũng bị rò như vậy.

**Hai yếu tố làm lỗi nặng thêm (do tôi):**
1. Tôi từng đặt `VIENEU_QUEUE_TIMEOUT=3600`. Request bị bỏ vẫn nằm chờ trong hàng đợi tới 1 giờ, tới lượt thì lại rò thêm một luồng.
2. Khi tắt `npm run dev`, app chỉ kill tiến trình `uv`. Trên Windows, **python con vẫn sống** thành tiến trình mồ côi, giữ cổng 8000 với trạng thái đã hỏng, và lần chạy sau app tưởng đó là server bình thường.

**Giải pháp (không sửa mã VieNeu):**

| Biện pháp | Vì sao |
|---|---|
| **Hàng đợi phía app** (`StreamGate`): không bao giờ gửi quá `max_streams` request | Request bị hủy chỉ rời hàng đợi của app, không tạo request "ma" trong VieNeu |
| **Không cắt ngang request tới VieNeu:** khi người dùng bấm Dừng, app ngừng phát nhưng **đọc nốt** đoạn đang tạo | Để VieNeu tự trả luồng. Đoạn VieNeu giảm xuống 600 byte để phần đọc nốt ngắn (khoảng 13 giây) |
| **Phát hiện kẹt:** app không có request nào đang chạy mà `/health` báo đầy luồng thì coi là rò | Khởi động lại VieNeu, kể cả khi đó là tiến trình mồ côi: tìm PID giữ cổng bằng `netstat` rồi `taskkill` |
| **Kill cả cây tiến trình:** `taskkill /PID … /T /F` | Diệt cả python con, không để lại tiến trình mồ côi |
| Queue của VieNeu: `8`, timeout `30` giây | Giới hạn thiệt hại nếu vẫn có request lọt vào hàng đợi |

**Kiểm chứng.**
- **Trước khi sửa:** hủy request đang stream thì `active` kẹt ở 1 mãi.
- **Sau khi sửa:** hủy cùng lúc 3 request (một đang stream, một đang chờ, một hủy ngay) thì luồng được trả sau 13 giây, request kế tiếp chạy bình thường, không phải khởi động lại.

**Bài học.**
- **Đo trạng thái bên trong** (`active`, `waiting`, CPU, số kết nối) trước khi đoán mò.
- Tài nguyên được **lấy ở handler** nhưng **trả trong generator** là mẫu dễ rò kinh điển với StreamingResponse.
- Trên Windows, kill tiến trình cha **không** kill tiến trình con.

---

## Giai đoạn 6 · Tạp âm trong giọng địa phương

**Hiện tượng.** Nghe file đọc bằng giọng địa phương thấy có tạp âm. Bạn nghi do bản ghi mẫu bị nhiễu.

**Điều tra, bước 1: số liệu tổng quát.** Tôi viết script Python chạy bằng môi trường của VieNeu (numpy, soundfile). Kết quả: SNR khoảng 59 dB, không vỡ tiếng, không có tiếng ù 50 Hz. Nhìn các số này thì **không thấy** nhiễu nền rõ ràng.

**Điều tra, bước 2: đo trong lúc có tiếng nói.** So bản ghi mẫu với một giọng mẫu sạch (preset):

| Chỉ số | Bản ghi mẫu | Giọng nhân bản | Giọng mẫu sạch |
|---|---|---|---|
| Năng lượng > 5 kHz khi nói | 0,69% | 0,69% | 0,12% |
| Độ phẳng phổ 4–10 kHz (1 = nhiễu trắng) | 0,66 | 0,66 | 0,48 |
| Mẫu gần như bằng 0 | 10,8% | 7,6% | 4,2% |

Giọng nhân bản **sao chép y hệt** đặc tính nhiễu của bản ghi mẫu. Tỉ lệ 10,8% mẫu bằng 0 cho thấy bộ khử ồn của trình duyệt đã cắt câm các khoảng lặng.

**Điều tra, bước 3: nhìn tận mắt.** Tôi vẽ spectrogram thành ảnh PNG để xem:
- **Bản ghi mẫu:** hạt nhiễu trải khắp dải tần trong lúc nói, một tiếng rít khoảng 7 kHz, một khoảng lặng dài khoảng 2 giây.
- **Giọng nhân bản:** có thêm tiếng "rè" ở các khoảng nghỉ.
- **Giọng mẫu sạch:** các vạch hài âm sắc nét.

**Thử các cách lọc:**
- **Bộ khử ồn có sẵn của VieNeu** (resemble-enhance): hầu như không đổi gì (0,69% → 0,72%).
- **Bộ lọc tự viết** (lọc thông cao, khử ồn phổ theo minimum statistics, rút ngắn khoảng lặng): **khoảng nghỉ trong giọng nhân bản sạch hẳn**, năng lượng cao tần giảm từ 0,69% xuống 0,38%.
- **Bộ khử tiếng click:** phát hiện nhầm 236 "click" ngay trên giọng mẫu sạch. Soi dạng sóng thì thấy các vạch sáng trên spectrogram là **phụ âm xát** ("s", "x"), không phải click. Tôi bỏ bước này.

**Phát hiện then chốt: độ hài âm (HNR).**

| File | HNR trung vị |
|---|---|
| Giọng mẫu sạch | **+8,9 dB** |
| Bản ghi mẫu | **−0,9 dB** |
| Sau khi lọc | −0,9 dB (không đổi) |

Giọng trong bản ghi **tự thân đã rè hoặc hơi**. Nguyên nhân thường là phòng vang, ngồi xa micro laptop, hoặc bộ khử ồn của trình duyệt. Không bộ lọc nào khôi phục được hài âm đã mất.

**Nguồn nhiễu thứ hai: MP3 48 kbps.** Spectrogram của file ra từ app có các mảng "thủng phổ". So với PCM gốc:

| Bitrate | SNR so với PCM |
|---|---|
| 48 kbps | 19,6 dB |
| 64 kbps | 24,4 dB |
| **96 kbps** | **25,8 dB** |
| 128 kbps | 25,8 dB |

**Giải pháp.**
- **Bộ lọc** [scripts/clean_voice.py](../scripts/clean_voice.py) chạy tự động khi tạo giọng. Giọng cũ có nút "Lọc nhiễu"; lọc lại sẽ cấp **mã giọng mới** (để không phát lại cache cũ), mã cũ lưu trong `previousIds` để lựa chọn của người dùng tự đi theo.
- **Đo HNR** và gắn nhãn **Rõ / Tạm / Rè**, kèm hướng dẫn ghi lại cụ thể.
- **MP3 cho VieNeu nâng lên 96 kbps**; đổi luôn khóa cache ở cả server lẫn trình duyệt để bỏ âm thanh 48 kbps cũ.
- **Ghi âm PCM thô** qua AudioWorklet, **tắt** khử ồn, tự chỉnh âm lượng và khử vọng của trình duyệt.

**Bài học.**
- **"SNR tốt" không có nghĩa là "giọng sạch".** Cần chọn đúng thước đo (HNR) cho đúng loại nhiễu.
- **Kiểm chứng bằng mắt** (spectrogram) trước khi tin một con số.
- Có **nhiều nguồn nhiễu chồng nhau** (bản ghi, bộ mã hóa MP3); phải tách từng nguồn ra đo riêng.
- Nói thẳng với người dùng phần nào **không sửa được** (giọng rè) và cách làm đúng (ghi lại).

---

## Giai đoạn 7 · 504 Gateway Time-out khi truy cập bằng IP

**Hiện tượng.** Máy khác mở `http://192.168.168.96:3102` thì nhận trang "504 Gateway Time-out".

**Điều tra.**
- **Từ chính máy chủ:** cả hai IP đều trả 200 trong chưa đến 1 giây (trang chủ, JS, API).
- **Máy chủ không có proxy:** không có proxy hệ thống, WinHTTP hay chính sách trình duyệt.
- **Tường lửa:** cả hai card mạng ở chế độ **Public**, và **không có luật tường lửa nào** cho cổng 3102 hay `node.exe`.
- **Trang 504:** là trang mặc định của một proxy, tức trình duyệt ở máy kia đi qua proxy công ty, và proxy chờ không được phản hồi.

**Nguyên nhân.** Tường lửa Windows chặn kết nối vào cổng 3102 từ máy khác.

**Giải pháp.** Tạo luật tường lửa chỉ cho dải mạng nội bộ; cần quyền Administrator. Công cụ tự động của tôi **không được phép** thay đổi tường lửa (đây là thay đổi bảo mật hệ thống), nên người dùng tự chạy lệnh (xem README, mục *Truy cập từ máy khác*). Nếu vẫn lỗi, thêm `192.168.*` vào danh sách bỏ qua proxy ở máy truy cập.

**Bài học.**
- **"Chạy được trên máy chủ" chưa chứng minh gì về máy khác.**
- Trang lỗi 504 kiểu này đến từ proxy, không phải từ app.
- Thay đổi bảo mật hệ thống thì để người dùng quyết định và tự thực hiện.

---

## Giai đoạn 8 · Ghi âm báo "phần có tiếng nói chỉ dài 0,2 giây"

**Hiện tượng.** Ghi âm đủ câu mẫu nhưng app báo chỉ có 0,2 giây tiếng nói.

**Nguyên nhân gốc (lỗi do tôi gây ra ở giai đoạn 6).** Khi tắt chế độ tự tăng âm lượng của trình duyệt, tín hiệu micro laptop nhỏ hẳn đi. Hàm cắt khoảng lặng lại dùng **ngưỡng tuyệt đối** (RMS 0,01), nên toàn bộ tiếng nói bị coi là im lặng. Phần duy nhất vượt ngưỡng là **tiếng "tách" khi micro vừa mở**, dài khoảng 0,2 giây.

**Kiểm chứng giả thuyết.** Mô phỏng một bản ghi: 1 giây ồn nền, tiếng click, 5 giây tiếng nói ở −48 dB, 1 giây ồn nền.

| Cách cắt | Giữ lại |
|---|---|
| Ngưỡng tuyệt đối (cũ) | **0,22 giây**, tái hiện đúng lỗi |
| Ngưỡng tương đối (mới) | 6,25 giây, đủ tiếng nói |

**Giải pháp.**
- **Ngưỡng tương đối:** `max(ồn nền + 6 dB, mức tiếng nói − 30 dB)`, tính trên chính bản ghi.
- **Bỏ 0,15 giây đầu** mỗi bản ghi để loại tiếng "tách" khi mở micro.
- **Khuếch đại tối đa 40 lần** (trước là 8 lần). Tín hiệu là số thực nên khuếch đại không mất độ chính xác.
- **Tính năng Kiểm tra micro:**
  - chọn thiết bị (lưu lại cho lần sau);
  - thanh đo mức âm theo dB;
  - im lặng 2 giây để đo ồn nền, rồi đọc 5 giây để đo tiếng nói;
  - kết quả: *tốt / hơi nhỏ / ồn quá / vỡ tiếng / không có tiếng*, kèm lời khuyên cụ thể và nghe lại bản thử;
  - tự mở ra khi ghi âm lỗi.

**Bài học.**
- **Sửa một chỗ có thể làm gãy chỗ khác:** tắt AGC là đúng cho chất lượng giọng, nhưng phá vỡ một giả định ngầm (mức tín hiệu) ở chỗ khác.
- Tránh ngưỡng tuyệt đối với tín hiệu có biên độ không kiểm soát được.
- Cho người dùng **công cụ tự chẩn đoán** (Kiểm tra micro) thay vì chỉ đưa ra thông báo lỗi.

---

## Giai đoạn 9 · Lỗi "120 giây" lần 2: VieNeu treo rồi chết

**Hiện tượng.** Tạo giọng mới "Nam Cao -HN 01" (bản ghi 12,1 giây), đọc thì lại báo lỗi 120 giây.

**Điều tra.**
- **Lúc kiểm tra, không có tiến trình nào nghe cổng 8000:** VieNeu đã chết.
- **Không có bằng chứng:** nhật ký VieNeu chỉ nằm trong RAM, đã mất theo tiến trình.
- **Giả thuyết "bản ghi 12 giây quá dài"** bị bác: đo lại thì mẫu 12 giây và mẫu 7 giây nhanh như nhau (âm thanh đầu tiên 0,7 giây). Riêng lần đọc đầu **ngay sau khi khởi động** mới chậm (6,1 giây).
- **Đọc lại đúng đoạn văn của bạn qua app:** chạy bình thường, 19,5 giây âm thanh trong 20,7 giây.

**Kết luận.** VieNeu **bị treo hoặc chết ngẫu nhiên**; chưa tìm được nguyên nhân gốc vì không có nhật ký. Hướng đúng là **tự phục hồi** và **ghi lại bằng chứng** cho lần sau.

**Giải pháp.**
- **Hai loại thời gian chờ:** 60 giây cho byte âm thanh đầu tiên (bình thường khoảng 1 giây), 30 giây cho khoảng ngắt giữa chừng (bình thường khoảng 0,1 giây).
- **Tự phục hồi:** khi treo, app khởi động lại VieNeu, **chờ server và đúng giọng đó sẵn sàng**, rồi **tự đọc lại đoạn**. Nếu một phần âm thanh của đoạn đã phát tới người dùng thì không đọc lại (tránh lặp tiếng) mà báo bấm Đọc lại.
- **VieNeu chết bất ngờ** được chạy lại, tối đa 3 lần trong 10 phút để tránh vòng lặp.
- **Nhật ký `.vieneu.log`:** ghi toàn bộ output của VieNeu và các sự kiện treo, khởi động lại, mã thoát. File tự xoay vòng khi quá 5 MB.

**Kiểm chứng bằng cách giả lập treo.** Tôi dùng Windows API `NtSuspendProcess` (P/Invoke từ PowerShell) để **đóng băng** python của VieNeu, rồi gửi yêu cầu đọc.
- **Lần 1, thất bại:** phát hiện treo đúng lúc 60 giây, nhưng VieNeu **không được khởi động lại**. Nguyên nhân: khi `npm run dev` nạp lại module, cờ `restartRequested` là biến cấp module nên **bị tách thành hai bản**, trong khi trình xử lý sự kiện "exit" vẫn thuộc bản module cũ. Bản cũ không thấy cờ, tưởng VieNeu tự chết và đánh dấu "hỏng".
- **Sửa:** chuyển mọi trạng thái của trình quản lý vào một đối tượng chung đặt trên `globalThis`. Ngoài ra, trong lúc chờ phục hồi, app chủ động chạy lại VieNeu nếu thấy trạng thái "hỏng".
- **Lần 2, thành công:** phát hiện treo ở giây 60, khởi động lại, VieNeu chạy lại sau khoảng 35 giây, ra tiếng ở giây 106 và đọc xong. Người dùng không thấy báo lỗi. `.vieneu.log` ghi đủ từng bước.

**Bài học.**
- **Khi chưa tìm ra nguyên nhân gốc, hãy làm hệ thống tự phục hồi và ghi lại bằng chứng.**
- **Tự gây lỗi có kiểm soát** (đóng băng tiến trình) để thử cơ chế phục hồi; đừng chờ lỗi thật xuất hiện.
- Với hot reload, mọi trạng thái sống lâu hơn một module (tiến trình con, listener) phải đặt ở nơi dùng chung (`globalThis`).

---

## Bài học tổng hợp (checklist)

**Chẩn đoán**
- [ ] Tìm triệu chứng phụ để khoanh vùng (bộ đếm ký tự bằng 0 → JS không chạy).
- [ ] Đo trạng thái bên trong: `/health` (`active`, `waiting`), CPU tiến trình, cổng đang nghe, số kết nối.
- [ ] Đọc mã nguồn thư viện ở chỗ nghi vấn; tài liệu có thể sai hoặc thiếu.
- [ ] Kiểm chứng bằng mắt (spectrogram, dạng sóng) trước khi tin một con số.
- [ ] Tái hiện lỗi bằng dữ liệu hoặc tình huống giả lập (mock server, tín hiệu mô phỏng, đóng băng tiến trình).

**Thiết kế**
- [ ] Hệ thống bên thứ ba có thể treo hoặc chết: cần thời gian chờ hợp lý, phát hiện, tự phục hồi và nhật ký ra file.
- [ ] Không để request chờ trong hàng đợi của dịch vụ có lỗi rò tài nguyên; xếp hàng ở phía mình.
- [ ] Dữ liệu người dùng (giọng nhân bản) phải do app lưu, không dựa vào RAM của dịch vụ khác.
- [ ] Đổi nội dung thì đổi khóa (mã giọng mới, phiên bản cache) để không phát lại dữ liệu cũ.
- [ ] Tránh ngưỡng tuyệt đối với tín hiệu có biên độ thay đổi.

**Vận hành trên Windows**
- [ ] Kill tiến trình phải kill cả cây (`taskkill /T /F`).
- [ ] Mạng ở chế độ Public: tường lửa chặn truy cập từ ngoài, cần luật riêng.
- [ ] Micro trên trình duyệt chỉ chạy trên localhost hoặc HTTPS.

**Quy trình làm việc**
- [ ] Không nhúng markdown hay backtick vào lệnh shell; dùng công cụ ghi file.
- [ ] Sau mỗi thay đổi: typecheck, kiểm thử luồng thật qua API, đo số liệu trước và sau.
- [ ] Nói rõ phần đã kiểm chứng, phần chưa kiểm chứng được (ví dụ: chưa thử micro thật, chưa thử từ máy khác).

## Kỹ thuật chẩn đoán đã dùng

| Mục đích | Cách làm |
|---|---|
| Xem trình duyệt có tải được JS qua IP không | `curl` file `/_next/static/*.js` với header `Referer: http://<ip>:3102/` |
| Thử engine khi chưa có VieNeu thật | Mock server Node giả lập `/v1/voices`, `/v1/audio/speech` (gửi PCM với số byte lẻ) |
| Xem VieNeu bận thật hay đang giữ luồng "ma" | `GET /health` + đo `TotalProcessorTime` của python trong 5 giây |
| Phân tích nhiễu | Script Python (numpy/scipy): mức dB theo khung, năng lượng cao tần, độ phẳng phổ, HNR bằng tự tương quan |
| Nhìn phổ âm thanh | Vẽ spectrogram ra PNG bằng numpy + Pillow rồi xem ảnh |
| So chất lượng MP3 | Mã hóa lamejs ở nhiều bitrate, giải mã lại, căn lệch bằng tương quan chéo, tính SNR so với PCM |
| Giả lập VieNeu treo | `NtSuspendProcess` qua P/Invoke trong PowerShell |
| Tìm tiến trình giữ cổng | `Get-NetTCPConnection -LocalPort 8000` / `netstat -ano` |

## Vấn đề còn mở và việc nên làm tiếp

1. **Nguyên nhân gốc khiến VieNeu treo hoặc chết** (giai đoạn 9) chưa tìm ra. Lần sau xảy ra, xem `.vieneu.log`.
2. **Chưa có test tự động** và **chưa dùng git**: nên khởi tạo repo, thêm test cho bộ chia đoạn, bộ mã hóa MP3, cắt khoảng lặng và cơ chế tự phục hồi (dùng mock server).
3. **Micro qua mạng LAN** cần HTTPS: có thể thêm reverse proxy (Caddy) với chứng chỉ nội bộ.
4. **Giọng địa phương đậm hơn:** cần fine-tune LoRA (10–30 phút ghi âm, cần GPU).
5. **Docker:** bộ lọc nhiễu cần môi trường Python của VieNeu, nên trong container hiện bị bỏ qua (dùng bản ghi gốc).
6. **Lỗi rò luồng của VieNeu** nên báo lên upstream: `acquire()` trong handler và `release()` trong generator của `StreamingResponse`.
7. `npm run typecheck` có thể lỗi do file type của Next dev bị hỏng khi thêm route; tắt và chạy lại `npm run dev`.

## Số liệu tham chiếu

| Hạng mục | Giá trị |
|---|---|
| Tải model VieNeu lần đầu | ~5,5 phút |
| Khởi động VieNeu (đã có model) | ~30–45 giây |
| Âm thanh đầu tiên, VieNeu CPU | 0,7–1,5 giây (~6 giây ngay sau khởi động) |
| Tốc độ tạo VieNeu CPU fp32 / int8 | RTF 0,99 / 0,88 |
| Đăng ký giọng nhân bản | 109 giây lần đầu; ~9 giây có denoise; ~2 giây không denoise |
| Lọc nhiễu bản ghi mẫu (clean_voice.py) | ~3–7 giây |
| Nạp lại 1 giọng địa phương sau khi VieNeu khởi động | ~30–60 giây |
| Luồng VieNeu được trả sau khi bấm Dừng | ~13 giây |
| Tự phục hồi khi VieNeu treo (tới lúc có tiếng) | ~106 giây |
| MP3 lamejs, SNR so với PCM: 48 / 96 kbps | 19,6 / 25,8 dB |
| HNR: giọng mẫu sạch / bản ghi laptop rè | +8,9 / −0,9 dB |
