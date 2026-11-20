"""Portable task cancellation. The control channel never takes the GUI lock."""
import threading
import time


class TaskCancelled(Exception):
    pass


class Task:
    def __init__(self, task_id, timeout_ms=180000, cancelled=None):
        if not isinstance(task_id, str) or not 16 <= len(task_id) <= 128:
            raise ValueError("invalid task identity")
        if not isinstance(timeout_ms, (int, float)) or not 0 < timeout_ms <= 3600000:
            raise ValueError("invalid task timeout")
        self.id = task_id
        self.deadline = time.monotonic() + timeout_ms / 1000
        self.cancelled = cancelled
        self.event = threading.Event()
        self.state = "queued"
        self.dispatched = False
        self.finished_at = None

    def check(self):
        if self.event.is_set() or time.monotonic() >= self.deadline or (self.cancelled and self.cancelled()):
            self.event.set()
            raise TaskCancelled("task cancelled or deadline exceeded")

    def result(self):
        return {"task_id": self.id, "state": self.state,
                "stop_confirmed": self.state in ("finished", "cancelled"),
                "may_have_applied": self.dispatched,
                "remaining_ms": max(0, int((self.deadline - time.monotonic()) * 1000))}


class TaskRegistry:
    def __init__(self):
        self.lock = threading.Lock()
        self.tasks = {}

    def _prune(self):
        now = time.monotonic()
        self.tasks = {k: v for k, v in self.tasks.items()
                      if v.finished_at is None or now - v.finished_at < 600}
        if len(self.tasks) >= 4096:
            raise RuntimeError("task registry capacity reached")

    def begin(self, task_id, timeout_ms):
        with self.lock:
            self._prune()
            if task_id in self.tasks:
                raise TaskCancelled("task identity already used; no replay")
            task = Task(task_id, timeout_ms)
            self.tasks[task_id] = task
            return task

    def control(self, task_id, cancel=False):
        with self.lock:
            task = self.tasks.get(task_id)
            if task is None:
                if not cancel:
                    return {"task_id": task_id, "state": "unknown", "stop_confirmed": False}
                self._prune()
                # A cancellation can overtake its queued request. Retain a
                # tombstone so that late delivery cannot start the action.
                task = Task(task_id)
                task.state, task.finished_at = "cancelled", time.monotonic()
                self.tasks[task_id] = task
            if cancel:
                task.event.set()
            return task.result()


TASKS = TaskRegistry()
LOCAL = threading.local()


def check_task():
    task = getattr(LOCAL, "task", None)
    if task:
        task.check()


def task_sleep(seconds):
    seconds = float(seconds)
    if seconds < 0:
        raise ValueError("sleep must be nonnegative")
    task = getattr(LOCAL, "task", None)
    if not task:
        return time.sleep(seconds)
    end = time.monotonic() + seconds
    while time.monotonic() < end:
        task.check()
        task.event.wait(min(0.05, end - time.monotonic()))
    task.check()
