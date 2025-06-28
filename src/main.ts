#!/usr/bin/env node

import {
  CodeActionKind,
  createConnection,
  DidChangeConfigurationNotification,
  DidChangeWatchedFilesNotification,
  ExecuteCommandParams,
  FileSystemWatcher,
  InitializeParams,
  InitializeResult,
  ProposedFeatures,
  TextDocuments,
  TextDocumentSyncKind,
} from "vscode-languageserver/node.js";

import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';

import { TextDocument } from "vscode-languageserver-textdocument";
import {
  constructSettingsForText,
  CSpellSettings,
  CSpellUserSettings,
  getDefaultConfigLoader,
  getDefaultSettings,
  getGlobalSettingsAsync,
  mergeSettings,
  readSettings,
} from "cspell-lib";

import * as Validator from './validator.js';
import { createOnCodeActionHandler } from "./codeActions.js";
import commandLineArgs from 'command-line-args';

const optionDefinitions = [
  { name: 'config', alias: 'c', type: String, defaultValue: null },
  { name: 'sortWords', type: Boolean, defaultValue: false },
  { name: 'stdio', type: String },
];

const options = commandLineArgs(optionDefinitions);

let defaultSettings: CSpellUserSettings = {};

const COMMANDS = ['AddToUserWordsConfig', 'AddToWorkspaceWordsConfig']

// Create a connection for the server, using Node's IPC as a transport.
// Also include all preview / proposed LSP features.
const connection = createConnection(ProposedFeatures.all);

// Create a simple text document manager.
const documents = new TextDocuments(TextDocument);

let hasConfigurationCapability = false;
let hasWorkspaceFolderCapability = false;
let workspaceRoot: string | undefined;

connection.onInitialize((params: InitializeParams) => {
  defaultSettings = params.initializationOptions?.defaultSettings ?? {};

  hasConfigurationCapability = !!(params.capabilities.workspace && !!params.capabilities.workspace.configuration);
  hasWorkspaceFolderCapability = !!(params.capabilities.workspace && !!params.capabilities.workspace.workspaceFolders);

  if (params.workspaceFolders?.length) {
    workspaceRoot = fileURLToPath(params.workspaceFolders[0].uri);
  } else if (params.rootUri) {
    workspaceRoot = fileURLToPath(params.rootUri);
  } else if (params.rootPath) {
    workspaceRoot = params.rootPath;
  }

  const result: InitializeResult = {
    capabilities: {
      textDocumentSync: {
        openClose: true,
        change: TextDocumentSyncKind.Incremental,
        willSave: true,
        save: { includeText: true },
      },
      codeActionProvider: {
        codeActionKinds: [CodeActionKind.QuickFix],
      },
      executeCommandProvider: {
        commands: COMMANDS,
      }
    },
  };
  return result;
});

connection.onInitialized(async () => {
  if (hasConfigurationCapability) {
    // Register for all configuration changes.
    connection.client.register(
      DidChangeConfigurationNotification.type,
      undefined,
    );
  }
  if (hasWorkspaceFolderCapability) {
    connection.workspace.onDidChangeWorkspaceFolders((_event) => {
      connection.console.log("Workspace folder change event received.");
    });
  }

  const watchers: FileSystemWatcher[] = [{ globPattern: '**/cspell.{json,yaml,yml}' }, { globPattern: '**/.cspell.json' }];
  if (options.config) {
    let baseUri: string;
    let pattern: string;
    if (path.isAbsolute(options.config)) {
      baseUri = 'file://' + path.dirname(options.config);
      pattern = path.basename(options.config);
    } else {
      baseUri = 'file://' + process.cwd();
      pattern = options.config.startsWith('.' + path.sep) ? options.config.substring(2) : options.config;
    }
    watchers.push({ globPattern: { baseUri, pattern } });
  }
  const globalConfig = await getGlobalSettingsAsync();
  // getGlobalSettingsAsync returns with globRoot even if global config doesn't exist
  if (globalConfig.globRoot && fs.existsSync(globalConfig.globRoot)) {
    const baseUri = 'file://' + globalConfig.globRoot;
    // https://github.com/streetsidesoftware/cspell/blob/1bee5f5aa4429a1b1ae0e88934b093c5440b44dc/packages/cspell-lib/src/lib/Settings/cfgStore.ts#L15
    watchers.push({ globPattern: { baseUri, pattern: 'cspell.json' } });
  }
  // Watch for changes in cspell config files
  connection.client.register(DidChangeWatchedFilesNotification.type, { watchers });
});

connection.onDidChangeWatchedFiles((_change) => {
    connection.console.log('Configuration file changed. Revalidating all open documents.');
    revalidateAllOpenDocuments();
});

connection.onCodeAction(createOnCodeActionHandler(documents));

// This event is emitted when the text document first opened or when its content has changed.
documents.onDidChangeContent((change) => {
  validateTextDocument(change.document);
});

async function validateTextDocument(textDocument: TextDocument): Promise<void> {
  const settings = await getSettingsForDocument(textDocument);
  connection.sendDiagnostics({
    uri: textDocument.uri,
    diagnostics: await Validator.validateTextDocument(textDocument, settings),
  });
}

function revalidateAllOpenDocuments() {
    settingsCache.clear();
    getDefaultConfigLoader().clearCachedSettingsFiles();
    for (const doc of documents.all()) {
        validateTextDocument(doc);
    }
}

const settingsCache: Map<string, CSpellSettings> = new Map();

export async function getSettingsForDocument(textDocument: TextDocument) {
  const cached = settingsCache.get(textDocument.uri);
  if (cached) {
    return cached;
  }
  const docPath = textDocument.uri.startsWith('file:') ? fileURLToPath(textDocument.uri) : undefined;
  let config;
  if (options.config) {
    try {
      config = await readSettings(options.config);
    } catch (e) {
      // The config file might not exist.
      config = undefined;
    }
  } else {
    const configLoader = getDefaultConfigLoader();
    config = docPath ? await configLoader.searchForConfig(docPath) : undefined;
  }

  const settings = mergeSettings(await getDefaultSettings(), await getGlobalSettingsAsync(), defaultSettings, config || {});
  const documentSettings = constructSettingsForText(settings, undefined, textDocument.languageId);

  settingsCache.set(textDocument.uri, documentSettings);
  return documentSettings;
}

connection.onExecuteCommand(async (params: ExecuteCommandParams) => {
  const { command, arguments: args } = params;
  if (COMMANDS.indexOf(command) < 0) {
    return;
  }

  const diagnosticInfo = args![0];
  const { uri, range, name: dictName, path: dictPath } = diagnosticInfo;
  const document = documents.get(uri!);
  if (!document) {
    return { error: `Could not get document for ${uri}` };
  }
  const word = document.getText(range);
  if (!word) {
    return { error: 'Could not extract the word from the message.' };
  }

  if (command == "AddToUserWordsConfig" || command == "AddToWorkspaceWordsConfig") {
    const docPath = fileURLToPath(uri);
    let configPath: string | undefined = options.config;
    if (!configPath) {
        const config = await getDefaultConfigLoader().searchForConfig(docPath);
        configPath = config?.source?.filename;
    }

    let currentSettings: CSpellUserSettings = {};

    if (configPath) {
        try {
            currentSettings = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
        } catch (e) {
            // It might not exist, which is fine, we will create it.
        }
    } else {
        if (!workspaceRoot) {
            return { error: 'Cannot determine workspace root to create a new cspell.json file.' };
        }
        configPath = path.join(workspaceRoot, 'cspell.json');
        currentSettings = defaultSettings;
    }


    if (!configPath.endsWith(".json")) {
      return { error: `Only JSON config files are supported` };
    }

    const attribute = command == "AddToUserWordsConfig" ? "userWords" : "words"
    // Add the word to the user words array
    const words = currentSettings[attribute] || [];
    if (!words.includes(word)) {
        words.push(word);
    }
    currentSettings[attribute] = words;

    // Sort words before write if settings in enabled
    if(options.sortWords) {
      currentSettings.userWords?.sort((a, b) => a.localeCompare(b, 'en', {'sensitivity': 'base'}))
      currentSettings.words?.sort((a, b) => a.localeCompare(b, 'en', {'sensitivity': 'base'}))
    }

    // Write to file
    fs.writeFileSync(configPath, JSON.stringify(currentSettings, null, 2));

    revalidateAllOpenDocuments();
    return { result: `Added "${word}" to the dictionary.` };
  }
});

// Make the text document manager listen on the connection
// for open, change and close text document events
documents.listen(connection);

// Listen on the connection
connection.listen();
