#!/usr/bin/env bash
#
# Install Bravia Console, either as a systemd service or as a Docker container,
# and optionally seal a password-protected deployment config on the way.
#
# It asks which, then asks for the display's address, the port to serve on, and
# which of the console's cards this copy should leave out. The pre-shared key
# set on the display is asked for only when it is sealing a locked config.
# Every answer can be given as a flag instead, and --non-interactive
# refuses to guess rather than hanging on a prompt that nobody is there to
# answer.
#
# Safe to run more than once. An existing sealed config is left alone unless you
# ask for a new one, and so is an existing list of cards to leave out: a run that
# is neither asked nor told keeps whatever the last one settled.
#
set -euo pipefail

SERVICE_USER=bravia
INSTALL_DIR=/opt/bravia-console
CONFIG_DIR=/etc/bravia-console
COMPOSE_FILE="$CONFIG_DIR/docker-compose.yml"
UNIT_NAME=bravia-console.service
UNIT_FILE="/etc/systemd/system/$UNIT_NAME"
IMAGE=ghcr.io/mjaksn/bravia-http-remote:latest

SOURCE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

# What the app is, as far as a web server is concerned. proxy.py serves files
# from its own directory, so this list is also exactly what it can serve.
APP_FILES="index.html app.js style.css lockbox.js deploy-config.js pack.html proxy.py"

usage() {
    cat <<'USAGE'
Usage: sudo scripts/install.sh [options]

Installs Bravia Console as a systemd service, or writes a Docker Compose file
and brings it up. With no options it asks which, and asks for the display.

Options:
  --systemd            install as a systemd service, do not ask
  --docker             install as a Docker container, do not ask
  --tv HOST            the display's address, host or host:port
  --port PORT          port to serve the console on (default 8585)
  --bind ADDR          address to serve on, systemd install only
                       (default 0.0.0.0, so a phone can reach it)
  --lock               seal a password-protected deployment config
  --no-lock            do not seal one; each browser is asked for the details
  --psk-file FILE      read the display's pre-shared key from this file
  --interval SECONDS   starting refresh interval when sealing (default 5)
  --hide CARDS         cards the console should never draw, comma-separated;
                       repeatable. Asked for when there is a terminal; a run
                       with neither keeps what an earlier run settled
  --password-file F    read the deployment password from this file
  --non-interactive    never prompt; fail if something needed is missing
  --no-start           install but do not start it
  --help               show this message

The cards are named after the ids in index.html, which is also where this
script reads them from: power, playing, volume, inputs, apps, keys, text,
picture, sound, system and speaker. They are a deployment's choice and not a
security measure, and nothing in the console puts one back.

This script never takes the pre-shared key or the deployment password as an
argument, and never passes one to seal.py either, because an argument is visible
in `ps` to every user on the machine. Both are asked for, or read from a file
for unattended use; delete those files afterwards. seal.py itself does accept
--psk, for a quick run at a keyboard.
USAGE
}

say() { printf '  %s\n' "$*"; }
die() { echo "install.sh: $*" >&2; exit 1; }

# A two-argument flag with nothing after it would otherwise `shift 2` off the
# end, which returns non-zero and, under `set -e`, ends the script without a
# word. Checked before shifting so the caller is told which flag it was.
need() {
    [ $# -ge 2 ] || die "$1 needs a value"
    printf '%s' "$2"
}

# --hide is repeatable and also takes a comma-separated list, so the two forms
# collapse into one comma-separated string here and are checked against the
# cards that actually exist further down, once index.html has been found.
join_hide() {
    if [ -z "$1" ]; then printf '%s' "$2"; else printf '%s,%s' "$1" "$2"; fi
}

MODE=""
TV=""
PORT=""
BIND=""
LOCK=""
PSK=""
PSK_FILE=""
INTERVAL=""
HIDE=""
PASSWORD_FILE=""
INTERACTIVE=1
START_IT=1

while [ $# -gt 0 ]; do
    case "$1" in
        --systemd) MODE=systemd; shift ;;
        --docker) MODE=docker; shift ;;
        --tv) TV="$(need "$@")"; shift 2 ;;
        --tv=*) TV="${1#*=}"; shift ;;
        --port) PORT="$(need "$@")"; shift 2 ;;
        --port=*) PORT="${1#*=}"; shift ;;
        --bind) BIND="$(need "$@")"; shift 2 ;;
        --bind=*) BIND="${1#*=}"; shift ;;
        --lock) LOCK=1; shift ;;
        --no-lock) LOCK=0; shift ;;
        --psk-file) PSK_FILE="$(need "$@")"; shift 2 ;;
        --psk-file=*) PSK_FILE="${1#*=}"; shift ;;
        --interval) INTERVAL="$(need "$@")"; shift 2 ;;
        --interval=*) INTERVAL="${1#*=}"; shift ;;
        --hide) HIDE="$(join_hide "$HIDE" "$(need "$@")")"; shift 2 ;;
        --hide=*) HIDE="$(join_hide "$HIDE" "${1#*=}")"; shift ;;
        --password-file) PASSWORD_FILE="$(need "$@")"; shift 2 ;;
        --password-file=*) PASSWORD_FILE="${1#*=}"; shift ;;
        --non-interactive) INTERACTIVE=0; shift ;;
        --no-start) START_IT=0; shift ;;
        --help|-h) usage; exit 0 ;;
        *) echo "install.sh: unrecognised option '$1'" >&2; usage >&2; exit 2 ;;
    esac
done

if [ "$(id -u)" -ne 0 ]; then
    echo "install.sh: this needs root. Try: sudo scripts/install.sh" >&2
    exit 1
fi


# A prompt that takes a default, and that refuses to block when nobody is there
# to answer. --non-interactive is the explicit form; a run from cron with no
# terminal is the accidental one, and both should take the default rather than
# wait for input that is never coming.
ask() {
    local prompt="$1" default="$2" answer=""
    if [ "$INTERACTIVE" -eq 0 ] || [ ! -t 0 ]; then
        printf '%s' "$default"
        return
    fi
    read -r -p "  $prompt [$default]: " answer </dev/tty || answer=""
    printf '%s' "${answer:-$default}"
}

ask_required() {
    local prompt="$1" answer=""
    if [ "$INTERACTIVE" -eq 0 ] || [ ! -t 0 ]; then
        printf ''
        return
    fi
    read -r -p "  $prompt: " answer </dev/tty || answer=""
    printf '%s' "$answer"
}

# Read without echoing. The pre-shared key controls the display and the
# deployment password unlocks it, so neither should be left on screen or in a
# shell history, and neither is ever passed as an argument.
ask_secret() {
    local prompt="$1" answer=""
    if [ "$INTERACTIVE" -eq 0 ] || [ ! -t 0 ]; then
        printf ''
        return
    fi
    read -r -s -p "  $prompt: " answer </dev/tty || answer=""
    printf '\n' >&2
    printf '%s' "$answer"
}

ask_yes_no() {
    local prompt="$1" default="$2" answer=""
    answer="$(ask "$prompt (y/n)" "$default")"
    case "$answer" in
        [Yy]*) printf '1' ;;
        [Nn]*) printf '0' ;;
        *) if [ "$default" = "y" ]; then printf '1'; else printf '0'; fi ;;
    esac
}

check_port() {
    local value="$1" what="$2"
    case "$value" in
        ''|*[!0-9]*) die "$what must be a number, not '$value'" ;;
    esac
    if [ "$value" -lt 1 ] || [ "$value" -gt 65535 ]; then
        die "$what must be between 1 and 65535, not $value"
    fi
    if [ "$value" -lt 1024 ]; then
        say "warning: $what $value is privileged, and this runs unprivileged"
    fi
}

# == the console's cards =====================================================

# Read out of index.html rather than kept as a list here. The names and the
# labels are both in that file, one <section> per card, and a copy in this
# script would be a fourth place for them to drift; tests/lint.js already has
# to keep three in step.
list_cards() {
    awk '
        /<section class="card" id="card-/ {
            name = $0
            sub(/.*id="card-/, "", name)
            sub(/".*/, "", name)
            want = 1
            next
        }
        want && /<h2>/ {
            label = $0
            sub(/.*<h2>/, "", label)
            sub(/<\/h2>.*/, "", label)
            print name, label
            want = 0
        }
    ' "$SOURCE_DIR/index.html"
}

card_names() { list_cards | awk '{print $1}'; }

# A name that is not a card seals, or writes, as a card that quietly stays
# put: the console passes an unknown name over rather than refusing the
# config. So it is refused here, before anything is written and before
# anybody is asked for a password.
check_hide() {
    local name="" known=""
    known="$(card_names)"
    [ -n "$known" ] || die "could not read the cards out of $SOURCE_DIR/index.html"
    local IFS=","
    for name in $1; do
        # A whole line and a fixed string, not a pattern: "app" is not the
        # card "apps", and neither is "app.", which as a pattern would match
        # it and then name nothing the console can find. -e as well, so a
        # name starting with a hyphen is a string that does not match rather
        # than an option to grep.
        if ! printf '%s\n' "$known" | grep -qxF -e "$name"; then
            die "not a card: '$name'. Cards are: $(card_names | tr '\n' ' ')"
        fi
    done
}

# The cards an earlier unsealed run left out, comma-separated, and empty
# when there is no such file. A sealed config is never read here: it is
# encrypted, and a run that finds one keeps it whole rather than reaching
# inside it.
saved_cards() {
    [ -f "$CONFIG_FILE" ] || return 0
    sed -n "s/.*BRAVIA_HIDDEN_CARDS = \[\(.*\)\];.*/\1/p" "$CONFIG_FILE" | tr -d "' "
}

# A seal writes the file the cards live in from scratch, so a run that was
# neither asked nor told has to carry the last answer into the new one by
# hand. The unsealed path keeps its own file and needs nothing. Without
# this a --non-interactive --lock re-run would put every card back
# silently, which is the one thing the header of this script promises it
# will not do.
#
# Sets HIDE rather than printing it, for the same reason choose_cards does:
# a $(...) would put a die() from check_hide in a subshell and carry on.
carry_over_cards() {
    [ "$ASKED" -eq 0 ] || return 0
    HIDE="$(saved_cards)"
    [ -n "$HIDE" ] || return 0
    check_hide "$HIDE"
    say "carrying over the cards an earlier run left out: $HIDE"
}

# Sets HIDE rather than printing it, so that a bad answer can end the script
# through die(): a $(...) here would put die in a subshell and carry on.
choose_cards() {
    local reply="" token="" name="" label="" picked="" n=0 current=""

    echo
    echo "  Which cards should this console leave out? Nothing is left out unless"
    echo "  you pick something, and the display's own capabilities still decide"
    echo "  the rest. Nobody at the browser can put one back."
    # What an earlier run settled, if anything. The answer given here replaces
    # it whole, blank included, so it has to be on screen before it is asked
    # for.
    current="$(saved_cards)"
    if [ -n "$current" ]; then
        echo
        echo "  An earlier run left out: $current. What you answer here replaces"
        echo "  that, and a blank answer puts every card back."
    fi
    echo
    while read -r name label; do
        n=$((n + 1))
        printf '    %2d) %s\n' "$n" "$label"
    done <<CARDS
$(list_cards)
CARDS
    echo

    reply="$(ask "Numbers to leave out, separated by spaces, blank for none" "")"
    for token in $(printf '%s' "$reply" | tr ',' ' '); do
        case "$token" in
            ''|*[!0-9]*) die "'$token' is not one of the numbers above" ;;
        esac
        name="$(list_cards | awk -v n="$token" 'NR == n {print $1}')"
        [ -n "$name" ] || die "there is no card $token in the list above"
        case ",$picked," in
            *",$name,"*) continue ;;
        esac
        picked="$(join_hide "$picked" "$name")"
    done
    HIDE="$picked"
}

# The unsealed half of the same choice. No address and no key go in here, so
# it is not a sealed config and is not treated as one: it is rewritten from
# this run's answers, and removed when nothing is picked.
write_card_config() {
    local target="$1" name="" json=""
    local IFS=","
    for name in $2; do
        if [ -n "$json" ]; then json="$json, "; fi
        json="$json'$name'"
    done
    cat > "$target" <<CARDCONFIG
/* Written by scripts/install.sh, and rewritten every time it runs.

   Not a sealed deployment config: there is no address and no pre-shared key
   in here, and every browser is still asked for both. All this file says is
   which cards the console leaves out. Edit the list, or delete the file to
   put every card back, and restart the service. */

window.BRAVIA_DEPLOY_CONFIG = null;
window.BRAVIA_HIDDEN_CARDS = [$json];
CARDCONFIG
    chmod 0644 "$target"
}

PYTHON=""
find_python() {
    for candidate in python3 python; do
        if command -v "$candidate" >/dev/null 2>&1; then
            # The path, not the name. ExecStart on systemd before v239 must be
            # absolute, and a unit that cannot start is a poor way to find out.
            PYTHON="$(command -v "$candidate")"
            return 0
        fi
    done
    return 1
}

# Seal to a new file beside the target and put it in place only once that
# has worked. Two things need this. seal.py refuses to overwrite, and an
# unsealed card list may be sitting at the target already; and a run can
# still fail after it starts, on a missing key file, an interval that is
# not a number, or a password typed differently twice. Writing straight to
# the target would mean a failed run had already taken away whatever was
# there, which for a wall panel is its whole card selection.
#
# The rename is within one directory, so it replaces the old file whole or
# not at all.
seal_to() {
    local target="$1"
    shift
    local tmp="$target.new"

    rm -f "$tmp"
    # In an if, so that a failure is handled here rather than ending the
    # script through set -e with the half-written file still beside it.
    if ! "$PYTHON" "$SOURCE_DIR/seal.py" --out "$tmp" "$@" >/dev/null; then
        rm -f "$tmp"
        die "sealing failed, and $target is as it was"
    fi
    mv "$tmp" "$target"
    chmod 0644 "$target"
}

echo
echo "Installing Bravia Console from $SOURCE_DIR"
echo

# == what kind of install ====================================================

if [ -z "$MODE" ]; then
    if [ "$INTERACTIVE" -eq 0 ]; then
        die "--systemd or --docker is required with --non-interactive"
    fi
    echo "  How should the console run?"
    echo
    echo "    1) systemd, serving the app from this machine"
    echo "    2) Docker, from the published image"
    echo
    case "$(ask "1 or 2" "1")" in
        2) MODE=docker ;;
        *) MODE=systemd ;;
    esac
    echo
fi

# == the answers =============================================================

if [ -z "$TV" ]; then
    TV="$(ask_required "The display's address, for example 192.168.1.50")"
fi
[ -n "$TV" ] || die "the display's address is required (--tv)"

# The address is interpolated into a YAML scalar and into an ExecStart line,
# and each has characters that mean something there: # opens a comment, [
# opens a flow sequence, and % is a systemd specifier. Rather than quote for
# three grammars, refuse anything that is not a host, an address and an
# optional port. The result is a message pointing at the input, instead of a
# unit that will not start or a compose file that is quietly wrong.
case "$TV" in
    *[!A-Za-z0-9.:_-]*) die "the display's address may only contain letters, digits, dot, colon, underscore and hyphen: '$TV'" ;;
esac

if [ -z "$PORT" ]; then
    PORT="$(ask "Port to serve the console on" "8585")"
fi
check_port "$PORT" "the console port"

# 0.0.0.0 rather than proxy.py's own 127.0.0.1 default, because a remote
# control that only answers on the machine running it is not much of a remote
# control. The Docker install always binds every interface inside the
# container and lets the publish decide, which is why this is asked for only
# on the systemd path.
if [ "$MODE" = "docker" ] && [ -n "$BIND" ]; then
    # Silently dropping a flag is bad enough; silently dropping one whose whole
    # purpose is to narrow what can reach the console is worse. The container
    # always binds every interface inside its own namespace, and what is
    # actually exposed is decided by the published port.
    die "--bind is for the systemd install. Under Docker the exposure is set by the
       published port instead: edit ports: in $COMPOSE_FILE to publish on the
       address you want, for example 127.0.0.1:$PORT:8585"
fi

if [ "$MODE" = "systemd" ] && [ -z "$BIND" ]; then
    BIND="$(ask "Address to serve on, 0.0.0.0 for the whole network" "0.0.0.0")"
fi
BIND="${BIND:-0.0.0.0}"

# == which cards ==============================================================

CONFIG_FILE="$CONFIG_DIR/deploy-config.js"
mkdir -p "$CONFIG_DIR"
chmod 0755 "$CONFIG_DIR"

# A config sealed by an earlier run decides its own cards, and they are inside
# it where this script cannot reach them. Asking would collect an answer with
# nowhere to go, so it does not ask, and says so if it was told.
KEEPING=0
if [ -f "$CONFIG_FILE" ] && grep -q 'BRAVIA_DEPLOY_CONFIG = {' "$CONFIG_FILE"; then
    KEEPING=1
fi

# Whether this run settled the question at all. A re-run that was never
# asked and never told leaves an earlier answer alone: picking up a new
# version is the most ordinary reason to run this script again, and an
# upgrade that quietly put a kiosk's cards back would be a poor way to
# find out that the answer was not carried over.
ASKED=0

if [ "$KEEPING" -eq 1 ]; then
    if [ -n "$HIDE" ]; then
        say "ignoring --hide: the sealed config already at $CONFIG_FILE decides that"
        HIDE=""
    fi
elif [ -n "$HIDE" ]; then
    check_hide "$HIDE"
    ASKED=1
elif [ "$INTERACTIVE" -eq 1 ] && [ -t 0 ]; then
    choose_cards
    ASKED=1
fi

# == the sealed config =======================================================

if [ -z "$LOCK" ] && [ "$INTERACTIVE" -eq 0 ]; then
    die "--lock or --no-lock is required with --non-interactive"
fi

if [ -z "$LOCK" ]; then
    echo
    echo "  Without a locked config, every browser that loads the page is asked for"
    echo "  the display's address and key, and anyone who can reach the page can"
    echo "  drive the display. A locked config ships them encrypted, behind a"
    echo "  password you choose."
    echo
    LOCK="$(ask_yes_no "Seal a password-protected config" "$([ "$BIND" = "127.0.0.1" ] && echo n || echo y)")"
fi

SEALED=0

# A config sealed by an earlier run keeps being used, whatever was asked for
# this time.
#
# --no-lock means "do not seal a new one", never "unlock the deployment". An
# upgrade that quietly reopened a locked console to everyone on the network
# would be the worst thing this script could do, and running it again to pick
# up a new version is the most ordinary reason to run it at all. Deleting the
# file is how you unlock, and the closing banner says so.
if [ "$KEEPING" -eq 1 ]; then
    SEALED=1
    say "keeping the sealed config already at $CONFIG_FILE"
    say "delete that file and run this again to change it, or to unlock"

elif [ "$LOCK" -eq 1 ]; then
    find_python || die "python3 is needed to seal a config, and was not found"

    # An unsealed run leaves a plain card list at this path, and the sealed
    # file carries the same choice inside it, so that one is replaced. The
    # choice itself is carried over first: this run may never have been
    # asked, and putting every card back unasked is the one thing the header
    # of this script promises will not happen.
    #
    # Nothing is taken away here. seal_to() replaces the file only once the
    # seal has worked, so a run that fails leaves the old one where it was.
    carry_over_cards
    if [ -f "$CONFIG_FILE" ]; then
        say "replacing the card list an earlier run left at $CONFIG_FILE"
    fi

    if [ -n "$PSK_FILE" ]; then
        [ -f "$PSK_FILE" ] || die "$PSK_FILE does not exist"
    else
        PSK="$(ask_secret "The pre-shared key set on the display")"
        [ -n "$PSK" ] || die "the pre-shared key is required in order to seal a config"
    fi

    if [ -z "$INTERVAL" ]; then
        INTERVAL="$(ask "Starting refresh interval in seconds" "5")"
    fi
    case "$INTERVAL" in
        ''|*[!0-9]*) die "the refresh interval must be a number, not '$INTERVAL'" ;;
    esac

    # The key reaches seal.py in a file, never as an argument. An argument is
    # visible in `ps` to every user on this machine for as long as the seal
    # takes, which is 120,000 rounds of PBKDF2 with the key sitting there.
    #
    # A file the caller supplied is handed straight over. Reading it into a
    # variable first would strip the trailing whitespace that `$(cat)` always
    # eats, and the key would seal as something they did not write.
    psk_tmp_ours=0
    if [ -n "$PSK_FILE" ]; then
        psk_tmp="$PSK_FILE"
    else
        psk_tmp="$(mktemp)"
        psk_tmp_ours=1
        chmod 0600 "$psk_tmp"
        # Cleared on every exit, including the die paths and a Ctrl-C part
        # way through the derivation.
        trap 'rm -f "$psk_tmp"' EXIT INT TERM
        printf '%s' "$PSK" > "$psk_tmp"
    fi

    # seal.py asks for the password itself, twice, without echoing it, and
    # verifies the file opens again before handing it over. --out is a path
    # outside any checkout, so a sealed config can never land in a build
    # context, which is the one place it must not be.
    # Unquoted on purpose, so that an empty HIDE adds no argument at all.
    # Every name in it has been checked against index.html, and a card name
    # is letters and nothing else.
    HIDE_ARG=""
    if [ -n "$HIDE" ]; then HIDE_ARG="--hide $HIDE"; fi

    if [ -n "$PASSWORD_FILE" ]; then
        seal_to "$CONFIG_FILE" --host "$TV" --psk-file "$psk_tmp" \
            --interval "$INTERVAL" $HIDE_ARG \
            --password-file "$PASSWORD_FILE"
    elif [ "$INTERACTIVE" -eq 0 ] || [ ! -t 0 ]; then
        die "sealing needs a password: use --password-file, or drop --lock"
    else
        echo
        seal_to "$CONFIG_FILE" --host "$TV" --psk-file "$psk_tmp" \
            --interval "$INTERVAL" $HIDE_ARG
    fi

    if [ "$psk_tmp_ours" -eq 1 ]; then
        rm -f "$psk_tmp"
        trap - EXIT INT TERM
    fi

    say "sealed the connection details into $CONFIG_FILE"
    if [ -n "$HIDE" ]; then say "and the cards to leave out: $HIDE"; fi
    SEALED=1
fi

# The unsealed half. The cards are all this file would hold, so there is
# nothing to preserve across runs: it is written from this run's answers, and
# taken away when this run picked nothing.
if [ "$SEALED" -eq 0 ] && [ "$ASKED" -eq 1 ]; then
    if [ -n "$HIDE" ]; then
        write_card_config "$CONFIG_FILE" "$HIDE"
        say "wrote the cards to leave out into $CONFIG_FILE: $HIDE"
    elif [ -f "$CONFIG_FILE" ]; then
        rm -f "$CONFIG_FILE"
        say "removed the card list an earlier run left at $CONFIG_FILE"
    fi
elif [ "$SEALED" -eq 0 ] && [ -f "$CONFIG_FILE" ]; then
    say "keeping the card list already at $CONFIG_FILE; --hide sets a new one"
fi

# Sealed or not, this is the file that goes beside the app.
HAVE_CONFIG=0
if [ -f "$CONFIG_FILE" ]; then HAVE_CONFIG=1; fi

# The key has done its work. Drop it rather than leaving it in the environment
# of everything this script runs from here on.
PSK=""
unset PSK

echo

if [ "$MODE" = "systemd" ]; then

    # == systemd =============================================================

    command -v systemctl >/dev/null 2>&1 \
        || die "systemctl not found. Choose the Docker install, or use a systemd machine."
    find_python || die "python3 not found. Install it and run this again."

    if id "$SERVICE_USER" >/dev/null 2>&1; then
        say "user $SERVICE_USER already exists"
    else
        # --user-group explicitly: the unit says Group=bravia, and whether a
        # bare useradd creates a matching group depends on USERGROUPS_ENAB and
        # so on the distribution.
        useradd --system --user-group --no-create-home \
            --shell /usr/sbin/nologin "$SERVICE_USER"
        say "created system user and group $SERVICE_USER"
    fi

    mkdir -p "$INSTALL_DIR"
    for file in $APP_FILES; do
        install -m 0644 "$SOURCE_DIR/$file" "$INSTALL_DIR/$file"
    done
    mkdir -p "$INSTALL_DIR/content"
    if [ -d "$SOURCE_DIR/content" ]; then
        find "$SOURCE_DIR/content" -maxdepth 1 -type f -exec \
            install -m 0644 {} "$INSTALL_DIR/content/" \;
    fi
    say "installed the app into $INSTALL_DIR"

    # Whichever config this run settled on replaces the placeholder that was
    # just copied in: the sealed one, or the plain list of cards to leave out.
    if [ "$HAVE_CONFIG" -eq 1 ]; then
        install -m 0644 "$CONFIG_FILE" "$INSTALL_DIR/deploy-config.js"
        if [ "$SEALED" -eq 1 ]; then
            say "installed the sealed config"
        else
            say "installed the card list"
        fi
    fi

    chown -R root:root "$INSTALL_DIR"

    cat > "$UNIT_FILE" <<UNIT
[Unit]
Description=Bravia Console, a web remote for Sony Bravia displays
Documentation=https://github.com/mjaksn/bravia-http-remote
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=$SERVICE_USER
Group=$SERVICE_USER
WorkingDirectory=$INSTALL_DIR
ExecStart=$PYTHON $INSTALL_DIR/proxy.py $TV $PORT $BIND
Restart=always
RestartSec=5

StandardOutput=journal
StandardError=journal
SyslogIdentifier=bravia-console

# Hardening. It reads its own directory, binds one port and talks to one
# television. It writes nothing at all.
NoNewPrivileges=true
ProtectSystem=strict
ProtectHome=true
PrivateTmp=true
ProtectKernelTunables=true
ProtectKernelModules=true
ProtectControlGroups=true
RestrictNamespaces=true
RestrictRealtime=true
RestrictSUIDSGID=true
LockPersonality=true
MemoryDenyWriteExecute=true
SystemCallArchitectures=native
SystemCallFilter=@system-service
SystemCallErrorNumber=EPERM
RestrictAddressFamilies=AF_INET AF_INET6 AF_UNIX

[Install]
WantedBy=multi-user.target
UNIT

    chmod 0644 "$UNIT_FILE"
    systemctl daemon-reload
    systemctl enable "$UNIT_NAME" >/dev/null 2>&1
    say "installed and enabled $UNIT_NAME"

    if [ "$START_IT" -eq 1 ]; then
        systemctl restart "$UNIT_NAME"
        say "started $UNIT_NAME"
    fi

else

    # == docker ==============================================================

    command -v docker >/dev/null 2>&1 \
        || die "docker not found. Choose the systemd install, or install Docker."
    docker compose version >/dev/null 2>&1 \
        || die "'docker compose' is not available. Install the Compose plugin."

    mkdir -p "$CONFIG_DIR"
    chmod 0755 "$CONFIG_DIR"

    mount_lines=""
    if [ "$HAVE_CONFIG" -eq 1 ]; then
        # Mounted, never copied into an image. A sealed blob inside a published
        # image can be pulled and attacked offline by anyone, and registry
        # layers outlive any attempt to take it back. The unsealed card list
        # is mounted the same way for the plainer reason that the published
        # image is not this deployment's to rebuild.
        mount_lines="
    volumes:
      - $CONFIG_FILE:/app/deploy-config.js:ro"
    fi

    cat > "$COMPOSE_FILE" <<COMPOSE
# Written by scripts/install.sh. Running the installer again rewrites this
# file, so keep any edits of your own somewhere else.

name: bravia-console

services:
  console:
    image: $IMAGE
    container_name: bravia-console
    restart: unless-stopped

    environment:
      BRAVIA_TV: "$TV"
      BRAVIA_PORT: 8585

    ports:
      - "$PORT:8585"$mount_lines
COMPOSE

    chmod 0644 "$COMPOSE_FILE"
    say "wrote $COMPOSE_FILE"

    if docker pull --quiet "$IMAGE" >/dev/null 2>&1; then
        say "pulled $IMAGE"
    else
        say "warning: could not pull $IMAGE; compose will try again on start"
    fi

    if [ "$START_IT" -eq 1 ]; then
        docker compose --file "$COMPOSE_FILE" up --detach >/dev/null
        say "started the bravia-console container"
    fi
fi

# == what to do next =========================================================

# A systemd install bound to one address answers only on that address, so it
# is the address to print. Asking the machine for its first LAN address there
# would end a perfectly good install by naming a URL that will not answer,
# and 127.0.0.1 is a supported answer to the prompt. Everything else, Docker
# included, is published on every interface, and for those the machine's own
# address is the useful one.
if [ "$MODE" = "systemd" ] && [ "$BIND" != "0.0.0.0" ]; then
    HOSTADDR="$BIND"
else
    # `hostname -I` is Linux and GNU. busybox has -i and not -I, and other
    # systems have neither, so this is allowed to come back with nothing.
    #
    # Two things have to be right for that to be harmless. `|| true` keeps
    # `pipefail` from handing a failed `hostname` to `set -e`, which would
    # end a completely successful install here, silently, with no "Done."
    # and a non-zero status. And the fallback tests the value rather than
    # the pipeline, because awk exits 0 on empty input and a `||` after it
    # would never run.
    HOSTADDR="$(hostname -I 2>/dev/null | awk '{print $1}' || true)"
fi
[ -n "$HOSTADDR" ] || HOSTADDR="localhost"

echo
echo "Done."
echo

cat <<NEXT
  The console is at:

      http://$HOSTADDR:$PORT/

  It serves the app and forwards /sony/* to $TV, so the browser and the
  display are same-origin and no CORS preflight is involved.

NEXT

if [ "$SEALED" -eq 1 ]; then
    cat <<LOCKED
  It will open at a password prompt. The address and the key are sealed inside
  $CONFIG_DIR/deploy-config.js and a forgotten password cannot be recovered:
  delete that file and run this again to set a new one.

LOCKED
else
    cat <<OPEN
  It is NOT locked. Every browser that loads it is asked for the display's
  address and key, and anyone who can reach the page can drive the display.
  Run this again with --lock if that is not what you want.

OPEN
fi

if [ -n "$HIDE" ]; then
    cat <<CARDSNEXT
  These cards are left out, and nothing in the console puts them back:

      $HIDE

  That is a choice about what this console is for, not a restriction on the
  display: it will still do those things if it is asked another way.

CARDSNEXT
fi

if [ "$MODE" = "systemd" ]; then
    cat <<SYSNEXT
  Check it came up:

      systemctl status $UNIT_NAME
      journalctl -u $UNIT_NAME -n 50 --no-pager

SYSNEXT
else
    cat <<DOCKNEXT
  Check it came up:

      docker compose --file $COMPOSE_FILE ps
      docker compose --file $COMPOSE_FILE logs --tail 50

DOCKNEXT
fi
