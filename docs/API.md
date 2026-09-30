# TTS API: tài liệu tích hợp cho đối tác

API chuyển văn bản thành giọng nói. Có giọng tiếng Việt chạy trên máy chủ riêng (VieNeu), giọng Microsoft Edge cho 7 ngôn ngữ, và giọng nhân bản từ ghi âm của bạn. Âm thanh được **stream** ngay khi đang tạo, nên bạn phát được trước khi cả file tạo xong.

- **Base URL:** `https://<tên-miền-được-cấp>/api/v1`
- **Định dạng:** JSON (UTF-8). Âm thanh trả về là MP3.

## 1. Xác thực

Mỗi đối tác được cấp một API key dạng `tts_…`. Gửi key trong mọi request:

```
Authorization: Bearer tts_xxxxxxxxxxxxxxxx
```

(Hoặc header `X-API-Key: tts_…`.) Key chỉ được hiển thị một lần khi cấp. Hãy giữ key ở phía server, **không nhúng vào app di động hay JavaScript chạy trên trình duyệt**. Nếu lộ key, liên hệ để được cấp key mới; key cũ sẽ ngừng hoạt động ngay.

## 2. Tạo giọng nói: `POST /api/v1/tts`

**Body JSON**

| Trường | Kiểu | Bắt buộc | Mô tả |
|---|---|---|---|
| `text` | string | có | Văn bản cần đọc, tối đa **5.000 ký tự** mỗi request (tùy gói) |
| `voice` | string | có | Mã giọng, lấy từ `GET /api/v1/voices`, ví dụ `vieneu:Trúc Ly`, `vi-VN-HoaiMyNeural` |
| `rate` | số | không | Tốc độ, % trong khoảng −100…200 (mặc định 0). Chỉ áp dụng cho giọng Edge |
| `pitch` | số | không | Cao độ, Hz trong khoảng −100…100. Chỉ áp dụng cho giọng Edge |
| `volume` | số | không | Âm lượng, % trong khoảng −100…100 |
| `format` | string | không | `mp3` (mặc định) hoặc `ndjson` (xem bên dưới). Có thể truyền bằng `?format=` |

**Kết quả với `format=mp3`**: `200`, `Content-Type: audio/mpeg`, thân là file MP3 được stream dần. Header kèm theo:

| Header | Ý nghĩa |
|---|---|
| `X-Chars` | Số ký tự của request |
| `X-Quota-Remaining` | Số ký tự còn lại trong tháng sau request này (`unlimited` nếu không giới hạn) |

Nếu quá trình tạo gặp lỗi **sau khi** đã gửi âm thanh, kết nối sẽ bị ngắt giữa chừng. Hãy coi file bị cắt ngang là lỗi và gửi lại. Lỗi xảy ra **trước khi** có âm thanh được trả về đúng mã HTTP (mục 5).

**Kết quả với `format=ndjson`**: `Content-Type: application/x-ndjson`, mỗi dòng là một JSON, có thêm **phụ đề theo thời gian** (cue):

```jsonc
{"type":"start","totalChunks":3,"totalChars":1127}
{"type":"audio","index":0,"data":"<MP3 base64>"}    // nối các data theo thứ tự = 1 file MP3
{"type":"cues","index":0,"cues":[{"id":0,"start":0.1,"end":1.8,"text":"Xin chào!"}]}
{"type":"chunk","index":0,"start":0,"duration":17.09,"cached":false}
{"type":"done","duration":83.1,"cachedChunks":0}
{"type":"error","message":"…","index":2}           // chỉ xuất hiện khi lỗi; luồng kết thúc sau dòng này
```

Thời gian (`start`, `end`, `duration`) tính bằng giây trên toàn bộ file. Với giọng VieNeu, phụ đề là **ước lượng** theo độ dài câu.

### Ví dụ

```bash
curl -X POST "https://<tên-miền>/api/v1/tts" \
  -H "Authorization: Bearer $TTS_KEY" \
  -H "Content-Type: application/json" \
  --data '{"text":"Xin chào, chúc bạn một ngày tốt lành.","voice":"vieneu:Trúc Ly"}' \
  -o xin-chao.mp3
```

```python
import requests

res = requests.post(
    "https://<tên-miền>/api/v1/tts",
    headers={"Authorization": f"Bearer {TTS_KEY}"},
    json={"text": "Xin chào, chúc bạn một ngày tốt lành.", "voice": "vieneu:Trúc Ly"},
    stream=True,
    timeout=(10, 600),
)
if res.status_code != 200:
    raise RuntimeError(res.json()["error"])
with open("xin-chao.mp3", "wb") as f:
    for part in res.iter_content(chunk_size=16384):
        f.write(part)
```

```js
// Node.js 18+
const res = await fetch('https://<tên-miền>/api/v1/tts', {
  method: 'POST',
  headers: { Authorization: `Bearer ${process.env.TTS_KEY}`, 'Content-Type': 'application/json' },
  body: JSON.stringify({ text: 'Xin chào, chúc bạn một ngày tốt lành.', voice: 'vieneu:Trúc Ly' }),
});
if (!res.ok) throw new Error((await res.json()).error.message);
await fs.promises.writeFile('xin-chao.mp3', Buffer.from(await res.arrayBuffer()));
```

**Văn bản dài hơn giới hạn:** chia theo đoạn văn hoặc câu, gửi **lần lượt** từng phần (mỗi tài khoản chỉ chạy 1 request cùng lúc), rồi nối các file MP3 lại theo thứ tự. File MP3 nối trực tiếp vẫn phát được.

## 3. Danh sách giọng: `GET /api/v1/voices`

```jsonc
{
  "voices": [
    { "id": "vieneu:Trúc Ly", "engine": "vieneu", "name": "Trúc Ly", "locale": "vi-VN", "language": "vi",
      "gender": "Female", "child": false, "description": "Nữ · Bắc · Phong cách tự nhiên", "featured": true },
    { "id": "vieneu:local-mux1…", "engine": "vieneu", "name": "Giọng Huế", "custom": true, "region": "Huế", … },
    { "id": "vi-VN-HoaiMyNeural", "engine": "edge", "name": "HoaiMy", "locale": "vi-VN", … }
  ],
  "engines": { "vieneu": { "available": true, "starting": false }, "edge": { "available": true } }
}
```

- `engine: "vieneu"`: tiếng Việt, chạy trên máy chủ của chúng tôi. `custom: true` là giọng bạn đã nhân bản (chỉ tài khoản của bạn thấy).
- `engine: "edge"`: Microsoft Edge TTS, 7 ngôn ngữ (vi, en, ja, zh, ko, fr, de).
- Danh sách có thể thay đổi. Nên lấy lại định kỳ (ví dụ mỗi ngày) thay vì ghi cứng.

## 4. Giọng nhân bản (nếu gói có)

Tạo một giọng mới từ một đoạn ghi âm ngắn của một người. Giọng chỉ dùng được trong tài khoản của bạn.

### `POST /api/v1/custom-voices` (multipart/form-data)

| Trường | Bắt buộc | Mô tả |
|---|---|---|
| `file` | có | **WAV PCM**, 3–20 giây, một người nói rõ ràng, tối đa 5 MB |
| `name` | có | Tên giọng (≤ 40 ký tự) |
| `speaker_name` | có | Họ tên người trong ghi âm |
| `consent_statement` | có | Xác nhận người trong ghi âm **đã đồng ý** cho nhân bản giọng, ví dụ "Ông Nguyễn Văn A đã ký văn bản đồng ý số 12/2026 ngày 01/10/2026" |
| `region` | không | Vùng miền, ví dụ "Nghệ An" |
| `gender` | không | `Female` (mặc định) hoặc `Male` |
| `denoise` | không | `true` (mặc định): lọc ồn nền trước khi nhân bản |

```bash
curl -X POST "https://<tên-miền>/api/v1/custom-voices" \
  -H "Authorization: Bearer $TTS_KEY" \
  -F name="Giọng Huế" -F region="Huế" -F gender=Female \
  -F speaker_name="Trần Thị B" \
  -F consent_statement="Bà Trần Thị B đã ký đồng ý cho phép nhân bản giọng ngày 01/10/2026" \
  -F "file=@ghi-am.wav;type=audio/wav"
```

Kết quả `201`:

```json
{ "voice": { "id": "vieneu:local-mux1ab2cd3", "name": "Giọng Huế", "region": "Huế", "gender": "Female",
  "duration": 7.4, "cleaned": true, "quality": { "hnr": 8.1, "snr": 36.2 }, "createdAt": "2026-10-01T02:03:04.000Z" } }
```

Dùng `voice.id` làm `voice` trong `POST /api/v1/tts`. `quality.hnr` < 2 nghĩa là ghi âm bị rè hoặc vang, giọng nhân bản sẽ rè theo. Khi đó nên ghi lại gần micro, trong phòng ít vang.

- `GET /api/v1/custom-voices`: danh sách giọng nhân bản của bạn.
- `DELETE /api/v1/custom-voices?id=vieneu:local-…`: xóa giọng và bản ghi âm gốc.

**Trách nhiệm:** bạn cam kết chỉ nhân bản giọng của người đã đồng ý bằng văn bản, và không dùng giọng nhân bản để mạo danh, lừa đảo hay gây nhầm lẫn về người nói. Chúng tôi lưu nội dung xác nhận, thời điểm và IP gửi làm bằng chứng.

## 5. Lỗi

Mọi lỗi trả JSON:

```json
{ "error": { "code": "rate_limited", "message": "Too many requests, retry later." } }
```

`code` cố định, dùng để xử lý trong chương trình. `message` bằng tiếng Việt nếu gửi header `Accept-Language: vi`, còn lại bằng tiếng Anh.

| HTTP | `code` | Ý nghĩa, cách xử lý |
|---|---|---|
| 400 | `invalid_request` | Body sai, thiếu trường, giọng không hợp lệ |
| 401 | `missing_key`, `invalid_key` | Thiếu hoặc sai API key |
| 403 | `client_disabled` | Tài khoản bị khóa |
| 403 | `engine_not_allowed`, `cloning_not_allowed` | Gói của bạn không gồm tính năng này |
| 404 | `voice_not_found` | Giọng không tồn tại hoặc không thuộc tài khoản của bạn |
| 409 | `voice_limit_reached` | Đã đủ số giọng nhân bản tối đa, cần xóa bớt |
| 413 | `text_too_long` | Văn bản dài quá giới hạn mỗi request, cần chia nhỏ |
| 429 | `rate_limited` | Vượt số request/phút. Chờ số giây trong header `Retry-After` |
| 429 | `too_many_concurrent` | Request trước của bạn chưa xong. Gửi lần lượt |
| 429 | `quota_exceeded` | Hết hạn mức ký tự của tháng |
| 502 | `synthesis_failed` | Không tạo được âm thanh. Thử lại sau vài giây |
| 503 | `server_busy`, `engine_unavailable` | Máy chủ đang bận hoặc engine đang khởi động. Thử lại theo `Retry-After` |

Khuyến nghị: với 429/502/503, thử lại tối đa 3 lần, giãn cách tăng dần (5 s, 15 s, 45 s).

## 6. Giới hạn và tính phí

| Giới hạn | Mặc định (có thể khác theo hợp đồng) |
|---|---|
| Ký tự mỗi request | 5.000 |
| Ký tự mỗi tháng | 1.000.000 |
| Request mỗi phút | 20 |
| Request chạy cùng lúc | 1 |
| Giọng nhân bản | 10 |

- **Ký tự tính phí** là số ký tự của phần âm thanh đã thực sự gửi cho bạn. Request lỗi trước khi có âm thanh không bị tính. Request bị ngắt giữa chừng chỉ tính phần đã gửi.
- Tháng tính theo giờ Việt Nam (UTC+7).
- **Tốc độ:** giọng VieNeu tạo âm thanh nhanh xấp xỉ thời gian thực (1 phút âm thanh ≈ 1 phút xử lý), âm thanh đầu tiên sau khoảng 1 giây. Giọng Edge tiếng Việt có độ trễ ban đầu 2–7 giây. Hãy đặt timeout đọc đủ dài (≥ 10 phút cho request 5.000 ký tự).
- Kết quả giống hệt nhau (cùng văn bản, giọng, tham số) được trả từ cache, nhanh hơn nhiều.

## 7. Lưu ý về giọng Microsoft Edge

Giọng `engine: "edge"` dùng dịch vụ đọc văn bản công khai của Microsoft Edge, **không phải dịch vụ có hợp đồng với Microsoft**. Microsoft có thể thay đổi hoặc ngừng dịch vụ này bất cứ lúc nào mà không báo trước, nên **không có cam kết chất lượng dịch vụ (SLA)** cho các giọng này. Với ứng dụng quan trọng, hãy dùng giọng `vieneu`, hoặc chuẩn bị phương án dự phòng.
