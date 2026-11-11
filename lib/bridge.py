"""eNSP GUI bridge - elevated sidecar used by the dsh-ensp plugin.

Why this exists
---------------
eNSP runs elevated (compat flags ``~WIN7RTM RUNASADMIN``).  A normal integrity
process cannot drive it: ``PostMessage``/``SetWindowPos`` fail with
ERROR_ACCESS_DENIED under UIPI.  This helper is started with the "runas" verb so
it lives at the same integrity level as eNSP.

Two run modes
-------------
``--job FILE``    one-shot batch (default).  One process start carries a whole
                  list of steps, which is what makes bulk GUI work fast:
                  ~0.3 s launch, then 1-70 ms per step.
``--port/--token`` resident server for callers that keep a process alive.

Protocol: newline-delimited JSON, one request per line.
``{"id": 7, "op": "postclick", "hwnd": 1234, "x": 10, "y": 20}``

Hard-won rules baked in here
----------------------------
* Screenshots use BitBlt from the window DC: works while the window is covered,
  needs no focus and no elevation (~15 ms).
* Clicks go through ``PostMessage`` whenever possible: no cursor movement, no
  focus steal, works in the background.  Real ``SendInput`` clicks are the
  fallback and always restore the previous cursor position.
* Re-resolve every window handle by title/class on each call.  eNSP spawns a
  fresh process (and fresh HWNDs) per topology, so cached handles go stale.
* Never send custom WM_USER messages to eNSP controls.  The skinned status bar
  crashes the whole client when asked for SB_GETPARTS.
"""

from __future__ import annotations

import argparse
import ctypes
import ctypes.wintypes as wt
from contextlib import contextmanager
import json
import ntpath
import os
import socket
import subprocess
import threading
import time
import traceback

import win32api
import win32clipboard
import win32con
import win32gui
import win32process
import win32ui

try:
    from PIL import Image
except Exception:  # pragma: no cover - Pillow is optional
    Image = None

user32 = ctypes.windll.user32
kernel32 = ctypes.windll.kernel32
shell32 = ctypes.windll.shell32

CREATE_NO_WINDOW = 0x08000000
CREATE_BREAKAWAY_FROM_JOB = 0x01000000
DETACHED_PROCESS = 0x00000008
CREATE_NEW_PROCESS_GROUP = 0x00000200

ULONG_PTR = ctypes.c_ulonglong if ctypes.sizeof(ctypes.c_void_p) == 8 else ctypes.c_ulong

INPUT_MOUSE = 0
INPUT_KEYBOARD = 1
KEYEVENTF_KEYUP = 0x0002
KEYEVENTF_UNICODE = 0x0004
MOUSEEVENTF_MOVE = 0x0001
MOUSEEVENTF_ABSOLUTE = 0x8000
MOUSEEVENTF_VIRTUALDESK = 0x4000
MOUSEEVENTF_LEFTDOWN = 0x0002
MOUSEEVENTF_LEFTUP = 0x0004
MOUSEEVENTF_RIGHTDOWN = 0x0008
MOUSEEVENTF_RIGHTUP = 0x0010
MOUSEEVENTF_MIDDLEDOWN = 0x0020
MOUSEEVENTF_MIDDLEUP = 0x0040
MOUSEEVENTF_WHEEL = 0x0800

VK = {
    "enter": 0x0D, "tab": 0x09, "esc": 0x1B, "escape": 0x1B, "space": 0x20,
    "backspace": 0x08, "del": 0x2E, "delete": 0x2E, "insert": 0x2D,
    "up": 0x26, "down": 0x28, "left": 0x25, "right": 0x27,
    "home": 0x24, "end": 0x23, "pageup": 0x21, "pagedown": 0x22,
    "ctrl": 0x11, "shift": 0x10, "alt": 0x12, "win": 0x5B,
    "f1": 0x70, "f2": 0x71, "f3": 0x72, "f4": 0x73, "f5": 0x74, "f6": 0x75,
    "f7": 0x76, "f8": 0x77, "f9": 0x78, "f10": 0x79, "f11": 0x7A, "f12": 0x7B,
}


class MOUSEINPUT(ctypes.Structure):
    _fields_ = [("dx", wt.LONG), ("dy", wt.LONG), ("mouseData", wt.DWORD),
                ("dwFlags", wt.DWORD), ("time", wt.DWORD), ("dwExtraInfo", ULONG_PTR)]


class KEYBDINPUT(ctypes.Structure):
    _fields_ = [("wVk", wt.WORD), ("wScan", wt.WORD), ("dwFlags", wt.DWORD),
                ("time", wt.DWORD), ("dwExtraInfo", ULONG_PTR)]


class HARDWAREINPUT(ctypes.Structure):
    _fields_ = [("uMsg", wt.DWORD), ("wParamL", wt.WORD), ("wParamH", wt.WORD)]


class _INPUTunion(ctypes.Union):
    _fields_ = [("mi", MOUSEINPUT), ("ki", KEYBDINPUT), ("hi", HARDWAREINPUT)]


class INPUT(ctypes.Structure):
    _fields_ = [("type", wt.DWORD), ("union", _INPUTunion)]


class STARTUPINFO(ctypes.Structure):
    _fields_ = [("cb", wt.DWORD), ("lpReserved", wt.LPWSTR), ("lpDesktop", wt.LPWSTR),
                ("lpTitle", wt.LPWSTR), ("dwX", wt.DWORD), ("dwY", wt.DWORD),
                ("dwXSize", wt.DWORD), ("dwYSize", wt.DWORD),
                ("dwXCountChars", wt.DWORD), ("dwYCountChars", wt.DWORD),
                ("dwFillAttribute", wt.DWORD), ("dwFlags", wt.DWORD),
                ("wShowWindow", wt.WORD), ("cbReserved2", wt.WORD),
                ("lpReserved2", ctypes.POINTER(ctypes.c_byte)),
                ("hStdInput", wt.HANDLE), ("hStdOutput", wt.HANDLE), ("hStdError", wt.HANDLE)]


class PROCESS_INFORMATION(ctypes.Structure):
    _fields_ = [("hProcess", wt.HANDLE), ("hThread", wt.HANDLE),
                ("dwProcessId", wt.DWORD), ("dwThreadId", wt.DWORD)]


DPI_MODE = None
LOG_LOCK = threading.Lock()
GUI_LOCK = threading.RLock()
LOG_PATH = None


def log(line):
    if not LOG_PATH:
        return
    with LOG_LOCK:
        try:
            with open(LOG_PATH, "a", encoding="utf-8") as fh:
                fh.write(line + "\n")
        except Exception:
            pass


# ------------------------------------------------------------------ utilities

def _win32_api(dll, name, args, result):
    """Bind pointer-sized handles explicitly, including DPI context handles."""
    try:
        fn = getattr(dll, name)
    except AttributeError:
        return None
    fn.argtypes = args
    fn.restype = result
    return fn


_set_thread_dpi = _win32_api(user32, "SetThreadDpiAwarenessContext",
                             [wt.HANDLE], wt.HANDLE)
_get_window_dpi_context = _win32_api(user32, "GetWindowDpiAwarenessContext",
                                     [wt.HWND], wt.HANDLE)
_get_dpi_awareness = _win32_api(user32, "GetAwarenessFromDpiAwarenessContext",
                               [wt.HANDLE], ctypes.c_int)
_get_window_dpi = _win32_api(user32, "GetDpiForWindow", [wt.HWND], wt.UINT)
_get_scroll_pos = _win32_api(user32, "GetScrollPos", [wt.HWND, ctypes.c_int], ctypes.c_int)
_get_owner = _win32_api(user32, "GetWindow", [wt.HWND, wt.UINT], wt.HWND)
_open_process = _win32_api(kernel32, "OpenProcess",
                          [wt.DWORD, wt.BOOL, wt.DWORD], wt.HANDLE)
_query_process_image = _win32_api(kernel32, "QueryFullProcessImageNameW",
                                 [wt.HANDLE, wt.DWORD, wt.LPWSTR,
                                  ctypes.POINTER(wt.DWORD)], wt.BOOL)
_close_handle = _win32_api(kernel32, "CloseHandle", [wt.HANDLE], wt.BOOL)
_create_mutex = _win32_api(kernel32, "CreateMutexW", [ctypes.c_void_p, wt.BOOL, wt.LPCWSTR], wt.HANDLE)
_wait_mutex = _win32_api(kernel32, "WaitForSingleObject", [wt.HANDLE, wt.DWORD], wt.DWORD)
_release_mutex = _win32_api(kernel32, "ReleaseMutex", [wt.HANDLE], wt.BOOL)


@contextmanager
def gui_transaction():
    """Serialize elevated job and resident processes in this Windows session."""
    with GUI_LOCK:
        mutex = _create_mutex(None, False, r"Local\dsh-ensp-gui-input-v1")
        if not mutex:
            raise RuntimeError("cannot create GUI transaction mutex")
        acquired = False
        try:
            acquired = _wait_mutex(mutex, 15000) in (0, 0x80)
            if not acquired:
                raise RuntimeError("another GUI operation is active; retry when it finishes")
            yield
        finally:
            if acquired:
                _release_mutex(mutex)
            _close_handle(mutex)


@contextmanager
def _dpi_context(context):
    """Temporarily change only this bridge thread; never the target process."""
    previous = None
    if context and _set_thread_dpi is not None:
        previous = _set_thread_dpi(context)
        if not previous:
            raise RuntimeError("cannot enter DPI awareness context %s" % context)
    try:
        yield
    finally:
        if previous:
            _set_thread_dpi(previous)


def window_dpi(hwnd):
    """Read physical and target-logical geometry without repainting the window.

    GetDpiForWindow alone is insufficient: it returns 96 for DPI-unaware eNSP,
    even on a 150% monitor. The window's context records its creating thread's
    awareness (which may differ from its process). Measuring in that context
    gives the native window-DC extent and the logical -> physical multiplier.
    """
    context = _get_window_dpi_context(hwnd) if _get_window_dpi_context else None
    with _dpi_context(-3):  # PER_MONITOR_AWARE: physical screen pixels
        physical = win32gui.GetWindowRect(hwnd)
    logical = physical
    if context:
        with _dpi_context(context):
            logical = win32gui.GetWindowRect(hwnd)
    pw, ph = physical[2] - physical[0], physical[3] - physical[1]
    lw, lh = logical[2] - logical[0], logical[3] - logical[1]
    return {
        "hwnd": int(hwnd),
        "context": context,
        "awareness": _get_dpi_awareness(context) if context and _get_dpi_awareness else None,
        "window_dpi": _get_window_dpi(hwnd) if _get_window_dpi else None,
        "physical_rect": list(physical),
        "logical_rect": list(logical),
        "physical_size": [pw, ph],
        "source_size": [lw, lh],
        "dpi_scale": pw / lw if pw > 0 and lw > 0 else 1.0,
    }


def dpi_diagnostics(hwnd):
    """Read-only comparison with DWM's unvirtualized physical frame bounds."""
    info = window_dpi(hwnd)
    info["dwm_frame_rect"] = None
    try:
        get_bounds = _win32_api(ctypes.windll.dwmapi, "DwmGetWindowAttribute",
                                [wt.HWND, wt.DWORD, ctypes.c_void_p, wt.DWORD], wt.LONG)
        bounds = wt.RECT()
        if get_bounds and get_bounds(hwnd, 9, ctypes.byref(bounds), ctypes.sizeof(bounds)) == 0:
            info["dwm_frame_rect"] = [bounds.left, bounds.top, bounds.right, bounds.bottom]
    except (AttributeError, OSError):
        pass
    with _dpi_context(-3):
        info["screen_size"] = [user32.GetSystemMetrics(0), user32.GetSystemMetrics(1)]
    return info


def set_dpi_aware():
    """Per-monitor v2 so reported rectangles match physical pixels."""
    for attempt in (-4, -3, -2):
        try:
            if user32.SetProcessDpiAwarenessContext(ctypes.c_void_p(attempt)):
                return attempt
        except Exception:
            pass
    try:
        ctypes.windll.shcore.SetProcessDpiAwareness(2)
        return "shcore:2"
    except Exception:
        pass
    try:
        user32.SetProcessDPIAware()
        return 1
    except Exception:
        return 0


def is_elevated():
    adv = ctypes.windll.advapi32
    adv.OpenProcessToken.argtypes = [wt.HANDLE, wt.DWORD, ctypes.POINTER(wt.HANDLE)]
    adv.OpenProcessToken.restype = wt.BOOL
    handle = wt.HANDLE()
    if not adv.OpenProcessToken(kernel32.GetCurrentProcess(), 0x0008, ctypes.byref(handle)):
        return None

    class TOKEN_ELEVATION(ctypes.Structure):
        _fields_ = [("TokenIsElevated", wt.DWORD)]

    te = TOKEN_ELEVATION()
    size = wt.DWORD()
    adv.GetTokenInformation(handle, 20, ctypes.byref(te), ctypes.sizeof(te),
                            ctypes.byref(size))
    kernel32.CloseHandle(handle)
    return bool(te.TokenIsElevated)


def _send_inputs(inputs):
    n = len(inputs)
    arr = (INPUT * n)(*inputs)
    sent = user32.SendInput(n, ctypes.byref(arr), ctypes.sizeof(INPUT))
    if sent != n:
        raise RuntimeError("SendInput inserted %s of %s events" % (sent, n))
    return sent


def _mouse_input(flags, dx=0, dy=0, data=0):
    item = INPUT()
    item.type = INPUT_MOUSE
    item.union.mi = MOUSEINPUT(dx, dy, data, flags, 0, 0)
    return item


def _key_input(vk=0, scan=0, flags=0):
    item = INPUT()
    item.type = INPUT_KEYBOARD
    item.union.ki = KEYBDINPUT(vk, scan, flags, 0, 0)
    return item


# ------------------------------------------------------------------ discovery

def window_info(hwnd):
    try:
        pid = win32process.GetWindowThreadProcessId(hwnd)[1]
    except Exception:
        pid = 0
    dpi = window_dpi(hwnd)
    with _dpi_context(-3):
        client_origin = win32gui.ClientToScreen(hwnd, (0, 0))
        client_size = win32gui.GetClientRect(hwnd)[2:]
    return {
        "hwnd": int(hwnd),
        "title": win32gui.GetWindowText(hwnd),
        "cls": win32gui.GetClassName(hwnd),
        "pid": int(pid),
        "rect": dpi["physical_rect"],
        "client_origin": list(client_origin),
        "client_size": list(client_size),
        "dpi_scale": dpi["dpi_scale"],
        "visible": bool(win32gui.IsWindowVisible(hwnd)),
        "minimized": bool(win32gui.IsIconic(hwnd)),
    }


def enum_windows(filter_text=None, visible_only=True):
    rows = []
    needle = (filter_text or "").lower()

    def cb(hwnd, _):
        if visible_only and not win32gui.IsWindowVisible(hwnd):
            return True
        title = win32gui.GetWindowText(hwnd)
        if needle:
            if needle not in title.lower():
                return True
        elif not title:
            return True
        rows.append(window_info(hwnd))
        return True

    win32gui.EnumWindows(cb, None)
    return rows


def find_window(title=None, hwnd=None, cls=None, include_hidden=True):
    if hwnd:
        if win32gui.IsWindow(int(hwnd)):
            return int(hwnd)
        raise LookupError("no such hwnd %s (eNSP re-creates windows; re-discover)" % hwnd)
    needle = (title or "").lower()
    want_cls = (cls or "").lower()
    matches = []

    def cb(h, _):
        if not include_hidden and not win32gui.IsWindowVisible(h):
            return True
        t = win32gui.GetWindowText(h)
        c = win32gui.GetClassName(h)
        if want_cls and c.lower() != want_cls:
            return True
        if needle and needle not in t.lower():
            return True
        if not needle and not want_cls:
            return True
        matches.append((h, t, c))
        return True

    win32gui.EnumWindows(cb, None)
    if not matches:
        raise LookupError("no window matched title=%r cls=%r" % (title, cls))
    matches.sort(key=lambda m: len(m[1]))
    return int(matches[0][0])


def _level_of(hwnd, root):
    level = 0
    cur = win32gui.GetParent(hwnd)
    while cur and cur != root and level < 12:
        level += 1
        cur = win32gui.GetParent(cur)
    return level + 1


def children(hwnd, depth=2):
    """All descendants of ``hwnd`` once each, tagged with nesting level."""
    out = []

    def cb(ch, _):
        try:
            level = _level_of(ch, hwnd)
            if level > depth:
                return True
            rect = win32gui.GetWindowRect(ch)
            crect = win32gui.GetClientRect(ch)
            out.append({
                "hwnd": int(ch),
                "cls": win32gui.GetClassName(ch),
                "txt": win32gui.GetWindowText(ch),
                "rect": list(rect),
                "local": [rect[0], rect[1], rect[2] - rect[0], rect[3] - rect[1]],
                "size": [crect[2], crect[3]],
                "visible": bool(win32gui.IsWindowVisible(ch)),
                "level": level,
            })
        except Exception:
            pass
        return True

    with _dpi_context(-3):
        win32gui.EnumChildWindows(hwnd, cb, None)
    return out


def texts(hwnd, depth=2, only=None):
    """Readable text of a window and its descendants (WM_GETTEXT only: safe)."""
    out = []
    for item in children(hwnd, depth):
        if only and item["cls"] != only:
            continue
        # GetWindowText does not retrieve another process's edit contents.
        # WM_GETTEXT is a system message (marshalled across processes).
        if item["cls"].lower() in ("edit", "richedit20a", "richedit20w", "richedit50w"):
            item["txt"] = ""
            buffer = ctypes.create_unicode_buffer(131072)
            result = ctypes.c_size_t()
            send = user32.SendMessageTimeoutW
            send.argtypes = [wt.HWND, wt.UINT, ctypes.c_size_t, ctypes.c_void_p,
                             wt.UINT, wt.UINT, ctypes.POINTER(ctypes.c_size_t)]
            send.restype = ctypes.c_ssize_t
            if send(item["hwnd"], 0x000D, len(buffer), ctypes.cast(buffer, ctypes.c_void_p),
                    2, 500, ctypes.byref(result)):
                item["txt"] = buffer.value
        if item["txt"]:
            out.append({"hwnd": item["hwnd"], "cls": item["cls"], "txt": item["txt"],
                        "local": item["local"]})
    return out


def wnd_at(x, y):
    hwnd = user32.WindowFromPoint(wt.POINT(int(x), int(y)))
    if not hwnd:
        return None
    chain = []
    cur = hwnd
    while cur:
        chain.append({"hwnd": int(cur), "cls": win32gui.GetClassName(cur),
                      "txt": win32gui.GetWindowText(cur),
                      "rect": list(win32gui.GetWindowRect(cur))})
        parent = win32gui.GetParent(cur)
        if not parent:
            break
        cur = parent
    client = win32gui.ScreenToClient(hwnd, (int(x), int(y)))
    return {"hwnd": int(hwnd), "cls": chain[0]["cls"], "txt": chain[0]["txt"],
            "client": list(client), "chain": chain}


# ------------------------------------------------------------------ capture

def capture(hwnd, out_path, crop=None, mode="blit"):
    """Grab a window's pixels.

    ``mode="blit"`` (default) copies from the window DC: fast, occlusion proof,
    no elevation needed.  ``mode="print"`` asks the window to paint itself.
    Capture the target's native DC pixels, then resize to physical pixels so
    crops and screenshot offsets use the same units as ``window_info.rect``.
    Without Pillow, BMP output retains its honest native dimensions instead.
    """
    if win32gui.IsIconic(hwnd):
        win32gui.ShowWindow(hwnd, win32con.SW_RESTORE)
        time.sleep(0.35)
        if win32gui.IsIconic(hwnd):
            raise RuntimeError("cannot capture minimized window %s: restore failed" % hwnd)
    dpi = window_dpi(hwnd)
    width, height = dpi["physical_size"]
    source_width, source_height = dpi["source_size"]
    if min(width, height, source_width, source_height) <= 0:
        raise RuntimeError("window has no area: %r" % (dpi["physical_rect"],))
    encoded = out_path.lower().endswith((".png", ".jpg", ".jpeg"))
    if Image is None and (encoded or crop):
        raise RuntimeError("Pillow missing: cannot convert/crop %s" % out_path)
    # A window that is covered or was never foreground keeps a stale device
    # context, and BitBlt then returns the previous screen. Ask it to repaint
    # first; for eNSP consoles this is the difference between a fresh transcript
    # and a frozen one.
    try:
        win32gui.RedrawWindow(hwnd, None, None,
                             win32con.RDW_INVALIDATE | win32con.RDW_ALLCHILDREN
                             | win32con.RDW_UPDATENOW | win32con.RDW_FRAME)
        win32gui.UpdateWindow(hwnd)
    except Exception:
        pass
    time.sleep(0.03)
    # A DPI-unaware eNSP window at 150% has a 1280x800 DC even when its
    # physical rectangle is 1920x1200. Blitting the latter extent adds black
    # padding. Both acquiring and reading the DC use the target's context.
    with _dpi_context(dpi["context"]):
        hdc = win32gui.GetWindowDC(hwnd)
        if not hdc:
            raise RuntimeError("GetWindowDC failed for hwnd %s" % hwnd)
        src = mem = bmp = old_bmp = None
        try:
            src = win32ui.CreateDCFromHandle(hdc)
            mem = src.CreateCompatibleDC()
            bmp = win32ui.CreateBitmap()
            bmp.CreateCompatibleBitmap(src, source_width, source_height)
            old_bmp = mem.SelectObject(bmp)
            if mode == "print":
                if not user32.PrintWindow(hwnd, mem.GetSafeHdc(), 2):
                    raise RuntimeError("PrintWindow failed for hwnd %s" % hwnd)
            else:
                mem.BitBlt((0, 0), (source_width, source_height), src, (0, 0),
                           win32con.SRCCOPY)
            os.makedirs(os.path.dirname(os.path.abspath(out_path)), exist_ok=True)
            bmp.SaveBitmapFile(mem, out_path)
        finally:
            try:
                if old_bmp is not None:
                    mem.SelectObject(old_bmp)
                if bmp:
                    win32gui.DeleteObject(bmp.GetHandle())
                if mem:
                    mem.DeleteDC()
                if src:
                    src.DeleteDC()
            finally:
                win32gui.ReleaseDC(hwnd, hdc)

    result = {"out": out_path, "width": source_width, "height": source_height,
              "mode": mode, "dpi_scale": dpi["dpi_scale"],
              "source_size": dpi["source_size"], "physical_size": dpi["physical_size"],
              "coordinate_space": "physical"}
    needs_resize = (source_width, source_height) != (width, height)
    if Image is not None and (encoded or crop or needs_resize):
        with Image.open(out_path) as img:
            img = img.convert("RGB")
            if needs_resize:
                img = img.resize((width, height), Image.Resampling.LANCZOS)
            if crop:
                x, y, w, h = (int(v) for v in crop)
                img = img.crop((x, y, x + w, y + h))
                result["cropped"] = [x, y, w, h]
            img.save(out_path)
            result["width"], result["height"] = img.size
    elif needs_resize:
        result["coordinate_space"] = "window-logical"
    return result


def window_exists(hwnd):
    return bool(hwnd) and bool(win32gui.IsWindow(int(hwnd)))


def wait_window(title=None, cls=None, timeout=15.0, poll=0.2):
    deadline = time.time() + float(timeout)
    last = None
    while time.time() < deadline:
        try:
            return window_info(find_window(title, None, cls))
        except LookupError as exc:
            last = exc
        time.sleep(poll)
    raise LookupError("window did not appear within %ss (title=%r cls=%r): %s"
                      % (timeout, title, cls, last))


# ------------------------------------------------------------------ input

def _abs(dx, dy):
    vx = user32.GetSystemMetrics(76)
    vy = user32.GetSystemMetrics(77)
    vw = user32.GetSystemMetrics(78)
    vh = user32.GetSystemMetrics(79)
    return (int(round((dx - vx) * 65535.0 / max(vw - 1, 1))),
            int(round((dy - vy) * 65535.0 / max(vh - 1, 1))))


def cursor_pos():
    try:
        return list(win32api.GetCursorPos())
    except Exception as exc:
        raise RuntimeError("interactive desktop unavailable (locked session or secure desktop); unlock Windows before GUI input") from exc


def move_to(x, y, steps=1, delay=0.0):
    start = cursor_pos()
    for i in range(1, steps + 1):
        px = int(round(start[0] + (x - start[0]) * i / steps))
        py = int(round(start[1] + (y - start[1]) * i / steps))
        ax, ay = _abs(px, py)
        _send_inputs([_mouse_input(MOUSEEVENTF_MOVE | MOUSEEVENTF_ABSOLUTE | MOUSEEVENTF_VIRTUALDESK, ax, ay)])
        if delay:
            time.sleep(delay)
    return cursor_pos()


def click_at(x, y, button="left", nomove=False, hold=0.0, double=False, clics=1,
             restore=False, verify=None):
    start = cursor_pos()
    if not nomove:
        move_to(x, y)
        time.sleep(0.03)
    down = {"left": MOUSEEVENTF_LEFTDOWN, "right": MOUSEEVENTF_RIGHTDOWN,
            "middle": MOUSEEVENTF_MIDDLEDOWN}[button]
    up = {"left": MOUSEEVENTF_LEFTUP, "right": MOUSEEVENTF_RIGHTUP,
          "middle": MOUSEEVENTF_MIDDLEUP}[button]
    try:
        for _ in range(clics * (2 if double else 1)):
            if verify:
                verify()
            if abs(cursor_pos()[0] - x) > 3 or abs(cursor_pos()[1] - y) > 3:
                raise RuntimeError("cursor moved before click; input cancelled")
            _send_inputs([_mouse_input(down)])
            try:
                time.sleep(min(float(hold), 0.08))
            finally:
                _send_inputs([_mouse_input(up)])
            time.sleep(0.05)
    finally:
        if restore:
            move_to(start[0], start[1])
    return {"cursor": cursor_pos(), "restored_to": start if restore else None}


def drag(x1, y1, x2, y2, steps=12, hold=0.15, button="left", restore=False):
    start = cursor_pos()
    move_to(x1, y1)
    time.sleep(0.05)
    down = MOUSEEVENTF_LEFTDOWN if button == "left" else MOUSEEVENTF_RIGHTDOWN
    up = MOUSEEVENTF_LEFTUP if button == "left" else MOUSEEVENTF_RIGHTUP
    _send_inputs([_mouse_input(down)])
    try:
        time.sleep(hold)
        move_to(x2, y2, steps=steps, delay=0.01)
        time.sleep(hold)
    finally:
        try:
            _send_inputs([_mouse_input(up)])
        finally:
            if restore:
                move_to(start[0], start[1])
    return {"cursor": cursor_pos()}


def wheel(delta, x=None, y=None):
    if x is not None and y is not None:
        move_to(x, y)
        time.sleep(0.05)
    _send_inputs([_mouse_input(MOUSEEVENTF_WHEEL, 0, 0, int(delta))])
    return {"delta": delta}


def post_click(hwnd, x, y, button="left", double=False, client=True):
    """Click through the target's message queue: no cursor, no focus needed."""
    if not client:
        x, y = win32gui.ScreenToClient(hwnd, (int(x), int(y)))
    down = win32con.WM_LBUTTONDOWN if button == "left" else win32con.WM_RBUTTONDOWN
    up = win32con.WM_LBUTTONUP if button == "left" else win32con.WM_RBUTTONUP
    mk = win32con.MK_LBUTTON if button == "left" else win32con.MK_RBUTTON
    lp = (int(y) << 16) | (int(x) & 0xFFFF)
    win32gui.PostMessage(hwnd, win32con.WM_MOUSEMOVE, 0, lp)
    time.sleep(0.01)
    win32gui.PostMessage(hwnd, down, mk, lp)
    time.sleep(0.03)
    win32gui.PostMessage(hwnd, up, 0, lp)
    if double:
        time.sleep(0.04)
        win32gui.PostMessage(hwnd, win32con.WM_LBUTTONDBLCLK, mk, lp)
        time.sleep(0.02)
        win32gui.PostMessage(hwnd, up, 0, lp)
    return {"hwnd": int(hwnd), "x": int(x), "y": int(y), "double": bool(double)}


def type_text(text, per_char=0.0):
    for ch in text:
        if ch == "\n":
            _send_inputs([_key_input(0x0D), _key_input(0x0D, 0, KEYEVENTF_KEYUP)])
        elif ch == "\r":
            continue
        elif ch == "\t":
            _send_inputs([_key_input(0x09), _key_input(0x09, 0, KEYEVENTF_KEYUP)])
        else:
            code = ord(ch)
            _send_inputs([_key_input(0, code, KEYEVENTF_UNICODE),
                          _key_input(0, code, KEYEVENTF_UNICODE | KEYEVENTF_KEYUP)])
        if per_char:
            time.sleep(per_char)
    return len(text)


def post_text(hwnd, text, per_char=0.0):
    """Deliver characters as WM_CHAR straight to a control (console windows)."""
    for ch in text:
        code = 0x0D if ch == "\n" else ord(ch)
        win32gui.PostMessage(hwnd, win32con.WM_CHAR, code, 1)
        if per_char:
            time.sleep(per_char)
    return len(text)


def press_key(name, mods=None):
    mods = mods or []
    keys = []
    for m in mods:
        vk = VK.get(m.lower())
        if vk is None:
            raise ValueError("unknown modifier %r" % m)
        keys.append(vk)
    vk = VK.get(name.lower())
    if vk is None:
        if len(name) == 1:
            vk = ord(name.upper())
        else:
            raise ValueError("unknown key %r" % name)
    seq = [_key_input(k) for k in keys] + [_key_input(vk)]
    seq += [_key_input(vk, 0, KEYEVENTF_KEYUP)]
    seq += [_key_input(k, 0, KEYEVENTF_KEYUP) for k in reversed(keys)]
    _send_inputs(seq)
    return {"key": name, "mods": mods}


def set_clipboard(text):
    for _ in range(8):
        try:
            win32clipboard.OpenClipboard()
            win32clipboard.EmptyClipboard()
            win32clipboard.SetClipboardText(text, win32clipboard.CF_UNICODETEXT)
            win32clipboard.CloseClipboard()
            return True
        except Exception:
            time.sleep(0.1)
    raise RuntimeError("clipboard busy after retries")


def paste_text(text):
    set_clipboard(text)
    time.sleep(0.08)
    press_key("v", ["ctrl"])
    return {"pasted": len(text)}


# ------------------------------------------------------------------ window ops

def focus(hwnd, restore=True):
    if restore and win32gui.IsIconic(hwnd):
        win32gui.ShowWindow(hwnd, win32con.SW_RESTORE)
        time.sleep(0.35)
    try:
        win32gui.SetForegroundWindow(hwnd)
    except Exception:
        fg = win32gui.GetForegroundWindow()
        tid_fg = win32process.GetWindowThreadProcessId(fg)[0]
        tid_self = kernel32.GetCurrentThreadId()
        user32.AttachThreadInput(tid_self, tid_fg, True)
        try:
            win32gui.BringWindowToTop(hwnd)
            win32gui.SetForegroundWindow(hwnd)
        finally:
            user32.AttachThreadInput(tid_self, tid_fg, False)
    time.sleep(0.2)
    return window_info(hwnd)


def _is_foreground(hwnd):
    return _root_of(int(user32.GetForegroundWindow() or 0)) == _root_of(hwnd)


def raise_window(hwnd, settle=0.2):
    """Lift a window to the top of the Z-order without activating it.

    HWND_TOPMOST followed by HWND_NOTOPMOST keeps the window above every other
    normal window, which is the only way to un-cover eNSP when another app is
    maximised in front of it.
    """
    hwnd = int(hwnd)
    flags = win32con.SWP_NOMOVE | win32con.SWP_NOSIZE | win32con.SWP_NOACTIVATE
    win32gui.SetWindowPos(hwnd, win32con.HWND_TOPMOST, 0, 0, 0, 0, flags)
    time.sleep(0.06)
    win32gui.SetWindowPos(hwnd, win32con.HWND_NOTOPMOST, 0, 0, 0, 0, flags)
    time.sleep(settle)
    return {"raised": True, "hwnd": hwnd}


def window_at(x, y):
    """Top-level window that would receive a click at screen point (x, y)."""
    hwnd = int(win32gui.WindowFromPoint((int(x), int(y))) or 0)
    return _root_of(hwnd)


def activate(hwnd, method="auto", settle=0.2):
    """Bring ``hwnd`` to the foreground, falling back to raising + a real click.

    Windows only lets the foreground process steal focus, and an elevated
    sidecar usually is not it, so SetForegroundWindow alone is unreliable.
    """
    hwnd = int(hwnd)
    if win32gui.IsIconic(hwnd):
        win32gui.ShowWindow(hwnd, win32con.SW_RESTORE)
        time.sleep(0.3)
    tried = []
    if method == "switch":
        try:
            user32.SwitchToThisWindow(hwnd, True)
        except Exception as exc:
            tried.append("switch:%s" % exc)
        time.sleep(settle)
        if _is_foreground(hwnd):
            return {"activated": True, "method": "switch", "tried": tried}
        tried.append("switch:no")
    if method in ("auto", "setfg"):
        try:
            focus(hwnd, False)
        except Exception as exc:
            tried.append("setfg:%s" % exc)
        time.sleep(settle)
        if _is_foreground(hwnd):
            return {"activated": True, "method": "setforeground", "tried": tried}
        tried.append("setfg:no")
    if method in ("auto", "raise"):
        raise_window(hwnd)
        if _is_foreground(hwnd):
            return {"activated": True, "method": "raise", "tried": tried}
        tried.append("raise:no")
    if method in ("auto", "click"):
        rect = win32gui.GetWindowRect(hwnd)
        point = [(rect[0] + rect[2]) // 2, rect[1] + 10]
        def verify_title_target():
            if window_at(point[0], point[1]) != _root_of(hwnd):
                raise RuntimeError("activation target changed or is covered; input cancelled")
        verify_title_target()
        click_at(point[0], point[1], restore=True, verify=verify_title_target)
        time.sleep(settle)
        if _is_foreground(hwnd):
            return {"activated": True, "method": "titlebar-click", "point": point, "tried": tried}
        tried.append("click:no")
    return {"activated": False, "tried": tried}


def guard_foreground(expect, settle=0.2):
    """Make ``expect`` the foreground window or refuse to keep going."""
    # UAC can return control to the elevated helper before Windows switches
    # back from its secure desktop. Wait briefly without injecting any input.
    deadline = time.monotonic() + 3
    while True:
        try:
            cursor_pos()
            if user32.GetForegroundWindow():
                break
        except RuntimeError:
            pass
        if time.monotonic() >= deadline:
            raise RuntimeError("interactive desktop unavailable; unlock Windows before GUI input")
        time.sleep(0.1)
    target = _root_of(int(expect))
    foreground_hwnd = int(user32.GetForegroundWindow() or 0)
    if foreground_hwnd != target and int(_get_owner(foreground_hwnd, 4) or 0) == target:
        raise RuntimeError("target owns an active modal dialog; resolve it before sending input")
    info = activate(target, "auto", settle)
    if not info.get("activated"):
        raise RuntimeError(
            "refusing to send keystrokes: %r is not the foreground window (tried %s)"
            % (win32gui.GetWindowText(target), ", ".join(info.get("tried", []))))
    return info


def click_guarded(x, y, expect=None, raise_first=True, **kwargs):
    """Click only when the point really belongs to the expected window.

    A blind SendInput click on a covered eNSP would land in whatever app the
    user has in front, so the target is verified (and optionally raised first).
    """
    x, y = int(x), int(y)
    info = {"point": [x, y]}
    if expect is not None:
        target = _root_of(int(expect))
        info["expect"] = target
        hit = window_at(x, y)
        if hit != target and raise_first:
            raise_window(target)
            hit = window_at(x, y)
            info["raised"] = True
        if hit != target:
            raise RuntimeError(
                "refusing to click %s: that point belongs to %r (hwnd %s), not the expected window %s "
                "(bring eNSP to the front, or pass raise=false to override)"
                % ([x, y], win32gui.GetWindowText(hit), hit, target))
        info["covered"] = False
    def verify():
        if expect is not None and window_at(x, y) != target:
            raise RuntimeError("target changed immediately before click; input cancelled")
    info.update(click_at(x, y, verify=verify, **kwargs))
    return info


def resize(hwnd, x, y, width, height):
    win32gui.SetWindowPos(hwnd, win32con.HWND_TOP, int(x), int(y), int(width), int(height),
                          win32con.SWP_SHOWWINDOW)
    time.sleep(0.2)
    return window_info(hwnd)


def close_window(hwnd):
    win32gui.PostMessage(hwnd, win32con.WM_CLOSE, 0, 0)
    deadline = time.monotonic() + 1.0
    while time.monotonic() < deadline:
        if not window_exists(hwnd) or not win32gui.IsWindowVisible(hwnd):
            return {"closed": int(hwnd), "confirmed": True}
        time.sleep(0.05)
    return {"ok": False, "closed": None, "requested": int(hwnd),
            "error": "close requested but window remains visible; inspect dialogs or use close_project"}


def owned_dialogs(hwnd):
    pid = win32process.GetWindowThreadProcessId(hwnd)[1]
    return [w for w in enum_windows(None, True)
            if w["pid"] == pid and w["cls"] == "#32770"
            and int(_get_owner(w["hwnd"], 4) or 0) == int(hwnd)]


def ensure_on_work_area(hwnd):
    """Fit into the nearest monitor's work area, including negative origins."""
    with _dpi_context(-3):
        monitor = win32api.MonitorFromWindow(hwnd, 2)  # nearest
        work = win32api.GetMonitorInfo(monitor)["Work"]
        rect = win32gui.GetWindowRect(hwnd)
        width = min(rect[2] - rect[0], work[2] - work[0])
        height = min(rect[3] - rect[1], work[3] - work[1])
        x = min(max(rect[0], work[0]), work[2] - width)
        y = min(max(rect[1], work[1]), work[3] - height)
        if [x, y, x+width, y+height] != list(rect):
            win32gui.SetWindowPos(hwnd, 0, x, y, width, height,
                                  win32con.SWP_NOZORDER | win32con.SWP_NOACTIVATE)
            time.sleep(0.15)


def stable_main(hwnd):
    guard_foreground(hwnd)
    if owned_dialogs(hwnd):
        raise RuntimeError("eNSP has an owned modal dialog; resolve it before GUI input")
    ensure_on_work_area(hwnd)
    before = window_info(hwnd)
    time.sleep(0.12)
    after = window_info(hwnd)
    if before["rect"] != after["rect"]:
        raise RuntimeError("eNSP window moved during input preparation; retry after it settles")
    return after


def relative_click(hwnd, point, double=False):
    main = stable_main(hwnd)
    x = main["rect"][0] + round(point[0] * main["dpi_scale"])
    y = main["rect"][1] + round(point[1] * main["dpi_scale"])
    return click_guarded(x, y, hwnd, double=double, hold=0.08, restore=True)


def control_devices(hwnd, toolbar):
    """One foreground transaction. Never send Ctrl+A after a failed click."""
    main = stable_main(hwnd)
    view = canvas_view(hwnd)
    if not view:
        raise RuntimeError("eNSP canvas was not found")
    # Focus the canvas through its verified client rectangle, not a fixed
    # coordinate which may hit a label, sidebar, or another window.
    with _dpi_context(-3):
        rect = win32gui.GetClientRect(view["hwnd"])
    point = [view["origin"][0] + max(12, rect[2] - 40),
             view["origin"][1] + max(12, rect[3] - 40)]
    click_guarded(*point, expect=hwnd, hold=0.08, restore=True)
    if not _is_foreground(hwnd) or main["rect"] != window_info(hwnd)["rect"]:
        raise RuntimeError("eNSP focus or geometry changed before selection")
    press_key("a", ["ctrl"])
    time.sleep(0.12)
    return {"selection": "all", "click": relative_click(hwnd, toolbar)}


def close_project(hwnd, save="ask", timeout=8, dialog_hwnd=None):
    # Keep a handle to the original process: window destruction precedes teardown.
    pid = win32process.GetWindowThreadProcessId(hwnd)[1]
    handle = _open_process(0x00100000, False, pid)  # SYNCHRONIZE
    if not handle:
        return {"ok": False, "confirmed": False, "error": "cannot verify project process exit"}
    started = time.monotonic()
    try:
        result = _close_project_window(hwnd, save, timeout, dialog_hwnd)
        if result.get("confirmed"):
            remaining = max(0, min(max(float(timeout), 0.1), 60) - (time.monotonic() - started))
            exited = _wait_mutex(handle, int(remaining * 1000)) == 0
            result["processExited"] = exited
            if not exited:
                result.update(ok=False, confirmed=False, error="window closed but process exit is unconfirmed; do not relaunch yet")
        return result
    finally:
        _close_handle(handle)


def _close_project_window(hwnd, save="ask", timeout=8, dialog_hwnd=None):
    """Verify close; only handle the recognized native three-button prompt.

    'ask' leaves it visible and reports failure. No unknown dialog is accepted.
    Device flash must already have been saved through the console.
    """
    if save not in ("ask", "save", "discard", "cancel"):
        raise ValueError("save must be ask, save, discard, or cancel")
    pid = win32process.GetWindowThreadProcessId(hwnd)[1]
    before = {w["hwnd"] for w in owned_dialogs(hwnd)}
    if before and save != "ask" and dialog_hwnd not in before:
        return {"ok": False, "confirmed": False, "error": "existing dialog requires its inspected dialog_hwnd"}
    if not before:
        win32gui.PostMessage(hwnd, win32con.WM_CLOSE, 0, 0)
    deadline = time.monotonic() + min(max(float(timeout), 0.1), 60)
    acted = None
    acted_dialog = None
    while time.monotonic() < deadline:
        if not window_exists(hwnd) or not win32gui.IsWindowVisible(hwnd):
            return {"closed": int(hwnd), "confirmed": True, "pid": pid, "decision": acted}
        dialogs = owned_dialogs(hwnd)
        if dialogs:
            dialog = dialogs[0]
            if acted and dialog["hwnd"] == acted_dialog:
                time.sleep(0.1)
                continue  # saving may take time; never send the decision twice
            buttons = sorted([c for c in children(dialog["hwnd"], 1)
                              if c["cls"] == "Button" and c["visible"]], key=lambda c: c["rect"][0])
            # This skin paints labels. Its actual control IDs are stable and
            # are checked along with owner, title, number, and native class.
            ids = [win32gui.GetDlgCtrlID(c["hwnd"]) for c in buttons]
            recognized = (dialog["title"] == "eNSP" and len(buttons) == 3
                          and ids in ([6, 7, 2], [1310, 1308, 1352]))
            if save == "ask" or not recognized or acted:
                return {"ok": False, "confirmed": False, "dialog": dialog,
                        "button_ids": ids, "error": "close blocked by confirmation; inspect before choosing save policy"}
            selected = buttons[{"save": 0, "discard": 1, "cancel": 2}[save]]
            control_id = win32gui.GetDlgCtrlID(selected["hwnd"])
            # Invoke the recognized dialog command (BN_CLICKED), not BM_CLICK:
            # the eNSP skin ignores BM_CLICK on these painted buttons. Verify
            # disappearance below; message delivery alone never means success.
            win32gui.PostMessage(dialog["hwnd"], win32con.WM_COMMAND, control_id, selected["hwnd"])
            acted = save
            acted_dialog = dialog["hwnd"]
            if save == "cancel":
                return {"ok": False, "confirmed": False, "cancelled": True, "error": "close cancelled"}
        time.sleep(0.1)
    return {"ok": False, "confirmed": False, "decision": acted, "error": "window did not close before timeout"}


def send_text(hwnd, text):
    win32gui.SendMessage(hwnd, win32con.WM_SETTEXT, 0, text)
    return {"hwnd": int(hwnd), "text": text}


def click_button(hwnd):
    # A modal dialog opened by BM_CLICK must not hold the GUI transaction lock.
    # Posting acknowledges delivery only; callers inspect the resulting state.
    win32gui.PostMessage(hwnd, win32con.BM_CLICK, 0, 0)
    return {"clicked": int(hwnd), "posted": True}


def _root_of(hwnd):
    if not hwnd:
        return 0
    return int(win32gui.GetAncestor(int(hwnd), win32con.GA_ROOT) or hwnd)


def foreground():
    hwnd = user32.GetForegroundWindow()
    return {"hwnd": int(hwnd or 0), "title": win32gui.GetWindowText(hwnd) if hwnd else "",
            "cls": win32gui.GetClassName(hwnd) if hwnd else ""}


def safe_type(hwnd, text, per_char=0.02, settle=0.15, method="auto"):
    """Type into ``hwnd`` only after proving it owns the keyboard.

    SendInput goes to the foreground window, so a failed activation would leak
    keystrokes into whatever the user is actually looking at.  This refuses
    instead of typing blind.
    """
    hwnd = int(hwnd)
    info = activate(hwnd, method, settle)
    fg = int(user32.GetForegroundWindow() or 0)
    if not info.get("activated"):
        raise RuntimeError(
            "refusing to type: could not activate hwnd %s (foreground is %r); tried %s"
            % (hwnd, win32gui.GetWindowText(fg), ", ".join(info.get("tried", []))))
    typed = type_text(text, per_char)
    return {"typed": typed, "foreground": fg, "activation": info["method"]}


# --------------------------------------------------------------- process ops

def shell_open(path, wait=0.0):
    """ShellExecute 'open' inherits our elevation for executables."""
    rc = shell32.ShellExecuteW(None, "open", path, None,
                             os.path.dirname(os.path.abspath(path)), 1)
    if rc <= 32:
        raise RuntimeError("ShellExecuteW rc=%s for %s" % (rc, path))
    if wait:
        time.sleep(float(wait))
    return {"rc": rc}


def explorer_open(path, wait=0.0):
    """Hand the document to Explorer so the new process outlives this job."""
    rc = shell32.ShellExecuteW(None, "open", "explorer.exe", '"%s"' % path, None, 1)
    if rc <= 32:
        raise RuntimeError("explorer ShellExecute rc=%s" % rc)
    if wait:
        time.sleep(float(wait))
    return {"rc": rc}


def spawn_detached(exe, cmdline=None, workdir=None, breakaway=True):
    si = STARTUPINFO()
    si.cb = ctypes.sizeof(STARTUPINFO)
    si.dwFlags = 0x00000001
    si.wShowWindow = 1
    pi = PROCESS_INFORMATION()
    flags = DETACHED_PROCESS | CREATE_NEW_PROCESS_GROUP | CREATE_NO_WINDOW
    if breakaway:
        flags |= CREATE_BREAKAWAY_FROM_JOB
    kernel32.CreateProcessW.argtypes = [wt.LPCWSTR, wt.LPWSTR, wt.LPVOID, wt.LPVOID,
                                        wt.BOOL, wt.DWORD, wt.LPVOID, wt.LPCWSTR,
                                        ctypes.POINTER(STARTUPINFO),
                                        ctypes.POINTER(PROCESS_INFORMATION)]
    # argv[0] must remain one token when the executable lives under Program Files.
    command = cmdline or subprocess.list2cmdline([exe])
    command_buffer = ctypes.create_unicode_buffer(command)
    ok = kernel32.CreateProcessW(exe, command_buffer, None, None, False,
                                 flags, None, workdir, ctypes.byref(si), ctypes.byref(pi))
    if not ok:
        raise OSError("CreateProcess failed: %s" % ctypes.WinError())
    try:
        return {"pid": int(pi.dwProcessId), "breakaway": breakaway}
    finally:
        _close_handle(pi.hThread)
        _close_handle(pi.hProcess)


def kill_images(names, wait=0.0):
    killed = []
    for name in names:
        proc = subprocess.run(["taskkill", "/f", "/im", name], capture_output=True, text=True,
                              creationflags=CREATE_NO_WINDOW)
        killed.append({"image": name, "rc": proc.returncode,
                       "out": ((proc.stdout or proc.stderr) or "").strip()[:200]})
    if wait:
        time.sleep(float(wait))
    return killed


# --------------------------------------------------------------- eNSP helpers

def process_executable(pid):
    """Query an image path with limited, read-only access; fail closed on denial."""
    handle = _open_process(0x1000, False, int(pid))  # PROCESS_QUERY_LIMITED_INFORMATION
    if not handle:
        return None
    try:
        path = ctypes.create_unicode_buffer(32768)
        size = wt.DWORD(len(path))
        if _query_process_image(handle, 0, path, ctypes.byref(size)):
            return path.value
        return None
    finally:
        _close_handle(handle)


def _ensp_owned_windows(cls_matches):
    # Cache only for this enumeration: eNSP creates new processes per topology,
    # and Windows can reuse PIDs. Class names and titles do not identify eNSP.
    owned = {}
    rows = []
    for w in enum_windows(None, True):
        if not cls_matches(w["cls"]):
            continue
        pid = w["pid"]
        if pid not in owned:
            try:
                owned[pid] = ntpath.basename(process_executable(pid) or "").lower() == "ensp_client.exe"
            except OSError:
                owned[pid] = False
        if owned[pid]:
            rows.append(w)
    return rows


def ensp_windows():
    """Visible eNSP main windows, verified by their owning process executable."""
    return _ensp_owned_windows(lambda cls: cls.lower().startswith("afx:"))


def ensp_main():
    """The first visible eNSP client window, or a clear error."""
    wins = ensp_windows()
    if not wins:
        raise LookupError("no eNSP window is open")
    if len(wins) != 1:
        raise LookupError("multiple eNSP windows open; select an explicit hwnd")
    return wins[0]


def resolve_target(args):
    """Window selector used by every window op: hwnd / title / cls, or ensp=true."""
    if args.get("hwnd"):
        return find_window(hwnd=args["hwnd"])
    if args.get("ensp"):
        return ensp_main()["hwnd"]
    return find_window(args.get("title"), args.get("hwnd"), args.get("cls"))


def device_windows():
    """eNSP device windows: consoles and property dialogs (#32770, titled by device)."""
    return _ensp_owned_windows(lambda cls: cls == "#32770")


def canvas_anchors(main_hwnd):
    """Label anchors on the canvas.

    eNSP parks one invisible 30x22 ``Edit`` control on every device label.  The
    names are painted, not stored, so a caller pairs these rectangles with the
    .topo file's ``edit_left``/``edit_top`` to learn the canvas -> screen offset.
    Rectangles remain physical; multiply topology coordinates by the main
    window's ``dpi_scale`` before matching them to these rectangles.
    """
    rows = []
    scale = window_dpi(main_hwnd)["dpi_scale"]
    for item in children(main_hwnd, 2):
        width = (item["rect"][2] - item["rect"][0]) / scale
        height = (item["rect"][3] - item["rect"][1]) / scale
        if item["cls"] == "Edit" and abs(width - 30) <= 6 and abs(height - 22) <= 6:
            rows.append({"hwnd": item["hwnd"], "rect": item["rect"]})
    return rows


def canvas_view(main_hwnd):
    """Viewport geometry at 100% canvas zoom, independent of moved labels."""
    for item in children(main_hwnd, 1):
        if item["cls"].startswith("AfxFrameOrView") and item["visible"]:
            hwnd = item["hwnd"]
            with _dpi_context(-3):
                origin = win32gui.ClientToScreen(hwnd, (0, 0))
                scroll = [_get_scroll_pos(hwnd, 0), _get_scroll_pos(hwnd, 1)]
            return {"hwnd": hwnd, "origin": list(origin), "scroll": scroll}
    return None


def exe_version(path):
    """File/product version of an executable, for telling eNSP builds apart."""
    info = win32api.GetFileVersionInfo(path, "\\")
    ms, ls = info["FileVersionMS"], info["FileVersionLS"]
    return "%d.%d.%d.%d" % (ms >> 16, ms & 0xFFFF, ls >> 16, ls & 0xFFFF)


def exeinfo(path):
    out = {"path": path, "exists": os.path.exists(path)}
    if out["exists"]:
        try:
            out["version"] = exe_version(path)
        except Exception as exc:
            out["version_error"] = str(exc)
        try:
            out["modified"] = time.strftime("%Y-%m-%d %H:%M:%S",
                                            time.localtime(os.path.getmtime(path)))
        except Exception:
            pass
    return out


# ------------------------------------------------------------------ dispatch


def _port_owners(ports):
    """PID(s) holding the given TCP listening ports, via netstat (works elevated)."""
    wanted = set(int(port) for port in ports)
    owners = {}
    try:
        out = subprocess.run(["netstat", "-ano", "-p", "TCP"],
                             capture_output=True, text=True, errors="ignore").stdout
    except Exception:
        return owners
    for line in out.splitlines():
        parts = line.split()
        if len(parts) < 4:
            continue
        local, state, pid = parts[1], parts[3], parts[-1]
        if ":" not in local:
            continue
        try:
            port = int(local.rsplit(":", 1)[1])
        except ValueError:
            continue
        if port in wanted and state.upper() == "LISTENING":
            try:
                owners.setdefault(port, set()).add(int(pid))
            except ValueError:
                pass
    return owners


def free_ports(ports, wait=1.0):
    """Kill whatever still listens on these console ports (stale eNSP daemons)."""
    killed = []
    owners = _port_owners(ports)
    for port, pids in owners.items():
        for pid in pids:
            try:
                rc = subprocess.run(["taskkill", "/F", "/PID", str(pid)],
                                    capture_output=True, text=True).returncode
                killed.append({"port": port, "pid": pid, "rc": rc})
            except Exception as error:
                killed.append({"port": port, "pid": pid, "error": str(error)})
    if wait:
        time.sleep(float(wait))
    remaining = sorted(_port_owners(ports).keys())
    return {"killed": killed, "remaining": remaining}

def dispatch(op, args):
    if op == "ping":
        try:
            cursor = cursor_pos()
            desktop = True
        except RuntimeError:
            cursor, desktop = None, False
        return {"pong": True, "pid": os.getpid(), "elevated": is_elevated(),
                "dpi_aware": DPI_MODE, "cursor": cursor, "desktop_available": desktop,
                "screen": [user32.GetSystemMetrics(0), user32.GetSystemMetrics(1)]}
    if op == "windows":
        return {"windows": enum_windows(args.get("filter"), args.get("visible_only", True))}
    if op == "ensp":
        wins = ensp_windows()
        return {"windows": wins, "devices": device_windows(),
                "canvases": [{"main": w["hwnd"], "view": canvas_view(w["hwnd"])} for w in wins],
                "anchors": [{"main": w["hwnd"], "items": canvas_anchors(w["hwnd"])}
                            for w in wins]}
    if op == "pidwindows":
        rows = []
        want = int(args["pid"])
        def cb(h, _):
            _t, pid = win32process.GetWindowThreadProcessId(h)
            if pid != want:
                return True
            rows.append(window_info(h))
            return True
        win32gui.EnumWindows(cb, None)
        return {"windows": rows}
    if op == "screen":
        out = args["out"]
        width = user32.GetSystemMetrics(0)
        height = user32.GetSystemMetrics(1)
        hdesktop = user32.GetDesktopWindow()
        hdc = user32.GetWindowDC(hdesktop)
        src = win32ui.CreateDCFromHandle(hdc)
        mem = src.CreateCompatibleDC()
        bmp = win32ui.CreateBitmap()
        bmp.CreateCompatibleBitmap(src, width, height)
        mem.SelectObject(bmp)
        mem.BitBlt((0, 0), (width, height), src, (0, 0), win32con.SRCCOPY)
        os.makedirs(os.path.dirname(os.path.abspath(out)), exist_ok=True)
        bmp.SaveBitmapFile(mem, out)
        win32gui.DeleteObject(bmp.GetHandle())
        mem.DeleteDC()
        src.DeleteDC()
        user32.ReleaseDC(hdesktop, hdc)
        if out.lower().endswith(".png") and Image is not None:
            with Image.open(out) as img:
                img = img.convert("RGB")
                if args.get("crop"):
                    x, y, w, h = (int(v) for v in args["crop"])
                    img = img.crop((x, y, x + w, y + h))
                img.save(out)
        return {"out": out, "width": width, "height": height}
    if op == "children":
        hwnd = resolve_target(args)
        return {"children": children(hwnd, args.get("depth", 2))}
    if op == "texts":
        hwnd = resolve_target(args)
        return {"texts": texts(hwnd, args.get("depth", 2), args.get("only"))}
    if op == "find":
        hwnd = find_window(args.get("title"), args.get("hwnd"), args.get("cls"),
                           args.get("include_hidden", True))
        return {"window": window_info(hwnd)}
    if op == "info":
        hwnd = resolve_target(args)
        return {"window": window_info(hwnd)}
    if op == "dpi":
        return dpi_diagnostics(resolve_target(args))
    if op == "wait":
        return {"window": wait_window(args.get("title"), args.get("cls"),
                                      args.get("timeout", 15))}
    if op == "exists":
        return {"exists": window_exists(args.get("hwnd"))}
    if op == "shot":
        hwnd = resolve_target(args)
        return capture(hwnd, args["out"], args.get("crop"), args.get("mode", "blit"))
    if op == "show":
        hwnd = find_window(args.get("title"), args.get("hwnd"), args.get("cls"),
                           include_hidden=True)
        win32gui.ShowWindow(hwnd, win32con.SW_SHOWNORMAL if args.get("normal", True)
                            else win32con.SW_SHOW)
        if args.get("front", True):
            focus(hwnd, False)
        time.sleep(args.get("settle", 0.4))
        return {"window": window_info(hwnd)}
    if op == "focus":
        hwnd = resolve_target(args)
        return {"window": focus(hwnd, args.get("restore", True))}
    if op == "resize":
        hwnd = resolve_target(args)
        return {"window": resize(hwnd, args["x"], args["y"], args["w"], args["h"])}
    if op == "close":
        hwnd = resolve_target(args)
        return close_window(hwnd)
    if op == "close_project":
        return close_project(resolve_target(args), args.get("save", "ask"), args.get("timeout", 8), args.get("dialog_hwnd"))
    if op == "device_control":
        return control_devices(resolve_target(args), args["toolbar"])
    if op == "normalize_canvas":
        hwnd = resolve_target(args)
        result = relative_click(hwnd, args.get("toolbar", [624, 56]))
        time.sleep(0.2)
        return {"requested_zoom": 1, "method": "native-1:1", "click": result}
    if op == "device_click":
        hwnd = resolve_target(args)
        main = stable_main(hwnd)
        view = canvas_view(hwnd)
        if not view:
            raise RuntimeError("eNSP canvas was not found")
        scale = main["dpi_scale"]
        x = round(view["origin"][0] + (args["cx"] + args.get("half_width", 32) - view["scroll"][0]) * scale)
        y = round(view["origin"][1] + (args["cy"] + args.get("half_height", 28) - view["scroll"][1]) * scale)
        with _dpi_context(-3):
            right, bottom = win32gui.GetClientRect(view["hwnd"])[2:]
        if not (view["origin"][0] <= x < view["origin"][0] + right and view["origin"][1] <= y < view["origin"][1] + bottom):
            raise RuntimeError("device outside visible canvas; scroll it into view")
        return click_guarded(x, y, hwnd, double=True, hold=0.05, restore=True)
    if op == "cursor":
        return {"cursor": cursor_pos()}
    if op == "move":
        return {"cursor": move_to(args["x"], args["y"], args.get("steps", 1),
                                  args.get("delay", 0.0))}
    if op == "click":
        expect = None
        if args.get("expect"):
            expect = ensp_main()["hwnd"] if args["expect"] == "ensp" else (
                int(args["expect"]) if isinstance(args["expect"], int) else resolve_target({"title": args["expect"]}))
        elif args.get("ensp_rel"):
            expect = ensp_main()["hwnd"]
        if args.get("ensp_rel"):
            main = ensp_main()
            # Toolbar/config offsets are target-logical pixels; SendInput and
            # the guard's hit test both require physical screen coordinates.
            scale = main["dpi_scale"]
            x = main["rect"][0] + int(round(args["ensp_rel"][0] * scale))
            y = main["rect"][1] + int(round(args["ensp_rel"][1] * scale))
        else:
            x, y = args["x"], args["y"]
        if expect:
            return click_guarded(x, y, expect, args.get("raise_first", True),
                                 button=args.get("button", "left"),
                                 nomove=args.get("nomove", False), hold=args.get("hold", 0.0),
                                 double=args.get("double", False), clics=args.get("clics", 1),
                                 restore=args.get("restore", False))
        return click_at(x, y, args.get("button", "left"),
                        args.get("nomove", False), args.get("hold", 0.0),
                        args.get("double", False), args.get("clics", 1),
                        args.get("restore", False))
    if op == "ncclick":
        hwnd = resolve_target(args)
        lp = (int(args["y"]) << 16) | (int(args["x"]) & 0xFFFF)
        win32gui.PostMessage(hwnd, win32con.WM_NCLBUTTONDOWN, win32con.HTCLIENT, lp)
        time.sleep(0.05)
        win32gui.PostMessage(hwnd, win32con.WM_NCLBUTTONUP, 0, lp)
        return {"nc": [args["x"], args["y"]]}
    if op == "postclick":
        hwnd = resolve_target(args)
        return post_click(hwnd, args["x"], args["y"], args.get("button", "left"),
                          args.get("double", False), args.get("client", True))
    if op == "drag":
        return drag(args["x1"], args["y1"], args["x2"], args["y2"],
                    args.get("steps", 12), args.get("hold", 0.15),
                    args.get("button", "left"), args.get("restore", False))
    if op == "wheel":
        return wheel(args.get("delta", -120), args.get("x"), args.get("y"))
    if op == "type":
        guard = guard_foreground(ensp_main()["hwnd"]) if args.get("ensp") else None
        if args.get("expect"):
            guard = guard_foreground(resolve_target({"title": args["expect"]}) if isinstance(args["expect"], str)
                                     else args["expect"])
        out = {"typed": type_text(args["text"], args.get("per_char", 0.0))}
        if guard:
            out["activation"] = guard["method"]
        return out
    if op == "safetype":
        return safe_type(resolve_target(args), args["text"],
                         args.get("per_char", 0.02), args.get("settle", 0.15),
                         args.get("method", "auto"))
    if op == "activate":
        result = activate(resolve_target(args), args.get("method", "auto"), args.get("settle", 0.2))
        if not result.get("activated"):
            result.update(ok=False, error="target window could not be activated")
        return result
    if op == "raise":
        return raise_window(resolve_target(args), args.get("settle", 0.2))
    if op == "fg":
        return foreground()
    if op == "posttext":
        hwnd = resolve_target(args)
        return {"posted": post_text(hwnd, args["text"], args.get("per_char", 0.0))}
    if op == "key":
        if args.get("expect") or args.get("ensp"):
            target = ensp_main()["hwnd"] if args.get("ensp") else (
                resolve_target({"title": args["expect"]}) if isinstance(args["expect"], str) else args["expect"])
            guard_foreground(target)
        return press_key(args["key"], args.get("mods"))
    if op == "paste":
        if args.get("expect") or args.get("ensp"):
            target = ensp_main()["hwnd"] if args.get("ensp") else (
                resolve_target({"title": args["expect"]}) if isinstance(args["expect"], str) else args["expect"])
            guard_foreground(target)
        if args.get("hwnd"):
            focus(find_window(None, args["hwnd"]), True)
        return paste_text(args["text"])
    if op == "settext":
        hwnd = resolve_target(args)
        return send_text(hwnd, args["text"])
    if op == "bmclick":
        hwnd = resolve_target(args)
        return click_button(hwnd)
    if op == "wndat":
        return {"at": wnd_at(args["x"], args["y"])}
    if op == "exeinfo":
        return {"exe": exeinfo(args["path"])}
    if op == "open":
        return shell_open(args["path"], args.get("wait", 0.0))
    if op == "explore":
        return explorer_open(args["path"], args.get("wait", 0.0))
    if op == "spawn":
        return {"spawned": spawn_detached(args["exe"], args.get("cmdline"),
                                          args.get("workdir"), args.get("breakaway", True))}
    if op == "kill":
        return {"killed": kill_images(args["names"], args.get("wait", 0.0))}
    if op == "free_ports":
        return free_ports(args["ports"], args.get("wait", 1.0))
    if op == "sleep":
        time.sleep(float(args.get("t", 0.5)))
        return {"slept": args.get("t", 0.5)}
    if op == "exit":
        return {"bye": True}
    raise ValueError("unknown op %r" % op)


# ------------------------------------------------------------------ run modes

def run_job(job_path):
    """One-shot batch.  One launch carries every step: the fast path."""
    with open(job_path, "r", encoding="utf-8") as fh:
        job = json.load(fh)
    results = []
    started = time.time()
    current = {"index": None, "op": None}
    completed = threading.Event()

    def write_atomic(path, payload):
        temp = path + ".tmp"
        with open(temp, "w", encoding="utf-8") as handle:
            json.dump(payload, handle, ensure_ascii=False, indent=1)
        os.replace(temp, path)

    def expired():
        if completed.is_set():
            return
        try:
            payload = {"ok": False, "pid": os.getpid(), "error_code": "GUI_JOB_TIMEOUT",
                       "uncertain": True, "steps": list(results) + [{**current, "ok": False,
                       "error": "GUI job deadline exceeded; inspect state before retrying"}],
                       "ms": int((time.time() - started) * 1000)}
            write_atomic(job["result"], payload)
        finally:
            # Terminate ONLY this job process. Windows releases its mutex.
            # Never kill eNSP/device processes or replay an uncertain operation.
            os._exit(124)

    timeout = float(job.get("timeout_ms", 180000)) / 1000
    if not 0 < timeout <= 3600:
        raise ValueError("job timeout must be in (0, 3600000] ms")
    watchdog = threading.Timer(timeout, expired)
    watchdog.daemon = True
    watchdog.start()
    for index, step in enumerate(job.get("steps", [])):
        if not isinstance(step, dict) or "op" not in step:
            results.append({"index": index, "ok": False, "op": None,
                            "error": "step must be an object with op"})
            continue
        op = step["op"]
        current.update(index=index, op=op)
        if job.get("status"):
            write_atomic(job["status"], {"pid": os.getpid(), "started": started,
                         "deadline": started + timeout, **current, "state": "running"})
        args = {k: v for k, v in step.items() if k != "op"}
        t0 = time.time()
        try:
            with gui_transaction():
                payload = dispatch(op, args) or {}
            payload.setdefault("ok", True)
        except Exception as exc:
            payload = {"ok": False, "error": "%s: %s" % (type(exc).__name__, exc),
                       "trace": traceback.format_exc()[-1200:]}
        payload["index"] = index
        payload["op"] = op
        payload["ms"] = int((time.time() - t0) * 1000)
        results.append(payload)
        if job.get("stop_on_error") and not payload["ok"]:
            break
    out = {"ok": all(item["ok"] for item in results), "elevated": is_elevated(), "dpi_aware": DPI_MODE,
           "pid": os.getpid(), "steps": results, "ms": int((time.time() - started) * 1000)}
    completed.set()
    watchdog.cancel()
    write_atomic(job["result"], out)
    if job.get("status"):
        write_atomic(job["status"], {"pid": os.getpid(), "state": "finished", "ok": out["ok"]})


def serve(port, token):
    server = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    server.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    server.bind(("127.0.0.1", port))
    server.listen(8)
    log("listening %d" % port)
    while True:
        conn, _addr = server.accept()
        threading.Thread(target=_serve_conn, args=(conn, token), daemon=True).start()


def _serve_conn(conn, token):
    buf = b""
    try:
        conn.settimeout(900)
        while True:
            chunk = conn.recv(65536)
            if not chunk:
                return
            buf += chunk
            while b"\n" in buf:
                line, buf = buf.split(b"\n", 1)
                if not line.strip():
                    continue
                try:
                    req = json.loads(line.decode("utf-8"))
                except Exception as exc:
                    conn.sendall((json.dumps({"ok": False, "error": "bad json: %s" % exc})
                                  + "\n").encode())
                    continue
                if token and req.get("token") != token:
                    conn.sendall((json.dumps({"id": req.get("id"), "ok": False,
                                              "error": "bad token"}) + "\n").encode())
                    continue
                op = req.get("op")
                t0 = time.time()
                try:
                    with gui_transaction():
                        payload = dispatch(op, {k: v for k, v in req.items() if k != "op"}) or {}
                    payload.setdefault("ok", True)
                except Exception as exc:
                    payload = {"ok": False, "error": "%s: %s" % (type(exc).__name__, exc),
                               "trace": traceback.format_exc()[-1200:]}
                payload["id"] = req.get("id")
                payload["ms"] = int((time.time() - t0) * 1000)
                conn.sendall((json.dumps(payload, ensure_ascii=False) + "\n").encode())
                if op == "exit":
                    os._exit(0)
    except Exception:
        log("conn error: " + traceback.format_exc()[-500:])
    finally:
        try:
            conn.close()
        except Exception:
            pass


def main(argv=None):
    global DPI_MODE, LOG_PATH
    parser = argparse.ArgumentParser()
    parser.add_argument("--port", type=int, default=0)
    parser.add_argument("--token", default="")
    parser.add_argument("--log", default="")
    parser.add_argument("--job", default="")
    args = parser.parse_args(argv)
    LOG_PATH = args.log or None
    DPI_MODE = set_dpi_aware()
    log("start pid=%s elevated=%s dpi=%s mode=%s" % (os.getpid(), is_elevated(), DPI_MODE,
                                                     "job" if args.job else "serve"))
    if args.job:
        run_job(args.job)
        return
    serve(args.port, args.token)


if __name__ == "__main__":
    main()
