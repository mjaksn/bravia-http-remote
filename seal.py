#!/usr/bin/env python3
"""Write a password-protected deploy-config.js, without a browser.

pack.html does this in a page, which is the right tool when somebody is
sitting at a keyboard. This is the same thing for a shell: an installer, a
build step, a machine with no display. Both produce a file the console
opens with the same password, because both implement the one format that
lockbox.js reads.

Usage:
    python seal.py --host 192.168.1.50 --psk-file ./psk --out ~/deploy-config.js
    python seal.py --host 192.168.1.50 --psk 0000 --out ~/deploy-config.js
    python seal.py --host 192.168.1.50 --psk-file ./psk --hide apps,keys

The second form is fine at a keyboard and wrong in a script: an argument is
visible in `ps` to every user on the machine, and --psk-file exists for that.
--out belongs outside any checkout holding a Dockerfile; see --force.

--hide names cards the deployed console never draws. It is a property of the
deployment and of nothing else: nobody at the browser can put one back, and
resealing is the only way to change the list. See CARDS below for the names.

The password is asked for, twice, with the typing hidden. It is never taken
as an argument, because an argument is visible in `ps` to every user on the
machine, and this one unlocks the display.

Format, matching lockbox.js exactly:

    dk           = PBKDF2-HMAC-SHA256(utf8(password), salt, iterations, 64)
    encKey       = dk[0:32]
    macKey       = dk[32:64]
    keystream    = SHA-256(encKey || nonce || counter_be32) per 32 bytes
    ct           = keystream XOR utf8(JSON(plaintext))
    mac          = HMAC-SHA256(macKey, MAGIC || iters_be32 || salt || nonce || ct)[:16]

Everything a reader needs in order to reproduce the keys is signed, so a
tampered iteration count or salt reads as a wrong password rather than as a
hang or as a silently different key.

There are no dependencies. hashlib and hmac carry all of it.
"""

import argparse
import base64
import getpass
import hashlib
import hmac
import json
import os
import secrets
import sys
from pathlib import Path

# The format, not preferences. MAGIC and MAC_LEN are checked directly by
# lockbox.js, so a change to either produces a file it refuses outright. The
# lengths and the iteration count travel inside the blob and are read back
# from it, so those the console will open whatever they are; the ceiling is
# the exception, and it is why MAX_ITERATIONS is here. All of it is checked
# against the browser in tests/seal.test.js.
MAGIC = b"bravia-lockbox-1"
DEFAULT_ITERATIONS = 120000
# lockbox.js refuses a blob claiming more than this rather than hanging on it,
# so a file sealed above the ceiling is one the console can never open. It has
# to be mirrored here: seal.py opening its own work would not notice, which is
# precisely the silent divergence the two implementations are checked against.
MAX_ITERATIONS = 2000000
SALT_LEN = 16
NONCE_LEN = 16
MAC_LEN = 16

# The console's cards, in the order index.html lays them out, named the way
# a sealed config names them: the part of an element id after "card-". A card
# listed in --hide is one the deployed console never draws. This file and
# pack.html are the two that seal such a name into a config, and tests/lint.js
# checks that both lists still agree with index.html, because a name matching
# no card is passed over in silence by the browser rather than refused.
# scripts/install.sh asks the same question and reads the cards out of
# index.html rather than keeping a third copy.
CARDS = (
    ("power", "Power"),
    ("playing", "On (what is playing)"),
    ("volume", "Audio"),
    ("inputs", "Inputs"),
    ("apps", "Apps"),
    ("keys", "Remote Keys"),
    ("text", "Text Entry"),
    ("picture", "Picture"),
    ("sound", "Sound Modes"),
    ("system", "System"),
    ("speaker", "Speaker Setup"),
)
CARD_NAMES = tuple(name for name, _ in CARDS)


def parse_hidden(values) -> list:
    """Turn every --hide into a list of card names, in the order CARDS has.

    Repeated options and comma-separated lists both work, and both end up
    the same. A name that is not a card is refused here rather than sealed:
    the console passes an unknown name over in silence, so a typo would
    otherwise seal as a deployment that quietly shows a card it was told to
    leave out.
    """
    asked = []
    for value in values or []:
        asked.extend(part.strip() for part in value.split(","))
    asked = [name for name in asked if name]
    unknown = [name for name in asked if name not in CARD_NAMES]
    if unknown:
        raise SystemExit(
            "seal.py: not a card: %s\n"
            "Cards are: %s"
            % (", ".join(unknown), ", ".join(CARD_NAMES)))
    # Page order, and each card once, however the options were written.
    return [name for name in CARD_NAMES if name in asked]

HEADER = (
    "/* Bravia Console deployment config, written by seal.py.\n"
    "   The address, the pre-shared key and the choice of cards inside are\n"
    "   encrypted with a password; the console asks for it at launch, unless\n"
    "   that browser has been told to stay signed in. Reseal to change any\n"
    "   of them. */\n\n"
)


def keystream_xor(enc_key: bytes, nonce: bytes, data: bytes) -> bytes:
    """XOR data with SHA-256(encKey || nonce || counter) blocks."""
    out = bytearray(len(data))
    for counter, pos in enumerate(range(0, len(data), 32)):
        block = hashlib.sha256(enc_key + nonce + counter.to_bytes(4, "big")).digest()
        chunk = data[pos:pos + 32]
        out[pos:pos + len(chunk)] = bytes(a ^ b for a, b in zip(chunk, block))
    return bytes(out)


def mac_input(iterations: int, salt: bytes, nonce: bytes, ct: bytes) -> bytes:
    """The bytes the tag is computed over: the header as well as the payload."""
    return MAGIC + iterations.to_bytes(4, "big") + salt + nonce + ct


def seal(password: str, obj: dict, iterations: int = DEFAULT_ITERATIONS) -> dict:
    """Seal a plain object into a blob that is safe to serve to anyone."""
    salt = secrets.token_bytes(SALT_LEN)
    nonce = secrets.token_bytes(NONCE_LEN)
    dk = hashlib.pbkdf2_hmac("sha256", password.encode("utf-8"), salt, iterations, 64)
    enc_key, mac_key = dk[:32], dk[32:]

    # Separators without spaces, matching JSON.stringify. The console parses
    # this rather than comparing it, so the spacing does not have to match;
    # it is done because a keystream cipher makes the file exactly as long
    # as its plaintext, and there is no reason to pad it with spaces.
    plaintext = json.dumps(obj, separators=(",", ":")).encode("utf-8")
    ct = keystream_xor(enc_key, nonce, plaintext)
    tag = hmac.new(mac_key, mac_input(iterations, salt, nonce, ct), hashlib.sha256)

    b64 = lambda raw: base64.b64encode(raw).decode("ascii")  # noqa: E731
    return {
        "v": 1,
        "kdf": "pbkdf2-hmac-sha256",
        "iterations": iterations,
        "salt": b64(salt),
        "nonce": b64(nonce),
        "ct": b64(ct),
        "mac": b64(tag.digest()[:MAC_LEN]),
    }


def open_sealed(password: str, blob: dict) -> dict:
    """Open a sealed blob, or raise ValueError.

    Here so that this file can prove its own work: seal.py opens what it
    just wrote before offering it, the way pack.html does. That catches a
    broken write, though not a disagreement with lockbox.js, which only the
    browser round trip in the tests can catch.
    """
    if blob.get("v") != 1 or blob.get("kdf") != "pbkdf2-hmac-sha256":
        raise ValueError("unrecognised configuration format")
    # Every malformed field in here raises ValueError, which is what the
    # docstring promises and what a caller will be catching. A missing or
    # non-numeric iteration count would otherwise come out as KeyError or
    # TypeError and go straight past them.
    try:
        iterations = int(blob["iterations"])
    except (KeyError, TypeError, ValueError):
        raise ValueError("corrupt configuration") from None
    # The same ceiling lockbox.js enforces, and for the same reason: a blob
    # claiming a billion rounds should be refused rather than spun on.
    if iterations < 1 or iterations > MAX_ITERATIONS:
        raise ValueError("unusable iteration count")
    # A missing field is a KeyError and a non-string one a TypeError, and
    # neither is what this function promises. Bad base64 and bad UTF-8 already
    # arrive as ValueError, since binascii.Error and UnicodeDecodeError both
    # subclass it, but the lookups do not.
    try:
        salt = base64.b64decode(blob["salt"])
        nonce = base64.b64decode(blob["nonce"])
        ct = base64.b64decode(blob["ct"])
        mac = base64.b64decode(blob["mac"])
    except (KeyError, TypeError, ValueError):
        raise ValueError("corrupt configuration") from None
    if len(mac) != MAC_LEN:
        raise ValueError("corrupt configuration")

    dk = hashlib.pbkdf2_hmac("sha256", password.encode("utf-8"), salt, iterations, 64)
    enc_key, mac_key = dk[:32], dk[32:]
    want = hmac.new(mac_key, mac_input(iterations, salt, nonce, ct), hashlib.sha256)
    if not hmac.compare_digest(mac, want.digest()[:MAC_LEN]):
        raise ValueError("access denied")
    return json.loads(keystream_xor(enc_key, nonce, ct).decode("utf-8"))


def render(blob: dict) -> str:
    """The whole deploy-config.js, ready to write."""
    return HEADER + "window.BRAVIA_DEPLOY_CONFIG = " + json.dumps(blob, indent=2) + ";\n"


def ask_password(confirm: bool = True) -> str:
    """Read a password twice without echoing it."""
    if not sys.stdin.isatty():
        raise SystemExit(
            "seal.py: no terminal to ask for a password on. Use --password-file, "
            "and delete the file afterwards."
        )
    while True:
        first = getpass.getpass("  Deployment password: ")
        if not first:
            print("  A password is required.")
            continue
        if not confirm:
            return first
        again = getpass.getpass("  Again, to be sure: ")
        if first == again:
            return first
        print("  Those do not match. Try again.")


def main() -> int:
    """Seal the connection details and write deploy-config.js."""
    parser = argparse.ArgumentParser(
        prog="seal.py",
        description=(
            "Write a password-protected deploy-config.js for Bravia Console, "
            "the same file pack.html produces, without needing a browser."
        ),
        epilog=(
            "A forgotten password cannot be recovered: reseal instead. "
            "Anyone who can load the page can take a copy of the file and attack "
            "it offline, so pick a password worth guessing at."
        ),
    )
    parser.add_argument("--host", required=True,
                        help="the display's address, host or host:port")
    parser.add_argument("--psk",
                        help=(
                            "the pre-shared key set on the display. Visible in ps "
                            "while this runs; prefer --psk-file when a script is "
                            "supplying it"
                        ))
    parser.add_argument("--psk-file",
                        help="read the pre-shared key from this file instead")
    parser.add_argument("--interval", type=int, default=5,
                        help="starting refresh interval in seconds (default 5)")
    parser.add_argument("--hide", action="append", metavar="CARDS",
                        help=(
                            "a card the deployed console should never draw. "
                            "Repeatable, and takes a comma-separated list. "
                            "One of: " + ", ".join(CARD_NAMES)
                        ))
    parser.add_argument("--out", default="deploy-config.js",
                        help="where to write it (default deploy-config.js)")
    parser.add_argument("--iterations", type=int, default=DEFAULT_ITERATIONS,
                        help="PBKDF2 rounds (default %d)" % DEFAULT_ITERATIONS)
    parser.add_argument("--password-file",
                        help=(
                            "read the password from this file instead of asking. "
                            "For unattended use; delete the file afterwards"
                        ))
    parser.add_argument("--force", action="store_true",
                        help=(
                            "overwrite the output file if it exists, AND write it even "
                            "inside a Docker build context. The second is the one to "
                            "think about: it removes a guard that keeps the sealed "
                            "config out of published images"
                        ))
    args = parser.parse_args()

    if args.iterations < 1:
        raise SystemExit("seal.py: --iterations must be at least 1")
    if args.iterations > MAX_ITERATIONS:
        raise SystemExit(
            "seal.py: --iterations above %d produces a file the console refuses to "
            "open, so it is rejected here rather than after it is deployed."
            % MAX_ITERATIONS)
    # Checked here, with the other arguments, rather than beside the payload
    # it goes into: a mistyped card name should be refused before somebody is
    # asked to type a password twice.
    hidden = parse_hidden(args.hide)

    if args.iterations < DEFAULT_ITERATIONS:
        print("  warning: %d rounds is weaker than the %d this format expects"
              % (args.iterations, DEFAULT_ITERATIONS), file=sys.stderr)

    out = Path(args.out).resolve()
    # A build context is the one place this file must never be written. An
    # image built with it inside publishes the sealed blob to whoever can
    # pull the image, which turns "somebody on my LAN" into "anybody, for
    # as long as the registry keeps the layer".
    #
    # Every ancestor is checked, not just the immediate parent. A context is
    # rooted at the Dockerfile and reaches down through every subdirectory
    # under it, so `--out content/deploy-config.js` from a checkout is inside
    # one just as surely as `--out deploy-config.js` is, and `COPY content
    # ./content` would carry it in.
    context = next((d for d in out.parents if (d / "Dockerfile").exists()), None)
    if context is not None and not args.force:
        raise SystemExit(
            "seal.py: %s is inside a Docker build context, rooted at %s.\n"
            "Writing the sealed config there bakes it into any image built from that\n"
            "context, and a published image hands it to anyone who can pull it. Mount\n"
            "it at run time instead, or pass --force if you are certain."
            % (out, context)
        )
    if out.exists() and not args.force:
        raise SystemExit("seal.py: %s already exists. Pass --force to replace it." % out)

    # Only a trailing newline comes off, not surrounding whitespace. A
    # password or key with a deliberate leading or trailing space has to seal
    # as the same thing however it was supplied, or an operator who recorded
    # exactly what they wrote cannot sign in with it. Every editor adds the
    # newline; nothing adds the spaces.
    if args.psk_file:
        psk = Path(args.psk_file).read_text(encoding="utf-8").rstrip("\r\n")
        if not psk:
            raise SystemExit("seal.py: %s is empty" % args.psk_file)
    elif args.psk:
        psk = args.psk
    else:
        raise SystemExit("seal.py: one of --psk or --psk-file is required")

    if args.password_file:
        password = Path(args.password_file).read_text(encoding="utf-8").rstrip("\r\n")
        if not password:
            raise SystemExit("seal.py: %s is empty" % args.password_file)
    else:
        password = ask_password()

    secret = {"host": args.host, "psk": psk, "interval": args.interval}
    # Left out of the payload when nothing was asked for, so a deployment
    # that hides nothing seals exactly what this file always sealed.
    if hidden:
        secret["hiddenCards"] = hidden
    blob = seal(password, secret, args.iterations)

    # Opened again before it is offered, the way pack.html does, so that a
    # file which cannot be opened is never handed over as though it could.
    if open_sealed(password, blob) != secret:
        raise SystemExit("seal.py: the sealed file did not open again. Nothing written.")

    out.write_text(render(blob), encoding="utf-8")
    # 0644: it is meant to be served. The secrecy is in the password, not in
    # the permissions, and a web server that cannot read it serves nothing.
    os.chmod(out, 0o644)

    print()
    print("  Wrote %s" % out)
    print("  Sealed %s with %d PBKDF2 rounds, and opened it again to check."
          % (args.host, args.iterations))
    if hidden:
        print("  The console will not draw: %s." % ", ".join(hidden))
    print()
    print("  Put it next to index.html. The console will start at a password prompt.")
    print("  There is no recovery for the password: reseal to change anything.")
    print()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
