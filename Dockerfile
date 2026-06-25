# TikDrawer — full app image with a complete TeX Live + dvisvgm toolchain so the
# render API has a LaTeX compiler available inside the container.
FROM texlive/texlive:latest

# Install Node.js 20 (the texlive image is Debian-based) and mupdf-tools, which
# provides `mutool` — dvisvgm needs it (or an old Ghostscript) to convert PDF to
# SVG; the image's Ghostscript is too new for dvisvgm's PDF support.
RUN apt-get update \
    && apt-get install -y --no-install-recommends curl ca-certificates gnupg \
    && curl -fsSL https://deb.nodesource.com/setup_20.x | bash - \
    && apt-get install -y --no-install-recommends nodejs mupdf-tools \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm install

COPY . .
RUN npm run build

ENV NODE_ENV=production
ENV PORT=3000
EXPOSE 3000

CMD ["npm", "run", "start"]
