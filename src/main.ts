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
import * as readline from 'readline';

import { TextDocument } from "vscode-languageserver-textdocument";
import { getDefaultSettings, constructSettingsForText, CSpellSettings } from "cspell-lib";

import * as Validator from './validator.js';
import { createOnCodeActionHandler } from "./codeActions.js";

// Retrieve the arguments array, excluding the first two elements
const args = process.argv.slice(2);
const dictionaryIndex = args.findIndex((e) => e === "--dictionary") + 1;

export let dictionaryPath = dictionaryIndex ? args.at(dictionaryIndex) : null;
export let userWords: string[] = [];

if (dictionaryPath) {
  console.log(`Dictionary path: ${dictionaryPath}`);
  try {
    let stream = fs.createReadStream(dictionaryPath);
    const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
    for await (const line of rl) {
      userWords.push(line);
    }
  } catch (err) {
    console.error(`An error occurred while processing the file: ${err}`);
  }
} else {
  console.log('No dictionary path provided');
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
        commands: ['AddToDictionary', 'AddToConfig'],
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

// The content of a text document has changed. This event is emitted
// when the text document first opened or when its content has changed.
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
  const settings = constructSettingsForText(
    await getDefaultSettings(),
    undefined,
    textDocument.languageId
  );
  settings.userWords = [...userWords];
  settingsCache.set(textDocument.uri, settings);
  return settings;
}

connection.onExecuteCommand(async (params: ExecuteCommandParams) => {
  const { command, arguments: args } = params;
  if (command == "AddToDictionary" || command == "AddToConfig") {
    const diagnosticInfo = args![0];
    const { uri, range } = diagnosticInfo;
    const document = documents.get(uri!);
    if (!document) {
      return { error: `Could not get document for ${uri}` };
    }
    const word = document.getText(range);
    if (word) {
      // Add the word to the custom dictionary
      userWords.push(word);
      // Add to dictionary file
      switch (command) {
        case "AddToDictionary":
          {
            if (dictionaryPath) {
              fs.appendFile(dictionaryPath, word + "\n", () => { });
            }
            break;
          }
        case "AddToConfig":
          {
            const filename = "cspell.json";

            if (!fs.existsSync(filename)) {
              fs.writeFileSync(filename, "{}");
            }
            const cspellConfig = JSON.parse(
              fs.readFileSync(filename, { encoding: "utf8" })
            ) as CSpellSettings;
            (cspellConfig.words ||= []).push(word);
            fs.writeFileSync(filename, JSON.stringify(cspellConfig, null, 2));
            break;
          }
      }

      // Clear settings cache
      settingsCache.clear();

      validateTextDocument(document);
      return { result: `Added "${word}" to the dictionary.` };
    }

    return { error: 'Could not extract the word from the message.' };
  }

});

// Make the text document manager listen on the connection
// for open, change and close text document events
documents.listen(connection);

// Listen on the connection
connection.listen();
