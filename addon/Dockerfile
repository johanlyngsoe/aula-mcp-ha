FROM oven/bun:1-debian

RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates git jq \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Copying config.yaml here means its version field busts the Docker layer
# cache on every addon version bump, forcing a fresh git clone + bun install.
COPY config.yaml /tmp/addon-config.yaml

# Clone source and install dependencies at build time.
RUN git clone https://github.com/johanlyngsoe/aula-mcp-ha.git . \
    && bun install

COPY run.sh /run.sh
RUN chmod +x /run.sh

CMD ["/run.sh"]
