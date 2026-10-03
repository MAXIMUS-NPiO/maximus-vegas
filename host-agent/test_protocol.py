import tempfile
import unittest
from protocol import input_command, validate_config

class ProtocolTest(unittest.TestCase):
    def test_rejects_shell_meta_and_invalid_coordinates(self):
        for code in ["MetaLeft", "AltLeft", "$(id)", "a; rm -rf /", "F12"]:
            self.assertIsNone(input_command({"type": "key", "code": code, "down": True}, 1280, 720))
        for x in [-1, 2, float("nan"), True, "1"]:
            self.assertIsNone(input_command({"type": "pointer", "x": x, "y": .5}, 1280, 720))
        self.assertEqual(input_command({"type": "key", "code": "KeyA", "down": True}, 1280, 720), ["keydown", "a"])
        self.assertEqual(input_command({"type": "pointer", "x": 1, "y": 1}, 1280, 720), ["mousemove", "1279", "719"])

    def test_only_explicit_game_directory_can_launch(self):
        with tempfile.TemporaryDirectory() as directory:
            config = {"portal": "https://www.maximus.vegas", "width": 1280, "height": 720, "games": {"cs2": {"directory": directory, "command": ["/game/game"]}}}
            self.assertIs(validate_config(config), config)
            config["games"]["cs2"]["command"] = ["/bin/sh"]
            with self.assertRaises(ValueError): validate_config(config)
            config["games"]["cs2"]["command"] = ["/game/../bin/sh"]
            with self.assertRaises(ValueError): validate_config(config)

if __name__ == "__main__": unittest.main()
