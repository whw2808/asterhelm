import unittest

from build import normalize_origin


class OriginTests(unittest.TestCase):
    def test_normalizes_origin(self):
        for supplied, expected in [
            ("https://ASSISTANT.example.test:443/", "https://assistant.example.test"),
            ("https://assistant.example.test:8443", "https://assistant.example.test:8443"),
            ("https://127.0.0.1:9443", "https://127.0.0.1:9443"),
            ("https://[::1]:9443/", "https://[::1]:9443"),
        ]:
            with self.subTest(supplied=supplied):
                self.assertEqual(expected, normalize_origin(supplied))

    def test_requires_bare_https_origin(self):
        for value in ("", "http://example.test", "https://user@example.test",
                      "https://example.test:0", "https://example.test:65536", "https://example.test:",
                      "https://example.test/api", "https://example.test/?", "https://example.test/#",
                      "https://example.test\n", "https://x_y.test", "https://[::1]x"):
            with self.subTest(value=value), self.assertRaises(ValueError):
                normalize_origin(value)
