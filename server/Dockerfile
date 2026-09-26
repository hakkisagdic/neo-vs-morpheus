# syntax=docker/dockerfile:1
#
# ModernUO at the commit pinned in deps.lock, plus our NeoArena overlay (server/overlay).
# The upstream source arrives as the named build context "modernuo"; docker-compose.yml points
# it at vendor/modernuo, which `scripts/deps.sh sync` fills. Upstream is never modified.
ARG DOTNET_VERSION=10.0

FROM mcr.microsoft.com/dotnet/sdk:${DOTNET_VERSION} AS build
WORKDIR /src
COPY --from=modernuo . .
COPY overlay/ Projects/UOContent/NeoArena/
# - NBGV_GitEngine=Disabled: Nerdbank.GitVersioning cannot compute a version from the shallow
#   checkout that scripts/deps.sh makes, and the version number does not matter here.
# - RuntimeIdentifiers=<this rid>: upstream lists six RIDs, which makes restore download a
#   runtime pack for each (about 1 GB); only the image's own is needed.
RUN --mount=type=cache,id=neo-vs-morpheus-nuget,target=/root/.nuget/packages \
    rid="linux-$(dpkg --print-architecture | sed 's/amd64/x64/')" \
 && props="-p:NBGV_GitEngine=Disabled -p:RuntimeIdentifiers=$rid" \
 && dotnet restore Projects/Application/Application.csproj -r "$rid" $props \
 && dotnet publish Projects/Application/Application.csproj -c Release -r "$rid" $props \
      --no-restore --self-contained=false -nologo \
 && find Distribution -name '*.pdb' -delete

FROM mcr.microsoft.com/dotnet/runtime:${DOTNET_VERSION}

# Native libraries ModernUO loads (see its README "Linux Prerequisites") plus jq for the entrypoint.
RUN apt-get update \
 && apt-get install -y --no-install-recommends jq libdeflate0 libargon2-1 tzdata '^libicu[0-9]+$' \
 && (apt-get install -y --no-install-recommends tzdata-legacy || true) \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY --from=build /src/Distribution/ ./

# Synthetic client data for running without EA's files: ModernUO strictly needs only tiledata.mul
# (a zeroed 7.0.9+ file: every tile passable, no flags) and multi.idx/multi.mul (empty: no
# multis). Missing map/statics files make it serve flat land at z=0 everywhere.
RUN mkdir -p /opt/arena-data \
 && head -c 3188736 /dev/zero > /opt/arena-data/tiledata.mul \
 && : > /opt/arena-data/multi.idx \
 && : > /opt/arena-data/multi.mul \
 && groupadd --gid 10001 uo \
 && useradd --uid 10001 --gid uo --no-create-home --home-dir /app uo \
 && mkdir -p World Configuration Logs \
 && chown -R uo:uo /app # the server writes next to itself (temp/, Logs/, crash reports)

COPY --chmod=755 entrypoint.sh /usr/local/bin/neo-server

USER uo
EXPOSE 2593
VOLUME ["/app/World"]
ENTRYPOINT ["/usr/local/bin/neo-server"]
