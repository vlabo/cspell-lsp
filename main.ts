import {
  CodeActionKind,
  createConnection,
  Diagnostic,
  DidChangeConfigurationNotification,
  ExecuteCommandParams,
  InitializeParams,
  InitializeResult,
  ProposedFeatures,
  TextDocuments,
  TextDocumentSyncKind,
} from "vscode-languageserver/node";

import * as fs from 'fs';
import * as readline from 'readline';

import { TextDocument } from "vscode-languageserver-textdocument";
import { getDefaultSettings, constructSettingsForText, CSpellSettings } from "cspell-lib";

import * as Validator from './validator.mjs';
import { createOnCodeActionHandler } from "./codeActions.mts";

// Retrieve the arguments array, excluding the first two elements
const args = process.argv.slice(2);

let dictionaryPath: string | null = null;

let settingsCache: Map<string, CSpellSettings> = new Map();
export let userWords: Array<string> = [];

// Iterate over the arguments to find '--dictionary'
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--dictionary' && args[i + 1]) {
    // The next element should be the path to the file
    try {
      dictionaryPath = args[i + 1];
      let stream = fs.createReadStream(dictionaryPath);
      const rl = readline.createInterface({
        input: stream,
        crlfDelay: Infinity  // Recognizes all instances of CR LF as a single line break
      });

      for await (const line of rl) {
        userWords.push(line);
      }
      break;
    } catch (err) {
      console.error(`An error occurred while processing the file: ${err}`);
    }
  }
}

if (dictionaryPath) {
  console.log(`Dictionary path: ${dictionaryPath}`);
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
        commands: ['AddToDictionary']
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


// connection.onDidChangeConfiguration((change) => {
//   connection.languages.diagnostics.refresh();
// });

// Utility function to create a simple code action
function createCodeAction(title, kind, diagnostics, textEdit) {
  return {
    title,
    kind,
    diagnostics,
    edit: {
      changes: {
        [textEdit.uri]: [textEdit]
      }
    }
  };
}

connection.onCodeAction(createOnCodeActionHandler(documents));

// The content of a text document has changed. This event is emitted
// when the text document first opened or when its content has changed.
documents.onDidChangeContent((change) => {
  validateTextDocument(change.document);
});

async function validateTextDocument(
  textDocument: TextDocument,
): Promise<void> {
  const settings = await getSettigsForDocument(textDocument);

  const diagnostics: Diagnostic[] = await Validator.validateTextDocument(textDocument, settings);
  // Send the computed diagnostics to the editor.
  connection.sendDiagnostics({ uri: textDocument.uri, diagnostics });
}

export async function getSettigsForDocument(textDocument: TextDocument) : Promise<CSpellSettings> {
    let cached = settingsCache.get(textDocument.uri);
    if(cached) {
      return cached;
    }
    const settings = constructSettingsForText(await getDefaultSettings(), undefined, textDocument.languageId);
    settings.userWords = [...userWords];
    settingsCache[textDocument.uri] = settings;
    return settings
}

connection.onExecuteCommand(async (params: ExecuteCommandParams) => {

  const { command, arguments: args } = params;
  if (command == "AddToDictionary") {
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
      // Add to fictionary file
      if (dictionaryPath) {
        fs.appendFile(dictionaryPath, word + "\n", () => { });
      }
      await validateTextDocument(document);
      // Clear settings cache
      settingsCache = new Map();
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
