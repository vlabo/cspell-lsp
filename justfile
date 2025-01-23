set windows-shell := ["pwsh.exe", "-NoProfile", "-NoLogo", "-Command"]

build:
    bun build ./main.ts --compile --outfile cspell-lsp