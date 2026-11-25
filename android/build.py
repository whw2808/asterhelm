#!/usr/bin/env python3
"""Compile, align and debug-sign the Asterhelm Android client with the stock SDK."""

import argparse
import fcntl
import hashlib
import ipaddress
import os
from pathlib import Path
import re
import secrets
import shutil
import subprocess
import sys
import tempfile
import unittest
import zipfile

ROOT = Path(__file__).resolve().parent
PACKAGE_PATH = Path("dev/asterhelm/android")
SRC = ROOT / "src" / PACKAGE_PATH
SERVER = ROOT.parent / "server"
ASSETS = {
    "mobile.html": "index.html",
    "mobile.css": "app.css",
    "mobile.js": "app.js",
    "mobile-work.mjs": "mobile-work.mjs",
    "mobile-marked.mjs": "mobile-marked.mjs",
    "agent-codex.png": "agent-codex.png",
    "agent-deepseek.png": "agent-deepseek.png",
    "assistant-mark.webp": "assistant-mark.webp",
    "device-desktop.webp": "device-desktop.webp",
    "device-laptop.webp": "device-laptop.webp",
}


def normalize_origin(value):
    match = re.fullmatch(r"https://(\[[0-9a-f:.]+\]|[\w.-]+)(?::([0-9]{1,5}))?/?",
                         value, re.ASCII | re.IGNORECASE)
    if not match:
        raise ValueError("Set ASTERHELM_PUBLIC_ORIGIN to the public HTTPS origin of your server.")
    host, port = match.groups()
    host = host.lower()
    if host.startswith("["):
        host = "[" + str(ipaddress.IPv6Address(host[1:-1])) + "]"
    else:
        labels = host.split(".")
        if len(host) > 253 or any(not re.fullmatch(r"[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?", s)
                                  for s in labels):
            raise ValueError("Invalid hostname in ASTERHELM_PUBLIC_ORIGIN.")
        if len(labels) > 1 and not labels[-1][0].isalpha():
            ipaddress.IPv4Address(host)
    number = int(port) if port else 443
    if not 1 <= number <= 65535:
        raise ValueError("Invalid HTTPS port in ASTERHELM_PUBLIC_ORIGIN.")
    return "https://" + host + (f":{number}" if number != 443 else "")


def run(*args):
    subprocess.run([os.fspath(arg) for arg in args], check=True)


def jdk(tool):
    return Path(os.environ["JAVA_HOME"]) / "bin" / tool if os.environ.get("JAVA_HOME") else tool


def test(stage):
    sys.dont_write_bytecode = True
    suite = unittest.defaultTestLoader.discover(str(ROOT / "tests"), pattern="test_*.py")
    if not unittest.TextTestRunner().run(suite).wasSuccessful():
        raise ValueError("Android build configuration tests failed.")
    run(jdk("javac"), "--release", "8", "-encoding", "UTF-8", "-d", stage,
        SRC / "PairCode.java", ROOT / "tests/PairCodeTest.java")
    run(jdk("java"), "-cp", stage, "dev.asterhelm.android.PairCodeTest")


def debug_identity():
    user_dir = Path(os.environ.get("ANDROID_USER_HOME") or Path.home() / ".android")
    identity = user_dir / "asterhelm-debug"
    identity.mkdir(mode=0o700, parents=True, exist_ok=True)
    store, password = identity / "debug.p12", identity / "store-pass"
    with (identity / ".lock").open("a") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        if not store.exists():
            with tempfile.TemporaryDirectory(dir=identity) as scratch:
                directory = Path(scratch)
                secret = directory / "store-pass"
                secret.write_text(secrets.token_urlsafe(32), encoding="ascii")
                run(jdk("keytool"), "-genkeypair", "-noprompt", "-storetype", "PKCS12",
                    "-keystore", directory / "debug.p12", "-storepass:file", secret,
                    "-alias", "asterhelm-debug", "-keyalg", "RSA", "-keysize", "2048",
                    "-validity", "10000", "-dname", "CN=Asterhelm Local Debug")
                os.replace(secret, password)
                os.replace(directory / "debug.p12", store)
        if not password.is_file():
            raise ValueError("The local Asterhelm debug identity is missing its store-pass file.")
    return store, password


def build(stage, output, origin):
    sdk = Path(os.environ["ANDROID_HOME"])
    bt = sdk / "build-tools/35.0.0"
    framework = sdk / "platforms/android-35/android.jar"
    if not framework.is_file() or not (bt / "aapt2").is_file():
        raise ValueError("Install platforms;android-35 and build-tools;35.0.0 under ANDROID_HOME.")
    gen = stage / "gen" / PACKAGE_PATH
    classes, dex, assets = stage / "classes", stage / "dex", stage / "assets/site"
    for directory in (gen, classes, dex, assets):
        directory.mkdir(parents=True)
    for source, target in ASSETS.items():
        shutil.copyfile(SERVER / source, assets / target)
    shutil.copyfile(ROOT / "assets/android-host.js", assets / "android-host.js")

    licenses = stage / "assets/licenses"
    licenses.mkdir()
    shutil.copyfile(ROOT.parent / "LICENSE", licenses / "asterhelm.txt")
    shutil.copyfile(SERVER / "MARKED-LICENSE.md", licenses / "marked.txt")

    # The Android preference namespace follows the server origin across app updates.
    prefs = "state-" + hashlib.sha256(origin.encode("ascii")).hexdigest()
    (gen / "BuildConfig.java").write_text(
        f'package dev.asterhelm.android;\nfinal class BuildConfig {{\n'
        f'    static final String PUBLIC_ORIGIN = "{origin}";\n'
        f'    static final String PREFERENCES = "{prefs}";\n}}\n', encoding="ascii")

    resources = stage / "res"
    shutil.copytree(ROOT / "res", resources)
    (resources / "drawable-nodpi").mkdir()
    shutil.copyfile(SERVER / "assistant-mark.webp", resources / "drawable-nodpi/launcher_mark.webp")
    run(bt / "aapt2", "compile", "--dir", resources, "-o", stage / "res.zip")
    base = stage / "resources.apk"
    run(bt / "aapt2", "link", "--debug-mode", "-o", base, "--manifest", ROOT / "AndroidManifest.xml",
        "-I", framework, "-A", stage / "assets", "--java", stage / "gen", stage / "res.zip")

    java_sources = sorted(SRC.glob("*.java")) + sorted(gen.glob("*.java"))
    run(jdk("javac"), "--release", "8", "-encoding", "UTF-8", "-classpath", framework,
        "-d", classes, *java_sources)
    run(jdk("jar"), "cf", stage / "classes.jar", "-C", classes, ".")
    run(jdk("java"), "-cp", bt / "lib/d8.jar", "com.android.tools.r8.D8", "--min-api", "26",
        "--lib", framework, "--output", dex, stage / "classes.jar")
    with zipfile.ZipFile(base, "a") as archive:
        archive.writestr(zipfile.ZipInfo("classes.dex"), (dex / "classes.dex").read_bytes())

    aligned = stage / "aligned.apk"
    run(bt / "zipalign", "-P", "16", "-f", "4", base, aligned)
    store, password = debug_identity()
    signer = [jdk("java"), "-jar", bt / "lib/apksigner.jar"]
    # Build the final file on the destination filesystem so replacement is atomic.
    output.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(dir=output.parent) as staging:
        signed = Path(staging) / "asterhelm-debug.apk"
        run(*signer, "sign", "--ks", store, "--ks-pass", "file:" + str(password),
            "--ks-key-alias", "asterhelm-debug", "--v4-signing-enabled", "false",
            "--out", signed, aligned)
        run(*signer, "verify", "--verbose", signed)
        run(bt / "zipalign", "-c", "-P", "16", "4", signed)
        os.replace(signed, output)
    print(f"Built {output}")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--test", action="store_true", help="run host checks without the Android SDK")
    parser.add_argument("--output", type=Path, default=ROOT / "build/asterhelm-debug.apk")
    args = parser.parse_args()
    if not args.test and not os.environ.get("ANDROID_HOME"):
        parser.error("Set ANDROID_HOME to your Android SDK directory.")
    os.umask(0o077)
    with tempfile.TemporaryDirectory(prefix="asterhelm-build-") as temp:
        stage = Path(temp)
        test(stage)
        if not args.test:
            origin = normalize_origin(os.environ.get("ASTERHELM_PUBLIC_ORIGIN", ""))
            build(stage, args.output.resolve(), origin)


if __name__ == "__main__":
    try:
        main()
    except (OSError, ValueError, subprocess.CalledProcessError) as error:
        sys.exit(str(error))
