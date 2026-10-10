# syntax=docker/dockerfile:1
#
# SphereServer-X (github.com/Sphereserver/Source-X) with the Scripts-X pack, for running our bots
# against a Sphere shard. Both arrive as named build contexts, "source-x" and "scripts-x";
# server/sphere/sphere.sh points them at vendor/emulators/. Upstream is never modified: the
# entrypoint writes our settings next to upstream's sphere.ini template at every start.
ARG DEBIAN_VERSION=trixie

# Upstream needs CMake >= 3.29 and a C++20 compiler: trixie has CMake 3.31 and GCC 14. Sphere
# links the MariaDB client library even when MySQL is off, hence libmariadb-dev.
FROM debian:${DEBIAN_VERSION} AS build
RUN apt-get update \
 && apt-get install -y --no-install-recommends cmake ninja-build g++ libmariadb-dev \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /src
COPY --from=source-x . .

# Upstream's "Nightly" build type (-O3, the one its CI publishes) with upstream's toolchain file
# for this machine's architecture.
# - CMAKE_NO_GIT_REVISION: the shallow checkout has no meaningful revision count; the image
#   tag carries the commit instead (sphere.sh).
# - -U_SANITIZERS: upstream's CMakeLists sets ENABLED_SANITIZER with a malformed CACHE call
#   (`set(ENABLED_SANITIZER FALSE CACHE INTERNAL BOOL "...")` makes a five-item list, which is
#   true), so every build gets _SANITIZERS, and with it Sphere installs no SIGHUP/SIGTERM
#   handlers: SIGHUP would kill it without the world save it is meant to trigger. The flag
#   comes after the -D in the compile command, so it wins.
# - -fsigned-char on ARM: char is signed on x86 and on Apple ARM, where upstream builds and
#   tests; Linux on ARM makes it unsigned unless told otherwise.
ARG JOBS=6
RUN case "$(dpkg --print-architecture)" in \
      amd64) toolchain=Linux-GNU-x86_64; bin=bin-x86_64; flags="-U_SANITIZERS" ;; \
      arm64) toolchain=Linux-GNU-AArch64; bin=bin-aarch64; flags="-U_SANITIZERS -fsigned-char" ;; \
      *) echo "no upstream toolchain for $(dpkg --print-architecture)" >&2; exit 1 ;; \
    esac \
 && cmake -G Ninja -S . -B build \
      -DCMAKE_TOOLCHAIN_FILE="cmake/toolchains/$toolchain.cmake" \
      -DCMAKE_BUILD_TYPE=Nightly \
      -DCMAKE_NO_GIT_REVISION=TRUE \
      -DCUSTOM_C_FLAGS="$flags" -DCUSTOM_CXX_FLAGS="$flags" \
 && ninja -C build -j "$JOBS" \
 && install -D -m 755 "build/$bin/SphereSvrX64_nightly" /out/SphereSvrX64_nightly \
 && install -D -m 644 src/sphere.ini /out/sphere.ini.dist \
 && install -D -m 644 src/sphereCrypt.ini /out/sphereCrypt.ini

FROM debian:${DEBIAN_VERSION}-slim

RUN apt-get update \
 && apt-get install -y --no-install-recommends libmariadb3 \
 && rm -rf /var/lib/apt/lists/* \
 && groupadd --gid 10001 sphere \
 && useradd --uid 10001 --gid sphere --no-create-home --home-dir /sphere sphere \
 && mkdir -p /sphere/data/save /sphere/data/accounts /sphere/data/logs \
 && chown -R sphere:sphere /sphere

# /opt/sphere is read-only for the server: the binary, upstream's ini templates and scripts.
COPY --from=build /out/ /opt/sphere/
COPY --from=scripts-x --exclude=.git --exclude=.github . /opt/sphere/scripts/
COPY --chmod=755 entrypoint.sh /usr/local/bin/laya-sphere

# On SIGHUP Sphere saves the world before it exits (given the -U_SANITIZERS above); SIGTERM
# makes it quit without saving.
STOPSIGNAL SIGHUP
USER sphere
WORKDIR /sphere
EXPOSE 2593
VOLUME ["/sphere/data"]
ENTRYPOINT ["/usr/local/bin/laya-sphere"]
