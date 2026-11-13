import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { discoverPythonCandidates } from '../lib/bridge-client.js'

const bridgePath = fileURLToPath(new URL('../lib/bridge.py', import.meta.url))
const candidates = [process.env.ENSP_TEST_PYTHON, ...discoverPythonCandidates(),
  ...(process.platform === 'win32' ? [] : ['python3', 'python'])].filter(Boolean)
const python = candidates.find((exe) => spawnSync(exe, ['-B', '-c', 'import sys'],
  { windowsHide: true, timeout: 5000 }).status === 0)

function runPython(t, script) {
  if (!python) return t.skip('Python unavailable; set ENSP_TEST_PYTHON to run bridge checks')
  const result = spawnSync(python, ['-B', '-', bridgePath], {
    input: script, encoding: 'utf8', windowsHide: true, timeout: 30000,
  })
  assert.equal(result.status, 0, `${result.error ?? ''}\n${result.stdout}\n${result.stderr}`)
}

test('bridge Python compiles without importing Win32 or writing bytecode', (t) => {
  runPython(t, 'import pathlib, sys; p = pathlib.Path(sys.argv[1]); compile(p.read_bytes(), str(p), "exec")')
})

test('bridge DPI, capture, discovery, and clicks with fully mocked Win32', (t) => {
  runPython(t, String.raw`
import ctypes
from pathlib import Path
import sys
import types
import unittest
from unittest.mock import Mock, patch

# Install stubs BEFORE executing bridge.py, even on Windows with pywin32.
# No native DLL calls, window enumeration, capture, messages, or elevation.
ctypes.windll = types.SimpleNamespace(
    user32=types.SimpleNamespace(), kernel32=types.SimpleNamespace(),
    shell32=types.SimpleNamespace())
for name in ('win32api', 'win32clipboard', 'win32con', 'win32gui', 'win32process', 'win32ui'):
    sys.modules[name] = types.ModuleType(name)
pil = types.ModuleType('PIL')
pil.Image = None
sys.modules['PIL'] = pil
b = types.ModuleType('bridge_under_test')
b.__file__ = sys.argv[1]
exec(compile(Path(sys.argv[1]).read_bytes(), sys.argv[1], 'exec'), b.__dict__)


class BridgeTests(unittest.TestCase):
    def test_inventory_retains_hidden_windows_and_marks_partial_process_scan(self):
        row = {'hwnd': 11, 'pid': 42, 'visible': False}
        process = types.SimpleNamespace(EnumProcesses=Mock(return_value=[0, 42, 99]))
        with patch.object(b, '_ensp_owned_windows', return_value=[row]) as discover, \
             patch.object(b, 'win32process', process), \
             patch.object(b, 'process_executable', side_effect=lambda pid: 'C:/eNSP/eNSP_Client.exe' if pid == 42 else None), \
             patch.object(b, 'owned_dialogs', return_value=[{'hwnd': 12}]), \
             patch.object(b.win32gui, 'IsWindowEnabled', return_value=False, create=True), \
             patch.object(b.user32, 'IsHungAppWindow', return_value=False, create=True):
            result = b.ensp_inventory()
            self.assertFalse(discover.call_args.kwargs['visible_only'])
            self.assertEqual(result['processes'][0]['pid'], 42)
            self.assertFalse(result['main_windows'][0]['visible'])
            self.assertFalse(result['main_windows'][0]['enabled'])
            self.assertFalse(result['process_scan_complete'])
            self.assertEqual(result['uninspected_process_count'], 1)
            self.assertFalse(result['active_project']['verified'])

    def test_save_dialog_posts_once_and_does_not_claim_project_saved(self):
        buttons = [{'hwnd': h, 'cls': 'Button', 'visible': True, 'rect': [i, 0, i + 1, 1]} for i, h in enumerate([21, 22, 23])]
        with patch.object(b, 'owned_dialogs', return_value=[{'hwnd': 12, 'title': 'eNSP'}]), \
             patch.object(b, 'children', return_value=buttons), \
             patch.object(b.win32gui, 'GetDlgCtrlID', side_effect=lambda h: {21: 6, 22: 7, 23: 2}[h], create=True), \
             patch.object(b.win32gui, 'PostMessage', create=True) as post, \
             patch.object(b, 'window_exists', return_value=False):
            result = b.dialog_decision(11, 12, 'save')
            post.assert_called_once_with(12, 273, 6, 21)
            self.assertTrue(result['confirmed'])
            self.assertFalse(result['projectPersistenceVerified'])
            with self.assertRaisesRegex(RuntimeError, 'stale'):
                b.dialog_decision(11, 99, 'save')
            post.assert_called_once()
        with patch.object(b, 'owned_dialogs', return_value=[{'hwnd': 12, 'title': 'Unknown'}]), \
             patch.object(b, 'children', return_value=[]), \
             patch.object(b.win32gui, 'PostMessage', create=True) as post:
            self.assertFalse(b.dialog_decision(11, 12, 'discard')['ok'])
            post.assert_not_called()

    def test_list_selection_by_native_label_rejects_missing_and_ambiguous_items(self):
        gui = types.SimpleNamespace(GetClassName=Mock(return_value='ListBox'),
            IsWindowVisible=Mock(return_value=True), GetWindowLong=Mock(return_value=0),
            GetParent=Mock(return_value=11), GetDlgCtrlID=Mock(return_value=42),
            SendMessage=Mock(side_effect=[2, 1, 1, 1, 0, 1]))
        with patch.object(b, 'win32gui', gui), patch.object(b.win32con, 'GWL_STYLE', -16, create=True), patch.object(b.win32con, 'WM_COMMAND', 273, create=True):
            self.assertTrue(b.select_list(12, text='HTTP')['confirmed'])
            self.assertEqual(gui.SendMessage.call_args_list[1].args, (12, 0x01A2, -1, 'HTTP'))
            gui.SendMessage.side_effect = [2, -1]
            with self.assertRaisesRegex(ValueError, 'not found'):
                b.select_list(12, text='HTTP')
            gui.SendMessage.side_effect = [3, 1, 2]
            with self.assertRaisesRegex(RuntimeError, 'ambiguous'):
                b.select_list(12, text='HTTP')
            gui.SendMessage.side_effect = [2]
            with self.assertRaisesRegex(RuntimeError, 'expected layout'):
                b.select_list(12, index=1, expected_count=3)

    def test_list_selection_notifies_parent_and_confirms_without_keyboard(self):
        gui = types.SimpleNamespace(GetClassName=Mock(return_value='ListBox'),
            IsWindowVisible=Mock(return_value=True), GetWindowLong=Mock(return_value=0),
            GetParent=Mock(return_value=11), GetDlgCtrlID=Mock(return_value=42),
            SendMessage=Mock(side_effect=[3, 2, 0, 2]))
        with patch.object(b, 'win32gui', gui), patch.object(b.win32con, 'GWL_STYLE', -16, create=True), patch.object(b.win32con, 'WM_COMMAND', 273, create=True), patch.object(b, 'press_key') as key:
            self.assertTrue(b.select_list(12, 2)['confirmed'])
            self.assertEqual(gui.SendMessage.call_args_list[2].args, (11, 273, (1 << 16) | 42, 12))
            key.assert_not_called()
            gui.SendMessage.reset_mock(side_effect=True)
            gui.SendMessage.side_effect = [3, 2, 0, 1]
            with self.assertRaisesRegex(RuntimeError, 'changed'):
                b.select_list(12, 2)
            gui.GetWindowLong.return_value = 0x0800
            gui.SendMessage.side_effect = None
            gui.SendMessage.return_value = 3
            with self.assertRaisesRegex(RuntimeError, 'multi-select'):
                b.select_list(12, 1)

    def test_tab_selection_uses_queried_rect_and_checks_native_selection(self):
        replies = [3, 0, 2]
        with patch.object(b, 'tab_message', side_effect=replies), patch.object(b, 'tab_item_rect', return_value=[120, 0, 240, 24]), patch.object(b, 'window_dpi', return_value={'context': None, 'dpi_scale': 1.5}), patch.object(b.win32gui, 'IsWindowVisible', return_value=True, create=True), patch.object(b.win32gui, 'GetClientRect', return_value=[0, 0, 300, 200], create=True), patch.object(b, 'post_click') as click:
            result = b.select_tab(12, 2)
            self.assertTrue(result['confirmed'])
            click.assert_called_once_with(12, 270, 18, client=True)

    def test_tab_selection_refuses_out_of_range_and_invalid_geometry(self):
        with patch.object(b, 'tab_message', return_value=2), patch.object(b, 'post_click') as click:
            with self.assertRaises(ValueError):
                b.select_tab(12, 2)
            click.assert_not_called()
        with patch.object(b, 'tab_message', return_value=3), patch.object(b, 'tab_item_rect', return_value=[-10, 0, 240, 24]), patch.object(b, 'window_dpi', return_value={'context': None, 'dpi_scale': 1.5}), patch.object(b.win32gui, 'IsWindowVisible', return_value=True, create=True), patch.object(b.win32gui, 'GetClientRect', return_value=[0, 0, 300, 200], create=True), patch.object(b, 'post_click') as click:
            with self.assertRaises(RuntimeError):
                b.select_tab(12, 2)
            click.assert_not_called()

    def test_button_click_posts_without_waiting_for_modal_dialog(self):
        with patch.object(b.win32gui, 'PostMessage', create=True) as post, patch.object(b.win32gui, 'SendMessage', create=True) as send, patch.object(b.win32con, 'BM_CLICK', 245, create=True):
            self.assertTrue(b.click_button(12)['posted'])
            post.assert_called_once_with(12, 245, 0, 0)
            send.assert_not_called()

    def test_texts_reads_remote_edit_with_bounded_system_message(self):
        def send(hwnd, msg, count, buffer, flags, timeout, result):
            self.assertEqual((hwnd, msg, flags, timeout), (12, 13, 2, 500))
            text = ctypes.create_unicode_buffer('PC>ping\r\n5 packet(s) received')
            ctypes.memmove(buffer, text, ctypes.sizeof(text))
            return 1
        api = types.SimpleNamespace(SendMessageTimeoutW=Mock(side_effect=send))
        with patch.object(b, 'user32', api), patch.object(b, 'children', return_value=[{'hwnd':12,'cls':'RichEdit20A','txt':'','local':[0,0,1,1]}]):
            result = b.texts(11, only='RichEdit20A')
            self.assertIn('5 packet(s) received', result[0]['txt'])
            api.SendMessageTimeoutW.return_value = 0
            api.SendMessageTimeoutW.side_effect = None
            self.assertEqual(b.texts(11, only='RichEdit20A'), [])

    def test_spawn_quotes_default_and_closes_handles(self):
        seen = []
        def create(exe, command, *args):
            seen.append(command.value)
            pi = args[-1]._obj
            pi.dwProcessId, pi.hThread, pi.hProcess = 123, 456, 789
            return 1
        kernel = types.SimpleNamespace(CreateProcessW=Mock(side_effect=create))
        with patch.object(b, 'kernel32', kernel), patch.object(b, '_close_handle') as close:
            exe = 'C:/Program Files/Huawei/eNSP/eNSP_Client.exe'
            self.assertEqual(b.spawn_detached(exe)['pid'], 123)
            self.assertEqual(seen[0], '"' + exe + '"')
            self.assertEqual([call.args[0] for call in close.call_args_list], [456, 789])
            b.spawn_detached(exe, '"custom.exe" --flag')
            self.assertEqual(seen[1], '"custom.exe" --flag')

    def setUp(self):
        self.context = -4
        self.target_context = -1  # DPI unaware, as with eNSP's compatibility mode
        self.physical = (320, 200, 2240, 1400)
        self.logical = (213, 133, 1493, 933)
        self.events = []
        self.minimized = False
        self.print_ok = True
        self.get_rect = Mock(side_effect=self.rect)
        self.gui = types.SimpleNamespace(
            GetWindowRect=self.get_rect,
            GetWindowText=Mock(return_value='eNSP'),
            GetClassName=Mock(return_value='Afx:Main'),
            ClientToScreen=Mock(side_effect=lambda *_: self.physical[:2]),
            GetClientRect=Mock(return_value=(0, 0, 1900, 1160)),
            IsWindowVisible=Mock(return_value=True),
            IsIconic=Mock(side_effect=lambda _: self.minimized),
            ShowWindow=Mock(side_effect=self.restore),
            RedrawWindow=Mock(), UpdateWindow=Mock(),
            GetWindowDC=Mock(side_effect=self.get_dc),
            DeleteObject=Mock(), ReleaseDC=Mock(),
        )
        # Spec catches unsupported PyCDC methods (e.g. Detach).
        self.src = Mock(spec=['CreateCompatibleDC', 'DeleteDC'])
        self.mem = Mock(spec=['SelectObject', 'BitBlt', 'GetSafeHdc', 'DeleteDC'])
        self.src.CreateCompatibleDC.return_value = self.mem
        self.mem.BitBlt.side_effect = self.blit
        self.bmp = Mock(spec=['CreateCompatibleBitmap', 'SaveBitmapFile', 'GetHandle'])
        self.bmp.CreateCompatibleBitmap.side_effect = self.allocate
        self.bmp.SaveBitmapFile.side_effect = lambda *_: self.events.append(('bitmap-saved',))
        self.ui = types.SimpleNamespace(CreateDCFromHandle=Mock(return_value=self.src),
                                        CreateBitmap=Mock(return_value=self.bmp))
        self.image = Mock()
        self.image.open.side_effect = lambda _: FakeImage(self, self.native_size)
        self.user32 = types.SimpleNamespace(PrintWindow=Mock(side_effect=self.print_window),
                                            GetSystemMetrics=Mock(side_effect=[2560, 1600]))
        constants = types.SimpleNamespace(RDW_INVALIDATE=1, RDW_ALLCHILDREN=2,
            RDW_UPDATENOW=4, RDW_FRAME=8, SRCCOPY=0xCC0020, SW_RESTORE=9, WM_CLOSE=16, WM_COMMAND=273)
        self.patches = [
            patch.multiple(b, win32gui=self.gui, win32ui=self.ui, win32con=constants,
                user32=self.user32, Image=self.image,
                win32process=types.SimpleNamespace(GetWindowThreadProcessId=Mock(return_value=(7, 42))),
                _set_thread_dpi=Mock(side_effect=self.set_context),
                _get_window_dpi_context=Mock(side_effect=lambda _: self.target_context),
                _get_dpi_awareness=Mock(return_value=0), _get_window_dpi=Mock(return_value=96)),
            patch.object(b.time, 'sleep'), patch.object(b.os, 'makedirs'),
        ]
        for p in self.patches:
            p.start()
            self.addCleanup(p.stop)

    def set_context(self, context):
        old = self.context
        self.context = context
        return old

    def rect(self, hwnd):
        if self.minimized:
            raise AssertionError('must restore before reading capture dimensions')
        return self.physical if self.context in (-3, -4) else self.logical

    def restore(self, *_):
        self.events.append(('restore',))
        self.minimized = False

    def get_dc(self, _):
        self.assertEqual(self.context, self.target_context)
        return 123

    def allocate(self, src, width, height):
        self.assertIs(src, self.src)
        self.native_size = (width, height)
        self.events.append(('allocate', self.native_size))

    def blit(self, dest, size, src, origin, raster_op):
        self.assertEqual(self.context, self.target_context)
        self.assertEqual(size, (1280, 800))
        self.events.append(('blit', size))

    def print_window(self, *_):
        self.assertEqual(self.context, self.target_context)
        self.assertEqual(self.native_size, (1280, 800))
        return self.print_ok

    def test_window_info_is_physical_and_dpi_comes_from_target_context(self):
        info = b.window_info(11)
        self.assertEqual(info['rect'], [320, 200, 2240, 1400])
        self.assertEqual(info['client_origin'], [320, 200])
        self.assertEqual(info['dpi_scale'], 1.5)
        self.assertEqual(b.window_dpi(11)['window_dpi'], 96)
        self.assertEqual(self.context, -4)

    def test_per_monitor_aware_window_has_no_virtualization_scale(self):
        self.target_context = -3
        b._get_window_dpi.return_value = 144
        self.assertEqual(b.window_info(11)['dpi_scale'], 1.0)
        self.assertEqual(b.window_dpi(11)['source_size'], [1920, 1200])

    def test_system_aware_window_on_other_monitor_uses_target_ratio(self):
        self.target_context = -2
        self.logical = (256, 160, 1792, 1120)
        b._get_window_dpi.return_value = 120
        self.assertEqual(b.window_dpi(11)['dpi_scale'], 1.25)

    def test_context_handles_are_pointer_sized(self):
        self.target_context = 0x100000001
        self.assertEqual(b.window_dpi(11)['dpi_scale'], 1.5)
        b._set_thread_dpi.assert_any_call(0x100000001)
        self.assertEqual(self.context, -4)

    def test_context_restored_when_measurement_fails(self):
        self.get_rect.side_effect = OSError('window destroyed')
        with self.assertRaises(OSError):
            b.window_info(11)
        self.assertEqual(self.context, -4)

    def test_missing_dpi_apis_leave_geometry_unchanged(self):
        with patch.multiple(b, _set_thread_dpi=None, _get_window_dpi_context=None,
                            _get_dpi_awareness=None, _get_window_dpi=None):
            info = b.window_dpi(11)
        self.assertEqual(info['source_size'], [1920, 1200])
        self.assertEqual(info['dpi_scale'], 1.0)

    def test_capture_reads_full_native_extent_and_resizes_before_physical_crop(self):
        result = b.capture(11, 'mock.png', [100, 150, 640, 480])
        self.assertEqual(result['source_size'], [1280, 800])
        self.assertEqual(result['physical_size'], [1920, 1200])
        self.assertEqual((result['width'], result['height']), (640, 480))
        self.assertEqual(result['coordinate_space'], 'physical')
        self.assertEqual(self.events, [('allocate', (1280, 800)), ('blit', (1280, 800)),
            ('bitmap-saved',), ('resize', (1920, 1200)), ('crop', (100, 150, 740, 630)),
            ('image-saved', (640, 480))])
        self.assertEqual(self.context, -4)
        self.gui.ReleaseDC.assert_called_once_with(11, 123)
        self.src.DeleteDC.assert_called_once()
        self.mem.DeleteDC.assert_called_once()
        self.assertEqual(self.mem.SelectObject.call_count, 2)

    def test_print_window_uses_native_extent_then_resizes(self):
        result = b.capture(11, 'mock.bmp', mode='print')
        self.assertEqual((result['width'], result['height']), (1920, 1200))
        self.mem.BitBlt.assert_not_called()
        self.user32.PrintWindow.assert_called_once()

    def test_capture_failure_releases_resources_and_restores_context(self):
        self.print_ok = False
        with self.assertRaisesRegex(RuntimeError, 'PrintWindow failed'):
            b.capture(11, 'mock.png', mode='print')
        self.assertEqual(self.context, -4)
        self.gui.ReleaseDC.assert_called_once_with(11, 123)
        self.bmp.SaveBitmapFile.assert_not_called()
        self.mem.DeleteDC.assert_called_once()

    def test_capture_restores_minimized_window_before_geometry(self):
        self.minimized = True
        result = b.capture(11, 'mock.png')
        self.assertEqual(self.events[0], ('restore',))
        self.gui.ShowWindow.assert_called_once_with(11, 9)
        self.assertEqual((result['width'], result['height']), (1920, 1200))

    def test_failed_restore_does_not_capture_minimized_bitmap(self):
        self.minimized = True
        self.gui.ShowWindow.side_effect = None
        with self.assertRaisesRegex(RuntimeError, 'restore failed'):
            b.capture(11, 'mock.png')
        self.get_rect.assert_not_called()
        self.gui.GetWindowDC.assert_not_called()

    def test_without_pillow_bmp_reports_honest_logical_dimensions(self):
        with patch.object(b, 'Image', None):
            result = b.capture(11, 'mock.bmp')
        self.assertEqual((result['width'], result['height']), (1280, 800))
        self.assertEqual(result['coordinate_space'], 'window-logical')

    def test_missing_pillow_rejects_png_before_capture(self):
        with patch.object(b, 'Image', None), self.assertRaisesRegex(RuntimeError, 'Pillow'):
            b.capture(11, 'mock.png')
        self.gui.GetWindowDC.assert_not_called()

    def test_scaled_canvas_anchors_keep_physical_rectangles(self):
        rows = [
            {'hwnd': 1, 'cls': 'Edit', 'rect': [500, 400, 545, 433]},
            {'hwnd': 2, 'cls': 'Edit', 'rect': [500, 400, 800, 433]},
            {'hwnd': 3, 'cls': 'Static', 'rect': [500, 400, 545, 433]},
        ]
        with patch.object(b, 'children', return_value=rows):
            self.assertEqual(b.canvas_anchors(11), [{'hwnd': 1, 'rect': [500, 400, 545, 433]}])

    def test_canvas_view_uses_viewport_origin_and_scroll_not_moved_labels(self):
        rows = [{'hwnd': 17, 'cls': 'AfxFrameOrView80su', 'visible': True}]
        with patch.object(b, 'children', return_value=rows), \
             patch.object(b, '_get_scroll_pos', side_effect=[120, 30]), \
             patch.object(b.win32gui, 'ClientToScreen', return_value=(618, 338)):
            self.assertEqual(b.canvas_view(11), {'hwnd': 17, 'origin': [618, 338], 'scroll': [120, 30]})

    def test_send_input_partial_delivery_raises(self):
        with patch.object(b.user32, 'SendInput', return_value=0, create=True):
            with self.assertRaisesRegex(RuntimeError, '0 of 1'):
                b._send_inputs([b._key_input(13)])

    def test_locked_desktop_has_actionable_error(self):
        with patch.object(b.win32api, 'GetCursorPos', side_effect=OSError('access denied'), create=True):
            with self.assertRaisesRegex(RuntimeError, 'unlock Windows'):
                b.cursor_pos()

    def test_locked_desktop_does_not_mark_resident_bridge_unhealthy(self):
        with patch.object(b, 'cursor_pos', side_effect=RuntimeError('locked')), \
             patch.object(b, 'is_elevated', return_value=True), \
             patch.object(b.user32, 'GetSystemMetrics', side_effect=[2560, 1600]):
            out = b.dispatch('ping', {})
            self.assertTrue(out['pong'])
            self.assertFalse(out['desktop_available'])
            self.assertIsNone(out['cursor'])

    def test_drag_releases_button_and_restores_cursor_after_move_failure(self):
        with patch.object(b, 'cursor_pos', return_value=[7, 8]), \
             patch.object(b, 'move_to', side_effect=[None, RuntimeError('moved'), None]) as move, \
             patch.object(b, '_send_inputs') as send:
            with self.assertRaisesRegex(RuntimeError, 'moved'):
                b.drag(100, 100, 200, 200, restore=True)
            flags = [call.args[0][0].union.mi.dwFlags for call in send.call_args_list]
            self.assertEqual(flags, [b.MOUSEEVENTF_LEFTDOWN, b.MOUSEEVENTF_LEFTUP])
            self.assertEqual(move.call_args.args, (7, 8))

    def test_gui_mutex_is_released_and_handle_closed_after_failure(self):
        with patch.object(b, '_create_mutex', return_value=99), \
             patch.object(b, '_wait_mutex', return_value=0), \
             patch.object(b, '_release_mutex') as release, patch.object(b, '_close_handle') as close:
            with self.assertRaisesRegex(RuntimeError, 'action failed'):
                with b.gui_transaction():
                    raise RuntimeError('action failed')
            release.assert_called_once_with(99)
            close.assert_called_once_with(99)

    def test_guard_rechecks_target_after_moving_and_restores_cursor_on_failure(self):
        with patch.object(b, '_root_of', return_value=11), \
             patch.object(b, 'window_at', side_effect=[11, 99]), \
             patch.object(b, 'cursor_pos', return_value=[7, 8]), \
             patch.object(b, 'move_to') as move, patch.object(b, '_send_inputs') as send:
            with self.assertRaisesRegex(RuntimeError, 'target changed'):
                b.click_guarded(100, 100, expect=11, restore=True)
            send.assert_not_called()
            self.assertEqual(move.call_args.args, (7, 8))

    def test_mouse_button_is_released_and_cursor_restored_if_hold_fails(self):
        with patch.object(b, 'cursor_pos', return_value=[100, 100]), \
             patch.object(b, 'move_to') as move, patch.object(b, '_send_inputs') as send, \
             patch.object(b.time, 'sleep', side_effect=[None, RuntimeError('interrupted')]):
            with self.assertRaisesRegex(RuntimeError, 'interrupted'):
                b.click_at(100, 100, restore=True)
            flags = [call.args[0][0].union.mi.dwFlags for call in send.call_args_list]
            self.assertEqual(flags, [b.MOUSEEVENTF_LEFTDOWN, b.MOUSEEVENTF_LEFTUP])
            self.assertEqual(move.call_args.args, (100, 100))

    def test_activation_title_click_refuses_covering_window(self):
        with patch.object(b, '_is_foreground', return_value=False), \
             patch.object(b, '_root_of', return_value=11), \
             patch.object(b, 'window_at', return_value=99), \
             patch.object(b, 'click_at') as click:
            with self.assertRaisesRegex(RuntimeError, 'activation target changed'):
                b.activate(11, method='click', settle=0)
            click.assert_not_called()

    def test_keyboard_start_has_no_mouse_input_and_checks_foreground(self):
        with patch.object(b, 'owned_dialogs', return_value=[]), \
             patch.object(b, 'activate', return_value={'activated': True}), \
             patch.object(b, 'window_info', return_value={'rect': [0,0,100,100]}), \
             patch.object(b, '_is_foreground', return_value=True), \
             patch.object(b, 'press_key') as key, patch.object(b, 'click_at') as click:
            self.assertEqual(b.start_devices(11)['method'], 'keyboard')
            key.assert_called_once_with('a', ['ctrl', 'alt'])
            click.assert_not_called()
        with patch.object(b, 'owned_dialogs', return_value=[]), \
             patch.object(b, 'activate', return_value={'activated': True}), \
             patch.object(b, 'window_info', return_value={'rect': [0,0,100,100]}), \
             patch.object(b, '_is_foreground', return_value=False), patch.object(b, 'press_key') as key:
            with self.assertRaisesRegex(RuntimeError, 'changed'):
                b.start_devices(11)
            key.assert_not_called()

    def test_geometry_change_prevents_selection_keys(self):
        with patch.object(b, 'cursor_pos'), patch.object(b, 'guard_foreground'), \
             patch.object(b, 'owned_dialogs', return_value=[]), \
             patch.object(b, 'ensure_on_work_area'), \
             patch.object(b, 'window_info', side_effect=[{'rect': [0,0,100,100]}, {'rect': [10,0,110,100]}]), \
             patch.object(b, 'press_key') as key:
            with self.assertRaisesRegex(RuntimeError, 'moved'):
                b.control_devices(11, [659, 56])
            key.assert_not_called()

    def test_offscreen_window_is_fitted_to_negative_monitor_work_area(self):
        with patch.object(b.win32api, 'MonitorFromWindow', return_value=1, create=True), \
             patch.object(b.win32api, 'GetMonitorInfo', return_value={'Work': [-1920, 0, 0, 1040]}, create=True), \
             patch.object(b.win32gui, 'GetWindowRect', return_value=(-2500, 800, -500, 2000)), \
             patch.object(b.win32gui, 'SetWindowPos', create=True) as position, \
             patch.object(b.win32con, 'SWP_NOZORDER', 4, create=True), \
             patch.object(b.win32con, 'SWP_NOACTIVATE', 16, create=True):
            b.ensure_on_work_area(11)
            self.assertEqual(position.call_args.args, (11, 0, -1920, 0, 1920, 1040, 20))

    def test_multiple_main_windows_fail_instead_of_guessing(self):
        with patch.object(b, 'ensp_windows', return_value=[{'hwnd': 1}, {'hwnd': 2}]):
            with self.assertRaisesRegex(LookupError, 'multiple'):
                b.ensp_main()

    def close_patches(self, ids):
        dialog = {'hwnd': 22, 'title': 'eNSP'}
        buttons = [{'hwnd': 30+i, 'cls': 'Button', 'visible': True, 'rect': [i*100,0,i*100+50,30]} for i in range(3)]
        return [patch.object(b.win32gui, 'PostMessage', create=True),
                patch.object(b.win32gui, 'GetDlgCtrlID', side_effect=lambda hwnd: ids[hwnd-30], create=True),
                patch.object(b, 'owned_dialogs', side_effect=[[], [dialog]]),
                patch.object(b, 'children', return_value=buttons),
                patch.object(b, 'window_exists', side_effect=[True, False]),
                patch.object(b, 'guard_foreground'), patch.object(b, 'click_guarded')]

    def test_close_project_saves_only_recognized_owned_dialog_and_verifies_disappearance(self):
        with patch.object(b, '_open_process', return_value=999), patch.object(b, '_wait_mutex', return_value=0), patch.object(b, '_close_handle'):
            self.check_close_project_saved()

    def check_close_project_saved(self):
        ps = self.close_patches([1310, 1308, 1352])
        mocks = [p.start() for p in ps]
        try:
            out = b.close_project(11, 'save')
            self.assertTrue(out['confirmed'])
            self.assertEqual(out['decision'], 'save')
            self.assertEqual(mocks[0].call_args.args, (22, 273, 1310, 30))
        finally:
            for p in reversed(ps): p.stop()

    def test_unknown_close_dialog_is_reported_without_accepting(self):
        with patch.object(b, '_open_process', return_value=999), patch.object(b, '_close_handle'):
            self.check_unknown_close_dialog()

    def check_unknown_close_dialog(self):
        ps = self.close_patches([100, 101, 102])
        mocks = [p.start() for p in ps]
        try:
            out = b.close_project(11, 'save')
            self.assertFalse(out['ok'])
            mocks[-1].assert_not_called()
        finally:
            for p in reversed(ps): p.stop()

    def test_close_project_requires_process_exit_after_window_disappears(self):
        with patch.object(b, '_open_process', return_value=999), patch.object(b, '_wait_mutex', return_value=258), patch.object(b, '_close_handle') as close, patch.object(b, '_close_project_window', return_value={'confirmed': True}):
            result = b.close_project(11, 'save', timeout=0.1)
            self.assertFalse(result['confirmed'])
            self.assertFalse(result['processExited'])
            self.assertIn('do not relaunch', result['error'])
            close.assert_called_once_with(999)

    def test_absolute_move_uses_virtual_desktop_and_physical_metrics(self):
        with patch.object(b.win32api, 'GetCursorPos', return_value=(0, 0), create=True), \
             patch.object(b.user32, 'GetSystemMetrics', side_effect=[-1920, 0, 4480, 1600]), \
             patch.object(b, '_send_inputs') as send:
            b.move_to(-100, 500)
            event = send.call_args.args[0][0].union.mi
            self.assertTrue(event.dwFlags & b.MOUSEEVENTF_VIRTUALDESK)
            self.assertEqual(event.dx, round(1820 * 65535 / 4479))

    def test_process_identity_filters_main_and_device_windows(self):
        rows = [
            {'hwnd': 1, 'pid': 42, 'cls': 'Afx:main', 'title': 'topology'},
            {'hwnd': 2, 'pid': 99, 'cls': 'Afx:other', 'title': 'eNSP'},
            {'hwnd': 3, 'pid': 42, 'cls': '#32770', 'title': 'R1'},
            {'hwnd': 4, 'pid': 99, 'cls': '#32770', 'title': 'R1'},
            {'hwnd': 5, 'pid': 42, 'cls': '#32770', 'title': 'R2'},
            {'hwnd': 6, 'pid': 88, 'cls': 'Afx:denied', 'title': 'eNSP'},
            {'hwnd': 7, 'pid': 88, 'cls': '#32770', 'title': 'R2'},
        ]
        paths = {42: r'C:\Huawei\ENSP_CLIENT.EXE', 99: r'C:\Other\editor.exe', 88: None}
        with patch.object(b, 'enum_windows', return_value=rows), \
             patch.object(b, 'process_executable', side_effect=paths.get) as exe:
            self.assertEqual([w['hwnd'] for w in b.ensp_windows()], [1])
            exe.reset_mock()
            self.assertEqual([w['hwnd'] for w in b.device_windows()], [3, 5])
            self.assertEqual(exe.call_count, 3)  # one query per PID in each call
            paths[42] = r'C:\Other\reused-pid.exe'
            self.assertEqual(b.device_windows(), [])  # no cross-call PID cache

    def test_service_process_windows_require_matching_install_root(self):
        rows = [
            {'hwnd': 1, 'pid': 42, 'cls': 'Afx:main', 'title': 'topology'},
            {'hwnd': 2, 'pid': 43, 'cls': '#32770', 'title': 'SERVER'},
            {'hwnd': 3, 'pid': 44, 'cls': '#32770', 'title': 'CLIENT'},
            {'hwnd': 4, 'pid': 45, 'cls': '#32770', 'title': 'SERVER'},
        ]
        paths = {42: r'C:\Huawei\eNSP_Client.exe',
                 43: r'C:\Huawei\plugin\pc_client_server\eNSP_PCServer.exe',
                 44: r'C:\Huawei\plugin\pc_client_server\eNSP_PCClient.exe',
                 45: r'C:\Other\eNSP_PCServer.exe'}
        with patch.object(b, 'enum_windows', return_value=rows), \
             patch.object(b, 'process_executable', side_effect=paths.get):
            found = b.device_windows()
            self.assertEqual([w['hwnd'] for w in found], [2, 3])
            self.assertEqual([w['ensp_pid'] for w in found], [42, 42])

    def test_process_query_uses_limited_access_and_always_closes_handle(self):
        def query(handle, flags, buffer, size):
            buffer.value = r'C:\Huawei\eNSP_Client.exe'
            return 1
        with patch.multiple(b, _open_process=Mock(return_value=0x100000001),
                            _query_process_image=Mock(side_effect=query), _close_handle=Mock()):
            self.assertEqual(b.process_executable(42), r'C:\Huawei\eNSP_Client.exe')
            b._open_process.assert_called_once_with(0x1000, False, 42)
            b._close_handle.assert_called_once_with(0x100000001)
            b._query_process_image.side_effect = OSError('process exited')
            with self.assertRaises(OSError):
                b.process_executable(42)
            self.assertEqual(b._close_handle.call_count, 2)
            b._open_process.return_value = 0
            self.assertIsNone(b.process_executable(42))
            self.assertEqual(b._close_handle.call_count, 2)

    def test_relative_click_scales_offsets_once_and_absolute_click_stays_physical(self):
        main = {'hwnd': 11, 'rect': list(self.physical), 'dpi_scale': 1.5}
        with patch.object(b, 'ensp_main', return_value=main), patch.object(b, 'click_guarded') as click:
            b.dispatch('click', {'ensp_rel': [400, 470], 'restore': True})
            self.assertEqual(click.call_args.args[:3], (920, 905, 11))
            b.dispatch('click', {'x': 1309, 'y': 284, 'expect': 11})
            self.assertEqual(click.call_args.args[:3], (1309, 284, 11))

    def test_dpi_diagnostics_are_read_only(self):
        def bounds(hwnd, attribute, pointer, size):
            r = ctypes.cast(pointer, ctypes.POINTER(b.wt.RECT)).contents
            r.left, r.top, r.right, r.bottom = (328, 200, 2232, 1392)
            return 0
        dwm = types.SimpleNamespace(DwmGetWindowAttribute=Mock(side_effect=bounds))
        with patch.object(b, 'resolve_target', return_value=11), \
             patch.object(ctypes.windll, 'dwmapi', dwm, create=True):
            info = b.dispatch('dpi', {'hwnd': 11})
        self.assertEqual(info['dwm_frame_rect'], [328, 200, 2232, 1392])
        self.assertEqual(info['screen_size'], [2560, 1600])
        self.gui.RedrawWindow.assert_not_called()
        self.gui.ShowWindow.assert_not_called()
        self.gui.GetWindowDC.assert_not_called()
        self.assertEqual(self.context, -4)


class FakeImage:
    def __init__(self, case, size):
        self.case, self.size = case, size
    def __enter__(self):
        return self
    def __exit__(self, *_):
        pass
    def convert(self, _):
        return self
    def resize(self, size, _):
        self.case.events.append(('resize', size))
        return FakeImage(self.case, size)
    def crop(self, box):
        self.case.events.append(('crop', box))
        return FakeImage(self.case, (box[2] - box[0], box[3] - box[1]))
    def save(self, _):
        self.case.events.append(('image-saved', self.size))


unittest.main(argv=['bridge-mocks'], verbosity=2)
`)
})
