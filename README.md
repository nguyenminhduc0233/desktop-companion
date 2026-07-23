# 🧝‍♀️ Desktop Companion — thú cưng AI trên màn hình

Một nhân vật anime luôn **nổi ở góc màn hình (always-on-top)**, như một người bạn nhỏ cạnh máy tính:

- 😊 Vui khi bạn trò chuyện · 😴 buồn ngủ khi bạn ngồi máy quá lâu · 😠 cáu khi bị bấm quá nhiều
- 💬 Chat như ChatGPT (nhập API key của bạn) · 📝 nhớ hội thoại trước · 😂 kể chuyện cười
- 🔔 Nhắc uống nước / nghỉ ngơi · 👀 nhìn theo chuột · 🚶 kéo thả đi quanh màn hình

Xây bằng **Electron** (cửa sổ trong suốt, không viền, luôn nổi, xuyên chuột). Nhân vật là ảnh 2D nhiều biểu cảm (có thể nâng lên Live2D/3D sau).

---

## 🚀 Chạy thử (dev)
Cần **Node.js 18+**.
```bash
npm install      # tự tạo icon (postinstall)
npm start        # bật thú cưng lên góc màn hình
```
- **Bấm vào nhân vật** → mở ô chat. **Kéo** nhân vật để di chuyển. Rê chuột vào để hiện thanh nút 💬 😂 ⚙️.
- Bấm **⚙️** để nhập **API key** (khuyên dùng **Gemini free**), đổi tên, chỉnh nhắc nhở.
- Biểu tượng khay hệ thống (tray): Hiện/Ẩn, luôn nổi, Thoát.

## 📦 Đóng gói ra file EXE (Windows)
```bash
npm run dist:win      # → release/Desktop-Companion-1.0.0-portable.exe
```
> Trên Linux/macOS cần `wine` để đóng gói EXE. Cách chắc chắn nhất: dùng **GitHub Actions** (đã cấu hình trong `.github/workflows/build.yml`) — push lên GitHub là tự build EXE + AppImage, tải ở tab *Actions → Artifacts*.

## 🧠 AI Brain (nhập key của bạn)
Vào **⚙️** chọn nhà cung cấp:
- **Gemini** (miễn phí) — key ở https://aistudio.google.com/apikey
- **OpenAI (ChatGPT)** — cần nạp credit API
- **Ollama (offline)** — chạy model nội bộ, không cần key, không tốn tiền (Base URL `http://localhost:11434/v1`, ví dụ model `llama3.2`)
- **Custom** — mọi endpoint tương thích OpenAI

Trong app (EXE) gọi AI qua tiến trình nền nên **không dính CORS** — mọi nhà cung cấp đều chạy.
Mẹo: gõ `/nhớ <việc>` để dặn nó ghi nhớ (vd `/nhớ mai mình phỏng vấn`) — hôm sau nó sẽ nhắc.

---

## 🗺️ Lộ trình (theo mô tả)
| Bản | Nội dung | Trạng thái |
|---|---|---|
| **V1** | Hiện nhân vật, click, idle, kéo thả (không cần AI) | ✅ |
| **V2** | Chat AI + bong bóng thoại | ✅ |
| **V3** | Cảm xúc (năng lượng, buồn ngủ, cáu) | ✅ |
| **V4** | Trí nhớ (nhớ hội thoại, `/nhớ`) | ✅ (cơ bản) |
| **V5** | Hành động nâng cao (đi quanh, ngồi taskbar, chạy theo chuột…) | 🔜 (đã có nhìn/kéo; roam là bước tiếp) |
| **Voice** | TTS đọc (Web Speech ✅). Offline **Piper/Kokoro/XTTS** | 🔜 |
| **Live2D** | Cubism `.moc3` (chớp mắt/thở/há miệng theo giọng) | 🔜 |
| **3D** | VRM/Blender thay ảnh 2D | 🔜 |

## 🏗️ Kiến trúc
```
Desktop Companion
├─ Character Engine  (src/app.js: biểu cảm, animation, gaze)
├─ AI Brain          (chat + memory + personality)
├─ Voice             (TTS Web Speech; Piper offline — roadmap)
├─ Scheduler         (nhắc uống nước / nghỉ)
└─ Electron shell    (electron/: cửa sổ trong suốt, luôn nổi, xuyên chuột, tray)
```

## 📁 Cấu trúc
```
desktop-companion/
├─ electron/  main.cjs · preload.cjs      # cửa sổ trong suốt + theo chuột + proxy AI + tray
├─ src/       index.html · pet.css · app.js · assets/*.jpg   # nhân vật + logic
├─ scripts/   gen-icon.cjs
└─ .github/workflows/build.yml            # CI build EXE + AppImage
```

## 🎨 Tạo / chỉnh / nhập nhân vật riêng

Bạn có thể **xuất** nhân vật hiện tại ra một **file `.character.json`**, chỉnh sửa, rồi **nhập** lại — không cần đụng code.

**Trong app:** ⚙️ → mục **Nhân vật** → **Xuất** (tải file `.json`) / **Nhập** (chọn file) / **Mặc định** (khôi phục). File nhập được lưu bằng IndexedDB nên vẫn còn sau khi tắt. Có sẵn file mẫu `character.example.json` để bắt đầu.

**Định dạng file (`.character.json`):**
```jsonc
{
  "format": "desktop-companion-character",   // BẮT BUỘC đúng chuỗi này
  "version": 1,
  "name": "Linh",                             // tên hiển thị
  "canvas": 640,                              // khung VUÔNG (px) mà mọi ảnh bộ phận dùng chung
  "parts": [                                  // vẽ theo z tăng dần
    { "id": "body", "image": "<PNG dataURL>", "pivot": [50, 50],  "z": 1 },
    { "id": "armL", "image": "<PNG dataURL>", "pivot": [40.9, 25], "z": 2, "bone": "armL" },
    { "id": "armR", "image": "<PNG dataURL>", "pivot": [57.5, 25], "z": 2, "bone": "armR" }
  ],
  "rig": {
    "restAngles": { "armL": -74, "armR": 74 }, // góc nghỉ của tay (độ)
    "walkSwing": 22,                            // biên độ đánh tay khi đi (độ)
    "waveArm": "armR"                           // tay dùng để vẫy
  }
}
```

**Yêu cầu để chạy đúng:**
| Mục | Yêu cầu |
|---|---|
| **Ảnh bộ phận** | PNG **nền trong suốt** (đã tách nền sạch). |
| **Khung chung** | MỌI bộ phận vẽ trên cùng một canvas **vuông** `canvas×canvas`, đặt **đúng vị trí** như khi ghép (KHÔNG cắt sát viền). Xếp chồng các phần = nhân vật hoàn chỉnh. |
| **`image`** | Nên nhúng **data URL PNG** (`data:image/png;base64,…`) để file mang đi 1-file; hoặc đường dẫn ảnh tương đối. |
| **`pivot`** | `[x%, y%]` — vị trí **khớp/bản lề** của bộ phận theo % khung (vd vai). Bộ phận sẽ xoay quanh điểm này. |
| **`z`** | Thứ tự lớp (số lớn hiển thị trên). |
| **`bone`** | Tuỳ chọn: `"armL"` hoặc `"armR"` → được engine xoay theo animation. Phần **không có `bone`** sẽ **tĩnh** (vd thân, tóc, phụ kiện). |
| **Tối ưu** | `canvas` khoảng **512–768**; tổng file nên ≤ **vài MB**. |

> Engine v1 điều khiển 2 khớp `armL`, `armR` (vẫy/đánh tay). Bạn có thể **thêm bộ phận tĩnh** tuỳ ý (tóc phụ, mũ, thú cưng nhỏ…). Khớp chân (`legL/legR`) sẽ được hỗ trợ ở bản sau.

## 📜 License
MIT
