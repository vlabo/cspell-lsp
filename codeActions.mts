
import type { SpellingDictionary, SuggestionResult, SuggestOptions } from 'cspell-lib';
import { CompoundWordsMethod, constructSettingsForText, getDefaultSettings, getDictionary, IssueType, Text } from 'cspell-lib';
import type { CancellationToken, CodeActionParams, Range as LangServerRange, RequestHandler, TextDocuments } from 'vscode-languageserver/node.js';
import { ResponseError } from 'vscode-languageserver/node.js';
import type { TextDocument } from 'vscode-languageserver-textdocument';
import { Diagnostic, WorkspaceEdit } from 'vscode-languageserver-types';
import { CodeAction, CodeActionKind, TextEdit } from 'vscode-languageserver-types';

import * as Validator from './validator.mjs';
import { getSettigsForDocument, userWords } from './main';

function extractText(textDocument: TextDocument, range: LangServerRange) {
  return textDocument.getText(range);
}

function extractDiagnosticData(diag: Diagnostic): Validator.SpellCheckerDiagnosticData {
  const { data } = diag;
  if (!data || typeof data !== 'object' || Array.isArray(data)) return {};
  return data as Validator.SpellCheckerDiagnosticData;
}

export function createOnActionResolveHandler(): RequestHandler<CodeAction, CodeAction, void> {
  return (_action: CodeAction, _token: CancellationToken) => { return new ResponseError(0, "Error resolving command"); }
}

export function createOnCodeActionHandler(
  documents: TextDocuments<TextDocument>,
): (params: CodeActionParams) => Promise<CodeAction[]> {
  const codeActionHandler = new CodeActionHandler(documents);

  return (params) => codeActionHandler.handler(params);
}


class CodeActionHandler {
  private sugGen: SuggestionGenerator;

  constructor(
    readonly documents: TextDocuments<TextDocument>,
  ) {
    this.sugGen = new SuggestionGenerator();
  }

  public async handler(params: CodeActionParams): Promise<CodeAction[]> {
    const {
      context,
      textDocument: { uri },
    } = params;
    const { diagnostics } = context;
    const spellCheckerDiags = diagnostics;

    if (!spellCheckerDiags.length) return [];

    const textDocument = this.documents.get(uri);
    if (!textDocument) return [];

    const rangeIntersectDiags = [...spellCheckerDiags]
      .map((diag) => diag.range)
      .reduce((a: LangServerRange | undefined, _) => a, params.range);

    // Only provide suggestions if the selection is contained in the diagnostics.
    if (!rangeIntersectDiags || !isWordLikeSelection(textDocument, params.range)) {
      return [];
    }

    const ctx = {
      params,
      textDocument,
    };

    const actions = await this.handlerCSpell({ ...ctx, diags: spellCheckerDiags });
    const codeAction: CodeAction = {
      title: "Add to dictrionary",
      kind: CodeActionKind.QuickFix,
      diagnostics: diagnostics,
      command: {
        title: "Add to dictrionary",
        command: "AddToDictionary",
        arguments: [
          {
            uri: params.textDocument.uri,
            range: diagnostics[0].range,
            message: diagnostics[0].message
          }
        ]
      },
    };
    actions.push(codeAction);

    return actions;
  }

  private async handlerCSpell(handlerContext: CodeActionHandlerContext) {
    const { textDocument, diags: spellCheckerDiags } = handlerContext;
    const actions: CodeAction[] = [];
    const uri = textDocument.uri;
    if (!spellCheckerDiags.length) return [];

    // We do not want to clutter the actions when someone is trying to refactor code
    if (spellCheckerDiags.length > 1) return [];

    // const { settings: docSetting, dictionary } = await this.getSettings(textDocument);

    function replaceText(range: LangServerRange, text?: string) {
      return TextEdit.replace(range, text || '');
    }

    const getSuggestions = (word: string) => {
      return this.sugGen.genWordSuggestions(textDocument, word);
    };

    async function genCodeActionsForSuggestions(_dictionary: SpellingDictionary) {
      let diagWord: string | undefined;
      for (const diag of spellCheckerDiags) {
        const { issueType = IssueType.spelling, suggestions } = extractDiagnosticData(diag);
        const srcWord = extractText(textDocument, diag.range);
        diagWord = diagWord || srcWord;
        const sugs: Validator.Suggestion[] = suggestions ?? (await getSuggestions(srcWord));
        sugs.map(({ word, isPreferred }) => ({ word: Text.isLowerCase(word) ? Text.matchCase(srcWord, word) : word, isPreferred }))
          .forEach((sug) => {
            const sugWord = sug.word;
            const title = suggestionToTitle(sug, issueType);
            if (!title) return;
            // const cmd = createCommand(title, 'cSpell.editText', uri, textDocument.version, [replaceText(diag.range, sugWord)]);
            var workspaceEdit: WorkspaceEdit = {
              changes: { [uri]: [replaceText(diag.range, sugWord)] }
            };

            const action = crateWorkspaceAction(title, workspaceEdit, [diag], sug.isPreferred);
            actions.push(action);
          });
      }

      return actions;
    }
    const dictionary = await getDictionary({});

    return genCodeActionsForSuggestions(dictionary);

  }
}

interface CodeActionHandlerContext {
  params: CodeActionParams;
  diags: Diagnostic[];
  textDocument: TextDocument;
}

function suggestionToTitle(sug: Validator.Suggestion, _: IssueType): string | undefined {
  return sug.word + (sug.isPreferred ? ' (preferred)' : '');
}

function crateWorkspaceAction(title: string, workspaceEdit: WorkspaceEdit, diags: Diagnostic[] | undefined, isPreferred?: boolean): CodeAction {
  const action = CodeAction.create(title, workspaceEdit, CodeActionKind.QuickFix);
  action.diagnostics = diags;
  if (isPreferred) {
    action.isPreferred = true;
  }
  return action;
}

function isWordLikeSelection(doc: TextDocument, range: LangServerRange): boolean {
  if (range.start.line !== range.end.line) return false;

  const text = doc.getText(range);
  const hasSpace = /\s/.test(text.trim());
  return !hasSpace;
}


const wordLengthForLimitingSuggestions = 15;
const maxNumberOfSuggestionsForLongWords = 1;
const regexJoinedWords = /[+]/g;

class SuggestionGenerator {

  async genSuggestions(doc: TextDocument, word: string): Promise<SuggestionResult[]> {
    const settings = await getSettigsForDocument(doc);

    const dictionary = await getDictionary(settings);
    const numSuggestions = 5;
    if (word.length > 20) {
      return [];
    }
    const numSugs =
      word.length > wordLengthForLimitingSuggestions ? Math.min(maxNumberOfSuggestionsForLongWords, numSuggestions) : numSuggestions;
    const options: SuggestOptions = {
      numChanges: 3,
      numSuggestions: numSugs,
      // Turn off compound suggestions for now until it works a bit better.
      compoundMethod: CompoundWordsMethod.NONE,
      ignoreCase: false,
      // Do not included ties, it could create a long list of suggestions.
      includeTies: false,
    };
    return dictionary.suggest(word, options).map((s) => ({ ...s, word: s.word.replace(regexJoinedWords, '') }));
  }

  async genWordSuggestions(doc: TextDocument, word: string): Promise<Validator.Suggestion[]> {
    return (await this.genSuggestions(doc, word)).map(({ word, isPreferred }) => ({ word, isPreferred }));
  }
}