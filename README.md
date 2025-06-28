# Spell Checker LSP

This lsp performs spell checking in source code files, using the [cspell library](https://cspell.org/).

~This is a fork of [vscode-spell-checker](https://github.com/streetsidesoftware/vscode-spell-checker) and adapted to work with the~  
This was intended as a fork to but its now rewritten to be general basic spell check LSP.
Tested on [Helix text editor](https://helix-editor.com/), [Neovim](https://neovim.io/).  
Community support for [Zed](https://zed.dev/) by @mantou132 [zed-cspell](https://github.com/mantou132/zed-cspell)

# Install
```
npm install -g @vlabo/cspell-lsp
```

## Arguments

```
--config, -c -> path to cspell.json config file. If not supplied the lsp will try to create a file in the root of the project. (optional)
--sortWords  -> Sorts the words in the config file (optional)
--stdio      -> Type of communication with the editor. 
```

`cspell-lsp` also reads the global `cspell.json` in:

- Linux: `~/.config/cspell/`
- macOS: `~/Library/Preferences/cspell/`
- Windows: `%AppData%\cspell\Config\` -> Usually: `C:\Users\<username>\AppData\Roaming\cspell\config`

## Helix config
`helix/languages.toml:`  
```toml
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

## Neovim config

### Mason
Search from `cspell-lsp` in the mason registry.

### Zero LSP

```lua
local lsp_configurations = require('lspconfig.configs')

if not lsp_configurations.cspell_lsp then
  lsp_configurations.cspell_lsp = {
    default_config = {
      cmd = {"<path-to-cspell-lsp>", "--stdio"},
      filetypes = {"go", "rust", "js", "ts", "html", "css", "json", "yaml", "markdown", "gitcommit"},
      root_dir = require('lspconfig.util').root_pattern('.git')
    }
  }
end
require('lspconfig').cspell_lsp.setup({})
```

## Build
```
npm install
npm run build
```

