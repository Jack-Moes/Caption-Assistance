"""Minimal Chrome DevTools Protocol client (no third-party deps).

Speaks raw RFC6455 over a socket so we can drive the running Electron renderer:
evaluate JS, click real buttons, and capture real screenshots.
"""
import json, os, socket, struct, base64, urllib.request


def _targets():
    raw = urllib.request.urlopen("http://127.0.0.1:9222/json/list", timeout=5).read()
    return json.loads(raw.decode())


def page_target(match=None):
    for t in _targets():
        if t.get("type") != "page":
            continue
        if match and match not in (t.get("url", "") + t.get("title", "")):
            continue
        return t
    return None


class CDP:
    def __init__(self, ws_url):
        _, _, rest = ws_url.partition("://")
        hostport, _, path = rest.partition("/")
        host, _, port = hostport.partition(":")
        self.sock = socket.create_connection((host, int(port or 80)), timeout=20)
        key = base64.b64encode(os.urandom(16)).decode()
        req = (
            "GET /%s HTTP/1.1\r\nHost: %s\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n"
            "Sec-WebSocket-Key: %s\r\nSec-WebSocket-Version: 13\r\n\r\n" % (path, hostport, key)
        )
        self.sock.sendall(req.encode())
        buf = b""
        while b"\r\n\r\n" not in buf:
            buf += self.sock.recv(4096)
        assert b"101" in buf.split(b"\r\n")[0], buf[:200]
        self.buf = buf.split(b"\r\n\r\n", 1)[1]
        self.id = 0

    def _send(self, payload):
        data = payload.encode()
        head = bytearray([0x81])
        n = len(data)
        if n < 126:
            head.append(0x80 | n)
        elif n < (1 << 16):
            head.append(0x80 | 126); head += struct.pack(">H", n)
        else:
            head.append(0x80 | 127); head += struct.pack(">Q", n)
        mask = os.urandom(4)
        head += mask
        self.sock.sendall(bytes(head) + bytes(b ^ mask[i % 4] for i, b in enumerate(data)))

    def _read(self, n):
        while len(self.buf) < n:
            chunk = self.sock.recv(65536)
            if not chunk:
                raise IOError("socket closed")
            self.buf += chunk
        out, self.buf = self.buf[:n], self.buf[n:]
        return out

    def _recv(self):
        while True:
            b0, b1 = self._read(2)
            op, ln = b0 & 0x0F, b1 & 0x7F
            if ln == 126:
                ln = struct.unpack(">H", self._read(2))[0]
            elif ln == 127:
                ln = struct.unpack(">Q", self._read(8))[0]
            data = self._read(ln)
            if op == 0x1:
                return data.decode("utf-8", "replace")
            if op == 0x8:
                raise IOError("closed by peer")

    def call(self, method, params=None, timeout=30):
        self.id += 1
        mid = self.id
        self.sock.settimeout(timeout)
        self._send(json.dumps({"id": mid, "method": method, "params": params or {}}))
        while True:
            msg = json.loads(self._recv())
            if msg.get("id") == mid:
                if "error" in msg:
                    raise RuntimeError("%s -> %s" % (method, msg["error"]))
                return msg.get("result", {})

    def js(self, expr, timeout=30):
        r = self.call("Runtime.evaluate", {
            "expression": "(function(){%s})()" % expr if expr.strip().startswith("return") else expr,
            "returnByValue": True, "awaitPromise": True,
        }, timeout=timeout)
        if r.get("exceptionDetails"):
            d = r["exceptionDetails"]
            raise RuntimeError("JS: " + (d.get("exception", {}).get("description") or d.get("text", "")))
        return r.get("result", {}).get("value")

    def shot(self, path):
        r = self.call("Page.captureScreenshot", {"format": "png"}, timeout=40)
        with open(path, "wb") as f:
            f.write(base64.b64decode(r["data"]))
        return path

    def close(self):
        try:
            self.sock.close()
        except Exception:
            pass


def connect(match=None):
    t = page_target(match)
    if not t:
        raise SystemExit("no CDP page target (is the app running with --remote-debugging-port=9222?)")
    return CDP(t["webSocketDebuggerUrl"])
