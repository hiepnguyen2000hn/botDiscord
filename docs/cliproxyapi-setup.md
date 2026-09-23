# Chạy CLIProxyAPI trên VPS

Source của [CLIProxyAPI](https://github.com/router-for-me/CLIProxyAPI) được vendor vào repo này dưới dạng git submodule tại [`cliproxyapi/`](../cliproxyapi). Lệnh `/chat` của bot ([src/commands/chat.ts](../src/commands/chat.ts)) gọi HTTP tới service này qua `PROXY_API_URL` / `PROXY_API_KEY`, dùng API tương thích OpenAI (`/v1/chat/completions`, `/v1/models`).

## 1. Lấy source submodule

```bash
git clone --recurse-submodules <url-repo-bot>
# hoặc nếu đã clone bot trước đó:
git submodule update --init --recursive
```

## 2. Build binary Go

Yêu cầu Go 1.26+ trên VPS.

```bash
cd cliproxyapi
go build -o cli-proxy-api ./cmd/server
```

## 3. Tạo config

```bash
cp config.example.yaml config.yaml
```

Sửa các field chính trong `config.yaml`:

- `port: 8317` — giữ mặc định để khớp `PROXY_API_URL=http://127.0.0.1:8317` của bot.
- `host: "127.0.0.1"` — nên bind local, không expose ra ngoài internet.
- `api-keys:` — thêm một key bất kỳ, ví dụ `"your-secret-key"`. Key này sẽ là giá trị `PROXY_API_KEY` trong `.env` của bot.
- `auth-dir: "~/.cli-proxy-api"` — nơi lưu credential OAuth sau khi login, giữ mặc định là được.

## 4. Đăng nhập provider (OAuth)

Chạy thử ở chế độ tương tác lần đầu để login provider bạn muốn dùng (Claude, Gemini, Codex, Grok...):

```bash
./cli-proxy-api --config config.yaml
```

Server sẽ in ra URL đăng nhập OAuth — mở URL đó trên máy có trình duyệt (dùng `--no-browser` nếu VPS không có GUI), đăng nhập, quay lại terminal. Credential sẽ được lưu vào `auth-dir` (mặc định `~/.cli-proxy-api`), từ lần sau chạy sẽ tự dùng lại credential đã lưu.

Xem thêm các flag hỗ trợ (`--tui`, `--standalone`, `--oauth-callback-port`, `--local-model`...) trong [AGENTS.md của CLIProxyAPI](../cliproxyapi/AGENTS.md) hoặc hướng dẫn chính thức tại https://help.router-for.me/.

Sau khi login xong, dừng process (Ctrl+C) rồi chuyển sang chạy nền bằng systemd ở bước 5.

## 5. Chạy nền bằng systemd

Copy file mẫu [`deploy/cliproxyapi.service`](../deploy/cliproxyapi.service) sang `/etc/systemd/system/`, sửa lại `User`, `WorkingDirectory`, `ExecStart` cho khớp đường dẫn thật trên VPS, rồi:

```bash
sudo cp deploy/cliproxyapi.service /etc/systemd/system/cliproxyapi.service
sudo systemctl daemon-reload
sudo systemctl enable --now cliproxyapi
sudo systemctl status cliproxyapi
```

## 6. Trỏ bot Discord vào service

Trong `.env` của bot (cùng VPS):

```
PROXY_API_URL=http://127.0.0.1:8317
PROXY_API_KEY=your-secret-key   # phải khớp giá trị trong api-keys của config.yaml
```

Khởi động lại bot, rồi test bằng lệnh `/chat` trên Discord.

## Cập nhật source CLIProxyAPI sau này

```bash
cd cliproxyapi
git fetch
git checkout <tag-hoặc-commit-muốn-lên>
cd ..
git add cliproxyapi
git commit -m "chore: bump cliproxyapi submodule"
```

Sau đó build lại binary (bước 2) và restart service systemd.
