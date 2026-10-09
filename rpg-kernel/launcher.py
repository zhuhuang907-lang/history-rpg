#!/usr/bin/env python3
# Launcher source for PyInstaller. Produces a standalone 启动游戏.exe that:
#  - locates a Node runtime (bundled node.exe next to the exe, then the
#    WorkBuddy managed node, then PATH)
#  - starts server.js in this folder
#  - opens the browser to the local game URL
import os
import sys
import time
import subprocess
import webbrowser

PORT = "8787"
URL = "http://127.0.0.1:%s" % PORT

APP_DIR = os.path.dirname(os.path.abspath(sys.executable)) if getattr(
    sys, "frozen", False) else os.path.dirname(os.path.abspath(__file__))


def find_node():
    candidates = [
        os.path.join(APP_DIR, "node.exe"),
        r"C:\Users\DELL\.workbuddy\binaries\node\versions\22.22.2-3\node.exe",
    ]
    for c in candidates:
        if os.path.exists(c):
            return c
    return "node"


def main():
    node = find_node()
    server = os.path.join(APP_DIR, "server.js")
    if not os.path.exists(server):
        print("[ERROR] server.js not found next to this program.")
        input("Press Enter to exit...")
        return
    try:
        proc = subprocess.Popen([node, "server.js"], cwd=APP_DIR)
    except Exception as e:  # noqa
        print("[ERROR] Failed to start server:", e)
        input("Press Enter to exit...")
        return
    time.sleep(2.5)
    try:
        webbrowser.open(URL)
    except Exception:  # noqa
        pass
    print("Pivot Engine running at", URL)
    print("Close this window to stop the game.")
    try:
        proc.wait()
    except KeyboardInterrupt:
        proc.terminate()


if __name__ == "__main__":
    main()
