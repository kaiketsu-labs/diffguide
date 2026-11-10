# Headless VS Code for scripts/e2e.mjs: Node, git, Xvfb and the VS Code release the e2e run targets.
FROM node:22-bookworm-slim
ARG VSCODE_VERSION=1.135.0
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates curl git xvfb xauth \
    libasound2 libgbm1 libgtk-3-0 libnss3 libxkbfile1 libsecret-1-0 libxss1 \
  && arch=$(dpkg --print-architecture | sed s/amd64/x64/) \
  && curl -fsSL -o /tmp/code.deb "https://update.code.visualstudio.com/${VSCODE_VERSION}/linux-deb-${arch}/stable" \
  && apt-get install -y --no-install-recommends /tmp/code.deb \
  && rm -rf /tmp/code.deb /var/lib/apt/lists/*
WORKDIR /work
CMD ["xvfb-run", "-a", "node", "scripts/e2e.mjs"]
