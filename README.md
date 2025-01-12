# Spell Checker LSP

This extension performs spell checking in source code files, using the [cspell library](https://cspell.org/).

~This is a fork of~ This was intended as a fork to [vscode-spell-checker](https://github.com/streetsidesoftware/vscode-spell-checker) ~and adapted to work with the~ but its now rewriten to be general basic spell check for [Helix text editor](https://helix-editor.com/) and hopfaly other editors.

## Build
```
npm install
bun build ./main.ts --compile --outfile cspell-lsp
```
> should work with npm

## Helix config
`helix/languages.toml:`  
```
[language-server.cspell]
command = "cspell-lsp"
args = ["--stdio", "--dictionary", "<path to dictionary file>"]

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
