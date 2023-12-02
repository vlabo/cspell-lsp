import { log } from '@internal/common-utils/log';
import type { SpellingDictionary } from 'cspell-lib';
import { constructSettingsForText, getDictionary, IssueType, Text } from 'cspell-lib';
import type { CancellationToken, CodeActionParams, Range as LangServerRange, RequestHandler, TextDocuments } from 'vscode-languageserver/node.js';
import { ResponseError } from 'vscode-languageserver/node.js';
import type { TextDocument } from 'vscode-languageserver-textdocument';
import { Diagnostic, WorkspaceEdit } from 'vscode-languageserver-types';
import { CodeAction, CodeActionKind, TextEdit } from 'vscode-languageserver-types';

import type { SpellCheckerDiagnosticData, Suggestion } from './api.js';
// import { calculateConfigTargets } from './config/configTargetsHelper.mjs';
import type { CSpellUserSettings } from './config/cspellConfig/index.mjs';
import { isUriAllowed } from './config/documentSettings.mjs';
import type { GetSettingsResult } from './SuggestionsGenerator.mjs';
import { SuggestionGenerator } from './SuggestionsGenerator.mjs';
import { uniqueFilter } from './utils/index.mjs';
import * as range from './utils/range.mjs';
import * as Validator from './validator.mjs';

// const createCommand = LangServerCommand.create;

function extractText(textDocument: TextDocument, range: LangServerRange) {
    return textDocument.getText(range);
}

// const debugTargets = false;

function extractDiagnosticData(diag: Diagnostic): SpellCheckerDiagnosticData {
    const { data } = diag;
    if (!data || typeof data !== 'object' || Array.isArray(data)) return {};
    return data as SpellCheckerDiagnosticData;
}

export interface CodeActionHandlerDependencies {
    fetchSettings: (doc: TextDocument) => Promise<CSpellUserSettings>;
    getSettingsVersion: (doc: TextDocument) => number;
    // fetchWorkspaceConfigForDocument: (uri: UriString) => Promise<WorkspaceConfigForDocument>;
}

export function createOnActionResolveHandler() : RequestHandler<CodeAction, CodeAction, void> {
    return (_action: CodeAction, _token: CancellationToken) => { return new ResponseError(0, "Error resolving command");} 
}

export function createOnCodeActionHandler(
    documents: TextDocuments<TextDocument>,
    dependencies: CodeActionHandlerDependencies,
): (params: CodeActionParams) => Promise<CodeAction[]> {
    const codeActionHandler = new CodeActionHandler(documents, dependencies);

    return (params) => codeActionHandler.handler(params);
}

type SettingsDictPair = GetSettingsResult;
interface CacheEntry {
    docVersion: number;
    settingsVersion: number;
    settings: Promise<SettingsDictPair>;
}

class CodeActionHandler {
    private sugGen: SuggestionGenerator<TextDocument>;
    private settingsCache: Map<string, CacheEntry>;

    constructor(
        readonly documents: TextDocuments<TextDocument>,
        readonly dependencies: CodeActionHandlerDependencies,
    ) {
        this.settingsCache = new Map<string, CacheEntry>();
        this.sugGen = new SuggestionGenerator((doc) => this.getSettings(doc));
    }

    async getSettings(doc: TextDocument): Promise<GetSettingsResult> {
        const cached = this.settingsCache.get(doc.uri);
        const settingsVersion = this.dependencies.getSettingsVersion(doc);
        if (cached?.docVersion === doc.version && cached.settingsVersion === settingsVersion) {
            return cached.settings;
        }
        const settings = this.constructSettings(doc);
        this.settingsCache.set(doc.uri, { docVersion: doc.version, settings, settingsVersion });
        return settings;
    }

    private async constructSettings(doc: TextDocument): Promise<SettingsDictPair> {
        const settings = constructSettingsForText(await this.dependencies.fetchSettings(doc), doc.getText(), doc.languageId);
        const dictionary = await getDictionary(settings);
        return { settings, dictionary };
    }

    public async handler(params: CodeActionParams): Promise<CodeAction[]> {
        const {
            context,
            textDocument: { uri },
        } = params;
        const { diagnostics } = context;
        const spellCheckerDiags = diagnostics.filter((diag) => diag.source === Validator.diagSource);

        if (!spellCheckerDiags.length) return [];

        const textDocument = this.documents.get(uri);
        if (!textDocument) return [];

        const rangeIntersectDiags = [...spellCheckerDiags]
            .map((diag) => diag.range)
            .reduce((a: LangServerRange | undefined, b) => a && range.intersect(a, b), params.range);

        // Only provide suggestions if the selection is contained in the diagnostics.
        if (!rangeIntersectDiags || !(range.equal(params.range, rangeIntersectDiags) || isWordLikeSelection(textDocument, params.range))) {
            return [];
        }

        const ctx = {
            params,
            textDocument,
        };

        return this.handlerCSpell({ ...ctx, diags: spellCheckerDiags });
    }

    private async handlerCSpell(handlerContext: CodeActionHandlerContext) {
        const { textDocument, diags: spellCheckerDiags } = handlerContext;
        const actions: CodeAction[] = [];
        const uri = textDocument.uri;
        if (!spellCheckerDiags.length) return [];

        // We do not want to clutter the actions when someone is trying to refactor code
        if (spellCheckerDiags.length > 1) return [];

        const { settings: docSetting, dictionary } = await this.getSettings(textDocument);
        if (!isUriAllowed(uri, docSetting.allowedSchemas)) {
            log(`CodeAction Uri Not allowed: ${uri}`);
            return [];
        }

        function replaceText(range: LangServerRange, text?: string) {
            return TextEdit.replace(range, text || '');
        }

        const getSuggestions = (word: string) => {
            return this.sugGen.genWordSuggestions(textDocument, word);
        };

        async function genCodeActionsForSuggestions(_dictionary: SpellingDictionary) {
            log('CodeAction generate suggestions');
            let diagWord: string | undefined;
            for (const diag of spellCheckerDiags) {
                const { issueType = IssueType.spelling, suggestions } = extractDiagnosticData(diag);
                const srcWord = extractText(textDocument, diag.range);
                diagWord = diagWord || srcWord;
                const sugs: Suggestion[] = suggestions ?? (await getSuggestions(srcWord));
                sugs.map(({ word, isPreferred }) => ({ word: Text.isLowerCase(word) ? Text.matchCase(srcWord, word) : word, isPreferred }))
                    .filter(uniqueFilter())
                    .forEach((sug) => {
                        const sugWord = sug.word;
                        const title = suggestionToTitle(sug, issueType);
                        if (!title) return;
                        // const cmd = createCommand(title, 'cSpell.editText', uri, textDocument.version, [replaceText(diag.range, sugWord)]);
                        var workspaceEdit: WorkspaceEdit = {
                            changes: {[uri]: [replaceText(diag.range, sugWord)]}
                        };
                    
                        const action = crateWorkspaceAction(title, workspaceEdit, [diag], sug.isPreferred);
                        actions.push(action);
                    });
            }
            return actions;
        }

        return genCodeActionsForSuggestions(dictionary);
    }
}

interface CodeActionHandlerContext {
    params: CodeActionParams;
    diags: Diagnostic[];
    textDocument: TextDocument;
}

const directiveToTitle: Record<string, string | undefined> = Object.assign(Object.create(null), {
    dictionary: 'cspell\x3adictionary - Enable Dictionaries for the file.',
    dictionaries: 'cspell\x3adictionaries - Enable Dictionaries for the file.',
    disable: 'cspell\x3adisable - Disable Spell Checking from this point.',
    disableCaseSensitive: 'cspell\x3adisableCaseSensitive - Disable for the file.',
    'disable-line': 'cspell\x3adisable-line - Do not spell check this line.',
    'disable-next': 'cspell\x3adisable-next - Do not spell check the next line.',
    'disable-next-line': 'cspell\x3adisable-next-line - Do not spell check the next line.',
    enable: 'cspell\x3aenable - Enable Spell Checking from this point.',
    enableCaseSensitive: 'cspell\x3aenableCaseSensitive - Enable for the file.',
    ignore: 'cspell\x3aignore - Ignore [word].',
    locale: 'cspell\x3alocale - Set the locale.',
    word: 'cspell\x3aword - Allow word [word].',
    words: 'cspell\x3awords - Allow words [word].',
});

const directivesToHide: Record<string, true | undefined> = {
    local: true,
};

function suggestionToTitle(sug: Suggestion, issueType: IssueType): string | undefined {
    const sugWord = sug.word;
    if (issueType === IssueType.spelling) return sugWord + (sug.isPreferred ? ' (preferred)' : '');
    if (sugWord in directivesToHide) return undefined;
    return directiveToTitle[sugWord] || 'cspell\x3a' + sugWord;
}


// function createAction(cmd: LangServerCommand, diags: Diagnostic[] | undefined, isPreferred?: boolean): CodeAction {
//     const action = CodeAction.create(cmd.title, cmd, CodeActionKind.QuickFix);
//     action.diagnostics = diags;
//     if (isPreferred) {
//         action.isPreferred = true;
//     }
//     return action;
// }

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
