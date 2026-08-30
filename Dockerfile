# Bravia Console in a container.
#
# It would be tempting to serve this as static files and be done, since that
# is what index.html, app.js, style.css and lockbox.js are. It is the wrong
# call here. Many Bravia displays never answer a CORS preflight, and a browser
# then blocks every request the page makes to the television. That is what
# proxy.py exists for, and a container is squarely in the failing case: the
# whole reason to run this in Docker is to reach it from a phone or a laptop,
# which means the page and the display are on different origins.
#
# So the image serves the app and forwards /sony/* to the display, making
# everything same-origin, which works in any unmodified browser.
#
# One stage, because there is nothing to build. proxy.py is standard library
# only, so there are no dependencies to install, nothing to pin in a lock file
# and no wheel to compile. The base image digest is the only pin here.
#
# A patch tag rather than the rolling 3.14-slim, and that is not fussiness.
# The rolling tags are rebuilt every few days, so whatever digest they point
# at is always a few days old, and nothing that young may be used here.
#
# A patch tag is quieter, but it is not still: while it is the newest of its
# line it is rebuilt too. So the newest patch is exactly the one whose digest
# keeps moving, which is how 3.14.7-slim was taken here on a digest a day old.
# Take the patch behind the newest, which has stopped.
#
# Check the age rather than assuming it, and do not lean on Dependabot's
# cooldown for this: the cooldown reads the version, and a rebuilt digest is
# the same version it was yesterday. This one was 23 days old when it was
# pinned.
FROM python:3.14.6-slim@sha256:7bec7ddcddeff7975d6ba9b4be7dd6f6b2f55e7491539145e2978f7f97ce9144

LABEL org.opencontainers.image.title="Bravia Console" \
      org.opencontainers.image.description="Single-page controller for Sony Bravia displays over the Bravia HTTP REST API" \
      org.opencontainers.image.source="https://github.com/mjaksn/bravia-http-remote" \
      org.opencontainers.image.documentation="https://github.com/mjaksn/bravia-http-remote/blob/main/README.md" \
      org.opencontainers.image.licenses="MIT"

# A fixed UID and GID rather than an arbitrary one, so that a mounted
# deploy-config.js can be given an owner that matches. 10001 is above the range
# Debian hands out to system accounts, so it will not collide with a user the
# base image created.
RUN groupadd --gid 10001 bravia \
    && useradd --uid 10001 --gid 10001 --no-create-home --shell /usr/sbin/nologin bravia

WORKDIR /app

# proxy.py serves files from its own directory, so what is copied here is
# exactly what the app can serve. deploy-config.js is the repository's
# placeholder, which leaves the console asking each browser for the address
# and the key.
#
# A sealed config is mounted at run time and never copied in. Baking one into a
# published image would hand the sealed blob to anyone who can pull it, and
# registry layers outlive the file, so it could not be taken back. seal.py
# refuses to write anywhere under a directory containing a Dockerfile for this
# reason.
COPY index.html app.js style.css lockbox.js deploy-config.js pack.html proxy.py ./
COPY content ./content

ENV PYTHONUNBUFFERED=1 \
    BRAVIA_PORT=8585

EXPOSE 8585

# /__proxy answers with the display it is pointed at, needs no authentication
# and touches the television not at all, so it says the server is up without
# waking anything. It does not say the display is reachable; nothing here can,
# short of talking to it.
HEALTHCHECK --interval=30s --timeout=5s --start-period=5s --retries=3 \
    CMD ["python", "-c", "import os,urllib.request; urllib.request.urlopen('http://127.0.0.1:%s/__proxy' % os.environ.get('BRAVIA_PORT','8585'), timeout=4)"]

USER bravia

# The display's address comes from the environment rather than from a
# positional argument, so that `docker run` and a compose file configure this
# the same way everything else is configured. Unset is a hard failure with a
# usable message, not a container that starts and forwards nowhere.
#
# The bind is 0.0.0.0 and not proxy.py's own 127.0.0.1 default, because
# loopback inside a container belongs to the container and a published port
# would reach nothing. What that exposes is decided by the publish: see the
# README, and note that reaching this from a phone is the ordinary case and
# exactly when a sealed deploy-config.js earns its keep.
#
# exec so that the interpreter is PID 1 and gets the signals directly.
ENTRYPOINT ["sh", "-c", "exec python proxy.py \"${BRAVIA_TV:?set BRAVIA_TV to the display address, for example 192.168.1.50}\" \"${BRAVIA_PORT:-8585}\" 0.0.0.0"]
