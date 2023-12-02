# Spell Checker LSP

This extension performs spell checking in source code files, using the [cspell library](https://cspell.org/).

This is a fork of [vscode-spell-checker](https://github.com/streetsidesoftware/vscode-spell-checker) and adapted to work with the [Helix text editor](https://helix-editor.com/).

## Build
```
npm install
npm run build
```

## Install
```
npm link
```

## Helix config
`helix/languages.toml:`  
```
[language-server.cspell]
command = "cspell-lsp"
args = ["--stdio"]

# Add for every language that you want to spell check
[[language]]
name = "rust"
language-servers = ["rust-analyzer", "cspell"]

[[language]]
name = "cpp"
language-servers = [ "clangd", "cspell" ]

[[language]]
name = "markdown"
language-servers = [ "marksman", "cspell" ]
```
For reference https://github.com/helix-editor/helix/blob/86023cf1e6c9ab12446061e40c838335c5790979/languages.toml

> Custom dictionaries and configurations are not supported
