"""Small, bounded input protocol. Peer messages never become shell commands."""
import math
import re

KEYS = {
    **{f"Key{x}": x.lower() for x in "ABCDEFGHIJKLMNOPQRSTUVWXYZ"},
    **{f"Digit{x}": x for x in "0123456789"},
    "ArrowLeft": "Left", "ArrowRight": "Right", "ArrowUp": "Up", "ArrowDown": "Down",
    "Space": "space", "Enter": "Return", "Escape": "Escape", "Tab": "Tab",
    "ShiftLeft": "Shift_L", "ShiftRight": "Shift_R", "ControlLeft": "Control_L", "ControlRight": "Control_R",
}

def input_command(data, width, height):
    if not isinstance(data, dict):
        return None
    if data.get("type") == "key" and data.get("code") in KEYS and isinstance(data.get("down"), bool):
        return ["keydown" if data["down"] else "keyup", KEYS[data["code"]]]
    if data.get("type") == "pointer":
        x, y = data.get("x"), data.get("y")
        if any(not isinstance(n, (int, float)) or isinstance(n, bool) or not math.isfinite(n) or n < 0 or n > 1 for n in (x, y)):
            return None
        return ["mousemove", str(min(width - 1, int(x * width))), str(min(height - 1, int(y * height)))]
    return None

def validate_config(config):
    from urllib.parse import urlparse
    from pathlib import Path
    portal = urlparse(config.get("portal", ""))
    if portal.scheme != "https" or not portal.hostname or portal.username or portal.password or portal.path not in ("", "/") or portal.query or portal.fragment:
        raise ValueError("portal must be an HTTPS origin without credentials")
    for axis, low, high in (("width", 640, 1920), ("height", 360, 1080)):
        value = config.get(axis)
        if not isinstance(value, int) or value < low or value > high or value % 16:
            raise ValueError(f"{axis} must be a multiple of 16 in {low}..{high}")
    if not isinstance(config.get("games"), dict) or not config["games"]:
        raise ValueError("configure at least one licensed game")
    for game, entry in config["games"].items():
        if not re.fullmatch(r"[a-z0-9-]{2,40}", game) or not isinstance(entry, dict):
            raise ValueError("invalid game configuration")
        directory = Path(entry.get("directory", ""))
        command = entry.get("command")
        if not directory.is_absolute() or not directory.is_dir() or directory.resolve() in (Path("/"), Path.home(), Path("/home"), Path("/etc")):
            raise ValueError("use a dedicated game directory, not a home or system directory")
        if not isinstance(command, list) or not command or any(not isinstance(s, str) or len(s) > 1000 or "\x00" in s for s in command):
            raise ValueError("command must be a bounded argument array")
        if not command[0].startswith("/game/") or ".." in Path(command[0]).parts:
            raise ValueError("game executable must be inside /game")
        if not isinstance(entry.get("network", False), bool):
            raise ValueError("network must be an explicit boolean")
    return config
