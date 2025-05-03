#!/usr/bin/env node

import {
  CodeActionKind,
  createConnection,
  DidChangeConfigurationNotification,
  ExecuteCommandParams,
  InitializeParams,
  InitializeResult,
  ProposedFeatures,
  TextDocuments,
  TextDocumentSyncKind,
} from "vscode-languageserver/node.js";

import * as fs from 'fs';

import { TextDocument } from "vscode-languageserver-textdocument";
import {
  constructSettingsForText,
  CSpellSettings,
  CSpellUserSettings,
  getDefaultConfigLoader,
  readSettings,
  refreshDictionaryCache
} from "cspell-lib";

import * as Validator from './validator.js';
import { createOnCodeActionHandler } from "./codeActions.js";

// Retrieve the arguments array, excluding the first element.
const args = process.argv.slice(1);
const configIndex = args.findIndex((e) => e === "--config") + 1;

const settingsPath = configIndex ? args.at(configIndex) : null;
export let userSettings: CSpellUserSettings = {};

const COMMANDS = ['AddToUserWordsConfig', 'AddToWorkspaceWordsConfig', 'AddToCustomDictionary']

function tryReadSettingsFile(file: string): CSpellSettings | null {
  if (!fs.existsSync(file)) {
    return null
  }
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (error) {
    return null;
  }
}

// List of settings files try and load.
// TODO: add more paths
const fileCandidates = ['./cspell.json', './.cspell.json'];
let mainSettingsPath = settingsPath ?? './cspell.json';

if (settingsPath) {
  fileCandidates.unshift(settingsPath);
}

for (const file of fileCandidates) {
  let fileSettings = tryReadSettingsFile(file);
  if (fileSettings) {
    userSettings = fileSettings;
    mainSettingsPath = file;
    break;
  }
}

// Create a connection for the server, using Node's IPC as a transport.
// Also include all preview / proposed LSP features.
const connection = createConnection(ProposedFeatures.all);

// Create a simple text document manager.
const documents = new TextDocuments(TextDocument);

let hasConfigurationCapability = false;
let hasWorkspaceFolderCapability = false;

connection.onInitialize((_: InitializeParams) => {
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

connection.onInitialized(() => {
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

const settingsCache: Map<string, CSpellSettings> = new Map();

export async function getSettingsForDocument(textDocument: TextDocument) {
  let cached = settingsCache.get(textDocument.uri);
  if (cached) {
    return cached;
  }
  var settings = constructSettingsForText(
    await readSettings(mainSettingsPath),
    undefined,
    textDocument.languageId
  );

  settingsCache.set(textDocument.uri, settings);
  return settings;
}

connection.onExecuteCommand((params: ExecuteCommandParams) => {
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
    if (!mainSettingsPath.endsWith(".json")) {
      return { error: `Only JSON config files are supported` };
    }

    const attribute = command == "AddToUserWordsConfig" ? "userWords" : "words"
    // Add the word to the user words array
    if (!userSettings[attribute]) {
      userSettings[attribute] = [];
    }
    userSettings[attribute].push(word);

    // Write to file
    fs.writeFileSync(mainSettingsPath, JSON.stringify(userSettings, null, 2));

    // Clear settings cache
    settingsCache.clear();

    getDefaultConfigLoader().clearCachedSettingsFiles();
    validateTextDocument(document);
    return { result: `Added "${word}" to the dictionary.` };
  }
  if (command == "AddToCustomDictionary") {
    // Assumes the file breaks lines with LF and it ends with a \n already,
    // instead of trying to be clever
    fs.appendFileSync(dictPath, `${word}\n`);

    refreshDictionaryCache(0).then(() => validateTextDocument(document));
    return { result: `Added ${word} to ${dictName} dictionary.` };
  }

});

// Make the text document manager listen on the connection
// for open, change and close text document events
documents.listen(connection);

// Listen on the connection
connection.listen();
